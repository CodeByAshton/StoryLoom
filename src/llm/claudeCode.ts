/**
 * "Claude Code" provider: runs the user's own, unmodified `claude` CLI in print mode, so requests are
 * covered by whatever that install is signed in with (for example a Claude Pro/Max subscription).
 *
 * Storyloom never reads, stores or forwards Claude credentials; signing in happens in Claude Code itself.
 * This module is pure apart from the injected process runner (see claudeCodeNode.ts), so it can be tested.
 */
import { CACHE_MARK, LLMError, type ChatMessage, type CompleteRequest, type LLMClient, type OnText } from "./types";

export interface ProcessLike {
	stdout: { on(event: "data", cb: (chunk: unknown) => void): void };
	stderr: { on(event: "data", cb: (chunk: unknown) => void): void };
	stdin: { write(text: string): void; end(): void };
	on(event: "close", cb: (code: number | null) => void): void;
	on(event: "error", cb: (err: Error) => void): void;
	kill(signal?: string): void;
}

export interface ClaudeCodeHost {
	/** Start the CLI. `binary` is already resolved to a path or command name. */
	spawn(binary: string, args: string[]): ProcessLike;
	/** Write a temp file (the system prompt can exceed command-line limits) and return its path. */
	writeTemp(text: string): Promise<string>;
	removeTemp(path: string): void;
	resolveBinary(configured: string): Promise<string | null>;
}

export interface ClaudeCodeOptions {
	binary: string;
	model: string;
	effort?: string;
	timeoutMs?: number;
}

/** Claude Code caches the part of a custom system prompt above this line. */
export const DYNAMIC_BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

export function claudeCodeSystem(system: string): string {
	return system.split(CACHE_MARK).join(`\n${DYNAMIC_BOUNDARY}\n`);
}

/**
 * Flags: print mode with streamed partial messages, no tools, no MCP, and `--safe-mode` so the user's
 * CLAUDE.md, plugins and hooks don't leak into prose (it keeps their sign-in, unlike `--bare`).
 * The run is ephemeral: nothing is saved to the user's Claude Code session history.
 */
export function buildClaudeCodeArgs(opts: ClaudeCodeOptions, systemFile: string): string[] {
	const args = [
		"-p",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--no-session-persistence",
		"--safe-mode",
		"--tools", "",
		"--disallowedTools", "mcp__*",
		"--strict-mcp-config",
		"--max-turns", "1",
		"--system-prompt-file", systemFile,
	];
	if (opts.model.trim()) args.push("--model", opts.model.trim());
	if (opts.effort) args.push("--effort", opts.effort);
	return args;
}

/** One prompt for stdin. Earlier chat turns are written out as a transcript. */
export function promptFromMessages(messages: ChatMessage[]): string {
	if (messages.length === 1) return messages[0].content;
	const last = messages[messages.length - 1];
	const earlier = messages
		.slice(0, -1)
		.map((m) => `${m.role === "user" ? "Author" : "You"}: ${m.content}`)
		.join("\n\n");
	return `Our conversation so far:\n\n${earlier}\n\nThe author's new message:\n${last.content}`;
}

export interface ClaudeCodeResult {
	isError: boolean;
	text: string;
	status?: number;
}

/** Parses Claude Code's newline-delimited stream-json output. */
export class StreamJsonParser {
	text = "";
	result: ClaudeCodeResult | null = null;
	private buffer = "";

	/** Feed raw stdout; returns true when new text arrived. */
	feed(chunk: string): boolean {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		let grew = false;
		for (const line of lines) grew = this.line(line) || grew;
		return grew;
	}

	end(): boolean {
		const grew = this.buffer.trim() ? this.line(this.buffer) : false;
		this.buffer = "";
		return grew;
	}

	private line(line: string): boolean {
		if (!line.trim()) return false;
		let j: {
			type?: string;
			event?: { type?: string; delta?: { type?: string; text?: string } };
			is_error?: boolean;
			result?: unknown;
			api_error_status?: number;
		};
		try {
			j = JSON.parse(line);
		} catch {
			return false;
		}
		if (j.type === "stream_event" && j.event?.type === "content_block_delta" && j.event.delta?.type === "text_delta" && j.event.delta.text) {
			this.text += j.event.delta.text;
			return true;
		}
		if (j.type === "result") {
			this.result = { isError: !!j.is_error, text: typeof j.result === "string" ? j.result : "", status: j.api_error_status };
			// Without partial messages (older CLIs) the result carries the whole answer.
			if (!this.result.isError && !this.text && this.result.text) {
				this.text = this.result.text;
				return true;
			}
		}
		return false;
	}
}

export function claudeCodeError(r: ClaudeCodeResult): LLMError {
	const msg = r.text || "Claude Code reported an error.";
	if (r.status === 401 || r.status === 403 || /not logged in|log ?in|login|sign in|authenticat|api key/i.test(msg)) {
		return new LLMError("auth", `Claude Code isn't signed in (or the sign-in expired). Open a terminal, run \`claude\`, sign in, then try again. (${msg})`, r.status);
	}
	if (r.status === 429 || /usage limit|rate limit|limit reached/i.test(msg)) {
		return new LLMError("rate_limit", `Your Claude plan's usage limit was reached. It resets on Claude's schedule; switch to an API key in Settings → Storyloom if you need to keep going. (${msg})`, r.status);
	}
	if (/model/i.test(msg) && /not found|invalid|unknown|not available/i.test(msg)) {
		return new LLMError("not_found", `Claude Code couldn't use that model. Check the model name in settings (e.g. sonnet or opus). (${msg})`, r.status);
	}
	return new LLMError("server", `Claude Code: ${msg}`, r.status);
}

const toText = (c: unknown) => (typeof c === "string" ? c : String((c as { toString(): string })?.toString?.() ?? ""));

export class ClaudeCodeClient implements LLMClient {
	constructor(
		private opts: ClaudeCodeOptions,
		private host: ClaudeCodeHost | null,
	) {}

	complete(req: CompleteRequest): Promise<string> {
		return this.stream(req, () => {});
	}

	async stream(req: CompleteRequest, onText: OnText, signal?: AbortSignal): Promise<string> {
		const host = this.host;
		if (!host) throw new LLMError("config", "The Claude Code provider only works in Obsidian on desktop. Choose another provider in Settings → Storyloom.");
		const binary = await host.resolveBinary(this.opts.binary);
		if (!binary) {
			throw new LLMError("config", "Couldn't find Claude Code on this computer. Install it (claude.com/claude-code), or set its full path in Settings → Storyloom.");
		}
		const sysFile = await host.writeTemp(claudeCodeSystem(req.system));
		try {
			return await this.run(host, binary, sysFile, req, onText, signal);
		} finally {
			host.removeTemp(sysFile);
		}
	}

	private run(host: ClaudeCodeHost, binary: string, sysFile: string, req: CompleteRequest, onText: OnText, signal?: AbortSignal): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			const parser = new StreamJsonParser();
			let stderr = "";
			let settled = false;
			const done = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				fn();
			};
			let proc: ProcessLike;
			try {
				proc = host.spawn(binary, buildClaudeCodeArgs(this.opts, sysFile));
			} catch (e) {
				reject(new LLMError("config", `Couldn't start Claude Code (${binary}): ${e instanceof Error ? e.message : String(e)}`));
				return;
			}
			const onAbort = () => {
				proc.kill("SIGTERM");
				done(() => reject(new LLMError("aborted", "Stopped.")));
			};
			signal?.addEventListener("abort", onAbort);
			const timer = setTimeout(() => {
				proc.kill("SIGTERM");
				done(() => reject(new LLMError("server", "Claude Code took too long to answer. Try again.", undefined, false)));
			}, this.opts.timeoutMs ?? 300_000);

			proc.stdout.on("data", (c) => {
				if (parser.feed(toText(c))) onText(parser.text);
			});
			proc.stderr.on("data", (c) => (stderr += toText(c)));
			proc.on("error", (err) =>
				done(() => reject(new LLMError("config", `Couldn't start Claude Code (${binary}): ${err.message}. Check its path in Settings → Storyloom.`))),
			);
			proc.on("close", (code) =>
				done(() => {
					if (parser.end()) onText(parser.text);
					const r = parser.result;
					if (r?.isError) return reject(claudeCodeError(r));
					if (parser.text.trim()) return resolve(parser.text);
					const detail = (r?.text || stderr).trim().split("\n").slice(-3).join(" ");
					if (/unknown option|unknown argument/i.test(detail)) {
						return reject(new LLMError("config", `Your Claude Code is too old for Storyloom. Run \`claude update\` in a terminal. (${detail})`));
					}
					reject(detail ? claudeCodeError({ isError: true, text: detail }) : new LLMError("empty", `Claude Code exited without an answer (code ${code}).`));
				}),
			);
			proc.stdin.write(promptFromMessages(req.messages));
			proc.stdin.end();
		});
	}
}
