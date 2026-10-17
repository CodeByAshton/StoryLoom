// Chapters board: drag to reorder (codex follows), drag between status columns.
import { launch, shot } from "./launch.mjs";
const { app, page, logs } = await launch();
const ok = (cond, msg) => console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
const sleep = (ms) => page.waitForTimeout(ms);
const read = (p) => page.evaluate(async (p) => { const f = window.app.vault.getAbstractFileByPath(p); return f ? window.app.vault.read(f) : null; }, p);
for (let i = 0; i < 40; i++) { if (await page.evaluate(() => !!window.app?.plugins?.plugins?.storyloom?.index?.ready).catch(() => false)) break; await sleep(300); }

await page.locator('.side-dock-ribbon-action[aria-label="Storyloom"]').click();
await page.locator(".menu .menu-item", { hasText: /^Chapters$/ }).click();
await page.waitForSelector(".sl-ch-card[data-path]");
await sleep(600);
const titles = () => page.locator(".sl-ch-grid .sl-ch-card[data-path] .sl-ch-card-title").allInnerTexts();
ok(JSON.stringify(await titles()) === JSON.stringify(["The Manor", "Lamplight", "The Harbor"]), "outline shows chapters in order");
const card3 = await page.locator('.sl-ch-card[data-path="Manuscript/03 - The Harbor.md"]').innerText();
ok(/Summarize/.test(card3) && /Mara Winston's point of view/.test(card3) && /words/.test(card3), "card shows POV, word count, and Summarize when there's no summary");
const card1 = await page.locator('.sl-ch-card[data-path="Manuscript/01 - The Manor.md"]').innerText();
ok(/arrives at Blackwood Manor/.test(card1), "card shows the chapter summary");
await shot(page, "p7-outline");

// Drag "The Harbor" onto the left half of "The Manor" (drop before it).
const src = page.locator('.sl-ch-card[data-path="Manuscript/03 - The Harbor.md"]');
const dst = page.locator('.sl-ch-card[data-path="Manuscript/01 - The Manor.md"]');
await src.dragTo(dst, { targetPosition: { x: 10, y: 60 } });
await page.waitForSelector(".modal.storyloom-glass-modal", { timeout: 5000 }).catch(() => {});
const confirm = await page.locator(".modal.storyloom-glass-modal").innerText().catch(() => "");
await shot(page, "p7-confirm");
ok(/“The Harbor”: chapter 3 → 1/.test(confirm) && /“The Manor”: chapter 1 → 2/.test(confirm) && /“Lamplight”: chapter 2 → 3/.test(confirm) && /renamed/.test(confirm), `dragging asks first and lists every change`);
await page.locator(".modal button", { hasText: "Reorder" }).click();
await sleep(2500);

const files = await page.evaluate(() => window.app.vault.getMarkdownFiles().map((f) => f.path).filter((p) => p.startsWith("Manuscript/")).sort());
ok(JSON.stringify(files) === JSON.stringify(["Manuscript/01 - The Harbor.md", "Manuscript/02 - The Manor.md", "Manuscript/03 - Lamplight.md"]), `files renamed to match: ${files.join(", ")}`);
const fm = await read("Manuscript/01 - The Harbor.md");
ok(/chapter: 1/.test(fm), "frontmatter chapter numbers updated");
const mara = await read("Codex/Characters/Mara Winston.md");
const tl = mara.split("## Timeline")[1].trim().split("\n");
ok(tl[0].startsWith("- ch 1 | location: [[Old Harbor]]") && tl[1].startsWith("- ch 2 | location: [[Blackwood Manor]]") && tl[2].startsWith("- ch 3 | status: Injured"), `Mara's timeline lines follow their chapters, in order:\n      ${tl.join("\n      ")}`);
ok(mara.includes("reluctant ally (ch 2-3)") && mara.includes("rival (ch 1+)"), "relationship ranges follow their chapters");
await sleep(800);
const now = await page.evaluate(() => {
	const p = window.app.plugins.plugins.storyloom;
	const s = (ch) => p.index.resolve(p.index.entities.get("Mara Winston"), ch).fields.location;
	return [s(1), p.index.chapters.map((c) => `${c.chapter}:${c.title}`).join(",")];
});
ok(now[0] === "[[Old Harbor]]" && now[1] === "1:The Harbor,2:The Manor,3:Lamplight", `index and state agree after reorder (${now.join(" | ")})`);
ok(JSON.stringify(await titles()) === JSON.stringify(["The Harbor", "The Manor", "Lamplight"]), "outline re-renders in the new order");

// Board: drag a card into Final.
await page.locator(".sl-tl-segmented button", { hasText: "Board" }).click();
await sleep(600);
// The event sequence a drag produces (headless Chromium's own drag pipeline is unreliable for
// drops into a second container, so the events are dispatched directly through our real handlers).
await page.evaluate(() => {
	const card = document.querySelector('.sl-ch-col.is-draft .sl-ch-card[data-path="Manuscript/03 - Lamplight.md"]');
	const col = document.querySelector(".sl-ch-col.is-final");
	const target = col.querySelector(".sl-ch-col-empty") ?? col;
	const dt = new DataTransfer();
	const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
	fire(card, "dragstart");
	const entered = !fire(target, "dragenter"); // cancelled = accepted as a drop target
	const over = !fire(target, "dragover");
	window.__accepted = entered && over;
	fire(target, "drop");
	fire(card, "dragend");
});
ok(await page.evaluate(() => window.__accepted), "the Final column accepts the drag (dragenter and dragover cancelled)");
await sleep(1200);
const status = await read("Manuscript/03 - Lamplight.md");
ok(/status: final/.test(status) && (await page.locator('.sl-ch-col.is-final .sl-ch-card[data-path="Manuscript/03 - Lamplight.md"]').count()) === 1, "dragging to the Final column sets status: final");
await shot(page, "p7-board");

// Keyboard: focus the first card in the outline and press Alt+→ to move it one place.
await page.locator(".sl-tl-segmented button", { hasText: "Outline" }).click();
await sleep(600);
const first = page.locator(".sl-ch-grid .sl-ch-card[data-path]").first();
const firstTitle = await first.locator(".sl-ch-card-title").innerText();
await first.focus();
await page.keyboard.press("Alt+ArrowRight");
await page.waitForSelector(".modal.storyloom-glass-modal", { timeout: 5000 }).catch(() => {});
const kb = await page.locator(".modal.storyloom-glass-modal").innerText().catch(() => "");
ok(new RegExp(`“${firstTitle}”: chapter 1 → 2`).test(kb), `Alt+→ on a focused card proposes moving it one place (${firstTitle})`);
await page.locator(".modal button", { hasText: "Cancel" }).click();
await sleep(300);

const errs = logs.filter((l) => /^\[(error|pageerror)\]/.test(l));
ok(errs.length === 0, `no console errors ${errs.length ? JSON.stringify(errs) : ""}`);
await app.close();
