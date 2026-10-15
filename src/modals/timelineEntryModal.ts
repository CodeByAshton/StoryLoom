import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { resolveState } from "../codex/state";
import { appendToSection, formatTimelineLine } from "../codex/write";
import type { Entity } from "../codex/types";
import { stripWikilinks } from "../codex/parse";
import { glass } from "../ui";

export interface TimelineSuggestions {
	locations: string[];
	characters: string[];
}

const FIELDS = [
	{ key: "location", label: "Location", placeholder: "Where they are now", list: "locations" },
	{ key: "status", label: "Status", placeholder: "e.g. Injured, Missing, Hopeful" },
	{ key: "with", label: "With", placeholder: "Who they're with, comma-separated", list: "characters" },
	{ key: "knows", label: "Learns", placeholder: "Something they find out (adds to what they know)" },
	{ key: "note", label: "Note", placeholder: "One line on what happens" },
] as const;

/**
 * Append a `- ch N | ...` line to an entity's ## Timeline (creating the section if needed).
 * A small form instead of hand-typed syntax: only filled fields are written, "—" clears a value,
 * and the exact line is previewed before saving.
 */
export class TimelineEntryModal extends Modal {
	private values: Record<string, string> = {};
	private chapter: number;

	constructor(
		app: App,
		private entity: Entity,
		chapter: number,
		private suggestions: TimelineSuggestions = { locations: [], characters: [] },
	) {
		super(app);
		glass(this);
		this.chapter = Number.isFinite(chapter) ? chapter : 1;
	}

	private line(): string | null {
		const fields: Record<string, string | null> = {};
		for (const f of FIELDS) {
			if (f.key === "note") continue;
			const v = (this.values[f.key] ?? "").trim();
			if (!v) continue;
			fields[f.key] = /^(—|-|none)$/i.test(v) ? null : this.linkify(f.key, v);
		}
		const note = (this.values.note ?? "").trim();
		if (!Object.keys(fields).length && !note) return null;
		return formatTimelineLine(this.chapter, fields, note || undefined);
	}

	/** Known names become wikilinks, so the graph and cards can follow them. */
	private linkify(key: string, value: string): string {
		const known = key === "location" ? this.suggestions.locations : key === "with" ? this.suggestions.characters : [];
		if (!known.length) return value;
		return value
			.split(",")
			.map((part) => {
				const t = part.trim();
				const hit = known.find((k) => k.toLowerCase() === stripWikilinks(t).toLowerCase());
				return hit && !t.startsWith("[[") ? `[[${hit}]]` : t;
			})
			.join(", ");
	}

	onOpen() {
		this.modalEl.addClass("storyloom-timeline-modal");
		this.titleEl.setText(`${this.entity.name} — timeline`);
		const current = resolveState(this.entity, this.chapter);
		const { contentEl } = this;
		const preview = createDiv({ cls: "storyloom-timeline-preview" });
		const refresh = () => {
			const l = this.line();
			preview.setText(l ?? "Fill in anything that changes in this chapter.");
			preview.toggleClass("is-empty", !l);
		};

		new Setting(contentEl).setName("Chapter").addText((t) => {
			t.inputEl.type = "number";
			t.setValue(String(this.chapter)).onChange((v) => {
				const n = Number(v);
				if (Number.isFinite(n) && n > 0) this.chapter = n;
				refresh();
			});
		});

		for (const list of ["locations", "characters"] as const) {
			const dl = contentEl.createEl("datalist", { attr: { id: `storyloom-dl-${list}` } });
			for (const n of this.suggestions[list]) dl.createEl("option", { value: n });
		}

		let first: HTMLInputElement | null = null;
		for (const f of FIELDS) {
			const now = f.key === "knows" ? current.knows.map(stripWikilinks).join("; ") : current.fields[f.key];
			const s = new Setting(contentEl).setName(f.label);
			if (now && f.key !== "note") s.setDesc(`Now: ${stripWikilinks(now)}`);
			s.addText((t) => {
				t.setPlaceholder(f.placeholder).onChange((v) => {
					this.values[f.key] = v;
					refresh();
				});
				if ("list" in f) t.inputEl.setAttr("list", `storyloom-dl-${f.list}`);
				t.inputEl.addEventListener("keydown", (e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						void this.save();
					}
				});
				first ??= t.inputEl;
			});
		}

		contentEl.createDiv({ cls: "storyloom-muted", text: "Will add this line (type — to clear a value):" });
		contentEl.appendChild(preview);
		refresh();

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Add to timeline").setCta().onClick(() => void this.save()));
		window.setTimeout(() => (first as HTMLInputElement | null)?.focus(), 0);
	}

	private async save() {
		const line = this.line();
		if (!line) {
			new Notice("Fill in at least one field.");
			return;
		}
		const f = this.app.vault.getAbstractFileByPath(this.entity.path);
		if (!(f instanceof TFile)) return;
		await this.app.vault.process(f, (text) => appendToSection(text, "Timeline", [line]));
		new Notice(`Added to ${this.entity.name}'s timeline.`);
		this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}
