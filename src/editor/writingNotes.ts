import { StateEffect, type Extension } from "@codemirror/state";
import { closeHoverTooltips, Decoration, EditorView, hoverTooltip, ViewPlugin, type DecorationSet, type Tooltip, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, setIcon } from "obsidian";
import type StoryloomPlugin from "../main";
import { fitInEditor } from "./fit";
import { frontmatterEnd } from "./highlight";
import { locateNotes, NOTE_KINDS, type LocatedNote } from "../notes/model";

/** Dispatched to every editor when a chapter's writing notes change. */
export const refreshNotes = StateEffect.define<null>();

function located(plugin: StoryloomPlugin, view: EditorView): LocatedNote[] {
	const path = view.state.field(editorInfoField, false)?.file?.path;
	if (!path) return [];
	const notes = plugin.notesFor(path);
	if (!notes.length) return [];
	// Notes belong to the prose: never underline (or fix) a match inside the frontmatter.
	const doc = view.state.doc.toString();
	const start = frontmatterEnd(doc);
	return locateNotes(doc.slice(start), notes, start);
}

/** The writing note under a position, if any (the entity hover card stays out of the way there). */
export function noteAt(plugin: StoryloomPlugin, view: EditorView, pos: number): LocatedNote | undefined {
	return located(plugin, view).find((l) => pos >= l.from && pos <= l.to);
}

/** Wavy underlines under each note (like a spell checker), and a card with Fix / Dismiss on hover. */
export function writingNotesExtension(plugin: StoryloomPlugin): Extension {
	const marks = new Map<string, Decoration>();
	const markFor = (kind: string) => {
		let m = marks.get(kind);
		if (!m) {
			m = Decoration.mark({ class: `sl-wn sl-wn-${kind}` });
			marks.set(kind, m);
		}
		return m;
	};
	const build = (view: EditorView): DecorationSet => Decoration.set(located(plugin, view).map((l) => markFor(l.note.kind).range(l.from, l.to)));

	const underline = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = build(view);
			}
			update(u: ViewUpdate) {
				if (u.docChanged || u.transactions.some((t) => t.effects.some((e) => e.is(refreshNotes)))) this.decorations = build(u.view);
			}
		},
		{ decorations: (v) => v.decorations },
	);

	const hover = hoverTooltip(
		(view, pos): Tooltip | null => {
			const hit = noteAt(plugin, view, pos);
			if (!hit) return null;
			const path = view.state.field(editorInfoField, false)?.file?.path ?? "";
			return {
				pos: hit.from,
				end: hit.to,
				above: false,
				create: () => {
					const dom = renderNoteCard(plugin, view, path, hit);
					return { dom, mount: () => dom.closest(".cm-tooltip")?.addClass("storyloom-hover-host"), positioned: () => fitInEditor(view, dom) };
				},
			};
		},
		{ hoverTime: 250, hideOnChange: true },
	);

	return [underline, hover];
}

function renderNoteCard(plugin: StoryloomPlugin, view: EditorView, path: string, hit: LocatedNote): HTMLElement {
	const { note } = hit;
	const kind = NOTE_KINDS[note.kind];
	const dom = createDiv({ cls: `storyloom-hover sl-wn-card is-${note.kind}` });
	const head = dom.createDiv({ cls: "sl-wn-head" });
	setIcon(head.createSpan({ cls: "sl-wn-icon" }), kind.icon);
	head.createSpan({ cls: "sl-wn-kind", text: kind.label });
	dom.createDiv({ cls: "sl-wn-message", text: note.message });
	if (note.suggestion) {
		const fix = dom.createDiv({ cls: "sl-wn-fix" });
		fix.createSpan({ cls: "sl-wn-old", text: note.quote });
		setIcon(fix.createSpan({ cls: "sl-wn-arrow" }), "arrow-right");
		fix.createSpan({ cls: "sl-wn-new", text: note.suggestion });
	}
	const actions = dom.createDiv({ cls: "sl-wn-actions" });
	const button = (label: string, icon: string, primary: boolean, onClick: () => void) => {
		const b = actions.createEl("button", { cls: `storyloom-glass-btn${primary ? " is-primary" : ""}` });
		setIcon(b.createSpan({ cls: "storyloom-glass-icon" }), icon);
		b.createSpan({ text: label });
		b.addEventListener("mousedown", (e) => e.preventDefault());
		b.addEventListener("click", onClick);
	};
	if (note.suggestion) {
		button("Fix", "check", true, () => {
			// Use the spot that was hovered; only re-find it if the text has moved since the card opened.
			const now = view.state.doc.sliceString(hit.from, hit.to) === note.quote ? hit : located(plugin, view).find((l) => l.note === note);
			if (now) view.dispatch({ changes: { from: now.from, to: now.to, insert: note.suggestion }, userEvent: "input.storyloom-fix" });
			void plugin.removeNote(path, note);
			view.dispatch({ effects: closeHoverTooltips });
		});
	}
	button("Dismiss", "x", !note.suggestion, () => {
		void plugin.removeNote(path, note);
		view.dispatch({ effects: closeHoverTooltips });
	});
	return dom;
}
