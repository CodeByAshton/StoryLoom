import { normalizePath, TFile, type App } from "obsidian";
import type { CodexIndex } from "./codex/index";
import { stripFrontmatter } from "./codex/parse";
import type { Entity } from "./codex/types";
import { buildContext, type BuiltContext } from "./context/builder";
import { JSON_RETRY, type Prompt } from "./context/prompts";
import { extractJson, JsonExtractError } from "./llm/json";
import { withRetry } from "./llm/retry";
import { LLMError, StreamUnavailable, type ChatMessage, type LLMClient, type OnText } from "./llm/types";
import { previewPrompt } from "./modals/instructionModal";
import type { MotifSettings } from "./settings";

export interface ContextRequest {
	file: TFile | null;
	/** Full note text (with frontmatter). */
	text: string;
	/** Offset in `text` where generation happens. Omit for analysis of the whole note. */
	cursor?: number;
	/** Extra text whose entity mentions should get priority (e.g. the selection). */
	passage?: string;
	/** Override the "as of" chapter (state update uses N-1). */
	asOf?: number;
	/** Entities to put first (e.g. @-mentions in chat). */
	pinned?: Entity[];
}

export class AIService {
	constructor(
		private app: App,
		private index: CodexIndex,
		private settings: () => MotifSettings,
		private client: () => LLMClient,
	) {}

	async bookText(): Promise<string> {
		const f = this.app.vault.getAbstractFileByPath(normalizePath(this.settings().bookPath));
		return f instanceof TFile ? this.app.vault.cachedRead(f) : "";
	}

	async context(req: ContextRequest): Promise<BuiltContext> {
		const s = this.settings();
		const chapter = this.index.chapterForPath(req.file?.path);
		const asOf = req.asOf ?? chapter?.chapter ?? Infinity;
		const generate = req.cursor !== undefined;
		const body = stripFrontmatter(req.text);
		const fmLength = req.text.length - body.length;
		const chapterText = generate ? body.slice(0, Math.max(0, (req.cursor as number) - fmLength)) : body;

		const mentionSource = (generate ? chapterText.slice(-4000) : body) + "\n" + (req.passage ?? "");
		const focus: Entity[] = [...(req.pinned ?? [])];
		const add = (e?: Entity) => {
			if (e && !focus.includes(e)) focus.push(e);
		};
		if (chapter?.pov) add(this.index.getEntity(chapter.pov));
		for (const n of this.index.mentionsIn(mentionSource)) add(this.index.entities.get(n));
		const others = this.index.sortedEntities().filter((e) => !focus.includes(e));

		const earlier = this.index.chapters
			.filter((c) => (chapter ? c.chapter < chapter.chapter : true) && c.summary)
			.map((c) => ({ chapter: c.chapter, title: c.title, summary: c.summary as string }));

		const built = buildContext({
			book: await this.bookText(),
			chapter,
			chapterText,
			mode: generate ? "generate" : "analyze",
			focusEntities: focus,
			otherEntities: others,
			earlierSummaries: earlier,
			asOf,
			budget: s.contextBudget,
		});
		if (s.debug) console.debug(`[Motif] context ${built.text.length} chars`, built.sections, built.truncated ? "(truncated)" : "");
		return built;
	}

	/** Providers (by config) that failed to stream this session, e.g. because of CORS. */
	private noStream = new Set<string>();

	private async request(prompt: Prompt, opts: { maxTokens?: number; temperature?: number; history?: ChatMessage[] }) {
		const s = this.settings();
		if (s.showContextBeforeSending) {
			const ok = await previewPrompt(this.app, prompt.system, prompt.user);
			if (!ok) throw new LLMError("aborted", "Cancelled.");
		}
		const messages: ChatMessage[] = [...(opts.history ?? []), { role: "user", content: prompt.user }];
		if (s.debug) console.debug("[Motif] request", { system: prompt.system.length, user: prompt.user.length });
		return { system: prompt.system, messages, maxTokens: opts.maxTokens ?? s.maxTokens, temperature: opts.temperature ?? s.temperature };
	}

	async complete(prompt: Prompt, opts: { maxTokens?: number; temperature?: number; history?: ChatMessage[] } = {}): Promise<string> {
		const req = await this.request(prompt, opts);
		const client = this.client();
		return withRetry(() => client.complete(req), this.settings().debug);
	}

	/**
	 * Like `complete`, but calls `onText` as the answer arrives. Falls back to a single request when
	 * streaming is off or the provider can't stream from inside Obsidian.
	 */
	async stream(prompt: Prompt, onText: OnText, opts: { maxTokens?: number; temperature?: number; history?: ChatMessage[]; signal?: AbortSignal } = {}): Promise<string> {
		const s = this.settings();
		const client = this.client();
		const key = JSON.stringify([s.provider, s.providers[s.provider]?.baseUrl ?? ""]);
		const req = await this.request(prompt, opts);
		if (s.stream && client.stream && !this.noStream.has(key)) {
			const stream: NonNullable<LLMClient["stream"]> = (r, on, sig) => (client.stream ? client.stream(r, on, sig) : client.complete(r));
			let started = false;
			try {
				// Retry only while nothing has been shown yet; a half-written answer isn't restarted.
				return await withRetry(
					() =>
						stream(req, (t: string) => {
							started = true;
							onText(t);
						}, opts.signal),
					s.debug,
					() => !started && !opts.signal?.aborted,
				);
			} catch (e) {
				if (!(e instanceof StreamUnavailable)) throw e;
				this.noStream.add(key);
				if (s.debug) console.warn("[Motif] streaming unavailable, falling back:", e.message);
			}
		}
		const text = await withRetry(() => client.complete(req), s.debug, () => !opts.signal?.aborted);
		onText(text);
		return text;
	}

	/** Ask for JSON; on a parse/shape failure, retry once with the schema restated. */
	async completeJson<T>(prompt: Prompt, validate: (raw: unknown) => T, schema: string): Promise<T> {
		const first = await this.complete(prompt, { temperature: 0.2 });
		try {
			return validate(extractJson(first));
		} catch (e) {
			if (!(e instanceof JsonExtractError)) throw e;
			if (this.settings().debug) console.warn("[Motif] JSON retry:", e.message, first);
			const second = await this.complete(
				{ system: prompt.system, user: `${JSON_RETRY}\n${schema}` },
				{ temperature: 0, history: [{ role: "user", content: prompt.user }, { role: "assistant", content: first }] },
			);
			try {
				return validate(extractJson(second));
			} catch {
				throw new LLMError("bad_request", "The AI's answer couldn't be read, even after a retry. Try again.");
			}
		}
	}
}
