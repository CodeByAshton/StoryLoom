import { send } from "./anthropic";
import { errorFromStatus, LLMError, type CompleteRequest, type HttpFn, type HttpRequest, type LLMClient } from "./types";

export interface OpenAICompatOptions {
	providerName: string;
	baseUrl: string;
	apiKey: string;
	model: string;
}

export function buildOpenAIRequest(opts: OpenAICompatOptions, req: CompleteRequest): HttpRequest {
	const base = opts.baseUrl.trim().replace(/\/+$/, "");
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (opts.apiKey) headers["authorization"] = `Bearer ${opts.apiKey}`;
	const messages = [...(req.system ? [{ role: "system", content: req.system }] : []), ...req.messages];
	const body: Record<string, unknown> = { model: opts.model, messages };
	if (req.maxTokens) body.max_tokens = req.maxTokens;
	if (req.temperature !== undefined) body.temperature = req.temperature;
	return { url: `${base}/chat/completions`, method: "POST", headers, body: JSON.stringify(body) };
}

export function parseOpenAIResponse(text: string, providerName: string): string {
	let j: { choices?: { message?: { content?: unknown }; finish_reason?: string }[] };
	try {
		j = JSON.parse(text);
	} catch {
		throw new LLMError("server", `${providerName} returned a response that wasn't JSON.`);
	}
	const content = j.choices?.[0]?.message?.content;
	const out = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c?.text ?? "").join("") : "";
	// Some local reasoning models wrap their thoughts in <think> tags.
	const cleaned = out.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
	if (!cleaned.trim()) throw new LLMError("empty", `${providerName} returned an empty response.`);
	return cleaned;
}

export class OpenAICompatClient implements LLMClient {
	constructor(
		private opts: OpenAICompatOptions,
		private http: HttpFn,
	) {}

	async complete(req: CompleteRequest): Promise<string> {
		if (!this.opts.baseUrl) throw new LLMError("config", "No base URL set for the OpenAI-compatible provider.");
		const res = await send(this.http, buildOpenAIRequest(this.opts, req), this.opts.providerName);
		if (res.status >= 200 && res.status < 300) return parseOpenAIResponse(res.text, this.opts.providerName);
		throw errorFromStatus(res.status, res.text, this.opts.providerName, this.opts.model);
	}
}
