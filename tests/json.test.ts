import { describe, expect, it } from "vitest";
import { extractJson, JsonExtractError, stripTrailingCommas, validateContinuity, validateStateUpdate } from "../src/llm/json";

describe("extractJson", () => {
	it("reads a fenced json block", () => {
		expect(extractJson('Here you go:\n```json\n{"a": 1}\n```\nThanks')).toEqual({ a: 1 });
	});
	it("reads the outermost object from prose", () => {
		expect(extractJson('Sure! {"a": {"b": "}"}} trailing')).toEqual({ a: { b: "}" } });
	});
	it("tolerates trailing commas", () => {
		expect(extractJson('{"a": [1, 2,], "b": 3,}')).toEqual({ a: [1, 2], b: 3 });
	});
	it("does not strip commas inside strings", () => {
		expect(stripTrailingCommas('{"a": "x,}"}')).toBe('{"a": "x,}"}');
	});
	it("throws on garbage", () => {
		expect(() => extractJson("no json here")).toThrow(JsonExtractError);
	});
});

describe("validateStateUpdate", () => {
	it("normalises a valid payload", () => {
		const v = validateStateUpdate({
			timeline: [{ entity: "Mara Winston", fields: { Location: "[[Old Harbor]]", with: ["[[A]]", "[[B]]"] }, note: "escapes" }],
			relationships: [{ from: "Mara Winston", to: "Arthur Vane", label: "rival", fromChapter: "7", endsPrevious: true }],
			newEntities: [{ name: "Captain Rook", type: "Character", description: "smuggler", aliases: ["Rook"] }],
		});
		expect(v.timeline[0].fields).toEqual({ location: "[[Old Harbor]]", with: "[[A]], [[B]]" });
		expect(v.relationships[0].fromChapter).toBe(7);
		expect(v.newEntities[0].type).toBe("character");
	});
	it("drops unusable rows rather than failing", () => {
		const v = validateStateUpdate({ timeline: [{ fields: {} }, "x"], relationships: [{ from: "a" }] });
		expect(v.timeline).toEqual([]);
		expect(v.relationships).toEqual([]);
	});
	it("rejects wrong shapes", () => {
		expect(() => validateStateUpdate([])).toThrow(JsonExtractError);
		expect(() => validateStateUpdate({ timeline: "nope" })).toThrow(JsonExtractError);
		expect(() => validateStateUpdate({ foo: 1 })).toThrow(JsonExtractError);
	});
	it("validates continuity issues", () => {
		expect(validateContinuity({ issues: [{ quote: "q", conflict: "c", fix: "f" }, { quote: "x" }] })).toHaveLength(1);
	});
});
