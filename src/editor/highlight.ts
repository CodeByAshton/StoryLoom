import { RangeSetBuilder, StateEffect, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import type StoryloomPlugin from "../main";

/** Dispatched to every editor when the codex changes, so decorations rebuild. */
export const refreshEntities = StateEffect.define<null>();

export function frontmatterEnd(doc: string): number {
	if (!doc.startsWith("---")) return 0;
	const m = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(doc);
	return m ? m[0].length : 0;
}

export function shouldHighlight(plugin: StoryloomPlugin, view: EditorView): boolean {
	if (!plugin.settings.highlightEntities) return false;
	const file = view.state.field(editorInfoField, false)?.file;
	if (!file) return false;
	if (plugin.index.chapterForPath(file.path)) return true;
	return plugin.settings.highlightOutsideManuscript;
}

export function entityHighlighter(plugin: StoryloomPlugin): Extension {
	const marks = new Map<string, Decoration>();
	const markFor = (type: string, name: string) => {
		const key = `${type}\u0000${name}`;
		let m = marks.get(key);
		if (!m) {
			m = Decoration.mark({ class: `storyloom-entity storyloom-type-${type}`, attributes: { "data-storyloom-entity": name } });
			marks.set(key, m);
		}
		return m;
	};

	const build = (view: EditorView): DecorationSet => {
		const re = plugin.index.nameRegex;
		if (!re || !shouldHighlight(plugin, view)) return Decoration.none;
		const builder = new RangeSetBuilder<Decoration>();
		const doc = view.state.doc;
		const fmEnd = frontmatterEnd(doc.sliceString(0, Math.min(doc.length, 5000)));
		for (const { from, to } of view.visibleRanges) {
			const start = Math.max(from, fmEnd);
			if (start >= to) continue;
			const text = doc.sliceString(start, to);
			const local = new RegExp(re.source, re.flags);
			for (const m of text.matchAll(local)) {
				const name = plugin.index.names.get(m[0]);
				const e = name ? plugin.index.entities.get(name) : undefined;
				if (!e || m.index === undefined) continue;
				builder.add(start + m.index, start + m.index + m[0].length, markFor(e.type, e.name));
			}
		}
		return builder.finish();
	};

	const viewPlugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = build(view);
			}
			update(u: ViewUpdate) {
				if (u.docChanged || u.viewportChanged || u.transactions.some((t) => t.effects.some((e) => e.is(refreshEntities)))) {
					this.decorations = build(u.view);
				}
			}
		},
		{ decorations: (v) => v.decorations },
	);

	// Ctrl/Cmd+click opens the entity's note.
	const clicks = EditorView.domEventHandlers({
		mousedown(event, view) {
			if (!(event.metaKey || event.ctrlKey) || event.button !== 0) return false;
			const el = (event.target as HTMLElement | null)?.closest?.("[data-storyloom-entity]") as HTMLElement | null;
			const name = el?.dataset.storyloomEntity;
			if (!name) return false;
			const e = plugin.index.entities.get(name);
			if (!e) return false;
			event.preventDefault();
			const src = view.state.field(editorInfoField, false)?.file?.path ?? "";
			void plugin.app.workspace.openLinkText(e.path, src, event.shiftKey ? "split" : false);
			return true;
		},
	});

	return [viewPlugin, clicks];
}
