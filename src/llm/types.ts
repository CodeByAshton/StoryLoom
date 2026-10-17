export type Role = "user" | "assistant";

export interface ChatMessage {
	role: Role;
	content: string;
}

export interface CompleteRequest {
	system: string;
	messages: ChatMessage[];
	maxTokens?: number;
	temperature?: number;
}

export type OnText = (soFar: string) => void;

/** Single seam for every provider. */
export interface LLMClient {
	complete(req: CompleteRequest): Promise<string>;
	/**
	 * Stream the answer, calling `onText` with the text so far. Throws `StreamUnavailable` when the
	 * provider can't be reached from the browser (e.g. CORS), so callers can fall back to `complete`.
	 */
	stream?(req: CompleteRequest, onText: OnText, signal?: AbortSignal): Promise<string>;
}

export class StreamUnavailable extends Error {}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>;

/**
 * The context builder puts this between the stable part of the system prompt (book, codex, summaries)
 * and the part that changes per request (the chapter text). Providers that support prompt caching cache
 * everything before it; everyone else just drops it.
 */
export const CACHE_MARK = "\u0000storyloom-cache\u0000";

export function splitSystem(system: string): { prefix: string; rest: string } {
	const i = system.indexOf(CACHE_MARK);
	if (i === -1) return { prefix: "", rest: system };
	return { prefix: system.slice(0, i), rest: system.slice(i + CACHE_MARK.length) };
}

export function plainSystem(system: string): string {
	return system.split(CACHE_MARK).join("");
}

export interface HttpRequest {
	url: string;
	method: "POST" | "GET";
	headers: Record<string, string>;
	body: string;
}

export interface HttpResponse {
	status: number;
	text: string;
}

export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

export type LLMErrorKind = "aborted" | "auth" | "rate_limit" | "not_found" | "bad_request" | "server" | "network" | "refusal" | "empty" | "config";

export class LLMError extends Error {
	constructor(
		public kind: LLMErrorKind,
		message: string,
		public status?: number,
		/** Worth trying again shortly: overloaded, server errors, network blips, per-minute rate limits. */
		public retryable = kind === "server" || kind === "network",
	) {
		super(message);
		this.name = "LLMError";
	}
}

export function isRetryable(e: unknown): boolean {
	return e instanceof LLMError && e.retryable;
}

/** Pull a readable message out of a provider error body. */
export function errorDetail(text: string): string {
	try {
		const j = JSON.parse(text);
		const m = j?.error?.message ?? j?.message ?? (typeof j?.error === "string" ? j.error : undefined);
		if (typeof m === "string") return m;
	} catch {
		/* not JSON */
	}
	return text.slice(0, 300);
}

export function errorFromStatus(status: number, text: string, providerName: string, model: string): LLMError {
	const detail = errorDetail(text);
	switch (true) {
		case status === 401 || status === 403:
			return new LLMError("auth", `${providerName} rejected the API key. Check it in Settings → Motif. (${detail})`, status);
		case status === 404:
			return new LLMError("not_found", `Model "${model}" was not found by ${providerName}. Check the model name in settings. (${detail})`, status);
		case status === 429:
			return new LLMError("rate_limit", `${providerName} rate limit reached. Wait a moment and try again. (${detail})`, status, true);
		case status === 529 || status === 503:
			return new LLMError("server", `${providerName} is overloaded right now. Try again shortly.`, status);
		case status >= 500:
			return new LLMError("server", `${providerName} had a server error (${status}). Try again shortly.`, status);
		default:
			return new LLMError("bad_request", `${providerName} refused the request (${status}): ${detail}`, status);
	}
}

export function friendlyError(e: unknown): string {
	if (e instanceof LLMError) return e.message;
	if (e instanceof Error) return e.message;
	return String(e);
}
