import { describe, expect, it } from "vitest";
import { diffWords, similarity, tokenize } from "../src/editor/diff";

describe("diffWords", () => {
	it("keeps all text and marks changed words", () => {
		const d = diffWords("The door opened slowly.", "The door burst open.");
		expect(d.filter((p) => p.kind !== "add").map((p) => p.text).join("")).toBe("The door opened slowly.");
		expect(d.filter((p) => p.kind !== "del").map((p) => p.text).join("")).toBe("The door burst open.");
		expect(d[0]).toEqual({ kind: "same", text: "The door " });
	});
	it("handles identical, empty and insert-only input", () => {
		expect(diffWords("a b", "a b")).toEqual([{ kind: "same", text: "a b" }]);
		expect(diffWords("", "new text")).toEqual([{ kind: "add", text: "new text" }]);
		expect(diffWords("old", "")).toEqual([{ kind: "del", text: "old" }]);
	});
	it("tokenizes words, spaces and punctuation without losing anything", () => {
		const s = "Mara's coat — wet, again.\n\nNext";
		expect(tokenize(s).join("")).toBe(s);
	});
	it("falls back for huge inputs and reports similarity", () => {
		expect(diffWords("a b c", "x y z", 4)).toEqual([{ kind: "del", text: "a b c" }, { kind: "add", text: "x y z" }]);
		expect(similarity(diffWords("one two three", "one two four"))).toBeGreaterThan(0.5);
		expect(similarity(diffWords("one two", "totally different words here"))).toBeLessThan(0.5);
	});
});
