import { describe, expect, it } from "vitest";
import { parseRelationships, parseTimeline } from "../src/codex/parse";
import { buildContext, entityCard, voiceSample } from "../src/context/builder";
import { cleanProse, parseSenses, parseVersions } from "../src/context/prompts";
import type { Entity } from "../src/codex/types";
import { CACHE_MARK } from "../src/llm/types";

function ent(name: string, md: string, type: Entity["type"] = "character"): Entity {
	return { name, path: `Codex/${name}.md`, type, aliases: [], description: `${name} desc`, voice: "", relationships: parseRelationships(md), timeline: parseTimeline(md) };
}

const mara = ent("Mara Winston", "## Relationships\n- [[Arthur Vane]]: ally (ch 1-2)\n- [[Arthur Vane]]: rival (ch 3+)\n## Timeline\n- ch 1 | location: [[Blackwood Manor]]\n- ch 3 | location: [[Old Harbor]] | knows: the ledger is fake");

describe("entityCard", () => {
	it("shows state as of the chapter", () => {
		expect(entityCard(mara, 1)).toContain("location: Blackwood Manor (since ch 1)");
		expect(entityCard(mara, 1)).toContain("Arthur Vane — ally");
		const c3 = entityCard(mara, 3);
		expect(c3).toContain("location: Old Harbor (since ch 3)");
		expect(c3).toContain("Knows: the ledger is fake");
		expect(c3).toContain("Arthur Vane — rival");
	});
});

describe("buildContext", () => {
	const base = {
		book: "---\ntitle: x\n---\n# Book\n\n## Voice sample\nShort. Cold.\n",
		chapterText: "A".repeat(500),
		mode: "generate" as const,
		focusEntities: [mara],
		otherEntities: [ent("Elias Crane", "")],
		earlierSummaries: [
			{ chapter: 1, title: "One", summary: "First." },
			{ chapter: 2, title: "Two", summary: "Second." },
		],
		asOf: 3,
		budget: 100000,
	};
	it("includes everything when it fits, in reading order", () => {
		const c = buildContext(base);
		expect(c.truncated).toBe(false);
		expect(c.sections.map((s) => s.name)).toEqual(["book", "codex", "summaries", "chapter"]);
		expect(c.text.indexOf("Chapter 1 (One)")).toBeLessThan(c.text.indexOf("Chapter 2 (Two)"));
		expect(c.text).not.toContain("title: x");
	});
	it("drops other cards and oldest summaries first under a tight budget", () => {
		const c = buildContext({ ...base, budget: 950 });
		expect(c.truncated).toBe(true);
		expect(c.text).toContain("Mara Winston");
		expect(c.text).not.toContain("Elias Crane");
	});
	it("keeps the end of the text when generating", () => {
		const c = buildContext({ ...base, chapterText: "START" + "x".repeat(5000) + "END", budget: 2000 });
		expect(c.text).toContain("END");
		expect(c.text).not.toContain("START");
	});
	it("marks the cache boundary right before the chapter, with cards in a fixed order", () => {
		const c = buildContext(base);
		const [stable, rest] = c.text.split(CACHE_MARK);
		expect(rest).toContain("Text so far");
		expect(stable).not.toContain("Text so far");
		const swapped = buildContext({ ...base, focusEntities: base.otherEntities, otherEntities: base.focusEntities });
		expect(swapped.text.split(CACHE_MARK)[0]).toBe(stable);
	});
	it("reads the voice sample", () => {
		expect(voiceSample(base.book)).toBe("Short. Cold.");
	});
});

describe("output parsing", () => {
	it("splits versions", () => {
		expect(parseVersions("=== VERSION 1 ===\nOne.\n\n=== VERSION 2 ===\nTwo.")).toEqual(["One.", "Two."]);
		expect(parseVersions("Just one.")).toEqual(["Just one."]);
	});
	it("parses senses", () => {
		const s = parseSenses("Sight: grey.\n**Sound:** gulls.\nSmell: tar\nTouch: wet\nTaste/metaphor: salt like a debt");
		expect(s.map((x) => x.label)).toEqual(["Sight", "Sound", "Smell", "Touch", "Taste/metaphor"]);
		expect(s[1].text).toBe("gulls.");
	});
	it("cleans preambles and fences", () => {
		expect(cleanProse("Here's a continuation:\n\nShe ran.")).toBe("She ran.");
		expect(cleanProse("```\nShe ran.\n```")).toBe("She ran.");
		expect(cleanProse('"She ran."')).toBe("She ran.");
		expect(cleanProse('"Run," she said. "Now."')).toBe('"Run," she said. "Now."');
	});
});
