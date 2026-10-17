import { App, Modal, Setting } from "obsidian";
import { ENTITY_TYPES } from "../codex/types";
import type { EntityProposal } from "../llm/json";
import { glass } from "../ui";

export interface EntityRow extends EntityProposal {
	checked: boolean;
}

/** Render editable new-entity rows into `parent`. Shared by both review modals. */
export function renderEntityRows(parent: HTMLElement, rows: EntityRow[]) {
	for (const row of rows) {
		const el = parent.createDiv({ cls: "storyloom-review-row" });
		const cb = el.createEl("input", { type: "checkbox" });
		cb.checked = row.checked;
		cb.addEventListener("change", () => (row.checked = cb.checked));
		const name = el.createEl("input", { type: "text", cls: "storyloom-review-name" });
		name.value = row.name;
		name.addEventListener("input", () => (row.name = name.value));
		const sel = el.createEl("select", { cls: "dropdown" });
		for (const t of ENTITY_TYPES) sel.createEl("option", { text: t, value: t });
		sel.value = (ENTITY_TYPES as readonly string[]).includes(row.type) ? row.type : "character";
		row.type = sel.value;
		sel.addEventListener("change", () => (row.type = sel.value));
		const desc = el.createEl("input", { type: "text", cls: "storyloom-review-value" });
		desc.value = row.description;
		desc.placeholder = "Description";
		desc.addEventListener("input", () => (row.description = desc.value));
	}
}

export class EntityReviewModal extends Modal {
	private applied = false;
	constructor(
		app: App,
		private rows: EntityRow[],
		private resolve: (rows: EntityRow[] | null) => void,
	) {
		super(app);
		glass(this);
	}

	static review(app: App, proposals: EntityProposal[]): Promise<EntityRow[] | null> {
		return new Promise((resolve) => new EntityReviewModal(app, proposals.map((p) => ({ ...p, checked: true })), resolve).open());
	}

	onOpen() {
		this.modalEl.addClass("storyloom-review-modal");
		this.titleEl.setText("New codex entries");
		if (!this.rows.length) {
			this.contentEl.createEl("p", { text: "No new names found in this chapter." });
		} else {
			this.contentEl.createEl("p", { cls: "storyloom-muted", text: "Checked names become codex entries, created from your templates." });
			renderEntityRows(this.contentEl.createDiv({ cls: "storyloom-review-group" }), this.rows);
		}
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Add to codex")
					.setCta()
					.setDisabled(!this.rows.length)
					.onClick(() => {
						this.applied = true;
						this.close();
					}),
			);
	}

	onClose() {
		this.resolve(this.applied ? this.rows.filter((r) => r.checked && r.name.trim()) : null);
		this.contentEl.empty();
	}
}
