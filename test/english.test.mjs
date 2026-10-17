import assert from "node:assert/strict";
import { test } from "node:test";

import { needsTranslation } from "../src/english.ts";

test("skips obvious English", () => {
	for (
		const text of [
			"hey what's up",
			"this is so cool",
			"i think we should go now",
			"lol",
			"lmaooo",
			"hahaha",
			"ok",
			"no",
			"xd",
			"gg wp",
			"thanks bro",
			"I don't know what you mean",
			"did you see the new update?",
		]
	) {
		assert.equal(needsTranslation(text), false, text);
	}
});

test("skips text without letters", () => {
	for (const text of ["", "   ", "123 456", "😀😀", "!!!", "?"]) {
		assert.equal(needsTranslation(text), false, JSON.stringify(text));
	}
});

test("sends other languages to the translator", () => {
	for (
		const text of [
			"Hola amigo, ¿cómo estás?",
			"hola amigo como estas",
			"no se",
			"a mi me gusta",
			"je ne sais pas",
			"on va a la plage",
			"das ist gut",
			"gracias",
			"ciao",
			"que buena la game de hoy bro",
			"saya mau makan",
			"こんにちは",
			"Привет, как дела?",
			"مرحبا",
			"안녕하세요",
			"Xin chào",
		]
	) {
		assert.equal(needsTranslation(text), true, text);
	}
});

test("mixed messages with foreign words are translated", () => {
	for (const text of ["el game estuvo cool", "bro kya kar raha hai", "lol que pasa", "ok gracias"]) {
		assert.equal(needsTranslation(text), true, text);
	}
});

test("common chat slang counts as English", () => {
	for (const text of ["ayo wtf", "bet", "lowkey mid ngl", "gonna carry ranked rn", "y'all are sus"]) {
		assert.equal(needsTranslation(text), false, text);
	}
});
