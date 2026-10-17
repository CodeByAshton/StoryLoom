import { debounce, ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import { stripFrontmatter } from "../codex/parse";
import { resolveState } from "../codex/state";
import type { ChapterInfo, Entity } from "../codex/types";
import type StoryloomPlugin from "../main";
import { renderEmpty } from "./empty";
import { plural, renderMeta, renderNav } from "./nav";
import { wordCount } from "../util";
import { renderEntityCard } from "./card";
import { huePalette, initials, laneEvents, locationRuns, presentAt } from "./timelineModel";

export const TIMELINE_VIEW = "storyloom-timeline";

type Mode = "characters" | "locations";

const EVENT_ICONS: Record<string, string> = { status: "activity", knows: "lightbulb", note: "sticky-note" };

/**
 * Swimlanes: one lane per character (or location), one column per chapter. A character's location is a
 * coloured pill that stretches across the chapters they stay there, so moves read at a glance.
 */
export class TimelineView extends ItemView {
	private mode: Mode = "characters";
	private seq = 0;
	/** Per-chapter scan results, reused until the file's mtime (or the codex names) change. */
	private scans = new Map<string, { mtime: number; mentions: Set<string>; words: number; index: unknown }>();
	private tip!: HTMLElement;
	refresh = debounce(() => void this.render(), 300, true);

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: StoryloomPlugin,
	) {
		super(leaf);
	}

	getViewType() {
		return TIMELINE_VIEW;
	}
	getDisplayText() {
		return "Story timeline";
	}
	getIcon() {
		return "table";
	}

	async onOpen() {
		this.registerEvent(
			this.app.vault.on("modify", (f) => {
				if (this.plugin.index.chapterForPath(f.path)) this.refresh();
			}),
		);
		this.registerEvent(this.app.workspace.on("file-open", () => this.markNow()));
		await this.render();
	}

	private async scan(chapters: ChapterInfo[]) {
		const index = this.plugin.index;
		const mentions = new Map<string, Set<string>>();
		const words = new Map<string, number>();
		for (const c of chapters) {
			const f = index.fileFor(c.path);
			let scan = this.scans.get(c.path);
			if (!scan || !f || scan.mtime !== f.stat.mtime || scan.index !== index.nameRegex) {
				const text = f ? await this.app.vault.cachedRead(f) : "";
				scan = { mtime: f?.stat.mtime ?? 0, mentions: index.mentionsIn(stripFrontmatter(text)), words: wordCount(text), index: index.nameRegex };
				this.scans.set(c.path, scan);
			}
			mentions.set(c.path, scan.mentions);
			words.set(c.path, scan.words);
		}
		return { mentions, words };
	}

	private async render() {
		const seq = ++this.seq;
		const index = this.plugin.index;
		const chapters = index.chapters;
		const { mentions, words } = await this.scan(chapters);
		if (seq !== this.seq) return;

		const root = this.contentEl;
		root.empty();
		root.addClass("storyloom-timeline", "sl-tl");

		// Toolbar
		const total = Array.from(words.values()).reduce((a, b) => a + b, 0);
		const bar = root.createDiv({ cls: "sl-tl-toolbar" });
		renderNav(bar, this.leaf, this.getViewType());
		const nChars = index.sortedEntities().filter((e) => e.type === "character").length;
		renderMeta(bar, [chapters.length > 0 && plural(chapters.length, "chapter"), chapters.length > 0 && plural(total, "word"), nChars > 0 && plural(nChars, "character")]);
		const seg = bar.createDiv({ cls: "sl-tl-segmented" });
		for (const m of ["characters", "locations"] as Mode[]) {
			const b = seg.createEl("button", { cls: m === this.mode ? "is-active" : "" });
			setIcon(b.createSpan({ cls: "storyloom-btn-icon" }), m === "characters" ? "users" : "map-pin");
			b.createSpan({ text: m === "characters" ? "Characters" : "Locations" });
			b.addEventListener("click", () => {
				this.mode = m;
				void this.render();
			});
		}

		if (!chapters.length) {
			renderEmpty(root, {
				icon: "table",
				title: "Nothing on the timeline yet",
				body: "The timeline has a column per chapter and a lane per character, showing where everyone is as the story moves. Write a chapter to get started.",
				actions: [{ label: "New chapter", icon: "file-plus", cta: true, onClick: () => void this.plugin.newChapter() }],
			});
			return;
		}
		const rows = index.sortedEntities().filter((e) => e.type === (this.mode === "characters" ? "character" : "location"));
		if (!rows.length) {
			const type = this.mode === "characters" ? "character" : "location";
			renderEmpty(root, {
				icon: this.mode === "characters" ? "users" : "map-pin",
				title: `No ${this.mode} yet`,
				body: `Add a ${type} to the codex, or run “Extract new entities” on a chapter and Storyloom will suggest them.`,
				actions: [{ label: `New ${type}`, icon: "plus", cta: true, onClick: () => void this.plugin.newEntity(type) }],
			});
			return;
		}

		const scroller = root.createDiv({ cls: "sl-tl-scroller" });
		const grid = scroller.createDiv({ cls: "sl-tl-grid" });
		grid.style.gridTemplateColumns = `200px repeat(${chapters.length}, minmax(160px, 1fr))`;
		grid.style.minWidth = `${200 + chapters.length * 160}px`;
		this.tip = root.createDiv({ cls: "storyloom-hover sl-tl-tip" });
		this.tip.hide();

		// Header row
		const maxWords = Math.max(1, ...Array.from(words.values()));
		const corner = grid.createDiv({ cls: "sl-tl-corner" });
		corner.style.gridRow = "1";
		corner.setText(this.mode === "characters" ? "Character" : "Location");
		chapters.forEach((c, i) => {
			const h = grid.createDiv({ cls: "sl-tl-head", attr: { "data-col": String(i) } });
			h.style.gridColumn = String(i + 2);
			h.style.gridRow = "1";
			h.style.animationDelay = `${i * 30}ms`;
			h.createDiv({ cls: "sl-tl-head-num", text: `Chapter ${c.chapter}` });
			h.createDiv({ cls: "sl-tl-head-title", text: c.title });
			const w = words.get(c.path) ?? 0;
			const meter = h.createDiv({ cls: "sl-tl-meter" });
			meter.createDiv({ cls: "sl-tl-meter-fill" }).style.width = `${Math.max(4, (w / maxWords) * 100)}%`;
			h.createDiv({ cls: "sl-tl-head-words", text: `${w.toLocaleString()} words` });
			h.addEventListener("click", () => this.openChapter(c));
		});

		const characters = index.sortedEntities().filter((e) => e.type === "character");
		const placeHue = huePalette(index.sortedEntities().filter((e) => e.type === "location").map((e) => e.name));
		const personHue = huePalette(characters.map((e) => e.name), 25);
		const hueFor = (name: string) => {
			const ent = index.getEntity(name);
			return ent?.type === "location" ? placeHue(ent.name) : ent?.type === "character" ? personHue(ent.name) : placeHue(name);
		};
		const numbers = chapters.map((c) => c.chapter);
		rows.forEach((e, r) => {
			const row = r + 2;
			// Name
			const name = grid.createDiv({ cls: `sl-tl-name storyloom-type-${e.type}` });
			name.style.gridRow = String(row);
			const av = name.createDiv({ cls: "sl-tl-avatar", text: initials(e.name) });
			av.style.setProperty("--hue", String(hueFor(e.name)));
			const nm = name.createDiv({ cls: "sl-tl-name-text" });
			nm.createDiv({ cls: "sl-tl-name-main", text: e.name });
			if (e.role) nm.createDiv({ cls: "sl-tl-name-role", text: e.role });
			name.addEventListener("click", () => this.plugin.openInCodex(e));

			// Cells (background, hover, mentions, events)
			const cells: HTMLElement[] = chapters.map((c, i) => {
				const cell = grid.createDiv({ cls: "sl-tl-cell", attr: { "data-col": String(i) } });
				cell.style.gridColumn = String(i + 2);
				cell.style.gridRow = String(row);
				if (mentions.get(c.path)?.has(e.name)) cell.createSpan({ cls: "sl-tl-mention", attr: { "aria-label": "Mentioned in this chapter" } });
				cell.addEventListener("click", () => this.openChapter(c));
				cell.addEventListener("mouseenter", (ev) => this.showTip(e, c.chapter, ev.currentTarget as HTMLElement));
				cell.addEventListener("mouseleave", () => this.tip.hide());
				return cell;
			});

			if (this.mode === "characters") {
				for (const run of locationRuns(e, numbers)) {
					const pill = grid.createDiv({ cls: "sl-tl-pill" });
					pill.style.gridColumn = `${run.start + 2} / ${run.end + 3}`;
					pill.style.gridRow = String(row);
					pill.style.setProperty("--hue", String(hueFor(run.location)));
					pill.style.animationDelay = `${80 + r * 60 + run.start * 25}ms`;
					setIcon(pill.createSpan({ cls: "sl-tl-pill-icon" }), "map-pin");
					pill.createSpan({ cls: "sl-tl-pill-text", text: run.location });
					pill.setAttr("aria-label", `${e.name}: ${run.location}, chapters ${numbers[run.start]}–${numbers[run.end]}`);
				}
			} else {
				chapters.forEach((c, i) => {
					const here = presentAt(e, characters, c.chapter);
					if (!here.length) return;
					const stack = cells[i].createDiv({ cls: "sl-tl-faces" });
					for (const ch of here.slice(0, 5)) {
						const f = stack.createDiv({ cls: "sl-tl-avatar is-small", text: initials(ch.name), attr: { "aria-label": ch.name } });
						f.style.setProperty("--hue", String(hueFor(ch.name)));
					}
					if (here.length > 5) stack.createDiv({ cls: "sl-tl-avatar is-small is-more", text: `+${here.length - 5}` });
				});
			}

			for (const ev of laneEvents(e, numbers)) {
				if (this.mode === "locations" && ev.kind !== "status") continue;
				const wrap = cells[ev.index].querySelector(".sl-tl-events") ?? cells[ev.index].createDiv({ cls: "sl-tl-events" });
				const chip = (wrap as HTMLElement).createDiv({ cls: `sl-tl-event is-${ev.kind}`, attr: { "aria-label": ev.text } });
				setIcon(chip.createSpan({ cls: "sl-tl-event-icon" }), EVENT_ICONS[ev.kind] ?? "dot");
				if (ev.kind === "status") chip.createSpan({ text: ev.text });
			}
		});
		this.markNow();
	}

	/** Highlight the column of the chapter you're working in. */
	private markNow() {
		const ch = this.plugin.index.chapterForPath(this.plugin.activeMarkdownFile()?.path);
		const col = ch ? String(this.plugin.index.chapters.indexOf(ch)) : "";
		this.contentEl.querySelectorAll("[data-col]").forEach((el) => el.toggleClass("is-now", (el as HTMLElement).dataset.col === col));
	}

	private showTip(e: Entity, chapter: number, anchor: HTMLElement) {
		this.tip.empty();
		renderEntityCard(this.tip, e, chapter, { compact: false });
		const s = resolveState(e, chapter);
		if (!Object.keys(s.fields).length && !s.relationships.length) this.tip.querySelector(".storyloom-card-empty")?.setText(`Nothing recorded by chapter ${chapter}.`);
		this.tip.show();
		const root = this.contentEl.getBoundingClientRect();
		const a = anchor.getBoundingClientRect();
		const w = this.tip.offsetWidth;
		const h = this.tip.offsetHeight;
		let x = a.left - root.left + a.width / 2 - w / 2;
		let y = a.bottom - root.top + 8;
		x = Math.max(8, Math.min(x, root.width - w - 8));
		if (y + h > root.height - 8) y = Math.max(8, a.top - root.top - h - 8);
		this.tip.style.left = `${x}px`;
		this.tip.style.top = `${y}px`;
	}

	private openChapter(c: ChapterInfo) {
		const f = this.plugin.index.fileFor(c.path);
		if (f) void this.app.workspace.getLeaf(false).openFile(f);
	}
}

