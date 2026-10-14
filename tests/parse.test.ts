import { describe, expect, it, vi } from "vitest";
import {
	buildNameRegex,
	findSection,
	linkTargets,
	parseChapterRange,
	parseDescription,
	parseRelationshipLine,
	parseRelationships,
	parseTimeline,
	parseTimelineLine,
	parseWikilink,
	splitList,
	stripWikilinks,
} from "../src/codex/parse";

const MARA = `---
type: character
aliases: [Mara, Detective Winston]
role: Protagonist
---

# Mara Winston

## Description
Former detective, now hunting the Arcane Syndicate.

## Relationships
- [[Arthur Vane]]: reluctant ally (ch 1-6)
- [[Arthur Vane|Vane]]: rival (ch 7+)
- [[Elias Crane]]: former partner

## Timeline
- ch 1 | location: [[Blackwood Manor]] | status: Safe | with: [[Arthur Vane]] | note: arrives at the manor
- ch 4 | status: Injured | note: shot in the left shoulder
- this line is junk
- ch 7 | location: [[Old Harbor]] | with: — | knows: Arthur lied about the ledger

## Notes
- ch 99 | location: nowhere
`;

describe("wikilinks", () => {
	it("parses plain and aliased links", () => {
		expect(parseWikilink("[[Arthur Vane]]")).toBe("Arthur Vane");
		expect(parseWikilink("[[Arthur Vane|Arthur]]")).toBe("Arthur Vane");
		expect(parseWikilink("[[Arthur Vane#Bio|Arthur]]")).toBe("Arthur Vane");
		expect(parseWikilink("Arthur")).toBeNull();
	});
	it("strips links to display text and finds all targets", () => {
		expect(stripWikilinks("at [[Old Harbor]] with [[Arthur Vane|Vane]]")).toBe("at Old Harbor with Vane");
		expect(linkTargets("[[A]], [[B|bee]]")).toEqual(["A", "B"]);
	});
	it("splits with-lists", () => {
		expect(splitList("[[Arthur Vane]], [[Elias Crane|Elias]]")).toEqual(["Arthur Vane", "Elias Crane"]);
		expect(splitList("—")).toEqual([]);
		expect(splitList("Rook, [[Mara Winston]]")).toEqual(["Rook", "Mara Winston"]);
	});
});

describe("chapter ranges", () => {
	it("parses all forms", () => {
		expect(parseChapterRange("(ch 3)")).toEqual({ from: 3, to: Infinity });
		expect(parseChapterRange("(ch 3+)")).toEqual({ from: 3, to: Infinity });
		expect(parseChapterRange("(ch 1-6)")).toEqual({ from: 1, to: 6 });
		expect(parseChapterRange("(ch 1–6)")).toEqual({ from: 1, to: 6 });
		expect(parseChapterRange("(Chapter 2 - 4)")).toEqual({ from: 2, to: 4 });
		expect(parseChapterRange("(friends)")).toBeNull();
	});
});

describe("relationship lines", () => {
	it("parses label and range", () => {
		const r = parseRelationshipLine("- [[Arthur Vane]]: reluctant ally (ch 1-6)");
		expect(r).toMatchObject({ target: "Arthur Vane", label: "reluctant ally", range: { from: 1, to: 6 } });
	});
	it("no range means always", () => {
		const r = parseRelationshipLine("- [[Elias Crane]]: former partner");
		expect(r?.range.from).toBe(-Infinity);
		expect(r?.range.to).toBe(Infinity);
	});
	it("resolves aliased wikilinks", () => {
		expect(parseRelationshipLine("- [[Arthur Vane|Vane]]: rival (ch 7+)")?.target).toBe("Arthur Vane");
	});
	it("keeps parentheses that aren't ranges in the label", () => {
		expect(parseRelationshipLine("- [[A]]: friend (mostly)")?.label).toBe("friend (mostly)");
	});
	it("rejects non-relationship lines", () => {
		expect(parseRelationshipLine("- Arthur: friend")).toBeNull();
		expect(parseRelationshipLine("- [[Arthur]]:")).toBeNull();
	});
});

describe("timeline lines", () => {
	it("parses fields, lowercases keys and separates notes", () => {
		const t = parseTimelineLine("- ch 1 | Location: [[Blackwood Manor]] | status: Safe | note: arrives");
		expect(t).toMatchObject({ chapter: 1, fields: { location: "[[Blackwood Manor]]", status: "Safe" }, note: "arrives" });
	});
	it("treats —, - and none as clears", () => {
		expect(parseTimelineLine("- ch 7 | with: —")?.fields).toEqual({ with: null });
		expect(parseTimelineLine("- ch 7 | with: -")?.fields).toEqual({ with: null });
		expect(parseTimelineLine("- ch 7 | with: none")?.fields).toEqual({ with: null });
	});
	it("keeps multiple wikilinks in a value", () => {
		expect(parseTimelineLine("- ch 2 | with: [[A]], [[B|bee]]")?.fields.with).toBe("[[A]], [[B|bee]]");
	});
	it("returns null for malformed lines", () => {
		expect(parseTimelineLine("- this line is junk")).toBeNull();
		expect(parseTimelineLine("- ch x | status: ok")).toBeNull();
		expect(parseTimelineLine("- ch 3")).toBeNull();
		expect(parseTimelineLine("- ch 3 | no colon here")).toBeNull();
	});
});

describe("note parsing", () => {
	it("finds sections and stops at the next h2", () => {
		const s = findSection(MARA, "timeline");
		expect(s?.lines.filter((l) => l.startsWith("-")).length).toBe(4);
	});
	it("parses relationships and timeline from a full note, warning on junk", () => {
		const warn = vi.fn();
		expect(parseRelationships(MARA, warn)).toHaveLength(3);
		const tl = parseTimeline(MARA, warn);
		expect(tl.map((t) => t.chapter)).toEqual([1, 4, 7]);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(tl[0].line).toBeGreaterThan(0);
		expect(MARA.split("\n")[tl[0].line as number]).toContain("ch 1");
	});
	it("does not crash on notes without sections", () => {
		expect(parseTimeline("# Nothing here")).toEqual([]);
		expect(parseRelationships("")).toEqual([]);
	});
	it("reads the description", () => {
		expect(parseDescription(MARA)).toBe("Former detective, now hunting the Arcane Syndicate.");
		expect(parseDescription("---\ntype: lore\n---\n# The Ledger\n\nA book of debts.\n\nMore.")).toBe("A book of debts.");
	});
});

describe("name regex", () => {
	it("matches whole words, case-sensitive, longest first", () => {
		const re = buildNameRegex(["Mara", "Mara Winston", "Vane"]) as RegExp;
		const text = "Mara Winston met Vane. Maranda and mara did not. Mara's coat.";
		const hits = [...text.matchAll(re)].map((m) => m[0]);
		expect(hits).toEqual(["Mara Winston", "Vane", "Mara"]);
	});
	it("escapes regex characters", () => {
		const re = buildNameRegex(["Dr. Who (II)"]) as RegExp;
		expect("Dr. Who (II) arrived".match(re)?.[0]).toBe("Dr. Who (II)");
	});
	it("returns null for no names", () => {
		expect(buildNameRegex([])).toBeNull();
	});
});
