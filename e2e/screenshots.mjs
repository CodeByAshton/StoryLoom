// Regenerates the README screenshots in docs/screenshots (run like the other parts; see e2e/README.md).
import { launch, shot } from "./launch.mjs";
const { app, page } = await launch();
const sleep = (ms) => page.waitForTimeout(ms);
const cmd = (id) => page.evaluate((id) => window.app.commands.executeCommandById(id), id);
const focusEditor = () => page.evaluate(() => { const leaf = window.app.workspace.getLeavesOfType("markdown")[0]; window.app.workspace.setActiveLeaf(leaf, { focus: true }); });
const clear = () => page.locator(".notice").evaluateAll((ns) => ns.forEach((n) => n.remove()));
for (let i = 0; i < 40; i++) { if (await page.evaluate(() => !!window.app?.plugins?.plugins?.motif?.index?.ready).catch(() => false)) break; await sleep(300); }
await page.evaluate(async () => { const p = window.app.plugins.plugins.motif; p.settings.provider = "ollama"; p.settings.providers.ollama = { apiKey: "", baseUrl: "http://localhost:11434/v1", model: "x" }; await p.saveSettings(); window.app.workspace.leftSplit.collapse(); });
const open = (p) => page.evaluate((p) => window.app.workspace.openLinkText(p, "", false), p);

await page.evaluate(() => window.app.changeTheme("obsidian"));
await open("Manuscript/03 - The Harbor.md"); await sleep(800);
await cmd("motif:open-cast"); await sleep(500);
await focusEditor(); await cmd("motif:update-story-state"); await sleep(3500); await clear();
await page.evaluate(() => { window.app.workspace.getLeavesOfType("markdown")[0].view.editor.scrollTo(0, 0); }); await sleep(600);
await page.screenshot({ path: new URL(`../docs/screenshots/hero.png`, import.meta.url).pathname });
// writing note
await page.locator(".workspace-leaf.mod-active .cm-content .sl-wn-word-choice, .cm-content .sl-wn-word-choice").first().hover(); await sleep(700);
await page.screenshot({ path: new URL(`../docs/screenshots/review.png`, import.meta.url).pathname });
await page.mouse.move(5, 5); await sleep(300);
// light: inline edit
await page.evaluate(() => window.app.changeTheme("moonstone")); await sleep(400);
await page.evaluate(() => { const leaf = window.app.workspace.getLeavesOfType("markdown")[0]; window.app.workspace.setActiveLeaf(leaf, { focus: true }); const e = leaf.view.editor; e.focus(); e.setSelection({ line: 10, ch: 0 }, { line: 10, ch: e.getLine(10).length }); });
await sleep(300); await page.keyboard.press("Control+k"); await sleep(500);
await page.keyboard.type("tighten this"); await page.keyboard.press("Enter"); await sleep(5000);
await page.screenshot({ path: new URL(`../docs/screenshots/inline.png`, import.meta.url).pathname });
await page.keyboard.press("Escape"); await sleep(300);
// views
await cmd("motif:open-chapters"); await sleep(1200);
await page.locator(".sl-tl-segmented button", { hasText: "Board" }).click().catch(() => {}); await sleep(900);
await page.screenshot({ path: new URL(`../docs/screenshots/board.png`, import.meta.url).pathname });
await cmd("motif:open-codex"); await sleep(800); await page.locator(".sl-cx-card", { hasText: "Mara Winston" }).click(); await sleep(800);
await page.screenshot({ path: new URL(`../docs/screenshots/codex.png`, import.meta.url).pathname });
await page.evaluate(() => window.app.changeTheme("obsidian")); await sleep(300);
await cmd("motif:open-timeline"); await sleep(1300);
await page.screenshot({ path: new URL(`../docs/screenshots/timeline.png`, import.meta.url).pathname });
await cmd("motif:open-graph"); await sleep(1500);
await page.screenshot({ path: new URL(`../docs/screenshots/graph.png`, import.meta.url).pathname });
await page.evaluate(() => window.app.changeTheme("moonstone")); await sleep(300);
await page.evaluate(() => window.app.plugins.plugins.motif.openSetup()); await sleep(700);
await page.screenshot({ path: new URL(`../docs/screenshots/setup.png`, import.meta.url).pathname });
await app.close();
