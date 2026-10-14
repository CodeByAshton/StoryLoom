import { errorDetail, errorFromStatus, LLMError, type CompleteRequest, type HttpFn, type HttpRequest, type LLMClient } from "./types";

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

export function buildAnthropicRequest(opts: AnthropicOptions, req: CompleteRequest, withFallback: boolean): HttpRequest {
	const body: Record<string, unknown> = {
		model: opts.model,
		max_tokens: req.maxTokens ?? 8000,
		messages: req.messages,
	};
	if (req.system) body.system = req.system;
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"x-api-key": opts.apiKey,
		"anthropic-version": "2023-06-01",
	};
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
	) {}

	async complete(req: CompleteRequest): Promise<string> {
		if (!this.opts.apiKey) throw new LLMError("config", "No Anthropic API key set. Add one in Settings → Storyloom.");
		let withFallback = this.opts.refusalFallback !== false;
		for (let attempt = 0; attempt < 2; attempt++) {
			const res = await send(this.http, buildAnthropicRequest(this.opts, req, withFallback), "Anthropic");
			if (res.status >= 200 && res.status < 300) return parseAnthropicResponse(res.text);
			// If the account or model doesn't accept the fallback beta, retry once without it.
			if (withFallback && res.status === 400 && /fallback|anthropic-beta/i.test(errorDetail(res.text))) {
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
