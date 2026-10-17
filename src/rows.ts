import { logger } from "@vendetta";
import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, ReactNative } from "@vendetta/metro/common";
import { before } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";

import { needsTranslation } from "./english";
import { languageName } from "./languages";
import { lookup, onTranslated, request, type Translation } from "./translator";

// Discord renders chat natively. JS hands the native side the rendered rows
// as JSON through NativeChatModule.updateRows(chatId, json); each message row
// carries the message's parsed markdown as a tree of nodes, so the
// translation is appended to that tree as an extra text node.

const MessageStore = findByStoreName("MessageStore");
const ChannelStore = findByStoreName("ChannelStore");
const SelectedChannelStore = findByStoreName("SelectedChannelStore");
const UserStore = findByStoreName("UserStore");

const PREFIX = "\n🌐 ";
// Zero-width space, appended to a message for a moment to make Discord re-render it.
const MARK = String.fromCharCode(0x200b);
const RESTORE_DELAY_MS = 400;
const VERIFY_DELAY_MS = 1500;
const MAX_REFRESH_ATTEMPTS = 3;

// Default, reply, slash command, thread starter, context menu command.
const TRANSLATABLE_TYPES = new Set([0, 19, 20, 21, 23]);

// Node types whose text is not prose (or is hidden, like spoilers).
const SKIPPED_NODES = new Set([
	"mention",
	"channelMention",
	"roleMention",
	"commandMention",
	"channel",
	"link",
	"emoji",
	"customEmoji",
	"codeBlock",
	"inlineCode",
	"timestamp",
	"spoiler",
	"guildNavigation",
	"staticRouteLink",
	"attachmentLink",
	"soundboard",
]);
const BLOCK_NODES = new Set(["heading", "blockQuote", "list", "paragraph", "subtext"]);

// Messages whose content currently ends with MARK (see toggleMark).
const marked = new Set<string>();
// Messages showing a translation right now, so they can be refreshed when settings change.
const shown = new Map<string, string>();
// When each message last reached the native side with its translation.
const delivered = new Map<string, number>();
let stopped = false;
let hookSeen = false;

function collectText(node: any, out: string[]) {
	if (node == null) return;
	if (Array.isArray(node)) {
		for (const child of node) collectText(child, out);
		return;
	}
	if (typeof node !== "object") return;

	const type = node.type;
	if (type === "text") {
		if (typeof node.content === "string") out.push(node.content);
		return;
	}
	if (type === "br" || type === "newline") {
		out.push("\n");
		return;
	}
	if (SKIPPED_NODES.has(type)) {
		out.push(" ");
		return;
	}

	if (Array.isArray(node.content)) collectText(node.content, out);
	if (Array.isArray(node.items)) {
		for (const item of node.items) {
			collectText(item, out);
			out.push("\n");
		}
	}
	if (BLOCK_NODES.has(type)) out.push("\n");
}

/** The readable text of a message's content tree, minus code, links, mentions and emoji. */
export function extractText(content: any[]): string {
	const out: string[] = [];
	collectText(content, out);
	return out
		.join("")
		.split(MARK)
		.join("")
		.replace(/[ \t]+/g, " ")
		.replace(/ ?\n[ \n]*/g, "\n")
		.trim();
}

function isOurNode(node: any) {
	return node?.type === "text" && typeof node.content === "string" && node.content.indexOf(PREFIX) === 0;
}

/** Appends the translation under the message text. Returns false if there was nothing to add. */
export function appendTranslation(content: any[], translation: Translation) {
	const label = storage.showLanguage === false ? "" : languageName(translation.lang);
	const text = translation.text
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0)
		.join("\n");
	if (!text) return false;

	// A plain text node: the kind Discord's own parser produces for ordinary text.
	content.push({ type: "text", content: `${PREFIX}${label ? `${label}: ` : ""}${text}` });
	return true;
}

/** Removes the trailing MARK added by toggleMark from the last node of a content tree. */
function stripMark(nodes: any[]): boolean {
	for (let i = nodes.length - 1; i >= 0; i--) {
		const node = nodes[i];
		if (Array.isArray(node)) return stripMark(node);
		if (!node || typeof node !== "object") continue;

		let changed = false;
		if (typeof node.target === "string") {
			if (node.target.endsWith(MARK)) {
				node.target = node.target.slice(0, -MARK.length);
				changed = true;
			} else if (node.target.endsWith("%E2%80%8B")) {
				node.target = node.target.slice(0, -9);
				changed = true;
			}
		}
		if (typeof node.content === "string") {
			if (node.content.endsWith(MARK)) {
				node.content = node.content.slice(0, -MARK.length);
				if (!node.content && node.type === "text") nodes.splice(i, 1);
				changed = true;
			}
			return changed;
		}
		if (Array.isArray(node.content)) return stripMark(node.content) || changed;
		if (Array.isArray(node.items)) return stripMark(node.items) || changed;
		return changed;
	}
	return false;
}

function isMine(authorId: string | undefined) {
	const me = UserStore?.getCurrentUser?.();
	return !!me && me.id === authorId;
}

/** Messages still being sent (or that failed to send) have a state other than "SENT". */
function isSent(message: any) {
	return typeof message?.state !== "string" || message.state === "SENT";
}

/** Checks a message from MessageStore: an ordinary message that has been sent. */
function isTranslatable(message: any) {
	if (typeof message.type === "number" && !TRANSLATABLE_TYPES.has(message.type)) return false;
	if (!isSent(message)) return false;
	return storage.ownMessages === true || !isMine(message.author?.id);
}

/** Checks a chat row's message. */
function shouldTranslate(message: any) {
	if (storage.ownMessages !== true && isMine(message.authorId)) return false;

	const stored = message.channelId ? MessageStore?.getMessage?.(message.channelId, message.id) : undefined;
	return !stored || isTranslatable(stored);
}

/** Adds the translation to one row. Returns true if the row changed. */
export function processRow(row: any): boolean {
	if (!row || row.type !== 1) return false;
	const message = row.message;
	if (!message || typeof message.id !== "string" || !Array.isArray(message.content)) return false;

	let changed = false;
	if (marked.has(message.id)) changed = stripMark(message.content);
	// Already handled (e.g. the same JSON went through a second patched module object).
	if (message.content.some(isOurNode)) return changed;
	if (!shouldTranslate(message)) return changed;

	const text = extractText(message.content);
	if (!needsTranslation(text)) return changed;

	const translation = lookup(text);
	if (translation === undefined) {
		request(text, message.channelId, message.id);
		return changed;
	}
	if (translation === null || !appendTranslation(message.content, translation)) {
		shown.delete(message.id);
		return changed;
	}

	shown.set(message.id, message.channelId);
	if (shown.size > 300) shown.delete(shown.keys().next().value!);
	delivered.set(message.id, Date.now());
	if (delivered.size > 300) delivered.delete(delivered.keys().next().value!);
	return true;
}

function onUpdateRows(args: any[]) {
	try {
		const json = args[1];
		if (typeof json !== "string" || json.indexOf("\"message\"") === -1) return;

		const rows = JSON.parse(json);
		if (!Array.isArray(rows)) return;

		if (!hookSeen) {
			hookSeen = true;
			logger.log("AutoTranslate: receiving chat rows");
		}

		let changed = false;
		for (const row of rows) {
			try {
				if (processRow(row)) changed = true;
			} catch (e) {
				logger.error("AutoTranslate: failed to process a chat row", e);
			}
		}
		if (changed) args[1] = JSON.stringify(rows);
	} catch (e) {
		// Never let a problem here break Discord's chat.
		logger.error("AutoTranslate: failed to process chat rows", e);
	}
}

function findChatModules() {
	const modules: any[] = [];
	const add = (module: any) => {
		if (module && typeof module.updateRows === "function" && modules.indexOf(module) === -1) {
			modules.push(module);
		}
	};

	for (const name of ["NativeChatModule", "DCDChatManager"]) {
		try {
			add(globalThis.__turboModuleProxy?.(name));
		} catch {}
		try {
			add(globalThis.nativeModuleProxy?.[name]);
		} catch {}
		try {
			add(ReactNative?.NativeModules?.[name]);
		} catch {}
	}
	return modules;
}

// --- Re-rendering ---
//
// A translation arrives after its row was drawn. To draw the row again, an
// invisible mark is appended to the message's content for a moment and then
// removed. The change is made in Discord's local message cache, the way
// Vencord's MessageUpdater re-renders messages: no Flux event is dispatched,
// so nothing else (like message logger plugins) sees an "edit". If the cache
// can't be found, or updating it doesn't re-render the row, a MESSAGE_UPDATE
// carrying only the message's id, channel and content is used instead.

type Method = "cache" | "event";

interface Refresh {
	channelId: string;
	// Set when a translation should appear; the refresh is retried if it doesn't.
	attempt?: number;
}

const pendingRefresh = new Map<string, Refresh>(); // messageId -> refresh
const restoring = new Set<string>();
let refreshTimer: any = null;
let cacheConfirmed = false; // a cache update re-rendered a row
let preferEvent = false; // a cache update didn't, but an event did

let channelMessages: any;

function getChannelMessages() {
	if (channelMessages === undefined) {
		channelMessages = null;
		for (const props of [["getOrCreate", "commit", "clearCache"], ["clearCache", "_channelMessages"]]) {
			try {
				const found = findByProps(...props);
				if (typeof found?.commit === "function") {
					channelMessages = found;
					break;
				}
			} catch {}
		}
	}
	return channelMessages;
}

function setContentInCache(channelId: string, messageId: string, content: string) {
	const ChannelMessages = getChannelMessages();
	if (!ChannelMessages || typeof MessageStore?.emitChange !== "function") return false;

	try {
		const cache = ChannelMessages.get?.(channelId) ?? ChannelMessages.getOrCreate?.(channelId);
		const message = cache?.get?.(messageId);
		if (!message || typeof message.merge !== "function" || typeof cache.update !== "function") return false;

		ChannelMessages.commit(cache.update(messageId, (m: any) => m.merge({ content })));
		MessageStore.emitChange();
		return true;
	} catch (e) {
		logger.warn("AutoTranslate: couldn't update the message cache", e);
		return false;
	}
}

function setContentWithEvent(message: any, content: string) {
	try {
		FluxDispatcher.dispatch({
			type: "MESSAGE_UPDATE",
			message: {
				id: message.id,
				channel_id: message.channel_id,
				guild_id: ChannelStore?.getChannel?.(message.channel_id)?.guild_id,
				content,
			},
			log_edit: false,
			otherPluginBypass: true,
		});
		return true;
	} catch (e) {
		logger.error("AutoTranslate: MESSAGE_UPDATE failed", e);
		return false;
	}
}

function setContent(method: Method, message: any, content: string): Method | undefined {
	if (method === "cache" && setContentInCache(message.channel_id, message.id, content)) return "cache";
	return setContentWithEvent(message, content) ? "event" : undefined;
}

function toggleMark(message: any, method: Method): Method | undefined {
	const id: string = message.id;
	const channelId: string = message.channel_id;
	const original: string = message.content;
	const withMark = original + MARK;

	marked.add(id);
	const used = setContent(method, message, withMark);
	if (!used) {
		marked.delete(id);
		return undefined;
	}

	restoring.add(id);
	setTimeout(() => {
		restoring.delete(id);
		const current = MessageStore?.getMessage?.(channelId, id);
		if (current && current.content === withMark) setContent(used, current, original);
		// Rows can be regenerated a little later; keep stripping the mark for a while.
		setTimeout(() => {
			if (!restoring.has(id)) marked.delete(id);
		}, 3000);
	}, RESTORE_DELAY_MS);
	return used;
}

function verifyLater(channelId: string, messageId: string, attempt: number, started: number, used?: Method) {
	setTimeout(() => {
		if (stopped) return;
		if ((delivered.get(messageId) ?? -1) >= started) {
			if (used === "cache") cacheConfirmed = true;
			else if (used === "event" && !cacheConfirmed) preferEvent = true;
			return;
		}
		if (attempt + 1 >= MAX_REFRESH_ATTEMPTS) return;
		if (SelectedChannelStore?.getChannelId?.() !== channelId) return;
		refreshMessage(channelId, messageId, attempt + 1);
	}, VERIFY_DELAY_MS);
}

function refreshNow(messageId: string, { channelId, attempt }: Refresh) {
	const message = MessageStore?.getMessage?.(channelId, messageId);
	if (!message || typeof message.content !== "string" || !message.content || !isSent(message)) return;

	const started = Date.now();
	let used: Method | undefined;
	// While a restore is pending, it re-renders the row anyway.
	if (!restoring.has(messageId)) {
		// After a cache update failed to re-render a row, try an event instead.
		const method: Method = preferEvent || (attempt && !cacheConfirmed) ? "event" : "cache";
		used = toggleMark(message, method);
		if (!used) return;
	}
	if (attempt !== undefined) verifyLater(channelId, messageId, attempt, started, used);
}

function flushRefreshes() {
	refreshTimer = null;
	let budget = 15;
	for (const [messageId, refresh] of pendingRefresh) {
		if (budget-- <= 0) break;
		pendingRefresh.delete(messageId);
		try {
			refreshNow(messageId, refresh);
		} catch (e) {
			logger.error("AutoTranslate: failed to refresh message", e);
		}
	}
	if (pendingRefresh.size) refreshTimer = setTimeout(flushRefreshes, 100);
}

/** Makes Discord render a message's row again. Pass `attempt` when a translation should appear. */
export function refreshMessage(channelId: string, messageId: string, attempt?: number) {
	if (!channelId || !messageId) return;
	pendingRefresh.set(messageId, { channelId, attempt: attempt ?? pendingRefresh.get(messageId)?.attempt });
	if (refreshTimer == null) refreshTimer = setTimeout(flushRefreshes, 50);
}

/** Re-renders translated messages in the open channel, e.g. after a settings change. */
export function refreshShown() {
	const current = SelectedChannelStore?.getChannelId?.();
	for (const [messageId, channelId] of shown) {
		if (channelId === current) refreshMessage(channelId, messageId);
	}
}

/** Re-renders recent messages in the open channel that look like they need translating. */
function refreshOpenChannel() {
	if (stopped) return;
	const channelId = SelectedChannelStore?.getChannelId?.();
	if (!channelId) return;

	const messages = MessageStore?.getMessages?.(channelId);
	const list: any[] = messages?.toArray?.() ?? messages?._array ?? [];
	for (const message of list.slice(-50)) {
		if (!message?.id || !isTranslatable(message)) continue;

		const rough = String(message.content ?? "")
			.replace(/```[\s\S]*?```|`[^`]*`|<[^>\s]+>|https?:\/\/\S+|\|\|[\s\S]*?\|\|/g, " ")
			.trim();
		if (needsTranslation(rough)) refreshMessage(channelId, message.id);
	}
}

export function patchChat(): () => void {
	const modules = findChatModules();
	if (!modules.length) {
		logger.error("AutoTranslate: couldn't find Discord's native chat module");
		return () => {};
	}

	const unpatches: (() => unknown)[] = [];
	for (const module of modules) {
		try {
			unpatches.push(before("updateRows", module, onUpdateRows));
		} catch (e) {
			logger.error("AutoTranslate: couldn't patch updateRows", e);
		}
	}
	if (!unpatches.length) return () => {};

	stopped = false;
	onTranslated((channelId, messageId) => refreshMessage(channelId, messageId, 0));
	setTimeout(refreshOpenChannel, 500);

	return () => {
		stopped = true;
		for (const unpatch of unpatches) unpatch();
		if (refreshTimer != null) clearTimeout(refreshTimer);
		refreshTimer = null;
		pendingRefresh.clear();
		// Re-render translated messages so the translations disappear.
		refreshShown();
		shown.clear();
		delivered.clear();
	};
}
