import { describe, expect, it } from "vitest";
import { withRetry } from "../src/llm/retry";
import { LLMError } from "../src/llm/types";

describe("withRetry", () => {
	const fast = [1, 1];
	it("retries transient failures, then succeeds", async () => {
		let n = 0;
		const r = await withRetry(async () => {
			if (n++ < 2) throw new LLMError("server", "overloaded");
			return "ok";
		}, false, () => true, fast);
		expect(r).toBe("ok");
		expect(n).toBe(3);
	});
	it("gives up after two retries", async () => {
		let n = 0;
		await expect(withRetry(async () => { n++; throw new LLMError("network", "down"); }, false, () => true, fast)).rejects.toThrow("down");
		expect(n).toBe(3);
	});
	it("never retries auth, config, aborts or plan limits", async () => {
		for (const e of [new LLMError("auth", "bad key"), new LLMError("config", "no key"), new LLMError("aborted", "stop"), new LLMError("rate_limit", "plan limit")]) {
			let n = 0;
			await expect(withRetry(async () => { n++; throw e; }, false, () => true, fast)).rejects.toBe(e);
			expect(n).toBe(1);
		}
	});
	it("retries a per-minute HTTP 429 but not once the caller says no (e.g. text already shown)", async () => {
		const e429 = new LLMError("rate_limit", "429", 429, true);
		let n = 0;
		await expect(withRetry(async () => { n++; throw e429; }, false, () => n < 2, fast)).rejects.toBe(e429);
		expect(n).toBe(2);
	});
});
