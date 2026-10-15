import { App, normalizePath, TFile } from "obsidian";
import type { ApprovedChanges } from "../modals/stateReviewModal";
import type { EntityRow } from "../modals/entityReviewModal";
import type { CodexIndex } from "./index";
import { parseRelationships, parseTimeline } from "./parse";
import { appendToSection, closeOpenRelationships, dedupeTimeline, fillEntityTemplate, formatRelationshipLine, formatTimelineLine, hasActiveRelationship, safeFileName, TYPE_FOLDERS } from "./write";

export interface ApplyPaths {
	codexFolder: string;
	templatesFolder: string;
}

export async function ensureFolder(app: App, path: string) {
	const parts = normalizePath(path).split("/");
	let cur = "";
	for (const p of parts) {
		cur = cur ? `${cur}/${p}` : p;
		if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur);
	}
}

export async function readTemplate(app: App, folder: string, type: string): Promise<string | null> {
	const name = type.charAt(0).toUpperCase() + type.slice(1);
	const f = app.vault.getAbstractFileByPath(normalizePath(`${folder}/${name}.md`));
	return f instanceof TFile ? app.vault.read(f) : null;
}

/** Create Codex notes for new entities. Returns name -> path for the ones created (or already present). */
export async function createEntities(app: App, index: CodexIndex, paths: ApplyPaths, rows: EntityRow[]): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const row of rows) {
		const existing = index.getEntity(row.name);
		if (existing) {
			out.set(row.name, existing.path);
			continue;
		}
		const folder = normalizePath(`${paths.codexFolder}/${TYPE_FOLDERS[row.type] ?? "Lore"}`);
		await ensureFolder(app, folder);
		const path = normalizePath(`${folder}/${safeFileName(row.name)}.md`);
		const f = app.vault.getAbstractFileByPath(path);
		if (!f) {
			const tpl = await readTemplate(app, paths.templatesFolder, row.type);
			await app.vault.create(path, fillEntityTemplate(tpl, row));
		}
		out.set(row.name, path);
	}
	return out;
}

/**
 * Write approved changes. Each note is re-read inside `vault.process` and deduped against its
 * current text, so applying the same changes twice writes nothing the second time.
 */
export async function applyChanges(app: App, index: CodexIndex, paths: ApplyPaths, changes: ApprovedChanges) {
	const created = await createEntities(app, index, paths, changes.newEntities);
	const pathFor = (name: string) => index.getEntity(name)?.path ?? created.get(name);
	const ch = changes.chapter;
	let lines = 0;
	let rels = 0;
	const touched = new Set<string>();

	for (const t of changes.timeline) {
		const file = fileAt(app, pathFor(t.entity));
		if (!file) continue;
		await app.vault.process(file, (text) => {
			const source = { timeline: parseTimeline(text), relationships: [] };
			const d = dedupeTimeline(source, ch, { fields: t.fields, note: t.note });
			if (!d) return text;
			lines++;
			touched.add(t.entity);
			return appendToSection(text, "Timeline", [formatTimelineLine(ch, d.fields, d.note)]);
		});
	}

	for (const r of changes.relationships) {
		const file = fileAt(app, pathFor(r.from));
		if (!file) continue;
		await app.vault.process(file, (text) => {
			const source = { timeline: [], relationships: parseRelationships(text) };
			if (hasActiveRelationship(source, r.to, r.label, r.fromChapter)) return text;
			let next = r.endsPrevious ? closeOpenRelationships(text, r.to, r.fromChapter - 1, r.label) : text;
			next = appendToSection(next, "Relationships", [formatRelationshipLine(r.to, r.label, { from: r.fromChapter, to: Infinity })]);
			rels++;
			touched.add(r.from);
			return next;
		});
	}

	return { created: changes.newEntities.filter((e) => !index.getEntity(e.name)).length, lines, rels, touched: Array.from(touched) };
}

function fileAt(app: App, path?: string): TFile | null {
	if (!path) return null;
	const f = app.vault.getAbstractFileByPath(path);
	return f instanceof TFile ? f : null;
}
