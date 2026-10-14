import { isolateHistory } from "@codemirror/commands";
import { Prec, StateEffect, StateField, Transaction, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap, showTooltip, ViewPlugin, WidgetType, type DecorationSet, type Tooltip, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, Scope, setIcon } from "obsidian";
import { cleanProse, inlineEditPrompt, REWRITE_PRESETS } from "../context/prompts";
import { friendlyError } from "../llm/types";
import type StoryloomPlugin from "../main";

type Phase = "input" | "loading" | "result" | "error";

export interface InlineEditState {
	id: number;
	phase: Phase;
	from: number;
	to: number;
	insert: boolean;
	instruction: string;
	/** Text being transformed: the selection, or the previous result when refining. */
	source: string;
	result?: string;
	error?: string;
}

export const setInlineEdit = StateEffect.define<InlineEditState | null>();

export const inlineEditField = StateField.define<InlineEditState | null>({
	create: () => null,
	update(value, tr) {
		for (const e of tr.effects) if (e.is(setInlineEdit)) return e.value;
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
	constructor(private plugin: StoryloomPlugin) {}

	get(view: EditorView) {
		return view.state.field(inlineEditField, false) ?? null;
	}

	private set(view: EditorView, s: InlineEditState | null) {
		view.dispatch({ effects: setInlineEdit.of(s) });
	}

	open(view: EditorView): boolean {
		const cur = this.get(view);
		if (cur && cur.phase === "input") {
			(view.dom.querySelector(".storyloom-ie-input") as HTMLInputElement | null)?.focus();
			return true;
		}
		const sel = view.state.selection.main;
		this.set(view, {
			id: ++seq,
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
		}
	}

	stop(view: EditorView) {
		const cur = this.get(view);
		if (cur?.phase === "loading") this.set(view, { ...cur, id: ++seq, phase: "input" });
	}

	accept(view: EditorView): boolean {
		const cur = this.get(view);
		if (!cur || cur.phase !== "result" || cur.result === undefined) return false;
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
		const raw = cleanProse(await this.plugin.ai.complete(prompt));
		if (st.insert) {
			const prev = doc.slice(Math.max(0, st.from - 1), st.from);
			return prev && !/\s/.test(prev) && !/^[\s,.;:!?)]/.test(raw) ? " " + raw : raw;
		}
		return preserveWhitespace(view.state.sliceDoc(st.from, st.to), raw);
	}
}

// ---------- Widgets ----------

class PanelWidget extends WidgetType {
	constructor(
		private st: InlineEditState,
		private ctrl: InlineEditController,
		private plugin: StoryloomPlugin,
	) {
		super();
	}

	eq(other: PanelWidget) {
		return other.st === this.st;
	}

	ignoreEvent() {
		return true;
	}

	toDOM(view: EditorView): HTMLElement {
		const st = this.st;
		const root = createDiv({ cls: `storyloom-ie-panel is-${st.phase}` });
		root.addEventListener("mousedown", (e) => e.stopPropagation());

		if (st.phase === "result" && st.result !== undefined) {
			const box = root.createDiv({ cls: "storyloom-ie-result" });
			box.setText(st.result);
		}
		if (st.phase === "error") {
			const err = root.createDiv({ cls: "storyloom-error" });
			setIcon(err.createSpan(), "alert-triangle");
			err.createSpan({ text: st.error ?? "Something went wrong." });
		}

		const bar = root.createDiv({ cls: "storyloom-ie-bar" });
		if (st.phase === "input") this.renderInput(root, bar, view);
		else if (st.phase === "loading") {
			const l = bar.createDiv({ cls: "storyloom-loading" });
			l.createSpan({ cls: "storyloom-spinner" });
			l.createSpan({ text: "Writing…" });
			btn(bar, "Stop", "square", () => this.ctrl.stop(view));
		} else if (st.phase === "result") {
			btn(bar, "Accept", "check", () => this.ctrl.accept(view), "Tab", true);
			btn(bar, "Reject", "x", () => this.ctrl.close(view), "Esc");
			btn(bar, "Retry", "rotate-ccw", () => this.ctrl.retry(view));
			const follow = bar.createEl("input", { type: "text", cls: "storyloom-ie-follow" });
			follow.placeholder = "Refine: shorter, less flowery…";
			follow.addEventListener("keydown", (e) => {
				if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
					e.preventDefault();
					this.ctrl.accept(view);
				} else if (e.key === "Enter" && !e.isComposing && follow.value.trim()) {
					e.preventDefault();
					this.ctrl.refine(view, follow.value);
				} else if (e.key === "Escape") {
					e.preventDefault();
					this.ctrl.close(view);
				}
				e.stopPropagation();
			});
		} else {
			btn(bar, "Retry", "rotate-ccw", () => this.ctrl.retry(view), undefined, true);
			btn(bar, "Edit instruction", "pencil", () => view.dispatch({ effects: setInlineEdit.of({ ...st, id: ++seq, phase: "input" }) }));
			btn(bar, "Close", "x", () => this.ctrl.close(view), "Esc");
		}
		return root;
	}

	private renderInput(root: HTMLElement, bar: HTMLElement, view: EditorView) {
		const input = bar.createEl("input", { type: "text", cls: "storyloom-ie-input" });
		input.placeholder = this.st.insert ? "Tell the AI what to write here…" : "Tell the AI what to do with this…";
		input.value = this.st.instruction;
		const history = this.plugin.settings.instructionHistory;
		let h = -1;
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				void this.ctrl.run(view, input.value);
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.ctrl.close(view);
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
		btn(bar, "Run", "corner-down-left", () => void this.ctrl.run(view, input.value), "Enter", true);
		const chips = root.createDiv({ cls: "storyloom-ie-chips" });
		for (const c of this.plugin.settings.quickChips) {
			const chip = chips.createEl("button", { cls: "storyloom-chip", text: c });
			chip.addEventListener("click", () => void this.ctrl.run(view, c));
		}
		window.requestAnimationFrame(() => input.focus());
	}
}

function btn(parent: HTMLElement, label: string, icon: string, onClick: () => void, hint?: string, cta = false) {
	const b = parent.createEl("button", { cls: `storyloom-ie-btn${cta ? " mod-cta" : ""}` });
	setIcon(b.createSpan({ cls: "storyloom-btn-icon" }), icon);
	b.createSpan({ text: label });
	if (hint) b.createSpan({ cls: "storyloom-kbd", text: hint });
	b.addEventListener("mousedown", (e) => e.preventDefault());
	b.addEventListener("click", (e) => {
		e.stopPropagation();
		onClick();
	});
	return b;
}

function decorationsFor(state: EditorState, ctrl: InlineEditController, plugin: StoryloomPlugin): DecorationSet {
	const st = state.field(inlineEditField, false);
	if (!st) return Decoration.none;
	const ranges = [];
	if (st.to > st.from) {
		const cls = st.phase === "result" ? "storyloom-ie-original" : st.phase === "loading" ? "storyloom-ie-pulse" : "storyloom-ie-selected";
		ranges.push(Decoration.mark({ class: cls }).range(st.from, st.to));
	}
	const anchor = state.doc.lineAt(st.insert ? st.from : st.to).to;
	ranges.push(Decoration.widget({ widget: new PanelWidget(st, ctrl, plugin), block: true, side: 1 }).range(anchor));
	return Decoration.set(ranges, true);
}

// ---------- "Ask AI" button ----------

function askTooltip(state: EditorState, plugin: StoryloomPlugin, ctrl: InlineEditController): Tooltip | null {
	if (!plugin.settings.askAiButton || state.field(inlineEditField, false)) return null;
	const sel = state.selection.main;
	if (sel.empty) return null;
	const words = state.sliceDoc(sel.from, sel.to).trim().split(/\s+/).filter(Boolean).length;
	if (words < 3) return null;
	return {
		pos: sel.to,
		above: false,
		strictSide: false,
		arrow: false,
		create: (view) => {
			const dom = createDiv({ cls: "storyloom-ask-ai" });
			const b = dom.createEl("button", { cls: "storyloom-ask-ai-btn" });
			setIcon(b.createSpan({ cls: "storyloom-btn-icon" }), "sparkles");
			b.createSpan({ text: "Ask AI" });
			b.addEventListener("mousedown", (e) => e.preventDefault());
			b.addEventListener("click", () => ctrl.open(view));
			return { dom };
		},
	};
}

export function inlineEditExtension(plugin: StoryloomPlugin, ctrl: InlineEditController): Extension {
	const decorations = EditorView.decorations.compute([inlineEditField], (state) => decorationsFor(state, ctrl, plugin));
	const ask = StateField.define<Tooltip | null>({
		create: (s) => askTooltip(s, plugin, ctrl),
		update(t, tr) {
			if (!tr.docChanged && !tr.selection && !tr.effects.some((e) => e.is(setInlineEdit))) return t;
			return askTooltip(tr.state, plugin, ctrl);
		},
		provide: (f) => showTooltip.from(f),
	});
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
	return [inlineEditField, decorations, ask, keys, acceptScope];
}
