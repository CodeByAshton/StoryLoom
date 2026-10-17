import { App, Editor, Modal, Notice, setIcon, type EditorPosition } from "obsidian";
import { friendlyError } from "../llm/types";
import { InstructionModal } from "./instructionModal";
import { addSettingsButton, glass } from "../ui";

export interface ResultItem {
	label?: string;
	text: string;
}

export interface ResultAction {
	label: string;
	icon?: string;
	cta?: boolean;
	run: (text: string) => void | Promise<void>;
}

export interface ResultModalOptions {
	title: string;
	editor?: Editor;
	/** Produce results. `extra` is an additional instruction from "Retry with instruction…". */
	/** `live` receives text as it streams in (single-result tools only). */
	run: (extra: string | undefined, live: (text: string) => void) => Promise<ResultItem[]>;
	/** Replace the default Insert/Replace buttons on the whole result. */
	actions?: ResultAction[];
	/** Render items as Markdown-ish blocks with per-item buttons (multi-version results). */
	perItemButtons?: boolean;
}

/** Insert text at a position, adding a separating space when the text would otherwise run into a word. */
export function smartInsert(editor: Editor, text: string, pos: EditorPosition) {
	const before = editor.getRange({ line: pos.line, ch: Math.max(0, pos.ch - 1) }, pos);
	let t = text;
	if (before && !/\s/.test(before) && !/^\s/.test(t)) t = " " + t;
	editor.replaceRange(t, pos);
	const lines = t.split("\n");
	const end = { line: pos.line + lines.length - 1, ch: (lines.length === 1 ? pos.ch : 0) + lines[lines.length - 1].length };
	editor.setCursor(end);
}

export class ResultModal extends Modal {
	private items: ResultItem[] = [];
	private busy = false;
	private cursor?: EditorPosition;
	private from?: EditorPosition;
	private to?: EditorPosition;
	private hasSelection = false;
	private bodyEl!: HTMLElement;
	private footerEl!: HTMLElement;
	private runId = 0;

	constructor(
		app: App,
		private opts: ResultModalOptions,
	) {
		super(app);
		glass(this);
		if (opts.editor) {
			this.cursor = opts.editor.getCursor("to");
			this.from = opts.editor.getCursor("from");
			this.to = opts.editor.getCursor("to");
			this.hasSelection = opts.editor.somethingSelected();
		}
	}

	onOpen() {
		this.modalEl.addClass("storyloom-result-modal");
		this.titleEl.setText(this.opts.title);
		this.bodyEl = this.contentEl.createDiv({ cls: "storyloom-result-body" });
		this.footerEl = this.contentEl.createDiv({ cls: "storyloom-result-footer" });
		void this.generate();
	}

	onClose() {
		this.runId++;
		this.contentEl.empty();
	}

	private async generate(extra?: string) {
		const id = ++this.runId;
		this.busy = true;
		this.renderLoading();
		try {
			const items = await this.opts.run(extra, (text) => {
				if (id === this.runId) this.renderLive(text);
			});
			if (id !== this.runId) return;
			this.items = items;
			this.busy = false;
			this.render();
		} catch (e) {
			if (id !== this.runId) return;
			this.busy = false;
			this.renderError(friendlyError(e));
		}
	}

	private renderLive(text: string) {
		let el = this.bodyEl.querySelector(".storyloom-result-live") as HTMLElement | null;
		if (!el) {
			this.bodyEl.empty();
			el = this.bodyEl.createDiv({ cls: "storyloom-result-live" });
		}
		el.setText(text);
		el.scrollTop = el.scrollHeight;
	}

	private renderLoading() {
		this.bodyEl.empty();
		const l = this.bodyEl.createDiv({ cls: "storyloom-loading" });
		l.createSpan({ cls: "storyloom-spinner" });
		l.createSpan({ text: "Writing…" });
		this.renderFooter();
	}

	private renderError(msg: string) {
		this.bodyEl.empty();
		const err = this.bodyEl.createDiv({ cls: "storyloom-error" });
		setIcon(err.createSpan(), "alert-triangle");
		err.createSpan({ text: msg });
		addSettingsButton(this.bodyEl, this.app, msg, "mod-cta storyloom-settings-btn");
		this.renderFooter();
	}

	private render() {
		this.bodyEl.empty();
		const multi = this.opts.perItemButtons && this.items.length > 1;
		for (const item of this.items) {
			const card = this.bodyEl.createDiv({ cls: "storyloom-result-item" });
			if (item.label) card.createDiv({ cls: "storyloom-result-label", text: item.label });
			const ta = card.createEl("textarea", { cls: "storyloom-result-text" });
			ta.value = item.text;
			ta.rows = Math.min(16, Math.max(2, Math.ceil(item.text.length / 80) + item.text.split("\n").length));
			ta.addEventListener("input", () => (item.text = ta.value));
			if (multi) {
				const bar = card.createDiv({ cls: "storyloom-result-item-actions" });
				this.editorButtons(bar, () => item.text);
			}
		}
		this.renderFooter();
	}

	private allText(): string {
		return this.items.map((i) => i.text).join("\n\n");
	}

	private editorButtons(bar: HTMLElement, text: () => string) {
		if (this.opts.actions) {
			for (const a of this.opts.actions) this.button(bar, a.label, a.icon, async () => {
				await a.run(text());
				this.close();
			}, a.cta);
			return;
		}
		if (!this.opts.editor) return;
		this.button(bar, "Insert at cursor", "text-cursor-input", () => {
			smartInsert(this.opts.editor as Editor, text(), this.cursor as EditorPosition);
			this.close();
		}, !this.hasSelection);
		if (this.hasSelection) {
			this.button(bar, "Replace selection", "replace", () => {
				(this.opts.editor as Editor).replaceRange(text(), this.from as EditorPosition, this.to as EditorPosition);
				this.close();
			}, true);
		}
	}

	private renderFooter() {
		this.footerEl.empty();
		const left = this.footerEl.createDiv({ cls: "storyloom-footer-left" });
		const right = this.footerEl.createDiv({ cls: "storyloom-footer-right" });
		this.button(left, "Retry", "rotate-ccw", () => void this.generate());
		this.button(left, "Retry with instruction…", "message-square", async () => {
			const extra = await InstructionModal.ask(this.app, { title: "Retry with instruction", placeholder: "e.g. shorter, more dialogue", cta: "Retry" });
			if (extra) void this.generate(extra);
		});
		if (this.items.length && !this.busy) {
			this.button(right, "Copy", "copy", async () => {
				await navigator.clipboard.writeText(this.allText());
				new Notice("Motif: copied.");
			});
			if (!this.opts.perItemButtons || this.items.length === 1) this.editorButtons(right, () => this.allText());
		}
		if (this.busy) this.footerEl.querySelectorAll("button").forEach((b) => ((b as HTMLButtonElement).disabled = true));
	}

	private button(parent: HTMLElement, label: string, icon: string | undefined, onClick: () => void | Promise<void>, cta = false) {
		const b = parent.createEl("button", { cls: cta ? "mod-cta" : "" });
		if (icon) setIcon(b.createSpan({ cls: "storyloom-btn-icon" }), icon);
		b.createSpan({ text: label });
		b.disabled = this.busy;
		b.addEventListener("click", () => void onClick());
		return b;
	}
}
