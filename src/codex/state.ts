import { linksToTargets } from "./parse";
import type { Relationship, ResolvedState, TimelineEntry } from "./types";

/** Keys that accumulate into a list instead of overriding. */
export const ACCUMULATING_KEYS = new Set(["knows"]);

export interface StateSource {
	timeline: TimelineEntry[];
	relationships: Relationship[];
}

/** Timeline entries sorted by chapter, keeping file order for equal chapters. */
export function sortedTimeline(timeline: TimelineEntry[]): TimelineEntry[] {
	return timeline
		.map((e, i) => ({ e, i }))
		.sort((a, b) => a.e.chapter - b.e.chapter || a.i - b.i)
		.map((x) => x.e);
}

export function isRelationshipActive(r: Relationship, chapter: number): boolean {
	return r.range.from <= chapter && chapter <= r.range.to;
}

/**
 * State of an entity as of `chapter` (inclusive). Pass `Infinity` for the latest state.
 * Pure: depends only on the parsed timeline and relationships.
 */
export function resolveState(entity: StateSource, chapter: number): ResolvedState {
	const fields: Record<string, string> = {};
	const lastChangedIn: Record<string, number> = {};
	const accum: Record<string, string[]> = {};
	const notes: { chapter: number; text: string }[] = [];

	for (const entry of sortedTimeline(entity.timeline)) {
		if (entry.chapter > chapter) break;
		for (const [key, value] of Object.entries(entry.fields)) {
			lastChangedIn[key] = entry.chapter;
			if (ACCUMULATING_KEYS.has(key)) {
				if (value === null) {
					delete accum[key];
				} else {
					const list = (accum[key] ??= []);
					if (!list.includes(value)) list.push(value);
				}
				continue;
			}
			if (value === null) delete fields[key];
			else fields[key] = value;
		}
		if (entry.note) notes.push({ chapter: entry.chapter, text: entry.note });
	}

	for (const [key, list] of Object.entries(accum)) fields[key] = list.join("; ");

	const relationships = entity.relationships
		.filter((r) => isRelationshipActive(r, chapter))
		.map((r) => ({ target: r.target, label: r.label, since: Number.isFinite(r.range.from) ? r.range.from : 0 }));

	return {
		chapter,
		fields,
		knows: accum["knows"] ?? [],
		notes: notes.reverse(),
		lastChangedIn,
		relationships,
	};
}

/** Normalise a field value for comparison: links stripped, whitespace collapsed, case-folded. */
export function normalizeValue(value: string): string {
	return linksToTargets(value).replace(/\s+/g, " ").trim().toLowerCase();
}

/** Did `key` change *in* this exact chapter? */
export function changedInChapter(state: ResolvedState, key: string): boolean {
	return state.lastChangedIn[key] === state.chapter;
}
