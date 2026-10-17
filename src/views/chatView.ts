import { Component, ItemView, MarkdownRenderer, MarkdownView, Notice, normalizePath, setIcon, TFile, type WorkspaceLeaf } from "obsidian";
import { stripFrontmatter } from "../codex/parse";
import type { Entity } from "../codex/types";
import { chatSystem } from "../context/prompts";
import { friendlyError, type ChatMessage } from "../llm/types";
import type MotifPlugin from "../main";
import { addSettingsButton } from "../ui";

export const CHAT_VIEW = "storyloom-chat";

interface Suggestion {
	label: string;
	insert: string;
	kind: "entity" | "chapter";
}

/** Chat about the book. `@` mentions pull entities and chapters into the context in full. */
export class ChatView extends ItemView {
	private history: ChatMessage[] = [];
	private busy = false;
	private listEl!: HTMLElement;
	private input!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private suggestEl!: HTMLElement;
	private suggestions: Suggestion[] = [];
	private suggestIdx = 0;
	private component = new Component();
	private chatId = newChatId();

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: MotifPlugin,
	) {
		super(leaf);
	}

	getViewType() {
		return CHAT_VIEW;
	}
	getDisplayText() {
		return "Story assistant";
	}
	getIcon() {
		return "message-circle";
	}

	async onOpen() {
		this.component.load();
		const root = this.contentEl;
		root.empty();
		root.addClass("storyloom-chat");

		const head = root.createDiv({ cls: "storyloom-chat-head" });
		head.createDiv({ cls: "storyloom-view-title", text: "Story assistant" });
		const newBtn = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "New chat" } });
		setIcon(newBtn, "plus");
		newBtn.addEventListener("click", () => this.newChat());

		this.listEl = root.createDiv({ cls: "storyloom-chat-list" });
		this.renderEmpty();

		const composer = root.createDiv({ cls: "storyloom-chat-composer" });
		this.suggestEl = composer.createDiv({ cls: "storyloom-chat-suggest" });
		this.suggestEl.hide();
		const field = composer.createDiv({ cls: "storyloom-chat-field" });
		this.input = field.createEl("textarea", { cls: "storyloom-chat-input" });
		this.input.placeholder = "Ask about your book…";
		this.input.rows = 1;
		this.sendBtn = field.createEl("button", { cls: "mod-cta storyloom-chat-send", attr: { "aria-label": "Send" } });
		setIcon(this.sendBtn, "arrow-up");
		const grow = () => {
			this.input.setCssProps({ height: "auto" });
			this.input.setCssProps({ height: `${Math.min(160, this.input.scrollHeight)}px` });
			field.toggleClass("has-text", !!this.input.value.trim());
		};
		this.input.addEventListener("input", grow);
		this.sendBtn.addEventListener("click", () => void this.send());
		this.input.addEventListener("input", () => this.updateSuggestions());
		this.input.addEventListener("keydown", (e) => this.onKey(e));

		// Clickable wikilinks in rendered answers.
		this.listEl.addEventListener("click", (e) => {
			const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.internal-link");
			if (!a) return;
			e.preventDefault();
			const href = a.dataset.href ?? a.getAttribute("href") ?? "";
			void this.app.workspace.openLinkText(href, "", e.metaKey || e.ctrlKey);
		});
	}

	async onClose() {
		this.component.unload();
	}

	private newChat() {
		this.history = [];
		this.chatId = newChatId();
		this.listEl.empty();
		this.renderEmpty();
	}

	private renderEmpty() {
		const empty = this.listEl.createDiv({ cls: "storyloom-chat-empty" });
		empty.createDiv({ cls: "sl-empty-title", text: "Ask about your book" });
		empty.createDiv({ cls: "sl-empty-body", text: "The assistant knows your codex, chapter summaries and the chapter you're in. Type @ to bring a character or chapter into the conversation." });
		const chips = empty.createDiv({ cls: "storyloom-chat-chips" });
		const people = this.plugin.index.sortedEntities().filter((e) => e.type === "character").map((e) => e.name.split(" ")[0]);
		const ideas = [people[0] ? `Where is ${people[0]} in chapter 2?` : "Who appears in chapter 1?", "Find plot holes so far.", people[1] ? `Is ${people[1]}'s voice consistent?` : "What should happen next?"];
		for (const q of ideas) {
			const b = chips.createEl("button", { cls: "storyloom-chip", text: q });
			b.addEventListener("click", () => {
				this.input.value = q;
				this.input.dispatchEvent(new Event("input"));
				this.input.focus();
			});
		}
	}

	// ---------- @ autocomplete ----------

	private mentionQuery(): { start: number; query: string } | null {
		const pos = this.input.selectionStart ?? 0;
		const before = this.input.value.slice(0, pos);
		const m = /(^|\s)@([^\s@]*)$/.exec(before);
		return m ? { start: pos - m[2].length - 1, query: m[2].toLowerCase() } : null;
	}

	private updateSuggestions() {
		const mq = this.mentionQuery();
		if (!mq) return this.hideSuggestions();
		const index = this.plugin.index;
		const items: Suggestion[] = [];
		for (const e of index.sortedEntities()) {
			if ([e.name, ...e.aliases].some((n) => n.toLowerCase().includes(mq.query))) items.push({ label: `${e.name} · ${e.type}`, insert: `@[[${e.name}]]`, kind: "entity" });
		}
		for (const c of index.chapters) {
			const label = `Chapter ${c.chapter}: ${c.title}`;
			if (label.toLowerCase().includes(mq.query) || String(c.chapter) === mq.query) items.push({ label, insert: `@[[${c.basename}]]`, kind: "chapter" });
		}
		this.suggestions = items.slice(0, 8);
		this.suggestIdx = 0;
		if (!this.suggestions.length) return this.hideSuggestions();
		this.renderSuggestions();
	}

	private renderSuggestions() {
		this.suggestEl.empty();
		this.suggestions.forEach((s, i) => {
			const row = this.suggestEl.createDiv({ cls: `storyloom-suggest-item${i === this.suggestIdx ? " is-selected" : ""}` });
			row.createSpan({ text: s.label });
			row.addEventListener("mousedown", (e) => {
				e.preventDefault();
				this.pick(i);
			});
		});
		this.suggestEl.show();
	}

	private hideSuggestions() {
		this.suggestions = [];
		this.suggestEl.hide();
	}

	private pick(i: number) {
		const s = this.suggestions[i];
		const mq = this.mentionQuery();
		if (!s || !mq) return;
		const pos = this.input.selectionStart ?? 0;
		const v = this.input.value;
		this.input.value = v.slice(0, mq.start) + s.insert + " " + v.slice(pos);
		const caret = mq.start + s.insert.length + 1;
		this.input.setSelectionRange(caret, caret);
		this.hideSuggestions();
		this.input.focus();
	}

	private onKey(e: KeyboardEvent) {
		if (this.suggestions.length) {
			if (e.key === "ArrowDown" || e.key === "ArrowUp") {
				e.preventDefault();
				this.suggestIdx = (this.suggestIdx + (e.key === "ArrowDown" ? 1 : -1) + this.suggestions.length) % this.suggestions.length;
				this.renderSuggestions();
				return;
			}
			if (e.key === "Enter" || e.key === "Tab") {
				e.preventDefault();
				this.pick(this.suggestIdx);
				return;
			}
			if (e.key === "Escape") {
				this.hideSuggestions();
				return;
			}
		}
		if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			void this.send();
		}
	}

	// ---------- Sending ----------

	private mentioned(text: string): { entities: Entity[]; chapters: TFile[] } {
		const entities: Entity[] = [];
		const chapters: TFile[] = [];
		for (const m of text.matchAll(/@\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
			const e = this.plugin.index.getEntity(m[1]);
			if (e && !entities.includes(e)) entities.push(e);
			const c = this.plugin.index.chapters.find((ch) => ch.basename === m[1] || ch.title === m[1]);
			const f = c ? this.plugin.index.fileFor(c.path) : null;
			if (f && !chapters.includes(f)) chapters.push(f);
		}
		return { entities, chapters };
	}

	private async send() {
		const q = this.input.value.trim();
		if (!q || this.busy) return;
		this.busy = true;
		this.sendBtn.disabled = true;
		this.input.value = "";
		this.input.dispatchEvent(new Event("input"));
		this.hideSuggestions();
		this.listEl.querySelector(".storyloom-chat-empty")?.remove();

		void this.addBubble("user", q);
		const pending = this.listEl.createDiv({ cls: "storyloom-chat-msg is-assistant" });
		const l = pending.createDiv({ cls: "storyloom-loading" });
		l.createSpan({ cls: "storyloom-spinner" });
		l.createSpan({ text: "Thinking…" });
		this.scroll();

		try {
			const file = this.plugin.activeMarkdownFile();
			const text = file ? await this.app.vault.cachedRead(file) : "";
			const { entities, chapters } = this.mentioned(q);
			const ctx = await this.plugin.ai.context({ file, text, passage: q, pinned: entities });
			let extra = "";
			for (const e of entities) {
				const f = this.plugin.index.fileFor(e.path);
				if (f) extra += `\n\n### Full note: ${e.name}\n${stripFrontmatter(await this.app.vault.cachedRead(f)).trim()}`;
			}
			for (const f of chapters) {
				if (f.path === file?.path) continue;
				const c = this.plugin.index.chapterForPath(f.path);
				extra += `\n\n### Full text: Chapter ${c?.chapter} — ${c?.title}\n${stripFrontmatter(await this.app.vault.cachedRead(f)).trim()}`;
			}
			const system = chatSystem(ctx.text + (extra ? `\n\n## Referenced in full${extra}` : ""));
			const question = q.replace(/@\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, "[[$1]]");
			const answer = await this.plugin.ai.stream({ system, user: question }, (soFar) => {
				pending.empty();
				pending.addClass("is-streaming");
				pending.setText(soFar);
				this.scroll();
			}, { history: this.history });
			this.history.push({ role: "user", content: question }, { role: "assistant", content: answer });
			pending.remove();
			await this.addBubble("assistant", answer);
			if (this.plugin.settings.saveChats) await this.save();
		} catch (e) {
			pending.empty();
			pending.addClass("storyloom-error");
			pending.setText(friendlyError(e));
			addSettingsButton(pending, this.app, friendlyError(e), "storyloom-settings-btn");
		} finally {
			this.busy = false;
			this.sendBtn.disabled = false;
			this.scroll();
		}
	}

	private async addBubble(role: "user" | "assistant", text: string) {
		const msg = this.listEl.createDiv({ cls: `storyloom-chat-msg is-${role}` });
		if (role === "user") {
			msg.setText(text.replace(/@\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, "@$1"));
			return;
		}
		const body = msg.createDiv({ cls: "markdown-rendered" });
		await MarkdownRenderer.render(this.app, text, body, this.plugin.activeMarkdownFile()?.path ?? "", this.component);
		const bar = msg.createDiv({ cls: "storyloom-chat-actions" });
		const copy = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Copy" } });
		setIcon(copy, "copy");
		copy.addEventListener("click", () => {
			void navigator.clipboard.writeText(text).then(() => new Notice("Motif: copied."));
		});
		const ins = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Insert into note" } });
		setIcon(ins, "text-cursor-input");
		ins.addEventListener("click", () => {
			const editor = this.plugin.activeEditor();
			if (!editor) return new Notice("Motif: open a note to insert into.");
			editor.replaceRange(text, editor.getCursor());
			const leaf = this.app.workspace.getLeavesOfType("markdown").find((l) => (l.view as MarkdownView).editor === editor);
			if (leaf) this.app.workspace.setActiveLeaf(leaf, { focus: true });
		});
		this.scroll();
	}

	private scroll() {
		this.listEl.scrollTop = this.listEl.scrollHeight;
	}

	private async save() {
		const dir = normalizePath(".motif/chats");
		const adapter = this.app.vault.adapter;
		if (!(await adapter.exists(".motif"))) await adapter.mkdir(".motif");
		if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
		const md = this.history.map((m) => `## ${m.role === "user" ? "You" : "Assistant"}\n\n${m.content}`).join("\n\n");
		await adapter.write(`${dir}/${this.chatId}.md`, md + "\n");
	}
}

function newChatId() {
	return new Date().toISOString().replace(/[:.]/g, "-");
}
