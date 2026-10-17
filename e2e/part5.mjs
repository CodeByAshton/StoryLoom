// Claude Code provider (fake CLI + the real CLI with an invalid key) and glass modals.
import { readFileSync } from "fs";
import { launch, shot } from "./launch.mjs";
const S = process.env.STORYLOOM_E2E_DIR ?? "/tmp/storyloom-e2e";
const FAKE = process.env.FAKE_CLAUDE ?? `${S}/fake-claude/claude`; // copy e2e/fixtures/fake-claude there;
const REAL = process.env.REAL_CLAUDE_ISOLATED ?? `${S}/real-claude-isolated.sh`;
const { app, page, logs } = await launch();
const ok = (cond, msg) => console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
const sleep = (ms) => page.waitForTimeout(ms);
const open = (p) => page.evaluate(async (p) => { await window.app.workspace.openLinkText(p, "", false); }, p);
const doc = () => page.evaluate(() => window.app.workspace.activeEditor.editor.getValue());
for (let i = 0; i < 40; i++) { if (await page.evaluate(() => !!window.app?.plugins?.plugins?.storyloom?.index?.ready).catch(() => false)) break; await sleep(300); }
const useClaudeCode = (bin) => page.evaluate(async (bin) => {
	const p = window.app.plugins.plugins.storyloom;
	p.settings.provider = "claudecode";
	p.settings.providers.claudecode = { apiKey: "", baseUrl: bin, model: "sonnet" };
	await p.saveSettings();
}, bin);
const para = "The door opened before she could knock. Arthur Vane filled it, all good tailoring and bad sleep.";
const select = () => page.evaluate((para) => { const e = window.app.workspace.activeEditor.editor; const i = e.getValue().indexOf(para); e.setSelection(e.offsetToPos(i), e.offsetToPos(i + para.length)); e.focus(); }, para);

// Settings: provider choice and sign-in check.
await useClaudeCode(FAKE);
await page.evaluate(() => { window.app.setting.open(); window.app.setting.openTabById("storyloom"); });
await sleep(600);
await page.locator(".vertical-tab-content button", { hasText: "Check" }).click();
await page.waitForFunction(() => /signed in with/i.test(document.querySelector(".vertical-tab-content")?.innerText ?? ""), null, { timeout: 8000 }).catch(() => {});
const settingsText = await page.locator(".vertical-tab-content").innerText();
await shot(page, "p5-settings");
ok(/Claude Code is signed in with your Claude account/.test(settingsText) && !/API key\n/.test(settingsText.split("Sign-in")[0]), "settings: Claude Code provider has no key field and Check reports the sign-in");
await page.keyboard.press("Escape");
await sleep(300);

// Inline edit through Claude Code, streaming.
await open("Manuscript/01 - The Manor.md");
await sleep(700);
await select();
await page.keyboard.press("Control+k");
await page.waitForSelector(".storyloom-glass-input");
await page.keyboard.type("make it tenser");
await page.keyboard.press("Enter");
await page.waitForSelector(".storyloom-glass-result.is-streaming", { timeout: 8000 }).catch(() => {});
const streamed = await page.locator(".storyloom-glass-result.is-streaming").count();
await page.waitForSelector(".storyloom-glass-result:not(.is-streaming)", { timeout: 15000 }).catch(() => {});
const result = await page.locator(".storyloom-glass-result").innerText().catch(() => "");
ok(streamed === 1 && /CC version/.test(result), "inline edit streams through Claude Code");
await page.keyboard.press("Tab");
await sleep(300);
ok((await doc()).includes("CC version: her heart hammered at the door."), "Claude Code result accepted with Tab");
await page.keyboard.press("Control+z");
const call = JSON.parse(readFileSync(`${FAKE.replace(/claude$/, "")}last-call.json`, "utf8"));
ok(call.args.includes("--safe-mode") && call.args[call.args.indexOf("--tools") + 1] === "" && call.args.includes("--no-session-persistence") && !call.args.includes("--bare"), "CLI is run tool-less, in safe mode, without saving a session");
ok(/patient as a debt collector/.test(call.system) && call.system.includes("__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__") && /make it tenser/.test(call.stdin), "book context goes in the system prompt file (with the cache boundary); the request on stdin");
ok(!/StoryLoom|vault/.test(call.cwd), `runs outside the vault so no CLAUDE.md is picked up (cwd ${call.cwd})`);

// The real Claude Code CLI, isolated with an invalid key: flags accepted, error readable.
await useClaudeCode(REAL);
await select();
await page.keyboard.press("Control+k");
await page.waitForSelector(".storyloom-glass-input");
await page.keyboard.type("tighten");
await page.keyboard.press("Enter");
await page.waitForSelector(".storyloom-glass-panel[data-phase=error]", { timeout: 60000 }).catch(() => {});
const err = await page.locator(".storyloom-glass-error").innerText().catch(() => "");
await shot(page, "p5-real-cli-error");
ok(/Claude Code isn't signed in.*Invalid API key/s.test(err), `real CLI: Storyloom's flags are accepted and its auth failure is readable: ${JSON.stringify(err.slice(0, 160))}`);
await page.keyboard.press("Escape");
await sleep(300);

// Missing install.
await useClaudeCode("/nonexistent/claude");
await page.evaluate(() => window.app.commands.executeCommandById("storyloom:continue-writing"));
await sleep(400);
await page.keyboard.press("Enter");
await page.waitForSelector(".storyloom-result-modal .storyloom-error", { timeout: 8000 }).catch(() => {});
const missing = await page.locator(".storyloom-result-modal .storyloom-error").innerText().catch(() => "");
ok(/Couldn't find Claude Code/.test(missing) && (await page.locator(".storyloom-result-modal button", { hasText: "Open settings" }).count()) === 1, "missing Claude Code: readable error with Open settings");
await shot(page, "p5-modal-error");
await page.keyboard.press("Escape");
await sleep(300);

// Glass modals.
await useClaudeCode(FAKE);
// Every Storyloom pop-up shares one material: a solid surface with a hairline border and a soft shadow.
const glassCount = () => page.evaluate(() => { const m = document.querySelector(".modal.storyloom-glass-modal, .prompt.storyloom-glass-modal"); if (!m) return "none"; const cs = getComputedStyle(m); return cs.boxShadow !== "none" && parseFloat(cs.borderTopWidth) > 0 ? "styled" : "unstyled"; });
await select();
await page.evaluate(() => window.app.commands.executeCommandById("storyloom:rewrite-selection"));
await sleep(500);
const pickerGlass = await glassCount();
await shot(page, "p5-picker");
await page.keyboard.type("Tighter");
await page.keyboard.press("Enter");
await page.waitForSelector(".storyloom-result-item", { timeout: 10000 }).catch(() => {});
await sleep(400);
const modalGlass = await glassCount();
await shot(page, "p5-rewrite-modal");
ok(pickerGlass === "styled" && modalGlass === "styled", `pickers and result pop-ups share the Storyloom pop-up style (${pickerGlass} / ${modalGlass})`);
await page.keyboard.press("Escape");
await sleep(300);
await page.evaluate(() => window.app.commands.executeCommandById("storyloom:word-count"));
await sleep(500);
await shot(page, "p5-wordcount");
await page.keyboard.press("Escape");

const errs = logs.filter((l) => /^\[(error|pageerror)\]/.test(l));
ok(errs.length === 0, `no console errors ${errs.length ? JSON.stringify(errs) : ""}`);
await app.close();
