import { setIcon } from "obsidian";
import { stripWikilinks } from "../codex/parse";
import { resolveState } from "../codex/state";
import type { Entity } from "../codex/types";
import { initials } from "./timelineModel";

/**
 * Notion-style building blocks for side panels: property rows (icon · name · value), small tags and
 * solid avatars. Flat, typographic, no boxes — the panel reads like a page, not a stack of cards.
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
		const name = row.createDiv({ cls: "sl-prop-name" });
		setIcon(name.createSpan({ cls: "sl-prop-icon" }), r.icon);
		name.createSpan({ text: r.name });
		const val = row.createDiv({ cls: "sl-prop-value" });
		r.value(val);
		if (r.title) row.setAttr("title", r.title);
	}
	return list;
}

/** A Notion select-option pill. Coloured by the nearest `--sl-color` (entity type), or neutral grey. */
export function tag(parent: HTMLElement, text: string, cls = ""): HTMLElement {
	return parent.createSpan({ cls: `sl-tag ${cls}`.trim(), text });
}

export function avatar(parent: HTMLElement, name: string, hue: number, size: "sm" | "md" | "lg" = "sm"): HTMLElement {
	const a = parent.createSpan({ cls: `sl-avatar is-${size}`, text: initials(name) });
	a.style.setProperty("--hue", String(hue));
	return a;
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
				else if (k === "status") tag(cell, v, "is-neutral");
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
			name: "Relations",
			value: (cell) => {
				cell.addClass("is-text");
				for (const r of s.relationships) {
					const line = cell.createDiv({ cls: "sl-prop-line" });
					const t = line.createSpan({ cls: "sl-prop-link", text: r.target });
					if (handlers.openLink) t.addEventListener("click", () => handlers.openLink?.(r.target));
					line.createSpan({ cls: "sl-prop-muted", text: ` ${r.label}` });
				}
			},
		});
	}
	return rows;
}

/** One entity in a side panel: avatar, name and type tag, then its state rows. */
export function renderEntityBlock(parent: HTMLElement, e: Entity, asOf: number, opts: { hue: number; handlers?: EntityRowHandlers }): HTMLElement {
	const h = opts.handlers ?? {};
	const block = parent.createDiv({ cls: `sl-ent storyloom-type-${e.type}` });
	const head = block.createDiv({ cls: "sl-ent-head" });
	avatar(head, e.name, opts.hue);
	const name = head.createSpan({ cls: "sl-ent-name", text: e.name });
	if (h.openNote) {
		name.addClass("is-link");
		name.addEventListener("click", () => h.openNote?.(e));
	}
	tag(head, e.role || cap(e.type), "is-type");
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
