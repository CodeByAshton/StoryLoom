import { describe, expect, it } from "vitest";
import { parseRelationships, parseTimeline } from "../src/codex/parse";
import type { Entity } from "../src/codex/types";
import { hueFor, initials, laneEvents, locationRuns, presentAt } from "../src/views/timelineModel";

const mk = (name: string, type: Entity["type"], md: string, aliases: string[] = []): Entity => ({
	name, path: name, type, aliases, description: "", voice: "", relationships: parseRelationships(md), timeline: parseTimeline(md),
});
const mara = mk("Mara Winston", "character", "## Timeline\n- ch 1 | location: [[Manor]] | status: Safe\n- ch 2 | status: Injured | note: shot\n- ch 3 | location: [[Harbor|the harbor]] | knows: the truth\n- ch 5 | location: —");
const chapters = [1, 2, 3, 4, 5];

describe("timeline model", () => {
	it("merges consecutive chapters at one place into runs, with gaps where unknown", () => {
		expect(locationRuns(mara, chapters)).toEqual([
			{ start: 0, end: 1, location: "Manor" },
			{ start: 2, end: 3, location: "the harbor" },
		]);
	});
	it("lists what happened per chapter", () => {
		expect(laneEvents(mara, chapters).map((e) => `${e.index}:${e.kind}:${e.text}`)).toEqual(["0:status:Safe", "1:status:Injured", "1:note:shot", "2:knows:the truth"]);
	});
	it("finds who is at a place, by name or alias", () => {
		const harbor = mk("Harbor", "location", "", ["the docks"]);
		expect(presentAt(harbor, [mara], 3).map((e) => e.name)).toEqual(["Mara Winston"]);
		expect(presentAt(harbor, [mara], 1)).toEqual([]);
	});
	it("gives stable colours and initials", () => {
		expect(hueFor("Old Harbor")).toBe(hueFor("Old Harbor"));
		expect(initials("Mara Winston")).toBe("MW");
		expect(initials("Rook")).toBe("R");
	});
});
