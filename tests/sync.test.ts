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

import { changedLines, revertSynced } from "../src/codex/write";
import { remapLine } from "../src/views/chaptersModel";

describe("revertSynced (no manual clean-up after a rewrite)", () => {
	const before = "## Relationships\n- [[Arthur Vane]]: client (ch 1+)\n";
	const afterSync = "## Relationships\n- [[Arthur Vane]]: client (ch 1-2)\n- [[Arthur Vane]]: rival (ch 3+)\n";
	it("puts back relationships a sync closed and removes the ones it added", () => {
		const edits = changedLines(before, "## Relationships\n- [[Arthur Vane]]: client (ch 1-2)\n");
		expect(edits).toEqual([{ before: "- [[Arthur Vane]]: client (ch 1+)", after: "- [[Arthur Vane]]: client (ch 1-2)" }]);
		const r = revertSynced(afterSync, [{ line: edits[0].after, restore: edits[0].before }, { line: "- [[Arthur Vane]]: rival (ch 3+)" }]);
		expect(r.reverted).toBe(2);
		expect(r.text).toBe(before);
	});
	it("leaves lines alone that were changed by hand since", () => {
		const r = revertSynced("- [[Arthur Vane]]: rival (ch 4+)", [{ line: "- [[Arthur Vane]]: rival (ch 3+)" }]);
		expect(r.reverted).toBe(0);
	});
});

describe("remapLine", () => {
	const map = new Map([[3, 1], [1, 2], [2, 3]]);
	it("renumbers a single timeline line", () => expect(remapLine("- ch 3 | status: Injured", map)).toBe("- ch 1 | status: Injured"));
	it("renumbers a single relationship range", () => expect(remapLine("- [[Arthur Vane]]: rival (ch 3+)", map)).toBe("- [[Arthur Vane]]: rival (ch 1+)"));
	it("leaves other lines alone", () => expect(remapLine("hello", map)).toBe("hello"));
});

describe("revertSynced undoes in reverse order", () => {
	it("reopens then removes a relationship that the same sync added and then closed", () => {
		// The sync added "ally (ch 5+)", then a later change closed it to "(ch 5-5)".
		const text = "## Relationships\n- [[B]]: ally (ch 5-5)\n- [[B]]: rival (ch 6+)\n";
		const entries = [{ line: "- [[B]]: ally (ch 5+)" }, { line: "- [[B]]: ally (ch 5-5)", restore: "- [[B]]: ally (ch 5+)" }, { line: "- [[B]]: rival (ch 6+)" }];
		expect(revertSynced(text, entries).text).toBe("## Relationships\n");
	});
});

describe("revertSynced across renames", () => {
	it("matches a line whose link a rename left as is, or wrote path-qualified", () => {
		expect(revertSynced("- [[Old Name]]: rival (ch 3+)", [{ line: "- [[New Name]]: rival (ch 3+)" }]).text).toBe("");
		expect(revertSynced("- [[People/New Name|Arthur]]: rival (ch 3+)", [{ line: "- [[New Name|Arthur]]: rival (ch 3+)" }]).text).toBe("");
	});
	it("leaves it when more than one line differs only in its links", () => {
		const md = "- [[A]]: rival (ch 3+)\n- [[B]]: rival (ch 3+)";
		expect(revertSynced(md, [{ line: "- [[C]]: rival (ch 3+)" }]).reverted).toBe(0);
	});
});
