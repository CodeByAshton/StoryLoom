import { debounce, ItemView, setIcon, TFile, type WorkspaceLeaf } from "obsidian";
import { stripFrontmatter } from "../codex/parse";
import type { Entity } from "../codex/types";
import type StoryloomPlugin from "../main";
import { renderEntityCard } from "./card";
import { proseHash, wordCount } from "../util";
import { renderEmpty } from "./empty";
import { huePalette } from "./timelineModel";

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
		if (file instanceof TFile && file.extension === "md") {
			const raw = await this.app.vault.cachedRead(file);
			const synced = this.plugin.settings.stateSynced[file.path];
			stale = !!chapter && !!synced && synced !== proseHash(raw);
			const text = stripFrontmatter(raw);
			words = wordCount(text);
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
		header.createDiv({ cls: "sl-cast-eyebrow", text: chapter ? `Chapter ${chapter.chapter}` : "Cast" });
		header.createDiv({ cls: "storyloom-cast-title", text: chapter ? chapter.title : "Everyone, as of the latest chapter" });
		if (chapter) header.createDiv({ cls: "sl-cast-meta", text: `${words.toLocaleString()} words · ${mentioned.length} from the codex in this chapter` });
		else header.createDiv({ cls: "sl-cast-meta", text: "Open a chapter to see everyone as of that point in the story." });

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
			renderEmpty(root, {
				icon: "users",
				title: "No cast yet",
				body: "Characters, places and lore you add to the codex show up here, with where they are and what they know as of the open chapter.",
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
		const card = (parent: HTMLElement, e: Entity) => renderEntityCard(parent, e, asOf, { compact: true, handlers, avatarHue: hue(e) });

		const inSection = root.createDiv({ cls: "storyloom-cast-section" });
		inSection.createDiv({ cls: "storyloom-section-title", text: chapter ? "In this chapter" : "In this note" });
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
			details.createEl("summary", { cls: "storyloom-section-title", text: `Everyone else (${others.length})` });
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
