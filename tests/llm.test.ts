import { describe, expect, it } from "vitest";
import { buildAnthropicRequest, isModernClaude, parseAnthropicResponse } from "../src/llm/anthropic";
import { createClient } from "../src/llm/client";
import { LLMError, type HttpRequest } from "../src/llm/types";

const req = { system: "sys", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 100, temperature: 0.8 };

describe("anthropic", () => {
	it("detects models that reject temperature", () => {
		expect(isModernClaude("claude-sonnet-5-5")).toBe(true);
		expect(isModernClaude("claude-opus-4-8")).toBe(true);
		expect(isModernClaude("claude-sonnet-4-6")).toBe(false);
		expect(isModernClaude("claude-3-5-sonnet-20241022")).toBe(false);
	});
	it("builds a request with the right headers and no temperature on modern models", () => {
		const r = buildAnthropicRequest({ apiKey: "k", model: "claude-sonnet-5-5", effort: "medium" }, req, false);
		const body = JSON.parse(r.body);
		expect(r.headers["x-api-key"]).toBe("k");
		expect(r.headers["anthropic-version"]).toBe("2023-06-01");
		expect(body.temperature).toBeUndefined();
		expect(body.output_config).toEqual({ effort: "medium" });
		expect(body.system).toBe("sys");
		expect(JSON.parse(buildAnthropicRequest({ apiKey: "k", model: "claude-sonnet-4-6" }, req, false).body).temperature).toBe(0.8);
	});
	it("joins text blocks and skips thinking blocks", () => {
		const text = JSON.stringify({ content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Hello" }, { type: "text", text: " world" }], stop_reason: "end_turn" });
		expect(parseAnthropicResponse(text)).toBe("Hello world");
	});
	it("reports refusals", () => {
		expect(() => parseAnthropicResponse(JSON.stringify({ content: [], stop_reason: "refusal" }))).toThrow(/declined/);
	});
	it("maps a bad key to a readable error", async () => {
		const client = createClient(
			{ provider: "anthropic", providers: { anthropic: { apiKey: "bad", baseUrl: "", model: "claude-sonnet-5-5" } }, effort: "", refusalFallback: false },
			async () => ({ status: 401, text: JSON.stringify({ error: { message: "invalid x-api-key" } }) }),
		);
		await expect(client.complete(req)).rejects.toMatchObject({ kind: "auth" });
	});
	it("retries without the fallback beta if the API rejects it", async () => {
		const seen: HttpRequest[] = [];
		const client = createClient(
			{ provider: "anthropic", providers: { anthropic: { apiKey: "k", baseUrl: "", model: "claude-sonnet-5-5" } }, effort: "", refusalFallback: true },
			async (r) => {
				seen.push(r);
				if (seen.length === 1) return { status: 400, text: JSON.stringify({ error: { message: "fallbacks: unknown field" } }) };
				return { status: 200, text: JSON.stringify({ content: [{ type: "text", text: "ok" }] }) };
			},
		);
		expect(await client.complete(req)).toBe("ok");
		expect(JSON.parse(seen[0].body).fallbacks).toBe("default");
		expect(JSON.parse(seen[1].body).fallbacks).toBeUndefined();
	});
	it("refuses to send without a key", async () => {
		const client = createClient({ provider: "anthropic", providers: {}, effort: "", refusalFallback: false }, async () => ({ status: 200, text: "" }));
		await expect(client.complete(req)).rejects.toBeInstanceOf(LLMError);
	});
});

describe("openai-compatible", () => {
	it("Ollama with no key goes to the local endpoint without an auth header", async () => {
		let sent: HttpRequest | undefined;
		const client = createClient({ provider: "ollama", providers: {}, effort: "", refusalFallback: false }, async (r) => {
			sent = r;
			return { status: 200, text: JSON.stringify({ choices: [{ message: { content: "<think>hmm</think>Hi" } }] }) };
		});
		expect(await client.complete(req)).toBe("Hi");
		expect(sent?.url).toBe("http://localhost:11434/v1/chat/completions");
		expect(sent?.headers.authorization).toBeUndefined();
		const body = JSON.parse(sent!.body);
		expect(body.messages[0]).toEqual({ role: "system", content: "sys" });
		expect(body.model).toBe("llama3.1");
	});
	it("explains an unreachable local server", async () => {
		const client = createClient({ provider: "ollama", providers: {}, effort: "", refusalFallback: false }, async () => {
			throw new Error("ECONNREFUSED");
		});
		await expect(client.complete(req)).rejects.toThrow(/Is it running/);
	});
	it("maps 404 to model not found", async () => {
		const client = createClient({ provider: "openai", providers: { openai: { apiKey: "k", baseUrl: "https://api.openai.com/v1/", model: "nope" } }, effort: "", refusalFallback: false }, async () => ({ status: 404, text: "{}" }));
		await expect(client.complete(req)).rejects.toMatchObject({ kind: "not_found" });
	});
});
