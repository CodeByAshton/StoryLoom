import type { ChapterRange, Relationship, TimelineEntry } from "./types";

/** Values that clear a timeline key. */
const CLEAR_VALUES = new Set(["—", "–", "-", "none", ""]);

const WIKILINK_RE = /\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]*))?\]\]/g;

/** Target of a single wikilink like `[[Arthur Vane|Arthur]]` -> `Arthur Vane`. Returns null if not a link. */
export function parseWikilink(text: string): string | null {
	const m = /^\s*\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]\s*$/.exec(text);
	return m ? m[1].trim() : null;
}

/** All link targets inside a string. */
export function linkTargets(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(WIKILINK_RE)) out.push(m[1].trim());
	return out;
}

/** Replace wikilinks with their display text: `[[A|B]]` -> `B`, `[[A]]` -> `A`. */
export function stripWikilinks(text: string): string {
	return text.replace(WIKILINK_RE, (_m, target: string, alias?: string) => (alias ?? target).trim());
}

/** Replace wikilinks with their targets: `[[A|B]]` -> `A`. Used for comparisons. */
export function linksToTargets(text: string): string {
	return text.replace(WIKILINK_RE, (_m, target: string) => target.trim());
}

/**
 * Split a `with`-style list into entries. Accepts comma-separated wikilinks or plain names.
 * Returns link targets (or trimmed plain text).
 */
export function splitList(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0 && !CLEAR_VALUES.has(s.toLowerCase()))
		.map((s) => parseWikilink(s) ?? stripWikilinks(s));
}

export function isClearValue(value: string): boolean {
	return CLEAR_VALUES.has(value.trim().toLowerCase());
}

/** Parse `(ch 3)`, `(ch 3+)`, `(ch 1-6)`, `(chapters 2–4)`. Returns null if not a range. */
export function parseChapterRange(text: string): ChapterRange | null {
	const m = /^\(\s*(?:ch|chs|chapter|chapters)\.?\s*(\d+)\s*(?:(\+)|[-–—]\s*(\d+))?\s*\)$/i.exec(text.trim());
	if (!m) return null;
	const from = Number(m[1]);
	if (m[3] !== undefined) {
		const to = Number(m[3]);
		return to >= from ? { from, to } : { from: to, to: from };
	}
	return { from, to: Infinity };
}

export function formatChapterRange(range: ChapterRange): string {
	if (range.from <= 1 && range.to === Infinity) return "";
	if (range.to === Infinity) return `(ch ${range.from}+)`;
	return `(ch ${range.from}-${range.to})`;
}

export const ALWAYS: ChapterRange = { from: -Infinity, to: Infinity };

/** `- [[Target]]: label (ch 1-6)` */
export function parseRelationshipLine(line: string): Relationship | null {
	const m = /^\s*[-*+]\s*\[\[([^\]]+)\]\]\s*:\s*(.*)$/.exec(line);
	if (!m) return null;
	const target = parseWikilink(`[[${m[1]}]]`);
	if (!target) return null;
	let label = m[2].trim();
	let range: ChapterRange = ALWAYS;
	const rm = /\(\s*(?:ch|chs|chapter|chapters)\.?[^)]*\)\s*$/i.exec(label);
	if (rm) {
		const parsed = parseChapterRange(rm[0]);
		if (parsed) {
			range = parsed;
			label = label.slice(0, rm.index).trim();
		}
	}
	if (!label) return null;
	return { target, label: stripWikilinks(label), range, raw: line };
}

/** Split on `|`, ignoring pipes inside `[[target|alias]]`. */
export function splitPipes(text: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let cur = "";
	for (let i = 0; i < text.length; i++) {
		if (text.startsWith("[[", i)) {
			depth++;
			cur += "[[";
			i++;
		} else if (text.startsWith("]]", i) && depth > 0) {
			depth--;
			cur += "]]";
			i++;
		} else if (text[i] === "|" && depth === 0) {
			parts.push(cur);
			cur = "";
		} else cur += text[i];
	}
	parts.push(cur);
	return parts;
}

/** `- ch N | key: value | key: value` */
export function parseTimelineLine(line: string): TimelineEntry | null {
	const m = /^\s*[-*+]\s*(?:ch|chapter)\.?\s*(\d+(?:\.\d+)?)\s*(\|.*)?$/i.exec(line);
	if (!m) return null;
	const chapter = Number(m[1]);
	if (!Number.isFinite(chapter)) return null;
	const fields: Record<string, string | null> = {};
	let note: string | undefined;
	const rest = (m[2] ?? "").slice(1);
	if (rest.trim().length === 0) return null;
	for (const part of splitPipes(rest)) {
		const p = part.trim();
		if (!p) continue;
		const idx = p.indexOf(":");
		if (idx <= 0) return null; // malformed segment
		const key = p.slice(0, idx).trim().toLowerCase();
		const value = p.slice(idx + 1).trim();
		if (!/^[a-z][a-z0-9 _-]*$/.test(key)) return null;
		if (key === "note") {
			if (!isClearValue(value)) note = value;
			continue;
		}
		fields[key] = isClearValue(value) ? null : value;
	}
	if (Object.keys(fields).length === 0 && note === undefined) return null;
	return { chapter, fields, note, raw: line };
}

export interface Section {
	heading: string;
	/** 0-based line index of the heading. */
	headingLine: number;
	/** 0-based index of the first line after the section (exclusive end). */
	end: number;
	lines: string[];
}

/** Find a `## Heading` section (case-insensitive). Ends at the next heading of level <= 2. */
export function findSection(markdown: string, heading: string): Section | null {
	const lines = markdown.split("\n");
	const want = heading.trim().toLowerCase();
	let start = -1;
	for (let i = 0; i < lines.length; i++) {
		const hm = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
		if (!hm) continue;
		if (start === -1) {
			if (hm[1].length === 2 && hm[2].trim().toLowerCase() === want) start = i;
		} else if (hm[1].length <= 2) {
			return { heading, headingLine: start, end: i, lines: lines.slice(start + 1, i) };
		}
	}
	if (start === -1) return null;
	return { heading, headingLine: start, end: lines.length, lines: lines.slice(start + 1) };
}

export function sectionText(markdown: string, heading: string): string {
	const s = findSection(markdown, heading);
	return s ? s.lines.join("\n").trim() : "";
}

export interface Warn {
	(msg: string): void;
}

const isListLine = (l: string) => /^\s*[-*+]\s+/.test(l);

export function parseRelationships(markdown: string, warn?: Warn): Relationship[] {
	const s = findSection(markdown, "Relationships");
	if (!s) return [];
	const out: Relationship[] = [];
	s.lines.forEach((l, i) => {
		if (!isListLine(l)) return;
		const r = parseRelationshipLine(l);
		if (r) out.push({ ...r, line: s.headingLine + 1 + i });
		else warn?.(`Skipping malformed relationship line: ${l}`);
	});
	return out;
}

export function parseTimeline(markdown: string, warn?: Warn): TimelineEntry[] {
	const s = findSection(markdown, "Timeline");
	if (!s) return [];
	const out: TimelineEntry[] = [];
	s.lines.forEach((l, i) => {
		if (!isListLine(l)) return;
		const t = parseTimelineLine(l);
		if (t) out.push({ ...t, line: s.headingLine + 1 + i });
		else warn?.(`Skipping malformed timeline line: ${l}`);
	});
	return out;
}

/** Remove a leading YAML frontmatter block. */
export function stripFrontmatter(markdown: string): string {
	const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(markdown);
	return m ? markdown.slice(m[0].length) : markdown;
}

/** Description: the `## Description` section, or the first paragraph after the title. */
export function parseDescription(markdown: string): string {
	const d = sectionText(markdown, "Description");
	if (d) return d;
	const body = stripFrontmatter(markdown)
		.split("\n")
		.filter((l) => !/^#/.test(l))
		.join("\n")
		.trim();
	return body.split(/\n\s*\n/)[0] ?? "";
}

export function normalizeAliases(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.map((a) => String(a).trim()).filter(Boolean);
	if (typeof raw === "string") return raw.split(",").map((a) => a.trim()).filter(Boolean);
	return [];
}

export function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a single case-sensitive, whole-word regex for a set of names, longest first.
 * Returns null when there are no names.
 */
export function buildNameRegex(names: string[]): RegExp | null {
	const uniq = Array.from(new Set(names.filter((n) => n.trim().length > 0)));
	if (uniq.length === 0) return null;
	uniq.sort((a, b) => b.length - a.length);
	const body = uniq.map(escapeRegExp).join("|");
	// Unicode-aware word boundaries so "Mara's" matches but "Maranda" doesn't.
	return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])`, "gu");
}
