import { describe, expect, it } from "vitest";
import { parseRelationships, parseTimeline } from "../src/codex/parse";
import { resolveState } from "../src/codex/state";
import { normalizeStatus, remapNote, renumberedBasename, reorderMapping } from "../src/views/chaptersModel";

const MARA = `# Mara

## Relationships
- [[Arthur Vane]]: reluctant ally (ch 1-2)
- [[Arthur Vane]]: rival (ch 3+)
- [[Elias Crane]]: former partner

## Timeline
- ch 1 | location: [[Blackwood Manor]] | note: arrives
- ch 2 | status: Injured
- ch 3 | location: [[Old Harbor]]
- not a timeline line

## Notes
- ch 2 | should not change (not in Timeline)
`;

describe("reorderMapping", () => {
	it("keeps the set of numbers and maps old -> new", () => {
		expect([...reorderMapping([1, 3, 2])]).toEqual([[3, 2], [2, 3]]);
		expect(reorderMapping([1, 2, 3]).size).toBe(0);
		expect([...reorderMapping([3, 1, 2])]).toEqual([[3, 1], [1, 2], [2, 3]]);
	});
});

describe("remapNote", () => {
	it("moves timeline lines with their chapters and keeps them in order", () => {
		// New order: old ch 3 first, then 1, then 2  =>  3->1, 1->2, 2->3
		const { text, changed } = remapNote(MARA, reorderMapping([3, 1, 2]));
		const tl = parseTimeline(text);
		expect(tl.map((t) => `${t.chapter}:${t.fields.location ?? t.fields.status}`)).toEqual(["1:[[Old Harbor]]", "2:[[Blackwood Manor]]", "3:Injured"]);
		expect(text).toContain("## Notes\n- ch 2 | should not change");
		expect(text).toContain("- not a timeline line");
		expect(changed).toBeGreaterThan(0);
	});
	it("state follows the chapter: what was true in old ch 3 is true in its new slot", () => {
		const before = { timeline: parseTimeline(MARA), relationships: parseRelationships(MARA) };
		const map = reorderMapping([1, 3, 2]); // swap chapters 2 and 3
		const { text } = remapNote(MARA, map);
		const after = { timeline: parseTimeline(text), relationships: parseRelationships(text) };
		expect(resolveState(after, 2).fields.location).toBe(resolveState(before, 3).fields.location);
		expect(resolveState(after, 3).fields.status).toBe("Injured");
	});
	it("remaps relationship ranges, swapping ends if needed, and leaves 'always' alone", () => {
		const { text } = remapNote(MARA, reorderMapping([3, 1, 2]));
		expect(text).toContain("- [[Arthur Vane]]: reluctant ally (ch 2-3)");
		expect(text).toContain("- [[Arthur Vane]]: rival (ch 1+)");
		expect(text).toContain("- [[Elias Crane]]: former partner\n");
	});
	it("is a no-op for an identity mapping", () => {
		expect(remapNote(MARA, new Map())).toEqual({ text: MARA, changed: 0 });
	});
});

describe("helpers", () => {
	it("renumbers file names, keeping padding", () => {
		expect(renumberedBasename("02 - Lamplight", 5)).toBe("05 - Lamplight");
		expect(renumberedBasename("7. Dawn", 12)).toBe("12. Dawn");
		expect(renumberedBasename("The Harbor", 3)).toBeNull();
	});
	it("normalizes status", () => {
		expect(normalizeStatus("Revised")).toBe("revised");
		expect(normalizeStatus(undefined)).toBe("draft");
		expect(normalizeStatus("wip")).toBe("draft");
	});
});
