/**
 * Pure helpers that produce new note text. The plugin reads the file, runs these, and writes it back,
 * so all the logic that has to be idempotent is unit-testable.
 */
import { findSection, splitPipes, formatChapterRange, isClearValue, parseRelationshipLine, parseWikilink, stripWikilinks } from "./parse";
import { ACCUMULATING_KEYS, isRelationshipActive, normalizeValue, resolveState, type StateSource } from "./state";
import type { ChapterRange } from "./types";

const KEY_ORDER = ["location", "status", "with", "knows"];

export function formatTimelineLine(chapter: number, fields: Record<string, string | null>, note?: string): string {
	const keys = Object.keys(fields).sort((a, b) => {
		const ia = KEY_ORDER.indexOf(a);
		const ib = KEY_ORDER.indexOf(b);
		return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
	});
	const parts = [`- ch ${chapter}`];
	for (const k of keys) parts.push(`${k}: ${fields[k] === null ? "—" : clean(fields[k] as string)}`);
	if (note && note.trim()) parts.push(`note: ${clean(note)}`);
	return parts.join(" | ");
}

/** Pipes and newlines would break the line format. */
function clean(v: string): string {
	return splitPipes(v.replace(/\s*\n\s*/g, " ")).join("/").trim();
}

export function formatRelationshipLine(target: string, label: string, range?: ChapterRange): string {
	const r = range ? formatChapterRange(range) : "";
	return `- [[${target}]]: ${clean(label)}${r ? " " + r : ""}`;
}

/**
 * Append lines to the end of `## heading` (after its last non-blank line).
 * Creates the section at the end of the note if it doesn't exist.
 */
export function appendToSection(markdown: string, heading: string, newLines: string[]): string {
	if (newLines.length === 0) return markdown;
	const section = findSection(markdown, heading);
	const lines = markdown.split("\n");
	if (!section) {
		while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
		return [...lines, "", `## ${heading}`, ...newLines, ""].join("\n");
	}
	let insertAt = section.headingLine + 1;
	for (let i = section.headingLine + 1; i < section.end; i++) {
		if (lines[i].trim() !== "") insertAt = i + 1;
	}
	lines.splice(insertAt, 0, ...newLines);
	return lines.join("\n");
}

/**
 * Remove lines a previous chapter sync wrote, so a re-sync replaces them instead of piling up.
 * Exact matches only (ignoring surrounding whitespace), one removal per listed line, so anything
 * edited or written by hand stays.
 */
export function removeLines(markdown: string, toRemove: string[]): { text: string; removed: number } {
	if (!toRemove.length) return { text: markdown, removed: 0 };
	const pending = new Map<string, number>();
	for (const l of toRemove) pending.set(l.trim(), (pending.get(l.trim()) ?? 0) + 1);
	let removed = 0;
	const kept = markdown.split("\n").filter((line) => {
		const n = pending.get(line.trim()) ?? 0;
		if (!n) return true;
		pending.set(line.trim(), n - 1);
		removed++;
		return false;
	});
	return { text: kept.join("\n"), removed };
}

/** A line a sync wrote: added (removed on re-sync) or edited from `restore` (put back on re-sync). */
export interface SyncedLine {
	path: string;
	line: string;
	restore?: string;
}

/** Undo what an earlier sync did to one note: drop the lines it added, put back the lines it edited. */
export function revertSynced(markdown: string, entries: Pick<SyncedLine, "line" | "restore">[]): { text: string; reverted: number } {
	const lines = markdown.split("\n");
	let reverted = 0;
	const drop = new Set<number>();
	// Undo in reverse: a line added and then closed by the same sync must be reopened before it's removed.
	for (const e of [...entries].reverse()) {
		let i = lines.findIndex((l, idx) => !drop.has(idx) && l.trim() === e.line.trim());
		if (i === -1) {
			// A rename may have changed the links (or left them alone when the record was relinked):
			// accept a line that differs only in its link targets, if exactly one does.
			const key = linkless(e.line);
			const hits = lines.flatMap((l, idx) => (!drop.has(idx) && linkless(l) === key ? [idx] : []));
			if (hits.length !== 1) continue; // edited by hand since: leave it
			i = hits[0];
		}
		if (e.restore !== undefined) lines[i] = e.restore;
		else drop.add(i);
		reverted++;
	}
	return { text: lines.filter((_, i) => !drop.has(i)).join("\n"), reverted };
}

/** A line with its wikilink targets blanked (aliases kept), for matching across renames. */
function linkless(line: string): string {
	return line.trim().replace(/\[\[[^\]|]*(\|[^\]]*)?\]\]/g, (_, alias: string | undefined) => `[[${alias ?? ""}]]`);
}

/** Lines that differ between two versions of a note with the same line count (what an in-place edit changed). */
export function changedLines(before: string, after: string): { before: string; after: string }[] {
	const a = before.split("\n");
	const b = after.split("\n");
	if (a.length !== b.length) return [];
	return a.flatMap((l, i) => (l !== b[i] ? [{ before: l, after: b[i] }] : []));
}

/**
 * Close any open-ended relationship to `target` so it ends at `endChapter`.
 * `(ch 1+)` -> `(ch 1-6)`; no range -> `(ch 1-6)`. Ranges that start after `endChapter` are left alone.
 */
export function closeOpenRelationships(markdown: string, target: string, endChapter: number, exceptLabel?: string): string {
	const section = findSection(markdown, "Relationships");
	if (!section) return markdown;
	const lines = markdown.split("\n");
	for (let i = section.headingLine + 1; i < section.end; i++) {
		const rel = parseRelationshipLine(lines[i]);
		if (!rel || rel.target !== target || rel.range.to !== Infinity) continue;
		if (exceptLabel && normalizeValue(rel.label) === normalizeValue(exceptLabel)) continue;
		const from = Number.isFinite(rel.range.from) ? rel.range.from : 1;
		if (from > endChapter) continue;
		const indent = /^\s*/.exec(lines[i])?.[0] ?? "";
		const link = /\[\[[^\]]+\]\]/.exec(lines[i])?.[0] ?? `[[${target}]]`;
		lines[i] = `${indent}- ${link}: ${rel.label} (ch ${from}-${endChapter})`;
	}
	return lines.join("\n");
}

export interface ProposedTimeline {
	fields: Record<string, string | null>;
	note?: string;
}

/**
 * Drop fields that the entity already has as of `chapter`, and a note already recorded in that chapter.
 * Returns null when nothing is left to write. This is what makes "Update story state" idempotent.
 */
export function dedupeTimeline(entity: StateSource, chapter: number, proposed: ProposedTimeline): ProposedTimeline | null {
	const state = resolveState(entity, chapter);
	const fields: Record<string, string | null> = {};
	for (const [rawKey, rawValue] of Object.entries(proposed.fields)) {
		const key = rawKey.trim().toLowerCase();
		if (!key || key === "note") continue;
		const value = rawValue === null || isClearValue(rawValue) ? null : rawValue.trim();
		if (ACCUMULATING_KEYS.has(key)) {
			if (value === null) {
				if (state.knows.length > 0) fields[key] = null;
				continue;
			}
			const known = new Set(state.knows.map(normalizeValue));
			if (!known.has(normalizeValue(value))) fields[key] = value;
			continue;
		}
		const current = state.fields[key];
		if (value === null) {
			if (current !== undefined) fields[key] = null;
		} else if (current === undefined || !sameValue(key, current, value)) {
			fields[key] = value;
		}
	}
	let note = proposed.note?.trim() || undefined;
	if (note && state.notes.some((n) => n.chapter === chapter && normalizeValue(n.text) === normalizeValue(note as string))) {
		note = undefined;
	}
	if (Object.keys(fields).length === 0 && !note) return null;
	return { fields, note };
}

function sameValue(key: string, a: string, b: string): boolean {
	if (key === "with") {
		const set = (v: string) =>
			v
				.split(",")
				.map((s) => normalizeValue(parseWikilink(s) ?? s))
				.filter(Boolean)
				.sort()
				.join(",");
		return set(a) === set(b);
	}
	return normalizeValue(a) === normalizeValue(b);
}

/** Is this relationship already active at `chapter` with the same label? */
export function hasActiveRelationship(entity: StateSource, target: string, label: string, chapter: number): boolean {
	return entity.relationships.some(
		(r) =>
			r.target === target &&
			isRelationshipActive(r, chapter) &&
			normalizeValue(r.label) === normalizeValue(stripWikilinks(label)),
	);
}

export const TYPE_FOLDERS: Record<string, string> = {
	character: "Characters",
	location: "Locations",
	lore: "Lore",
	item: "Items",
	faction: "Factions",
};

/**
 * Fill a Codex template for a new entity. Replaces {{title}}/{{name}}, writes aliases into frontmatter
 * and puts the description under ## Description. Works without a template too.
 */
export function fillEntityTemplate(template: string | null, opts: { name: string; type: string; description: string; aliases: string[] }): string {
	const aliasYaml = `[${opts.aliases.map((a) => (/[,:[\]{}#&*!|>'"%@`]/.test(a) ? JSON.stringify(a) : a)).join(", ")}]`;
	let t =
		template ??
		`---\ntype: ${opts.type}\naliases: []\n---\n\n# {{title}}\n\n## Description\n\n## Relationships\n\n## Timeline\n`;
	t = t.replace(/\{\{\s*(title|name)\s*\}\}/g, opts.name);
	const fm = /^---\n([\s\S]*?)\n---/.exec(t);
	if (fm) {
		let body = fm[1];
		body = /^type:.*$/m.test(body) ? body.replace(/^type:.*$/m, `type: ${opts.type}`) : `type: ${opts.type}\n${body}`;
		body = /^aliases:.*$/m.test(body) ? body.replace(/^aliases:.*$/m, `aliases: ${aliasYaml}`) : `${body}\naliases: ${aliasYaml}`;
		t = `---\n${body}\n---` + t.slice(fm[0].length);
	} else {
		t = `---\ntype: ${opts.type}\naliases: ${aliasYaml}\n---\n\n` + t;
	}
	if (opts.description.trim()) {
		const s = findSection(t, "Description");
		if (s) {
			const lines = t.split("\n");
			const existing = s.lines.filter((l) => l.trim() && !/^\s*<!--/.test(l));
			if (existing.length === 0) {
				lines.splice(s.headingLine + 1, s.end - s.headingLine - 1, opts.description.trim(), "");
				t = lines.join("\n");
			}
		} else {
			t = appendToSection(t, "Description", [opts.description.trim()]);
		}
	}
	return t;
}

/** A filename-safe version of a name. */
export function safeFileName(name: string): string {
	return name.replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim();
}
