import { readFileSync } from "fs";
import { launch, shot } from "./launch.mjs";
const { app, page, logs } = await launch();
const ok = (cond, msg) => console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
const open = (p) => page.evaluate(async (p) => { await window.app.workspace.openLinkText(p, "", false); }, p);
const sleep = (ms) => page.waitForTimeout(ms);
const read = (p) => page.evaluate(async (p) => { const f = window.app.vault.getAbstractFileByPath(p); return f ? window.app.vault.read(f) : null; }, p);
const cmd = (id) => page.evaluate((id) => window.app.commands.executeCommandById(id), id);
for (let i = 0; i < 40; i++) { if (await page.evaluate(() => !!window.app?.plugins?.plugins?.storyloom?.index?.ready).catch(() => false)) break; await sleep(300); }
await page.evaluate(async () => { const p = window.app.plugins.plugins.storyloom; p.settings.provider = "ollama"; p.settings.providers.ollama = { apiKey: "", baseUrl: "http://localhost:11434/v1", model: "x" }; await p.saveSettings(); });

// (6) Update story state.
await open("Manuscript/03 - The Harbor.md");
await sleep(800);
const files = ["Codex/Characters/Mara Winston.md", "Codex/Characters/Elias Crane.md", "Codex/Characters/Arthur Vane.md"];
const before = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await read(f)])));
await cmd("storyloom:update-story-state");
await page.waitForSelector(".storyloom-review-modal", { timeout: 10000 });
await sleep(300);
await shot(page, "06-review");
// A long review scrolls, and Apply stays reachable.
const scroll = await page.evaluate(async () => {
	const c = document.querySelector(".storyloom-review-modal .modal-content");
	const g = c.querySelector(".storyloom-review-group");
	const before = c.querySelector(".setting-item:last-child");
	const clones = Array.from({ length: 30 }, () => c.insertBefore(g.cloneNode(true), before));
	clones.forEach((x) => x.classList.add("e2e-clone"));
	c.scrollTop = 0;
	await new Promise((r) => setTimeout(r, 50));
	const apply = [...document.querySelectorAll(".storyloom-review-modal button")].find((b) => b.textContent === "Apply").getBoundingClientRect();
	const modal = document.querySelector(".storyloom-review-modal").getBoundingClientRect();
	return { scrolls: c.scrollHeight > c.clientHeight + 100, overflow: getComputedStyle(c).overflowY, applyVisible: apply.bottom <= modal.bottom && apply.bottom <= window.innerHeight && apply.top >= modal.top };
});
await shot(page, "06-review-long");
await page.evaluate(() => document.querySelectorAll(".e2e-clone").forEach((x) => x.remove()));
ok(scroll.scrolls && scroll.overflow === "auto" && scroll.applyVisible, `(6) a long review scrolls and Apply stays visible ${JSON.stringify(scroll)}`);
const rows = await page.evaluate(() => [...document.querySelectorAll(".storyloom-review-group")].map((g) => g.innerText.replace(/\n+/g, " | ")));
console.log("   review groups:", JSON.stringify(rows));
ok(!rows.some((r) => r.startsWith("Mara Winston")), "(6) already-recorded changes (Mara's ch 3 location/status/note) are not proposed again");
// Uncheck Arthur's status row.
await page.evaluate(() => {
	const g = [...document.querySelectorAll(".storyloom-review-group")].find((g) => g.querySelector(".storyloom-review-entity").textContent.startsWith("Arthur Vane"));
	const cb = g.querySelector("input[type=checkbox]");
	cb.checked = false;
	cb.dispatchEvent(new Event("change"));
});
await page.getByRole("button", { name: "Apply" }).click();
await sleep(1500);
const after = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await read(f)])));
const rook = await read("Codex/Characters/Captain Rook.md");
ok(after["Codex/Characters/Arthur Vane.md"] === before["Codex/Characters/Arthur Vane.md"], "(6) unchecked change (Arthur's status) was not written");
ok(after["Codex/Characters/Mara Winston.md"] === before["Codex/Characters/Mara Winston.md"], "(6) Mara's note untouched (nothing new for her)");
const elias = after["Codex/Characters/Elias Crane.md"];
ok(/- ch 3 \| knows: Mara is working for Arthur \| note: agrees to help Mara/.test(elias), "(6) Elias got the checked timeline line");
ok(/- \[\[Mara Winston\]\]: former partner \(ch 1-2\)/.test(elias) && /- \[\[Mara Winston\]\]: ally \(ch 3\+\)/.test(elias), "(6) relationship with endsPrevious closed the old range and added the new one");
ok(rook && /type: character/.test(rook) && /aliases: \[Rook\]/.test(rook) && /Runs the night boats/.test(rook) && /## Voice/.test(rook), "(6) Captain Rook created from the Character template");
console.log(elias.split("## Relationships")[1]);
// Run again: nothing new should be written.
await sleep(1000);
const snapshot = Object.fromEntries(await Promise.all([...files, "Codex/Characters/Captain Rook.md"].map(async (f) => [f, await read(f)])));
await cmd("storyloom:update-story-state");
await page.waitForSelector(".storyloom-review-modal", { timeout: 10000 });
await sleep(300);
const rows2 = await page.evaluate(() => [...document.querySelectorAll(".storyloom-review-group")].map((g) => g.innerText.replace(/\n+/g, " | ")));
console.log("   second run groups:", JSON.stringify(rows2));
await page.getByRole("button", { name: "Apply" }).click();
await sleep(1500);
const snapshot2 = Object.fromEntries(await Promise.all(Object.keys(snapshot).map(async (f) => [f, await read(f)])));
const changed = Object.keys(snapshot).filter((f) => snapshot[f] !== snapshot2[f] && f !== "Codex/Characters/Arthur Vane.md");
ok(changed.length === 0 && rows2.length === 1 && rows2[0].startsWith("Arthur Vane"), `(6) second run proposes only the previously unchecked item and duplicates nothing ${changed.join()}`);
ok((snapshot2["Codex/Characters/Arthur Vane.md"].match(/- ch 3/g) ?? []).length === 2, "(6) applying the remaining Arthur change once adds exactly one line");

// Summarize → save to frontmatter.
await cmd("storyloom:summarize-chapter");
await page.waitForSelector(".storyloom-result-text", { timeout: 8000 });
await page.getByRole("button", { name: "Save to summary" }).click();
await sleep(800);
const ch3 = await read("Manuscript/03 - The Harbor.md");
ok(/summary: The fog pressed in/.test(ch3), "summary written to frontmatter");

// Continuity check: clicking an issue jumps to the line.
await cmd("storyloom:continuity-check");
await page.waitForSelector(".storyloom-issue", { timeout: 8000 });
await shot(page, "continuity");
await page.locator(".storyloom-issue").first().click();
await sleep(400);
const sel = await page.evaluate(() => window.app.workspace.activeEditor.editor.getSelection());
ok(sel === "Elias Crane sat at a high desk", `continuity issue click selects the quoted line (${JSON.stringify(sel)})`);

// Chat with an @mention.
await cmd("storyloom:open-chat");
await sleep(800);
await page.locator(".storyloom-chat-input").click();
await page.keyboard.type("Where is @Elia");
await sleep(200);
const sug = await page.locator(".storyloom-suggest-item").allInnerTexts();
await page.keyboard.press("Enter");
await page.keyboard.type("in chapter 2?");
const inputVal = await page.locator(".storyloom-chat-input").inputValue();
await page.keyboard.press("Enter");
await page.waitForSelector(".storyloom-chat-msg.is-assistant .markdown-rendered", { timeout: 8000 }).catch(() => {});
await shot(page, "chat");
const lastReq = readFileSync(new URL("./requests.jsonl", import.meta.url), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
ok(sug[0]?.includes("Elias Crane") && inputVal.includes("@[[Elias Crane]]"), `@ autocomplete inserts the entity (${JSON.stringify(inputVal)})`);
ok(/Full note: Elias Crane/.test(lastReq.body.messages[0].content) && /\[\[Elias Crane\]\] in chapter 2/.test(lastReq.body.messages.at(-1).content), "mentioned entity added to context in full");

// New chapter, word count, export.
await cmd("storyloom:new-chapter");
await sleep(400);
await page.keyboard.type("The Night Boats");
await page.keyboard.press("Enter");
await sleep(1200);
const ch4 = await read("Manuscript/04 - The Night Boats.md");
ok(ch4 && /chapter: 4/.test(ch4) && /title: The Night Boats/.test(ch4) && /type: chapter/.test(ch4), "New chapter auto-numbers to 4 from the template");
await cmd("storyloom:export-manuscript");
await sleep(1200);
const exp = await page.evaluate(async () => { const f = window.app.vault.getFiles().find((f) => f.path.startsWith("Exports/")); return f ? window.app.vault.read(f) : ""; });
ok(/^# The Blackwood Ledger/.test(exp) && /## Chapter 1: The Manor/.test(exp) && /## Chapter 4: The Night Boats/.test(exp) && !/storyloom_sample/.test(exp), "Export manuscript: ordered, headings, frontmatter stripped");

// (10) Clear sample content.
await cmd("storyloom:clear-sample-content");
await page.waitForSelector(".modal button.mod-warning", { timeout: 5000 });
await shot(page, "10-clear");
await page.locator(".modal button.mod-warning").click();
await sleep(1500);
const remaining = await page.evaluate(() => window.app.vault.getMarkdownFiles().map((f) => f.path).sort());
console.log("   remaining:", JSON.stringify(remaining));
const has = (p) => remaining.includes(p);
ok(["Book.md", "Start Here.md", "Templates/Chapter.md", "Templates/Character.md", "Templates/Location.md", "Templates/Lore.md"].every(has), "(10) templates, Book.md and Start Here kept");
ok(!remaining.some((p) => p.startsWith("Codex/Characters/Mara") || p.startsWith("Manuscript/01")), "(10) sample chapters and codex removed");
const settingsKept = await page.evaluate(() => window.app.plugins.plugins.storyloom.settings.provider);
ok(settingsKept === "ollama", "(10) settings intact");
const errs = logs.filter((l) => /^\[(error|pageerror)\]/.test(l));
ok(errs.length === 0, `no console errors ${errs.length ? JSON.stringify(errs) : ""}`);
await app.close();
