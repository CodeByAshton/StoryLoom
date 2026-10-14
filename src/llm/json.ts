/** Robust JSON extraction from model output. Pure; no Obsidian imports. */

export class JsonExtractError extends Error {}

/** Remove trailing commas before `}` or `]`, ignoring commas inside strings. */
export function stripTrailingCommas(text: string): string {
	let out = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			out += c;
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') {
			inString = true;
			out += c;
			continue;
		}
		if (c === ",") {
			let j = i + 1;
			while (j < text.length && /\s/.test(text[j])) j++;
			if (text[j] === "}" || text[j] === "]") continue;
		}
		out += c;
	}
	return out;
}

/** The outermost balanced `{...}` (or `[...]`) starting at the first opener. */
export function outermostBlock(text: string, open = "{", close = "}"): string | null {
	const start = text.indexOf(open);
	if (start === -1) return null;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (c === "\\") escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === open) depth++;
		else if (c === close) {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

/** Extract and parse the first ```json block, or the outermost `{…}`. Throws JsonExtractError. */
export function extractJson(text: string): unknown {
	const candidates: string[] = [];
	const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(text);
	if (fence) candidates.push(fence[1].trim());
	const obj = outermostBlock(text);
	if (obj) candidates.push(obj);
	candidates.push(text.trim());
	for (const c of candidates) {
		for (const attempt of [c, stripTrailingCommas(c), stripTrailingCommas(normalizeQuotes(c))]) {
			try {
				return JSON.parse(attempt);
			} catch {
				/* try next */
			}
		}
	}
	throw new JsonExtractError("The model did not return valid JSON.");
}

/** Curly quotes used as JSON delimiters are a common model glitch. */
function normalizeQuotes(s: string): string {
	return s.replace(/[“”]/g, '"');
}

// ---------- Shape validation for the story-state update ----------

export interface StateUpdate {
	timeline: { entity: string; fields: Record<string, string | null>; note?: string }[];
	relationships: { from: string; to: string; label: string; fromChapter?: number; endsPrevious?: boolean }[];
	newEntities: { name: string; type: string; description: string; aliases: string[] }[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);

/** Validate and normalise. Throws JsonExtractError with a readable reason if the shape is unusable. */
export function validateStateUpdate(raw: unknown): StateUpdate {
	if (!isObj(raw)) throw new JsonExtractError("Expected a JSON object.");
	const out: StateUpdate = { timeline: [], relationships: [], newEntities: [] };
	for (const key of ["timeline", "relationships", "newEntities"]) {
		if (raw[key] !== undefined && !Array.isArray(raw[key])) throw new JsonExtractError(`"${key}" must be an array.`);
	}
	if (raw.timeline === undefined && raw.relationships === undefined && raw.newEntities === undefined) {
		throw new JsonExtractError('Expected "timeline", "relationships" or "newEntities".');
	}
	for (const t of (raw.timeline as unknown[]) ?? []) {
		if (!isObj(t)) continue;
		const entity = str(t.entity);
		if (!entity) continue;
		const fields: Record<string, string | null> = {};
		if (isObj(t.fields)) {
			for (const [k, v] of Object.entries(t.fields)) {
				if (v === null) fields[k.toLowerCase()] = null;
				else if (Array.isArray(v)) fields[k.toLowerCase()] = v.map(String).join(", ");
				else if (str(v) !== undefined) fields[k.toLowerCase()] = str(v) as string;
			}
		}
		const note = str(t.note);
		if (Object.keys(fields).length === 0 && !note) continue;
		out.timeline.push({ entity, fields, note: note || undefined });
	}
	for (const r of (raw.relationships as unknown[]) ?? []) {
		if (!isObj(r)) continue;
		const from = str(r.from);
		const to = str(r.to);
		const label = str(r.label);
		if (!from || !to || !label) continue;
		const fc = typeof r.fromChapter === "number" ? r.fromChapter : Number(r.fromChapter);
		out.relationships.push({
			from,
			to,
			label,
			fromChapter: Number.isFinite(fc) ? fc : undefined,
			endsPrevious: r.endsPrevious === true,
		});
	}
	for (const e of (raw.newEntities as unknown[]) ?? []) {
		if (!isObj(e)) continue;
		const name = str(e.name);
		if (!name) continue;
		out.newEntities.push({
			name,
			type: (str(e.type) ?? "character").toLowerCase(),
			description: str(e.description) ?? "",
			aliases: Array.isArray(e.aliases) ? e.aliases.map(String).filter(Boolean) : [],
		});
	}
	return out;
}

export interface EntityProposal {
	name: string;
	type: string;
	description: string;
	aliases: string[];
}

export function validateEntityList(raw: unknown): EntityProposal[] {
	const list = isObj(raw) ? raw.newEntities ?? raw.entities : raw;
	if (!Array.isArray(list)) throw new JsonExtractError('Expected an array of entities or {"newEntities": [...]}.');
	return validateStateUpdate({ newEntities: list }).newEntities;
}

export interface ContinuityIssue {
	quote: string;
	conflict: string;
	fix: string;
	severity?: string;
}

export function validateContinuity(raw: unknown): ContinuityIssue[] {
	const list = isObj(raw) ? raw.issues : raw;
	if (!Array.isArray(list)) throw new JsonExtractError('Expected {"issues": [...]}.');
	const out: ContinuityIssue[] = [];
	for (const i of list) {
		if (!isObj(i)) continue;
		const quote = str(i.quote) ?? "";
		const conflict = str(i.conflict) ?? str(i.problem) ?? "";
		if (!conflict) continue;
		out.push({ quote, conflict, fix: str(i.fix) ?? str(i.suggestion) ?? "", severity: str(i.severity) });
	}
	return out;
}
