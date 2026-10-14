/** Pure graph model: edges at a chapter and a small force layout. */
import { linksToTargets, splitList } from "../codex/parse";
import { resolveState } from "../codex/state";
import type { Entity } from "../codex/types";

export type EdgeKind = "rel" | "together" | "at";

export interface GraphEdge {
	id: string;
	a: string;
	b: string;
	kind: EdgeKind;
	label: string;
}

function pairKey(a: string, b: string) {
	return a < b ? [a, b] : [b, a];
}

/**
 * Edges active at `chapter` among `entities` (already filtered by type).
 * Relationships A→B and B→A merge into one edge; both labels are shown when they differ.
 */
export function edgesAt(entities: Entity[], chapter: number, opts: { together: boolean; presence: boolean }): GraphEdge[] {
	const byName = new Map<string, Entity>();
	for (const e of entities) {
		byName.set(e.name.toLowerCase(), e);
		for (const a of e.aliases) if (!byName.has(a.toLowerCase())) byName.set(a.toLowerCase(), e);
	}
	const find = (n: string) => byName.get(linksToTargets(n).trim().toLowerCase());

	const rel = new Map<string, { a: string; b: string; labels: Map<string, string> }>();
	const states = new Map(entities.map((e) => [e.name, resolveState(e, chapter)]));
	for (const e of entities) {
		for (const r of states.get(e.name)?.relationships ?? []) {
			const t = find(r.target);
			if (!t || t === e) continue;
			const [a, b] = pairKey(e.name, t.name);
			const key = `${a}\u0000${b}`;
			const entry = rel.get(key) ?? { a, b, labels: new Map() };
			entry.labels.set(e.name, r.label);
			rel.set(key, entry);
		}
	}
	const edges: GraphEdge[] = [];
	for (const { a, b, labels } of rel.values()) {
		const la = labels.get(a);
		const lb = labels.get(b);
		const label = la && lb && la !== lb ? `${la} / ${lb}` : (la ?? lb ?? "");
		edges.push({ id: `rel:${a}:${b}:${label}`, a, b, kind: "rel", label });
	}

	if (opts.together || opts.presence) {
		const chars = entities.filter((e) => e.type === "character");
		const locOf = new Map<string, Entity | undefined>();
		for (const c of chars) {
			const loc = states.get(c.name)?.fields.location;
			locOf.set(c.name, loc ? find(loc) : undefined);
		}
		if (opts.presence) {
			for (const c of chars) {
				const l = locOf.get(c.name);
				if (l) edges.push({ id: `at:${c.name}:${l.name}`, a: c.name, b: l.name, kind: "at", label: "" });
			}
		}
		if (opts.together) {
			const seen = new Set<string>();
			const add = (x: string, y: string, why: string) => {
				const [a, b] = pairKey(x, y);
				const key = `${a}\u0000${b}`;
				if (seen.has(key)) return;
				seen.add(key);
				edges.push({ id: `together:${a}:${b}`, a, b, kind: "together", label: why });
			};
			for (let i = 0; i < chars.length; i++) {
				for (let j = i + 1; j < chars.length; j++) {
					const li = locOf.get(chars[i].name);
					if (li && li === locOf.get(chars[j].name)) add(chars[i].name, chars[j].name, "");
				}
				const w = states.get(chars[i].name)?.fields.with;
				if (w) for (const n of splitList(w)) {
					const other = find(n);
					if (other && other !== chars[i] && other.type === "character") add(chars[i].name, other.name, "");
				}
			}
		}
	}
	return edges;
}

/** Every relationship pair across all chapters, for a layout that doesn't move while scrubbing. */
export function allPairs(entities: Entity[], chapters: number[]): [string, string][] {
	const seen = new Map<string, [string, string]>();
	for (const ch of [...chapters, Infinity]) {
		for (const e of edgesAt(entities, ch, { together: true, presence: true })) seen.set(`${e.a}\u0000${e.b}`, [e.a, e.b]);
	}
	return Array.from(seen.values());
}

export interface Point {
	x: number;
	y: number;
}

/** Deterministic pseudo-random so the first layout is the same every time. */
function seeded(seed: number) {
	let s = seed;
	return () => {
		s = (s * 1664525 + 1013904223) % 4294967296;
		return s / 4294967296;
	};
}

/**
 * Repulsion + springs + centering. Existing positions are kept (and only nudged when `fixed` is false),
 * so adding a node doesn't reshuffle the graph.
 */
export function forceLayout(
	nodes: string[],
	edges: [string, string][],
	opts: { width: number; height: number; iterations?: number; existing?: Map<string, Point>; fixExisting?: boolean },
): Map<string, Point> {
	const { width, height } = opts;
	const rand = seeded(nodes.length * 7919 + edges.length);
	const pos = new Map<string, Point>();
	const fixed = new Set<string>();
	const cx = width / 2;
	const cy = height / 2;
	nodes.forEach((n, i) => {
		const prev = opts.existing?.get(n);
		if (prev) {
			pos.set(n, { ...prev });
			if (opts.fixExisting) fixed.add(n);
		} else {
			const angle = (i / Math.max(1, nodes.length)) * Math.PI * 2;
			const r = Math.min(width, height) * 0.3 * (0.6 + rand() * 0.4);
			pos.set(n, { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
		}
	});
	const k = Math.sqrt((width * height) / Math.max(1, nodes.length)) * 0.75;
	const iterations = opts.iterations ?? 300;
	let temp = Math.min(width, height) / 8;
	for (let it = 0; it < iterations; it++) {
		const disp = new Map<string, Point>(nodes.map((n) => [n, { x: 0, y: 0 }]));
		for (let i = 0; i < nodes.length; i++) {
			for (let j = i + 1; j < nodes.length; j++) {
				const a = pos.get(nodes[i]) as Point;
				const b = pos.get(nodes[j]) as Point;
				let dx = a.x - b.x;
				let dy = a.y - b.y;
				let d = Math.hypot(dx, dy);
				if (d < 0.01) {
					dx = rand() - 0.5;
					dy = rand() - 0.5;
					d = 0.5;
				}
				const f = (k * k) / d;
				const da = disp.get(nodes[i]) as Point;
				const db = disp.get(nodes[j]) as Point;
				da.x += (dx / d) * f;
				da.y += (dy / d) * f;
				db.x -= (dx / d) * f;
				db.y -= (dy / d) * f;
			}
		}
		for (const [s, t] of edges) {
			const a = pos.get(s);
			const b = pos.get(t);
			if (!a || !b) continue;
			const dx = a.x - b.x;
			const dy = a.y - b.y;
			const d = Math.max(0.01, Math.hypot(dx, dy));
			const f = (d * d) / k;
			const da = disp.get(s) as Point;
			const db = disp.get(t) as Point;
			da.x -= (dx / d) * f;
			da.y -= (dy / d) * f;
			db.x += (dx / d) * f;
			db.y += (dy / d) * f;
		}
		for (const n of nodes) {
			if (fixed.has(n)) continue;
			const p = pos.get(n) as Point;
			const d = disp.get(n) as Point;
			d.x += (cx - p.x) * 0.02 * k * 0.1;
			d.y += (cy - p.y) * 0.02 * k * 0.1;
			const len = Math.max(0.01, Math.hypot(d.x, d.y));
			p.x += (d.x / len) * Math.min(len, temp);
			p.y += (d.y / len) * Math.min(len, temp);
			p.x = Math.min(width - 40, Math.max(40, p.x));
			p.y = Math.min(height - 30, Math.max(30, p.y));
		}
		temp = Math.max(0.5, temp * 0.985);
	}
	return pos;
}
