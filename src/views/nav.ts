import { setIcon, type WorkspaceLeaf } from "obsidian";

/** The four main Storyloom views. Kept as strings so views can import this without cycles. */
export const MAIN_VIEWS = [
	{ type: "storyloom-chapters", label: "Chapters", icon: "layout-grid" },
	{ type: "storyloom-codex", label: "Codex", icon: "library" },
	{ type: "storyloom-timeline", label: "Timeline", icon: "table" },
	{ type: "storyloom-graph", label: "Graph", icon: "network" },
] as const;

/** Tab bar that switches between the main views in the same pane, so they feel like one app. */
export function renderNav(parent: HTMLElement, leaf: WorkspaceLeaf, current: string): HTMLElement {
	const nav = parent.createDiv({ cls: "sl-nav", attr: { role: "tablist" } });
	for (const v of MAIN_VIEWS) {
		const tab = nav.createEl("button", { cls: `sl-nav-tab${v.type === current ? " is-active" : ""}`, attr: { role: "tab", "aria-selected": String(v.type === current), "aria-label": v.label } });
		setIcon(tab.createSpan({ cls: "sl-nav-icon" }), v.icon);
		tab.createSpan({ cls: "sl-nav-label", text: v.label });
		if (v.type !== current) tab.addEventListener("click", () => void switchTo(leaf, v.type));
	}
	return nav;
}

/** Show the view in this pane, or jump to it if it's already open somewhere else. */
async function switchTo(leaf: WorkspaceLeaf, type: string) {
	const ws = leaf.view.app.workspace;
	const other = ws.getLeavesOfType(type)[0];
	if (other) return ws.revealLeaf(other);
	await leaf.setViewState({ type, active: true });
}

/** A quiet one-line summary next to the tabs ("3 chapters · 1,174 words"), instead of big stat blocks. */
export function renderMeta(parent: HTMLElement, parts: (string | false | null | undefined)[]): HTMLElement {
	return parent.createDiv({ cls: "sl-meta", text: parts.filter(Boolean).join(" · ") });
}

export function plural(n: number, word: string): string {
	return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}
