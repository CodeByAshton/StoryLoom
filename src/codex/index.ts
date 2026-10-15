import { App, debounce, Events, normalizePath, TFile, type CachedMetadata, type EventRef } from "obsidian";
import { buildNameRegex, normalizeAliases, parseDescription, parseRelationships, parseTimeline, parseWikilink, sectionText, stripWikilinks } from "./parse";
import { resolveState } from "./state";
import { isEntityType, type ChapterInfo, type Entity, type ResolvedState } from "./types";

export interface IndexSettings {
	manuscriptFolder: string;
	codexFolder: string;
	templatesFolder: string;
	debug: boolean;
}

/**
 * Builds and caches entities and chapters from the vault. Everything is derived from notes;
 * nothing is stored elsewhere. Emits "changed" (debounced) whenever the index updates.
 */
export class CodexIndex extends Events {
	entities = new Map<string, Entity>();
	chapters: ChapterInfo[] = [];
	/** name or alias -> entity name */
	names = new Map<string, string>();
	nameRegex: RegExp | null = null;
	ready = false;

	private byPath = new Map<string, string>();
	private emitChanged = debounce(() => this.trigger("changed"), 150, true);

	constructor(
		private app: App,
		private settings: () => IndexSettings,
	) {
		super();
	}

	/** `register` should be Plugin.registerEvent so listeners are removed on unload. */
	async load(register: (ref: EventRef) => void) {
		await this.rebuild();
		const mc = this.app.metadataCache;
		const vault = this.app.vault;
		[
			mc.on("changed", (file) => void this.onFileChanged(file)),
			vault.on("delete", (f) => {
				if (f instanceof TFile) this.onFileRemoved(f.path);
			}),
			vault.on("rename", (f, oldPath) => {
				this.onFileRemoved(oldPath);
				if (f instanceof TFile) void this.onFileChanged(f);
			}),
		].forEach(register);
	}

	inFolder(path: string, folder: string): boolean {
		const f = normalizePath(folder);
		return f === "/" || f === "" || path === f || path.startsWith(f + "/");
	}

	async rebuild() {
		this.entities.clear();
		this.byPath.clear();
		this.chapters = [];
		for (const file of this.app.vault.getMarkdownFiles()) await this.indexFile(file);
		this.ready = true;
		this.finish();
	}

	/**
	 * Re-index one file, and only broadcast if what Storyloom derives from it changed.
	 * Typing in a chapter autosaves every couple of seconds; the prose itself isn't indexed,
	 * so those saves cost one fingerprint comparison instead of a full refresh of every view.
	 */
	private async onFileChanged(file: TFile) {
		if (file.extension !== "md") return;
		const before = this.fingerprint(file.path);
		this.removePath(file.path);
		await this.indexFile(file);
		if (this.fingerprint(file.path) !== before) this.finish();
	}

	private fingerprint(path: string): string {
		const name = this.byPath.get(path);
		const entity = name ? this.entities.get(name) : undefined;
		const chapter = this.chapters.find((c) => c.path === path);
		if (!entity && !chapter) return "";
		const inf = (_k: string, v: unknown) => (v === Infinity ? "+inf" : v === -Infinity ? "-inf" : v);
		return JSON.stringify([entity, chapter], inf);
	}

	private onFileRemoved(path: string) {
		if (this.removePath(path)) this.finish();
	}

	private removePath(path: string): boolean {
		let changed = false;
		const name = this.byPath.get(path);
		if (name) {
			this.entities.delete(name);
			this.byPath.delete(path);
			changed = true;
		}
		const before = this.chapters.length;
		this.chapters = this.chapters.filter((c) => c.path !== path);
		return changed || before !== this.chapters.length;
	}

	private async indexFile(file: TFile) {
		const s = this.settings();
		if (s.templatesFolder && this.inFolder(file.path, s.templatesFolder)) return;
		const cache = this.app.metadataCache.getFileCache(file);
		const fm = cache?.frontmatter ?? {};
		if (this.inFolder(file.path, s.codexFolder) && isEntityType(fm.type)) {
			this.addEntity(file, fm, await this.app.vault.cachedRead(file));
		} else {
			const ch = this.chapterFromMeta(file, cache);
			if (ch) this.chapters.push(ch);
		}
	}

	private addEntity(file: TFile, fm: Record<string, unknown>, text: string) {
		const warn = (m: string) => console.warn(`[Storyloom] ${file.path}: ${m}`);
		const entity: Entity = {
			name: file.basename,
			path: file.path,
			type: fm.type as Entity["type"],
			aliases: normalizeAliases(fm.aliases ?? fm.alias),
			role: typeof fm.role === "string" ? fm.role : undefined,
			description: parseDescription(text),
			voice: sectionText(text, "Voice"),
			relationships: parseRelationships(text, warn),
			timeline: parseTimeline(text, warn),
		};
		this.entities.set(entity.name, entity);
		this.byPath.set(file.path, entity.name);
	}

	chapterFromMeta(file: TFile, cache: CachedMetadata | null): ChapterInfo | null {
		const fm = cache?.frontmatter;
		if (!fm) return null;
		const isChapter = fm.type === "chapter" || (this.inFolder(file.path, this.settings().manuscriptFolder) && fm.chapter !== undefined);
		if (!isChapter) return null;
		const raw = fm.chapter;
		const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
		if (!Number.isFinite(n)) return null;
		const pov = typeof fm.pov === "string" ? (parseWikilink(fm.pov) ?? stripWikilinks(fm.pov)) : undefined;
		return {
			path: file.path,
			basename: file.basename,
			chapter: n,
			title: typeof fm.title === "string" && fm.title ? fm.title : file.basename,
			pov,
			summary: typeof fm.summary === "string" ? fm.summary : undefined,
			status: typeof fm.status === "string" ? fm.status : undefined,
		};
	}

	private finish() {
		this.chapters.sort((a, b) => a.chapter - b.chapter || a.path.localeCompare(b.path));
		this.names.clear();
		for (const e of this.entities.values()) {
			for (const n of [e.name, ...e.aliases]) if (!this.names.has(n)) this.names.set(n, e.name);
		}
		this.nameRegex = buildNameRegex(Array.from(this.names.keys()));
		if (this.settings().debug) console.log(`[Storyloom] index: ${this.entities.size} entities, ${this.chapters.length} chapters`);
		this.emitChanged();
	}

	// ---------- Queries ----------

	getEntity(nameOrAlias: string): Entity | undefined {
		const target = parseWikilink(nameOrAlias) ?? nameOrAlias.trim();
		const name = this.names.get(target) ?? this.names.get(stripWikilinks(target));
		if (name) return this.entities.get(name);
		// Case-insensitive fallback, for AI output.
		const lower = target.toLowerCase();
		for (const [n, en] of this.names) if (n.toLowerCase() === lower) return this.entities.get(en);
		return undefined;
	}

	resolve(entity: Entity, chapter: number): ResolvedState {
		return resolveState(entity, chapter);
	}

	chapterForPath(path: string | undefined | null): ChapterInfo | undefined {
		if (!path) return undefined;
		return this.chapters.find((c) => c.path === path);
	}

	/** Chapter number for "as of" lookups: the chapter's number, or Infinity for non-chapter notes. */
	asOf(path: string | undefined | null): number {
		return this.chapterForPath(path)?.chapter ?? Infinity;
	}

	chapterByNumber(n: number): ChapterInfo | undefined {
		return this.chapters.find((c) => c.chapter === n);
	}

	get lastChapter(): number {
		return this.chapters.length ? this.chapters[this.chapters.length - 1].chapter : 0;
	}

	/** Entity names mentioned in `text` (names and aliases, whole word, case-sensitive). */
	mentionsIn(text: string): Set<string> {
		const out = new Set<string>();
		if (!this.nameRegex) return out;
		const re = new RegExp(this.nameRegex.source, this.nameRegex.flags);
		for (const m of text.matchAll(re)) {
			const n = this.names.get(m[0]);
			if (n) out.add(n);
		}
		// Explicit wikilinks count too.
		for (const m of text.matchAll(/\[\[([^\]|#]+)/g)) {
			const e = this.getEntity(m[1]);
			if (e) out.add(e.name);
		}
		return out;
	}

	sortedEntities(): Entity[] {
		const order = ["character", "location", "lore", "faction", "item"];
		return Array.from(this.entities.values()).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.name.localeCompare(b.name));
	}

	fileFor(path: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(path);
		return f instanceof TFile ? f : null;
	}
}
