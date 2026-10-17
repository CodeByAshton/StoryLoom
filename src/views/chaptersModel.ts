/** Pure logic for reordering chapters. Tested: renumbering must never lose where everyone is. */
import { findSection, parseRelationshipLine, parseTimelineLine } from "../codex/parse";

/**
 * Old chapter number -> new chapter number when chapters are put in `newOrder` (old numbers).
 * The set of numbers is kept (1,2,3 stays 1,2,3); only who gets which changes.
 */
export function reorderMapping(newOrder: number[]): Map<number, number> {
	const numbers = [...newOrder].sort((a, b) => a - b);
	const map = new Map<number, number>();
	newOrder.forEach((old, i) => {
		if (old !== numbers[i]) map.set(old, numbers[i]);
	});
	return map;
}

const remap = (map: Map<number, number>, n: number) => map.get(n) ?? n;

/**
 * Rewrite a codex note so its timeline lines and relationship ranges follow their chapters.
 * Returns the new text and how many lines changed. Lines that don't parse are left alone.
 */
export function remapNote(markdown: string, map: Map<number, number>): { text: string; changed: number } {
	if (!map.size) return { text: markdown, changed: 0 };
	const lines = markdown.split("\n");
	let changed = 0;

	const tl = findSection(markdown, "Timeline");
	if (tl) {
		for (let i = tl.headingLine + 1; i < tl.end; i++) {
			const entry = parseTimelineLine(lines[i]);
			if (!entry || !map.has(entry.chapter)) continue;
			lines[i] = lines[i].replace(/^(\s*[-*+]\s*(?:ch|chapter)\.?\s*)(\d+(?:\.\d+)?)/i, (_m, pre: string) => `${pre}${remap(map, entry.chapter)}`);
			changed++;
		}
	}

	const rel = findSection(markdown, "Relationships");
	if (rel) {
		for (let i = rel.headingLine + 1; i < rel.end; i++) {
			const r = parseRelationshipLine(lines[i]);
			if (!r || !Number.isFinite(r.range.from)) continue;
			const from = remap(map, r.range.from);
			const to = Number.isFinite(r.range.to) ? remap(map, r.range.to) : Infinity;
			if (from === r.range.from && to === r.range.to) continue;
			const [a, b] = to !== Infinity && to < from ? [to, from] : [from, to];
			const range = b === Infinity ? `(ch ${a}+)` : `(ch ${a}-${b})`;
			lines[i] = lines[i].replace(/\(\s*(?:ch|chs|chapter|chapters)\.?[^)]*\)\s*$/i, range);
			changed++;
		}
	}
	// Timeline lines must stay in chapter order for people reading the note.
	if (tl && changed) sortSection(lines, tl.headingLine + 1, tl.end);
	return { text: lines.join("\n"), changed };
}

/** Renumber one timeline or relationship line on its own (used for the record of what a sync wrote). */
export function remapLine(line: string, map: Map<number, number>): string {
	for (const heading of ["Timeline", "Relationships"]) {
		const r = remapNote(`## ${heading}\n${line}`, map);
		if (r.changed) return r.text.split("\n")[1];
	}
	return line;
}

/** Stable-sort the `- ch N` lines of a section by chapter, leaving other lines where they are. */
function sortSection(lines: string[], start: number, end: number) {
	const idx: number[] = [];
	const entries: { line: string; ch: number; i: number }[] = [];
	for (let i = start; i < end; i++) {
		const e = parseTimelineLine(lines[i]);
		if (e) {
			idx.push(i);
			entries.push({ line: lines[i], ch: e.chapter, i });
		}
	}
	entries.sort((a, b) => a.ch - b.ch || a.i - b.i);
	idx.forEach((pos, k) => (lines[pos] = entries[k].line));
}

/** "02 - Lamplight" -> "05 - Lamplight" (keeps the zero-padding). Null when the name has no number prefix. */
export function renumberedBasename(basename: string, newNumber: number): string | null {
	const m = /^(\d+)(\s*[-–.]\s*)(.*)$/.exec(basename);
	if (!m) return null;
	return `${String(newNumber).padStart(m[1].length, "0")}${m[2]}${m[3]}`;
}

export const STATUSES = ["draft", "revised", "final"] as const;
export type ChapterStatus = (typeof STATUSES)[number];

export function normalizeStatus(s: string | undefined): ChapterStatus {
	const v = (s ?? "").toLowerCase().trim();
	return (STATUSES as readonly string[]).includes(v) ? (v as ChapterStatus) : "draft";
}
