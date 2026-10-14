/** Runs the shipped sample vault through the pure pipeline (acceptance tests 3–6, data side). */
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { buildNameRegex, parseDescription, parseRelationships, parseTimeline, stripFrontmatter } from "../src/codex/parse";
import { resolveState } from "../src/codex/state";
import type { Entity } from "../src/codex/types";
import { appendToSection, closeOpenRelationships, dedupeTimeline, formatRelationshipLine, formatTimelineLine, hasActiveRelationship } from "../src/codex/write";
import { edgesAt } from "../src/views/graphModel";

const VAULT = join(__dirname, "..", "My Book");

function fm(text: string): Record<string, string> {
	const m = /^---\n([\s\S]*?)\n---/.exec(text);
	const out: Record<string, string> = {};
	for (const line of m?.[1].split("\n") ?? []) {
		const i = line.indexOf(":");
		if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return out;
}

function loadEntities(): Entity[] {
	const out: Entity[] = [];
	for (const sub of ["Characters", "Locations", "Lore"]) {
		for (const f of readdirSync(join(VAULT, "Codex", sub))) {
			const text = readFileSync(join(VAULT, "Codex", sub, f), "utf8");
			const meta = fm(text);
			out.push({
				name: f.replace(/\.md$/, ""),
				path: `Codex/${sub}/${f}`,
				type: meta.type as Entity["type"],
				aliases: (meta.aliases ?? "").replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean),
				description: parseDescription(text),
				voice: "",
				relationships: parseRelationships(text),
				timeline: parseTimeline(text),
			});
		}
	}
	return out;
}

const entities = loadEntities();
const byName = (n: string) => entities.find((e) => e.name === n) as Entity;
const chapters = readdirSync(join(VAULT, "Manuscript")).sort().map((f) => {
	const text = readFileSync(join(VAULT, "Manuscript", f), "utf8");
	return { n: Number(fm(text).chapter), body: stripFrontmatter(text) };
});

describe("sample vault", () => {
	it("has 3 chapters, 3 characters, 2 locations, 1 lore entry, every line parseable", () => {
		expect(chapters.map((c) => c.n)).toEqual([1, 2, 3]);
		expect(entities.filter((e) => e.type === "character")).toHaveLength(3);
		expect(entities.filter((e) => e.type === "location")).toHaveLength(2);
		expect(entities.filter((e) => e.type === "lore")).toHaveLength(1);
		for (const e of entities) {
			const md = readFileSync(join(VAULT, e.path), "utf8");
			const listLines = md.split("\n").filter((l) => /^- /.test(l)).length;
			expect(e.relationships.length + e.timeline.length).toBe(listLines);
		}
	});

	it("(3) Mara's state differs between chapter 1 and chapter 3", () => {
		const s1 = resolveState(byName("Mara Winston"), 1);
		const s3 = resolveState(byName("Mara Winston"), 3);
		expect(s1.fields.location).toBe("[[Blackwood Manor]]");
		expect(s3.fields.location).toBe("[[Old Harbor]]");
		expect(s3.fields.status).toBe("Injured");
		expect(s3.lastChangedIn.status).toBe(2);
		expect(s3.knows).toEqual(["Arthur pawned the ledger himself"]);
	});

	it("(4) scrubbing 1 → 3 changes a relationship edge and a co-location edge", () => {
		const opts = { together: true, presence: true };
		const ids = (ch: number, kind: string) => new Set(edgesAt(entities, ch, opts).filter((e) => e.kind === kind).map((e) => e.id));
		const diff = (a: Set<string>, b: Set<string>) => [...a].filter((x) => !b.has(x));
		expect(diff(ids(1, "rel"), ids(3, "rel")).length).toBeGreaterThan(0);
		expect(diff(ids(3, "rel"), ids(1, "rel")).length).toBeGreaterThan(0);
		expect(diff(ids(1, "together"), ids(3, "together"))).toEqual(["together:Arthur Vane:Mara Winston"]);
		expect(diff(ids(3, "together"), ids(1, "together"))).toEqual(["together:Elias Crane:Mara Winston"]);
		const rel3 = edgesAt(entities, 3, opts).find((e) => e.id.startsWith("rel:Arthur Vane:Mara Winston"));
		expect(rel3?.label).toBe("hired help / rival");
	});

	it("(5) each character's location per chapter, and mention dots match the text", () => {
		const loc = (n: string, ch: number) => resolveState(byName(n), ch).fields.location;
		expect([1, 2, 3].map((c) => loc("Mara Winston", c))).toEqual(["[[Blackwood Manor]]", "[[Blackwood Manor]]", "[[Old Harbor]]"]);
		expect([1, 2, 3].map((c) => loc("Arthur Vane", c))).toEqual(Array(3).fill("[[Blackwood Manor]]"));
		expect([1, 2, 3].map((c) => loc("Elias Crane", c))).toEqual(Array(3).fill("[[Old Harbor]]"));

		const names = new Map<string, string>();
		for (const e of entities) for (const n of [e.name, ...e.aliases]) names.set(n, e.name);
		const re = buildNameRegex([...names.keys()]) as RegExp;
		const mentioned = chapters.map((c) => new Set([...c.body.matchAll(re)].map((m) => names.get(m[0]))));
		expect(mentioned.map((s) => s.has("Elias Crane"))).toEqual([false, false, true]);
		expect(mentioned.map((s) => s.has("Mara Winston"))).toEqual([true, true, true]);
		expect(mentioned.map((s) => s.has("Old Harbor"))).toEqual([false, true, true]);
		expect(mentioned.map((s) => s.has("The Ledger"))).toEqual([true, true, false]);
	});

	it("(6) applying a state update writes only checked items and is idempotent", () => {
		const path = join(VAULT, "Codex/Characters/Arthur Vane.md");
		let md = readFileSync(path, "utf8");
		const ch = 3;
		const apply = (text: string) => {
			let out = text;
			const src = { timeline: parseTimeline(out), relationships: parseRelationships(out) };
			// Proposed: location (already true → skipped), knows (new). Status row unchecked by the user → not passed in.
			const d = dedupeTimeline(src, ch, { fields: { location: "[[Blackwood Manor]]", knows: "Mara found the pawn ticket" }, note: "waits for Mara's report" });
			if (d) out = appendToSection(out, "Timeline", [formatTimelineLine(ch, d.fields, d.note)]);
			if (!hasActiveRelationship({ timeline: [], relationships: parseRelationships(out) }, "Mara Winston", "liability", ch)) {
				out = closeOpenRelationships(out, "Mara Winston", ch - 1, "liability");
				out = appendToSection(out, "Relationships", [formatRelationshipLine("Mara Winston", "liability", { from: ch, to: Infinity })]);
			}
			return out;
		};
		const once = apply(md);
		expect(once).toContain("- ch 3 | knows: Mara found the pawn ticket | note: waits for Mara's report");
		expect(once).not.toContain("- ch 3 | location");
		expect(once).toContain("- [[Mara Winston]]: hired help (ch 1-2)");
		expect(once).toContain("- [[Mara Winston]]: liability (ch 3+)");
		expect(apply(once)).toBe(once);
		md = once; // file on disk is untouched
	});
});
