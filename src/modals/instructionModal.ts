import { App, Modal, Setting, SuggestModal } from "obsidian";
import { CACHE_MARK } from "../llm/types";

/** Single-line text prompt. Resolves to null when cancelled. */
export class InstructionModal extends Modal {
	private value = "";
	private done = false;

	constructor(
		app: App,
		private opts: { title: string; placeholder?: string; initial?: string; cta?: string; optional?: boolean; description?: string },
		private resolve: (v: string | null) => void,
	) {
		super(app);
		this.value = opts.initial ?? "";
	}

	static ask(app: App, opts: InstructionModal["opts"]): Promise<string | null> {
		return new Promise((resolve) => new InstructionModal(app, opts, resolve).open());
	}

	onOpen() {
		this.titleEl.setText(this.opts.title);
		if (this.opts.description) this.contentEl.createEl("p", { text: this.opts.description, cls: "storyloom-muted" });
		const input = this.contentEl.createEl("input", { type: "text", cls: "storyloom-wide-input" });
		input.placeholder = this.opts.placeholder ?? "";
		input.value = this.value;
		input.addEventListener("input", () => (this.value = input.value));
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				this.submit();
			}
		});
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText(this.opts.cta ?? "OK").setCta().onClick(() => this.submit()));
		window.setTimeout(() => input.focus(), 0);
	}

	private submit() {
		const v = this.value.trim();
		if (!v && !this.opts.optional) return;
		this.done = true;
		this.resolve(v);
		this.close();
	}

	onClose() {
		if (!this.done) this.resolve(null);
		this.contentEl.empty();
	}
}

/** Pick one of a few options. Resolves to null when cancelled. */
export class ChoiceModal extends SuggestModal<string> {
	private picked = false;
	constructor(
		app: App,
		private choices: string[],
		placeholder: string,
		private resolve: (v: string | null) => void,
	) {
		super(app);
		this.setPlaceholder(placeholder);
	}

	static pick(app: App, choices: string[], placeholder: string): Promise<string | null> {
		return new Promise((resolve) => new ChoiceModal(app, choices, placeholder, resolve).open());
	}

	getSuggestions(query: string): string[] {
		const q = query.toLowerCase();
		return this.choices.filter((c) => c.toLowerCase().includes(q));
	}
	renderSuggestion(value: string, el: HTMLElement) {
		el.setText(value);
	}
	onChooseSuggestion(item: string) {
		this.picked = true;
		this.resolve(item);
	}
	onClose() {
		// onChooseSuggestion runs after onClose in some versions; defer the null.
		window.setTimeout(() => {
			if (!this.picked) this.resolve(null);
		}, 0);
	}
}

export class ConfirmModal extends Modal {
	private ok = false;
	constructor(
		app: App,
		private opts: { title: string; body: string | ((el: HTMLElement) => void); cta: string; warning?: boolean },
		private resolve: (v: boolean) => void,
	) {
		super(app);
	}
	static ask(app: App, opts: ConfirmModal["opts"]): Promise<boolean> {
		return new Promise((resolve) => new ConfirmModal(app, opts, resolve).open());
	}
	onOpen() {
		this.titleEl.setText(this.opts.title);
		if (typeof this.opts.body === "string") this.contentEl.createEl("p", { text: this.opts.body });
		else this.opts.body(this.contentEl);
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText(this.opts.cta).onClick(() => {
					this.ok = true;
					this.close();
				});
				if (this.opts.warning) b.setWarning();
				else b.setCta();
			});
	}
	onClose() {
		this.resolve(this.ok);
		this.contentEl.empty();
	}
}

/** Shows the full prompt before sending (debug setting). */
export function previewPrompt(app: App, system: string, user: string): Promise<boolean> {
	return ConfirmModal.ask(app, {
		title: "Context preview",
		cta: "Send",
		body: (el) => {
			el.createEl("p", { cls: "storyloom-muted", text: `System ${system.length.toLocaleString()} chars · user ${user.length.toLocaleString()} chars` });
			const pre = el.createEl("pre", { cls: "storyloom-preview" });
			const shown = system.split(CACHE_MARK).join("\n\n──────── cached above this line (Anthropic) ────────");
			pre.setText(`### SYSTEM\n${shown}\n\n### USER\n${user}`);
		},
	});
}
