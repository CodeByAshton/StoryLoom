// Screenshots of every view, pop-up and menu in light and dark (THEMES=moonstone,obsidian) for visual review; saved to $STORYLOOM_E2E_DIR/shots as t2-*.png.
import { launch, shot } from "./launch.mjs";
const { app, page } = await launch();
const sleep = (ms) => page.waitForTimeout(ms);
const cmd = (id) => page.evaluate((id) => window.app.commands.executeCommandById(id), id);
const focusEd = (sel) => page.evaluate((sel) => { const leaf = window.app.workspace.getLeavesOfType("markdown")[0]; window.app.workspace.setActiveLeaf(leaf, { focus: true }); const e = leaf.view.editor; e.focus(); if (sel) e.setSelection(sel[0], sel[1]); }, sel);
const clear = () => page.locator(".notice").evaluateAll((ns) => ns.forEach((n) => n.remove()));
const esc = async () => { await page.keyboard.press("Escape"); await sleep(300); };
const open = (p) => page.evaluate((p) => window.app.workspace.openLinkText(p, "", false), p);
for (let i = 0; i < 40; i++) { if (await page.evaluate(() => !!window.app?.plugins?.plugins?.storyloom?.index?.ready).catch(() => false)) break; await sleep(300); }
await page.evaluate(async () => { const p = window.app.plugins.plugins.storyloom; p.settings.provider = "ollama"; p.settings.providers.ollama = { apiKey: "", baseUrl: "http://localhost:11434/v1", model: "x" }; await p.saveSettings(); });
for (const theme of (process.env.THEMES ?? "moonstone,obsidian").split(",")) {
  const t = theme === "obsidian" ? "d" : "l";
  await page.evaluate((th) => window.app.changeTheme(th), theme); await sleep(300);
  await open("Manuscript/03 - The Harbor.md"); await sleep(700);
  await cmd("storyloom:open-cast"); await sleep(400);
  if (t === "l") { await focusEd(); await cmd("storyloom:update-story-state"); await sleep(3500); }
  await clear(); await shot(page, `t2-${t}-01-editor`);
  // entity hover
  await page.locator('.cm-content [data-storyloom-entity="Elias Crane"]').first().hover({ timeout: 4000 }).catch(() => {}); await sleep(800); await shot(page, `t2-${t}-02-hover`); await page.mouse.move(5,5); await sleep(300);
  // ask ai pill
  await focusEd([{ line: 12, ch: 0 }, { line: 12, ch: 40 }]); await sleep(600); await shot(page, `t2-${t}-03-pill`);
  await page.keyboard.press("Control+k"); await sleep(500); await shot(page, `t2-${t}-04-inline-open`);
  await esc();
  // modals
  await focusEd([{ line: 12, ch: 0 }, { line: 12, ch: 60 }]); await cmd("storyloom:rewrite-selection"); await sleep(600); await shot(page, `t2-${t}-05-rewrite-pick`);
  await page.keyboard.press("Enter"); await sleep(3000); await shot(page, `t2-${t}-06-rewrite-result`); await esc(); await esc();
  await focusEd([{ line: 12, ch: 0 }, { line: 12, ch: 30 }]); await cmd("storyloom:describe"); await sleep(3000); await shot(page, `t2-${t}-07-describe`); await esc();
  await focusEd(); await cmd("storyloom:brainstorm"); await sleep(600); await shot(page, `t2-${t}-08-brainstorm-pick`); await esc();
  await focusEd(); await cmd("storyloom:critique-chapter"); await sleep(3000); await shot(page, `t2-${t}-09-critique`); await esc();
  await focusEd(); await cmd("storyloom:continuity-check"); await sleep(3000); await shot(page, `t2-${t}-10-continuity`); await esc();
  await page.evaluate(() => { const p = window.app.plugins.plugins.storyloom; p.addTimelineEntry(p.index.getEntity("Mara Winston"), 3); }); await sleep(600); await shot(page, `t2-${t}-11-tlentry`); await esc();
  await focusEd(); await cmd("storyloom:word-count"); await sleep(800); await shot(page, `t2-${t}-12-wordcount`); await esc();
  await cmd("storyloom:new-chapter"); await sleep(600); await shot(page, `t2-${t}-13-newchapter`); await esc();
  // menus
  await page.locator('.side-dock-ribbon-action[aria-label="Storyloom"]').click(); await sleep(400); await shot(page, `t2-${t}-14-menu`); await esc();
  await page.locator(".status-bar .sl-status").click(); await sleep(400); await shot(page, `t2-${t}-15-statusmenu`); await esc();
  // chat with reply
  await cmd("storyloom:open-chat"); await sleep(600);
  await page.locator(".storyloom-chat-input").fill("Where is Mara in chapter 2?"); await page.keyboard.press("Enter"); await sleep(3500); await shot(page, `t2-${t}-16-chat`);
  await cmd("storyloom:open-cast"); await sleep(300);
  // views
  for (const v of ["chapters", "codex", "timeline", "graph"]) { await cmd(`storyloom:open-${v}`); await sleep(1300); await shot(page, `t2-${t}-2${["chapters","codex","timeline","graph"].indexOf(v)}-${v}`); }
  await cmd("storyloom:open-timeline"); await sleep(500); await page.locator(".sl-tl-segmented button", { hasText: "Locations" }).click(); await sleep(900); await shot(page, `t2-${t}-24-timeline-loc`); await page.locator(".sl-tl-segmented button", { hasText: "Characters" }).click();
  // settings
  await page.evaluate(() => { window.app.setting.open(); window.app.setting.openTabById("storyloom"); }); await sleep(700); await shot(page, `t2-${t}-30-settings`);
  await page.evaluate(() => document.querySelector(".vertical-tab-content")?.scrollBy(0, 700)); await sleep(300); await shot(page, `t2-${t}-31-settings2`);
  await page.evaluate(() => document.querySelector(".vertical-tab-content")?.scrollBy(0, 900)); await sleep(300); await shot(page, `t2-${t}-32-settings3`);
  await esc();
  await page.evaluate(() => window.app.plugins.plugins.storyloom.openSetup()); await sleep(600); await shot(page, `t2-${t}-33-setup`); await esc();
}
await app.close();
