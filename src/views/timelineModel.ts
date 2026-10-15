/** Pure data for the swimlane timeline. Tested. */
import { linksToTargets, stripWikilinks } from "../codex/parse";
import { resolveState } from "../codex/state";
import type { Entity } from "../codex/types";

export interface Run {
	/** Index into the chapter list (not the chapter number). */
	start: number;
	end: number; // inclusive
	location: string; // display name
}

/** Consecutive chapters at the same location merge into one run; chapters with no location are gaps. */
export function locationRuns(entity: Entity, chapters: number[]): Run[] {
	const runs: Run[] = [];
	chapters.forEach((ch, i) => {
		const raw = resolveState(entity, ch).fields.location;
		const loc = raw ? stripWikilinks(raw).trim() : "";
		const last = runs[runs.length - 1];
		if (!loc) return;
		if (last && last.location === loc && last.end === i - 1) last.end = i;
		else runs.push({ start: i, end: i, location: loc });
	});
	return runs;
}

export interface LaneEvent {
	index: number;
	kind: "status" | "knows" | "note" | "with";
	text: string;
}

/** What happened to an entity in each chapter: status changes, new knowledge, notes. */
export function laneEvents(entity: Entity, chapters: number[]): LaneEvent[] {
	const out: LaneEvent[] = [];
	chapters.forEach((ch, i) => {
		for (const t of entity.timeline.filter((e) => e.chapter === ch)) {
			if (t.fields.status) out.push({ index: i, kind: "status", text: stripWikilinks(t.fields.status) });
			if (t.fields.knows) out.push({ index: i, kind: "knows", text: stripWikilinks(t.fields.knows) });
			if (t.note) out.push({ index: i, kind: "note", text: stripWikilinks(t.note) });
		}
	});
	return out;
}

/** Characters at a location in a given chapter (by name or alias). */
export function presentAt(place: Entity, characters: Entity[], chapter: number): Entity[] {
	const names = new Set([place.name, ...place.aliases].map((n) => n.toLowerCase()));
	return characters.filter((c) => {
		const loc = resolveState(c, chapter).fields.location;
		return !!loc && names.has(linksToTargets(loc).trim().toLowerCase());
	});
}

/** Stable hue for a name, so a place keeps its colour everywhere. Golden-angle spacing keeps neighbours distinct. */
export function hueFor(name: string): number {
	let h = 2166136261;
	for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619) >>> 0;
	return Math.round((h % 997) * 137.508) % 360;
}

export function initials(name: string): string {
	const parts = name.split(/\s+/).filter(Boolean);
	return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/**
 * Hues for a known set of names: the i-th name gets i × the golden angle, so every place (or person)
 * in the codex has a clearly different colour. Unknown names fall back to `hueFor`.
 */
export function huePalette(names: string[], offset = 205): (name: string) => number {
	const map = new Map(names.map((n, i) => [n.toLowerCase(), Math.round(offset + i * 137.508) % 360]));
	return (name: string) => map.get(name.toLowerCase()) ?? hueFor(name);
}
