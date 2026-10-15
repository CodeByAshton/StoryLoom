/** Sets up a vault for Storyloom: folders, a Book note and templates. Never overwrites anything. */
import { normalizePath, type App } from "obsidian";
import { ensureFolder } from "./codex/apply";
import type { StoryloomSettings } from "./settings";

export const TEMPLATES: Record<string, string> = {
	Chapter: `---\ntype: chapter\nchapter:\ntitle: "{{title}}"\npov: ""\nsummary: ""\nstatus: draft\n---\n\n`,
	Character: `---\ntype: character\naliases: []\nrole: ""\n---\n\n# {{title}}\n\n## Description\n\n## Voice\n\n## Relationships\n\n## Timeline\n`,
	Location: `---\ntype: location\naliases: []\n---\n\n# {{title}}\n\n## Description\n\n## Relationships\n\n## Timeline\n`,
	Lore: `---\ntype: lore\naliases: []\n---\n\n# {{title}}\n\n## Description\n\n## Relationships\n\n## Timeline\n`,
};

export function bookNote(title: string): string {
	return `---
title: ${JSON.stringify(title)}
---

# ${title}

## Premise
What the book is about, in a few sentences.

## Genre and tone

## Style guide
- Point of view and tense:
- Things to always / never do:

## Voice sample
Paste a paragraph or two written in the book's voice. The AI matches it when it writes.
`;
}

export interface ScaffoldPlan {
	folders: string[];
	files: { path: string; content: string }[];
}

/** What's missing. Pure apart from the existence check passed in. */
export function planScaffold(s: Pick<StoryloomSettings, "manuscriptFolder" | "codexFolder" | "templatesFolder" | "bookPath">, exists: (path: string) => boolean, bookTitle = "My Book"): ScaffoldPlan {
	const folders = [s.manuscriptFolder, `${s.codexFolder}/Characters`, `${s.codexFolder}/Locations`, `${s.codexFolder}/Lore`, s.templatesFolder]
		.map((f) => normalizePath(f))
		.filter((f) => !exists(f));
	const files = [
		{ path: normalizePath(s.bookPath), content: bookNote(bookTitle) },
		...Object.entries(TEMPLATES).map(([name, content]) => ({ path: normalizePath(`${s.templatesFolder}/${name}.md`), content })),
	].filter((f) => !exists(f.path));
	return { folders, files };
}

export async function applyScaffold(app: App, plan: ScaffoldPlan) {
	for (const f of plan.folders) await ensureFolder(app, f);
	for (const f of plan.files) {
		const dir = f.path.split("/").slice(0, -1).join("/");
		if (dir) await ensureFolder(app, dir);
		if (!app.vault.getAbstractFileByPath(f.path)) await app.vault.create(f.path, f.content);
	}
}
