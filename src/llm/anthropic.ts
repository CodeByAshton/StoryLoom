import { readSSE } from "./sse";
import { errorDetail, errorFromStatus, LLMError, splitSystem, StreamUnavailable, type CompleteRequest, type FetchFn, type HttpFn, type HttpRequest, type LLMClient, type OnText } from "./types";

export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export interface AnthropicOptions {
	apiKey: string;
	model: string;
	/** "low" | "medium" | "high" | "" (omit). Only sent to models that accept it. */
	effort?: string;
	refusalFallback?: boolean;
}

/**
 * Claude 4.7+ and the 5.x family reject non-default sampling parameters and accept `output_config.effort`.
 * Older models still take `temperature`.
 */
export function isModernClaude(model: string): boolean {
	return /^claude-[a-z]+-([5-9]|4-[7-9])(\b|-|$)/.test(model);
}

export function buildAnthropicRequest(opts: AnthropicOptions, req: CompleteRequest, withFallback: boolean, stream = false): HttpRequest {
	const body: Record<string, unknown> = {
		model: opts.model,
		max_tokens: req.maxTokens ?? 8000,
		messages: req.messages,
	};
	// The stable part of the context (book, codex, summaries) is sent as its own cached block,
	// so repeated requests in the same chapter only pay full price for the chapter text.
	const { prefix, rest } = splitSystem(req.system);
	if (prefix.trim()) {
		body.system = [
			{ type: "text", text: prefix, cache_control: { type: "ephemeral" } },
			...(rest.trim() ? [{ type: "text", text: rest }] : []),
		];
	} else if (rest.trim()) body.system = rest;
	if (stream) body.stream = true;
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"x-api-key": opts.apiKey,
		"anthropic-version": "2023-06-01",
	};
	// Required for requests made directly from a browser context (streaming uses fetch, not requestUrl).
	if (stream) headers["anthropic-dangerous-direct-browser-access"] = "true";
	if (isModernClaude(opts.model)) {
		if (opts.effort) body.output_config = { effort: opts.effort };
		if (withFallback) {
			body.fallbacks = "default";
			headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
		}
	} else if (req.temperature !== undefined) {
		body.temperature = req.temperature;
	}
	return { url: ANTHROPIC_URL, method: "POST", headers, body: JSON.stringify(body) };
}

export function parseAnthropicResponse(text: string): string {
	let j: { content?: { type: string; text?: string }[]; stop_reason?: string };
	try {
		j = JSON.parse(text);
	} catch {
		throw new LLMError("server", "Anthropic returned a response that wasn't JSON.");
	}
	if (j.stop_reason === "refusal") {
		throw new LLMError("refusal", "Claude declined this request. Try rephrasing the instruction or the passage.");
	}
	const out = (j.content ?? [])
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("");
	if (!out.trim()) {
		throw new LLMError(
			"empty",
			j.stop_reason === "max_tokens"
				? "The response was cut off before any text was written. Raise “Max output tokens” in settings."
				: "Claude returned an empty response.",
		);
	}
	return out;
}

export class AnthropicClient implements LLMClient {
	constructor(
		private opts: AnthropicOptions,
		private http: HttpFn,
		private fetchFn?: FetchFn,
	) {}

	async stream(req: CompleteRequest, onText: OnText, signal?: AbortSignal): Promise<string> {
		if (!this.fetchFn) throw new StreamUnavailable("no fetch");
		if (!this.opts.apiKey) throw new LLMError("config", "No Anthropic API key set. Add one in Settings → Storyloom.");
		let withFallback = this.opts.refusalFallback !== false;
		for (let attempt = 0; attempt < 2; attempt++) {
			const r = buildAnthropicRequest(this.opts, req, withFallback, true);
			const res = await openStream(this.fetchFn, r, signal);
			if (!res.ok || !res.body) {
				const text = await res.text();
				if (withFallback && res.status === 400 && /fallback|beta/i.test(errorDetail(text))) {
					withFallback = false;
					continue;
				}
				throw errorFromStatus(res.status, text, "Anthropic", this.opts.model);
			}
			return consumeAnthropicStream(res.body, onText);
		}
		throw new LLMError("server", "Anthropic request failed.");
	}

	async complete(req: CompleteRequest): Promise<string> {
		if (!this.opts.apiKey) throw new LLMError("config", "No Anthropic API key set. Add one in Settings → Storyloom.");
		let withFallback = this.opts.refusalFallback !== false;
		for (let attempt = 0; attempt < 2; attempt++) {
			const res = await send(this.http, buildAnthropicRequest(this.opts, req, withFallback), "Anthropic");
			if (res.status >= 200 && res.status < 300) return parseAnthropicResponse(res.text);
			// If the account or model doesn't accept the fallback beta, retry once without it.
			if (withFallback && res.status === 400 && /fallback|beta/i.test(errorDetail(res.text))) {
				withFallback = false;
				continue;
			}
			throw errorFromStatus(res.status, res.text, "Anthropic", this.opts.model);
		}
		throw new LLMError("server", "Anthropic request failed.");
	}
}

export async function send(http: HttpFn, req: HttpRequest, providerName: string) {
	try {
		return await http(req);
	} catch (e) {
		const host = (() => {
			try {
				return new URL(req.url).host;
			} catch {
				return req.url;
			}
		})();
		const local = /localhost|127\.0\.0\.1/.test(host);
		throw new LLMError(
			"network",
			local
				? `Couldn't reach ${providerName} at ${host}. Is it running?`
				: `Couldn't reach ${providerName} (${host}). Check your internet connection. ${e instanceof Error ? e.message : ""}`.trim(),
		);
	}
}

/** fetch, turning network/CORS failures into StreamUnavailable and aborts into an "aborted" error. */
export async function openStream(fetchFn: FetchFn, r: HttpRequest, signal?: AbortSignal): Promise<Response> {
	try {
		return await fetchFn(r.url, { method: r.method, headers: r.headers, body: r.body, signal });
	} catch (e) {
		if (signal?.aborted) throw new LLMError("aborted", "Stopped.");
		throw new StreamUnavailable(e instanceof Error ? e.message : String(e));
	}
}

export async function consumeAnthropicStream(body: ReadableStream<Uint8Array>, onText: OnText): Promise<string> {
	let text = "";
	let stop: string | undefined;
	for await (const ev of readSSE(body)) {
		let j: { type?: string; delta?: { type?: string; text?: string; stop_reason?: string }; error?: { message?: string } };
		try {
			j = JSON.parse(ev.data);
		} catch {
			continue;
		}
		if (j.type === "content_block_delta" && j.delta?.type === "text_delta" && j.delta.text) {
			text += j.delta.text;
			onText(text);
		} else if (j.type === "message_delta" && j.delta?.stop_reason) stop = j.delta.stop_reason;
		else if (j.type === "error") throw new LLMError("server", `Anthropic: ${j.error?.message ?? "stream error"}`);
	}
	if (stop === "refusal") throw new LLMError("refusal", "Claude declined this request. Try rephrasing the instruction or the passage.");
	if (!text.trim()) {
		throw new LLMError("empty", stop === "max_tokens" ? "The response was cut off before any text was written. Raise “Max output tokens” in settings." : "Claude returned an empty response.");
	}
	return text;
}
