import { Modal, Platform, setIcon } from "obsidian";
import { claudeCodeStatus } from "../llm/claudeCodeNode";
import { providerConfig, PROVIDERS, type ProviderId } from "../llm/client";
import { friendlyError } from "../llm/types";
import type StoryloomPlugin from "../main";
import { applyScaffold, planScaffold } from "../scaffold";
import { glass, openSettings } from "../ui";

type Step = 0 | 1 | 2;

interface Choice {
	id: ProviderId;
	title: string;
	desc: string;
	icon: string;
	hidden?: boolean;
}

/** First-run setup: connect an AI, set up the book's folders, then a few tips. Every step can be skipped. */
export class SetupModal extends Modal {
	private step: Step = 0;
	private bookTitle = "";

	constructor(private plugin: StoryloomPlugin) {
		super(plugin.app);
		glass(this);
		this.modalEl.addClass("sl-setup");
	}

	onOpen() {
		this.bookTitle = this.app.vault.getName();
		this.render();
	}

	async onClose() {
		this.contentEl.empty();
		if (!this.plugin.settings.onboarded) {
			this.plugin.settings.onboarded = true;
			await this.plugin.saveSettings();
		}
	}

	private render() {
		const el = this.contentEl;
		el.empty();
		const dots = el.createDiv({ cls: "sl-setup-steps" });
		["Connect AI", "Your book", "Ready"].forEach((label, i) => {
			const d = dots.createDiv({ cls: `sl-setup-step${i === this.step ? " is-active" : ""}${i < this.step ? " is-done" : ""}` });
			const n = d.createSpan({ cls: "sl-setup-step-n" });
			if (i < this.step) setIcon(n, "check");
			else n.setText(String(i + 1));
			d.createSpan({ text: label });
		});
		const body = el.createDiv({ cls: "sl-setup-body" });
		if (this.step === 0) this.connect(body);
		else if (this.step === 1) this.book(body);
		else this.ready(body);
	}

	private footer(parent: HTMLElement, next: { label: string; onClick: () => void }, skip?: string) {
		const f = parent.createDiv({ cls: "sl-setup-footer" });
		if (this.step > 0) {
			const back = f.createEl("button", { text: "Back" });
			back.addEventListener("click", () => this.go((this.step - 1) as Step));
		}
		f.createDiv({ cls: "sl-setup-spacer" });
		if (skip) {
			const s = f.createEl("button", { cls: "sl-setup-skip", text: skip });
			s.addEventListener("click", () => this.go((this.step + 1) as Step));
		}
		const b = f.createEl("button", { cls: "mod-cta", text: next.label });
		b.addEventListener("click", next.onClick);
		return b;
	}

	private go(step: Step) {
		this.step = step;
		this.render();
	}

	// ---------- Step 1: connect ----------

	private connect(body: HTMLElement) {
		body.createEl("h2", { text: "Welcome to Storyloom" });
		body.createEl("p", { cls: "sl-setup-lead", text: "First, choose how Storyloom talks to an AI. You can change this any time in settings." });

		const s = this.plugin.settings;
		const choices: Choice[] = [
			{ id: "claudecode", title: "My Claude subscription", desc: "Uses Claude Code on this computer. No API key needed.", icon: "sparkles", hidden: !Platform.isDesktopApp },
			{ id: "anthropic", title: "Anthropic API key", desc: "Pay per use. Get a key at console.anthropic.com.", icon: "key-round" },
			{ id: "ollama", title: "Local model (Ollama)", desc: "Free and private. Runs on your machine.", icon: "cpu" },
			{ id: "openai", title: "Something else", desc: "OpenAI, OpenRouter, LM Studio or any compatible server.", icon: "plug" },
		];
		const grid = body.createDiv({ cls: "sl-setup-choices" });
		const detail = body.createDiv({ cls: "sl-setup-detail" });
		const status = body.createDiv({ cls: "sl-setup-status" });
		const select = async (id: ProviderId) => {
			s.provider = id;
			await this.plugin.saveSettings();
			grid.querySelectorAll(".sl-setup-choice").forEach((c) => c.toggleClass("is-selected", (c as HTMLElement).dataset.id === id));
			this.providerDetail(detail, status);
		};
		for (const c of choices) {
			if (c.hidden) continue;
			const card = grid.createDiv({ cls: `sl-setup-choice${s.provider === c.id || (c.id === "openai" && ["openrouter", "lmstudio", "custom"].includes(s.provider)) ? " is-selected" : ""}`, attr: { "data-id": c.id, tabindex: "0", role: "button" } });
			setIcon(card.createDiv({ cls: "sl-setup-choice-icon" }), c.icon);
			card.createDiv({ cls: "sl-setup-choice-title", text: c.title });
			card.createDiv({ cls: "sl-setup-choice-desc", text: c.desc });
			card.addEventListener("click", () => void select(c.id));
			card.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter" || ev.key === " ") {
					ev.preventDefault();
					void select(c.id);
				}
			});
		}
		this.providerDetail(detail, status);
		this.footer(body, { label: "Continue", onClick: () => this.go(1) }, "Skip for now");
	}

	private providerDetail(detail: HTMLElement, status: HTMLElement) {
		detail.empty();
		status.empty();
		const s = this.plugin.settings;
		const cfg = providerConfig(s);
		const save = async (patch: Partial<typeof cfg>) => {
			s.providers[s.provider] = { ...providerConfig(s), ...patch };
			await this.plugin.saveSettings();
		};
		const field = (label: string, value: string, placeholder: string, onChange: (v: string) => void, password = false) => {
			const row = detail.createDiv({ cls: "sl-setup-field" });
			row.createEl("label", { text: label });
			const input = row.createEl("input", { type: password ? "password" : "text", value, attr: { placeholder, spellcheck: "false" } });
			input.addEventListener("input", () => onChange(input.value.trim()));
			return input;
		};

		if (s.provider === "claudecode") {
			detail.createEl("p", { cls: "storyloom-muted", text: "Storyloom runs the Claude Code app you already have, so it uses whatever plan Claude Code is signed in with. Storyloom never sees your Claude login. Not installed or signed in? Install Claude Code, run `claude` once in a terminal, then check again." });
		} else if (s.provider === "anthropic") {
			const i = field("API key", cfg.apiKey, "sk-ant-…", (v) => void save({ apiKey: v }), true);
			window.setTimeout(() => i.focus(), 0);
			detail.createEl("p", { cls: "storyloom-muted", text: "Stored only in this vault's plugin settings file." });
		} else if (s.provider === "ollama") {
			field("Model", cfg.model, PROVIDERS.ollama.defaults.model, (v) => void save({ model: v || PROVIDERS.ollama.defaults.model }));
			detail.createEl("p", { cls: "storyloom-muted", text: "Start Ollama and pull a model first, e.g. `ollama pull llama3.1`." });
		} else {
			const p = detail.createEl("p", { cls: "storyloom-muted", text: "Pick the exact provider, base URL and model in settings. " });
			const a = p.createEl("a", { text: "Open settings", href: "#" });
			a.addEventListener("click", (ev) => {
				ev.preventDefault();
				this.close();
				openSettings(this.app);
			});
		}

		const test = status.createEl("button", { cls: "sl-setup-test" });
		setIcon(test.createSpan({ cls: "storyloom-btn-icon" }), "zap");
		test.createSpan({ text: s.provider === "claudecode" ? "Check Claude Code" : "Test connection" });
		const out = status.createDiv({ cls: "sl-setup-result" });
		test.addEventListener("click", async () => {
			test.disabled = true;
			out.className = "sl-setup-result is-pending";
			out.setText(s.provider === "claudecode" ? "Looking for Claude Code…" : "Sending a tiny test request…");
			const r = await this.test();
			test.disabled = false;
			out.className = `sl-setup-result ${r.ok ? "is-ok" : "is-error"}`;
			out.empty();
			setIcon(out.createSpan({ cls: "storyloom-btn-icon" }), r.ok ? "check-circle-2" : "alert-circle");
			out.createSpan({ text: r.message });
		});
	}

	private async test(): Promise<{ ok: boolean; message: string }> {
		const s = this.plugin.settings;
		if (s.provider === "claudecode") {
			this.plugin.llm(); // creates the desktop host on first use
			const status = await claudeCodeStatus(this.plugin.claudeHost ?? null, providerConfig(s).baseUrl || "claude");
			if (!status.ok) return status;
		}
		try {
			const reply = await this.plugin.testConnection();
			return { ok: true, message: `Connected. The model replied “${reply}”.` };
		} catch (e) {
			return { ok: false, message: friendlyError(e) };
		}
	}

	// ---------- Step 2: book ----------

	private book(body: HTMLElement) {
		const s = this.plugin.settings;
		body.createEl("h2", { text: "Set up your book" });
		const exists = (p: string) => !!this.app.vault.getAbstractFileByPath(p);
		const plan = planScaffold(s, exists, this.bookTitle);
		if (!plan.folders.length && !plan.files.length) {
			body.createEl("p", { cls: "sl-setup-lead", text: "This vault is already set up: chapters, codex, templates and a Book note are all in place." });
			this.footer(body, { label: "Continue", onClick: () => this.go(2) });
			return;
		}
		body.createEl("p", { cls: "sl-setup-lead", text: "Storyloom keeps everything as plain Markdown notes. It will add whatever's missing below and won't touch anything that already exists." });
		const row = body.createDiv({ cls: "sl-setup-field" });
		row.createEl("label", { text: "Book title" });
		const input = row.createEl("input", { type: "text", value: this.bookTitle });
		input.addEventListener("input", () => (this.bookTitle = input.value.trim() || this.app.vault.getName()));

		const list = body.createDiv({ cls: "sl-setup-plan" });
		const item = (icon: string, path: string, note: string) => {
			const r = list.createDiv({ cls: "sl-setup-plan-item" });
			setIcon(r.createSpan({ cls: "storyloom-btn-icon" }), icon);
			r.createSpan({ cls: "sl-setup-plan-path", text: path });
			r.createSpan({ cls: "storyloom-muted", text: note });
		};
		const notes: Record<string, string> = { [s.manuscriptFolder]: "your chapters", [`${s.codexFolder}/Characters`]: "people", [`${s.codexFolder}/Locations`]: "places", [`${s.codexFolder}/Lore`]: "everything else", [s.templatesFolder]: "for new notes" };
		for (const f of plan.folders) item("folder", f + "/", notes[f] ?? "");
		for (const f of plan.files) item("file-text", f.path, f.path === s.bookPath ? "premise, style guide and voice sample" : "template");

		const b = this.footer(body, {
			label: "Create",
			onClick: async () => {
				b.disabled = true;
				b.setText("Creating…");
				await applyScaffold(this.app, planScaffold(s, exists, this.bookTitle));
				await this.plugin.index.rebuild();
				this.go(2);
			},
		}, "Skip");
	}

	// ---------- Step 3: tips ----------

	private ready(body: HTMLElement) {
		body.createEl("h2", { text: "You're ready" });
		body.createEl("p", { cls: "sl-setup-lead", text: "A few things worth knowing:" });
		const mod = Platform.isMacOS ? "⌘" : "Ctrl";
		const tips: [string, string, string][] = [
			["text-cursor-input", `Select text and press ${mod}+K`, "Ask the AI to rewrite it. Tab accepts, Esc discards. With nothing selected it writes at the cursor."],
			["feather", "The Storyloom button in the left ribbon", "Opens Chapters, Codex, Timeline, Graph and more, plus quick actions."],
			["users", "Names are underlined in your chapters", "Hover one to see that character's state as of the chapter you're in."],
			["refresh-cw", "Update story state after a chapter", "Storyloom reads it and suggests what changed: who moved, who learned what. You approve each line."],
		];
		const list = body.createDiv({ cls: "sl-setup-tips" });
		for (const [icon, title, desc] of tips) {
			const t = list.createDiv({ cls: "sl-setup-tip" });
			setIcon(t.createDiv({ cls: "sl-setup-tip-icon" }), icon);
			const txt = t.createDiv();
			txt.createDiv({ cls: "sl-setup-tip-title", text: title });
			txt.createDiv({ cls: "storyloom-muted", text: desc });
		}
		this.footer(body, {
			label: "Open chapters",
			onClick: () => {
				this.close();
				void this.plugin.openView("storyloom-chapters", "tab");
			},
		});
	}
}
