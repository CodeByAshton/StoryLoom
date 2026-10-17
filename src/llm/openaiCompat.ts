import { openStream, send } from "./anthropic";
import { readSSE, stripThinking } from "./sse";
import { errorFromStatus, LLMError, plainSystem, StreamUnavailable, type CompleteRequest, type FetchFn, type HttpFn, type HttpRequest, type LLMClient, type OnText } from "./types";

export interface OpenAICompatOptions {
	providerName: string;
	baseUrl: string;
	apiKey: string;
	model: string;
}

export function buildOpenAIRequest(opts: OpenAICompatOptions, req: CompleteRequest, stream = false): HttpRequest {
	const base = opts.baseUrl.trim().replace(/\/+$/, "");
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (opts.apiKey) headers["authorization"] = `Bearer ${opts.apiKey}`;
	const system = plainSystem(req.system);
	const messages = [...(system ? [{ role: "system", content: system }] : []), ...req.messages];
	const body: Record<string, unknown> = { model: opts.model, messages };
	if (stream) body.stream = true;
	if (req.maxTokens) body.max_tokens = req.maxTokens;
	if (req.temperature !== undefined) body.temperature = req.temperature;
	return { url: `${base}/chat/completions`, method: "POST", headers, body: JSON.stringify(body) };
}

export function parseOpenAIResponse(text: string, providerName: string): string {
	let j: { choices?: { message?: { content?: unknown }; finish_reason?: string }[] };
	try {
		j = JSON.parse(text) as typeof j;
	} catch {
		throw new LLMError("server", `${providerName} returned a response that wasn't JSON.`);
	}
	const content = j.choices?.[0]?.message?.content;
	const out = typeof content === "string" ? content : Array.isArray(content) ? (content as { text?: unknown }[]).map((c) => (typeof c?.text === "string" ? c.text : "")).join("") : "";
	// Some local reasoning models wrap their thoughts in <think> tags.
	const cleaned = stripThinking(out);
	if (!cleaned.trim()) throw new LLMError("empty", `${providerName} returned an empty response.`);
	return cleaned;
}

export class OpenAICompatClient implements LLMClient {
	constructor(
		private opts: OpenAICompatOptions,
		private http: HttpFn,
		private fetchFn?: FetchFn,
	) {}

	async stream(req: CompleteRequest, onText: OnText, signal?: AbortSignal): Promise<string> {
		if (!this.fetchFn) throw new StreamUnavailable("no fetch");
		if (!this.opts.baseUrl) throw new LLMError("config", "No base URL set for the OpenAI-compatible provider.");
		const res = await openStream(this.fetchFn, buildOpenAIRequest(this.opts, req, true), signal);
		if (!res.ok || !res.body) throw errorFromStatus(res.status, await res.text(), this.opts.providerName, this.opts.model);
		return consumeOpenAIStream(res.body, onText, this.opts.providerName);
	}

	async complete(req: CompleteRequest): Promise<string> {
		if (!this.opts.baseUrl) throw new LLMError("config", "No base URL set for the OpenAI-compatible provider.");
		const res = await send(this.http, buildOpenAIRequest(this.opts, req), this.opts.providerName);
		if (res.status >= 200 && res.status < 300) return parseOpenAIResponse(res.text, this.opts.providerName);
		throw errorFromStatus(res.status, res.text, this.opts.providerName, this.opts.model);
	}
}

export async function consumeOpenAIStream(body: ReadableStream<Uint8Array>, onText: OnText, providerName: string): Promise<string> {
	let raw = "";
	for await (const ev of readSSE(body)) {
		if (ev.data.trim() === "[DONE]") break;
		let j: { choices?: { delta?: { content?: string } }[]; error?: { message?: string } };
		try {
			j = JSON.parse(ev.data) as typeof j;
		} catch {
			continue;
		}
		if (j.error) throw new LLMError("server", `${providerName}: ${j.error.message ?? "stream error"}`);
		const piece = j.choices?.[0]?.delta?.content;
		if (piece) {
			raw += piece;
			onText(stripThinking(raw));
		}
	}
	const text = stripThinking(raw);
	if (!text.trim()) throw new LLMError("empty", `${providerName} returned an empty response.`);
	return text;
}
