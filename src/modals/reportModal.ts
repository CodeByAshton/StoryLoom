import { App, Component, MarkdownRenderer, Modal, Notice, setIcon } from "obsidian";
import { friendlyError } from "../llm/types";
import type { ContinuityIssue } from "../llm/json";
import { addSettingsButton } from "../ui";

/** Markdown report (critique) or a clickable list of continuity issues. */
export class ReportModal extends Modal {
	private component = new Component();
	private runId = 0;
	constructor(
		app: App,
		private opts: {
			title: string;
			sourcePath: string;
			run: () => Promise<{ markdown?: string; issues?: ContinuityIssue[] }>;
			onJump?: (quote: string) => boolean;
		},
	) {
		super(app);
	}

	onOpen() {
		this.modalEl.addClass("storyloom-result-modal");
		this.titleEl.setText(this.opts.title);
		this.component.load();
		void this.generate();
	}

	onClose() {
		this.runId++;
		this.component.unload();
		this.contentEl.empty();
	}

	private async generate() {
		const id = ++this.runId;
		const { contentEl } = this;
		contentEl.empty();
		const l = contentEl.createDiv({ cls: "storyloom-loading" });
		l.createSpan({ cls: "storyloom-spinner" });
		l.createSpan({ text: "Reading the chapter…" });
		try {
			const res = await this.opts.run();
			if (id !== this.runId) return;
			contentEl.empty();
			if (res.markdown !== undefined) {
				const md = contentEl.createDiv({ cls: "storyloom-report markdown-rendered" });
				await MarkdownRenderer.render(this.app, res.markdown, md, this.opts.sourcePath, this.component);
			}
			if (res.issues) this.renderIssues(res.issues);
			this.footer(res.markdown);
		} catch (e) {
			if (id !== this.runId) return;
			contentEl.empty();
			const err = contentEl.createDiv({ cls: "storyloom-error" });
			setIcon(err.createSpan(), "alert-triangle");
			err.createSpan({ text: friendlyError(e) });
			addSettingsButton(contentEl, this.app, friendlyError(e), "mod-cta storyloom-settings-btn");
			this.footer();
		}
	}

	private renderIssues(issues: ContinuityIssue[]) {
		if (!issues.length) {
			this.contentEl.createEl("p", { text: "No continuity problems found against the codex and earlier summaries." });
			return;
		}
		this.contentEl.createEl("p", { cls: "storyloom-muted", text: `${issues.length} possible issue${issues.length === 1 ? "" : "s"}. Click one to jump to the line.` });
		const list = this.contentEl.createDiv({ cls: "storyloom-issues" });
		for (const i of issues) {
			const row = list.createDiv({ cls: "storyloom-issue" });
			if (i.severity) row.createSpan({ cls: `storyloom-badge storyloom-sev-${i.severity.toLowerCase()}`, text: i.severity });
			if (i.quote) row.createEl("blockquote", { text: i.quote });
			const c = row.createDiv();
			c.createEl("strong", { text: "Conflicts with: " });
			c.appendText(i.conflict);
			if (i.fix) {
				const f = row.createDiv();
				f.createEl("strong", { text: "Fix: " });
				f.appendText(i.fix);
			}
			row.addEventListener("click", () => {
				if (!i.quote) return;
				if (this.opts.onJump?.(i.quote)) this.close();
				else new Notice("Couldn't find that line in the chapter. It may have been paraphrased.");
			});
		}
	}

	private footer(markdown?: string) {
		const bar = this.contentEl.createDiv({ cls: "storyloom-result-footer" });
		const left = bar.createDiv({ cls: "storyloom-footer-left" });
		const right = bar.createDiv({ cls: "storyloom-footer-right" });
		left.createEl("button", { text: "Retry" }).addEventListener("click", () => void this.generate());
		if (markdown) {
			right.createEl("button", { text: "Copy" }).addEventListener("click", async () => {
				await navigator.clipboard.writeText(markdown);
				new Notice("Copied");
			});
		}
	}
}
