import type { EditorView } from "@codemirror/view";
import { Editor, MarkdownView, Menu, Notice, normalizePath, Platform, Plugin, requestUrl, Scope, TFile, type MarkdownFileInfo, type Modifier, type WorkspaceLeaf } from "obsidian";
import { AIService } from "./ai";
import { applyChanges, createEntities, ensureFolder, readTemplate } from "./codex/apply";
import { CodexIndex } from "./codex/index";
import { stripFrontmatter } from "./codex/parse";
import { fillEntityTemplate, safeFileName, TYPE_FOLDERS } from "./codex/write";
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
} from "./context/prompts";
import { entityHighlighter, refreshEntities } from "./editor/highlight";
import { entityHover } from "./editor/hover";
import { InlineEditController, inlineEditExtension } from "./editor/inlineEdit";
import { createClient } from "./llm/client";
import type { ClaudeCodeHost } from "./llm/claudeCode";
import { createClaudeCodeHost } from "./llm/claudeCodeNode";
import { validateContinuity, validateEntityList, validateStateUpdate } from "./llm/json";
import { friendlyError, type HttpFn, type LLMClient } from "./llm/types";
import { EntityReviewModal } from "./modals/entityReviewModal";
import { ChoiceModal, ConfirmModal, InstructionModal } from "./modals/instructionModal";
import { ReportModal } from "./modals/reportModal";
import { ResultModal } from "./modals/resultModal";
import { buildReviewRows, StateReviewModal } from "./modals/stateReviewModal";
import { TimelineEntryModal } from "./modals/timelineEntryModal";
import { DEFAULT_SETTINGS, StoryloomSettingTab, type StoryloomSettings } from "./settings";
import { CAST_VIEW, CastView } from "./views/castView";
import { CHAT_VIEW, ChatView } from "./views/chatView";
import { GRAPH_VIEW, GraphView } from "./views/graphView";
import { TIMELINE_VIEW, TimelineView } from "./views/timelineView";
import { proseHash, wordCount } from "./util";
import { isSettingsError, openSettings } from "./ui";

const http: HttpFn = async (req) => {
	const res = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, contentType: "application/json", throw: false });
	return { status: res.status, text: res.text };
};

export const SAMPLE_FLAG = "storyloom_sample";

export default class StoryloomPlugin extends Plugin {
	settings!: StoryloomSettings;
	index!: CodexIndex;
	ai!: AIService;
	inline!: InlineEditController;
	/** Lazily created: loads Node modules, desktop only. */
	claudeHost: ClaudeCodeHost | null | undefined;

	async onload() {
		await this.loadSettings();
		this.index = new CodexIndex(this.app, () => this.settings);
		this.ai = new AIService(this.app, this.index, () => this.settings, () => this.llm());
		this.inline = new InlineEditController(this);
		this.applyColors();

		this.registerView(CAST_VIEW, (leaf) => new CastView(leaf, this));
		this.registerView(GRAPH_VIEW, (leaf) => new GraphView(leaf, this));
		this.registerView(TIMELINE_VIEW, (leaf) => new TimelineView(leaf, this));
		this.registerView(CHAT_VIEW, (leaf) => new ChatView(leaf, this));

		this.registerEditorExtension([entityHighlighter(this), entityHover(this), inlineEditExtension(this, this.inline)]);

		this.addRibbonIcon("network", "Storyloom: Story graph", () => void this.openView(GRAPH_VIEW, "tab"));
		this.addRibbonIcon("table", "Storyloom: Story timeline", () => void this.openView(TIMELINE_VIEW, "tab"));
		this.addRibbonIcon("users", "Storyloom: Cast", () => void this.openView(CAST_VIEW, "right"));
		this.addRibbonIcon("message-circle", "Storyloom: Story assistant", () => void this.openView(CHAT_VIEW, "right"));

		this.addSettingTab(new StoryloomSettingTab(this.app, this));
		this.registerInlineEditKey();
		this.registerCommands();
		this.registerEditorMenu();

		this.index.on("changed", () => this.onIndexChanged());
		this.registerEvent(this.app.workspace.on("file-open", (f) => void this.onFileOpen(f)));
		this.app.workspace.onLayoutReady(async () => {
			await this.index.load((ref) => this.registerEvent(ref));
			// On a cold start the metadata cache may still be filling; rebuild once it has resolved.
			const ref = this.app.metadataCache.on("resolved", () => {
				this.app.metadataCache.offref(ref);
				void this.index.rebuild();
			});
			this.registerEvent(ref);
		});
	}

	onunload() {
		for (const type of Object.keys(this.settings.entityColors)) document.body.style.removeProperty(`--storyloom-${type}`);
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

	async loadSettings() {
		const data = (await this.loadData()) ?? {};
		this.settings = { ...DEFAULT_SETTINGS, ...data, entityColors: { ...DEFAULT_SETTINGS.entityColors, ...(data.entityColors ?? {}) } };
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.applyColors();
		this.refreshEditors();
	}

	llm(): LLMClient {
		// fetch is only used for streaming; everything else goes through requestUrl (no CORS issues).
		if (this.settings.provider === "claudecode") this.claudeHost ??= Platform.isDesktopApp ? createClaudeCodeHost() : null;
		return createClient(this.settings, http, (url, init) => window.fetch(url, init), this.claudeHost);
	}

	applyColors() {
		for (const [type, color] of Object.entries(this.settings.entityColors)) document.body.style.setProperty(`--storyloom-${type}`, color);
	}

	rememberInstruction(text: string) {
		const h = this.settings.instructionHistory.filter((x) => x !== text);
		h.unshift(text);
		this.settings.instructionHistory = h.slice(0, 20);
		void this.saveData(this.settings);
	}

	private onIndexChanged() {
		this.refreshEditors();
		for (const type of [CAST_VIEW, GRAPH_VIEW, TIMELINE_VIEW]) {
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
			name: "Inline edit (highlight and instruct)",
			editorCallback: (editor) => {
				const cm = cmOf(editor);
				if (cm) this.inline.open(cm);
			},
		});
		editorCmd("rewrite-selection", "Rewrite selection", (e, f) => this.rewrite(e, f), true);
		editorCmd("describe", "Describe (senses)", (e, f) => this.describe(e, f), true);
		editorCmd("expand", "Expand selection", (e, f) => this.expand(e, f), true);
		editorCmd("brainstorm", "Brainstorm", (e, f) => this.brainstorm(e, f));
		editorCmd("summarize-chapter", "Summarize chapter", (e, f) => this.summarize(f, e));
		editorCmd("critique-chapter", "Critique chapter", (_e, f) => this.critique(f));
		editorCmd("continuity-check", "Continuity check", (e, f) => this.continuity(f, e));
		this.addCommand({
			id: "update-story-state",
			name: "Update story state from this chapter",
			checkCallback: (checking) => {
				const f = this.activeMarkdownFile();
				if (!f || !this.index.chapterForPath(f.path)) return false;
				if (!checking) void this.updateStoryState(f);
				return true;
			},
		});
		this.addCommand({
			id: "extract-entities",
			name: "Extract new entities",
			checkCallback: (checking) => {
				const f = this.activeMarkdownFile();
				if (!f) return false;
				if (!checking) void this.extractEntities(f);
				return true;
			},
		});

		this.addCommand({ id: "open-cast", name: "Open cast panel", callback: () => void this.openView(CAST_VIEW, "right") });
		this.addCommand({ id: "open-graph", name: "Open story graph", callback: () => void this.openView(GRAPH_VIEW, "tab") });
		this.addCommand({ id: "open-timeline", name: "Open story timeline", callback: () => void this.openView(TIMELINE_VIEW, "tab") });
		this.addCommand({ id: "open-chat", name: "Open story assistant", callback: () => void this.openView(CHAT_VIEW, "right") });

		this.addCommand({ id: "new-chapter", name: "New chapter", callback: () => void this.newChapter() });
		for (const type of ["character", "location", "lore"]) {
			this.addCommand({ id: `new-${type}`, name: `New ${type}`, callback: () => void this.newEntity(type) });
		}
		this.addCommand({ id: "next-chapter", name: "Go to next chapter", callback: () => void this.stepChapter(1) });
		this.addCommand({ id: "previous-chapter", name: "Go to previous chapter", callback: () => void this.stepChapter(-1) });
		this.addCommand({ id: "word-count", name: "Word count by chapter", callback: () => void this.showWordCounts() });
		this.addCommand({ id: "export-manuscript", name: "Export manuscript", callback: () => void this.exportManuscript() });
		this.addCommand({ id: "clear-sample-content", name: "Clear sample content", callback: () => void this.clearSample() });
		this.addCommand({ id: "rebuild-index", name: "Rebuild codex index", callback: () => void this.index.rebuild() });
	}

	private registerEditorMenu() {
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, info: MarkdownView | MarkdownFileInfo) => {
				const file = info.file;
				if (!file) return;
				const sel = editor.somethingSelected();
				menu.addSeparator();
				const add = (title: string, icon: string, fn: () => void) => menu.addItem((i) => i.setTitle(title).setIcon(icon).setSection("storyloom").onClick(fn));
				add(sel ? "Storyloom: Inline edit…" : "Storyloom: Write here…", "sparkles", () => {
					const cm = cmOf(editor);
					if (cm) this.inline.open(cm);
				});
				add("Storyloom: Continue writing", "pen-line", () => void this.continueWriting(editor, file));
				if (sel) {
					add("Storyloom: Rewrite selection", "replace", () => void this.rewrite(editor, file));
					add("Storyloom: Describe", "eye", () => void this.describe(editor, file));
					add("Storyloom: Expand", "unfold-vertical", () => void this.expand(editor, file));
				}
				add("Storyloom: Brainstorm", "lightbulb", () => void this.brainstorm(editor, file));
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
			title: `Rewrite — ${choice.replace("…", "")}`,
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
					label: "Save to summary",
					icon: "save",
					cta: true,
					run: async (text) => {
						await this.app.fileManager.processFrontMatter(file, (fm) => {
							fm.summary = text.replace(/\s+/g, " ").trim();
						});
						new Notice("Summary saved to the chapter's frontmatter.");
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

	private editorFor(file: TFile): Editor | null {
		let found: Editor | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!found && leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) found = leaf.view.editor;
		});
		return found;
	}

	async updateStoryState(file: TFile) {
		return this.once(`state:${file.path}`, "updating this chapter's story state", () => this.updateStoryStateNow(file));
	}

	private async updateStoryStateNow(file: TFile) {
		const chapter = this.index.chapterForPath(file.path);
		if (!chapter) {
			new Notice("This note isn't a chapter (it needs `chapter: N` in its frontmatter).");
			return;
		}
		const notice = new Notice(`Storyloom: reading chapter ${chapter.chapter}…`, 0);
		try {
			const text = await this.fileText(file, this.editorFor(file) ?? undefined);
			const ctx = await this.ai.context({ file, text, asOf: chapter.chapter - 1 });
			const update = await this.ai.completeJson(stateUpdatePrompt(ctx.text, chapter.chapter), validateStateUpdate, STATE_SCHEMA);
			notice.hide();
			const rows = buildReviewRows(update, this.index, chapter.chapter);
			if (!rows.groups.length && !rows.rels.length && !rows.entities.length) await this.markStateSynced(file, text);
			const approved = await StateReviewModal.review(this.app, chapter.chapter, rows);
			if (!approved) return;
			await this.markStateSynced(file, text);
			const res = await applyChanges(this.app, this.index, this.settings, approved);
			const parts = [
				res.lines ? `${res.lines} timeline ${res.lines === 1 ? "entry" : "entries"}` : "",
				res.rels ? `${res.rels} relationship${res.rels === 1 ? "" : "s"}` : "",
				res.created ? `${res.created} new note${res.created === 1 ? "" : "s"}` : "",
			].filter(Boolean);
			new Notice(parts.length ? `Storyloom: added ${parts.join(", ")}${res.touched.length ? ` (${res.touched.join(", ")})` : ""}.` : "Storyloom: nothing new to write.");
		} catch (e) {
			notice.hide();
			this.errorNotice(e);
		}
	}

	/** Commands that write to the vault shouldn't run twice at once for the same chapter. */
	private running = new Set<string>();
	private async once(key: string, label: string, fn: () => Promise<void>) {
		if (this.running.has(key)) {
			new Notice(`Storyloom: already ${label}…`);
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
		const frag = document.createDocumentFragment();
		frag.createSpan({ text: `“${this.index.chapterForPath(prev.path)?.title}” changed since its last story-state update.` });
		const b = frag.createEl("button", { text: "Update story state", cls: "storyloom-notice-btn mod-cta" });
		const notice = new Notice(frag, 12000);
		b.addEventListener("click", () => {
			notice.hide();
			void this.updateStoryState(prev);
		});
	}

	/** Remember the prose we just synced, so the Cast panel can tell when the chapter changes again. */
	async markStateSynced(file: TFile, text: string) {
		this.settings.stateSynced[file.path] = proseHash(text);
		await this.saveData(this.settings);
		this.app.workspace.getLeavesOfType(CAST_VIEW).forEach((l) => (l.view as CastView).refresh());
	}

	async extractEntities(file: TFile) {
		return this.once(`extract:${file.path}`, "looking for new names", () => this.extractEntitiesNow(file));
	}

	private async extractEntitiesNow(file: TFile) {
		const notice = new Notice("Storyloom: looking for new names…", 0);
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
			new Notice(`Storyloom: created ${rows.length} note${rows.length === 1 ? "" : "s"}.`);
		} catch (e) {
			notice.hide();
			this.errorNotice(e);
		}
	}

	/** A notice for an AI error, with an "Open settings" button when that's where the fix is. */
	errorNotice(e: unknown) {
		const msg = friendlyError(e);
		const frag = document.createDocumentFragment();
		frag.createSpan({ text: `Storyloom: ${msg}` });
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
		await this.app.fileManager.processFrontMatter(file, (fm) => {
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
		if (!chapters.length) return new Notice("No chapters yet.");
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
			cta: "Close",
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
		new Notice(`Exported ${this.index.chapters.length} chapters to ${path}`);
		await this.app.workspace.getLeaf("tab").openFile(file);
	}

	async clearSample() {
		const files = this.app.vault.getMarkdownFiles().filter((f) => this.app.metadataCache.getFileCache(f)?.frontmatter?.[SAMPLE_FLAG] === true);
		if (!files.length) return new Notice("No sample content found.");
		const ok = await ConfirmModal.ask(this.app, {
			title: "Clear sample content?",
			cta: "Delete sample files",
			warning: true,
			body: (el) => {
				el.createEl("p", { text: `This moves ${files.length} sample notes to the trash. Templates, Book.md, Start Here and your settings stay.` });
				const ul = el.createEl("ul", { cls: "storyloom-file-list" });
				for (const f of files) ul.createEl("li", { text: f.path });
			},
		});
		if (!ok) return;
		for (const f of files) await this.app.fileManager.trashFile(f);
		new Notice(`Removed ${files.length} sample notes.`);
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
	return ((editor as unknown as { cm?: EditorView }).cm ?? null) as EditorView | null;
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
