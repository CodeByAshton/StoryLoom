import { describe, expect, it } from "vitest";
import { locateNotes, validateWritingNotes } from "../src/notes/model";

describe("validateWritingNotes", () => {
	it("keeps well-formed notes, normalizes kinds, drops junk and duplicates", () => {
		const notes = validateWritingNotes({
			notes: [
				{ quote: "went their", kind: "Homophone", message: "Means the place: “there”.", suggestion: "went there" },
				{ quote: "went their", kind: "grammar", message: "dup" },
				{ quote: "", kind: "spelling", message: "no quote" },
				{ quote: "a b c", type: "comma splice", explanation: "Two sentences joined by a comma.", fix: "a. B c" },
				{ quote: "same", kind: "typo", message: "No change", suggestion: "same" },
				"nonsense",
			],
		});
		expect(notes.map((n) => [n.quote, n.kind, n.suggestion])).toEqual([
			["went their", "word-choice", "went there"],
			["a b c", "run-on", "a. B c"],
			["same", "spelling", ""],
		]);
	});
	it("rejects a response with no list", () => expect(() => validateWritingNotes({ foo: 1 })).toThrow());
});

describe("locateNotes", () => {
	const n = (quote: string) => ({ quote, kind: "grammar" as const, message: "m", suggestion: "" });
	it("finds each quote, skips ones that are gone, and sorts by position", () => {
		const text = "She went their. Then she left. She went their again.";
		const out = locateNotes(text, [n("Then she left"), n("missing text"), n("went their")]);
		expect(out.map((l) => text.slice(l.from, l.to))).toEqual(["went their", "Then she left"]);
	});
	it("gives repeated quotes different occurrences", () => {
		const text = "the the cat";
		const out = locateNotes(text, [n("the"), n("the")]);
		expect(out.map((l) => l.from)).toEqual([0, 4]);
	});
	it("applies an offset", () => expect(locateNotes("abc", [n("b")], 10)[0]).toMatchObject({ from: 11, to: 12 }));
});
