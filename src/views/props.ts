import { setIcon } from "obsidian";
import { stripWikilinks } from "../codex/parse";
import { resolveState } from "../codex/state";
import type { Entity } from "../codex/types";
import { focusable } from "../ui";

/**
 * Building blocks for side panels: property rows (name · value) and small outline tags.
 * Flat and typographic, no boxes: the panel reads like a page, not a stack of cards.
 */

export const FIELD_ICONS: Record<string, string> = { location: "map-pin", with: "users", status: "activity", knows: "lightbulb", note: "sticky-note", role: "user-round" };

export interface PropRow {
	icon: string;
	name: string;
	/** Fills the value cell. */
	value: (cell: HTMLElement) => void;
	title?: string;
}

export function renderProps(parent: HTMLElement, rows: PropRow[]): HTMLElement {
	const list = parent.createDiv({ cls: "sl-props" });
	for (const r of rows) {
		const row = list.createDiv({ cls: "sl-prop" });
		row.createDiv({ cls: "sl-prop-name", text: r.name });
		const val = row.createDiv({ cls: "sl-prop-value" });
		r.value(val);
		if (r.title) row.setAttr("title", r.title);
	}
	return list;
}

/** A small outline tag; `is-strong` fills it for emphasis. */
export function tag(parent: HTMLElement, text: string, cls = ""): HTMLElement {
	return parent.createSpan({ cls: `sl-tag ${cls}`.trim(), text });
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface EntityRowHandlers {
	openNote?: (e: Entity) => void;
	openLink?: (target: string) => void;
	addTimeline?: (e: Entity) => void;
}

/** The state rows for an entity as of a chapter: location, company, status, knowledge, other fields, relationships. */
export function stateRows(e: Entity, asOf: number, handlers: EntityRowHandlers = {}): PropRow[] {
	const s = resolveState(e, asOf);
	const rows: PropRow[] = [];
	const since = (k: string) => (s.lastChangedIn[k] !== undefined ? `Since chapter ${s.lastChangedIn[k]}` : undefined);
	const order = ["location", "with", "status"];
	const keys = [...order.filter((k) => k in s.fields || (k === "with" && "with" in s.lastChangedIn)), ...Object.keys(s.fields).filter((k) => !order.includes(k) && k !== "knows").sort()];
	for (const k of keys) {
		const raw = s.fields[k];
		const v = raw === undefined ? "" : stripWikilinks(raw);
		rows.push({
			icon: FIELD_ICONS[k] ?? "circle-dot",
			name: cap(k),
			title: since(k),
			value: (cell) => {
				if (!v) cell.createSpan({ cls: "sl-prop-empty", text: "Empty" });
				else if (k === "status") tag(cell, v);
				else cell.setText(v);
			},
		});
	}
	if (s.knows.length) {
		rows.push({
			icon: FIELD_ICONS.knows,
			name: "Knows",
			value: (cell) => {
				cell.addClass("is-text");
				for (const k of s.knows) cell.createDiv({ cls: "sl-prop-line", text: stripWikilinks(k) });
			},
		});
	}
	if (s.relationships.length) {
		rows.push({
			icon: "link",
			name: "Relationships",
			value: (cell) => {
				cell.addClass("is-text");
				for (const r of s.relationships) {
					const line = cell.createDiv({ cls: "sl-prop-line" });
					// Only a target something can open looks and acts like a link.
					const open = handlers.openLink;
					if (open) focusable(line.createSpan({ cls: "sl-prop-link", text: r.target })).addEventListener("click", () => open(r.target));
					else line.createSpan({ text: r.target });
					line.createSpan({ cls: "sl-prop-muted", text: ` ${r.label}` });
				}
			},
		});
	}
	return rows;
}

/** One entity in a side panel: avatar, name and type tag, then its state rows. */
export function renderEntityBlock(parent: HTMLElement, e: Entity, asOf: number, opts: { handlers?: EntityRowHandlers } = {}): HTMLElement {
	const h = opts.handlers ?? {};
	const block = parent.createDiv({ cls: `sl-ent storyloom-type-${e.type}` });
	const head = block.createDiv({ cls: "sl-ent-head" });
	const name = head.createSpan({ cls: "sl-ent-name", text: e.name });
	if (h.openNote) {
		name.addClass("is-link");
		focusable(name);
		name.addEventListener("click", () => h.openNote?.(e));
	}
	tag(head, e.role || cap(e.type));
	const tools = head.createDiv({ cls: "sl-ent-tools" });
	if (h.addTimeline) {
		const b = tools.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Add timeline entry" } });
		setIcon(b, "plus");
		b.addEventListener("click", () => h.addTimeline?.(e));
	}
	if (h.openNote) {
		const b = tools.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Open note" } });
		setIcon(b, "arrow-up-right");
		b.addEventListener("click", () => h.openNote?.(e));
	}
	const rows = stateRows(e, asOf, h);
	if (rows.length) renderProps(block, rows);
	else block.createDiv({ cls: "sl-ent-none", text: Number.isFinite(asOf) ? `Nothing recorded by chapter ${asOf}.` : "Nothing recorded yet." });
	return block;
}

/**
 * The floating card shown on hover (editor, timeline, graph): the same rows as the Cast panel, plus
 * "as of chapter N", the latest note, a short description and actions.
 */
export function renderEntityPeek(parent: HTMLElement, e: Entity, asOf: number, opts: { handlers?: EntityRowHandlers } = {}): HTMLElement {
	const h = opts.handlers ?? {};
	const s = resolveState(e, asOf);
	const block = parent.createDiv({ cls: `sl-ent is-peek storyloom-type-${e.type}` });
	const head = block.createDiv({ cls: "sl-ent-head" });
	const name = head.createSpan({ cls: "sl-ent-name", text: e.name });
	if (h.openNote) {
		name.addClass("is-link");
		focusable(name);
		name.addEventListener("click", () => h.openNote?.(e));
	}
	tag(head, e.role || cap(e.type));
	block.createDiv({ cls: "sl-ent-meta", text: Number.isFinite(asOf) ? `As of chapter ${asOf}` : "Latest" });
	const rows = stateRows(e, asOf, h);
	if (s.notes.length) rows.push({ icon: FIELD_ICONS.note, name: "Latest", value: (c) => { c.addClass("is-text"); c.setText(`Ch ${s.notes[0].chapter}: ${stripWikilinks(s.notes[0].text)}`); } });
	if (rows.length) renderProps(block, rows);
	else block.createDiv({ cls: "sl-ent-none", text: Number.isFinite(asOf) ? `Nothing recorded by chapter ${asOf}.` : "Nothing recorded yet." });
	if (e.description) block.createDiv({ cls: "sl-ent-desc", text: stripWikilinks(e.description).split("\n").filter((l) => l.trim()).join(" ") });
	if (h.openNote || h.addTimeline) {
		const bar = block.createDiv({ cls: "sl-ent-actions" });
		const button = (label: string, fn: () => void) => {
			const b = bar.createEl("button", { cls: "storyloom-card-btn", text: label });
			b.addEventListener("mousedown", (ev) => ev.preventDefault());
			b.addEventListener("click", (ev) => {
				ev.stopPropagation();
				fn();
			});
		};
		if (h.openNote) button("Open note", () => h.openNote?.(e));
		if (h.addTimeline) button("Add timeline entry", () => h.addTimeline?.(e));
	}
	return block;
}
