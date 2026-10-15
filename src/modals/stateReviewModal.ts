import { App, Modal, Setting } from "obsidian";
import type { CodexIndex } from "../codex/index";
import { stripWikilinks } from "../codex/parse";
import { resolveState } from "../codex/state";
import { dedupeTimeline, hasActiveRelationship } from "../codex/write";
import type { StateUpdate } from "../llm/json";
import { renderEntityRows, type EntityRow } from "./entityReviewModal";
import { glass } from "../ui";

export interface FieldRow {
	key: string;
	value: string | null; // null = clear
	previous?: string;
	checked: boolean;
}

export interface TimelineGroup {
	entity: string; // canonical name (or new entity name)
	known: boolean;
	fields: FieldRow[];
	note?: { text: string; checked: boolean };
}

export interface RelRow {
	from: string;
	to: string;
	label: string;
	fromChapter: number;
	endsPrevious: boolean;
	checked: boolean;
}

export interface ApprovedChanges {
	chapter: number;
	timeline: { entity: string; fields: Record<string, string | null>; note?: string }[];
	relationships: Omit<RelRow, "checked">[];
	newEntities: EntityRow[];
}

/** Turn the model's proposal into review rows, dropping anything already recorded. */
export function buildReviewRows(update: StateUpdate, index: CodexIndex, chapter: number) {
	const newNames = new Set(update.newEntities.map((e) => e.name));
	const groups = new Map<string, TimelineGroup>();
	for (const t of update.timeline) {
		const entity = index.getEntity(t.entity);
		const name = entity?.name ?? t.entity;
		const source = entity ?? { timeline: [], relationships: [] };
		const deduped = dedupeTimeline(source, chapter, { fields: t.fields, note: t.note });
		if (!deduped) continue;
		const before = resolveState(source, chapter - 1);
		const g = groups.get(name) ?? { entity: name, known: !!entity || newNames.has(name), fields: [] };
		for (const [key, value] of Object.entries(deduped.fields)) {
			g.fields.push({ key, value, previous: before.fields[key], checked: g.known });
		}
		if (deduped.note) g.note = { text: deduped.note, checked: g.known };
		groups.set(name, g);
	}
	const rels: RelRow[] = [];
	for (const r of update.relationships) {
		const from = index.getEntity(r.from);
		const to = index.getEntity(r.to);
		const fromName = from?.name ?? r.from;
		const toName = to?.name ?? r.to;
		if (from && hasActiveRelationship(from, toName, r.label, chapter)) continue;
		rels.push({
			from: fromName,
			to: toName,
			label: stripWikilinks(r.label),
			fromChapter: r.fromChapter && r.fromChapter > 0 ? r.fromChapter : chapter,
			endsPrevious: !!r.endsPrevious,
			checked: !!from || newNames.has(fromName),
		});
	}
	const entities: EntityRow[] = update.newEntities.filter((e) => !index.getEntity(e.name)).map((e) => ({ ...e, checked: true }));
	return { groups: Array.from(groups.values()), rels, entities };
}

export class StateReviewModal extends Modal {
	private applied = false;
	constructor(
		app: App,
		private chapter: number,
		private rows: ReturnType<typeof buildReviewRows>,
		private resolve: (c: ApprovedChanges | null) => void,
	) {
		super(app);
		glass(this);
	}

	static review(app: App, chapter: number, rows: ReturnType<typeof buildReviewRows>): Promise<ApprovedChanges | null> {
		return new Promise((resolve) => new StateReviewModal(app, chapter, rows, resolve).open());
	}

	onOpen() {
		this.modalEl.addClass("storyloom-review-modal");
		this.titleEl.setText(`Story state changes — chapter ${this.chapter}`);
		const { groups, rels, entities } = this.rows;
		const c = this.contentEl;
		if (!groups.length && !rels.length && !entities.length) {
			c.createEl("p", { text: "Nothing new to record. The codex already reflects this chapter." });
		} else {
			c.createEl("p", { cls: "storyloom-muted", text: "Nothing is written until you click Apply. Uncheck anything you don't want; values are editable." });
		}

		for (const g of groups) {
			const box = c.createDiv({ cls: "storyloom-review-group" });
			const h = box.createDiv({ cls: "storyloom-review-entity", text: g.entity });
			if (!g.known) h.createSpan({ cls: "storyloom-badge", text: "not in codex" });
			for (const f of g.fields) {
				const row = box.createDiv({ cls: "storyloom-review-row" });
				const cb = row.createEl("input", { type: "checkbox" });
				cb.checked = f.checked;
				cb.disabled = !g.known;
				cb.addEventListener("change", () => (f.checked = cb.checked));
				row.createSpan({ cls: "storyloom-review-key", text: f.key });
				const input = row.createEl("input", { type: "text", cls: "storyloom-review-value" });
				input.value = f.value ?? "—";
				input.addEventListener("input", () => (f.value = input.value));
				if (f.previous !== undefined) row.createSpan({ cls: "storyloom-review-prev", text: `was ${stripWikilinks(f.previous)}` });
			}
			if (g.note) {
				const note = g.note;
				const row = box.createDiv({ cls: "storyloom-review-row" });
				const cb = row.createEl("input", { type: "checkbox" });
				cb.checked = note.checked;
				cb.disabled = !g.known;
				cb.addEventListener("change", () => (note.checked = cb.checked));
				row.createSpan({ cls: "storyloom-review-key", text: "note" });
				const input = row.createEl("input", { type: "text", cls: "storyloom-review-value" });
				input.value = note.text;
				input.addEventListener("input", () => (note.text = input.value));
			}
		}

		if (rels.length) {
			const box = c.createDiv({ cls: "storyloom-review-group" });
			box.createDiv({ cls: "storyloom-review-entity", text: "Relationships" });
			for (const r of rels) {
				const row = box.createDiv({ cls: "storyloom-review-row" });
				const cb = row.createEl("input", { type: "checkbox" });
				cb.checked = r.checked;
				cb.addEventListener("change", () => (r.checked = cb.checked));
				row.createSpan({ cls: "storyloom-review-key is-names", text: `${r.from} → ${r.to}` });
				const input = row.createEl("input", { type: "text", cls: "storyloom-review-value" });
				input.value = r.label;
				input.addEventListener("input", () => (r.label = input.value));
				row.createSpan({ cls: "storyloom-review-prev", text: `from ch ${r.fromChapter}${r.endsPrevious ? ", ends previous" : ""}` });
			}
		}

		if (entities.length) {
			const box = c.createDiv({ cls: "storyloom-review-group" });
			box.createDiv({ cls: "storyloom-review-entity", text: "New entities" });
			renderEntityRows(box, entities);
		}

		new Setting(c)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Apply")
					.setCta()
					.setDisabled(!groups.length && !rels.length && !entities.length)
					.onClick(() => {
						this.applied = true;
						this.close();
					}),
			);
	}

	onClose() {
		this.contentEl.empty();
		if (!this.applied) return this.resolve(null);
		const createdNames = new Set(this.rows.entities.filter((e) => e.checked).map((e) => e.name));
		const usable = (name: string, known: boolean) => known || createdNames.has(name);
		const timeline: ApprovedChanges["timeline"] = [];
		for (const g of this.rows.groups) {
			if (!usable(g.entity, g.known)) continue;
			const fields: Record<string, string | null> = {};
			for (const f of g.fields) if (f.checked) fields[f.key] = f.value;
			const note = g.note?.checked ? g.note.text : undefined;
			if (Object.keys(fields).length || note) timeline.push({ entity: g.entity, fields, note });
		}
		this.resolve({
			chapter: this.chapter,
			timeline,
			relationships: this.rows.rels.filter((r) => r.checked && r.label.trim()).map(({ checked: _c, ...r }) => r),
			newEntities: this.rows.entities.filter((e) => e.checked && e.name.trim()),
		});
	}
}
