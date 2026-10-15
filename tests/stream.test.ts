import { describe, expect, it } from "vitest";
import { buildAnthropicRequest } from "../src/llm/anthropic";
import { createClient } from "../src/llm/client";
import { parseSSE, stripThinking } from "../src/llm/sse";
import { buildOpenAIRequest } from "../src/llm/openaiCompat";
import { CACHE_MARK, StreamUnavailable, type FetchFn } from "../src/llm/types";

const req = (system = "sys") => ({ system, messages: [{ role: "user" as const, content: "hi" }], maxTokens: 100 });

/** A Response whose body arrives in the given chunks (split mid-event on purpose). */
function sse(chunks: string[], status = 200) {
	const enc = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(c) {
				for (const ch of chunks) c.enqueue(enc.encode(ch));
				c.close();
			},
		}),
		{ status },
	);
}

describe("parseSSE", () => {
	it("parses events, keeps the unfinished remainder, ignores comments", () => {
		const { events, rest } = parseSSE("event: a\ndata: 1\n\n: ping\n\ndata: x\ndata: y\n\ndata: part");
		expect(events).toEqual([{ event: "a", data: "1" }, { event: "message", data: "x\ny" }]);
		expect(rest).toBe("data: part");
	});
	it("strips think blocks, including an unclosed one", () => {
		expect(stripThinking("<think>hmm</think>Hello")).toBe("Hello");
		expect(stripThinking("<think>still going")).toBe("");
	});
});

describe("prompt caching", () => {
	const system = `Book and codex${CACHE_MARK}Chapter text`;
	it("Anthropic gets the stable prefix as a cached block", () => {
		const body = JSON.parse(buildAnthropicRequest({ apiKey: "k", model: "claude-sonnet-5-5" }, req(system), false).body);
		expect(body.system).toEqual([
			{ type: "text", text: "Book and codex", cache_control: { type: "ephemeral" } },
			{ type: "text", text: "Chapter text" },
		]);
	});
	it("OpenAI-compatible providers get plain text with the marker removed", () => {
		const body = JSON.parse(buildOpenAIRequest({ providerName: "x", baseUrl: "http://h/v1", apiKey: "", model: "m" }, req(system)).body);
		expect(body.messages[0].content).toBe("Book and codexChapter text");
	});
	it("no marker means a plain string system prompt", () => {
		expect(JSON.parse(buildAnthropicRequest({ apiKey: "k", model: "claude-sonnet-5-5" }, req("plain"), false).body).system).toBe("plain");
	});
});

describe("streaming", () => {
	it("Anthropic: accumulates text deltas across chunk boundaries and sends the browser-access header", async () => {
		let headers: Record<string, string> = {};
		const fetchFn: FetchFn = async (_u, init) => {
			headers = init.headers;
			expect(JSON.parse(init.body).stream).toBe(true);
			return sse([
				'event: message_start\ndata: {"type":"message_start"}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\nevent: content_bl',
				'ock_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n',
				'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
			]);
		};
		const client = createClient({ provider: "anthropic", providers: { anthropic: { apiKey: "k", baseUrl: "", model: "claude-sonnet-5-5" } }, effort: "", refusalFallback: false }, async () => ({ status: 500, text: "" }), fetchFn);
		const seen: string[] = [];
		expect(await client.stream!(req(), (t) => seen.push(t))).toBe("Hello");
		expect(seen).toEqual(["Hel", "Hello"]);
		expect(headers["anthropic-dangerous-direct-browser-access"]).toBe("true");
	});
	it("Anthropic: refusal mid-stream becomes a readable error", async () => {
		const fetchFn: FetchFn = async () => sse(['data: {"type":"message_delta","delta":{"stop_reason":"refusal"}}\n\n']);
		const client = createClient({ provider: "anthropic", providers: { anthropic: { apiKey: "k", baseUrl: "", model: "claude-sonnet-5-5" } }, effort: "", refusalFallback: false }, async () => ({ status: 500, text: "" }), fetchFn);
		await expect(client.stream!(req(), () => {})).rejects.toMatchObject({ kind: "refusal" });
	});
	it("Anthropic: HTTP errors map like non-streaming ones", async () => {
		const fetchFn: FetchFn = async () => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 });
		const client = createClient({ provider: "anthropic", providers: { anthropic: { apiKey: "bad", baseUrl: "", model: "claude-sonnet-5-5" } }, effort: "", refusalFallback: false }, async () => ({ status: 500, text: "" }), fetchFn);
		await expect(client.stream!(req(), () => {})).rejects.toMatchObject({ kind: "auth" });
	});
	it("OpenAI-compatible: reads deltas until [DONE], hiding <think>", async () => {
		const fetchFn: FetchFn = async () =>
			sse(['data: {"choices":[{"delta":{"content":"<think>x</think>Fo"}}]}\n\n', 'data: {"choices":[{"delta":{"content":"g."}}]}\n\ndata: [DONE]\n\n']);
		const client = createClient({ provider: "ollama", providers: {}, effort: "", refusalFallback: false }, async () => ({ status: 500, text: "" }), fetchFn);
		const seen: string[] = [];
		expect(await client.stream!(req(), (t) => seen.push(t))).toBe("Fog.");
		expect(seen).toEqual(["Fo", "Fog."]);
	});
	it("a network/CORS failure is reported as StreamUnavailable so callers can fall back", async () => {
		const fetchFn: FetchFn = async () => {
			throw new TypeError("Failed to fetch");
		};
		const client = createClient({ provider: "ollama", providers: {}, effort: "", refusalFallback: false }, async () => ({ status: 500, text: "" }), fetchFn);
		await expect(client.stream!(req(), () => {})).rejects.toBeInstanceOf(StreamUnavailable);
	});
});
