import { debounce, ItemView, setIcon, TFile, type WorkspaceLeaf } from "obsidian";
import { stripFrontmatter, stripWikilinks } from "../codex/parse";
import type { Entity } from "../codex/types";
import type StoryloomPlugin from "../main";
import { renderEntityBlock, renderProps, tag } from "./props";
import { proseHash, wordCount } from "../util";
import { renderEmpty } from "./empty";
import { huePalette } from "./timelineModel";
import { focusable } from "../ui";

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
		let words = 0;
		let noteCount = 0;
		let synced: string | undefined;
		if (file instanceof TFile && file.extension === "md") {
			const raw = await this.app.vault.cachedRead(file);
			synced = this.plugin.settings.stateSynced[file.path];
			stale = !!chapter && !!synced && synced !== proseHash(raw);
			const text = stripFrontmatter(raw);
			words = wordCount(text);
			noteCount = this.plugin.visibleNotes(file.path, text).length;
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
		header.createDiv({ cls: "sl-cast-eyebrow", text: chapter ? `Chapter ${chapter.chapter} of ${index.chapters.length}` : "Cast" });
		header.createDiv({ cls: "storyloom-cast-title", text: chapter ? chapter.title : "Everyone" });
		if (chapter) {
			renderProps(header, [
				{ icon: "text", name: "Words", value: (c) => c.setText(words.toLocaleString()) },
				...(chapter.pov ? [{ icon: "eye", name: "POV", value: (c: HTMLElement) => c.setText(stripWikilinks(chapter.pov ?? "")) }] : []),
				...(this.plugin.settings.writingNotes ? [{
					icon: "spell-check",
					name: "AI review",
					value: (c: HTMLElement) => {
						if (!noteCount) return void c.createSpan({ cls: "sl-prop-empty", text: this.plugin.settings.chapterNotes[file?.path ?? ""] || synced ? "None" : "Sync to check" });
						const t = focusable(tag(c, `${noteCount} to review`, "is-warn sl-clickable"));
						t.setAttr("aria-label", "Go to the next writing note");
						t.addEventListener("click", () => {
							const editor = this.plugin.activeEditor();
							if (editor && file) this.plugin.nextNote(editor, file);
						});
					},
				}] : []),
				{ icon: "refresh-cw", name: "Synced", value: (c: HTMLElement) => (stale ? tag(c, "Edited since last sync", "is-warn") : tag(c, synced ? "Up to date" : "Not synced yet", synced ? "is-ok" : "is-neutral")) },
			]);
		} else header.createDiv({ cls: "sl-cast-meta", text: "Open a chapter to see everyone as of that point in the story." });

		if (chapter && file) {
			const actions = root.createDiv({ cls: "storyloom-cast-actions" });
			this.button(actions, "Sync chapter", "refresh-cw", () => void this.plugin.updateStoryState(file), stale);
			this.button(actions, "Summarize", "align-left", () => void this.plugin.summarize(file));
		}

		const handlers = {
			openNote: (e: Entity) => void this.app.workspace.openLinkText(e.path, file?.path ?? "", false),
			openLink: (t: string) => void this.app.workspace.openLinkText(t, file?.path ?? "", false),
			addTimeline: (e: Entity) => this.plugin.addTimelineEntry(e, asOf),
		};

		if (!index.entities.size) {
			renderEmpty(root, {
				icon: "users",
				title: "No cast yet",
				body: "Characters, locations and lore you add to the codex show up here, with where they are and what they know as of the open chapter.",
				actions: [
					{ label: "New character", icon: "user", cta: true, onClick: () => void this.plugin.newEntity("character") },
					{ label: "Open codex", icon: "library", onClick: () => void this.plugin.openView("storyloom-codex", "tab") },
				],
			});
			return;
		}

		const all = index.sortedEntities();
		const palettes = new Map<string, (n: string) => number>();
		const hue = (e: Entity) => {
			if (!palettes.has(e.type)) palettes.set(e.type, huePalette(all.filter((x) => x.type === e.type).map((x) => x.name), e.type === "character" ? 25 : 205));
			return (palettes.get(e.type) as (n: string) => number)(e.name);
		};
		const card = (parent: HTMLElement, e: Entity) => renderEntityBlock(parent, e, asOf, { hue: hue(e), handlers });

		const inSection = root.createDiv({ cls: "storyloom-cast-section" });
		const t = inSection.createDiv({ cls: "storyloom-section-title", text: chapter ? "In this chapter" : "In this note" });
		if (mentioned.length) t.createSpan({ cls: "sl-count", text: String(mentioned.length) });
		if (mentioned.length) {
			for (const e of mentioned) card(inSection, e);
		} else {
			inSection.createDiv({ cls: "storyloom-muted", text: "Nobody from the codex is mentioned here yet." });
		}

		const others = index.sortedEntities().filter((e) => !mentioned.includes(e));
		if (others.length) {
			const details = root.createEl("details", { cls: "storyloom-cast-section" });
			details.open = this.othersOpen;
			details.addEventListener("toggle", () => (this.othersOpen = details.open));
			const sum = details.createEl("summary", { cls: "storyloom-section-title", text: "Everyone else" });
			sum.createSpan({ cls: "sl-count", text: String(others.length) });
			for (const e of others) card(details, e);
		}
	}

	private button(parent: HTMLElement, label: string, icon: string, onClick: () => void, cta = false) {
		const b = parent.createEl("button", { cls: cta ? "mod-cta" : "" });
		setIcon(b.createSpan({ cls: "storyloom-btn-icon" }), icon);
		b.createSpan({ text: label });
		b.addEventListener("click", onClick);
	}
}
