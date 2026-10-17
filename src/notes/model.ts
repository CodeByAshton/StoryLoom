/**
 * Writing notes: mechanical issues the AI spots when a chapter is synced (spelling, grammar, a word used
 * with the wrong meaning, run-on sentences, repetition). Not story feedback. Pure, so it's tested.
 */

export const NOTE_KINDS = {
	spelling: { label: "Spelling", icon: "spell-check" },
	grammar: { label: "Grammar", icon: "pilcrow" },
	"word-choice": { label: "Word choice", icon: "book-a" },
	punctuation: { label: "Punctuation", icon: "quote" },
	"run-on": { label: "Run-on sentence", icon: "wrap-text" },
	repetition: { label: "Repetition", icon: "repeat" },
	clarity: { label: "Clarity", icon: "glasses" },
} as const;

export type NoteKind = keyof typeof NOTE_KINDS;

export interface WritingNote {
	/** Exact text from the chapter (enough words to find it). */
	quote: string;
	kind: NoteKind;
	message: string;
	/** Replacement for the whole quote; empty when there's no single fix (e.g. "used 12 times"). */
	suggestion: string;
}

export interface ChapterNotes {
	/** Prose hash of the chapter when it was checked. */
	hash: string;
	notes: WritingNote[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

function normalizeKind(k: string): NoteKind {
	const s = k.toLowerCase().replace(/[\s_]+/g, "-");
	if (s in NOTE_KINDS) return s as NoteKind;
	if (/spell|typo/.test(s)) return "spelling";
	if (/word|usage|homophone|confus|meaning/.test(s)) return "word-choice";
	if (/run|long-sentence|comma-splice/.test(s)) return "run-on";
	if (/repeat|repetit|overus/.test(s)) return "repetition";
	if (/punct|comma|quote/.test(s)) return "punctuation";
	if (/clar|ambig/.test(s)) return "clarity";
	return "grammar";
}

export function validateWritingNotes(raw: unknown): WritingNote[] {
	const list = isObj(raw) ? raw.notes ?? raw.issues : raw;
	if (!Array.isArray(list)) throw new Error('Expected {"notes": [...]}.');
	const out: WritingNote[] = [];
	const seen = new Set<string>();
	for (const n of list) {
		if (!isObj(n)) continue;
		const quote = str(n.quote);
		const message = str(n.message) || str(n.explanation) || str(n.problem);
		if (!quote || !message || seen.has(quote)) continue;
		seen.add(quote);
		const suggestion = str(n.suggestion) || str(n.fix) || str(n.replacement);
		out.push({ quote, kind: normalizeKind(str(n.kind) || str(n.type)), message, suggestion: suggestion === quote ? "" : suggestion });
	}
	return out;
}

export interface LocatedNote {
	note: WritingNote;
	from: number;
	to: number;
}

/**
 * Where each note sits in the text. Notes whose quote is gone (the passage was edited) are skipped,
 * so stale notes quietly disappear. If a quote occurs more than once, the first unclaimed one is used.
 */
export function locateNotes(text: string, notes: WritingNote[], offset = 0): LocatedNote[] {
	const taken: [number, number][] = [];
	const out: LocatedNote[] = [];
	for (const note of notes) {
		let i = text.indexOf(note.quote);
		while (i !== -1 && taken.some(([a, b]) => i < b && i + note.quote.length > a)) i = text.indexOf(note.quote, i + 1);
		if (i === -1) continue;
		taken.push([i, i + note.quote.length]);
		out.push({ note, from: offset + i, to: offset + i + note.quote.length });
	}
	return out.sort((a, b) => a.from - b.from);
}

const WORD = /[\p{L}\p{N}']/u;

/**
 * Notes safe to show and fix: the quote occurs exactly once in the chapter and starts and ends on word
 * boundaries. A bare "lose" would also match inside "closed"; one fix there would write "cloosed".
 */
export function reliableNotes(text: string, notes: WritingNote[]): WritingNote[] {
	return notes.filter((n) => {
		const i = text.indexOf(n.quote);
		if (i === -1 || text.indexOf(n.quote, i + 1) !== -1) return false;
		const before = text[i - 1] ?? " ";
		const after = text[i + n.quote.length] ?? " ";
		const edgeOk = (inner: string | undefined, outer: string) => !(inner && WORD.test(inner) && WORD.test(outer));
		return edgeOk(n.quote[0], before) && edgeOk(n.quote[n.quote.length - 1], after);
	});
}

export const WRITING_NOTES_SCHEMA = `{"notes": [{"quote": "exact text from the chapter", "kind": "spelling|grammar|word-choice|punctuation|run-on|repetition|clarity", "message": "short explanation", "suggestion": "replacement for the quote, or empty"}]}`;
