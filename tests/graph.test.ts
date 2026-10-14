import { describe, expect, it } from "vitest";
import { parseRelationships, parseTimeline } from "../src/codex/parse";
import type { Entity } from "../src/codex/types";
import { allPairs, edgesAt, forceLayout } from "../src/views/graphModel";

const mk = (name: string, type: Entity["type"], md: string, aliases: string[] = []): Entity => ({
	name, path: name, type, aliases, description: "", voice: "", relationships: parseRelationships(md), timeline: parseTimeline(md),
});

const ents = [
	mk("Mara", "character", "## Relationships\n- [[Arthur]]: ally (ch 1-2)\n- [[Arthur]]: rival (ch 3+)\n## Timeline\n- ch 1 | location: [[Manor]]\n- ch 3 | location: [[Harbor]]"),
	mk("Arthur", "character", "## Relationships\n- [[Mara]]: ally (ch 1-2)\n## Timeline\n- ch 1 | location: [[Manor]]"),
	mk("Elias", "character", "## Timeline\n- ch 3 | location: [[Harbor|the harbor]] | with: [[Mara]]"),
	mk("Manor", "location", ""),
	mk("Harbor", "location", "", ["the docks"]),
];

describe("edgesAt", () => {
	const opts = { together: true, presence: false };
	it("merges directions and shows both labels when they differ", () => {
		const e1 = edgesAt(ents, 1, opts).filter((e) => e.kind === "rel");
		expect(e1).toHaveLength(1);
		expect(e1[0].label).toBe("ally");
		const e3 = edgesAt(ents, 3, opts).filter((e) => e.kind === "rel");
		expect(e3[0].label).toBe("rival");
	});
	it("co-location edges change between chapters", () => {
		const t1 = edgesAt(ents, 1, opts).filter((e) => e.kind === "together").map((e) => `${e.a}-${e.b}`);
		const t3 = edgesAt(ents, 3, opts).filter((e) => e.kind === "together").map((e) => `${e.a}-${e.b}`);
		expect(t1).toEqual(["Arthur-Mara"]);
		expect(t3).toEqual(["Elias-Mara"]);
	});
	it("presence edges point characters at their location", () => {
		const at = edgesAt(ents, 3, { together: false, presence: true }).filter((e) => e.kind === "at").map((e) => `${e.a}@${e.b}`).sort();
		expect(at).toEqual(["Arthur@Manor", "Elias@Harbor", "Mara@Harbor"]);
	});
});

describe("forceLayout", () => {
	it("is deterministic and keeps existing positions fixed", () => {
		const nodes = ents.map((e) => e.name);
		const pairs = allPairs(ents, [1, 2, 3]);
		const a = forceLayout(nodes, pairs, { width: 800, height: 600 });
		const b = forceLayout(nodes, pairs, { width: 800, height: 600 });
		expect(a).toEqual(b);
		const c = forceLayout([...nodes, "New"], pairs, { width: 800, height: 600, existing: a, fixExisting: true, iterations: 50 });
		expect(c.get("Mara")).toEqual(a.get("Mara"));
		for (const p of a.values()) {
			expect(p.x).toBeGreaterThanOrEqual(40);
			expect(p.x).toBeLessThanOrEqual(760);
		}
	});
});
