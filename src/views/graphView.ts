import { debounce, ItemView, setIcon, type WorkspaceLeaf } from "obsidian";
import { ENTITY_TYPES, type Entity, type EntityType } from "../codex/types";
import type MotifPlugin from "../main";
import { renderEmpty } from "./empty";
import { renderNav } from "./nav";
import { renderEntityPeek } from "./props";
import { allPairs, edgesAt, forceLayout, type GraphEdge, type Point } from "./graphModel";

export const GRAPH_VIEW = "storyloom-graph";

const SVG_NS = "http://www.w3.org/2000/svg";
const W = 1000;
const H = 700;

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
	const el = document.createElementNS(SVG_NS, tag);
	for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
	parent?.appendChild(el);
	return el;
}

export class GraphView extends ItemView {
	private chapter = 1;
	private filters = new Set<EntityType>(["character", "location", "lore", "faction", "item"]);
	private together = true;
	private presence = true;
	private positions = new Map<string, Point>();
	private svgEl!: SVGSVGElement;
	private stage!: HTMLElement;
	private emptyEl?: HTMLElement;
	private edgeLayer!: SVGGElement;
	private nodeLayer!: SVGGElement;
	private tooltipEl!: HTMLElement;
	private labelEl!: HTMLElement;
	private slider!: HTMLInputElement;
	private edgeEls = new Map<string, SVGGElement>();
	private nodeEls = new Map<string, SVGGElement>();
	private view = { x: 0, y: 0, w: W, h: H };
	/** Until the user pans or zooms, the view fits the nodes. */
	private userMoved = false;
	refresh = debounce(() => {
		// The filter chips list each type with its count; rebuild the shell when those change.
		if (this.typeKey() !== this.shellKey) {
			this.buildShell(); // existing nodes keep their places; new ones are laid out around them
		}
		this.rebuild();
	}, 300, true);
	private shellKey = "";
	private typeKey(): string {
		const counts = new Map<string, number>();
		for (const e of this.plugin.index.sortedEntities()) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
		return [...counts].sort().join(",");
	}

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: MotifPlugin,
	) {
		super(leaf);
	}

	getViewType() {
		return GRAPH_VIEW;
	}
	getDisplayText() {
		return "Story graph";
	}
	getIcon() {
		return "network";
	}

	async onOpen() {
		const current = this.plugin.index.chapterForPath(this.plugin.activeMarkdownFile()?.path);
		this.chapter = current?.chapter ?? this.plugin.index.chapters[0]?.chapter ?? 1;
		this.buildShell();
		this.rebuild();
	}

	async onClose() {
		this.contentEl.empty();
	}

	private visibleEntities(): Entity[] {
		return this.plugin.index.sortedEntities().filter((e) => this.filters.has(e.type));
	}

	private chapterNumbers(): number[] {
		return this.plugin.index.chapters.map((c) => c.chapter);
	}

	private buildShell() {
		this.shellKey = this.typeKey();
		const root = this.contentEl;
		root.empty();
		root.addClass("storyloom-graph");

		const bar = root.createDiv({ cls: "sl-tl-toolbar" });
		renderNav(bar, this.leaf, this.getViewType());
		const chips = root.createDiv({ cls: "sl-cx-chips" });
		const counts = new Map<string, number>();
		for (const e of this.plugin.index.sortedEntities()) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
		for (const t of ENTITY_TYPES) {
			if (!counts.get(t)) continue;
			const c = chips.createEl("button", { cls: `sl-cx-chip storyloom-type-${t}${this.filters.has(t) ? " is-active" : ""}` });
			c.createSpan({ text: t.charAt(0).toUpperCase() + t.slice(1) + (t === "lore" ? "" : "s") });
			c.createSpan({ cls: "sl-cx-chip-count", text: String(counts.get(t)) });
			c.addEventListener("click", () => {
				if (this.filters.has(t)) this.filters.delete(t);
				else this.filters.add(t);
				c.toggleClass("is-active", this.filters.has(t));
				this.rebuild();
			});
		}

		const toggles = chips.createDiv({ cls: "sl-gr-toggles" });
		const toggle = (text: string, hint: string, get: () => boolean, set: (v: boolean) => void) => {
			const b = toggles.createEl("button", { cls: `sl-cx-chip${get() ? " is-active" : ""}`, attr: { "aria-label": hint, "aria-pressed": String(get()) } });
			b.createSpan({ text });
			b.addEventListener("click", () => {
				set(!get());
				b.toggleClass("is-active", get());
				b.setAttr("aria-pressed", String(get()));
				this.update();
			});
		};
		toggle("Who's together", "Dashed lines between characters in the same place", () => this.together, (v) => (this.together = v));
		toggle("Where they are", "Dotted lines from characters to their location", () => this.presence, (v) => (this.presence = v));

		const stage = (this.stage = root.createDiv({ cls: "storyloom-graph-stage" }));
		const scrub = stage.createDiv({ cls: "storyloom-scrubber storyloom-glass" });
		const prev = scrub.createEl("button", { cls: "storyloom-glass-btn is-icon", attr: { "aria-label": "Previous chapter" } });
		setIcon(prev, "chevron-left");
		this.slider = scrub.createEl("input", { type: "range", cls: "storyloom-slider" });
		const next = scrub.createEl("button", { cls: "storyloom-glass-btn is-icon", attr: { "aria-label": "Next chapter" } });
		setIcon(next, "chevron-right");
		this.labelEl = scrub.createDiv({ cls: "storyloom-scrub-label" });
		prev.addEventListener("click", () => this.step(-1));
		next.addEventListener("click", () => this.step(1));
		this.slider.addEventListener("input", () => {
			const chs = this.chapterNumbers();
			this.chapter = chs[Number(this.slider.value)] ?? this.chapter;
			this.update();
		});
		this.svgEl = svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "xMidYMid meet" });
		stage.appendChild(this.svgEl);
		this.edgeLayer = svg("g", { class: "storyloom-edges" }, this.svgEl);
		this.nodeLayer = svg("g", { class: "storyloom-nodes" }, this.svgEl);
		this.tooltipEl = stage.createDiv({ cls: "storyloom-graph-tooltip storyloom-hover" });
		this.tooltipEl.hide();
		this.enablePanZoom(stage);
	}

	private step(dir: number) {
		const chs = this.chapterNumbers();
		const i = chs.indexOf(this.chapter);
		const n = chs[Math.min(chs.length - 1, Math.max(0, (i === -1 ? 0 : i) + dir))];
		if (n !== undefined) {
			this.chapter = n;
			this.update();
		}
	}

	/** Layout (only for new nodes) and full redraw of nodes; then edges for the chapter. */
	private rebuild() {
		if (!this.svgEl) return;
		const entities = this.visibleEntities();
		const chs = this.chapterNumbers();
		if (chs.length && !chs.includes(this.chapter)) this.chapter = chs[0];
		this.slider.min = "0";
		this.slider.max = String(Math.max(0, chs.length - 1));
		this.slider.disabled = chs.length < 2;

		const names = entities.map((e) => e.name);
		const hasAll = names.every((n) => this.positions.has(n));
		if (!hasAll) {
			const pairs = allPairs(this.plugin.index.sortedEntities(), chs);
			const laid = forceLayout(names, pairs, { width: W, height: H, existing: this.positions, fixExisting: this.positions.size > 0 });
			for (const [n, p] of laid) this.positions.set(n, p);
		}

		this.nodeLayer.empty();
		this.nodeEls.clear();
		this.edgeLayer.empty();
		this.edgeEls.clear();
		this.emptyEl?.remove();
		if (!entities.length) {
			const any = this.plugin.index.entities.size > 0;
			this.emptyEl = renderEmpty(this.stage, any
				? { icon: "filter", title: "Everything is filtered out", body: "Turn a type back on above to see it here." }
				: {
						icon: "network",
						title: "No one to show yet",
						body: "The graph draws your characters, locations and lore, and the relationships between them as of each chapter.",
						actions: [{ label: "New character", icon: "user", cta: true, onClick: () => void this.plugin.newEntity("character") }],
					});
		}
		for (const e of entities) this.drawNode(e);
		if (!this.userMoved) this.fitView(names);
		this.update();
	}

	private fitView(names: string[]) {
		const pts = names.map((n) => this.positions.get(n)).filter((p): p is Point => !!p);
		if (!pts.length) return;
		const pad = 70;
		const minX = Math.min(...pts.map((p) => p.x)) - pad;
		const maxX = Math.max(...pts.map((p) => p.x)) + pad;
		const minY = Math.min(...pts.map((p) => p.y)) - pad;
		// Extra room at the bottom for the floating chapter scrubber.
		const maxY = Math.max(...pts.map((p) => p.y)) + pad + 0.18 * (Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y)) + 2 * pad);
		this.view = { x: minX, y: minY, w: Math.max(240, maxX - minX), h: Math.max(200, maxY - minY) };
		this.svgEl.setAttribute("viewBox", `${this.view.x} ${this.view.y} ${this.view.w} ${this.view.h}`);
	}

	private drawNode(e: Entity) {
		const p = this.positions.get(e.name) as Point;
		const g = svg("g", { class: `storyloom-node storyloom-type-${e.type}`, transform: `translate(${p.x},${p.y})` }, this.nodeLayer);
		const r = e.type === "character" ? 14 : e.type === "location" ? 12 : 10;
		if (e.type === "location") svg("rect", { x: -r, y: -r, width: r * 2, height: r * 2, rx: 3 }, g);
		else if (e.type === "character") svg("circle", { r }, g);
		else svg("polygon", { points: `0,${-r - 1} ${r + 1},0 0,${r + 1} ${-r - 1},0` }, g);
		const label = svg("text", { y: r + 18, "text-anchor": "middle" }, g);
		label.textContent = e.name;
		this.nodeEls.set(e.name, g);

		let dragging = false;
		let moved = false;
		g.addEventListener("pointerdown", (ev) => {
			ev.stopPropagation();
			dragging = true;
			moved = false;
			g.setPointerCapture(ev.pointerId);
			this.tooltipEl.hide();
		});
		g.addEventListener("pointermove", (ev) => {
			if (!dragging) {
				this.showTooltip(e, ev);
				return;
			}
			const pt = this.toSvg(ev);
			moved = true;
			this.positions.set(e.name, pt);
			g.setAttribute("transform", `translate(${pt.x},${pt.y})`);
			this.redrawEdgeGeometry();
		});
		g.addEventListener("pointerup", (ev) => {
			dragging = false;
			g.releasePointerCapture(ev.pointerId);
			if (!moved) void this.app.workspace.openLinkText(e.path, "", ev.metaKey || ev.ctrlKey ? "tab" : false);
		});
		g.addEventListener("pointerleave", () => {
			if (!dragging) this.tooltipEl.hide();
		});
	}

	private showTooltip(e: Entity, ev: PointerEvent) {
		this.tooltipEl.empty();
		renderEntityPeek(this.tooltipEl, e, this.chapter);
		this.tooltipEl.show();
		const stage = this.tooltipEl.parentElement as HTMLElement;
		const rect = stage.getBoundingClientRect();
		const w = this.tooltipEl.offsetWidth;
		const h = this.tooltipEl.offsetHeight;
		let x = ev.clientX - rect.left + 14;
		let y = ev.clientY - rect.top + 14;
		if (x + w > rect.width - 8) x = Math.max(8, ev.clientX - rect.left - w - 14);
		if (y + h > rect.height - 8) y = Math.max(8, rect.height - h - 8);
		this.tooltipEl.style.left = `${x}px`;
		this.tooltipEl.style.top = `${y}px`;
	}

	/** Re-resolve edges for the current chapter and animate the difference. Node positions never move. */
	private update() {
		const chs = this.chapterNumbers();
		const ch = this.plugin.index.chapterByNumber(this.chapter);
		this.slider.value = String(Math.max(0, chs.indexOf(this.chapter)));
		this.labelEl.setText(ch ? `Chapter ${ch.chapter} — ${ch.title}` : chs.length ? `Chapter ${this.chapter}` : "No chapters yet (showing latest)");
		const asOf = chs.length ? this.chapter : Infinity;

		const edges = edgesAt(this.visibleEntities(), asOf, { together: this.together, presence: this.presence });
		const want = new Map(edges.map((e) => [e.id, e]));
		for (const [id, el] of this.edgeEls) {
			if (want.has(id)) continue;
			this.edgeEls.delete(id);
			el.classList.add("is-leaving");
			window.setTimeout(() => el.remove(), 220);
		}
		for (const e of edges) {
			if (this.edgeEls.has(e.id)) continue;
			const el = this.drawEdge(e);
			this.edgeEls.set(e.id, el);
			window.requestAnimationFrame(() => el.classList.remove("is-entering"));
		}
		this.redrawEdgeGeometry();

		// Dim nodes that have no timeline entries yet at this chapter.
		for (const e of this.visibleEntities()) {
			const started = e.timeline.length === 0 || e.timeline.some((t) => t.chapter <= asOf);
			this.nodeEls.get(e.name)?.classList.toggle("is-dormant", !started);
		}
	}

	private drawEdge(e: GraphEdge): SVGGElement {
		const g = svg("g", { class: `storyloom-edge is-${e.kind} is-entering` }, this.edgeLayer);
		g.dataset.a = e.a;
		g.dataset.b = e.b;
		svg("path", {}, g);
		if (e.label) {
			const t = svg("text", { "text-anchor": "middle" }, g);
			t.textContent = e.label;
		}
		return g;
	}

	private redrawEdgeGeometry() {
		for (const g of this.edgeEls.values()) {
			const a = this.positions.get(g.dataset.a as string);
			const b = this.positions.get(g.dataset.b as string);
			if (!a || !b) continue;
			// "Together" edges bow out so they stay visible beside a relationship line.
			const curved = g.classList.contains("is-together");
			const mx = (a.x + b.x) / 2;
			const my = (a.y + b.y) / 2;
			const len = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
			const bow = curved ? Math.min(40, len * 0.2) : 0;
			const cx = mx - ((b.y - a.y) / len) * bow;
			const cy = my + ((b.x - a.x) / len) * bow;
			(g.querySelector("path") as SVGPathElement).setAttribute("d", `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`);
			const t = g.querySelector("text");
			if (t) {
				t.setAttribute("x", String(mx));
				t.setAttribute("y", String(my - 4));
			}
		}
	}

	private toSvg(ev: { clientX: number; clientY: number }): Point {
		const pt = this.svgEl.createSVGPoint();
		pt.x = ev.clientX;
		pt.y = ev.clientY;
		const m = this.svgEl.getScreenCTM();
		if (!m) return { x: 0, y: 0 };
		const p = pt.matrixTransform(m.inverse());
		return { x: p.x, y: p.y };
	}

	private enablePanZoom(stage: HTMLElement) {
		const apply = () => this.svgEl.setAttribute("viewBox", `${this.view.x} ${this.view.y} ${this.view.w} ${this.view.h}`);
		stage.addEventListener(
			"wheel",
			(ev) => {
				ev.preventDefault();
				this.userMoved = true;
				const p = this.toSvg(ev);
				const f = ev.deltaY > 0 ? 1.1 : 1 / 1.1;
				const w = Math.min(W * 4, Math.max(W / 4, this.view.w * f));
				const scale = w / this.view.w;
				this.view = { x: p.x - (p.x - this.view.x) * scale, y: p.y - (p.y - this.view.y) * scale, w, h: this.view.h * scale };
				apply();
			},
			{ passive: false },
		);
		let pan: { x: number; y: number; vx: number; vy: number } | null = null;
		this.svgEl.addEventListener("pointerdown", (ev) => {
			pan = { x: ev.clientX, y: ev.clientY, vx: this.view.x, vy: this.view.y };
			this.svgEl.setPointerCapture(ev.pointerId);
		});
		this.svgEl.addEventListener("pointermove", (ev) => {
			if (!pan) return;
			this.userMoved = true;
			const rect = this.svgEl.getBoundingClientRect();
			const s = Math.max(this.view.w / rect.width, this.view.h / rect.height);
			this.view.x = pan.vx - (ev.clientX - pan.x) * s;
			this.view.y = pan.vy - (ev.clientY - pan.y) * s;
			apply();
		});
		this.svgEl.addEventListener("pointerup", (ev) => {
			pan = null;
			this.svgEl.releasePointerCapture(ev.pointerId);
		});
	}
}
