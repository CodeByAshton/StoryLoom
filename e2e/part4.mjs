// Review round: streaming + fallback, no refresh while typing, stale indicator, timeline form, settings button.
import { launch, shot } from "./launch.mjs";
const { app, page, logs } = await launch();
const ok = (cond, msg) => console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
const sleep = (ms) => page.waitForTimeout(ms);
const open = (p) => page.evaluate(async (p) => { await window.app.workspace.openLinkText(p, "", false); }, p);
const doc = () => page.evaluate(() => window.app.workspace.activeEditor.editor.getValue());
for (let i = 0; i < 40; i++) { if (await page.evaluate(() => !!window.app?.plugins?.plugins?.storyloom?.index?.ready).catch(() => false)) break; await sleep(300); }
const setProvider = (provider, cfg) => page.evaluate(async ([provider, cfg]) => {
	const p = window.app.plugins.plugins.storyloom;
	p.settings.provider = provider;
	p.settings.providers[provider] = { ...(p.settings.providers[provider] ?? {}), ...cfg };
	await p.saveSettings();
}, [provider, cfg]);
const select = (para) => page.evaluate((para) => {
	const e = window.app.workspace.activeEditor.editor;
	const i = e.getValue().indexOf(para);
	e.setSelection(e.offsetToPos(i), e.offsetToPos(i + para.length));
	e.focus();
}, para);
const para = "The door opened before she could knock. Arthur Vane filled it, all good tailoring and bad sleep.";

// Streaming into the inline panel.
await setProvider("ollama", { apiKey: "", baseUrl: "http://localhost:11434/v1" });
await open("Manuscript/01 - The Manor.md");
await sleep(700);
await select(para);
await page.keyboard.press("Control+k");
await page.waitForSelector(".storyloom-glass-input");
await page.keyboard.type("tighten this");
await page.keyboard.press("Enter");
await page.waitForSelector(".storyloom-glass-result.is-streaming", { timeout: 5000 }).catch(() => {});
const partial1 = await page.locator(".storyloom-glass-result.is-streaming").innerText().catch(() => "");
await sleep(400);
const partial2 = await page.locator(".storyloom-glass-result.is-streaming").innerText().catch(() => "");
await shot(page, "p4-streaming");
ok(partial1.length > 0 && partial2.length > partial1.length, `inline panel streams text as it arrives (${partial1.length} → ${partial2.length} chars)`);
await page.waitForSelector(".storyloom-glass-result:not(.is-streaming)", { timeout: 10000 });
const final = await page.locator(".storyloom-glass-result").innerText();
ok(/swung/.test(final) && (await page.locator(".storyloom-diff-add").count()) > 0, "after streaming, the result shows as a word diff");
await page.keyboard.press("Tab");
await sleep(300);
ok((await doc()).includes("swung open before she knocked"), "streamed result is accepted with Tab");
await page.keyboard.press("Control+z");
await sleep(300);

// Stop aborts a stream.
await select(para);
await page.keyboard.press("Control+k");
await page.waitForSelector(".storyloom-glass-input");
await page.keyboard.type("tighten this");
await page.keyboard.press("Enter");
await page.waitForSelector(".storyloom-glass-result.is-streaming", { timeout: 5000 }).catch(() => {});
await page.getByRole("button", { name: "Stop" }).click();
await sleep(1500);
ok((await page.locator(".storyloom-glass-input").count()) === 1 && (await page.locator(".storyloom-glass-result").count()) === 0, "Stop ends the stream and returns to the instruction box");
await page.keyboard.press("Escape");
await sleep(300);

// Fallback: a server without CORS can't stream from inside Obsidian; the request still succeeds.
await setProvider("custom", { apiKey: "", baseUrl: "http://localhost:11435/v1", model: "m" });
await page.evaluate(() => { const e = window.app.workspace.activeEditor.editor; e.setCursor({ line: e.lastLine(), ch: 0 }); window.app.commands.executeCommandById("storyloom:continue-writing"); });
await sleep(400);
await page.keyboard.press("Enter");
await page.waitForSelector(".storyloom-result-text", { timeout: 10000 }).catch(() => {});
const fb = await page.locator(".storyloom-result-text").inputValue().catch(() => "");
ok(/The fog pressed in/.test(fb), "without CORS, Continue writing falls back to a normal request and still works");
await page.keyboard.press("Escape");
await sleep(300);

// Continue writing streams into the modal (CORS server).
await setProvider("ollama", { apiKey: "", baseUrl: "http://localhost:11434/v1" });
await page.evaluate(() => window.app.commands.executeCommandById("storyloom:continue-writing"));
await sleep(400);
await page.keyboard.press("Enter");
await page.waitForSelector(".storyloom-result-live", { timeout: 5000 }).catch(() => {});
ok((await page.locator(".storyloom-result-live").count()) === 1, "Continue writing shows text live while streaming");
await page.waitForSelector(".storyloom-result-text", { timeout: 10000 }).catch(() => {});
await page.keyboard.press("Escape");
await sleep(300);

// Typing in a chapter no longer refreshes the whole plugin.
await page.evaluate(() => { const p = window.app.plugins.plugins.storyloom; window.__changes = 0; p.index.on("changed", () => window.__changes++); });
await page.evaluate(async () => {
	const f = window.app.vault.getAbstractFileByPath("Manuscript/01 - The Manor.md");
	for (let i = 0; i < 3; i++) { await window.app.vault.process(f, (t) => t + "\nMore prose."); await new Promise((r) => setTimeout(r, 300)); }
});
await sleep(1200);
const proseChanges = await page.evaluate(() => window.__changes);
await page.evaluate(async () => { const f = window.app.vault.getAbstractFileByPath("Manuscript/01 - The Manor.md"); await window.app.fileManager.processFrontMatter(f, (fm) => { fm.title = "The Manor House"; }); });
await sleep(1200);
const fmChanges = await page.evaluate(() => window.__changes);
ok(proseChanges === 0 && fmChanges === 1, `prose edits don't broadcast index changes (${proseChanges}); a title change does (${fmChanges - proseChanges})`);

// Stale indicator in the Cast panel.
await page.evaluate(() => window.app.commands.executeCommandById("storyloom:open-cast"));
await open("Manuscript/02 - Lamplight.md");
await sleep(800);
await page.evaluate(async () => { const p = window.app.plugins.plugins.storyloom; const f = window.app.vault.getAbstractFileByPath("Manuscript/02 - Lamplight.md"); await p.markStateSynced(f, await window.app.vault.read(f)); });
await sleep(600);
const before = await page.locator(".storyloom-stale").count();
await page.evaluate(async () => { const f = window.app.vault.getAbstractFileByPath("Manuscript/02 - Lamplight.md"); await window.app.vault.process(f, (t) => t + "\nShe slept badly."); });
await sleep(1200);
const after = await page.locator(".storyloom-stale").count();
await shot(page, "p4-stale");
ok(before === 0 && after === 1, "Cast flags a chapter edited since its last story-state update");

// Structured timeline entry.
await page.evaluate(() => { const p = window.app.plugins.plugins.storyloom; p.addTimelineEntry(p.index.entities.get("Elias Crane"), 2); });
await page.waitForSelector(".storyloom-timeline-modal");
const inputs = page.locator(".storyloom-timeline-modal input[type=text]");
await inputs.nth(0).fill("old harbor");
await inputs.nth(1).fill("Worried");
await inputs.nth(2).fill("Mara Winston");
await inputs.nth(4).fill("hears about the shooting");
await shot(page, "p4-timeline-form");
const preview = await page.locator(".storyloom-timeline-preview").innerText();
ok(preview === "- ch 2 | location: [[Old Harbor]] | status: Worried | with: [[Mara Winston]] | note: hears about the shooting", `timeline form previews the exact line, linking known names: ${preview}`);
await page.getByRole("button", { name: "Add to timeline" }).click();
await sleep(600);
const elias = await page.evaluate(async () => window.app.vault.read(window.app.vault.getAbstractFileByPath("Codex/Characters/Elias Crane.md")));
ok(elias.includes(preview), "the line is written to the Timeline section");

// Missing key → Open settings.
await setProvider("anthropic", { apiKey: "" });
await open("Manuscript/01 - The Manor.md");
await sleep(500);
await select(para);
await page.keyboard.press("Control+k");
await page.waitForSelector(".storyloom-glass-input");
await page.keyboard.type("tighten");
await page.keyboard.press("Enter");
await page.waitForSelector(".storyloom-glass-panel[data-phase=error]", { timeout: 5000 }).catch(() => {});
await shot(page, "p4-nokey");
const btn = page.locator(".storyloom-glass-btn", { hasText: "Open settings" });
ok((await btn.count()) === 1, "missing API key offers an Open settings button");
await btn.click().catch(() => {});
await sleep(700);
ok((await page.evaluate(() => window.app.setting.activeTab?.id)) === "storyloom" && (await page.locator(".modal.mod-settings").count()) === 1, "it opens Storyloom's settings tab");
await page.keyboard.press("Escape");

// The CORS block on :11435 is the deliberate fallback test; Chromium always logs it.
const errs = logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/localhost:11435|ERR_FAILED/.test(l));
ok(errs.length === 0, `no console errors ${errs.length ? JSON.stringify(errs) : ""}`);
await app.close();
