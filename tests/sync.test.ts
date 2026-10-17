import { describe, expect, it } from "vitest";
import { removeLines } from "../src/codex/write";
import { approvedFrom, buildReviewRows } from "../src/modals/stateReviewModal";
import type { Entity } from "../src/codex/types";

const note = `# Mara

## Timeline
- ch 1 | location: [[Blackwood Manor]]
- ch 3 | location: [[Old Harbor]] | note: written by sync
- ch 3 | status: Injured
- ch 4 | note: hand-written
`;

describe("removeLines (re-sync replaces what the last sync wrote)", () => {
	it("removes exactly the listed lines and keeps everything else", () => {
		const r = removeLines(note, ["- ch 3 | location: [[Old Harbor]] | note: written by sync"]);
		expect(r.removed).toBe(1);
		expect(r.text).not.toContain("written by sync");
		expect(r.text).toContain("- ch 3 | status: Injured");
		expect(r.text).toContain("- ch 4 | note: hand-written");
	});
	it("leaves a line alone if it was edited by hand since", () => {
		const r = removeLines(note, ["- ch 3 | status: Wounded"]);
		expect(r.removed).toBe(0);
		expect(r.text).toBe(note);
	});
	it("removes one copy per listed line", () => {
		const r = removeLines("a\n- x\n- x\nb", ["- x"]);
		expect(r.text).toBe("a\n- x\nb");
	});
});

describe("approvedFrom (sync writes without a review step)", () => {
	const mara = { name: "Mara Winston", type: "character", aliases: [], path: "Codex/Characters/Mara Winston.md", description: "", timeline: [{ chapter: 1, fields: { location: "[[Blackwood Manor]]" } }], relationships: [] } as unknown as Entity;
	const index = { getEntity: (n: string) => (n === "Mara Winston" || n === "Mara" ? mara : undefined) };
	const update = {
		timeline: [
			{ entity: "Mara", fields: { location: "[[Old Harbor]]" }, note: "arrives" },
			{ entity: "Nobody Known", fields: { status: "Lost" } },
			{ entity: "Captain Rook", fields: { location: "[[Old Harbor]]" } },
		],
		relationships: [{ from: "Mara Winston", to: "Captain Rook", label: "uneasy ally" }],
		newEntities: [{ name: "Captain Rook", type: "character", description: "Runs the night boats.", aliases: [] }],
	};
	it("takes every change for known or newly created entities, and skips unknown names", () => {
		const a = approvedFrom(3, buildReviewRows(update as never, index, 3));
		expect(a.timeline.map((t) => t.entity).sort()).toEqual(["Captain Rook", "Mara Winston"]);
		expect(a.timeline.find((t) => t.entity === "Mara Winston")).toMatchObject({ fields: { location: "[[Old Harbor]]" }, note: "arrives" });
		expect(a.relationships).toHaveLength(1);
		expect(a.newEntities.map((e) => e.name)).toEqual(["Captain Rook"]);
	});
	it("drops changes the codex already records", () => {
		const a = approvedFrom(1, buildReviewRows({ timeline: [{ entity: "Mara", fields: { location: "[[Blackwood Manor]]" } }], relationships: [], newEntities: [] } as never, index, 1));
		expect(a.timeline).toHaveLength(0);
	});
});
