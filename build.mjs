// Builds the plugin into dist/ in the Vendetta plugin format that Revenge loads.
//
// Revenge evaluates a plugin as `vendetta => { return <index.js> }`, so index.js
// has to be a single expression that evaluates to the plugin's exports. The
// swc settings mirror the ones Revenge uses for its own bundle, because
// Discord's Hermes engine needs block scoping, classes and async functions
// lowered.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { transformFile } from "@swc/core";
import { build } from "esbuild";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));

await mkdir("dist", { recursive: true });

await build({
	entryPoints: [manifest.main],
	bundle: true,
	outfile: "dist/index.js",
	format: "iife",
	globalName: "$",
	banner: { js: "(()=>{" },
	footer: { js: "return $;})();" },
	supported: {
		// Hermes accepts const/let but treats them like var.
		"const-and-let": false,
	},
	minifySyntax: true,
	minifyWhitespace: true,
	legalComments: "none",
	charset: "ascii",
	logLevel: "info",
	plugins: [
		{
			// `import { x } from "@vendetta/metro"` -> `vendetta.metro.x`
			name: "vendetta-globals",
			setup(build) {
				build.onResolve({ filter: /^@vendetta(\/|$)/ }, ({ path }) => ({
					path,
					namespace: "vendetta",
				}));
				build.onLoad({ filter: /.*/, namespace: "vendetta" }, ({ path }) => ({
					contents: `module.exports = ${path.slice(1).replace(/\//g, ".")};`,
					loader: "js",
				}));
			},
		},
		{
			name: "swc",
			setup(build) {
				build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
					const isTs = /\.[cm]?tsx?$/.test(args.path);
					const isJsx = /x$/.test(args.path);
					const result = await transformFile(args.path, {
						swcrc: false,
						isModule: true,
						jsc: {
							parser: isTs
								? { syntax: "typescript", tsx: isJsx }
								: { syntax: "ecmascript", jsx: isJsx },
							transform: {
								react: {
									runtime: "classic",
									pragma: "React.createElement",
									pragmaFrag: "React.Fragment",
								},
							},
							externalHelpers: false,
							output: { charset: "ascii" },
						},
						env: {
							targets: "fully supports es6",
							include: [
								"transform-block-scoping",
								"transform-classes",
								"transform-async-to-generator",
								"transform-async-generator-functions",
								"transform-named-capturing-groups-regex",
							],
							exclude: [
								"transform-parameters",
								"transform-template-literals",
								"transform-exponentiation-operator",
								"transform-nullish-coalescing-operator",
								"transform-object-rest-spread",
								"transform-optional-chaining",
								"transform-logical-assignment-operators",
							],
						},
					});

					return { contents: result.code, loader: "js" };
				});
			},
		},
	],
});

const js = await readFile("dist/index.js", "utf8");

const outManifest = {
	...manifest,
	main: "index.js",
	hash: createHash("sha256").update(js).digest("hex"),
};
await writeFile("dist/manifest.json", `${JSON.stringify(outManifest, null, 2)}\n`);

console.log(`Built ${manifest.name} (${js.length} bytes, hash ${outManifest.hash.slice(0, 12)})`);
