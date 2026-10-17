// Runs test/hermes/scenario.mjs inside Hermes, the engine Discord's mobile app
// uses. Hermes isn't a dependency; point HERMES at a `hermes` CLI binary, e.g.
// from the hermes-engine-cli npm package:
//   HERMES=/path/to/hermes node test/hermes/run.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { build } from "esbuild";

const hermes = process.env.HERMES;
if (!hermes) {
	console.log("HERMES is not set, skipping the Hermes run");
	process.exit(0);
}

const pluginJs = readFileSync(new URL("../../dist/index.js", import.meta.url), "utf8");
const out = join(mkdtempSync(join(tmpdir(), "autotranslate-hermes-")), "scenario.js");

await build({
	entryPoints: [new URL("scenario.mjs", import.meta.url).pathname],
	bundle: true,
	format: "iife",
	outfile: out,
	define: { PLUGIN_JS: JSON.stringify(pluginJs) },
	// Older Hermes versions reject async arrow functions.
	supported: { "async-await": false },
	logLevel: "warning",
});

// Without -Xmicrotask-queue the CLI runs promise jobs after timers, unlike React Native.
const output = execFileSync(hermes, ["-Xmicrotask-queue", out], { encoding: "utf8" });
process.stdout.write(output);
if (!output.includes("HERMES: OK")) process.exit(1);
