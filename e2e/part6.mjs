// Codex view (own button, folder hidden) and swimlane timeline interactions.
import { launch, shot } from "./launch.mjs";
const { app, page, logs } = await launch();
const ok = (cond, msg) => console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
const sleep = (ms) => page.waitForTimeout(ms);
for (let i = 0; i < 40; i++) { if (await page.evaluate(() => !!window.app?.plugins?.plugins?.storyloom?.index?.ready).catch(() => false)) break; await sleep(300); }
const explorerShows = (folder) => page.evaluate((f) => { const t = document.querySelector(`.nav-folder-title[data-path="${f}"]`); return !!t && getComputedStyle(t.closest(".nav-folder")).display !== "none"; }, folder);

ok(!(await explorerShows("Codex")) && (await explorerShows("Manuscript")), "Codex folder is hidden from the file explorer; Manuscript isn't");
ok((await page.locator('.side-dock-ribbon-action[aria-label="Storyloom"]').count()) === 1, "One Storyloom ribbon button");
await page.evaluate(async () => { const p = window.app.plugins.plugins.storyloom; p.settings.hideCodexFolder = false; await p.saveSettings(); });
await sleep(300);
ok(await explorerShows("Codex"), "turning the setting off shows the folder again");
await page.evaluate(async () => { const p = window.app.plugins.plugins.storyloom; p.settings.hideCodexFolder = true; await p.saveSettings(); });

await page.locator('.side-dock-ribbon-action[aria-label="Storyloom"]').click();
await page.locator(".menu .menu-item", { hasText: /^Codex$/ }).click();
await page.waitForSelector(".sl-cx-card");
ok((await page.locator(".sl-cx-card").count()) === 6, "Codex shows a card per entity");
await page.locator(".sl-cx-search").fill("harbor");
await sleep(200);
const hits = await page.locator(".sl-cx-card .sl-cx-card-name").allInnerTexts();
ok(hits.includes("Old Harbor") && hits.includes("Elias Crane") && !hits.includes("Arthur Vane"), `search matches names, aliases and descriptions (${hits.join(", ")})`);
await page.locator(".sl-cx-search").fill("");
await page.locator(".sl-cx-chip", { hasText: "Locations" }).click();
await sleep(200);
ok(JSON.stringify(await page.locator(".sl-cx-card .sl-cx-card-name").allInnerTexts()) === JSON.stringify(["Blackwood Manor", "Old Harbor"]), "type chips filter the cards");
await page.locator(".sl-cx-chip", { hasText: "All" }).click();
await page.locator(".sl-cx-card", { hasText: "Mara Winston" }).click();
await page.waitForSelector(".sl-cx-detail");
const detail = await page.locator(".sl-cx-detail").innerText();
ok(/Old Harbor/.test(detail) && /reluctant ally/.test(detail) && /Ch 3/.test(detail) && /finds Elias at the harbor/.test(detail), "detail shows current state, relationships and the timeline");
await page.locator(".sl-cx-rel-target", { hasText: "Elias Crane" }).click();
await sleep(300);
ok(/Elias Crane/.test(await page.locator(".sl-cx-detail-name").innerText()), "clicking a relationship jumps to that entity");
await page.locator(".sl-cx-actions button", { hasText: "Open note" }).click();
await sleep(500);
ok((await page.evaluate(() => window.app.workspace.getActiveFile()?.path)) === "Codex/Characters/Elias Crane.md", "Open note opens the Markdown note to edit");
await shot(page, "p6-codex");

// Timeline → codex.
await page.evaluate(() => window.app.commands.executeCommandById("storyloom:open-timeline"));
await page.waitForSelector(".sl-tl-name");
await page.locator(".sl-tl-name", { hasText: "Arthur Vane" }).click();
await sleep(600);
ok((await page.locator(".sl-cx-detail-name").innerText().catch(() => "")) === "Arthur Vane", "clicking a name on the timeline opens it in the codex");
await page.evaluate(() => window.app.commands.executeCommandById("storyloom:open-timeline"));
await sleep(500);
await page.locator(".sl-tl-segmented button", { hasText: "Locations" }).click();
await sleep(600);
const faces = await page.evaluate(() => {
	const grid = document.querySelector(".sl-tl-grid");
	const out = {};
	for (const name of grid.querySelectorAll(".sl-tl-name")) {
		const row = name.style.gridRow;
		out[name.querySelector(".sl-tl-name-main").textContent] = [...grid.querySelectorAll(".sl-tl-cell")].filter((c) => c.style.gridRow === row).map((c) => [...c.querySelectorAll(".sl-tl-avatar")].map((a) => a.textContent).join("+") || "-");
	}
	return out;
});
ok(JSON.stringify(faces) === JSON.stringify({ "Blackwood Manor": ["AV+MW", "AV+MW", "AV"], "Old Harbor": ["EC", "EC", "EC+MW"] }), `locations mode shows who is where: ${JSON.stringify(faces)}`);
await page.locator(".sl-tl-cell").nth(2).hover();
await sleep(400);
ok(/As of chapter 3/i.test(await page.locator(".sl-tl-tip").innerText().catch(() => "")), "hovering a cell shows the state card for that chapter");
await shot(page, "p6-timeline-locations");

const errs = logs.filter((l) => /^\[(error|pageerror)\]/.test(l));
ok(errs.length === 0, `no console errors ${errs.length ? JSON.stringify(errs) : ""}`);
await app.close();
