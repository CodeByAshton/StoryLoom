import type { App } from "obsidian";

/** Open Motif's settings tab. Uses Obsidian's settings API, which isn't in the public typings. */
export function openSettings(app: App) {
	const setting = (app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
	setting?.open();
	setting?.openTabById("motif");
}

/** Errors that the user fixes in settings (missing or rejected key, wrong model, no base URL). */
export function isSettingsError(message: string): boolean {
	return /Settings → Motif|model name in settings|No base URL|Max output tokens/.test(message);
}

/** Append an "Open settings" button when the error is one the user fixes in settings. */
export function addSettingsButton(parent: HTMLElement, app: App, message: string, cls = "") {
	if (!isSettingsError(message)) return;
	const b = parent.createEl("button", { cls, text: "Open settings" });
	b.addEventListener("click", () => openSettings(app));
}

/** Give an Obsidian modal (or suggester) Motif's glass look. */
export function glass(modal: { modalEl: HTMLElement; containerEl: HTMLElement }) {
	modal.modalEl.addClass("storyloom-glass-modal");
	modal.containerEl.addClass("storyloom-glass-container");
}

/** Make a clickable element reachable and usable from the keyboard (Tab, then Enter or Space). */
export function focusable<T extends HTMLElement>(el: T, label?: string): T {
	el.tabIndex = 0;
	el.setAttr("role", "button");
	if (label) el.setAttr("aria-label", label);
	el.addEventListener("keydown", (ev) => {
		if (ev.target !== el || (ev.key !== "Enter" && ev.key !== " ")) return;
		ev.preventDefault();
		el.click();
	});
	return el;
}
