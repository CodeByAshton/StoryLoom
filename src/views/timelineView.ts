import { debounce, ItemView, type WorkspaceLeaf } from "obsidian";
import { linksToTargets, stripFrontmatter, stripWikilinks } from "../codex/parse";
import { resolveState } from "../codex/state";
import type { ChapterInfo, Entity } from "../codex/types";
import { wordCount } from "../util";
import type StoryloomPlugin from "../main";

export const TIMELINE_VIEW = "storyloom-timeline";

type Mode = "characters" | "locations";

/** Who is where, per chapter. Rows are characters (or locations), columns are chapters. */
export class TimelineView extends ItemView {
	private mode: Mode = "characters";
	private seq = 0;
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
		this.registerEvent(this.app.vault.on("modify", () => this.refresh()));
		await this.render();
	}

	private async render() {
		const seq = ++this.seq;
		const index = this.plugin.index;
		const chapters = index.chapters;
		const mentions = new Map<string, Set<string>>();
		const words = new Map<string, number>();
		for (const c of chapters) {
			const f = index.fileFor(c.path);
			const text = f ? await this.app.vault.cachedRead(f) : "";
			mentions.set(c.path, index.mentionsIn(stripFrontmatter(text)));
			words.set(c.path, wordCount(text));
		}
		if (seq !== this.seq) return;

		const root = this.contentEl;
		root.empty();
		root.addClass("storyloom-timeline");

		const total = Array.from(words.values()).reduce((a, b) => a + b, 0);
		const head = root.createDiv({ cls: "storyloom-view-toolbar" });
		head.createDiv({ cls: "storyloom-view-title", text: "Story timeline" });
		head.createDiv({ cls: "storyloom-muted", text: `${chapters.length} chapters · ${total.toLocaleString()} words` });
		const toggle = head.createDiv({ cls: "storyloom-segmented" });
		for (const m of ["characters", "locations"] as Mode[]) {
			const b = toggle.createEl("button", { text: m === "characters" ? "Characters" : "Locations", cls: m === this.mode ? "is-active" : "" });
			b.addEventListener("click", () => {
				this.mode = m;
				void this.render();
			});
		}

		if (!chapters.length) {
			root.createDiv({ cls: "storyloom-empty", text: "No chapters yet. Chapter notes need `type: chapter` and `chapter: N` in their frontmatter." });
			return;
		}

		const rows = index.sortedEntities().filter((e) => e.type === (this.mode === "characters" ? "character" : "location"));
		const wrap = root.createDiv({ cls: "storyloom-grid-wrap" });
		const table = wrap.createEl("table", { cls: "storyloom-grid" });
		const thead = table.createEl("thead").createEl("tr");
		thead.createEl("th", { cls: "storyloom-grid-corner", text: this.mode === "characters" ? "Character" : "Location" });
		for (const c of chapters) {
			const th = thead.createEl("th", { cls: "storyloom-grid-col" });
			th.createDiv({ cls: "storyloom-grid-ch", text: `Ch ${c.chapter}` });
			th.createDiv({ cls: "storyloom-grid-title", text: c.title });
			th.createDiv({ cls: "storyloom-grid-words", text: `${(words.get(c.path) ?? 0).toLocaleString()} w` });
			th.addEventListener("click", () => this.openChapter(c));
		}
		const tbody = table.createEl("tbody");
		const characters = index.sortedEntities().filter((e) => e.type === "character");

		for (const e of rows) {
			const tr = tbody.createEl("tr");
			const th = tr.createEl("th", { cls: `storyloom-grid-row storyloom-type-${e.type}` });
			th.createSpan({ cls: "storyloom-dot-type" });
			th.createSpan({ text: e.name });
			th.addEventListener("click", () => void this.app.workspace.openLinkText(e.path, "", false));
			for (const c of chapters) {
				const td = tr.createEl("td", { cls: "storyloom-grid-cell" });
				td.addEventListener("click", () => this.openChapter(c));
				const mentioned = mentions.get(c.path)?.has(e.name) ?? false;
				if (this.mode === "characters") this.characterCell(td, e, c, mentioned);
				else this.locationCell(td, e, c, characters, mentioned);
			}
		}
		if (!rows.length) root.createDiv({ cls: "storyloom-empty", text: `No ${this.mode} in the codex yet.` });
	}

	private characterCell(td: HTMLElement, e: Entity, c: ChapterInfo, mentioned: boolean) {
		const s = resolveState(e, c.chapter);
		const loc = s.fields.location;
		const changedLoc = s.lastChangedIn.location === c.chapter;
		if (loc) td.createDiv({ cls: `storyloom-cell-loc${changedLoc ? " is-changed" : ""}`, text: stripWikilinks(loc) });
		if (s.lastChangedIn.status === c.chapter && s.fields.status) td.createSpan({ cls: "storyloom-badge", text: stripWikilinks(s.fields.status) });
		if (mentioned) this.mentionDot(td);
		td.setAttr("title", this.tooltip(e, c, s.fields));
	}

	private locationCell(td: HTMLElement, place: Entity, c: ChapterInfo, characters: Entity[], mentioned: boolean) {
		const names = new Set([place.name, ...place.aliases].map((n) => n.toLowerCase()));
		const here = characters.filter((ch) => {
			const loc = resolveState(ch, c.chapter).fields.location;
			return loc && names.has(linksToTargets(loc).trim().toLowerCase());
		});
		if (here.length) td.createDiv({ cls: "storyloom-cell-loc", text: here.map((h) => h.name.split(" ")[0]).join(", ") });
		const s = resolveState(place, c.chapter);
		if (s.lastChangedIn.status === c.chapter && s.fields.status) td.createSpan({ cls: "storyloom-badge", text: stripWikilinks(s.fields.status) });
		if (mentioned) this.mentionDot(td);
		td.setAttr("title", `${place.name} — chapter ${c.chapter}\n${here.length ? "Here: " + here.map((h) => h.name).join(", ") : "Nobody recorded here"}`);
	}

	private mentionDot(td: HTMLElement) {
		const d = td.createSpan({ cls: "storyloom-mention-dot" });
		d.setAttr("aria-label", "Mentioned in this chapter");
	}

	private tooltip(e: Entity, c: ChapterInfo, fields: Record<string, string>) {
		const lines = [`${e.name} — chapter ${c.chapter}`];
		for (const [k, v] of Object.entries(fields)) lines.push(`${k}: ${stripWikilinks(v)}`);
		return lines.join("\n");
	}

	private openChapter(c: ChapterInfo) {
		const f = this.plugin.index.fileFor(c.path);
		if (f) void this.app.workspace.getLeaf(false).openFile(f);
	}
}
