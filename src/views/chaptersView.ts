import { debounce, ItemView, setIcon, TFile, type WorkspaceLeaf } from "obsidian";
import { stripFrontmatter } from "../codex/parse";
import type { ChapterInfo } from "../codex/types";
import type StoryloomPlugin from "../main";
import { renderEmpty } from "./empty";
import { plural, renderMeta, renderNav } from "./nav";
import { proseHash, wordCount } from "../util";
import { normalizeStatus, STATUSES, type ChapterStatus } from "./chaptersModel";
import { huePalette, initials } from "./timelineModel";

export const CHAPTERS_VIEW = "storyloom-chapters";

type Mode = "outline" | "board";

const STATUS_LABEL: Record<ChapterStatus, string> = { draft: "Draft", revised: "Revised", final: "Final" };
const STATUS_ICON: Record<ChapterStatus, string> = { draft: "pencil", revised: "pen-line", final: "check-circle-2" };

interface Scan {
	mtime: number;
	words: number;
	cast: string[];
	hash: string;
	index: unknown;
}

/** Chapter cards: drag to reorder (outline) or to change status (board). */
export class ChaptersView extends ItemView {
	private mode: Mode = "outline";
	private scans = new Map<string, Scan>();
	private dragging: string | null = null;
	private seq = 0;
	refresh = debounce(() => void this.render(), 250, true);

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: StoryloomPlugin,
	) {
		super(leaf);
	}

	getViewType() {
		return CHAPTERS_VIEW;
	}
	getDisplayText() {
		return "Chapters";
	}
	getIcon() {
		return "layout-grid";
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

	private async scan(c: ChapterInfo): Promise<Scan> {
		const index = this.plugin.index;
		const f = index.fileFor(c.path);
		const prev = this.scans.get(c.path);
		if (prev && f && prev.mtime === f.stat.mtime && prev.index === index.nameRegex) return prev;
		const text = f ? await this.app.vault.cachedRead(f) : "";
		const mentioned = index.mentionsIn(stripFrontmatter(text));
		const cast = index.sortedEntities().filter((e) => e.type === "character" && mentioned.has(e.name)).map((e) => e.name);
		const s = { mtime: f?.stat.mtime ?? 0, words: wordCount(text), cast, hash: proseHash(text), index: index.nameRegex };
		this.scans.set(c.path, s);
		return s;
	}

	private async render() {
		const seq = ++this.seq;
		const chapters = this.plugin.index.chapters;
		const scans = new Map<string, Scan>();
		for (const c of chapters) scans.set(c.path, await this.scan(c));
		if (seq !== this.seq) return;

		const root = this.contentEl;
		root.empty();
		root.addClass("sl-ch");

		const total = [...scans.values()].reduce((a, s) => a + s.words, 0);
		const bar = root.createDiv({ cls: "sl-tl-toolbar" });
		renderNav(bar, this.leaf, this.getViewType());
		const done = chapters.filter((c) => normalizeStatus(c.status) === "final").length;
		renderMeta(bar, [chapters.length > 0 && plural(chapters.length, "chapter"), chapters.length > 0 && plural(total, "word"), done > 0 && `${done} final`]);
		const seg = bar.createDiv({ cls: "sl-tl-segmented" });
		for (const m of ["outline", "board"] as Mode[]) {
			const b = seg.createEl("button", { cls: m === this.mode ? "is-active" : "" });
			setIcon(b.createSpan({ cls: "storyloom-btn-icon" }), m === "outline" ? "list-ordered" : "columns-3");
			b.createSpan({ text: m === "outline" ? "Outline" : "Board" });
			b.addEventListener("click", () => {
				this.mode = m;
				void this.render();
			});
		}

		const body = root.createDiv({ cls: "sl-ch-body" });
		if (!chapters.length) {
			renderEmpty(body, {
				icon: "book-open",
				title: "No chapters yet",
				body: `Chapters are notes in ${this.plugin.settings.manuscriptFolder}/ with \`type: chapter\` in their frontmatter. New chapter makes one for you, numbered and ready to write.`,
				actions: [
					{ label: "New chapter", icon: "file-plus", cta: true, onClick: () => void this.plugin.newChapter() },
					{ label: "Set up my book", icon: "sparkles", onClick: () => this.plugin.openSetup() },
				],
			});
			return;
		}
		if (this.mode === "outline") this.renderOutline(body, chapters, scans);
		else this.renderBoard(body, chapters, scans);
		this.markNow();
	}

	// ---------- Outline: drag to reorder ----------

	private renderOutline(body: HTMLElement, chapters: ChapterInfo[], scans: Map<string, Scan>) {
		const hint = body.createDiv({ cls: "sl-ch-hint" });
		setIcon(hint.createSpan({ cls: "storyloom-btn-icon" }), "move");
		hint.createSpan({ text: "Drag cards to reorder. Chapter numbers and codex timelines update to match." });
		const grid = body.createDiv({ cls: "sl-ch-grid" });
		const maxWords = Math.max(1, ...[...scans.values()].map((s) => s.words));
		chapters.forEach((c, i) => {
			const card = this.card(grid, c, scans.get(c.path) as Scan, maxWords, i);
			card.addEventListener("dragover", (ev) => {
				if (!this.dragging || this.dragging === c.path) return;
				ev.preventDefault();
				if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
				const r = card.getBoundingClientRect();
				const before = ev.clientX < r.left + r.width / 2;
				card.toggleClass("is-drop-before", before);
				card.toggleClass("is-drop-after", !before);
			});
			// Both dragenter and dragover must be cancelled for the element to count as a drop target.
			card.addEventListener("dragenter", (ev) => {
				if (this.dragging && this.dragging !== c.path) ev.preventDefault();
			});
			card.addEventListener("dragleave", () => card.removeClass("is-drop-before", "is-drop-after"));
			card.addEventListener("drop", (ev) => {
				ev.preventDefault();
				const before = card.hasClass("is-drop-before");
				card.removeClass("is-drop-before", "is-drop-after");
				const from = this.dragging;
				if (!from || from === c.path) return;
				const order = chapters.map((x) => x.path).filter((p) => p !== from);
				const at = order.indexOf(c.path) + (before ? 0 : 1);
				order.splice(at, 0, from);
				void this.plugin.reorderChapters(order);
			});
		});
		const add = grid.createDiv({ cls: "sl-ch-card is-new" });
		setIcon(add.createSpan({ cls: "sl-ch-new-icon" }), "plus");
		add.createSpan({ text: "New chapter" });
		add.addEventListener("click", () => void this.plugin.newChapter());
	}

	// ---------- Board: drag between status columns ----------

	private renderBoard(body: HTMLElement, chapters: ChapterInfo[], scans: Map<string, Scan>) {
		const board = body.createDiv({ cls: "sl-ch-board" });
		const maxWords = Math.max(1, ...[...scans.values()].map((s) => s.words));
		for (const status of STATUSES) {
			const col = board.createDiv({ cls: `sl-ch-col is-${status}` });
			const items = chapters.filter((c) => normalizeStatus(c.status) === status);
			const head = col.createDiv({ cls: "sl-ch-col-head" });
			setIcon(head.createSpan({ cls: "sl-ch-col-icon" }), STATUS_ICON[status]);
			head.createSpan({ text: STATUS_LABEL[status] });
			head.createSpan({ cls: "sl-ch-col-count", text: String(items.length) });
			const words = items.reduce((a, c) => a + (scans.get(c.path)?.words ?? 0), 0);
			head.createSpan({ cls: "sl-ch-col-words", text: `${words.toLocaleString()} words` });
			const list = col.createDiv({ cls: "sl-ch-col-list" });
			items.forEach((c, i) => this.card(list, c, scans.get(c.path) as Scan, maxWords, i));
			if (!items.length) list.createDiv({ cls: "sl-ch-col-empty", text: "Drop chapters here" });
			col.addEventListener("dragover", (ev) => {
				if (!this.dragging) return;
				ev.preventDefault();
				if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
				col.addClass("is-over");
			});
			col.addEventListener("dragenter", (ev) => {
				if (this.dragging) ev.preventDefault();
			});
			col.addEventListener("dragleave", (ev) => {
				if (!col.contains(ev.relatedTarget as Node)) col.removeClass("is-over");
			});
			col.addEventListener("drop", (ev) => {
				ev.preventDefault();
				col.removeClass("is-over");
				const f = this.dragging ? this.plugin.index.fileFor(this.dragging) : null;
				if (f && normalizeStatus(this.plugin.index.chapterForPath(f.path)?.status) !== status) void this.plugin.setChapterStatus(f, status);
			});
		}
	}

	// ---------- Card ----------

	private card(parent: HTMLElement, c: ChapterInfo, s: Scan, maxWords: number, i: number): HTMLElement {
		const status = normalizeStatus(c.status);
		const card = parent.createDiv({ cls: `sl-ch-card is-${status}`, attr: { draggable: "true", "data-path": c.path } });
		card.style.animationDelay = `${Math.min(i, 20) * 28}ms`;
		card.addEventListener("dragstart", (ev) => {
			this.dragging = c.path;
			ev.dataTransfer?.setData("text/plain", c.path);
			if (ev.dataTransfer) ev.dataTransfer.effectAllowed = "move";
			window.requestAnimationFrame(() => card.addClass("is-dragging"));
		});
		card.addEventListener("dragend", () => {
			this.dragging = null;
			card.removeClass("is-dragging");
			this.contentEl.querySelectorAll(".is-drop-before, .is-drop-after, .is-over").forEach((el) => el.removeClass("is-drop-before", "is-drop-after", "is-over"));
		});

		const head = card.createDiv({ cls: "sl-ch-card-head" });
		head.createDiv({ cls: "sl-ch-num", text: String(c.chapter) });
		const t = head.createDiv({ cls: "sl-ch-card-titles" });
		t.createDiv({ cls: "sl-ch-card-title", text: c.title });
		const pill = t.createDiv({ cls: `sl-ch-status is-${status}` });
		setIcon(pill.createSpan({ cls: "sl-ch-status-icon" }), STATUS_ICON[status]);
		pill.createSpan({ text: STATUS_LABEL[status] });
		const synced = this.plugin.settings.stateSynced[c.path];
		if (synced && synced !== s.hash) head.createDiv({ cls: "sl-ch-stale", attr: { "aria-label": "Edited since the last story-state update" } });

		const characters = this.plugin.index.sortedEntities().filter((e) => e.type === "character").map((e) => e.name);
		const hue = huePalette(characters, 25);
		if (c.pov) {
			const pov = card.createDiv({ cls: "sl-ch-pov" });
			const av = pov.createDiv({ cls: "sl-tl-avatar is-small", text: initials(c.pov) });
			av.style.setProperty("--hue", String(hue(c.pov)));
			pov.createSpan({ text: `${c.pov}'s point of view` });
		}

		if (c.summary?.trim()) card.createDiv({ cls: "sl-ch-summary", text: c.summary });
		else {
			const sum = card.createEl("button", { cls: "sl-ch-summarize" });
			setIcon(sum.createSpan({ cls: "storyloom-btn-icon" }), "sparkles");
			sum.createSpan({ text: "Summarize" });
			sum.addEventListener("click", (ev) => {
				ev.stopPropagation();
				const f = this.plugin.index.fileFor(c.path);
				if (f instanceof TFile) void this.plugin.summarize(f);
			});
		}

		const foot = card.createDiv({ cls: "sl-ch-foot" });
		const cast = foot.createDiv({ cls: "sl-tl-faces" });
		for (const n of s.cast.slice(0, 5)) {
			const a = cast.createDiv({ cls: "sl-tl-avatar is-small", text: initials(n), attr: { "aria-label": n } });
			a.style.setProperty("--hue", String(hue(n)));
		}
		if (s.cast.length > 5) cast.createDiv({ cls: "sl-tl-avatar is-small is-more", text: `+${s.cast.length - 5}` });
		const w = foot.createDiv({ cls: "sl-ch-words" });
		w.createSpan({ text: `${s.words.toLocaleString()} words` });
		w.createDiv({ cls: "sl-tl-meter" }).createDiv({ cls: "sl-tl-meter-fill" }).style.width = `${Math.max(4, (s.words / maxWords) * 100)}%`;

		card.addEventListener("click", () => {
			const f = this.plugin.index.fileFor(c.path);
			if (f) void this.app.workspace.getLeaf(false).openFile(f);
		});
		return card;
	}

	private markNow() {
		const now = this.plugin.activeMarkdownFile()?.path;
		this.contentEl.querySelectorAll(".sl-ch-card[data-path]").forEach((el) => el.toggleClass("is-now", (el as HTMLElement).dataset.path === now));
	}
}
