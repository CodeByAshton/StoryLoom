import { readFileSync } from "fs";
import { launch, shot } from "./launch.mjs";
const { app, page, logs } = await launch();
const ok = (cond, msg) => console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
const open = (p) => page.evaluate(async (p) => { await window.app.workspace.openLinkText(p, "", false); }, p);
const sleep = (ms) => page.waitForTimeout(ms);
const requests = () => readFileSync(new URL("./requests.jsonl", import.meta.url), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const setProvider = (provider, cfg) => page.evaluate(async ([provider, cfg]) => {
	const p = window.app.plugins.plugins.motif;
	p.settings.provider = provider;
	p.settings.providers[provider] = { ...(p.settings.providers[provider] ?? {}), ...cfg };
	await p.saveSettings();
}, [provider, cfg]);
const doc = () => page.evaluate(() => window.app.workspace.activeEditor.editor.getValue());
const ready = async () => { for (let i = 0; i < 40; i++) { if (await page.evaluate(() => !!window.app?.plugins?.plugins?.motif?.index?.ready).catch(() => false)) return; await sleep(300); } };
await ready();

// (9) Ollama selected, no key → requests go to the local endpoint.
await setProvider("ollama", { apiKey: "" });
const before = requests().length;
await open("Manuscript/03 - The Harbor.md");
await sleep(800);
await page.evaluate(() => {
	const e = window.app.workspace.activeEditor.editor;
	e.setCursor({ line: e.lastLine(), ch: e.getLine(e.lastLine()).length });
	window.app.commands.executeCommandById("motif:continue-writing");
});
await sleep(500);
await page.keyboard.type("she heads for the night boats");
await page.keyboard.press("Enter");
await page.waitForSelector(".storyloom-result-text", { timeout: 8000 }).catch(() => {});
await shot(page, "07-continue");
const reqs = requests().slice(before);
const last = reqs.at(-1);
ok(reqs.length === 1 && last.url === "/v1/chat/completions" && last.auth === null, `(9) Ollama request hit localhost:11434${last?.url} with no auth header`);
ok(/Mara Winston/.test(last?.body.messages[0].content) && /Voice sample|patient as a debt collector/.test(last?.body.messages[0].content), "(8.2) context includes codex cards and Book voice sample");
ok(/night boats/.test(last?.body.messages.at(-1).content), "(7) direction passed to the model");
// (7) Insert at cursor
const pre = await doc();
await page.getByRole("button", { name: "Insert at cursor" }).click();
await sleep(300);
const post = await doc();
ok(post.length > pre.length && /The fog pressed in\./.test(post.slice(pre.length - 5)), "(7) Continue writing inserted the text at the cursor");

// (7) Invalid key → readable error, no crash.
await setProvider("custom", { apiKey: "bad", baseUrl: "http://localhost:11434/v1", model: "test" });
await page.evaluate(() => window.app.commands.executeCommandById("motif:continue-writing"));
await sleep(400);
await page.keyboard.press("Enter");
await page.waitForSelector(".storyloom-result-modal .storyloom-error", { timeout: 20000 }).catch(() => {});
const err = await page.locator(".storyloom-result-modal .storyloom-error").innerText().catch(() => "(no error shown)");
await shot(page, "07-bad-key");
ok(/rejected the API key/.test(err), `(7) invalid key shows a readable error: ${JSON.stringify(err)}`);
await page.keyboard.press("Escape");
await sleep(300);
await setProvider("ollama", { apiKey: "" });

// Inline edit acceptance (§5.1).
await open("Manuscript/01 - The Manor.md");
await sleep(700);
const original = await doc();
const para = "The door opened before she could knock. Arthur Vane filled it, all good tailoring and bad sleep.";
await page.evaluate((para) => {
	const e = window.app.workspace.activeEditor.editor;
	const i = e.getValue().indexOf(para);
	e.setSelection(e.offsetToPos(i), e.offsetToPos(i + para.length));
	e.focus();
}, para);
const lineY = () => page.evaluate(() => {
	const lines = [...document.querySelectorAll(".cm-content .cm-line")];
	const l = lines.find((x) => x.textContent.startsWith('"My dear detective,"'));
	return l ? Math.round(l.getBoundingClientRect().top) : null;
});
const yBefore = await lineY();
await page.keyboard.press("Control+k");
await page.waitForSelector(".storyloom-glass-input", { timeout: 3000 }).catch(() => {});
await sleep(400);
const yOpen = await lineY();
ok(yBefore !== null && yBefore === yOpen, `(UI) panel floats over the text; following line did not move (${yBefore} → ${yOpen})`);
const inputShown = await page.locator(".storyloom-glass-input").count();
ok(inputShown === 1, "(5.1) Ctrl+K opens the inline input under the selection");
await page.keyboard.type("make it tenser");
await shot(page, "51-input");
await page.keyboard.press("Enter");
await page.waitForSelector(".storyloom-glass-mark.is-shimmer", { timeout: 2000 }).catch(() => {});
ok((await page.locator(".storyloom-glass-mark.is-shimmer").count()) > 0, "(5.1) selection pulses while generating");
await page.waitForSelector(".storyloom-glass-result:not(.is-streaming)", { timeout: 8000 }).catch(() => {});
await sleep(400);
const yResult = await lineY();
ok(yResult === yBefore, `(UI) result is shown in the floating card, document layout unchanged (${yBefore} → ${yResult})`);
await shot(page, "51-diff");
const diffText = await page.locator(".storyloom-glass-result").innerText().catch(() => "");
const struck = await page.locator(".storyloom-glass-mark.is-pending").count();
ok(/TENSE VERSION/.test(diffText) && struck > 0 && (await doc()) === original, "(5.1) inline diff shown (original struck through), document untouched");
const sent = requests().at(-1).body.messages.at(-1).content;
ok(/make it tenser/.test(sent) && sent.includes(`⟦${para}⟧`), "(5.1) prompt contains instruction and the marked selection with surrounding text");
await page.keyboard.press("Tab");
await sleep(300);
const accepted = await doc();
ok(accepted.includes("TENSE VERSION") && !accepted.includes(para) && (await page.locator(".storyloom-glass-panel:not(.is-ghost)").count()) === 0, "(5.1) Tab accepts and replaces the selection");
await page.keyboard.press("Control+z");
await sleep(300);
ok((await doc()) === original, "(5.1) a single Ctrl+Z restores the original");
// Second attempt, Esc.
await page.evaluate((para) => {
	const e = window.app.workspace.activeEditor.editor;
	const i = e.getValue().indexOf(para);
	e.setSelection(e.offsetToPos(i), e.offsetToPos(i + para.length));
	e.focus();
}, para);
await page.keyboard.press("Control+k");
await page.waitForSelector(".storyloom-glass-input", { timeout: 3000 }).catch(() => {});
await page.keyboard.type("make it tenser");
await page.keyboard.press("Enter");
await page.waitForSelector(".storyloom-glass-result:not(.is-streaming)", { timeout: 8000 }).catch(() => {});
await page.keyboard.press("Escape");
await sleep(300);
ok((await doc()) === original && (await page.locator(".storyloom-glass-panel:not(.is-ghost)").count()) === 0, "(5.1) Esc on a second attempt leaves the document untouched");
// Editing elsewhere cancels a pending result.
await page.evaluate((para) => {
	const e = window.app.workspace.activeEditor.editor;
	const i = e.getValue().indexOf(para);
	e.setSelection(e.offsetToPos(i), e.offsetToPos(i + para.length));
	e.focus();
}, para);
await page.keyboard.press("Control+k");
await page.waitForSelector(".storyloom-glass-input", { timeout: 3000 }).catch(() => {});
await page.keyboard.type("x");
await page.keyboard.press("Enter");
await sleep(100);
await page.evaluate(() => window.app.workspace.activeEditor.editor.replaceRange("Z", { line: 0, ch: 0 }));
await sleep(900);
const afterEdit = await doc();
ok((await page.locator(".storyloom-glass-panel:not(.is-ghost)").count()) === 0 && !afterEdit.includes("TENSE VERSION"), "(5.1) editing elsewhere cancels the pending result cleanly");
await page.evaluate(() => window.app.workspace.activeEditor.editor.replaceRange("", { line: 0, ch: 0 }, { line: 0, ch: 1 }));
// No selection → insert mode.
await page.evaluate(() => { const e = window.app.workspace.activeEditor.editor; e.setCursor({ line: e.lastLine(), ch: 0 }); e.focus(); });
await page.keyboard.press("Control+k");
await page.waitForSelector(".storyloom-glass-input", { timeout: 3000 }).catch(() => {});
await page.locator(".storyloom-glass-chip", { hasText: "Continue" }).click();
await page.waitForSelector(".storyloom-glass-result:not(.is-streaming)", { timeout: 8000 }).catch(() => {});
await page.keyboard.press("Control+Enter");
await sleep(300);
ok((await doc()).includes("The fog pressed in."), "(5.1) with no selection the result is inserted at the cursor (chip + Ctrl+Enter)");
await page.keyboard.press("Control+z");
await sleep(200);

// The bad-key check streams via fetch, so Chromium logs the expected 401.
const errs = logs.filter((l) => /^\[(error|pageerror)\]/.test(l) && !/status of 401/.test(l));
ok(errs.length === 0, `no console errors during AI flows ${errs.length ? JSON.stringify(errs) : ""}`);
await app.close();
