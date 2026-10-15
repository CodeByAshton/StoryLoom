import { debounce, ItemView, setIcon, TFile, type WorkspaceLeaf } from "obsidian";
import { stripFrontmatter } from "../codex/parse";
import type { Entity } from "../codex/types";
import type StoryloomPlugin from "../main";
import { renderEntityCard } from "./card";
import { proseHash } from "../util";

export const CAST_VIEW = "storyloom-cast";

export class CastView extends ItemView {
	private othersOpen = false;
	private renderSeq = 0;
	refresh = debounce(() => void this.render(), 250, true);

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: StoryloomPlugin,
	) {
		super(leaf);
	}

	getViewType() {
		return CAST_VIEW;
	}
	getDisplayText() {
		return "Cast";
	}
	getIcon() {
		return "users";
	}

	async onOpen() {
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.refresh()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.refresh()));
		this.registerEvent(
			this.app.vault.on("modify", (f) => {
				if (f.path === this.plugin.activeMarkdownFile()?.path) this.refresh();
			}),
		);
		await this.render();
	}

	private async render() {
		const seq = ++this.renderSeq;
		const file = this.plugin.activeMarkdownFile();
		const index = this.plugin.index;
		const chapter = index.chapterForPath(file?.path);
		const asOf = chapter?.chapter ?? Infinity;

		let mentioned: Entity[] = [];
		let stale = false;
		if (file instanceof TFile && file.extension === "md") {
			const raw = await this.app.vault.cachedRead(file);
			const synced = this.plugin.settings.stateSynced[file.path];
			stale = !!chapter && !!synced && synced !== proseHash(raw);
			const text = stripFrontmatter(raw);
			const names = index.mentionsIn(text);
			if (chapter?.pov) {
				const pov = index.getEntity(chapter.pov);
				if (pov) names.add(pov.name);
			}
			mentioned = index.sortedEntities().filter((e) => names.has(e.name) && e.path !== file.path);
		}
		if (seq !== this.renderSeq) return;

		const root = this.contentEl;
		root.empty();
		root.addClass("storyloom-cast");

		const header = root.createDiv({ cls: "storyloom-cast-header" });
		header.createDiv({ cls: "storyloom-cast-title", text: chapter ? `Chapter ${chapter.chapter} — ${chapter.title}` : "Latest" });
		if (!chapter) header.createDiv({ cls: "storyloom-muted", text: "Open a chapter to see everyone as of that point in the story." });

		if (chapter && file) {
			if (stale) {
				const note = root.createDiv({ cls: "storyloom-stale" });
				setIcon(note.createSpan({ cls: "storyloom-btn-icon" }), "circle-dot");
				note.createSpan({ text: "Edited since the last story-state update" });
			}
			const actions = root.createDiv({ cls: "storyloom-cast-actions" });
			this.button(actions, "Update story state", "refresh-cw", () => void this.plugin.updateStoryState(file), stale);
			this.button(actions, "Summarize chapter", "align-left", () => void this.plugin.summarize(file));
		}

		const handlers = {
			openNote: (e: Entity) => void this.app.workspace.openLinkText(e.path, file?.path ?? "", false),
			openLink: (t: string) => void this.app.workspace.openLinkText(t, file?.path ?? "", false),
			addTimeline: (e: Entity) => this.plugin.addTimelineEntry(e, asOf),
		};

		if (!index.entities.size) {
			root.createDiv({ cls: "storyloom-empty", text: `No codex entries yet. Add notes with \`type: character\` (or location, lore) under ${this.plugin.settings.codexFolder}/.` });
			return;
		}

		const inSection = root.createDiv({ cls: "storyloom-cast-section" });
		inSection.createDiv({ cls: "storyloom-section-title", text: chapter ? "In this chapter" : "In this note" });
		if (mentioned.length) {
			for (const e of mentioned) renderEntityCard(inSection, e, asOf, { compact: true, handlers });
		} else {
			inSection.createDiv({ cls: "storyloom-muted", text: "Nobody from the codex is mentioned here yet." });
		}

		const others = index.sortedEntities().filter((e) => !mentioned.includes(e));
		if (others.length) {
			const details = root.createEl("details", { cls: "storyloom-cast-section" });
			details.open = this.othersOpen;
			details.addEventListener("toggle", () => (this.othersOpen = details.open));
			details.createEl("summary", { cls: "storyloom-section-title", text: `Everyone else (${others.length})` });
			for (const e of others) renderEntityCard(details, e, asOf, { compact: true, handlers });
		}
	}

	private button(parent: HTMLElement, label: string, icon: string, onClick: () => void, cta = false) {
		const b = parent.createEl("button", { cls: cta ? "mod-cta" : "" });
		setIcon(b.createSpan({ cls: "storyloom-btn-icon" }), icon);
		b.createSpan({ text: label });
		b.addEventListener("click", onClick);
	}
}
