import { isolateHistory } from "@codemirror/commands";
import { Prec, StateEffect, StateField, Transaction, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, showTooltip, ViewPlugin, type DecorationSet, type Tooltip, type TooltipView, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, Platform, Scope, setIcon } from "obsidian";
import { cleanProse, inlineEditPrompt, REWRITE_PRESETS } from "../context/prompts";
import { friendlyError, LLMError } from "../llm/types";
import type MotifPlugin from "../main";
import { diffWords, similarity } from "./diff";
import { isSettingsError, openSettings } from "../ui";

type Phase = "input" | "loading" | "result" | "error";

export interface InlineEditState {
	id: number;
	/** Stable for one open/close cycle, so the floating panel morphs instead of being rebuilt. */
	session: number;
	phase: Phase;
	from: number;
	to: number;
	insert: boolean;
	instruction: string;
	/** Text being transformed: the selection, or the previous result when refining. */
	source: string;
	result?: string;
	error?: string;
	/** Text streamed so far while loading. */
	partial?: string;
}

export const setInlineEdit = StateEffect.define<InlineEditState | null>();
const setPartial = StateEffect.define<{ id: number; text: string }>();

export const inlineEditField = StateField.define<InlineEditState | null>({
	create: () => null,
	update(value, tr) {
		for (const e of tr.effects) {
			if (e.is(setInlineEdit)) return e.value;
			if (e.is(setPartial) && value?.id === e.value.id) value = { ...value, partial: e.value.text };
		}
		// Any edit to the document while a result is pending cancels it cleanly.
		if (value && tr.docChanged) return null;
		return value;
	},
});

const CHIP_INSTRUCTIONS: Record<string, string> = {
	...REWRITE_PRESETS,
	"Fix grammar": "Fix grammar, spelling and punctuation only. Change nothing else.",
	Continue: "Continue writing from here in the same voice, about one paragraph.",
};

let seq = 0;

/** Pure-ish helper: keep the original selection's leading/trailing whitespace around a rewrite. */
export function preserveWhitespace(original: string, replacement: string): string {
	const lead = /^\s*/.exec(original)?.[0] ?? "";
	const trail = /\s*$/.exec(original)?.[0] ?? "";
	return lead + replacement.trim() + trail;
}

export class InlineEditController {
	/** One in-flight request per editor, so working in one pane never cancels another. */
	private aborts = new WeakMap<EditorView, AbortController>();

	constructor(private plugin: MotifPlugin) {}

	get(view: EditorView) {
		return view.state.field(inlineEditField, false) ?? null;
	}

	private set(view: EditorView, s: InlineEditState | null) {
		view.dispatch({ effects: setInlineEdit.of(s) });
	}

	open(view: EditorView): boolean {
		const cur = this.get(view);
		if (cur && cur.phase === "input") {
			view.dom.querySelector<HTMLInputElement>(".storyloom-glass-input")?.focus();
			return true;
		}
		const sel = view.state.selection.main;
		this.set(view, {
			id: ++seq,
			session: ++seq,
			phase: "input",
			from: sel.from,
			to: sel.to,
			insert: sel.empty,
			instruction: "",
			source: view.state.sliceDoc(sel.from, sel.to),
		});
		return true;
	}

	close(view: EditorView) {
		if (!this.get(view)) return false;
		this.aborts.get(view)?.abort();
		ghostOut(view);
		this.set(view, null);
		view.focus();
		return true;
	}

	async run(view: EditorView, rawInstruction: string, source?: string) {
		const cur = this.get(view);
		const instruction = rawInstruction.trim();
		if (!cur || !instruction) return;
		this.plugin.rememberInstruction(instruction);
		let next: InlineEditState = { ...cur, id: ++seq, phase: "loading", instruction, source: source ?? cur.source, error: undefined };
		// "Continue" on a selection writes after it instead of replacing it.
		if (rawInstruction === "Continue" && !cur.insert) next = { ...next, from: cur.to, insert: true, source: "" };
		this.set(view, next);
		try {
			const text = await this.generate(view, next, CHIP_INSTRUCTIONS[instruction] ?? instruction);
			if (this.get(view)?.id !== next.id) return; // stopped, cancelled or superseded
			this.set(view, { ...next, id: ++seq, phase: "result", result: text });
			view.focus();
		} catch (e) {
			if (this.get(view)?.id !== next.id) return;
			this.set(view, { ...next, id: ++seq, phase: "error", error: friendlyError(e) });
			view.focus(); // so Esc closes it
		}
	}

	stop(view: EditorView) {
		this.aborts.get(view)?.abort();
		const cur = this.get(view);
		if (cur?.phase === "loading") this.set(view, { ...cur, id: ++seq, phase: "input" });
	}

	accept(view: EditorView): boolean {
		const cur = this.get(view);
		if (!cur || cur.phase !== "result" || cur.result === undefined) return false;
		ghostOut(view);
		view.dispatch({
			changes: { from: cur.from, to: cur.to, insert: cur.result },
			selection: { anchor: cur.from + cur.result.length },
			effects: setInlineEdit.of(null),
			annotations: [isolateHistory.of("full"), Transaction.userEvent.of("input.storyloom")],
			scrollIntoView: true,
		});
		view.focus();
		return true;
	}

	refine(view: EditorView, followUp: string) {
		const cur = this.get(view);
		if (cur?.phase === "result" && cur.result !== undefined) void this.run(view, followUp, cur.result);
	}

	retry(view: EditorView) {
		const cur = this.get(view);
		if (cur) void this.run(view, cur.instruction, cur.source);
	}

	private async generate(view: EditorView, st: InlineEditState, instruction: string): Promise<string> {
		// Register the request before any await, so Stop also cancels it while the context loads.
		this.aborts.get(view)?.abort();
		const abort = new AbortController();
		this.aborts.set(view, abort);
		const file = view.state.field(editorInfoField, false)?.file ?? null;
		const doc = view.state.doc.toString();
		const before = doc.slice(Math.max(0, st.from - 1500), st.from);
		const after = doc.slice(st.to, st.to + 1500);
		const ctx = await this.plugin.ai.context({ file, text: doc, cursor: Math.max(0, st.from - before.length), passage: st.source });
		// Refining: the span to rewrite is the previous result, not what's in the document.
		const refining = st.source !== view.state.sliceDoc(st.from, st.to);
		const prompt = inlineEditPrompt(ctx.text, {
			instruction: refining ? `${instruction} (This is a revision of an earlier draft of the replacement, shown as the selected span.)` : instruction,
			selection: st.source,
			before,
			after,
			insert: st.insert && !refining,
		});
		if (abort.signal.aborted) throw new LLMError("aborted", "Stopped.");
		// Stream into the panel, at most one update per frame.
		let pending: string | null = null;
		const flush = () => {
			if (pending === null || this.get(view)?.id !== st.id) return;
			view.dispatch({ effects: setPartial.of({ id: st.id, text: cleanProse(pending) }) });
			pending = null;
		};
		const raw = cleanProse(
			await this.plugin.ai.stream(
				prompt,
				(soFar) => {
					if (pending === null) window.requestAnimationFrame(flush);
					pending = soFar;
				},
				{ signal: abort.signal },
			),
		);
		if (st.insert) {
			const prev = doc.slice(Math.max(0, st.from - 1), st.from);
			return prev && !/\s/.test(prev) && !/^[\s,.;:!?)]/.test(raw) ? " " + raw : raw;
		}
		return preserveWhitespace(view.state.sliceDoc(st.from, st.to), raw);
	}
}

// ---------- Floating panel ----------

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** Fade a copy of the panel out where it was, so closing feels smooth even though CM removes it at once. */
function ghostOut(view: EditorView) {
	const el = view.dom.querySelector<HTMLElement>(".storyloom-glass-panel");
	if (!el || reducedMotion()) return;
	const rect = el.getBoundingClientRect();
	const ghost = el.cloneNode(true) as HTMLElement;
	ghost.addClass("is-ghost");
	Object.assign(ghost.style, { position: "fixed", left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, margin: "0", zIndex: "1000", pointerEvents: "none" });
	(view.dom.ownerDocument.body ?? document.body).appendChild(ghost);
	window.setTimeout(() => ghost.remove(), 220);
}

function icon(parent: HTMLElement, name: string, cls = "storyloom-glass-icon") {
	const span = parent.createSpan({ cls });
	setIcon(span, name);
	return span;
}

function glassButton(parent: HTMLElement, opts: { label?: string; icon?: string; kbd?: string; primary?: boolean; title?: string; onClick: () => void }) {
	const b = parent.createEl("button", { cls: `storyloom-glass-btn${opts.primary ? " is-primary" : ""}${opts.label ? "" : " is-icon"}` });
	if (opts.title) b.setAttr("aria-label", opts.title);
	if (opts.icon) icon(b, opts.icon);
	if (opts.label) b.createSpan({ text: opts.label });
	if (opts.kbd) b.createSpan({ cls: "storyloom-glass-kbd", text: opts.kbd });
	b.addEventListener("mousedown", (e) => e.preventDefault());
	b.addEventListener("click", (e) => {
		e.stopPropagation();
		opts.onClick();
	});
	return b;
}

/** One panel per session. It re-renders in place and animates its height between phases. */
class GlassPanel implements TooltipView {
	dom: HTMLElement;
	private inner: HTMLElement;
	private st: InlineEditState | null = null;

	constructor(
		private view: EditorView,
		private ctrl: InlineEditController,
		private plugin: MotifPlugin,
	) {
		this.dom = createDiv({ cls: "storyloom-glass storyloom-glass-panel" });
		this.dom.addEventListener("mousedown", (e) => e.stopPropagation());
		this.inner = this.dom.createDiv({ cls: "storyloom-glass-inner" });
		this.render(view.state.field(inlineEditField, false) ?? null, false);
	}

	/**
	 * Anchored at the end of the selection so it sits below it, then shifted left to the start of the
	 * text column (CM's own offset hook runs in the write phase, where layout can't be read through CM).
	 */
	positioned() {
		const tip = this.dom; // CM puts the cm-tooltip class (and its position) on our element itself
		// Lines carry the real text column (Obsidian centres them when "readable line length" is on).
		const line = this.view.contentDOM.querySelector<HTMLElement>(".cm-line");
		if (!line) return;
		const pad = parseFloat(getComputedStyle(line).paddingLeft) || 0;
		// Never wider than the editor, and never spilling past either edge of it.
		const box = this.view.scrollDOM.getBoundingClientRect();
		tip.style.maxWidth = `${Math.max(240, box.width - 24)}px`;
		const t = tip.getBoundingClientRect();
		let target = line.getBoundingClientRect().left + pad;
		target = Math.min(target, box.right - 12 - t.width);
		target = Math.max(target, box.left + 12);
		const shift = target - t.left;
		if (Math.abs(shift) > 1) tip.style.left = `${(parseFloat(tip.style.left) || 0) + shift}px`;
	}

	mount() {
		window.requestAnimationFrame(() => this.dom.querySelector<HTMLInputElement>(".storyloom-glass-input")?.focus());
	}

	update(u: ViewUpdate) {
		const st = u.state.field(inlineEditField, false) ?? null;
		if (st && st !== this.st && (st.phase !== this.st?.phase || st.result !== this.st?.result || st.error !== this.st?.error)) this.render(st, true);
		else {
			const grew = st?.phase === "loading" && st.partial !== this.st?.partial;
			this.st = st;
			if (grew && st) this.showPartial(st.partial ?? "");
		}
	}

	/** While streaming: swap the skeleton for the text so far, growing smoothly. */
	private showPartial(text: string) {
		const sk = this.inner.querySelector(".storyloom-glass-skeleton");
		let live = this.inner.querySelector<HTMLElement>(".storyloom-glass-result");
		const from = this.dom.offsetHeight;
		if (!live) {
			live = createDiv({ cls: "storyloom-glass-result is-streaming" });
			if (sk) sk.replaceWith(live);
			else this.inner.querySelector(".storyloom-glass-bar")?.before(live);
		}
		live.setText(text);
		live.scrollTop = live.scrollHeight;
		const to = this.dom.offsetHeight;
		if (!reducedMotion() && Math.abs(to - from) > 2) this.dom.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 160, easing: "ease-out" });
	}

	private render(st: InlineEditState | null, animate: boolean) {
		const from = animate && !reducedMotion() ? this.dom.offsetHeight : 0;
		this.st = st;
		this.dom.dataset.phase = st?.phase ?? "";
		const next = createDiv({ cls: "storyloom-glass-inner is-entering" });
		if (st) this.fill(next, st);
		this.inner.replaceWith(next);
		this.inner = next;
		window.requestAnimationFrame(() => next.removeClass("is-entering"));
		if (from) {
			const to = this.dom.offsetHeight;
			if (Math.abs(to - from) > 2) {
				this.dom.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 260, easing: "cubic-bezier(.2,.9,.25,1)" });
			}
		}
		if (st?.phase === "input") this.mount();
	}

	private fill(root: HTMLElement, st: InlineEditState) {
		const v = this.view;
		if (st.phase === "input") {
			const row = root.createDiv({ cls: "storyloom-glass-row" });
			icon(row, "sparkles", "storyloom-glass-icon is-accent");
			const input = row.createEl("input", { type: "text", cls: "storyloom-glass-input" });
			input.placeholder = st.insert ? "Tell the AI what to write here…" : "Tell the AI what to do with this…";
			input.value = st.instruction;
			const history = this.plugin.settings.instructionHistory;
			let h = -1;
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && !e.isComposing) {
					e.preventDefault();
					void this.ctrl.run(v, input.value);
				} else if (e.key === "Escape") {
					e.preventDefault();
					this.ctrl.close(v);
				} else if (e.key === "ArrowUp" && history.length) {
					e.preventDefault();
					h = Math.min(history.length - 1, h + 1);
					input.value = history[h];
				} else if (e.key === "ArrowDown" && h >= 0) {
					e.preventDefault();
					h--;
					input.value = h >= 0 ? history[h] : "";
				}
				e.stopPropagation();
			});
			glassButton(row, { icon: "arrow-up", primary: true, title: "Send (Enter)", onClick: () => void this.ctrl.run(v, input.value) });
			const chips = root.createDiv({ cls: "storyloom-glass-chips" });
			this.plugin.settings.quickChips.forEach((c, i) => {
				const chip = chips.createEl("button", { cls: "storyloom-glass-chip", text: c });
				chip.style.animationDelay = `${40 + i * 25}ms`;
				chip.addEventListener("mousedown", (e) => e.preventDefault());
				chip.addEventListener("click", () => void this.ctrl.run(v, c));
			});
			return;
		}

		const head = root.createDiv({ cls: "storyloom-glass-head" });
		icon(head, st.phase === "error" ? "alert-triangle" : "sparkles", `storyloom-glass-icon ${st.phase === "error" ? "is-error" : "is-accent"}`);
		head.createSpan({ cls: "storyloom-glass-instruction", text: st.instruction || "Ask AI" });

		if (st.phase === "loading") {
			const sk = root.createDiv({ cls: "storyloom-glass-skeleton" });
			for (const w of [92, 78, 64]) sk.createDiv({ cls: "storyloom-glass-skeleton-line" }).style.width = `${w}%`;
			const bar = root.createDiv({ cls: "storyloom-glass-bar" });
			bar.createSpan({ cls: "storyloom-glass-status", text: "Writing…" });
			bar.createDiv({ cls: "storyloom-glass-spacer" });
			glassButton(bar, { label: "Stop", icon: "square", onClick: () => this.ctrl.stop(v) });
			return;
		}

		if (st.phase === "error") {
			root.createDiv({ cls: "storyloom-glass-error", text: st.error ?? "Something went wrong." });
			const bar = root.createDiv({ cls: "storyloom-glass-bar" });
			bar.createDiv({ cls: "storyloom-glass-spacer" });
			glassButton(bar, { label: "Edit", icon: "pencil", onClick: () => v.dispatch({ effects: setInlineEdit.of({ ...st, id: ++seq, phase: "input" }) }) });
			glassButton(bar, { label: "Close", kbd: "esc", onClick: () => this.ctrl.close(v) });
			if (isSettingsError(st.error ?? "")) {
				glassButton(bar, { label: "Open settings", icon: "settings", primary: true, onClick: () => { this.ctrl.close(v); openSettings(this.plugin.app); } });
			} else glassButton(bar, { label: "Retry", icon: "rotate-ccw", primary: true, onClick: () => this.ctrl.retry(v) });
			return;
		}

		// Result: show what changes, word by word, without touching the document.
		const result = st.result ?? "";
		const original = st.insert ? "" : v.state.sliceDoc(st.from, st.to);
		const body = root.createDiv({ cls: "storyloom-glass-result" });
		const parts = diffWords(original.trim(), result.trim());
		if (!st.insert && similarity(parts) >= 0.25) {
			for (const p of parts) {
				if (p.kind === "same") body.appendText(p.text);
				else body.createSpan({ cls: p.kind === "add" ? "storyloom-diff-add" : "storyloom-diff-del", text: p.text });
			}
		} else {
			body.createSpan({ cls: st.insert ? "storyloom-diff-add is-soft" : "", text: result.trim() });
		}

		const bar = root.createDiv({ cls: "storyloom-glass-bar" });
		const refine = bar.createEl("input", { type: "text", cls: "storyloom-glass-input is-refine" });
		refine.placeholder = "Ask for changes…";
		refine.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this.ctrl.accept(v);
			} else if (e.key === "Enter" && !e.isComposing && refine.value.trim()) {
				e.preventDefault();
				this.ctrl.refine(v, refine.value);
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.ctrl.close(v);
			}
			e.stopPropagation();
		});
		glassButton(bar, { icon: "rotate-ccw", title: "Retry", onClick: () => this.ctrl.retry(v) });
		glassButton(bar, { label: "Discard", kbd: "esc", onClick: () => this.ctrl.close(v) });
		glassButton(bar, { label: st.insert ? "Insert" : "Replace", kbd: "tab", primary: true, onClick: () => this.ctrl.accept(v) });
	}
}

/** The panel's tooltip object stays the same for a whole session, so CM keeps one view and we morph it. */
function panelTooltipField(ctrl: InlineEditController, plugin: MotifPlugin) {
	return StateField.define<{ key: string; tooltip: Tooltip } | null>({
		create: () => null,
		update(prev, tr) {
			const st = tr.state.field(inlineEditField, false);
			if (!st) return null;
			const key = `${st.session}:${st.from}:${st.to}`;
			if (prev?.key === key) return prev;
			return {
				key,
				tooltip: {
					pos: st.insert ? st.from : st.to,
					above: false,
					strictSide: false,
					arrow: false,
					create: (view) => new GlassPanel(view, ctrl, plugin),
				},
			};
		},
		provide: (f) => showTooltip.from(f, (v) => v?.tooltip ?? null),
	});
}

function selectionMarks(state: EditorState): DecorationSet {
	const st = state.field(inlineEditField, false);
	if (!st || st.to <= st.from) return Decoration.none;
	const cls = st.phase === "loading" ? "storyloom-glass-mark is-shimmer" : st.phase === "result" ? "storyloom-glass-mark is-pending" : "storyloom-glass-mark";
	return Decoration.set([Decoration.mark({ class: cls }).range(st.from, st.to)]);
}

// ---------- "Ask AI" pill ----------

const showAsk = StateEffect.define<number | null>();

/** Appears once the selection settles (not while dragging), above the start of the selection. */
function askPill(plugin: MotifPlugin, ctrl: InlineEditController): Extension {
	const field = StateField.define<Tooltip | null>({
		create: () => null,
		update(t, tr) {
			for (const e of tr.effects) {
				if (e.is(showAsk)) {
					const pos = e.value;
					if (pos === null) return null;
					return {
						pos,
						above: true,
						strictSide: false,
						arrow: false,
						create: (view) => {
							const dom = createDiv({ cls: "storyloom-glass storyloom-ask-pill" });
							const b = dom.createEl("button", { cls: "storyloom-ask-pill-btn" });
							icon(b, "sparkles", "storyloom-glass-icon is-accent");
							b.createSpan({ text: "Ask AI" });
							const key = plugin.settings.inlineEditKey.replace(/^Mod-/i, Platform.isMacOS ? "⌘" : "Ctrl+").toUpperCase();
							if (key) b.createSpan({ cls: "storyloom-glass-kbd", text: key });
							b.addEventListener("mousedown", (e) => e.preventDefault());
							b.addEventListener("click", () => ctrl.open(view));
							return { dom };
						},
					};
				}
			}
			if (t && (tr.docChanged || tr.selection || tr.state.field(inlineEditField, false))) return null;
			return t;
		},
		provide: (f) => showTooltip.from(f),
	});
	const watcher = ViewPlugin.fromClass(
		class {
			timer = 0;
			pointerDown = false;
			constructor(private view: EditorView) {
				view.dom.addEventListener("pointerdown", this.down);
				view.dom.ownerDocument.addEventListener("pointerup", this.up);
			}
			down = () => (this.pointerDown = true);
			up = () => {
				if (!this.pointerDown) return;
				this.pointerDown = false;
				this.schedule();
			};
			update(u: ViewUpdate) {
				if (u.selectionSet || u.docChanged) this.schedule();
			}
			schedule() {
				window.clearTimeout(this.timer);
				if (this.pointerDown) return;
				this.timer = window.setTimeout(() => {
					const s = this.view.state;
					const sel = s.selection.main;
					const words = sel.empty ? 0 : s.sliceDoc(sel.from, sel.to).trim().split(/\s+/).filter(Boolean).length;
					const show = plugin.settings.askAiButton && words >= 3 && !s.field(inlineEditField, false) && this.view.hasFocus;
					const cur = s.field(field, false);
					if (show && !cur) this.view.dispatch({ effects: showAsk.of(sel.from) });
				}, 220);
			}
			destroy() {
				window.clearTimeout(this.timer);
				this.view.dom.removeEventListener("pointerdown", this.down);
				this.view.dom.ownerDocument.removeEventListener("pointerup", this.up);
			}
		},
	);
	return [field, watcher];
}

export function inlineEditExtension(plugin: MotifPlugin, ctrl: InlineEditController): Extension {
	const marks = EditorView.decorations.compute([inlineEditField], (state) => selectionMarks(state));
	const keys = Prec.highest(
		keymap.of([
			{ key: "Tab", run: (v) => ctrl.accept(v) },
			{ key: "Mod-Enter", run: (v) => ctrl.accept(v) },
			{
				key: "Escape",
				run: (v) => {
					const cur = ctrl.get(v);
					if (!cur) return false;
					if (cur.phase === "loading") ctrl.stop(v);
					return ctrl.close(v);
				},
			},
		]),
	);
	// Obsidian binds Mod+Enter globally ("open link in new tab") ahead of CodeMirror, and a scope
	// handler can't pass a key through, so claim it only while a result is waiting.
	const acceptScope = ViewPlugin.fromClass(
		class {
			scope: Scope | null = null;
			constructor(private view: EditorView) {}
			update(u: ViewUpdate) {
				const pending = u.state.field(inlineEditField, false)?.phase === "result";
				if (pending && !this.scope) {
					this.scope = new Scope(plugin.app.scope);
					this.scope.register(["Mod"], "Enter", () => {
						if (!this.view.hasFocus && !this.view.dom.contains(document.activeElement)) return true; // not ours: let it through
						ctrl.accept(this.view);
						return false;
					});
					plugin.app.keymap.pushScope(this.scope);
				} else if (!pending && this.scope) this.release();
			}
			release() {
				if (this.scope) plugin.app.keymap.popScope(this.scope);
				this.scope = null;
			}
			destroy() {
				this.release();
			}
		},
	);
	return [inlineEditField, panelTooltipField(ctrl, plugin), marks, askPill(plugin, ctrl), keys, acceptScope];
}
