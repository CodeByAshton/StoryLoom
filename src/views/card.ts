import { setIcon } from "obsidian";
import { stripWikilinks } from "../codex/parse";
import { resolveState } from "../codex/state";
import type { Entity } from "../codex/types";
import { initials } from "./timelineModel";

export interface CardHandlers {
	openNote?: (e: Entity) => void;
	addTimeline?: (e: Entity) => void;
	openLink?: (target: string) => void;
}

const FIELD_LABELS: Record<string, string> = { location: "Location", with: "With", status: "Status", knows: "Knows" };
const FIELD_ORDER = ["location", "with", "status", "knows"];

/** Render an entity's state card as of `asOf` (Infinity = latest). */
export function renderEntityCard(
	parent: HTMLElement,
	e: Entity,
	asOf: number,
	opts: { compact?: boolean; handlers?: CardHandlers; chapterTitle?: (n: number) => string | undefined; avatarHue?: number } = {},
): HTMLElement {
	const s = resolveState(e, asOf);
	const card = parent.createDiv({ cls: `storyloom-card storyloom-type-${e.type}${opts.compact ? " is-compact" : ""}` });

	const head = card.createDiv({ cls: "storyloom-card-head" });
	if (opts.avatarHue !== undefined) {
		card.addClass("has-avatar");
		const av = head.createDiv({ cls: "sl-tl-avatar is-small", text: initials(e.name) });
		av.style.setProperty("--hue", String(opts.avatarHue));
		if (opts.handlers?.openNote) av.addEventListener("click", () => opts.handlers?.openNote?.(e));
	}
	const name = head.createDiv({ cls: "storyloom-card-name", text: e.name });
	if (opts.handlers?.openNote) {
		name.addClass("is-link");
		name.addEventListener("click", () => opts.handlers?.openNote?.(e));
	}
	head.createDiv({ cls: "storyloom-card-type", text: [cap(e.type), e.role].filter(Boolean).join(" · ") });

	if (!opts.compact) {
		card.createDiv({ cls: "storyloom-card-asof", text: Number.isFinite(asOf) ? `As of Chapter ${asOf}` : "Latest" });
	}

	const keys = [...FIELD_ORDER.filter((k) => k in s.fields || (k === "with" && "with" in s.lastChangedIn)), ...Object.keys(s.fields).filter((k) => !FIELD_ORDER.includes(k)).sort()];
	if (keys.length) {
		const grid = card.createDiv({ cls: "storyloom-card-fields" });
		for (const k of keys) {
			const v = k === "knows" ? s.knows.map(stripWikilinks).join("; ") : s.fields[k] !== undefined ? stripWikilinks(s.fields[k]) : "—";
			grid.createDiv({ cls: "storyloom-card-label", text: FIELD_LABELS[k] ?? cap(k) });
			const val = grid.createDiv({ cls: "storyloom-card-value" });
			val.createSpan({ text: v || "—" });
			const since = s.lastChangedIn[k];
			if (since !== undefined && k !== "knows") val.createSpan({ cls: "storyloom-since", text: `since ch ${since}` });
		}
	} else if (!opts.compact) {
		card.createDiv({ cls: "storyloom-card-empty", text: "No timeline entries yet." });
	}

	if (s.relationships.length) {
		const rel = card.createDiv({ cls: "storyloom-card-rel" });
		rel.createSpan({ cls: "storyloom-card-label", text: "Relationships" });
		const list = rel.createSpan({ cls: "storyloom-card-rel-list" });
		s.relationships.forEach((r, i) => {
			if (i) list.appendText(" · ");
			const t = list.createSpan({ cls: "storyloom-card-rel-target", text: r.target });
			if (opts.handlers?.openLink) {
				t.addClass("is-link");
				t.addEventListener("click", () => opts.handlers?.openLink?.(r.target));
			}
			list.appendText(` — ${r.label}`);
		});
	}

	if (!opts.compact) {
		if (s.notes.length) {
			const n = card.createDiv({ cls: "storyloom-card-note" });
			n.createSpan({ cls: "storyloom-card-label", text: "Latest note" });
			n.createSpan({ text: `ch ${s.notes[0].chapter}: ${stripWikilinks(s.notes[0].text)}` });
		}
		if (e.description) {
			card.createDiv({ cls: "storyloom-card-desc", text: firstLines(e.description, 2) });
		}
		if (opts.handlers?.openNote || opts.handlers?.addTimeline) {
			const bar = card.createDiv({ cls: "storyloom-card-actions" });
			if (opts.handlers.openNote) button(bar, "Open note", "file-text", () => opts.handlers?.openNote?.(e));
			if (opts.handlers.addTimeline) button(bar, "Add timeline entry", "plus", () => opts.handlers?.addTimeline?.(e));
		}
	}
	return card;
}

function button(parent: HTMLElement, label: string, icon: string, onClick: () => void) {
	const b = parent.createEl("button", { cls: "storyloom-card-btn" });
	setIcon(b.createSpan({ cls: "storyloom-btn-icon" }), icon);
	b.createSpan({ text: label });
	b.addEventListener("mousedown", (ev) => ev.preventDefault());
	b.addEventListener("click", (ev) => {
		ev.stopPropagation();
		onClick();
	});
}

function cap(s: string) {
	return s.charAt(0).toUpperCase() + s.slice(1);
}

function firstLines(s: string, n: number): string {
	const t = stripWikilinks(s).split("\n").filter((l) => l.trim()).slice(0, n).join(" ");
	return t.length > 220 ? t.slice(0, 219) + "…" : t;
}
