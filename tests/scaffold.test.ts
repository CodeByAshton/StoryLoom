import { describe, expect, it } from "vitest";
import { planScaffold, TEMPLATES } from "../src/scaffold";

const s = { manuscriptFolder: "Manuscript", codexFolder: "Codex", templatesFolder: "Templates", bookPath: "Book.md" };

describe("planScaffold", () => {
	it("plans everything for an empty vault", () => {
		const p = planScaffold(s, () => false, "The Glass City");
		expect(p.folders).toEqual(["Manuscript", "Codex/Characters", "Codex/Locations", "Codex/Lore", "Templates"]);
		expect(p.files.map((f) => f.path)).toEqual(["Book.md", "Templates/Chapter.md", "Templates/Character.md", "Templates/Location.md", "Templates/Lore.md"]);
		expect(p.files[0].content).toContain("# The Glass City");
		expect(p.files[0].content).toContain("## Voice sample");
	});
	it("never plans to overwrite what exists", () => {
		const have = new Set(["Manuscript", "Book.md", "Templates", "Templates/Chapter.md"]);
		const p = planScaffold(s, (x) => have.has(x));
		expect(p.folders).not.toContain("Manuscript");
		expect(p.files.map((f) => f.path)).not.toContain("Book.md");
		expect(p.files.map((f) => f.path)).not.toContain("Templates/Chapter.md");
	});
	it("templates match what the plugin parses", () => {
		expect(TEMPLATES.Chapter).toContain("type: chapter");
		expect(TEMPLATES.Character).toContain("## Timeline");
	});
});
