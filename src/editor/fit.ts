import type { EditorView } from "@codemirror/view";

/**
 * Keep a hover card inside the editor pane. CodeMirror keeps tooltips inside the window, but a pane
 * can be much narrower (sidebars open), and the card would be clipped at its edge.
 */
export function fitInEditor(view: EditorView, dom: HTMLElement) {
	const tip = (dom.closest(".cm-tooltip") as HTMLElement | null) ?? dom;
	const box = view.scrollDOM.getBoundingClientRect();
	const r = tip.getBoundingClientRect();
	let dx = 0;
	if (r.right > box.right - 8) dx = box.right - 8 - r.right;
	if (r.left + dx < box.left + 8) dx = box.left + 8 - r.left;
	if (Math.abs(dx) > 0.5) tip.style.left = `${(parseFloat(tip.style.left) || 0) + dx}px`;
}
