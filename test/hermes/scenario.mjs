// The main translate flow, run inside the Hermes engine (see run.mjs).
/* global PLUGIN_JS, print */

import { createDiscord, loadPlugin, sleep, translationNodes } from "../harness.mjs";

// The Hermes CLI runs setTimeout callbacks immediately, in order, ignoring the
// delay. React Native's timers do wait, so give the plugin a virtual clock with
// real ordering. Promise jobs still run between timers (-Xmicrotask-queue).
{
	const hostSetTimeout = globalThis.setTimeout;
	const timers = [];
	let now = 0;
	let nextId = 0;
	let driving = false;

	const step = () => {
		if (!timers.length) {
			driving = false;
			return;
		}
		timers.sort((a, b) => a.due - b.due || a.id - b.id);
		const timer = timers.shift();
		now = timer.due;
		timer.fn(...timer.args);
		hostSetTimeout(step, 0);
	};

	globalThis.setTimeout = (fn, ms = 0, ...args) => {
		const id = ++nextId;
		timers.push({ id, due: now + Math.max(0, Number(ms) || 0), fn, args });
		if (!driving) {
			driving = true;
			hostSetTimeout(step, 0);
		}
		return id;
	};
	globalThis.clearTimeout = id => {
		const index = timers.findIndex(timer => timer.id === id);
		if (index !== -1) timers.splice(index, 1);
	};
	Date.now = () => now;
}

const results = [];
const check = (name, ok) => results.push(`${ok ? "PASS" : "FAIL"} ${name}`);

async function main() {
	const discord = createDiscord();
	discord.google.dictionary.set("Hola amigo, ¿cómo estás?", ["Hello friend, how are you?", "es"]);
	discord.google.dictionary.set("Mira esto", ["Look at this", "es"]);
	const { plugin, errors } = loadPlugin(discord, { js: PLUGIN_JS });
	check("plugin evaluates", typeof plugin.onLoad === "function");

	plugin.onLoad();
	discord.addMessage("1", "Hola amigo, ¿cómo estás?");
	discord.addMessage("2", "hey what's up guys");
	discord.addMessage("3", "Mira esto https://example.com/a");
	discord.renderChannel();
	await sleep(1500);

	const spanish = translationNodes(discord.native.rows.get("1"));
	check(
		"Spanish message gets an English translation",
		spanish.length === 1 && spanish[0].content === "\n\u{1F310} Spanish: Hello friend, how are you?",
	);
	check("English message is left alone", translationNodes(discord.native.rows.get("2")).length === 0);
	check("only foreign messages hit the network", discord.fetches.length === 2);

	const link = discord.native.rows.get("3").message.content.find(n => n.type === "link");
	check("links keep their target", link && link.target === "https://example.com/a");
	check("message content is restored", discord.stores.MessageStore.getMessage("c1", "1").content === "Hola amigo, ¿cómo estás?");

	plugin.onUnload();
	await sleep(800);
	check("translations go away after unloading", translationNodes(discord.native.rows.get("1")).length === 0);
	check("no errors were logged", errors.length === 0);

	for (const line of results) print(line);
	print(results.some(line => line.startsWith("FAIL")) ? "HERMES: FAILED" : "HERMES: OK");
}

main().then(undefined, error => print(`HERMES: CRASHED ${error && error.stack}`));
