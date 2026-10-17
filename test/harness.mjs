// Loads dist/index.js the way Revenge does (`vendetta => { return <js> }`)
// against a small fake of the Discord pieces the plugin touches: the message
// stores, FluxDispatcher, the native chat module and Google Translate.

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A rough stand-in for Discord's markdown parser output (the native row AST).
export function parseContent(content) {
	const nodes = [];
	const re = /```([\s\S]*?)```|`([^`]+)`|<@!?(\d+)>|(https?:\/\/[^\s<]+)|\|\|([\s\S]+?)\|\||(:[a-z_]+:)/g;
	let last = 0;
	let match;
	while ((match = re.exec(content))) {
		if (match.index > last) nodes.push({ type: "text", content: content.slice(last, match.index) });
		if (match[1] !== undefined) nodes.push({ type: "codeBlock", lang: "", content: match[1] });
		else if (match[2] !== undefined) nodes.push({ type: "inlineCode", content: match[2] });
		else if (match[3] !== undefined) nodes.push({ type: "mention", userId: match[3], content: [{ type: "text", content: "@someone" }] });
		else if (match[4] !== undefined) nodes.push({ type: "link", target: match[4], content: [{ type: "text", content: match[4] }] });
		else if (match[5] !== undefined) nodes.push({ type: "spoiler", channelId: "c1", content: [{ type: "text", content: match[5] }] });
		else nodes.push({ type: "emoji", content: match[6], surrogate: "😀" });
		last = re.lastIndex;
	}
	if (last < content.length) nodes.push({ type: "text", content: content.slice(last) });
	return nodes;
}

// Discord's MessageRecord is immutable; merge() returns an updated copy.
function makeRecord(props) {
	const record = { ...props };
	Object.defineProperty(record, "merge", { value: fields => makeRecord({ ...record, ...fields }) });
	return record;
}

export function createDiscord() {
	const channels = new Map(); // channelId -> Map(messageId -> message)
	const native = { calls: [], rows: new Map() };
	const dispatched = [];
	const toasts = [];
	const fetches = [];
	const google = {
		mode: "ok", // "ok" | "429" | "sorry" | "error"
		dictMode: "ok",
		dictionary: new Map(),
	};

	// What Discord last sent for each message, before plugins touched it.
	// Like the real client, unchanged rows are not sent again.
	const lastGenerated = new Map();

	const chatModule = {
		updateRows(chatId, json) {
			let rows;
			try {
				rows = JSON.parse(json);
			} catch {
				native.calls.push({ chatId, raw: json });
				return;
			}
			native.calls.push({ chatId, rows });
			if (Array.isArray(rows)) {
				for (const row of rows) if (row?.message?.id) native.rows.set(row.message.id, row);
			}
		},
	};

	function rowFor(message, index) {
		return {
			type: 1,
			index,
			changeType: 1,
			message: {
				id: message.id,
				channelId: message.channel_id,
				guildId: "g1",
				authorId: message.author.id,
				content: parseContent(message.content),
			},
		};
	}

	function render(channelId, messages) {
		// Simulates Discord batching away a re-render.
		if (discord.dropRenders > 0) {
			discord.dropRenders--;
			return;
		}
		const rows = [];
		messages.forEach((message, index) => {
			const row = rowFor(message, index);
			const json = JSON.stringify(row);
			if (lastGenerated.get(message.id) === json) return;
			lastGenerated.set(message.id, json);
			rows.push(row);
		});
		if (rows.length) chatModule.updateRows(`chat-${channelId}`, JSON.stringify(rows));
	}

	let dispatching = false;
	const FluxDispatcher = {
		dispatch(action) {
			if (dispatching) throw new Error("Cannot dispatch in the middle of a dispatch");
			dispatching = true;
			try {
				dispatched.push(action);
				if (action.type === "MESSAGE_UPDATE") {
					const channel = channels.get(action.message.channel_id);
					const existing = channel?.get(action.message.id);
					if (existing) {
						const updated = action.message.content ? existing.merge({ content: action.message.content }) : existing;
						channel.set(updated.id, updated);
						render(updated.channel_id, [updated]);
					}
				}
			} finally {
				dispatching = false;
			}
		},
	};

	// Discord's per-channel message cache (ChannelMessages). update() returns a new
	// cache object; commit() stores it.
	const commits = [];
	function channelCache(channelId, map = channels.get(channelId) ?? new Map()) {
		return {
			channelId,
			map,
			has: id => map.has(id),
			get: id => map.get(id),
			update(id, fn) {
				const next = new Map(map);
				next.set(id, fn(map.get(id)));
				return channelCache(channelId, next);
			},
		};
	}
	const ChannelMessages = {
		_channelMessages: {},
		clearCache() {},
		get: channelId => (channels.has(channelId) ? channelCache(channelId) : undefined),
		getOrCreate: channelId => channelCache(channelId),
		commit(cache) {
			commits.push(cache.channelId);
			channels.set(cache.channelId, cache.map);
		},
	};

	const MessageStore = {
		getMessage: (channelId, id) => channels.get(channelId)?.get(id),
		getMessages: channelId => ({ toArray: () => [...(channels.get(channelId)?.values() ?? [])] }),
		emitChange() {
			// Set emitChangeRenders = false to simulate a Discord version that ignores this.
			if (!discord.emitChangeRenders) return;
			for (const channelId of channels.keys()) render(channelId, [...channels.get(channelId).values()]);
		},
	};

	const stores = {
		MessageStore,
		ChannelStore: { getChannel: id => ({ id, guild_id: "g1" }) },
		SelectedChannelStore: { getChannelId: () => "c1" },
		UserStore: { getCurrentUser: () => ({ id: "me" }) },
	};

	function addMessage(id, content, { channelId = "c1", authorId = "u1", type = 0, state = "SENT" } = {}) {
		if (!channels.has(channelId)) channels.set(channelId, new Map());
		const message = makeRecord({ id, channel_id: channelId, content, type, state, author: { id: authorId } });
		channels.get(channelId).set(id, message);
		return message;
	}

	function renderChannel(channelId = "c1") {
		render(channelId, [...(channels.get(channelId)?.values() ?? [])]);
	}

	async function fakeFetch(url) {
		fetches.push(url);
		// No URL class in every engine this runs in (e.g. the Hermes CLI).
		const q = decodeURIComponent((url.match(/[?&]q=([^&]*)/) || [])[1] || "");
		const isGtx = url.split("/")[2] === "translate.googleapis.com";
		const mode = isGtx ? google.mode : google.dictMode;

		const response = (status, body, finalUrl = url) => ({
			status,
			ok: status >= 200 && status < 300,
			url: finalUrl,
			text: async () => body,
		});

		if (mode === "429") return response(429, "<html>Too many requests</html>");
		if (mode === "sorry") return response(429, "<html>captcha</html>", "https://www.google.com/sorry/index?continue=x");
		if (mode === "error") throw new TypeError("Network request failed");

		const known = google.dictionary.get(q);
		const [trans, src] = known ?? [q, "en"];
		if (isGtx) {
			return response(200, JSON.stringify({ sentences: [{ trans, orig: q, backend: 3 }], src, confidence: 1 }));
		}
		return response(200, JSON.stringify([[trans, src]]));
	}

	const discord = {
		dropRenders: 0,
		cacheEnabled: true,
		emitChangeRenders: true,
		ChannelMessages,
		commits,
		chatModule,
		native,
		dispatched,
		toasts,
		fetches,
		google,
		stores,
		FluxDispatcher,
		addMessage,
		renderChannel,
		fakeFetch,
		channels,
	};
	return discord;
}

export function createReact() {
	return {
		createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
		Fragment: "Fragment",
	};
}

export function loadPlugin(discord, { js, storage = {}, components = {} }) {
	const errors = [];

	const vendetta = {
		logger: {
			log() {},
			info() {},
			warn() {},
			error: (...args) => errors.push(args),
		},
		plugin: { id: "https://example.invalid/AutoTranslate/", manifest: {}, storage },
		patcher: {
			before(funcName, parent, callback) {
				const original = parent[funcName];
				parent[funcName] = function(...args) {
					const ret = callback.call(this, args);
					return original.apply(this, Array.isArray(ret) ? ret : args);
				};
				return () => {
					parent[funcName] = original;
					return true;
				};
			},
		},
		metro: {
			findByStoreName: name => discord.stores[name],
			findByProps: (...props) => {
				if (props.every(p => p in discord.ChannelMessages)) {
					return discord.cacheEnabled ? discord.ChannelMessages : undefined;
				}
				return props.every(p => p in components) ? components : undefined;
			},
			common: {
				React: createReact(),
				ReactNative: {
					NativeModules: {},
					ScrollView: "ScrollView",
					View: "View",
					Text: "Text",
					Switch: "Switch",
				},
				FluxDispatcher: discord.FluxDispatcher,
			},
		},
		storage: { useProxy: s => s },
		ui: {
			components: { Forms: {} },
			toasts: { showToast: message => discord.toasts.push(message) },
		},
	};

	globalThis.nativeModuleProxy = { NativeChatModule: discord.chatModule };
	globalThis.fetch = discord.fakeFetch;

	// Same wrapping as Revenge's VdPluginManager.evalPlugin.
	const raw = (0, eval)(`vendetta=>{return ${js}}\n//# sourceURL=AutoTranslate`)(vendetta);
	const ret = typeof raw === "function" ? raw() : raw;
	const plugin = ret?.default ?? ret ?? {};

	return { plugin, errors, storage };
}

/** All text in a row's content, flattened. */
export function rowText(row) {
	const out = [];
	const walk = node => {
		if (Array.isArray(node)) return node.forEach(walk);
		if (!node || typeof node !== "object") return;
		if (typeof node.content === "string") out.push(node.content);
		if (Array.isArray(node.content)) walk(node.content);
	};
	walk(row?.message?.content);
	return out.join("");
}

export function translationNodes(row) {
	return (row?.message?.content ?? []).filter(
		node => node.type === "text" && typeof node.content === "string" && node.content.startsWith("\n🌐 "),
	);
}
