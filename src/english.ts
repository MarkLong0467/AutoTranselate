// Cheap local checks that decide whether a message is worth sending to the
// translator. Clear English is skipped here so most English messages never
// cost a request; anything uncertain is sent, and the translator's language
// detection makes the final call.

// Letters from scripts other than basic Latin (accented Latin, Greek, Cyrillic,
// Armenian, Hebrew, Arabic, Indic, Thai, Georgian, Hangul, kana, CJK, ...).
// Punctuation, symbol and emoji ranges are deliberately not included.
const FOREIGN_LETTER =
	/[\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02AF\u0370-\u03FF\u0400-\u052F\u0531-\u058F\u0591-\u05F4\u0600-\u06FF\u0700-\u08FF\u0900-\u0DFF\u0E00-\u0EFF\u0F00-\u0FFF\u1000-\u109F\u10A0-\u10FF\u1100-\u11FF\u1200-\u139F\u1780-\u17FF\u1E00-\u1FFF\u2C00-\u2DFF\u2E80-\u2FDF\u3040-\u30FF\u3100-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7AF\uF900-\uFAFF\uFF21-\uFF3A\uFF41-\uFF5A\uFF66-\uFFDC]/;

const ENGLISH = new Set(
	`
the of and you that it he she they we his her him them their our your my its this these those there here
are be been being was were has have had having do does did doing done not but or if then than so very
with from by about into over after before under between through during without within against until
what which who whom whose when where why how all any each every some many much more most other another
such only own same just also too even still again already always never ever often sometimes maybe probably
can could would should shall may might must will wont dont doesnt didnt isnt arent wasnt werent cant couldnt
wouldnt shouldnt havent hasnt hadnt im ive ill id youre youve youll youd hes shes its weve were theyre theyve
lets thats whats theres heres whos hows wheres
one two three first last next new old good bad great best better worst big small little long right left
time day year today tonight tomorrow yesterday now later soon week month night morning
get got getting go going gone went come coming came make made making take took know knew think thought
see saw seen look looking want wanted need needed like liked love hate feel felt say said says saying tell
told ask asked try tried use used work working play playing played give gave find found mean means meant
wait call called talk talking help keep let put run seem show start stop thing things stuff something
nothing anything everything someone anyone everyone nobody people person guy guys dude bro man friend
yes yeah yep yup nope nah ok okay sure fine thanks thank thx ty please pls plz sorry hi hello hey bye
lol lmao lmfao rofl omg wtf idk idc tbh imo imho btw brb afk gg ggs wp gl hf np fr ngl rn irl smh jk
lmk wym wdym hbu wyd ikr oh ah uh um hmm huh damn shit fuck fucking bruh nice cool awesome amazing fun
funny crazy wow true false real actually literally basically really though because cause well
game games server channel discord message chat voice video stream link pic photo music song movie
ayo ayy bet cap sus lowkey highkey deadass frfr ong mid goat pog poggers kekw based cringe ratio slay yeet vibe
vibes lit fam bruv innit mate oi yall gonna wanna gotta kinda sorta dunno lemme gimme
noob nerf buff lag ez clutch carry ranked queue lobby op
w l k kk xd xdd
`.split(/\s+/),
);

// Short words that are also common in other languages ("a", "no", "me", "die",
// "was", ...). They say nothing either way, so they are left out of the count.
const NEUTRAL = new Set(
	`
a i o e y u me no on so se si te tu mi ma la le de di da do du en es et il al un una une con per
die das was will also an am to at as for in come man yo ya ha re ne na ci vs
`.split(/\s+/),
);

// Everyday words of other languages that English chat practically never uses.
// One of these is enough to send the message to the translator.
const FOREIGN = new Set(
	`
que el los las por para pero muy esta estoy estas eso esto aqui tambien porque cuando donde como hola
gracias bueno buena bien mucho eres tengo tiene vamos
mais sont nous vous ils elle oui merci bonjour pas trop
ich ist nicht und der ein eine sie wir nein sehr aber auch noch schon
het een niet ik jeg ikke
ang mga ng naman lang yung
ini itu aku kamu tidak gak nggak sudah belum mau dari untuk dengan apa kenapa gimana banget yang
voce nao muito isso isto mas uma
che sono sei molto perche questo quello anche ancora grazie bene gli della nel
kya hai nahi kar raha rahe bhai yaar acha accha haan kaise kuch tum aap mein hindi
`.split(/\s+/),
);

const LAUGH = /^(?:a?(?:ha){2,}h?|(?:he){2,}h?|(?:ja){2,}j?|(?:je){2,}|(?:ka){2,}|k+|(?:wk){2,}|x+d+|l+o+l+|l+m+a+o+)$/;

export function hasLetters(text: string): boolean {
	return /[A-Za-z]/.test(text) || FOREIGN_LETTER.test(text);
}

function isEnglishWord(word: string): boolean {
	if (ENGLISH.has(word) || LAUGH.test(word)) return true;
	// Contractions: "that's" -> "thats" is listed, "game's" -> "game".
	const bare = word.replace(/'/g, "");
	if (ENGLISH.has(bare)) return true;
	const base = word.replace(/'(?:s|re|ve|ll|d|m)$/, "");
	return base !== word && ENGLISH.has(base);
}

export function needsTranslation(text: string): boolean {
	if (!text || !hasLetters(text)) return false;
	if (FOREIGN_LETTER.test(text)) return true;

	const words = text
		.toLowerCase()
		.replace(/\u2019/g, "'")
		.match(/[a-z]+(?:'[a-z]+)*/g);
	if (!words) return false;

	let considered = 0;
	let english = 0;
	for (const raw of words) {
		// "yesss" -> "yes", "soooo" -> "so", "lmaooo" -> "lmao"
		const word = raw.replace(/(.)\1{2,}/g, "$1");
		if (FOREIGN.has(word)) return true;
		if (NEUTRAL.has(word)) continue;
		considered++;
		if (isEnglishWord(word)) english++;
	}

	// Only ambiguous words: skip a lone "no"/"si", but translate phrases like "no se".
	if (considered === 0) return words.length > 1;
	// Short messages count as English only if every word is English.
	if (considered <= 2) return english < considered;
	return !(english >= 2 && english / considered >= 0.5);
}
