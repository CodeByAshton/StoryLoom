import { debounce, ItemView, Menu, setIcon, type WorkspaceLeaf } from "obsidian";
import { stripWikilinks } from "../codex/parse";
import { resolveState, sortedTimeline } from "../codex/state";
import { ENTITY_TYPES, type Entity, type EntityType } from "../codex/types";
import type StoryloomPlugin from "../main";
import { renderEmpty } from "./empty";
import { avatar, renderProps, stateRows, tag, type PropRow } from "./props";
import { renderNav } from "./nav";
import { huePalette, initials } from "./timelineModel";

export const CODEX_VIEW = "storyloom-codex";

const TYPE_LABEL: Record<EntityType, string> = { character: "Characters", location: "Locations", lore: "Lore", item: "Items", faction: "Factions" };
const TYPE_ICON: Record<EntityType, string> = { character: "user", location: "map-pin", lore: "scroll-text", item: "gem", faction: "flag" };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The codex as its own place: searchable cards and a detail panel, instead of a folder of notes.
 * Notes stay plain Markdown in the Codex folder; this is just a better way in.
 */
export class CodexView extends ItemView {
	private query = "";
	private type: EntityType | "all" = "all";
	private selected: string | null = null;
	refresh = debounce(() => this.render(), 200, true);

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: StoryloomPlugin,
	) {
		super(leaf);
	}

	getViewType() {
		return CODEX_VIEW;
	}
	getDisplayText() {
		return "Codex";
	}
	getIcon() {
		return "library";
	}

	async onOpen() {
		this.render();
	}

	select(name: string | null) {
		this.selected = name;
		if (name) {
			const e = this.plugin.index.entities.get(name);
			if (e && this.type !== "all" && e.type !== this.type) this.type = "all";
		}
		this.render();
	}

	private filtered(): Entity[] {
		const q = this.query.trim().toLowerCase();
		return this.plugin.index.sortedEntities().filter((e) => {
			if (this.type !== "all" && e.type !== this.type) return false;
			if (!q) return true;
			return [e.name, ...e.aliases, e.role ?? "", e.description].some((t) => t.toLowerCase().includes(q));
		});
	}

	private render() {
		const root = this.contentEl;
		const keepFocus = document.activeElement?.classList.contains("sl-cx-search");
		root.empty();
		root.addClass("sl-cx");
		const all = this.plugin.index.sortedEntities();

		// Toolbar
		const bar = root.createDiv({ cls: "sl-cx-toolbar" });
		renderNav(bar, this.leaf, this.getViewType());
		const search = bar.createDiv({ cls: "sl-cx-searchbox" });
		setIcon(search.createSpan({ cls: "sl-cx-search-icon" }), "search");
		const input = search.createEl("input", { type: "search", cls: "sl-cx-search", attr: { placeholder: "Search names, aliases, descriptions…" } });
		input.value = this.query;
		input.addEventListener("input", () => {
			this.query = input.value;
			this.renderGrid(gridEl);
		});
		if (keepFocus) window.requestAnimationFrame(() => input.focus());
		const add = bar.createEl("button", { cls: "sl-cx-new mod-cta", attr: { "aria-label": "New codex entry" } });
		setIcon(add.createSpan({ cls: "storyloom-btn-icon" }), "plus");
		add.createSpan({ text: "New" });
		add.addEventListener("click", (ev) => {
			const menu = new Menu();
			for (const t of ["character", "location", "lore"] as const) {
				menu.addItem((i) => i.setTitle(`New ${t}`).setIcon(TYPE_ICON[t]).onClick(() => void this.plugin.newEntity(t)));
			}
			menu.showAtMouseEvent(ev);
		});

		const chips = root.createDiv({ cls: "sl-cx-chips" });
		const chip = (key: EntityType | "all", label: string, count: number, icon?: string) => {
			const c = chips.createEl("button", { cls: `sl-cx-chip${this.type === key ? " is-active" : ""}${key !== "all" ? ` storyloom-type-${key}` : ""}` });
			if (icon) setIcon(c.createSpan({ cls: "sl-cx-chip-icon" }), icon);
			c.createSpan({ text: label });
			c.createSpan({ cls: "sl-cx-chip-count", text: String(count) });
			c.addEventListener("click", () => {
				this.type = key;
				this.render();
			});
		};
		chip("all", "All", all.length);
		for (const t of ENTITY_TYPES) {
			const n = all.filter((e) => e.type === t).length;
			if (n || this.type === t) chip(t, TYPE_LABEL[t], n, TYPE_ICON[t]);
		}

		const body = root.createDiv({ cls: `sl-cx-body${this.selected ? " has-detail" : ""}` });
		const gridEl = body.createDiv({ cls: "sl-cx-grid" });
		this.renderGrid(gridEl);
		const sel = this.selected ? this.plugin.index.entities.get(this.selected) : undefined;
		if (sel) this.renderDetail(body.createDiv({ cls: "sl-cx-detail" }), sel);
	}

	/** Same colours as the timeline: places and people each get evenly spaced hues. */
	private hue(name: string): number {
		const all = this.plugin.index.sortedEntities();
		const ent = this.plugin.index.getEntity(name);
		const type = ent?.type ?? "location";
		const offset = type === "character" ? 25 : 205;
		return huePalette(all.filter((e) => e.type === type).map((e) => e.name), offset)(ent?.name ?? name);
	}

	private renderGrid(grid: HTMLElement) {
		grid.empty();
		const list = this.filtered();
		if (!list.length) {
			if (this.plugin.index.entities.size) {
				renderEmpty(grid, {
					icon: "search-x",
					title: "Nothing matches",
					body: "Try another search, or show every type.",
					actions: [{ label: "Clear filters", icon: "x", onClick: () => { this.query = ""; this.type = "all"; this.render(); } }],
				});
			} else {
				renderEmpty(grid, {
					icon: "library",
					title: "Your codex is empty",
					body: "The codex holds your characters, places and lore. Storyloom uses it to underline names, show who's where, and give the AI context.",
					actions: [
						{ label: "New character", icon: "user", cta: true, onClick: () => void this.plugin.newEntity("character") },
						{ label: "New location", icon: "map-pin", onClick: () => void this.plugin.newEntity("location") },
					],
				});
			}
			return;
		}
		list.forEach((e, i) => {
			const s = resolveState(e, Infinity);
			const card = grid.createDiv({ cls: `sl-cx-card storyloom-type-${e.type}${this.selected === e.name ? " is-selected" : ""}` });
			card.style.animationDelay = `${Math.min(i, 20) * 22}ms`;
			const head = card.createDiv({ cls: "sl-cx-card-head" });
			const av = head.createDiv({ cls: "sl-tl-avatar", text: initials(e.name) });
			av.style.setProperty("--hue", String(this.hue(e.name)));
			const t = head.createDiv({ cls: "sl-cx-card-title" });
			t.createDiv({ cls: "sl-cx-card-name", text: e.name });
			t.createDiv({ cls: "sl-cx-card-type", text: [cap(e.type), e.role].filter(Boolean).join(" · ") });
			if (e.aliases.length) card.createDiv({ cls: "sl-cx-card-aliases", text: `Also: ${e.aliases.join(", ")}` });
			if (e.description) card.createDiv({ cls: "sl-cx-card-desc", text: stripWikilinks(e.description) });
			const foot = card.createDiv({ cls: "sl-cx-card-foot" });
			if (s.fields.location) {
				const loc = stripWikilinks(s.fields.location);
				const p = foot.createDiv({ cls: "sl-tl-pill is-static" });
				p.style.setProperty("--hue", String(this.hue(loc)));
				setIcon(p.createSpan({ cls: "sl-tl-pill-icon" }), "map-pin");
				p.createSpan({ cls: "sl-tl-pill-text", text: loc });
			}
			if (s.fields.status) {
				const st = foot.createDiv({ cls: "sl-tl-event is-status" });
				setIcon(st.createSpan({ cls: "sl-tl-event-icon" }), "activity");
				st.createSpan({ text: stripWikilinks(s.fields.status) });
			}
			card.addEventListener("click", () => this.select(this.selected === e.name ? null : e.name));
			card.addEventListener("dblclick", () => void this.app.workspace.openLinkText(e.path, "", false));
		});
	}

	private renderDetail(el: HTMLElement, e: Entity) {
		el.addClass(`storyloom-type-${e.type}`);
		const bar = el.createDiv({ cls: "sl-peek-bar" });
		const close = bar.createEl("button", { cls: "clickable-icon sl-cx-close", attr: { "aria-label": "Close" } });
		setIcon(close, "chevrons-right");
		close.addEventListener("click", () => this.select(null));
		const open = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Open note" } });
		setIcon(open, "maximize-2");
		open.addEventListener("click", () => void this.app.workspace.openLinkText(e.path, "", false));

		const head = el.createDiv({ cls: "sl-cx-detail-head" });
		avatar(head, e.name, this.hue(e.name), "lg");
		head.createDiv({ cls: "sl-cx-detail-name", text: e.name });

		const rows: PropRow[] = [
			{ icon: "shapes", name: "Type", value: (c) => tag(c, cap(e.type), "is-type") },
			...(e.role ? [{ icon: "user-round", name: "Role", value: (c: HTMLElement) => c.setText(e.role ?? "") }] : []),
			...(e.aliases.length ? [{ icon: "at-sign", name: "Also called", value: (c: HTMLElement) => { c.addClass("is-text"); c.setText(e.aliases.join(", ")); } }] : []),
			...stateRows(e, Infinity, { openLink: (t) => { const x = this.plugin.index.getEntity(t); if (x) this.select(x.name); } }),
		];
		renderProps(el, rows);

		const actions = el.createDiv({ cls: "sl-cx-actions" });
		const act = (label: string, icon: string, fn: () => void) => {
			const b = actions.createEl("button");
			setIcon(b.createSpan({ cls: "storyloom-btn-icon" }), icon);
			b.createSpan({ text: label });
			b.addEventListener("click", fn);
		};
		act("Add timeline entry", "plus", () => this.plugin.addTimelineEntry(e, this.plugin.index.lastChapter || 1));
		act("Open note", "file-pen-line", () => void this.app.workspace.openLinkText(e.path, "", false));

		if (e.description) this.section(el, "Description").setText(stripWikilinks(e.description));
		if (e.voice) this.section(el, "Voice").setText(stripWikilinks(e.voice));

		if (e.relationships.length) {
			const rel = this.section(el, "Relationship history");
			for (const r of e.relationships) {
				const row = rel.createDiv({ cls: "sl-cx-rel" });
				const target = this.plugin.index.getEntity(r.target);
				const name = row.createSpan({ cls: `sl-cx-rel-target${target ? " is-link" : ""}`, text: r.target });
				if (target) name.addEventListener("click", () => this.select(target.name));
				row.createSpan({ cls: "sl-cx-rel-label", text: r.label });
				const range = !Number.isFinite(r.range.from) && r.range.to === Infinity ? "always" : r.range.to === Infinity ? `from ch ${r.range.from}` : `ch ${Number.isFinite(r.range.from) ? r.range.from : 1}–${r.range.to}`;
				row.createSpan({ cls: "sl-cx-rel-range", text: range });
			}
		}

		const tl = sortedTimeline(e.timeline);
		if (tl.length) {
			const sec = this.section(el, "Timeline");
			const list = sec.createDiv({ cls: "sl-cx-timeline" });
			for (const entry of tl) {
				const item = list.createDiv({ cls: "sl-cx-tl-item" });
				const ch = this.plugin.index.chapterByNumber(entry.chapter);
				const label = item.createDiv({ cls: "sl-cx-tl-ch", text: `Ch ${entry.chapter}` });
				if (ch) {
					label.addClass("is-link");
					label.setAttr("aria-label", ch.title);
					label.addEventListener("click", () => {
						const f = this.plugin.index.fileFor(ch.path);
						if (f) void this.app.workspace.getLeaf(false).openFile(f);
					});
				}
				const body = item.createDiv({ cls: "sl-cx-tl-body" });
				const chips = body.createDiv({ cls: "sl-cx-tl-fields" });
				for (const [k, v] of Object.entries(entry.fields)) {
					chips.createSpan({ cls: "sl-cx-tl-field", text: `${k}: ${v === null ? "—" : stripWikilinks(v)}` });
				}
				if (entry.note) body.createDiv({ cls: "sl-cx-tl-note", text: stripWikilinks(entry.note) });
			}
		}
	}

	private section(parent: HTMLElement, title: string): HTMLElement {
		const sec = parent.createDiv({ cls: "sl-cx-section" });
		sec.createDiv({ cls: "sl-cx-section-title", text: title });
		return sec.createDiv({ cls: "sl-cx-section-body" });
	}
}
