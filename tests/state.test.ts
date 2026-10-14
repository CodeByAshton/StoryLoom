import { describe, expect, it } from "vitest";
import { parseRelationships, parseTimeline } from "../src/codex/parse";
import { resolveState } from "../src/codex/state";
import {
	appendToSection,
	closeOpenRelationships,
	dedupeTimeline,
	formatTimelineLine,
	hasActiveRelationship,
} from "../src/codex/write";

function entity(md: string) {
	return { timeline: parseTimeline(md), relationships: parseRelationships(md) };
}

const MARA = `# Mara Winston

## Relationships
- [[Arthur Vane]]: reluctant ally (ch 1-6)
- [[Arthur Vane]]: rival (ch 7+)
- [[Elias Crane]]: former partner
- [[Captain Rook]]: debtor (ch 3)

## Timeline
- ch 7 | location: [[Old Harbor]] | with: — | knows: Arthur lied about the ledger
- ch 1 | location: [[Blackwood Manor]] | status: Safe | with: [[Arthur Vane]] | note: arrives at the manor
- ch 4 | status: Injured | note: shot in the left shoulder
- ch 9 | knows: the ledger is fake
- ch 9 | knows: Arthur lied about the ledger
`;

describe("resolveState", () => {
	const e = entity(MARA);

	it("folds entries in chapter order even when out of order in the file", () => {
		const s = resolveState(e, 4);
		expect(s.fields.location).toBe("[[Blackwood Manor]]");
		expect(s.fields.status).toBe("Injured");
		expect(s.lastChangedIn.status).toBe(4);
		expect(s.lastChangedIn.location).toBe(1);
	});

	it("later values override earlier ones", () => {
		expect(resolveState(e, 7).fields.location).toBe("[[Old Harbor]]");
		expect(resolveState(e, 6).fields.location).toBe("[[Blackwood Manor]]");
	});

	it("clearing removes the key", () => {
		expect(resolveState(e, 6).fields.with).toBe("[[Arthur Vane]]");
		const s7 = resolveState(e, 7);
		expect(s7.fields.with).toBeUndefined();
		expect(s7.lastChangedIn.with).toBe(7);
	});

	it("knows accumulates without duplicates", () => {
		expect(resolveState(e, 6).knows).toEqual([]);
		expect(resolveState(e, 7).knows).toEqual(["Arthur lied about the ledger"]);
		expect(resolveState(e, 9).knows).toEqual(["Arthur lied about the ledger", "the ledger is fake"]);
		expect(resolveState(e, 9).fields.knows).toBe("Arthur lied about the ledger; the ledger is fake");
	});

	it("knows can be cleared", () => {
		const s = resolveState(entity("## Timeline\n- ch 1 | knows: a\n- ch 2 | knows: b\n- ch 3 | knows: none\n- ch 4 | knows: c"), 4);
		expect(s.knows).toEqual(["c"]);
	});

	it("notes are newest first and limited to <= chapter", () => {
		expect(resolveState(e, 4).notes.map((n) => n.chapter)).toEqual([4, 1]);
		expect(resolveState(e, 1).notes).toEqual([{ chapter: 1, text: "arrives at the manor" }]);
	});

	it("chapter ranges: (ch 1-6), (ch 7+), (ch 3), and none", () => {
		const labels = (ch: number) => resolveState(e, ch).relationships.map((r) => `${r.target}:${r.label}`).sort();
		expect(labels(1)).toEqual(["Arthur Vane:reluctant ally", "Elias Crane:former partner"]);
		expect(labels(3)).toEqual(["Arthur Vane:reluctant ally", "Captain Rook:debtor", "Elias Crane:former partner"]);
		expect(labels(6)).toContain("Arthur Vane:reluctant ally");
		expect(labels(7)).toEqual(["Arthur Vane:rival", "Captain Rook:debtor", "Elias Crane:former partner"]);
	});

	it("Infinity gives the latest state and only open relationships", () => {
		const s = resolveState(e, Infinity);
		expect(s.fields.location).toBe("[[Old Harbor]]");
		expect(s.relationships.map((r) => r.label).sort()).toEqual(["debtor", "former partner", "rival"]);
	});

	it("before the first entry everything is empty", () => {
		const s = resolveState(e, 0);
		expect(s.fields).toEqual({});
		expect(s.notes).toEqual([]);
	});

	it("aliased wikilinks resolve to the target", () => {
		const s = resolveState(entity("## Relationships\n- [[Arthur Vane|Vane]]: rival"), 1);
		expect(s.relationships[0].target).toBe("Arthur Vane");
	});

	it("ignores malformed lines without crashing", () => {
		const s = resolveState(entity("## Timeline\n- ch 1 | status: ok\n- garbage\n- ch two | status: bad\n- ch 2 | | status: fine"), 5);
		expect(s.fields.status).toBe("fine");
	});
});

describe("writing helpers", () => {
	it("formats timeline lines in a stable key order", () => {
		expect(formatTimelineLine(3, { status: "Hurt", location: "[[Old Harbor]]", with: null }, "flees")).toBe(
			"- ch 3 | location: [[Old Harbor]] | status: Hurt | with: — | note: flees",
		);
		expect(formatTimelineLine(2, { status: "a | b" })).toBe("- ch 2 | status: a / b");
		expect(formatTimelineLine(2, { with: "[[Arthur Vane|Vane]]" })).toBe("- ch 2 | with: [[Arthur Vane|Vane]]");
	});

	it("appends inside an existing section, before the next heading", () => {
		const out = appendToSection(MARA + "\n## Notes\nstuff\n", "Timeline", ["- ch 10 | status: Fine"]);
		const lines = out.split("\n");
		const idx = lines.indexOf("- ch 10 | status: Fine");
		expect(lines[idx - 1]).toContain("ch 9");
		expect(lines.indexOf("## Notes")).toBeGreaterThan(idx);
	});

	it("creates the section when missing", () => {
		const out = appendToSection("# Rook\n\nA smuggler.\n", "Timeline", ["- ch 2 | status: Arrested"]);
		expect(out).toBe("# Rook\n\nA smuggler.\n\n## Timeline\n- ch 2 | status: Arrested\n");
	});

	it("closes open relationship ranges", () => {
		const md = "## Relationships\n- [[Arthur Vane]]: ally (ch 1+)\n- [[Arthur Vane|Vane]]: friend\n- [[Elias Crane]]: partner (ch 2+)\n- [[Arthur Vane]]: cousin (ch 9+)\n";
		const out = closeOpenRelationships(md, "Arthur Vane", 6);
		expect(out).toContain("- [[Arthur Vane]]: ally (ch 1-6)");
		expect(out).toContain("- [[Arthur Vane|Vane]]: friend (ch 1-6)");
		expect(out).toContain("- [[Elias Crane]]: partner (ch 2+)");
		expect(out).toContain("- [[Arthur Vane]]: cousin (ch 9+)");
	});

	it("dedupeTimeline skips values already in effect and is idempotent", () => {
		let md = MARA;
		const proposed = { fields: { location: "[[Old Harbor]]", status: "Injured", knows: "the ledger is fake" }, note: "searches the docks" };
		// ch 8: location and status already in effect; knows is new as of ch 8 (it's recorded in ch 9).
		const first = dedupeTimeline(entity(md), 8, proposed);
		expect(first).toEqual({ fields: { knows: "the ledger is fake" }, note: "searches the docks" });
		md = appendToSection(md, "Timeline", [formatTimelineLine(8, first!.fields, first!.note)]);
		expect(dedupeTimeline(entity(md), 8, proposed)).toBeNull();
	});

	it("dedupeTimeline compares links loosely and with-lists as sets", () => {
		const md = "## Timeline\n- ch 1 | location: [[Old Harbor|the harbor]] | with: [[A]], [[B]]";
		expect(dedupeTimeline(entity(md), 2, { fields: { location: "Old Harbor", with: "[[B]], [[A]]" } })).toBeNull();
		expect(dedupeTimeline(entity(md), 2, { fields: { with: "—" } })).toEqual({ fields: { with: null }, note: undefined });
		expect(dedupeTimeline(entity("## Timeline\n"), 2, { fields: { with: "none" } })).toBeNull();
	});

	it("hasActiveRelationship", () => {
		const e = entity(MARA);
		expect(hasActiveRelationship(e, "Arthur Vane", "rival", 7)).toBe(true);
		expect(hasActiveRelationship(e, "Arthur Vane", "rival", 6)).toBe(false);
	});
});
