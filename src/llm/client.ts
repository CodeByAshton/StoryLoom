import { AnthropicClient } from "./anthropic";
import { OpenAICompatClient } from "./openaiCompat";
import type { HttpFn, LLMClient } from "./types";

export type ProviderId = "anthropic" | "openai" | "openrouter" | "ollama" | "lmstudio" | "custom";

export interface ProviderConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
}

export const PROVIDERS: Record<ProviderId, { name: string; defaults: ProviderConfig; needsKey: boolean }> = {
	anthropic: { name: "Anthropic", needsKey: true, defaults: { apiKey: "", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5" } },
	openai: { name: "OpenAI", needsKey: true, defaults: { apiKey: "", baseUrl: "https://api.openai.com/v1", model: "gpt-4o" } },
	openrouter: { name: "OpenRouter", needsKey: true, defaults: { apiKey: "", baseUrl: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-5-5" } },
	ollama: { name: "Ollama", needsKey: false, defaults: { apiKey: "", baseUrl: "http://localhost:11434/v1", model: "llama3.1" } },
	lmstudio: { name: "LM Studio", needsKey: false, defaults: { apiKey: "", baseUrl: "http://localhost:1234/v1", model: "local-model" } },
	custom: { name: "OpenAI-compatible", needsKey: false, defaults: { apiKey: "", baseUrl: "", model: "" } },
};

export interface ClientSettings {
	provider: ProviderId;
	providers: Partial<Record<ProviderId, ProviderConfig>>;
	effort: string;
	refusalFallback: boolean;
}

export function providerConfig(s: ClientSettings, id: ProviderId = s.provider): ProviderConfig {
	return { ...PROVIDERS[id].defaults, ...(s.providers[id] ?? {}) };
}

export function createClient(s: ClientSettings, http: HttpFn): LLMClient {
	const cfg = providerConfig(s);
	if (s.provider === "anthropic") {
		return new AnthropicClient({ apiKey: cfg.apiKey.trim(), model: cfg.model.trim(), effort: s.effort, refusalFallback: s.refusalFallback }, http);
	}
	return new OpenAICompatClient(
		{ providerName: PROVIDERS[s.provider].name, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey.trim(), model: cfg.model.trim() },
		http,
	);
}
