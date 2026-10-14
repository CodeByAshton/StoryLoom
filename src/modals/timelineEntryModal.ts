import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { parseTimelineLine } from "../codex/parse";
import { appendToSection } from "../codex/write";
import type { Entity } from "../codex/types";

/** Append a `- ch N | ...` line to an entity's ## Timeline (creating the section if needed). */
export class TimelineEntryModal extends Modal {
	constructor(
		app: App,
		private entity: Entity,
		private chapter: number,
	) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(`Add timeline entry — ${this.entity.name}`);
		this.contentEl.createEl("p", {
			cls: "storyloom-muted",
			text: "Format: ch N | key: value | key: value. Keys like location, status, with, knows, note. Use — to clear a value.",
		});
		const input = this.contentEl.createEl("input", { type: "text", cls: "storyloom-wide-input" });
		const ch = Number.isFinite(this.chapter) ? this.chapter : 1;
		input.value = `ch ${ch} | `;
		const save = async () => {
			let line = input.value.trim();
			if (!line.startsWith("-")) line = "- " + line;
			if (!parseTimelineLine(line)) {
				new Notice("That line doesn't look like “ch N | key: value”.");
				return;
			}
			const f = this.app.vault.getAbstractFileByPath(this.entity.path);
			if (!(f instanceof TFile)) return;
			await this.app.vault.process(f, (text) => appendToSection(text, "Timeline", [line]));
			new Notice(`Added to ${this.entity.name}'s timeline.`);
			this.close();
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				void save();
			}
		});
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Add").setCta().onClick(() => void save()));
		window.setTimeout(() => {
			input.focus();
			input.setSelectionRange(input.value.length, input.value.length);
		}, 0);
	}

	onClose() {
		this.contentEl.empty();
	}
}
