import type { EditorView } from "@codemirror/view";
import { debounce, Editor, MarkdownView, Menu, Notice, setIcon, normalizePath, Platform, Plugin, requestUrl, Scope, TFile, type MarkdownFileInfo, type Modifier, type WorkspaceLeaf } from "obsidian";
import { AIService } from "./ai";
import { applyChanges, createEntities, ensureFolder, readTemplate, removeSyncedLines } from "./codex/apply";
import { CodexIndex } from "./codex/index";
import { parseRelationships, parseTimeline, stripFrontmatter } from "./codex/parse";
import { fillEntityTemplate, revertSynced, safeFileName, TYPE_FOLDERS, type SyncedLine } from "./codex/write";
import type { Entity } from "./codex/types";
import {
	BRAINSTORM_TOPICS,
	brainstormPrompt,
	cleanProse,
	continuePrompt,
	continuityPrompt,
	critiquePrompt,
	describePrompt,
	expandPrompt,
	extractEntitiesPrompt,
	parseSenses,
	parseVersions,
	REWRITE_PRESETS,
	rewritePrompt,
	STATE_SCHEMA,
	stateUpdatePrompt,
	summarizePrompt,
	writingNotesPrompt,
} from "./context/prompts";
import { entityHighlighter, frontmatterEnd, refreshEntities } from "./editor/highlight";
import { entityHover } from "./editor/hover";
import { InlineEditController, inlineEditExtension } from "./editor/inlineEdit";
import { refreshNotes, writingNotesExtension } from "./editor/writingNotes";
import { locateNotes, reliableNotes, validateWritingNotes, WRITING_NOTES_SCHEMA, type LocatedNote, type WritingNote } from "./notes/model";
import { createClient } from "./llm/client";
import type { ClaudeCodeHost } from "./llm/claudeCode";
import { createClaudeCodeHost } from "./llm/claudeCodeNode";
import { validateContinuity, validateEntityList, validateStateUpdate } from "./llm/json";
import { friendlyError, type HttpFn, type LLMClient } from "./llm/types";
import { EntityReviewModal } from "./modals/entityReviewModal";
import { ChoiceModal, ConfirmModal, InstructionModal } from "./modals/instructionModal";
import { ReportModal } from "./modals/reportModal";
import { ResultModal } from "./modals/resultModal";
import { approvedFrom, buildReviewRows, StateReviewModal } from "./modals/stateReviewModal";
import { TimelineEntryModal } from "./modals/timelineEntryModal";
import { SetupModal } from "./modals/setupModal";
import { DEFAULT_SETTINGS, MotifSettingTab, type MotifSettings } from "./settings";
import { CAST_VIEW, CastView } from "./views/castView";
import { CHAT_VIEW, ChatView } from "./views/chatView";
import { CODEX_VIEW, CodexView } from "./views/codexView";
import { CHAPTERS_VIEW, ChaptersView } from "./views/chaptersView";
import { plural } from "./views/nav";
import { remapLine, remapNote, renumberedBasename, reorderMapping, type ChapterStatus } from "./views/chaptersModel";
import { GRAPH_VIEW, GraphView } from "./views/graphView";
import { TIMELINE_VIEW, TimelineView } from "./views/timelineView";
import { proseHash, wordCount } from "./util";
import { isSettingsError, openSettings } from "./ui";

const http: HttpFn = async (req) => {
	const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, contentType: "application/json", throw: false });
	return { status: res.status, text: res.text };
};

export const SAMPLE_FLAG = "motif_sample";

const VIEWS: { type: string; name: string; icon: string; where: "tab" | "right" }[] = [
	{ type: CHAPTERS_VIEW, name: "Chapters", icon: "layout-grid", where: "tab" },
	{ type: CODEX_VIEW, name: "Codex", icon: "library", where: "tab" },
	{ type: TIMELINE_VIEW, name: "Timeline", icon: "table", where: "tab" },
	{ type: GRAPH_VIEW, name: "Graph", icon: "network", where: "tab" },
	{ type: CAST_VIEW, name: "Cast", icon: "users", where: "right" },
	{ type: CHAT_VIEW, name: "Story assistant", icon: "message-circle", where: "right" },
];

export default class MotifPlugin extends Plugin {
	settings!: MotifSettings;
	index!: CodexIndex;
	ai!: AIService;
	inline!: InlineEditController;
	/** Lazily created: loads Node modules, desktop only. */
	claudeHost: ClaudeCodeHost | null | undefined;
	private explorerObservers = new Map<HTMLElement, MutationObserver>();

	async onload() {
		await this.loadSettings();
		this.index = new CodexIndex(this.app, () => this.settings);
		this.ai = new AIService(this.app, this.index, () => this.settings, () => this.llm());
		this.inline = new InlineEditController(this);
		this.applyColors();
		this.applyCodexFolderVisibility();

		this.registerView(CAST_VIEW, (leaf) => new CastView(leaf, this));
		this.registerView(GRAPH_VIEW, (leaf) => new GraphView(leaf, this));
		this.registerView(TIMELINE_VIEW, (leaf) => new TimelineView(leaf, this));
		this.registerView(CHAT_VIEW, (leaf) => new ChatView(leaf, this));
		this.registerView(CODEX_VIEW, (leaf) => new CodexView(leaf, this));
		this.registerView(CHAPTERS_VIEW, (leaf) => new ChaptersView(leaf, this));

		this.registerEditorExtension([entityHighlighter(this), entityHover(this), inlineEditExtension(this, this.inline), writingNotesExtension(this)]);

		if (this.settings.separateRibbonButtons) {
			for (const v of VIEWS) this.addRibbonIcon(v.icon, `Motif: ${v.name}`, () => void this.openView(v.type, v.where));
		} else {
			this.addRibbonIcon("feather", "Motif", (ev) => this.motifMenu().showAtMouseEvent(ev));
		}
		// Sync is the one action you take after every chapter, so it gets its own button in the sidebar.
		this.addRibbonIcon("refresh-cw", "Motif: Sync chapter", () => void this.syncActiveChapter());
		this.setupStatusBar();
		this.setupHeaderSync();

		this.addSettingTab(new MotifSettingTab(this.app, this));
		this.registerInlineEditKey();
		this.registerCommands();
		this.registerEditorMenu();

		this.index.on("changed", () => this.onIndexChanged());
		this.registerEvent(this.app.vault.on("rename", (f, old) => void this.onRename(f.path, old)));
		this.registerEvent(this.app.vault.on("delete", (f) => void this.onDelete(f.path)));
		this.registerEvent(this.app.workspace.on("file-open", (f) => void this.onFileOpen(f)));
		this.registerEvent(this.app.workspace.on("window-open", (win) => this.applyColors(win.doc.body)));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.applyCodexFolderVisibility()));
		this.app.workspace.onLayoutReady(async () => {
			this.applyCodexFolderVisibility();
			await this.index.load((ref) => this.registerEvent(ref));
			if (!this.settings.onboarded) this.openSetup();
			// On a cold start the metadata cache may still be filling; rebuild once it has resolved.
			const ref = this.app.metadataCache.on("resolved", () => {
				this.app.metadataCache.offref(ref);
				void this.index.rebuild();
			});
			this.registerEvent(ref);
		});
	}

	onunload() {
		for (const [root, observer] of this.explorerObservers) {
			observer.disconnect();
			root.querySelectorAll(".sl-hidden-folder").forEach((el) => el.removeClass("sl-hidden-folder"));
		}
		this.explorerObservers.clear();
		for (const b of [document.body, ...this.popoutBodies()]) {
			for (const type of Object.keys(this.settings.entityColors)) b.style.removeProperty(`--storyloom-${type}`);
			b.style.removeProperty("--sl-scale");
			b.removeClass("sl-red-spelling");
		}
	}

	/**
	 * Obsidian's own hotkeys (Mod+K is "Insert Markdown link") run before CodeMirror keymaps,
	 * so the inline-edit key is claimed through a keymap scope, and only while an editor has focus.
	 */
	private registerInlineEditKey() {
		const parsed = parseKey(this.settings.inlineEditKey);
		if (!parsed) return;
		const scope = new Scope(this.app.scope);
		scope.register(parsed.modifiers, parsed.key, () => {
			const editor = this.app.workspace.activeEditor?.editor;
			const cm = editor ? cmOf(editor) : null;
			if (!cm || !cm.hasFocus) return true;
			this.inline.open(cm);
			return false;
		});
		this.app.keymap.pushScope(scope);
		this.register(() => this.app.keymap.popScope(scope));
	}

	/** Everything Motif opens, in one menu: the ribbon button, and the status bar's "More". */
	motifMenu(): Menu {
		const menu = new Menu();
		for (const v of VIEWS) menu.addItem((i) => i.setTitle(v.name).setIcon(v.icon).onClick(() => void this.openView(v.type, v.where)));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("New chapter").setIcon("file-plus").onClick(() => void this.newChapter()));
		menu.addItem((i) => i.setTitle("New character").setIcon("user-plus").onClick(() => void this.newEntity("character")));
		menu.addItem((i) => i.setTitle("New location").setIcon("map-pin").onClick(() => void this.newEntity("location")));
		menu.addItem((i) => i.setTitle("New lore entry").setIcon("scroll-text").onClick(() => void this.newEntity("lore")));
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("AI review").setIcon("spell-check").setChecked(this.settings.writingNotes).onClick(() => void this.setAiReview(!this.settings.writingNotes)));
		menu.addItem((i) => i.setTitle("Setup guide").setIcon("sparkles").onClick(() => this.openSetup()));
		menu.addItem((i) => i.setTitle("Settings").setIcon("settings").onClick(() => openSettings(this.app)));
		return menu;
	}

	/** Sync the chapter you're working in (from the ribbon or a note's header). */
	async syncActiveChapter() {
		const file = this.activeMarkdownFile();
		if (!file || !this.index.chapterForPath(file.path)) return new Notice("Motif: open a chapter to sync it.");
		await this.updateStoryState(file);
	}

	// ---------- Sync button in chapter headers ----------

	private headerButtons = new WeakMap<MarkdownView, HTMLElement>();
	private reviewButtons = new WeakMap<MarkdownView, HTMLElement>();

	private setupHeaderSync() {
		const refresh = () => {
			for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
				const view = leaf.view as MarkdownView;
				const isChapter = !!this.index.chapterForPath(view.file?.path);
				const existing = this.headerButtons.get(view);
				if (isChapter && !existing) {
					const el = view.addAction("refresh-cw", "Sync chapter", () => {
						if (view.file) void this.updateStoryState(view.file);
					});
					el.addClass("sl-header-sync");
					this.headerButtons.set(view, el);
				} else if (!isChapter && existing) {
					existing.remove();
					this.headerButtons.delete(view);
				}
				const review = this.reviewButtons.get(view);
				if (isChapter && !review) {
					const el = view.addAction("spell-check", "AI review", () => void this.setAiReview(!this.settings.writingNotes));
					el.addClass("sl-header-review");
					this.reviewButtons.set(view, el);
				} else if (!isChapter && review) {
					review.remove();
					this.reviewButtons.delete(view);
				}
				const r = this.reviewButtons.get(view);
				if (r) {
					r.toggleClass("sl-on", this.settings.writingNotes);
					r.setAttr("aria-label", this.settings.writingNotes ? "AI review is on: each chapter is proofread when you sync it. Click to turn off." : "AI review is off. Click to turn on.");
				}
				this.headerButtons.get(view)?.toggleClass("is-stale", isChapter && this.isStale(view.file?.path));
			}
		};
		this.refreshHeaderSync = refresh;
		this.registerEvent(this.app.workspace.on("layout-change", refresh));
		this.registerEvent(this.app.workspace.on("file-open", refresh));
		this.app.workspace.onLayoutReady(refresh);
		this.register(() =>
			this.app.workspace.iterateAllLeaves((leaf) => leaf.view.containerEl.querySelectorAll(".sl-header-sync, .sl-header-review").forEach((el) => el.remove())),
		);
	}
	private refreshHeaderSync: () => void = () => {};

	/** Edited since its last sync (by the cached prose hash; the status bar keeps it fresh while typing). */
	private staleCache = new Map<string, boolean>();
	private isStale(path?: string): boolean {
		return !!path && !!this.staleCache.get(path);
	}

	openSetup() {
		new SetupModal(this).open();
	}

	/** A tiny request with the current settings. Resolves to the model's (trimmed) reply. */
	async testConnection(): Promise<string> {
		const out = await this.llm().complete({
			system: "",
			messages: [{ role: "user", content: "Reply with the single word: OK" }],
			maxTokens: 400,
			temperature: 0,
		});
		return out.trim().slice(0, 40);
	}

	// ---------- Status bar ----------

	private statusEl: HTMLElement | null = null;
	updateStatus = debounce(() => void this.renderStatus(), 400, true);

	private setupStatusBar() {
		const el = (this.statusEl = this.addStatusBarItem());
		el.addClass("sl-status", "mod-clickable");
		el.addEventListener("click", (ev) => this.statusMenu().showAtMouseEvent(ev));
		this.registerEvent(this.app.workspace.on("file-open", () => this.updateStatus()));
		this.registerEvent(this.app.workspace.on("editor-change", () => this.updateStatus()));
		this.registerEvent(this.app.vault.on("modify", (f) => f.path === this.activeMarkdownFile()?.path && this.updateStatus()));
		this.app.workspace.onLayoutReady(() => this.updateStatus());
	}

	private async renderStatus() {
		const el = this.statusEl;
		if (!el) return;
		const file = this.activeMarkdownFile();
		const ch = this.index.chapterForPath(file?.path);
		if (!file || !ch) {
			el.hide();
			return;
		}
		const editor = this.activeEditor();
		const text = editor && this.app.workspace.getActiveFile()?.path === file.path ? editor.getValue() : await this.app.vault.cachedRead(file);
		const synced = this.settings.stateSynced[file.path];
		const stale = !!synced && synced !== proseHash(text);
		if (this.staleCache.get(file.path) !== stale) {
			this.staleCache.set(file.path, stale);
			this.refreshHeaderSync();
		}
		if (!this.settings.statusBar) {
			el.hide();
			return;
		}
		el.empty();
		el.show();
		setIcon(el.createSpan({ cls: "sl-status-icon" }), "feather");
		const all = this.index.chapters;
		el.createSpan({ text: `Chapter ${all.indexOf(ch) + 1} of ${all.length}` });
		el.createSpan({ cls: "sl-status-title", text: ch.title });
		const notes = this.visibleNotes(file.path, text).length;
		if (notes) el.createSpan({ cls: "sl-status-notes", text: `${notes} writing note${notes === 1 ? "" : "s"}` });
		if (stale) el.createSpan({ cls: "sl-status-dot", attr: { "aria-label": "Edited since it was last synced" } });
		el.setAttr("aria-label", stale ? "Edited since it was last synced. Click for chapter actions." : "Chapter actions");
		el.setAttr("data-tooltip-position", "top");
	}

	private statusMenu(): Menu {
		const menu = new Menu();
		const file = this.activeMarkdownFile();
		if (file && this.index.chapterForPath(file.path)) {
			menu.addItem((i) => i.setTitle("Sync chapter").setIcon("refresh-cw").onClick(() => void this.updateStoryState(file)));
			menu.addItem((i) => i.setTitle("Summarize chapter").setIcon("align-left").onClick(() => void this.summarize(file)));
			menu.addItem((i) => i.setTitle("Run AI review").setIcon("spell-check").onClick(() => void this.checkWriting(file, this.activeEditor() ?? undefined)));
			if (this.notesFor(file.path).length) {
				menu.addItem((i) =>
					i.setTitle("Next writing note").setIcon("arrow-down-to-dot").onClick(() => {
						const e = this.activeEditor();
						if (e) this.nextNote(e, file);
					}),
				);
			}
			menu.addSeparator();
			menu.addItem((i) => i.setTitle("Previous chapter").setIcon("arrow-left").onClick(() => void this.stepChapter(-1)));
			menu.addItem((i) => i.setTitle("Next chapter").setIcon("arrow-right").onClick(() => void this.stepChapter(1)));
			menu.addItem((i) => i.setTitle("Show in Chapters").setIcon("layout-grid").onClick(() => void this.openView(CHAPTERS_VIEW, "tab")));
		}
		menu.addSeparator();
		menu.addItem((i) => i.setTitle("Open cast").setIcon("users").onClick(() => void this.openView(CAST_VIEW, "right")));
		return menu;
	}

	async loadSettings() {
		const data = ((await this.loadData()) ?? (await this.legacyData()) ?? {}) as Partial<MotifSettings>;
		this.settings = { ...DEFAULT_SETTINGS, ...data, entityColors: { ...DEFAULT_SETTINGS.entityColors, ...(data.entityColors ?? {}) } };
	}

	/** Settings saved under the plugin's old id (Storyloom), carried over the first time Motif loads. */
	private async legacyData(): Promise<Record<string, unknown> | null> {
		const path = normalizePath(`${this.app.vault.configDir}/plugins/storyloom/data.json`);
		try {
			if (!(await this.app.vault.adapter.exists(path))) return null;
			const data: unknown = JSON.parse(await this.app.vault.adapter.read(path));
			if (data && typeof data === "object") {
				await this.saveData(data);
				return data as Record<string, unknown>;
			}
		} catch {
			// Unreadable old settings: start fresh.
		}
		return null;
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.applyColors();
		this.applyCodexFolderVisibility();
		this.refreshEditors();
		this.updateStatus?.();
		this.notesChanged?.();
		this.refreshHeaderSync?.();
	}

	llm(): LLMClient {
		// fetch is only used for streaming; everything else goes through requestUrl (no CORS issues).
		if (this.settings.provider === "claudecode") this.claudeHost ??= Platform.isDesktopApp ? createClaudeCodeHost() : null;
		return createClient(this.settings, http, (url, init) => window.fetch(url, init), this.claudeHost);
	}

	/** Entity colours, text size and spelling colour, on the main window and any pop-out windows. */
	applyColors(body?: HTMLElement) {
		const bodies = body ? [body] : [document.body, ...this.popoutBodies()];
		for (const b of bodies) {
			for (const [type, color] of Object.entries(this.settings.entityColors)) b.style.setProperty(`--storyloom-${type}`, color);
			b.style.setProperty("--sl-scale", String({ small: 0.92, default: 1, large: 1.1 }[this.settings.textSize] ?? 1));
			b.toggleClass("sl-red-spelling", this.settings.redSpelling);
		}
	}

	private popoutBodies(): HTMLElement[] {
		const bodies = new Set<HTMLElement>();
		this.app.workspace.iterateAllLeaves((l) => {
			const b = l.view.containerEl.ownerDocument?.body;
			if (b && b !== document.body) bodies.add(b);
		});
		return [...bodies];
	}

	rememberInstruction(text: string) {
		const h = this.settings.instructionHistory.filter((x) => x !== text);
		h.unshift(text);
		this.settings.instructionHistory = h.slice(0, 20);
		void this.saveData(this.settings);
	}

	private onIndexChanged() {
		this.updateStatus();
		this.refreshHeaderSync();
		this.refreshEditors();
		for (const type of [CAST_VIEW, GRAPH_VIEW, TIMELINE_VIEW, CODEX_VIEW, CHAPTERS_VIEW]) {
			for (const leaf of this.app.workspace.getLeavesOfType(type)) (leaf.view as unknown as { refresh?: () => void }).refresh?.();
		}
	}

	refreshEditors() {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) {
				const cm = cmOf(leaf.view.editor);
				cm?.dispatch({ effects: refreshEntities.of(null) });
			}
		});
	}

	async openView(type: string, where: "tab" | "right") {
		const existing = this.app.workspace.getLeavesOfType(type)[0];
		if (existing) {
			await this.app.workspace.revealLeaf(existing);
			return existing;
		}
		const leaf: WorkspaceLeaf | null = where === "right" ? this.app.workspace.getRightLeaf(false) : this.app.workspace.getLeaf("tab");
		if (!leaf) return null;
		await leaf.setViewState({ type, active: true });
		await this.app.workspace.revealLeaf(leaf);
		return leaf;
	}

	async setChapterStatus(file: TFile, status: ChapterStatus) {
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			fm.status = status;
		});
	}

	/**
	 * Put chapters in a new order (paths, first to last). Chapter numbers are reassigned, every codex
	 * timeline line and relationship range moves with its chapter, and "NN - Title" files are renamed.
	 * Shows exactly what will change and asks first.
	 */
	async reorderChapters(order: string[]) {
		const chapters = order.map((p) => this.index.chapterForPath(p)).filter((c): c is NonNullable<typeof c> => !!c);
		if (chapters.length !== this.index.chapters.length) return new Notice("Motif: the chapter list changed; try again.");
		if (new Set(chapters.map((c) => c.chapter)).size !== chapters.length) return new Notice("Motif: two chapters share a number. Give each chapter its own number, then reorder.");
		if ([...this.running].some((k) => k.startsWith("state:"))) return new Notice("Motif: a chapter is syncing. Reorder when it's done.");
		const map = reorderMapping(chapters.map((c) => c.chapter));
		if (!map.size) return;

		const notes: { file: TFile; changed: number }[] = [];
		for (const e of this.index.entities.values()) {
			const f = this.index.fileFor(e.path);
			if (!f) continue;
			const { changed } = remapNote(await this.app.vault.cachedRead(f), map);
			if (changed) notes.push({ file: f, changed });
		}
		const moves = chapters.filter((c) => map.has(c.chapter)).map((c) => ({ c, to: map.get(c.chapter) as number }));
		const renames = moves
			.map(({ c, to }) => ({ file: this.index.fileFor(c.path), name: renumberedBasename(c.basename, to) }))
			.filter((r): r is { file: TFile; name: string } => !!r.file && !!r.name && r.name !== r.file.basename);
		const lines = notes.reduce((a, n) => a + n.changed, 0);

		const ok = await ConfirmModal.ask(this.app, {
			title: "Reorder chapters?",
			cta: "Reorder",
			body: (el) => {
				const ul = el.createEl("ul", { cls: "storyloom-file-list" });
				for (const { c, to } of moves) ul.createEl("li", { text: `“${c.title}”: chapter ${c.chapter} → ${to}` });
				el.createEl("p", {
					cls: "storyloom-muted",
					text: `Codex timelines follow their chapters: ${lines} line${lines === 1 ? "" : "s"} in ${notes.length} note${notes.length === 1 ? "" : "s"} will be renumbered.${renames.length ? ` ${renames.length} file${renames.length === 1 ? "" : "s"} will be renamed (links update automatically).` : ""}`,
				});
			},
		});
		if (!ok) return;
		await this.once("reorder", "reordering chapters", async () => {

			for (const { file } of notes) await this.app.vault.process(file, (t) => remapNote(t, map).text);
			// Lines remembered from earlier syncs were renumbered in the notes; keep the record matching.
			for (const lines of Object.values(this.settings.syncedLines))
				for (const l of lines) {
					l.line = remapLine(l.line, map);
					if (l.restore !== undefined) l.restore = remapLine(l.restore, map);
				}
			for (const { c, to } of moves) {
				const f = this.index.fileFor(c.path);
				if (f) await this.app.fileManager.processFrontMatter(f, (fm: Record<string, unknown>) => (fm.chapter = to));
			}
			let skipped = 0;
			for (const { file, name } of renames) {
				const dest = normalizePath(`${file.parent?.path ?? ""}/${name}.${file.extension}`);
				if (this.app.vault.getAbstractFileByPath(dest)) {
					skipped++;
					continue;
				}
				await this.app.fileManager.renameFile(file, dest); // the rename handler moves everything keyed by path
			}
			await this.saveData(this.settings);
			new Notice(`Motif: reordered ${moves.length} chapters and updated ${lines} codex line${lines === 1 ? "" : "s"}.${skipped ? ` ${skipped} file${skipped === 1 ? "" : "s"} kept ${skipped === 1 ? "its" : "their"} name because the new name was taken.` : ""}`);
		});
	}

	/** Open the Codex view with an entity selected. */
	async openInCodex(e: Entity) {
		const leaf = await this.openView(CODEX_VIEW, "tab");
		(leaf?.view as CodexView | undefined)?.select?.(e.name);
	}

	/**
	 * The codex lives behind its own button; optionally hide its folder from the file explorer.
	 * The explorer redraws folders as the vault changes, so each explorer is watched and re-marked.
	 */
	applyCodexFolderVisibility() {
		const hide = this.settings.hideCodexFolder;
		const roots = new Set(this.app.workspace.getLeavesOfType("file-explorer").map((l) => l.view.containerEl));
		// Stop watching explorers that were closed (or everything, when the setting is off).
		for (const [root, observer] of this.explorerObservers) {
			if (hide && roots.has(root)) continue;
			observer.disconnect();
			this.explorerObservers.delete(root);
		}
		for (const root of roots) {
			this.markCodexFolder(root);
			if (hide && !this.explorerObservers.has(root)) {
				// Runs before the next paint, so a redrawn folder row is never shown (or measured) unhidden.
				const observer = new MutationObserver(() => this.markCodexFolder(root));
				observer.observe(root, { childList: true, subtree: true });
				this.explorerObservers.set(root, observer);
			}
		}
	}

	private markCodexFolder(root: HTMLElement) {
		const folder = this.settings.hideCodexFolder ? normalizePath(this.settings.codexFolder) : null;
		root.querySelectorAll<HTMLElement>(".nav-folder-title").forEach((t) => t.parentElement?.toggleClass("sl-hidden-folder", t.dataset.path === folder));
	}

	addTimelineEntry(e: Entity, chapter: number) {
		const names = (type: string) => this.index.sortedEntities().filter((x) => x.type === type && x !== e).map((x) => x.name);
		new TimelineEntryModal(this.app, e, chapter, { locations: names("location"), characters: names("character") }).open();
	}

	/** The markdown file the user is working in (ignores focus on sidebar views). */
	activeMarkdownFile(): TFile | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view?.file) return view.file;
		const recent = this.app.workspace.getMostRecentLeaf();
		if (recent?.view instanceof MarkdownView && recent.view.file) return recent.view.file;
		return this.app.workspace.getActiveFile();
	}

	activeEditor(): Editor | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (view) return view.editor;
		const recent = this.app.workspace.getMostRecentLeaf();
		return recent?.view instanceof MarkdownView ? recent.view.editor : null;
	}

	// ---------- Commands ----------

	private registerCommands() {
		const editorCmd = (id: string, name: string, fn: (editor: Editor, file: TFile) => void | Promise<void>, needsSelection = false) =>
			this.addCommand({
				id,
				name,
				editorCheckCallback: (checking, editor, ctx) => {
					if (!ctx.file) return false;
					if (needsSelection && !editor.somethingSelected()) return false;
					if (!checking) void fn(editor, ctx.file);
					return true;
				},
			});

		editorCmd("continue-writing", "Continue writing", (e, f) => this.continueWriting(e, f));
		this.addCommand({
			id: "inline-edit",
			name: "Ask AI",
			editorCallback: (editor) => {
				const cm = cmOf(editor);
				if (cm) this.inline.open(cm);
			},
		});
		editorCmd("rewrite-selection", "Rewrite selection", (e, f) => this.rewrite(e, f), true);
		editorCmd("describe", "Describe selection", (e, f) => this.describe(e, f), true);
		editorCmd("expand", "Expand selection", (e, f) => this.expand(e, f), true);
		editorCmd("brainstorm", "Brainstorm", (e, f) => this.brainstorm(e, f));
		editorCmd("summarize-chapter", "Summarize chapter", (e, f) => this.summarize(f, e));
		editorCmd("critique-chapter", "Critique chapter", (_e, f) => this.critique(f));
		editorCmd("continuity-check", "Check continuity", (e, f) => this.continuity(f, e));
		this.addCommand({
			id: "check-writing",
			name: "Run AI review",
			editorCheckCallback: (checking, editor, ctx) => {
				const f = ctx.file;
				if (!f || !this.index.chapterForPath(f.path)) return false;
				if (!checking) void this.checkWriting(f, editor);
				return true;
			},
		});
		editorCmd("next-writing-note", "Go to next writing note", (e, f) => this.nextNote(e, f));
		this.addCommand({ id: "toggle-ai-review", name: "Turn AI review on or off", callback: () => void this.setAiReview(!this.settings.writingNotes) });
		this.addCommand({
			id: "update-story-state",
			name: "Sync chapter",
			checkCallback: (checking) => {
				const f = this.activeMarkdownFile();
				if (!f || !this.index.chapterForPath(f.path)) return false;
				if (!checking) void this.updateStoryState(f);
				return true;
			},
		});
		this.addCommand({
			id: "extract-entities",
			name: "Find new codex entries",
			checkCallback: (checking) => {
				const f = this.activeMarkdownFile();
				if (!f) return false;
				if (!checking) void this.extractEntities(f);
				return true;
			},
		});

		this.addCommand({ id: "open-setup", name: "Open setup guide", callback: () => this.openSetup() });
		this.addCommand({ id: "open-chapters", name: "Open chapters", callback: () => void this.openView(CHAPTERS_VIEW, "tab") });
		this.addCommand({ id: "open-codex", name: "Open codex", callback: () => void this.openView(CODEX_VIEW, "tab") });
		this.addCommand({ id: "open-cast", name: "Open cast", callback: () => void this.openView(CAST_VIEW, "right") });
		this.addCommand({ id: "open-graph", name: "Open graph", callback: () => void this.openView(GRAPH_VIEW, "tab") });
		this.addCommand({ id: "open-timeline", name: "Open timeline", callback: () => void this.openView(TIMELINE_VIEW, "tab") });
		this.addCommand({ id: "open-chat", name: "Open story assistant", callback: () => void this.openView(CHAT_VIEW, "right") });

		this.addCommand({ id: "new-chapter", name: "New chapter", callback: () => void this.newChapter() });
		for (const type of ["character", "location", "lore"]) {
			this.addCommand({ id: `new-${type}`, name: type === "lore" ? "New lore entry" : `New ${type}`, callback: () => void this.newEntity(type) });
		}
		this.addCommand({ id: "next-chapter", name: "Go to next chapter", callback: () => void this.stepChapter(1) });
		this.addCommand({ id: "previous-chapter", name: "Go to previous chapter", callback: () => void this.stepChapter(-1) });
		this.addCommand({ id: "word-count", name: "Show word count by chapter", callback: () => void this.showWordCounts() });
		this.addCommand({ id: "export-manuscript", name: "Export manuscript", callback: () => void this.exportManuscript() });
		this.addCommand({ id: "clear-sample-content", name: "Clear sample content", callback: () => void this.clearSample() });
		this.addCommand({ id: "rebuild-index", name: "Refresh codex", callback: () => void this.index.rebuild() });
	}

	private registerEditorMenu() {
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
				const file = info.file;
				if (!file) return;
				const sel = editor.somethingSelected();
				menu.addSeparator();
				const add = (title: string, icon: string, fn: () => void) => menu.addItem((i) => i.setTitle(title).setIcon(icon).setSection("motif").onClick(fn));
				add(sel ? "Motif: Ask AI…" : "Motif: Write here…", "sparkles", () => {
					const cm = cmOf(editor);
					if (cm) this.inline.open(cm);
				});
				add("Motif: Continue writing", "pen-line", () => void this.continueWriting(editor, file));
				if (sel) {
					add("Motif: Rewrite selection", "replace", () => void this.rewrite(editor, file));
					add("Motif: Describe selection", "eye", () => void this.describe(editor, file));
					add("Motif: Expand selection", "unfold-vertical", () => void this.expand(editor, file));
				}
				add("Motif: Brainstorm", "lightbulb", () => void this.brainstorm(editor, file));
			}),
		);
	}

	// ---------- AI tools ----------

	private ctxForEditor(editor: Editor, file: TFile, atCursor = true) {
		const text = editor.getValue();
		const cursor = atCursor ? editor.posToOffset(editor.getCursor("from")) : undefined;
		return this.ai.context({ file, text, cursor, passage: editor.getSelection() });
	}

	async continueWriting(editor: Editor, file: TFile) {
		const direction = await InstructionModal.ask(this.app, {
			title: "Continue writing",
			placeholder: "Optional direction, e.g. “she finds the ledger”",
			cta: "Write",
			optional: true,
		});
		if (direction === null) return;
		editor.setCursor(editor.getCursor("to"));
		new ResultModal(this.app, {
			title: "Continue writing",
			editor,
			run: async (extra, live) => {
				const ctx = await this.ctxForEditor(editor, file);
				const p = continuePrompt(ctx.text, this.settings.continueWords, [direction, extra].filter(Boolean).join(". "));
				return [{ text: cleanProse(await this.ai.stream(p, (t) => live(cleanProse(t)))) }];
			},
		}).open();
	}

	async rewrite(editor: Editor, file: TFile) {
		const choice = await ChoiceModal.pick(this.app, [...Object.keys(REWRITE_PRESETS), "Custom…"], "How should it be rewritten?");
		if (!choice) return;
		let instruction = REWRITE_PRESETS[choice];
		if (choice === "Custom…") {
			const custom = await InstructionModal.ask(this.app, { title: "Rewrite", placeholder: "e.g. make Arthur sound more evasive", cta: "Rewrite" });
			if (!custom) return;
			instruction = custom;
		}
		const passage = editor.getSelection();
		new ResultModal(this.app, {
			title: `Rewrite: ${choice.replace("…", "").toLowerCase()}`,
			editor,
			perItemButtons: true,
			run: async (extra) => {
				const ctx = await this.ctxForEditor(editor, file);
				const out = await this.ai.complete(rewritePrompt(ctx.text, passage, [instruction, extra].filter(Boolean).join(" ")));
				return parseVersions(out).map((t, i) => ({ label: `Version ${i + 1}`, text: cleanProse(t) }));
			},
		}).open();
	}

	async describe(editor: Editor, file: TFile) {
		const subject = editor.getSelection();
		new ResultModal(this.app, {
			title: "Describe",
			editor,
			perItemButtons: true,
			run: async (extra) => {
				const ctx = await this.ctxForEditor(editor, file);
				const p = describePrompt(ctx.text, subject);
				if (extra) p.user += `\nAlso: ${extra}`;
				return parseSenses(await this.ai.complete(p)).map((s) => ({ label: s.label, text: s.text }));
			},
		}).open();
	}

	async expand(editor: Editor, file: TFile) {
		const passage = editor.getSelection();
		new ResultModal(this.app, {
			title: "Expand",
			editor,
			run: async (extra, live) => {
				const ctx = await this.ctxForEditor(editor, file);
				const p = expandPrompt(ctx.text, passage);
				if (extra) p.user += `\nAlso: ${extra}`;
				return [{ text: cleanProse(await this.ai.stream(p, (t) => live(cleanProse(t)))) }];
			},
		}).open();
	}

	async brainstorm(editor: Editor, file: TFile) {
		const choice = await ChoiceModal.pick(this.app, [...Object.keys(BRAINSTORM_TOPICS), "Custom…"], "Brainstorm what?");
		if (!choice) return;
		let topic = BRAINSTORM_TOPICS[choice];
		if (choice === "Custom…") {
			const custom = await InstructionModal.ask(this.app, { title: "Brainstorm", placeholder: "e.g. ways Mara could get into the vault", cta: "Brainstorm" });
			if (!custom) return;
			topic = custom;
		}
		new ResultModal(this.app, {
			title: `Brainstorm — ${choice.replace("…", "")}`,
			editor,
			run: async (extra) => {
				const ctx = await this.ctxForEditor(editor, file);
				const p = brainstormPrompt(ctx.text, topic + (extra ? `. ${extra}` : ""));
				return [{ text: (await this.ai.complete(p)).trim() }];
			},
		}).open();
	}

	private async fileText(file: TFile, editor?: Editor) {
		return editor ? editor.getValue() : this.app.vault.cachedRead(file);
	}

	async summarize(file: TFile, editor?: Editor) {
		new ResultModal(this.app, {
			title: "Chapter summary",
			actions: [
				{
					label: "Save as chapter summary",
					icon: "save",
					cta: true,
					run: async (text) => {
						await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
							fm.summary = text.replace(/\s+/g, " ").trim();
						});
						new Notice("Motif: saved the summary to the chapter's properties.");
					},
				},
			],
			run: async (extra, live) => {
				const ctx = await this.ai.context({ file, text: await this.fileText(file, editor) });
				const p = summarizePrompt(ctx.text);
				if (extra) p.user += `\nAlso: ${extra}`;
				return [{ text: cleanProse(await this.ai.stream(p, (t) => live(cleanProse(t)))) }];
			},
		}).open();
	}

	async critique(file: TFile) {
		new ReportModal(this.app, {
			title: "Critique",
			sourcePath: file.path,
			run: async () => {
				const ctx = await this.ai.context({ file, text: await this.fileText(file, this.editorFor(file) ?? undefined) });
				return { markdown: (await this.ai.complete(critiquePrompt(ctx.text))).trim() };
			},
		}).open();
	}

	async continuity(file: TFile, editor?: Editor) {
		new ReportModal(this.app, {
			title: "Continuity check",
			sourcePath: file.path,
			run: async () => {
				const ctx = await this.ai.context({ file, text: await this.fileText(file, editor) });
				const issues = await this.ai.completeJson(continuityPrompt(ctx.text), validateContinuity, '{"issues": [{"quote": "", "conflict": "", "fix": "", "severity": ""}]}');
				return { issues };
			},
			onJump: (quote) => (editor ? jumpToQuote(editor, quote) : false),
		}).open();
	}

	async checkWriting(file: TFile, editor?: Editor) {
		if (!this.settings.writingNotes) {
			this.settings.writingNotes = true; // asking for a check means you want to see the notes
			await this.saveData(this.settings);
			this.refreshHeaderSync();
		}
		return this.once(`notes:${file.path}`, "checking this chapter", async () => {
			const notice = new Notice("Motif: running AI review…", 0);
			try {
				const notes = await this.proofread(file, await this.fileText(file, editor));
				notice.hide();
				new Notice(notes.length ? `Motif: ${notes.length} writing note${notes.length === 1 ? "" : "s"} underlined. Hover one to fix or dismiss it.` : "Motif: no writing notes. Nice and clean.");
			} catch (e) {
				notice.hide();
				this.errorNotice(e);
			}
		});
	}

	private editorFor(file: TFile): Editor | null {
		let found: Editor | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!found && leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) found = leaf.view.editor;
		});
		return found;
	}

	async updateStoryState(file: TFile) {
		if (this.running.has("reorder")) return void new Notice("Motif: chapters are being reordered. Sync when it's done.");
		return this.once(`state:${file.path}`, "syncing this chapter", () => this.updateStoryStateNow(file));
	}

	private async updateStoryStateNow(file: TFile) {
		const chapter = this.index.chapterForPath(file.path);
		if (!chapter) {
			new Notice("Motif: this note isn't a chapter. Give it a chapter number in its properties to sync it.");
			return;
		}
		const notice = new Notice(`Motif: syncing chapter ${chapter.chapter}…`, 0);
		try {
			const text = await this.fileText(file, this.editorFor(file) ?? undefined);
			const ctx = await this.ai.context({ file, text, asOf: chapter.chapter - 1 });
			// Proofreading runs alongside the sync; if it fails, the sync still goes through.
			let reviewError = "";
			const proofread = this.settings.writingNotes
				? this.proofread(file, text).catch((e) => {
						reviewError = friendlyError(e);
						return null;
					})
				: Promise.resolve(null);
			const [update, notes] = await Promise.all([this.ai.completeJson(stateUpdatePrompt(ctx.text, chapter.chapter), validateStateUpdate, STATE_SCHEMA), proofread]);
			notice.hide();
			// A re-sync replaces what the last sync of this chapter wrote; compare against the codex without those lines.
			const previous = this.settings.syncedLines[file.path] ?? [];
			const rows = buildReviewRows(update, await this.withoutLines(previous), chapter.chapter);
			// The codex follows the chapters: changes are written straight away (to change one, change the chapter).
			// (Nothing to review still clears what the last sync wrote, so skip the empty dialog.)
			const nothing = !rows.groups.length && !rows.rels.length && !rows.entities.length;
			const approved = this.settings.reviewStateChanges && !nothing ? await StateReviewModal.review(this.app, chapter.chapter, rows) : approvedFrom(chapter.chapter, rows);
			if (!approved) return;
			// Record what was written even if a write fails partway, so the next sync can still replace it.
			const written: SyncedLine[] = [];
			let replaced = 0;
			let removed = false;
			let res: Awaited<ReturnType<typeof applyChanges>>;
			try {
				replaced = await removeSyncedLines(this.app, previous);
				removed = true;
				res = await applyChanges(this.app, this.index, this.settings, approved, written);
			} finally {
				// If removing the old lines failed partway, keep their record so the next sync can finish the job.
				this.settings.syncedLines[file.path] = removed ? written : [...previous, ...written];
				await this.saveData(this.settings);
			}
			await this.markStateSynced(file, text);
			const parts = [
				res.lines ? `${res.lines} timeline ${res.lines === 1 ? "entry" : "entries"}` : "",
				res.rels ? `${res.rels} relationship${res.rels === 1 ? "" : "s"}` : "",
				res.created ? `${res.created} new note${res.created === 1 ? "" : "s"}` : "",
			].filter(Boolean);
			const what = parts.length ? `Recorded ${parts.join(", ")}${res.touched.length ? ` (${res.touched.join(", ")})` : ""}.` : "Nothing new to record.";
			const noteText = reviewError ? ` AI review couldn't run: ${reviewError}` : notes === null ? "" : notes.length ? ` ${notes.length} writing note${notes.length === 1 ? "" : "s"} underlined in the chapter.` : " No writing notes.";
			new Notice(`Motif: synced chapter ${chapter.chapter}. ${what}${replaced ? ` Replaced ${replaced} line${replaced === 1 ? "" : "s"} from the last sync.` : ""}${noteText}`, 8000);
		} catch (e) {
			notice.hide();
			this.errorNotice(e);
		}
	}

	// ---------- Writing notes ----------

	notesFor(path: string): WritingNote[] {
		if (!this.settings.writingNotes) return [];
		return this.settings.chapterNotes[path]?.notes ?? [];
	}

	/** Turn AI review (writing notes) on or off everywhere: underlines, sync proofreading, counts. */
	async setAiReview(on: boolean) {
		this.settings.writingNotes = on;
		await this.saveData(this.settings);
		this.notesChanged();
		this.refreshHeaderSync();
		const file = this.activeMarkdownFile();
		if (!on) {
			new Notice("Motif: AI review is off. Your writing notes are kept and come back when you turn it on.");
			return;
		}
		const unchecked = !!file && !!this.index.chapterForPath(file.path) && !this.settings.chapterNotes[file.path];
		const frag = createFragment();
		frag.createSpan({ text: "Motif: AI review is on. Chapters are proofread when you sync them." });
		if (unchecked && file) {
			const b = frag.createEl("button", { text: "Run AI review now", cls: "storyloom-notice-btn mod-cta" });
			b.addEventListener("click", () => void this.checkWriting(file, this.editorFor(file) ?? undefined));
		}
		new Notice(frag, 8000);
	}

	/** Proofread a chapter and store the notes (replacing the previous ones). */
	async proofread(file: TFile, text: string): Promise<WritingNote[]> {
		const body = stripFrontmatter(text);
		const notes = await this.ai.completeJson(writingNotesPrompt(body, await this.styleGuide()), validateWritingNotes, WRITING_NOTES_SCHEMA);
		// Keep only notes we can point at exactly: copied verbatim, found once, on word boundaries.
		const found = reliableNotes(body, notes);
		this.settings.chapterNotes[file.path] = { hash: proseHash(text), notes: found };
		await this.saveData(this.settings);
		this.notesChanged();
		return found;
	}

	async removeNote(path: string, note: WritingNote) {
		const entry = this.settings.chapterNotes[path];
		if (!entry) return;
		entry.notes = entry.notes.filter((n) => n !== note && !(n.quote === note.quote && n.message === note.message));
		if (!entry.notes.length) delete this.settings.chapterNotes[path];
		await this.saveData(this.settings);
		this.notesChanged();
	}

	private notesChanged() {
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView) cmOf(leaf.view.editor)?.dispatch({ effects: refreshNotes.of(null) });
		});
		this.app.workspace.getLeavesOfType(CAST_VIEW).forEach((l) => (l.view as CastView).refresh());
		this.updateStatus();
	}

	/** Notes that are still in the text, in order. */
	visibleNotes(path: string, text: string): LocatedNote[] {
		const start = frontmatterEnd(text);
		return locateNotes(text.slice(start), this.notesFor(path), start);
	}

	/** Move the cursor to the next writing note after it (wrapping around). */
	nextNote(editor: Editor, file: TFile) {
		const all = this.visibleNotes(file.path, editor.getValue());
		if (!all.length) {
			new Notice("Motif: no writing notes in this chapter.");
			return;
		}
		const cur = editor.posToOffset(editor.getCursor("to"));
		const n = all.find((l) => l.from > cur) ?? all[0];
		editor.setSelection(editor.offsetToPos(n.from), editor.offsetToPos(n.to));
		editor.scrollIntoView({ from: editor.offsetToPos(n.from), to: editor.offsetToPos(n.to) }, true);
		editor.focus();
	}

	/** The Book note's "## Style guide" section, so proofreading respects deliberate choices. */
	private async styleGuide(): Promise<string> {
		const f = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.bookPath));
		if (!(f instanceof TFile)) return "";
		const m = /^##\s+Style guide\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(await this.app.vault.cachedRead(f));
		return m ? m[1].trim().slice(0, 2000) : "";
	}

	/** The index's entities as they'd be with these (previously synced) lines taken out of their notes. */
	private async withoutLines(lines: SyncedLine[]): Promise<Pick<CodexIndex, "getEntity">> {
		if (!lines.length) return this.index;
		const patched = new Map<string, Entity>();
		for (const path of new Set(lines.map((l) => l.path))) {
			const e = [...this.index.entities.values()].find((x) => x.path === path);
			const f = this.index.fileFor(path);
			if (!e || !f) continue;
			const text = revertSynced(await this.app.vault.read(f), lines.filter((l) => l.path === path)).text;
			patched.set(e.name, { ...e, timeline: parseTimeline(text), relationships: parseRelationships(text) });
		}
		return { getEntity: (name: string) => { const e = this.index.getEntity(name); return e ? patched.get(e.name) ?? e : undefined; } };
	}

	/** Commands that write to the vault shouldn't run twice at once for the same chapter. */
	private running = new Set<string>();
	private async once(key: string, label: string, fn: () => Promise<void>) {
		if (this.running.has(key)) {
			new Notice(`Motif: already ${label}…`);
			return;
		}
		this.running.add(key);
		try {
			await fn();
		} finally {
			this.running.delete(key);
		}
	}

	private lastOpened: TFile | null = null;
	private reminded = new Set<string>();

	/** Leaving a chapter that changed since its last story-state update: offer to update it (once per edit). */
	private async onFileOpen(next: TFile | null) {
		const prev = this.lastOpened;
		this.lastOpened = next;
		if (!this.settings.remindStateUpdate || !prev || prev === next || !this.index.chapterForPath(prev.path)) return;
		const synced = this.settings.stateSynced[prev.path];
		if (!synced) return; // only for chapters you've started tracking
		const hash = proseHash(await this.app.vault.cachedRead(prev));
		const key = `${prev.path}:${hash}`;
		if (hash === synced || this.reminded.has(key)) return;
		this.reminded.add(key);
		const frag = createFragment();
		frag.createSpan({ text: `“${this.index.chapterForPath(prev.path)?.title}” changed since it was last synced.` });
		const b = frag.createEl("button", { text: "Sync chapter", cls: "storyloom-notice-btn mod-cta" });
		const notice = new Notice(frag, 12000);
		b.addEventListener("click", () => {
			notice.hide();
			void this.updateStoryState(prev);
		});
	}

	/**
	 * Keep everything remembered per path in step with renames (chapters, and codex notes whose
	 * synced lines we may need to replace). Links in those lines are renamed the way Obsidian renames them.
	 */
	private async onRename(path: string, old: string) {
		const s = this.settings;
		let changed = false;
		for (const map of [s.stateSynced, s.syncedLines, s.chapterNotes] as Record<string, unknown>[]) {
			if (old in map) {
				map[path] = map[old];
				delete map[old];
				changed = true;
			}
		}
		const base = (p: string) => p.split("/").pop()?.replace(/\.md$/, "") ?? p;
		const [from, to] = [base(old), base(path)];
		const relink = (line: string) => (from === to ? line : line.split(`[[${from}]]`).join(`[[${to}]]`).split(`[[${from}|`).join(`[[${to}|`));
		for (const lines of Object.values(s.syncedLines)) {
			for (const l of lines) {
				const next = { path: l.path === old ? path : l.path, line: relink(l.line), restore: l.restore === undefined ? undefined : relink(l.restore) };
				if (next.path !== l.path || next.line !== l.line || next.restore !== l.restore) {
					Object.assign(l, next);
					changed = true;
				}
			}
		}
		if (changed) await this.saveData(s);
	}

	/** A deleted chapter takes its sync status, sync record and writing notes with it (its codex lines stay). */
	private async onDelete(path: string) {
		const s = this.settings;
		if (!(path in s.stateSynced) && !(path in s.chapterNotes) && !(path in s.syncedLines)) return;
		delete s.stateSynced[path];
		delete s.syncedLines[path];
		delete s.chapterNotes[path];
		await this.saveData(s);
	}

	/** Remember the prose we just synced, so the Cast panel can tell when the chapter changes again. */
	async markStateSynced(file: TFile, text: string) {
		this.settings.stateSynced[file.path] = proseHash(text);
		await this.saveData(this.settings);
		this.app.workspace.getLeavesOfType(CAST_VIEW).forEach((l) => (l.view as CastView).refresh());
		this.updateStatus();
	}

	async extractEntities(file: TFile) {
		return this.once(`extract:${file.path}`, "looking for new names", () => this.extractEntitiesNow(file));
	}

	private async extractEntitiesNow(file: TFile) {
		const notice = new Notice("Motif: looking for new names…", 0);
		try {
			const text = await this.fileText(file, this.editorFor(file) ?? undefined);
			const ctx = await this.ai.context({ file, text });
			const known = Array.from(this.index.names.keys());
			const found = await this.ai.completeJson(extractEntitiesPrompt(ctx.text, known), validateEntityList, '{"newEntities": [{"name": "", "type": "", "description": "", "aliases": []}]}');
			notice.hide();
			const fresh = found.filter((e) => !this.index.getEntity(e.name));
			const rows = await EntityReviewModal.review(this.app, fresh);
			if (!rows?.length) return;
			await createEntities(this.app, this.index, this.settings, rows);
			new Notice(`Motif: created ${rows.length} note${rows.length === 1 ? "" : "s"}.`);
		} catch (e) {
			notice.hide();
			this.errorNotice(e);
		}
	}

	/** A notice for an AI error, with an "Open settings" button when that's where the fix is. */
	errorNotice(e: unknown) {
		const msg = friendlyError(e);
		const frag = createFragment();
		frag.createSpan({ text: `Motif: ${msg}` });
		if (isSettingsError(msg)) {
			const b = frag.createEl("button", { text: "Open settings", cls: "storyloom-notice-btn" });
			b.addEventListener("click", () => openSettings(this.app));
		}
		new Notice(frag, 10000);
	}

	// ---------- Quality of life ----------

	async newChapter() {
		const n = this.index.lastChapter + 1;
		const title = await InstructionModal.ask(this.app, { title: `New chapter ${n}`, placeholder: "Title", cta: "Create" });
		if (!title) return;
		const folder = normalizePath(this.settings.manuscriptFolder);
		await ensureFolder(this.app, folder);
		const path = normalizePath(`${folder}/${String(n).padStart(2, "0")} - ${safeFileName(title)}.md`);
		const tpl = await readTemplate(this.app, this.settings.templatesFolder, "chapter");
		const body = (tpl ?? "---\ntype: chapter\nchapter: \ntitle: \npov: \nsummary: \"\"\nstatus: draft\n---\n\n").replace(/\{\{\s*(title|name)\s*\}\}/g, title);
		const file = await this.app.vault.create(path, body);
		await this.app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
			fm.type = "chapter";
			fm.chapter = n;
			fm.title = title;
		});
		await this.app.workspace.getLeaf(false).openFile(file);
	}

	async newEntity(type: string) {
		const name = await InstructionModal.ask(this.app, { title: `New ${type}`, placeholder: "Name", cta: "Create" });
		if (!name) return;
		const folder = normalizePath(`${this.settings.codexFolder}/${TYPE_FOLDERS[type]}`);
		await ensureFolder(this.app, folder);
		const path = normalizePath(`${folder}/${safeFileName(name)}.md`);
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.workspace.getLeaf(false).openFile(existing);
			return;
		}
		const tpl = await readTemplate(this.app, this.settings.templatesFolder, type);
		const file = await this.app.vault.create(path, fillEntityTemplate(tpl, { name, type, description: "", aliases: [] }));
		await this.app.workspace.getLeaf(false).openFile(file);
	}

	async stepChapter(dir: 1 | -1) {
		const chapters = this.index.chapters;
		if (!chapters.length) return new Notice("Motif: no chapters yet.");
		const cur = this.index.chapterForPath(this.activeMarkdownFile()?.path);
		const idx = cur ? chapters.indexOf(cur) + dir : dir > 0 ? 0 : chapters.length - 1;
		const target = chapters[idx];
		if (!target) return new Notice(dir > 0 ? "This is the last chapter." : "This is the first chapter.");
		const f = this.index.fileFor(target.path);
		if (f) await this.app.workspace.getLeaf(false).openFile(f);
	}

	async chapterWordCounts() {
		const out: { chapter: number; title: string; words: number }[] = [];
		for (const c of this.index.chapters) {
			const f = this.index.fileFor(c.path);
			out.push({ chapter: c.chapter, title: c.title, words: f ? wordCount(await this.app.vault.cachedRead(f)) : 0 });
		}
		return out;
	}

	async showWordCounts() {
		const counts = await this.chapterWordCounts();
		const total = counts.reduce((a, c) => a + c.words, 0);
		await ConfirmModal.ask(this.app, {
			title: "Word count by chapter",
			cta: "Done",
			info: true,
			body: (el) => {
				const table = el.createEl("table", { cls: "storyloom-wordcount" });
				for (const c of counts) {
					const tr = table.createEl("tr");
					tr.createEl("td", { text: `${c.chapter}. ${c.title}` });
					tr.createEl("td", { text: c.words.toLocaleString(), cls: "storyloom-num" });
				}
				const tr = table.createEl("tr", { cls: "storyloom-total" });
				tr.createEl("td", { text: "Total" });
				tr.createEl("td", { text: total.toLocaleString(), cls: "storyloom-num" });
			},
		});
	}

	async exportManuscript() {
		const parts: string[] = [];
		const book = this.app.vault.getAbstractFileByPath(normalizePath(this.settings.bookPath));
		let bookTitle = "Manuscript";
		if (book instanceof TFile) {
			const fm = this.app.metadataCache.getFileCache(book)?.frontmatter;
			if (typeof fm?.title === "string") bookTitle = fm.title;
		}
		parts.push(`# ${bookTitle}`);
		for (const c of this.index.chapters) {
			const f = this.index.fileFor(c.path);
			if (!f) continue;
			const body = stripFrontmatter(await this.app.vault.read(f)).trim();
			parts.push(`## Chapter ${c.chapter}: ${c.title}\n\n${body}`);
		}
		await ensureFolder(this.app, "Exports");
		const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
		const path = normalizePath(`Exports/${safeFileName(bookTitle)} ${stamp}.md`);
		const file = await this.app.vault.create(path, parts.join("\n\n") + "\n");
		new Notice(`Motif: exported ${plural(this.index.chapters.length, "chapter")} to ${path}.`);
		await this.app.workspace.getLeaf("tab").openFile(file);
	}

	async clearSample() {
		const files = this.app.vault.getMarkdownFiles().filter((f) => {
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
			return fm?.[SAMPLE_FLAG] === true || fm?.storyloom_sample === true; // (the old name, for vaults made before the rename)
		});
		if (!files.length) return new Notice("Motif: no sample content found.");
		const ok = await ConfirmModal.ask(this.app, {
			title: "Clear sample content?",
			cta: "Move to trash",
			warning: true,
			body: (el) => {
				el.createEl("p", { text: `This moves ${files.length} sample notes to the trash. Templates, Book.md, Start Here and your settings stay.` });
				const ul = el.createEl("ul", { cls: "storyloom-file-list" });
				for (const f of files) ul.createEl("li", { text: f.path });
			},
		});
		if (!ok) return;
		for (const f of files) await this.app.fileManager.trashFile(f);
		new Notice(`Motif: moved ${files.length} sample notes to the trash.`);
	}
}

/** "Mod-Shift-k" -> { modifiers: ["Mod", "Shift"], key: "k" } */
export function parseKey(spec: string): { modifiers: Modifier[]; key: string } | null {
	const parts = spec.split("-").map((p) => p.trim()).filter(Boolean);
	const key = parts.pop();
	if (!key) return null;
	const map: Record<string, Modifier> = { mod: "Mod", ctrl: "Ctrl", meta: "Meta", cmd: "Meta", shift: "Shift", alt: "Alt" };
	const modifiers = parts.map((p) => map[p.toLowerCase()]).filter(Boolean);
	return { modifiers, key: key.length === 1 ? key.toLowerCase() : key };
}

/** The CodeMirror view behind an Obsidian editor. */
export function cmOf(editor: Editor): EditorView | null {
	return (editor as unknown as { cm?: EditorView }).cm ?? null;
}

/** Select the first occurrence of a quote (whitespace-insensitive). */
export function jumpToQuote(editor: Editor, quote: string): boolean {
	const text = editor.getValue();
	const q = quote.trim().replace(/^["“”']+|["“”']+$/g, "");
	const candidates = [q, q.slice(0, 60), q.slice(0, 30)].filter((c) => c.length >= 6);
	for (const c of candidates) {
		const pattern = c
			.split(/\s+/)
			.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
			.join("\\s+");
		const m = new RegExp(pattern, "i").exec(text);
		if (m) {
			const from = editor.offsetToPos(m.index);
			const to = editor.offsetToPos(m.index + m[0].length);
			editor.setSelection(from, to);
			editor.scrollIntoView({ from, to }, true);
			editor.focus();
			return true;
		}
	}
	return false;
}
