/** Entity types recognised in the Codex. Extend this list to support more. */
export const ENTITY_TYPES = ["character", "location", "lore", "item", "faction"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export function isEntityType(value: unknown): value is EntityType {
	return typeof value === "string" && (ENTITY_TYPES as readonly string[]).includes(value);
}

export interface ChapterRange {
	from: number; // inclusive
	to: number; // inclusive; Infinity for open ranges
}

export interface Relationship {
	target: string; // resolved link target (alias part stripped)
	label: string;
	range: ChapterRange;
	/** 0-based line number inside the note, for writing back. */
	line?: number;
	raw?: string;
}

/** A field value of `null` means "cleared". */
export interface TimelineEntry {
	chapter: number;
	fields: Record<string, string | null>;
	note?: string;
	line?: number;
	raw?: string;
}

export interface Entity {
	name: string; // file basename
	path: string;
	type: EntityType;
	aliases: string[];
	role?: string;
	description: string;
	voice: string;
	relationships: Relationship[];
	timeline: TimelineEntry[];
}

export interface ChapterInfo {
	path: string;
	basename: string;
	chapter: number;
	title: string;
	pov?: string;
	summary?: string;
	status?: string;
}

export interface ResolvedState {
	chapter: number;
	fields: Record<string, string>;
	knows: string[];
	notes: { chapter: number; text: string }[]; // newest first
	lastChangedIn: Record<string, number>;
	relationships: { target: string; label: string; since: number }[];
}
