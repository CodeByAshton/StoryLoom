import { hoverTooltip, type Tooltip } from "@codemirror/view";
import { editorInfoField } from "obsidian";
import type MotifPlugin from "../main";
import { renderEntityPeek } from "../views/props";
import { frontmatterEnd, shouldHighlight } from "./highlight";
import { noteAt } from "./writingNotes";
import { fitInEditor } from "./fit";

export function entityHover(plugin: MotifPlugin) {
	return hoverTooltip(
		(view, pos): Tooltip | null => {
			const re = plugin.index.nameRegex;
			if (!re || !shouldHighlight(plugin, view)) return null;
			if (noteAt(plugin, view, pos)) return null; // a writing note's card takes this spot
			if (pos < frontmatterEnd(view.state.doc.sliceString(0, Math.min(view.state.doc.length, 5000)))) return null;
			const line = view.state.doc.lineAt(pos);
			const local = new RegExp(re.source, re.flags);
			for (const m of line.text.matchAll(local)) {
				const start = line.from + (m.index ?? 0);
				const end = start + m[0].length;
				if (pos < start || pos > end) continue;
				const name = plugin.index.names.get(m[0]);
				const entity = name ? plugin.index.entities.get(name) : undefined;
				if (!entity) return null;
				const file = view.state.field(editorInfoField, false)?.file;
				const asOf = plugin.index.asOf(file?.path);
				return {
					pos: start,
					end,
					above: false,
					create: () => {
						const dom = createDiv({ cls: "storyloom-hover" });
						renderEntityPeek(dom, entity, asOf, {
							handlers: {
								openNote: (e) => void plugin.app.workspace.openLinkText(e.path, file?.path ?? "", false),
								addTimeline: (e) => plugin.addTimelineEntry(e, asOf),
								openLink: (t) => void plugin.app.workspace.openLinkText(t, file?.path ?? "", false),
							},
						});
						// CodeMirror wraps hover sections in its own .cm-tooltip box; make that wrapper invisible.
						return { dom, mount: () => dom.closest(".cm-tooltip")?.addClass("storyloom-hover-host"), positioned: () => fitInEditor(view, dom) };
					},
				};
			}
			return null;
		},
		{ hoverTime: 350, hideOnChange: true },
	);
}
