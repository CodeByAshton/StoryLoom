/** Assembles AI context within a character budget. Pure: callers gather the inputs. */
import { sectionText, stripFrontmatter, stripWikilinks } from "../codex/parse";
import { resolveState } from "../codex/state";
import type { ChapterInfo, Entity } from "../codex/types";
import { CACHE_MARK } from "../llm/types";

export interface ContextInput {
	/** Raw Book.md text (frontmatter allowed). */
	book: string;
	chapter?: ChapterInfo;
	/** Text up to the cursor (generation) or the full chapter (analysis). */
	chapterText: string;
	mode: "generate" | "analyze";
	/** POV + entities mentioned in the passage, in priority order. */
	focusEntities: Entity[];
	otherEntities: Entity[];
	/** Summaries of chapters before the current one. */
	earlierSummaries: { chapter: number; title: string; summary: string }[];
	asOf: number;
	budget: number;
}

export interface BuiltContext {
	text: string;
	sections: { name: string; chars: number }[];
	truncated: boolean;
}

export function voiceSample(book: string): string {
	return sectionText(book, "Voice sample") || sectionText(book, "Voice");
}

export function formatValue(v: string): string {
	return stripWikilinks(v);
}

/** A compact, model-readable card for one entity as of a chapter. */
export function entityCard(e: Entity, asOf: number): string {
	const s = resolveState(e, asOf);
	const lines = [`### ${e.name} (${e.type}${e.role ? " · " + e.role : ""})`];
	if (e.aliases.length) lines.push(`Also called: ${e.aliases.join(", ")}`);
	if (e.description) lines.push(`Description: ${oneLine(e.description, 600)}`);
	if (e.voice) lines.push(`Voice: ${oneLine(e.voice, 300)}`);
	const when = Number.isFinite(asOf) ? `as of chapter ${asOf}` : "latest";
	const fields = Object.entries(s.fields)
		.filter(([k]) => k !== "knows")
		.map(([k, v]) => `${k}: ${formatValue(v)}${s.lastChangedIn[k] !== undefined ? ` (since ch ${s.lastChangedIn[k]})` : ""}`);
	if (fields.length) lines.push(`State ${when}: ${fields.join("; ")}`);
	if (s.knows.length) lines.push(`Knows: ${s.knows.map(formatValue).join("; ")}`);
	if (s.relationships.length) lines.push(`Relationships: ${s.relationships.map((r) => `${r.target} — ${r.label}`).join("; ")}`);
	if (s.notes.length) lines.push(`Recent: ${s.notes.slice(0, 3).map((n) => `ch ${n.chapter}: ${n.text}`).join(" / ")}`);
	return lines.join("\n");
}

function oneLine(s: string, max: number): string {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/**
 * Fill by priority until the budget is hit:
 * 1. Book (always)  2. focus cards  3. earlier summaries, most recent first  4. chapter text  5. other cards.
 * The output is then laid out in reading order.
 */
export function buildContext(input: ContextInput): BuiltContext {
	let remaining = input.budget;
	let truncated = false;
	const take = (s: string): boolean => {
		if (s.length + 2 > remaining) return false;
		remaining -= s.length + 2;
		return true;
	};

	const book = stripFrontmatter(input.book).trim();
	const bookPart = book ? `## The book\n${book}` : "";
	remaining -= bookPart.length;

	// Cards are chosen by priority but written out in a fixed order, so the cached prefix of the
	// prompt stays byte-identical while you work in one chapter.
	const cards: { e: Entity; text: string }[] = [];
	for (const e of input.focusEntities) {
		const c = entityCard(e, input.asOf);
		if (take(c)) cards.push({ e, text: c });
		else truncated = true;
	}

	const summaries: string[] = [];
	const recentFirst = [...input.earlierSummaries].filter((s) => s.summary.trim()).sort((a, b) => b.chapter - a.chapter);
	for (const s of recentFirst) {
		const line = `- Chapter ${s.chapter} (${s.title}): ${oneLine(s.summary, 1500)}`;
		if (take(line)) summaries.unshift(line);
		else {
			truncated = true;
			break;
		}
	}

	let chapterText = input.chapterText;
	if (chapterText.length + 200 > remaining) {
		truncated = true;
		const keep = Math.max(0, remaining - 200);
		chapterText =
			input.mode === "generate"
				? "[…earlier text omitted…]\n" + chapterText.slice(chapterText.length - keep)
				: chapterText.slice(0, keep) + "\n[…rest of chapter omitted…]";
	}
	// If the chapter text had to be cut, there's no room for lower-priority cards.
	remaining = truncated && chapterText !== input.chapterText ? 0 : remaining - chapterText.length;

	for (const e of input.otherEntities) {
		const c = entityCard(e, input.asOf);
		if (take(c)) cards.push({ e, text: c });
		else truncated = true;
	}

	const parts: { name: string; text: string }[] = [];
	if (bookPart) parts.push({ name: "book", text: bookPart });
	if (cards.length) {
		const when = Number.isFinite(input.asOf) ? ` (states as of chapter ${input.asOf}; treat these as facts)` : " (latest states; treat these as facts)";
		const order = ["character", "location", "lore", "faction", "item"];
		cards.sort((a, b) => order.indexOf(a.e.type) - order.indexOf(b.e.type) || a.e.name.localeCompare(b.e.name));
		parts.push({ name: "codex", text: `## Codex${when}\n${cards.map((c) => c.text).join("\n\n")}` });
	}
	if (summaries.length) parts.push({ name: "summaries", text: `## Earlier chapters\n${summaries.join("\n")}` });
	if (input.chapter || chapterText.trim()) {
		const head = input.chapter
			? `## Current chapter: ${input.chapter.chapter} — ${input.chapter.title}${input.chapter.pov ? ` (POV: ${input.chapter.pov})` : ""}`
			: "## Current note";
		const label = input.mode === "generate" ? "Text so far" : "Full text";
		parts.push({ name: "chapter", text: `${head}\n${label}:\n<<<\n${chapterText}\n>>>` });
	}
	// Everything before the chapter is stable between requests; mark the boundary for prompt caching.
	const stable = parts.filter((p) => p.name !== "chapter").map((p) => p.text).join("\n\n");
	const chapterPart = parts.find((p) => p.name === "chapter")?.text ?? "";
	return {
		text: stable && chapterPart ? `${stable}${CACHE_MARK}\n\n${chapterPart}` : stable || chapterPart,
		sections: parts.map((p) => ({ name: p.name, chars: p.text.length })),
		truncated,
	};
}
