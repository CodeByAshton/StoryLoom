import { AnthropicClient } from "./anthropic";
import { ClaudeCodeClient, type ClaudeCodeHost } from "./claudeCode";
import { OpenAICompatClient } from "./openaiCompat";
import type { FetchFn, HttpFn, LLMClient } from "./types";

export type ProviderId = "anthropic" | "claudecode" | "openai" | "openrouter" | "ollama" | "lmstudio" | "custom";

export interface ProviderConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
}

export const PROVIDERS: Record<ProviderId, { name: string; defaults: ProviderConfig; needsKey: boolean }> = {
	anthropic: { name: "Anthropic (API key)", needsKey: true, defaults: { apiKey: "", baseUrl: "https://api.anthropic.com", model: "claude-sonnet-5-5" } },
	// baseUrl holds the path to the `claude` binary; empty means auto-detect.
	claudecode: { name: "Claude Code (your Claude subscription)", needsKey: false, defaults: { apiKey: "", baseUrl: "", model: "sonnet" } },
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

export function createClient(s: ClientSettings, http: HttpFn, fetchFn?: FetchFn, claudeHost?: ClaudeCodeHost | null): LLMClient {
	const cfg = providerConfig(s);
	if (s.provider === "claudecode") {
		return new ClaudeCodeClient({ binary: cfg.baseUrl || "claude", model: cfg.model, effort: s.effort || undefined }, claudeHost ?? null);
	}
	if (s.provider === "anthropic") {
		return new AnthropicClient({ apiKey: cfg.apiKey.trim(), model: cfg.model.trim(), effort: s.effort, refusalFallback: s.refusalFallback }, http, fetchFn);
	}
	return new OpenAICompatClient(
		{ providerName: PROVIDERS[s.provider].name, baseUrl: cfg.baseUrl, apiKey: cfg.apiKey.trim(), model: cfg.model.trim() },
		http,
		fetchFn,
	);
}
