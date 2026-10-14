import { launch, shot } from "./launch.mjs";
const { app, page, logs } = await launch();
const ok = (cond, msg) => console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
const open = (p) => page.evaluate(async (p) => { await window.app.workspace.openLinkText(p, "", false); }, p);
const sleep = (ms) => page.waitForTimeout(ms);

// (2) Reload the app with listeners attached and look for errors.
logs.length = 0;
await page.reload();
for (let i = 0; i < 40; i++) {
	if (await page.evaluate(() => !!window.app?.plugins?.plugins?.storyloom?.index?.ready).catch(() => false)) break;
	await sleep(500);
}
await sleep(1500);
const errs = logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/bus\.cc|favicon/i.test(l));
ok(errs.length === 0, `(2) loads with no console errors ${errs.length ? JSON.stringify(errs) : ""}`);
const warns = logs.filter((l) => /storyloom/i.test(l));
if (warns.length) console.log("   storyloom logs:", warns);

async function hoverCard(path, name) {
	await open(path);
	await sleep(800);
	const el = page.locator(`.cm-content [data-storyloom-entity="${name}"]`).first();
	await el.scrollIntoViewIfNeeded();
	await page.mouse.move(5, 5);
	await sleep(200);
	await el.hover();
	await page.waitForSelector(".storyloom-hover .storyloom-card", { timeout: 4000 }).catch(() => {});
	const txt = await page.locator(".storyloom-hover .storyloom-card").first().innerText().catch(() => "");
	return txt;
}

// (3) Hover Mara in chapter 3 and chapter 1.
const c3 = await hoverCard("Manuscript/03 - The Harbor.md", "Mara Winston");
await shot(page, "03-hover-ch3");
ok(/As of Chapter 3/.test(c3) && /Old Harbor/.test(c3) && /Injured/.test(c3), `(3) ch3 hover shows state as of ch 3 → ${JSON.stringify(c3.slice(0, 160))}`);
const c1 = await hoverCard("Manuscript/01 - The Manor.md", "Mara Winston");
await shot(page, "03-hover-ch1");
ok(/As of Chapter 1/.test(c1) && /Blackwood Manor/.test(c1) && !/Old Harbor/.test(c1), `(3) ch1 hover shows ch-1 location → ${JSON.stringify(c1.slice(0, 160))}`);
const highlighted = await page.locator(".cm-content .storyloom-entity").count();
ok(highlighted > 5, `(4.1) entity names highlighted in chapter (${highlighted})`);
await open("Start Here.md");
await sleep(600);
ok((await page.locator(".cm-content .storyloom-entity").count()) === 0, "(4.1) no highlighting outside the manuscript by default");

// (4) Graph: scrub 1 → 3.
await page.mouse.move(5, 5);
await page.evaluate(() => window.app.commands.executeCommandById("storyloom:open-graph"));
await sleep(1500);
const graphState = () =>
	page.evaluate(() => ({
		edges: [...document.querySelectorAll(".storyloom-edge:not(.is-leaving)")].map((e) => e.getAttribute("class").split(" ").find((c) => c.startsWith("is-") && c !== "is-entering") + ":" + e.dataset.a + "~" + e.dataset.b + ":" + (e.querySelector("text")?.textContent ?? "")),
		nodes: Object.fromEntries([...document.querySelectorAll(".storyloom-node")].map((n) => [n.querySelector("text").textContent, n.getAttribute("transform")])),
		label: document.querySelector(".storyloom-scrub-label")?.textContent,
	}));
const setCh = async (idx) => {
	await page.evaluate((i) => {
		const s = document.querySelector(".storyloom-slider");
		s.value = String(i);
		s.dispatchEvent(new Event("input"));
	}, idx);
	await sleep(500);
};
await setCh(0);
const g1 = await graphState();
await shot(page, "04-graph-ch1");
await setCh(2);
const g3 = await graphState();
await shot(page, "04-graph-ch3");
const relChanged = g1.edges.filter((e) => e.startsWith("is-rel")).join() !== g3.edges.filter((e) => e.startsWith("is-rel")).join();
const togChanged = g1.edges.filter((e) => !e.startsWith("is-rel")).join() !== g3.edges.filter((e) => !e.startsWith("is-rel")).join();
ok(relChanged, `(4) relationship edges change: ch1 ${JSON.stringify(g1.edges.filter((e) => e.startsWith("is-rel")))} → ch3 ${JSON.stringify(g3.edges.filter((e) => e.startsWith("is-rel")))}`);
ok(togChanged, `(4) co-location edges change: ch1 ${JSON.stringify(g1.edges.filter((e) => !e.startsWith("is-rel")))} → ch3 ${JSON.stringify(g3.edges.filter((e) => !e.startsWith("is-rel")))}`);
ok(JSON.stringify(g1.nodes) === JSON.stringify(g3.nodes), `(4) node positions stable while scrubbing (${Object.keys(g1.nodes).length} nodes)`);
ok(g3.label === "Chapter 3 — The Harbor", `(4) scrubber label: ${g3.label}`);

// (5) Timeline.
await page.evaluate(() => window.app.commands.executeCommandById("storyloom:open-timeline"));
await sleep(1500);
await shot(page, "05-timeline");
const grid = await page.evaluate(() =>
	[...document.querySelectorAll(".storyloom-grid tbody tr")].map((tr) => ({
		row: tr.querySelector("th").textContent,
		cells: [...tr.querySelectorAll("td")].map((td) => (td.querySelector(".storyloom-cell-loc")?.textContent ?? "") + (td.querySelector(".storyloom-mention-dot") ? "•" : "")),
	})),
);
console.log("   grid:", JSON.stringify(grid));
const row = (n) => grid.find((r) => r.row.includes(n))?.cells ?? [];
ok(JSON.stringify(row("Mara")) === JSON.stringify(["Blackwood Manor•", "Blackwood Manor•", "Old Harbor•"]), "(5) Mara's locations + mentions per chapter");
ok(JSON.stringify(row("Elias")) === JSON.stringify(["Old Harbor", "Old Harbor", "Old Harbor•"]), "(5) Elias mentioned only in ch 3");

// (8) Hand-edit a timeline line; hover card and cast panel update within a second.
await page.evaluate(() => window.app.commands.executeCommandById("storyloom:open-cast"));
await open("Manuscript/03 - The Harbor.md");
await sleep(1200);
const castBefore = await page.locator(".storyloom-cast").innerText();
await page.evaluate(async () => {
	const f = window.app.vault.getAbstractFileByPath("Codex/Characters/Mara Winston.md");
	await window.app.vault.process(f, (t) => t.replace("- ch 2 | status: Injured", "- ch 2 | status: Feverish"));
});
const t0 = Date.now();
let castAfter = "";
while (Date.now() - t0 < 3000) {
	castAfter = await page.locator(".storyloom-cast").innerText();
	if (/Feverish/.test(castAfter)) break;
	await sleep(100);
}
const castMs = Date.now() - t0;
ok(/Injured/.test(castBefore) && /Feverish/.test(castAfter) && castMs < 1000, `(8) cast panel updated after hand edit in ${castMs} ms`);
await shot(page, "08-cast");
const c3b = await hoverCard("Manuscript/03 - The Harbor.md", "Mara Winston");
ok(/Feverish/.test(c3b), "(8) hover card reflects hand edit");
await app.close();
