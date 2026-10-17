// Release-readiness fixes: hidden codex folder survives explorer redraws, keyboard focus after reorder,
// the graph keeps its pan and zoom, and a deleted chapter takes its sync record with it.
import { launch, shot } from "./launch.mjs";
const { app, page, logs } = await launch();
const ok = (cond, msg) => console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
const sleep = (ms) => page.waitForTimeout(ms);
for (let i = 0; i < 40; i++) { if (await page.evaluate(() => !!window.app?.plugins?.plugins?.motif?.index?.ready).catch(() => false)) break; await sleep(300); }
const explorerShows = (folder) => page.evaluate((f) => { const t = document.querySelector(`.nav-folder-title[data-path="${f}"]`); return !!t && getComputedStyle(t.closest(".nav-folder")).display !== "none"; }, folder);
const menu = async (item) => {
	await page.locator('.side-dock-ribbon-action[aria-label="Motif"]').click();
	await page.locator(".menu .menu-item", { hasText: new RegExp(`^${item}$`) }).click();
	await sleep(600);
};

// Hidden codex folder: no <style> element, and it stays hidden when the explorer redraws.
ok(!(await explorerShows("Codex")) && (await page.locator("style#storyloom-hide-codex").count()) === 0, "codex folder hidden with a CSS class, not an injected style element");
await page.evaluate(async () => {
	await window.app.vault.createFolder("Aaa New Folder");
	await window.app.vault.create("Aaa New Folder/Note.md", "hello");
});
await sleep(800);
ok(!(await explorerShows("Codex")) && (await explorerShows("Aaa New Folder")), "codex folder stays hidden after the explorer redraws for new files");
await page.evaluate(async () => { const p = window.app.plugins.plugins.motif; p.settings.codexFolder = "Manuscript"; await p.saveSettings(); });
await sleep(300);
ok((await explorerShows("Codex")) && !(await explorerShows("Manuscript")), "changing the codex folder setting moves which folder is hidden");
await page.evaluate(async () => { const p = window.app.plugins.plugins.motif; p.settings.codexFolder = "Codex"; await p.saveSettings(); });
await sleep(300);

// Chapters: after Alt+→ and Reorder, focus stays on the moved card so it can keep moving.
await menu("Chapters");
await page.waitForSelector(".sl-ch-grid .sl-ch-card[data-path]");
const first = page.locator(".sl-ch-grid .sl-ch-card[data-path]").first();
const title = await first.locator(".sl-ch-card-title").innerText();
await first.focus();
await page.keyboard.press("Alt+ArrowRight");
await page.waitForSelector(".modal.storyloom-glass-modal", { timeout: 5000 }).catch(() => {});
await page.locator(".modal button", { hasText: "Reorder" }).click();
await sleep(2500);
const focused = await page.evaluate(() => { const a = document.activeElement; return a?.classList.contains("sl-ch-card") ? a.innerText : ""; });
ok(focused.includes(title) && /^2\b/.test(focused.trim()), `focus follows the moved chapter (${JSON.stringify(focused.slice(0, 30))})`);
const noNewFocus = await page.evaluate(() => !document.activeElement?.classList.contains("is-new"));
ok(noNewFocus, "the New chapter card isn't focused on its own");
await shot(page, "p9-reorder-focus");

// Codex: Enter on a card keeps focus on that card.
await menu("Codex");
await page.waitForSelector(".sl-cx-card");
const card = page.locator(".sl-cx-card").nth(1);
const name = await card.getAttribute("data-name");
await card.focus();
await page.keyboard.press("Enter");
await sleep(500);
const kept = await page.evaluate((n) => { const a = document.activeElement; return a?.getAttribute("data-name") === n || (a?.classList.contains("sl-cx-detail") && a.getAttribute("aria-label") === n); }, name);
ok(kept, `Enter on a codex card keeps focus on it, or on its detail when the pane is narrow (${name})`);

// Graph: zoom, then add an entity of a new kind; the view keeps the zoom.
await menu("Graph");
await page.waitForSelector(".storyloom-graph-stage > svg");
const svg = page.locator(".storyloom-graph-stage > svg").first();
const box = await svg.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.wheel(0, -400);
await sleep(400);
const zoomed = await svg.getAttribute("viewBox");
await page.evaluate(async () => {
	await window.app.vault.create("Codex/Lore/The Second Key.md", "---\ntype: lore\n---\nA key.\n");
	await window.app.vault.create("Codex/Characters/Nell Hart.md", "---\ntype: character\n---\nA witness.\n");
});
await sleep(1500);
const after = await page.locator(".storyloom-graph-stage > svg").first().getAttribute("viewBox");
ok(zoomed === after, `graph keeps the user's zoom after the codex changes (${zoomed} / ${after})`);

// Deleting a chapter clears its sync record.
const del = await page.evaluate(async () => {
	const p = window.app.plugins.plugins.motif;
	const path = p.index.chapters[p.index.chapters.length - 1].path;
	p.settings.syncedLines[path] = [{ path: "Codex/Characters/Nell Hart.md", line: "- ch 3 | status: Fine" }];
	await p.saveSettings();
	await window.app.vault.trash(window.app.vault.getAbstractFileByPath(path), true);
	await new Promise((r) => setTimeout(r, 800));
	return !(path in p.settings.syncedLines);
});
ok(del, "deleting a chapter clears its sync record");

const errs = logs.filter((l) => /^\[(error|pageerror)\]/.test(l));
ok(errs.length === 0, `no console errors ${errs.length ? JSON.stringify(errs) : ""}`);
await app.close();
