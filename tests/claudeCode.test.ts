import { EventEmitter } from "events";
import { describe, expect, it } from "vitest";
import { buildClaudeCodeArgs, claudeCodeSystem, ClaudeCodeClient, DYNAMIC_BOUNDARY, promptFromMessages, StreamJsonParser, type ClaudeCodeHost, type ProcessLike } from "../src/llm/claudeCode";
import { CACHE_MARK } from "../src/llm/types";

const delta = (text: string) => JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
const result = (r: Record<string, unknown>) => JSON.stringify({ type: "result", subtype: "success", ...r });

/** A fake `claude` process that replays stdout lines (in arbitrary chunks) and records stdin + args. */
function fakeHost(stdoutChunks: string[], opts: { code?: number; binary?: string | null; stderr?: string } = {}) {
	const seen = { args: [] as string[], stdin: "", system: "", killed: false, removed: false };
	const host: ClaudeCodeHost = {
		async resolveBinary() {
			return opts.binary === undefined ? "/usr/local/bin/claude" : opts.binary;
		},
		async writeTemp(text) {
			seen.system = text;
			return "/tmp/x/system.txt";
		},
		removeTemp() {
			seen.removed = true;
		},
		spawn(_bin, args) {
			seen.args = args;
			const p = new EventEmitter() as EventEmitter & ProcessLike;
			const out = new EventEmitter();
			const err = new EventEmitter();
			Object.assign(p, {
				stdout: out,
				stderr: err,
				stdin: { write: (t: string) => (seen.stdin += t), end: () => {
					setTimeout(() => {
						for (const c of stdoutChunks) out.emit("data", Buffer.from(c));
						if (opts.stderr) err.emit("data", Buffer.from(opts.stderr));
						p.emit("close", opts.code ?? 0);
					}, 5);
				} },
				kill: () => (seen.killed = true),
			});
			return p;
		},
	};
	return { host, seen };
}

const req = { system: `Book${CACHE_MARK}Chapter`, messages: [{ role: "user" as const, content: "Write" }] };

describe("Claude Code provider: pure parts", () => {
	it("uses safe, tool-less, ephemeral print mode with a system prompt file", () => {
		const a = buildClaudeCodeArgs({ binary: "claude", model: "opus", effort: "low" }, "/tmp/s.txt");
		expect(a.slice(0, 3)).toEqual(["-p", "--output-format", "stream-json"]);
		for (const flag of ["--include-partial-messages", "--no-session-persistence", "--safe-mode", "--strict-mcp-config"]) expect(a).toContain(flag);
		expect(a[a.indexOf("--tools") + 1]).toBe("");
		expect(a[a.indexOf("--max-turns") + 1]).toBe("1");
		expect(a[a.indexOf("--system-prompt-file") + 1]).toBe("/tmp/s.txt");
		expect(a[a.indexOf("--model") + 1]).toBe("opus");
		expect(a[a.indexOf("--effort") + 1]).toBe("low");
		expect(a).not.toContain("--bare"); // bare mode would ignore the user's subscription sign-in
	});
	it("turns the cache marker into Claude Code's dynamic boundary", () => {
		expect(claudeCodeSystem(`Book${CACHE_MARK}Chapter`)).toBe(`Book\n${DYNAMIC_BOUNDARY}\nChapter`);
	});
	it("flattens chat history into one prompt", () => {
		expect(promptFromMessages([{ role: "user", content: "hi" }])).toBe("hi");
		const p = promptFromMessages([{ role: "user", content: "Where is Mara?" }, { role: "assistant", content: "At the harbor." }, { role: "user", content: "And Arthur?" }]);
		expect(p).toContain("Author: Where is Mara?\n\nYou: At the harbor.");
		expect(p.endsWith("The author's new message:\nAnd Arthur?")).toBe(true);
	});
	it("parses streamed deltas split across chunks, and the final result", () => {
		const parser = new StreamJsonParser();
		const all = [JSON.stringify({ type: "system", subtype: "init" }), delta("Hel"), delta("lo"), result({ is_error: false, result: "Hello" })].join("\n") + "\n";
		parser.feed(all.slice(0, 50));
		parser.feed(all.slice(50));
		parser.end();
		expect(parser.text).toBe("Hello");
		expect(parser.result).toEqual({ isError: false, text: "Hello", status: undefined });
	});
	it("falls back to the result text when partial messages aren't available", () => {
		const parser = new StreamJsonParser();
		parser.feed(result({ is_error: false, result: "Whole answer" }) + "\n");
		expect(parser.text).toBe("Whole answer");
	});
});

describe("Claude Code provider: client", () => {
	it("streams text, sends the prompt on stdin, writes and removes the system file", async () => {
		const { host, seen } = fakeHost([delta("The fog ") + "\n" + delta("lifted."), "\n" + result({ is_error: false, result: "The fog lifted." }) + "\n"]);
		const client = new ClaudeCodeClient({ binary: "claude", model: "sonnet" }, host);
		const parts: string[] = [];
		expect(await client.stream(req, (t) => parts.push(t))).toBe("The fog lifted.");
		expect(parts.at(-1)).toBe("The fog lifted.");
		expect(seen.stdin).toBe("Write");
		expect(seen.system).toBe(`Book\n${DYNAMIC_BOUNDARY}\nChapter`);
		expect(seen.removed).toBe(true);
	});
	it("maps 'not signed in' to a readable auth error", async () => {
		const { host } = fakeHost([result({ is_error: true, result: "Not logged in · Please run /login", api_error_status: 401 }) + "\n"], { code: 1 });
		await expect(new ClaudeCodeClient({ binary: "claude", model: "sonnet" }, host).complete(req)).rejects.toMatchObject({ kind: "auth" });
	});
	it("maps plan usage limits to a rate-limit error", async () => {
		const { host } = fakeHost([result({ is_error: true, result: "Claude usage limit reached", api_error_status: 429 }) + "\n"], { code: 1 });
		await expect(new ClaudeCodeClient({ binary: "claude", model: "sonnet" }, host).complete(req)).rejects.toMatchObject({ kind: "rate_limit" });
	});
	it("explains a missing install and an outdated CLI", async () => {
		await expect(new ClaudeCodeClient({ binary: "claude", model: "s" }, fakeHost([], { binary: null }).host).complete(req)).rejects.toThrow(/Couldn't find Claude Code/);
		await expect(new ClaudeCodeClient({ binary: "claude", model: "s" }, fakeHost([], { code: 1, stderr: "error: unknown option '--safe-mode'" }).host).complete(req)).rejects.toThrow(/claude update/);
		await expect(new ClaudeCodeClient({ binary: "claude", model: "s" }, null).complete(req)).rejects.toThrow(/desktop/);
	});
	it("Stop kills the process", async () => {
		const { host, seen } = fakeHost([delta("x")]);
		const ac = new AbortController();
		const p = new ClaudeCodeClient({ binary: "claude", model: "s" }, host).stream(req, () => {}, ac.signal);
		await new Promise((r) => setTimeout(r, 1));
		ac.abort();
		await expect(p).rejects.toMatchObject({ kind: "aborted" });
		expect(seen.killed).toBe(true);
	});
});
