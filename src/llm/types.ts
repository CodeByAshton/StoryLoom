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

/** Single seam for every provider. A streaming variant can be added beside it later. */
export interface LLMClient {
	complete(req: CompleteRequest): Promise<string>;
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

export type LLMErrorKind = "auth" | "rate_limit" | "not_found" | "bad_request" | "server" | "network" | "refusal" | "empty" | "config";

export class LLMError extends Error {
	constructor(
		public kind: LLMErrorKind,
		message: string,
		public status?: number,
	) {
		super(message);
		this.name = "LLMError";
	}
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
			return new LLMError("auth", `${providerName} rejected the API key. Check it in Settings → Storyloom. (${detail})`, status);
		case status === 404:
			return new LLMError("not_found", `Model "${model}" was not found by ${providerName}. Check the model name in settings. (${detail})`, status);
		case status === 429:
			return new LLMError("rate_limit", `${providerName} rate limit reached. Wait a moment and try again. (${detail})`, status);
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
