/**
 * Desktop-only process host for the Claude Code provider. Node modules are loaded lazily through
 * Obsidian's `require`, so the plugin still loads on mobile (where this provider is unavailable).
 */
import type { ClaudeCodeHost, ProcessLike } from "./claudeCode";

type NodeRequire = (id: string) => unknown;

interface NodeMods {
	cp: { spawn(cmd: string, args: string[], opts: Record<string, unknown>): ProcessLike; execFile(cmd: string, args: string[], opts: Record<string, unknown>, cb: (err: Error | null, stdout: string) => void): void };
	fs: { existsSync(p: string): boolean; promises: { writeFile(p: string, d: string, enc: string): Promise<void>; mkdtemp(prefix: string): Promise<string> }; rmSync(p: string, o: Record<string, unknown>): void };
	os: { tmpdir(): string; homedir(): string; platform(): string };
	path: { join(...p: string[]): string; dirname(p: string): string; delimiter: string };
	env: Record<string, string | undefined>;
}

function nodeMods(): NodeMods | null {
	const req = (window as unknown as { require?: NodeRequire }).require;
	const proc = (window as unknown as { process?: { env: Record<string, string | undefined> } }).process;
	if (!req || !proc) return null;
	try {
		return {
			cp: req("child_process") as NodeMods["cp"],
			fs: req("fs") as NodeMods["fs"],
			os: req("os") as NodeMods["os"],
			path: req("path") as NodeMods["path"],
			env: proc.env,
		};
	} catch {
		return null;
	}
}

/** Where installers put `claude`. Apps launched from the dock don't inherit the shell's PATH. */
function candidates(m: NodeMods): string[] {
	const home = m.os.homedir();
	if (m.os.platform() === "win32") {
		const appData = m.env.APPDATA ?? m.path.join(home, "AppData", "Roaming");
		return [m.path.join(home, ".local", "bin", "claude.exe"), m.path.join(appData, "npm", "claude.cmd")];
	}
	return [
		m.path.join(home, ".local", "bin", "claude"),
		m.path.join(home, ".claude", "local", "claude"),
		"/opt/homebrew/bin/claude",
		"/usr/local/bin/claude",
		"/usr/bin/claude",
		m.path.join(home, ".npm-global", "bin", "claude"),
		m.path.join(home, ".volta", "bin", "claude"),
	];
}

/** Ask the user's login shell, which knows their real PATH (nvm, asdf, custom installs). */
function fromLoginShell(m: NodeMods): Promise<string | null> {
	if (m.os.platform() === "win32") return Promise.resolve(null);
	const shell = m.env.SHELL || "/bin/sh";
	return new Promise((resolve) => {
		m.cp.execFile(shell, ["-lc", "command -v claude"], { timeout: 4000 }, (err, stdout) => {
			const p = String(stdout ?? "").trim().split("\n").pop() ?? "";
			resolve(!err && p.startsWith("/") ? p : null);
		});
	});
}

export function createClaudeCodeHost(): ClaudeCodeHost | null {
	const m = nodeMods();
	if (!m) return null;
	let cached: { configured: string; path: string | null } | null = null;

	const env = () => {
		// npm-installed `claude` is a Node script, so its directory (and Node's) must be on PATH.
		const extra = [...new Set(candidates(m).map((c) => m.path.dirname(c)))];
		return { ...m.env, PATH: [m.env.PATH ?? "", ...extra].filter(Boolean).join(m.path.delimiter) };
	};

	return {
		async resolveBinary(configured: string) {
			const want = configured.trim();
			if (cached && cached.configured === want && cached.path) return cached.path;
			let found: string | null = null;
			if (want && want !== "claude") found = m.fs.existsSync(want) ? want : null;
			else found = candidates(m).find((c) => m.fs.existsSync(c)) ?? (await fromLoginShell(m));
			cached = { configured: want, path: found };
			return found;
		},
		spawn(binary: string, args: string[]) {
			const cwd = m.os.tmpdir(); // never a folder with a CLAUDE.md or .mcp.json in it
			const shell = /\.(cmd|bat)$/i.test(binary); // npm shims on Windows need a shell
			return m.cp.spawn(binary, args, { cwd, env: env(), shell, windowsHide: true });
		},
		async writeTemp(text: string) {
			const dir = await m.fs.promises.mkdtemp(m.path.join(m.os.tmpdir(), "motif-"));
			const file = m.path.join(dir, "system.txt");
			await m.fs.promises.writeFile(file, text, "utf8");
			return file;
		},
		removeTemp(file: string) {
			try {
				m.fs.rmSync(m.path.dirname(file), { recursive: true, force: true });
			} catch {
				/* temp dir; the OS cleans it eventually */
			}
		},
	};
}

/** `claude auth status` for the settings tab: "Signed in with your Claude account", etc. Never reads credentials itself. */
export async function claudeCodeStatus(host: ClaudeCodeHost | null, configured: string): Promise<{ ok: boolean; message: string }> {
	const m = nodeMods();
	if (!host || !m) return { ok: false, message: "Only available in Obsidian on desktop." };
	const bin = await host.resolveBinary(configured);
	if (!bin) return { ok: false, message: "Claude Code not found. Install it from claude.com/claude-code, or set its path below." };
	return new Promise((resolve) => {
		m.cp.execFile(bin, ["auth", "status"], { timeout: 10000, shell: /\.(cmd|bat)$/i.test(bin) }, (_err, stdout) => {
			try {
				const j = JSON.parse(String(stdout)) as { loggedIn?: boolean; authMethod?: string };
				if (!j.loggedIn) return resolve({ ok: false, message: `Found Claude Code at ${bin}, but it isn't signed in. Run \`claude\` in a terminal and sign in.` });
				const how = j.authMethod === "claude.ai" || j.authMethod === "oauth_token" ? "your Claude account" : j.authMethod === "api_key" ? "an API key" : (j.authMethod ?? "unknown");
				resolve({ ok: true, message: `Claude Code is signed in with ${how} (${bin}).` });
			} catch {
				resolve({ ok: false, message: `Found Claude Code at ${bin}, but couldn't read its sign-in status. Try \`claude update\`.` });
			}
		});
	});
}
