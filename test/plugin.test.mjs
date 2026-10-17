import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createDiscord, loadPlugin, rowText, sleep, translationNodes } from "./harness.mjs";

const js = readFileSync(new URL("../dist/index.js", import.meta.url), "utf8");

const SPANISH = "Hola amigo, ¿cómo estás?";
const JAPANESE = "こんにちは、元気ですか？";

function setup(options = {}) {
	const discord = createDiscord();
	discord.google.dictionary.set(SPANISH, ["Hello friend, how are you?", "es"]);
	discord.google.dictionary.set(JAPANESE, ["Hello, how are you?", "ja"]);
	const loaded = loadPlugin(discord, { js, ...options });
	return { discord, ...loaded };
}

test("the bundle evaluates like a Vendetta plugin", () => {
	const { plugin } = setup();
	assert.equal(typeof plugin.onLoad, "function");
	assert.equal(typeof plugin.onUnload, "function");
	assert.equal(typeof plugin.settings, "function");
});

test("translates non-English messages under the original", async () => {
	const { discord, plugin, errors } = setup();
	plugin.onLoad();

	discord.addMessage("100", SPANISH);
	discord.addMessage("101", "hey what's up guys");
	discord.addMessage("102", JAPANESE);
	discord.addMessage("103", "```js\nconst x = 1\n```");
	discord.addMessage("104", ":smile:");
	discord.renderChannel();

	await sleep(1500);

	const spanish = translationNodes(discord.native.rows.get("100"));
	assert.equal(spanish.length, 1);
	assert.deepEqual(spanish[0], {
		type: "subtext",
		content: [{ type: "text", content: "🌐 Spanish: Hello friend, how are you?" }],
	});
	// The original text is still there, above the translation.
	assert.ok(rowText(discord.native.rows.get("100")).startsWith(SPANISH));

	assert.equal(
		translationNodes(discord.native.rows.get("102"))[0].content[0].content,
		"🌐 Japanese: Hello, how are you?",
	);

	for (const id of ["101", "103", "104"]) {
		assert.equal(translationNodes(discord.native.rows.get(id)).length, 0, id);
	}

	// Only the two foreign messages were sent to Google.
	assert.equal(discord.fetches.length, 2);
	assert.ok(discord.fetches.every(url => url.startsWith("https://translate.googleapis.com/")));

	// The content toggle used to re-render was undone.
	assert.equal(discord.stores.MessageStore.getMessage("c1", "100").content, SPANISH);
	assert.ok(!rowText(discord.native.rows.get("100")).includes("\u200B"));

	const updates = discord.dispatched.filter(a => a.type === "MESSAGE_UPDATE");
	assert.ok(updates.length >= 2);
	assert.ok(updates.every(a => a.log_edit === false && a.otherPluginBypass === true));

	assert.deepEqual(errors, []);
	plugin.onUnload();
});

test("reuses translations for repeated text without new requests", async () => {
	const { discord, plugin } = setup();
	plugin.onLoad();

	discord.addMessage("200", SPANISH);
	discord.renderChannel();
	await sleep(1200);
	assert.equal(discord.fetches.length, 1);

	discord.addMessage("201", SPANISH);
	discord.renderChannel();
	await sleep(50);

	assert.equal(translationNodes(discord.native.rows.get("201")).length, 1);
	assert.equal(discord.fetches.length, 1);
	plugin.onUnload();
});

test("keeps links working while re-rendering", async () => {
	const { discord, plugin } = setup();
	const text = "Mira esto https://example.com/video";
	discord.google.dictionary.set("Mira esto", ["Look at this", "es"]);
	plugin.onLoad();

	discord.addMessage("300", text);
	discord.renderChannel();
	await sleep(1500);

	const row = discord.native.rows.get("300");
	const link = row.message.content.find(node => node.type === "link");
	assert.equal(link.target, "https://example.com/video");
	assert.equal(translationNodes(row)[0].content[0].content, "🌐 Spanish: Look at this");

	// Every row the native side saw had the invisible mark removed.
	for (const call of discord.native.calls) {
		for (const r of call.rows) assert.ok(!JSON.stringify(r).includes("\\u200b") && !JSON.stringify(r).includes("\u200B"));
	}
	plugin.onUnload();
});

test("retries the refresh if Discord skips re-rendering", async () => {
	const { discord, plugin } = setup();
	plugin.onLoad();
	await sleep(700); // let the startup refresh of the open channel finish

	discord.addMessage("350", SPANISH);
	discord.dropRenders = 2; // the marked and the restored render both get lost
	discord.renderChannel();
	await sleep(2500);

	assert.equal(translationNodes(discord.native.rows.get("350")).length, 1);
	assert.equal(discord.stores.MessageStore.getMessage("c1", "350").content, SPANISH);
	plugin.onUnload();
});

test("falls back to the second endpoint when the first is rate limited", async () => {
	const { discord, plugin } = setup();
	discord.google.mode = "sorry";
	plugin.onLoad();

	discord.addMessage("400", SPANISH);
	discord.renderChannel();
	await sleep(1500);

	assert.ok(discord.fetches.some(url => url.startsWith("https://clients5.google.com/")));
	assert.equal(translationNodes(discord.native.rows.get("400")).length, 1);
	plugin.onUnload();
});

test("backs off and tells the user when Google rate limits everything", async () => {
	const { discord, plugin } = setup();
	discord.google.mode = "429";
	discord.google.dictMode = "429";
	plugin.onLoad();

	discord.addMessage("500", SPANISH);
	discord.addMessage("501", JAPANESE);
	discord.renderChannel();
	await sleep(1500);

	assert.equal(discord.toasts.length, 1);
	// Two requests failed together, but the pause only grows once.
	assert.match(discord.toasts[0], /limiting requests, retrying in 1 min/);
	// It paused instead of hammering the endpoint.
	assert.ok(discord.fetches.length <= 4, `made ${discord.fetches.length} requests`);
	assert.equal(translationNodes(discord.native.rows.get("500")).length, 0);
	plugin.onUnload();
});

test("respects the display settings", async () => {
	const { discord, plugin } = setup({ storage: { smallText: false, showLanguage: false } });
	plugin.onLoad();

	discord.addMessage("600", SPANISH);
	discord.renderChannel();
	await sleep(1500);

	assert.deepEqual(translationNodes(discord.native.rows.get("600")), [
		{ type: "text", content: "🌐 Hello friend, how are you?" },
	]);
	plugin.onUnload();
});

test("can skip your own messages and skips system messages", async () => {
	const { discord, plugin } = setup({ storage: { translateOwn: false } });
	plugin.onLoad();

	discord.addMessage("700", SPANISH, { authorId: "me" });
	discord.addMessage("701", JAPANESE, { type: 7 });
	discord.renderChannel();
	await sleep(1200);

	assert.equal(discord.fetches.length, 0);
	plugin.onUnload();
});

test("translates your own messages by default", async () => {
	const { discord, plugin, storage } = setup();
	plugin.onLoad();
	assert.equal(storage.translateOwn, true);

	discord.addMessage("750", SPANISH, { authorId: "me" });
	discord.renderChannel();
	await sleep(1500);

	assert.equal(translationNodes(discord.native.rows.get("750")).length, 1);
	plugin.onUnload();
});

test("translates messages already on screen when enabled", async () => {
	const { discord, plugin } = setup();
	discord.addMessage("800", SPANISH);
	discord.renderChannel(); // rendered before the plugin starts

	plugin.onLoad();
	await sleep(2000);

	assert.equal(translationNodes(discord.native.rows.get("800")).length, 1);
	plugin.onUnload();
});

test("removes translations when unloaded", async () => {
	const { discord, plugin } = setup();
	plugin.onLoad();

	discord.addMessage("900", SPANISH);
	discord.renderChannel();
	await sleep(1500);
	assert.equal(translationNodes(discord.native.rows.get("900")).length, 1);

	plugin.onUnload();
	await sleep(800);

	assert.equal(translationNodes(discord.native.rows.get("900")).length, 0);
	assert.equal(discord.stores.MessageStore.getMessage("c1", "900").content, SPANISH);

	// The native module is no longer patched.
	const before = discord.native.calls.length;
	discord.chatModule.updateRows("chat-c1", JSON.stringify([{ type: 1, message: { id: "x", content: [] } }]));
	assert.equal(discord.native.calls.length, before + 1);
});

test("never breaks updateRows on unexpected input", () => {
	const { discord, plugin, errors } = setup();
	plugin.onLoad();

	const inputs = [
		"not json",
		"{\"message\": 1}",
		JSON.stringify([null, 1, "x", { type: 1 }, { type: 1, message: null }, { type: 1, message: { id: 5 } }]),
		JSON.stringify([{ type: 1, message: { id: "1", content: [{ type: "text" }, null, { type: "strong", content: "x" }] } }]),
	];
	for (const json of inputs) {
		assert.doesNotThrow(() => discord.chatModule.updateRows("chat-c1", json));
	}
	// Everything reached the native side unchanged.
	assert.deepEqual(
		discord.native.calls.map(call => call.raw ?? JSON.stringify(call.rows)),
		inputs.map(json => (json === "not json" ? json : JSON.stringify(JSON.parse(json)))),
	);
	assert.deepEqual(errors, []);
	plugin.onUnload();
});

test("settings page renders", () => {
	const components = {
		TableRowGroup: "TableRowGroup",
		TableSwitchRow: "TableSwitchRow",
		TableRow: "TableRow",
	};
	const { plugin, storage } = setup({ components });
	plugin.onLoad();

	const tree = plugin.settings();
	const switches = [];
	const walk = node => {
		if (Array.isArray(node)) return node.forEach(walk);
		if (!node || typeof node !== "object") return;
		if (node.type === "TableSwitchRow") switches.push(node);
		walk(node.props?.children);
	};
	walk(tree);

	assert.equal(switches.length, 3);
	const small = switches.find(s => s.props.label === "Small translation text");
	assert.equal(small.props.value, true);
	small.props.onValueChange(false);
	assert.equal(storage.smallText, false);
	plugin.onUnload();
});

test("settings page falls back to plain components", () => {
	const { plugin } = setup();
	plugin.onLoad();
	const tree = plugin.settings();
	assert.equal(tree.type, "ScrollView");
	plugin.onUnload();
});
