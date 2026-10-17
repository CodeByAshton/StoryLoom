export interface EmptyAction {
	label: string;
	/** Kept for callers; the monochrome design shows text only. */
	icon?: string;
	onClick: () => void;
	cta?: boolean;
}

/** A friendly empty state: one line of what's missing, one of why it matters, and buttons that fix it. */
export function renderEmpty(parent: HTMLElement, o: { icon?: string; title: string; body: string; actions?: EmptyAction[] }): HTMLElement {
	const el = parent.createDiv({ cls: "sl-empty" });
	el.createDiv({ cls: "sl-empty-title", text: o.title });
	el.createDiv({ cls: "sl-empty-body", text: o.body });
	if (o.actions?.length) {
		const row = el.createDiv({ cls: "sl-empty-actions" });
		for (const a of o.actions) {
			const b = row.createEl("button", { cls: a.cta ? "mod-cta" : "", text: a.label });
			b.addEventListener("click", a.onClick);
		}
	}
	return el;
}
