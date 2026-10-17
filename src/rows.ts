import { logger } from "@vendetta";
import { findByStoreName } from "@vendetta/metro";
import { FluxDispatcher, ReactNative } from "@vendetta/metro/common";
import { before } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";

import { needsTranslation } from "./english";
import { languageName } from "./languages";
import { lookup, onTranslated, request, type Translation } from "./translator";

// Discord renders chat natively. JS hands the native side the rendered rows
// as JSON through NativeChatModule.updateRows(chatId, json); each message row
// carries the message's parsed markdown as a tree of nodes, so the
// translation is appended to that tree as extra nodes.

const MessageStore = findByStoreName("MessageStore");
const ChannelStore = findByStoreName("ChannelStore");
const SelectedChannelStore = findByStoreName("SelectedChannelStore");
const UserStore = findByStoreName("UserStore");

const PREFIX = "🌐 ";
const MARK = "\u200B";
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

// Messages whose content currently ends with MARK (see refreshMessage).
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
		.replace(/\u200B/g, "")
		.replace(/[ \t]+/g, " ")
		.replace(/ ?\n[ \n]*/g, "\n")
		.trim();
}

function isOurNode(node: any) {
	if (!node) return false;
	if (node.type === "text") return typeof node.content === "string" && node.content.indexOf(PREFIX) === 0;
	if (node.type === "subtext" && Array.isArray(node.content)) return isOurNode(node.content[0]);
	return false;
}

export function appendTranslation(content: any[], translation: Translation) {
	const label = storage.showLanguage === false ? "" : languageName(translation.lang);
	const lines = translation.text
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);

	lines.forEach((line, i) => {
		const text = i === 0 ? `${PREFIX}${label ? `${label}: ` : ""}${line}` : line;
		const node = { type: "text", content: text };
		content.push({ type: "text", content: "\n" });
		content.push(storage.smallText === false ? node : { type: "subtext", content: [node] });
	});
}

/** Removes the trailing MARK added by refreshMessage from the last node of a content tree. */
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

function shouldTranslate(message: any) {
	if (storage.translateOwn === false) {
		const me = UserStore?.getCurrentUser?.();
		if (me && me.id === message.authorId) return false;
	}

	const stored = message.channelId ? MessageStore?.getMessage?.(message.channelId, message.id) : undefined;
	if (stored && typeof stored.type === "number" && !TRANSLATABLE_TYPES.has(stored.type)) return false;
	return true;
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
	if (translation === null) {
		shown.delete(message.id);
		return changed;
	}

	appendTranslation(message.content, translation);
	shown.set(message.id, message.channelId);
	if (shown.size > 300) shown.delete(shown.keys().next().value!);
	delivered.set(message.id, Date.now());
	if (delivered.size > 300) delivered.delete(delivered.keys().next().value!);
	return true;
}

function onUpdateRows(args: any[]) {
	const json = args[1];
	if (typeof json !== "string" || json.indexOf("\"message\"") === -1) return;

	let rows: any;
	try {
		rows = JSON.parse(json);
	} catch {
		return;
	}
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
// A translation arrives after its row was rendered. To render the row again,
// the message's content is changed for a moment (an invisible mark is
// appended) and then restored, which makes Discord regenerate the row.

interface Refresh {
	channelId: string;
	// Set when a translation should appear; the refresh is retried if it doesn't.
	attempt?: number;
}

const pendingRefresh = new Map<string, Refresh>(); // messageId -> refresh
const restoring = new Set<string>();
let refreshTimer: any = null;

function dispatchContent(message: any, content: string) {
	try {
		FluxDispatcher.dispatch({
			type: "MESSAGE_UPDATE",
			message: {
				...message,
				id: message.id,
				channel_id: message.channel_id,
				guild_id: message.guild_id ?? ChannelStore?.getChannel?.(message.channel_id)?.guild_id,
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

function refreshNow(messageId: string, { channelId, attempt }: Refresh) {
	const message = MessageStore?.getMessage?.(channelId, messageId);
	if (!message || typeof message.content !== "string" || !message.content) return;

	if (attempt !== undefined) {
		// If Discord doesn't re-render the row (it may batch updates), try again.
		const started = Date.now();
		setTimeout(() => {
			if (stopped || (delivered.get(messageId) ?? -1) >= started) return;
			if (attempt + 1 >= MAX_REFRESH_ATTEMPTS) return;
			if (SelectedChannelStore?.getChannelId?.() !== channelId) return;
			refreshMessage(channelId, messageId, attempt + 1);
		}, VERIFY_DELAY_MS);
	}

	if (restoring.has(messageId)) return; // the pending restore re-renders it anyway

	const original = message.content;
	const withMark = original + MARK;
	marked.add(messageId);
	if (!dispatchContent(message, withMark)) {
		marked.delete(messageId);
		return;
	}

	restoring.add(messageId);
	setTimeout(() => {
		restoring.delete(messageId);
		const current = MessageStore?.getMessage?.(channelId, messageId);
		if (current && current.content === withMark) dispatchContent(current, original);
		// Rows can be regenerated a little later; keep stripping the mark for a while.
		setTimeout(() => {
			if (!restoring.has(messageId)) marked.delete(messageId);
		}, 3000);
	}, RESTORE_DELAY_MS);
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
		const rough = String(message?.content ?? "")
			.replace(/```[\s\S]*?```|`[^`]*`|<[^>\s]+>|https?:\/\/\S+|\|\|[\s\S]*?\|\|/g, " ")
			.trim();
		if (message?.id && needsTranslation(rough)) refreshMessage(channelId, message.id);
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
