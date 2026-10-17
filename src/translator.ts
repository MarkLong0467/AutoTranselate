import { logger } from "@vendetta";
import { showToast } from "@vendetta/ui/toasts";

import { isEnglishCode } from "./languages";

export interface Translation {
	text: string;
	lang: string;
}

// null means "looked it up, nothing to show" (already English, or unchanged).
type Result = Translation | null;

interface Job {
	key: string;
	attempts: number;
	// Snowflake of the newest message waiting on this text; newest goes first.
	priority: string;
}

const MAX_CONCURRENT = 2;
const REQUEST_GAP_MS = 150;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_QUEUE = 150;
const MAX_CACHE = 2000;
const CHUNK_SIZE = 800;
const RETRY_FAILED_AFTER_MS = 2 * 60_000;

const results = new Map<string, Result>();
const waiting = new Map<string, Map<string, string>>(); // key -> messageId -> channelId
const inFlight = new Set<string>();
const failedUntil = new Map<string, number>();
const queue: Job[] = [];

let active = 0;
let pausedUntil = 0;
let backoffMs = 0;
let lastRateLimitToast = 0;
let pumpTimer: any = null;
let generation = 0;
let listener: (channelId: string, messageId: string) => void = () => {};

export function onTranslated(fn: (channelId: string, messageId: string) => void) {
	listener = fn;
}

/** Cached result for this text: a Translation, null (nothing to show), or undefined (not known yet). */
export function lookup(key: string): Result | undefined {
	return results.get(key);
}

export function request(key: string, channelId: string, messageId: string) {
	if (results.has(key)) return;

	const until = failedUntil.get(key);
	if (until && Date.now() < until) return;

	let refs = waiting.get(key);
	if (!refs) {
		refs = new Map();
		waiting.set(key, refs);
	}
	refs.set(messageId, channelId);

	if (inFlight.has(key)) {
		const job = queue.find(j => j.key === key);
		if (job && newerId(messageId, job.priority)) job.priority = messageId;
		return;
	}

	inFlight.add(key);
	queue.push({ key, attempts: 0, priority: messageId });

	if (queue.length > MAX_QUEUE) {
		// Drop the oldest waiting texts; they are requested again if they get rendered again.
		queue.sort((a, b) => (newerId(a.priority, b.priority) ? 1 : -1));
		for (const job of queue.splice(0, queue.length - MAX_QUEUE)) {
			inFlight.delete(job.key);
			waiting.delete(job.key);
		}
	}

	schedulePump(0);
}

export function clearTranslations() {
	results.clear();
	failedUntil.clear();
}

export function resetTranslator() {
	generation++;
	if (pumpTimer != null) clearTimeout(pumpTimer);
	pumpTimer = null;
	queue.length = 0;
	active = 0;
	pausedUntil = 0;
	backoffMs = 0;
	results.clear();
	waiting.clear();
	inFlight.clear();
	failedUntil.clear();
	listener = () => {};
}

function newerId(a: string, b: string) {
	return a.length !== b.length ? a.length > b.length : a > b;
}

function schedulePump(delay: number) {
	if (pumpTimer != null) return;
	pumpTimer = setTimeout(pump, delay);
}

function pump() {
	pumpTimer = null;

	const wait = pausedUntil - Date.now();
	if (wait > 0) {
		if (queue.length) schedulePump(wait);
		return;
	}

	while (active < MAX_CONCURRENT && queue.length) {
		let best = 0;
		for (let i = 1; i < queue.length; i++) {
			if (newerId(queue[i].priority, queue[best].priority)) best = i;
		}
		run(queue.splice(best, 1)[0]);
	}
}

function run(job: Job) {
	const gen = generation;
	active++;

	translate(job.key).then(
		result => {
			if (gen !== generation) return;
			active--;
			backoffMs = 0;
			finish(job.key, result);
			schedulePump(REQUEST_GAP_MS);
		},
		error => {
			if (gen !== generation) return;
			active--;
			fail(job, error);
			schedulePump(REQUEST_GAP_MS);
		},
	);
}

function finish(key: string, result: Result) {
	if (results.size >= MAX_CACHE) {
		// Maps iterate in insertion order, so this drops the oldest entries.
		let excess = results.size - MAX_CACHE + 1;
		for (const oldKey of results.keys()) {
			if (excess-- <= 0) break;
			results.delete(oldKey);
		}
	}
	results.set(key, result);
	inFlight.delete(key);
	failedUntil.delete(key);

	const refs = waiting.get(key);
	waiting.delete(key);
	if (!result || !refs) return;

	refs.forEach((channelId, messageId) => {
		try {
			listener(channelId, messageId);
		} catch (e) {
			logger.error("AutoTranslate: failed to refresh message", e);
		}
	});
}

function fail(job: Job, error: any) {
	if (error?.rateLimited) {
		queue.unshift(job);
		// Several requests can fail at once; only back off further once per pause.
		if (Date.now() < pausedUntil) return;
		backoffMs = Math.min(backoffMs ? backoffMs * 2 : 60_000, 10 * 60_000);
		pausedUntil = Date.now() + backoffMs;

		if (Date.now() - lastRateLimitToast > 10 * 60_000) {
			lastRateLimitToast = Date.now();
			showToast(`AutoTranslate: Google is limiting requests, retrying in ${Math.round(backoffMs / 60_000)} min`);
		}
		logger.warn(`AutoTranslate: rate limited, pausing for ${backoffMs / 1000}s`);
		return;
	}

	job.attempts++;
	if (job.attempts < 3) {
		const gen = generation;
		setTimeout(() => {
			if (gen !== generation) return;
			queue.push(job);
			schedulePump(0);
		}, 4000 * job.attempts);
		return;
	}

	logger.warn("AutoTranslate: giving up on a message for now", String(error?.message ?? error));
	inFlight.delete(job.key);
	waiting.delete(job.key);
	failedUntil.set(job.key, Date.now() + RETRY_FAILED_AFTER_MS);
}

// --- Google Translate ---

function rateLimitError(): Error {
	const error: any = new Error("Rate limited by Google Translate");
	error.rateLimited = true;
	return error;
}

function fetchText(url: string): Promise<{ status: number; ok: boolean; url: string; body: string }> {
	const controller = typeof AbortController === "function" ? new AbortController() : undefined;
	const timer = setTimeout(() => controller?.abort(), REQUEST_TIMEOUT_MS);

	return fetch(url, { signal: controller?.signal }).then(
		res =>
			res.text().then(
				body => {
					clearTimeout(timer);
					return { status: res.status, ok: res.ok, url: res.url ?? "", body };
				},
				error => {
					clearTimeout(timer);
					throw error;
				},
			),
		error => {
			clearTimeout(timer);
			throw error;
		},
	);
}

function checkResponse(res: { status: number; ok: boolean; url: string; body: string }) {
	// Google answers too many requests with 429 or a redirect to an HTML captcha page.
	if (res.status === 429 || res.url.indexOf("/sorry/") !== -1) throw rateLimitError();
	if (!res.ok) throw new Error(`Google Translate returned HTTP ${res.status}`);
	if (/^\s*</.test(res.body)) throw rateLimitError();
	return JSON.parse(res.body);
}

async function translateWithGtx(text: string): Promise<Translation> {
	const res = await fetchText(
		`https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&dj=1&sl=auto&tl=en&q=${encodeURIComponent(text)}`,
	);
	const json = checkResponse(res);
	if (!json || !Array.isArray(json.sentences)) throw new Error("Unexpected Google Translate response");

	let out = "";
	for (const sentence of json.sentences) {
		if (sentence && typeof sentence.trans === "string") out += sentence.trans;
	}
	return { text: out, lang: typeof json.src === "string" ? json.src : "" };
}

async function translateWithDict(text: string): Promise<Translation> {
	const res = await fetchText(
		`https://clients5.google.com/translate_a/t?client=dict-chrome-ex&sl=auto&tl=en&q=${encodeURIComponent(text)}`,
	);
	const json = checkResponse(res);

	// Seen shapes: [["translation", "es"]], ["translation"], or the gtx object.
	if (Array.isArray(json)) {
		const first = json[0];
		if (Array.isArray(first) && typeof first[0] === "string") {
			return { text: first[0], lang: typeof first[1] === "string" ? first[1] : "" };
		}
		if (typeof first === "string") return { text: first, lang: "" };
	} else if (json && Array.isArray(json.sentences)) {
		let out = "";
		for (const sentence of json.sentences) {
			if (sentence && typeof sentence.trans === "string") out += sentence.trans;
		}
		return { text: out, lang: typeof json.src === "string" ? json.src : "" };
	}
	throw new Error("Unexpected Google Translate response");
}

// While the main endpoint is limiting us, go straight to the fallback.
let gtxPausedUntil = 0;

async function translateChunk(text: string): Promise<Translation> {
	const skipGtx = Date.now() < gtxPausedUntil;
	let gtxError: any;
	if (!skipGtx) {
		try {
			return await translateWithGtx(text);
		} catch (error: any) {
			gtxError = error;
			if (error?.rateLimited) gtxPausedUntil = Date.now() + 5 * 60_000;
		}
	}

	try {
		return await translateWithDict(text);
	} catch (error: any) {
		// Make the queue back off if the main endpoint is limiting us.
		if (skipGtx || error?.rateLimited || gtxError?.rateLimited) throw rateLimitError();
		throw gtxError ?? error;
	}
}

/** Drops unpaired surrogates, which make encodeURIComponent throw. */
function wellFormed(text: string) {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				out += text[i] + text[i + 1];
				i++;
			}
		} else if (code < 0xdc00 || code > 0xdfff) {
			out += text[i];
		}
	}
	return out;
}

/**
 * Splits long text so each request stays small, preferring line breaks and
 * then spaces. The separator stays at the end of its chunk.
 */
export function splitText(text: string, size = CHUNK_SIZE): string[] {
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > size) {
		let cut = rest.lastIndexOf("\n", size - 1) + 1;
		if (cut < size / 2) cut = rest.lastIndexOf(" ", size - 1) + 1;
		if (cut < size / 2) {
			cut = size;
			const code = rest.charCodeAt(cut - 1);
			if (code >= 0xd800 && code <= 0xdbff) cut--;
		}
		chunks.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest) chunks.push(rest);
	return chunks;
}

function comparable(text: string) {
	return text.toLowerCase().replace(/[\s.,!?;:'"()\[\]{}\-_*~`]+/g, "");
}

export async function translate(text: string): Promise<Result> {
	const source = wellFormed(text);
	const chunks = splitText(source);

	let lang = "";
	let out = "";
	for (const chunk of chunks) {
		const part = await translateChunk(chunk);
		if (!lang && part.lang) lang = part.lang;
		out += part.text;
		// Google drops trailing whitespace, which would glue chunks together.
		const end = chunk[chunk.length - 1];
		if ((end === " " || end === "\n") && !/\s$/.test(part.text)) out += end;
	}

	out = out.trim();
	if (!out || isEnglishCode(lang)) return null;
	if (comparable(out) === comparable(source)) return null;
	return { text: out, lang };
}
