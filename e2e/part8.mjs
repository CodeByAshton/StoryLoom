// Polish: setup guide, the Motif menu, view tabs, status bar, empty states, scaffolding. Run with KEEP_SETUP=1.
import { launch, shot } from "./launch.mjs";
process.env.KEEP_SETUP = "1";
const { app, page, logs } = await launch();
const ok = (cond, msg) => console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
const sleep = (ms) => page.waitForTimeout(ms);
const exists = (p) => page.evaluate((p) => !!window.app.vault.getAbstractFileByPath(p), p);
const read = (p) => page.evaluate(async (p) => { const f = window.app.vault.getAbstractFileByPath(p); return f ? window.app.vault.read(f) : null; }, p);
const activeType = () => page.evaluate(() => window.app.workspace.getMostRecentLeaf()?.view.getViewType());
for (let i = 0; i < 40; i++) { if (await page.evaluate(() => !!window.app?.plugins?.plugins?.motif?.index?.ready).catch(() => false)) break; await sleep(300); }

// ---- Setup guide on first run ----
await page.waitForSelector(".modal.sl-setup", { timeout: 8000 }).catch(() => {});
ok((await page.locator(".modal.sl-setup").count()) === 1, "setup guide opens on first run");
ok((await page.locator(".sl-setup-step.is-active").innerText()).includes("Connect AI"), "starts on Connect AI");
await sleep(400);
await shot(page, "p8-setup-1");
await page.locator(".sl-setup-choice", { hasText: "Local model" }).click();
ok(await page.evaluate(() => window.app.plugins.plugins.motif.settings.provider) === "ollama", "picking a card sets the provider");
ok((await page.locator(".sl-setup-choice.is-selected").count()) === 1, "exactly one card selected");
await page.locator(".sl-setup-test").click();
await page.waitForSelector(".sl-setup-result.is-ok, .sl-setup-result.is-error", { timeout: 15000 }).catch(() => {});
const result = await page.locator(".sl-setup-result").innerText();
ok(/Connected/.test(result), `test connection shows the result inline: ${result}`);
await shot(page, "p8-setup-1-tested");
await page.locator(".sl-setup-footer button.mod-cta", { hasText: "Continue" }).click();
await sleep(300);
ok(/already set up/.test(await page.locator(".sl-setup-body").innerText()), "book step: the sample vault is already set up");
await page.locator(".sl-setup-footer button", { hasText: "Back" }).click();
await sleep(200);
ok((await page.locator(".sl-setup-step.is-active").innerText()).includes("Connect AI"), "Back returns to the previous step");
await page.locator(".sl-setup-footer button.mod-cta").click();
await page.locator(".sl-setup-footer button.mod-cta").click();
await sleep(300);
ok((await page.locator(".sl-setup-tip").count()) === 4, "ready step shows tips");
await shot(page, "p8-setup-3");
await page.locator(".sl-setup-footer button.mod-cta", { hasText: "Open chapters" }).click();
await sleep(800);
ok((await page.locator(".modal.sl-setup").count()) === 0 && (await activeType()) === "storyloom-chapters", "finishing opens Chapters");
ok(await page.evaluate(() => window.app.plugins.plugins.motif.settings.onboarded) === true, "setup is remembered");

// ---- Tabs between views, in the same pane ----
const leaves = () => page.evaluate(() => ["storyloom-chapters", "storyloom-codex", "storyloom-timeline", "storyloom-graph"].map((t) => window.app.workspace.getLeavesOfType(t).length).join(","));
ok((await page.locator(".sl-ch .sl-nav-tab.is-active").getAttribute("aria-label")) === "Chapters", "Chapters tab is active");
await page.locator(".sl-ch .sl-nav-tab", { hasText: "Timeline" }).click();
await page.waitForSelector(".sl-tl .sl-nav-tab.is-active", { timeout: 5000 });
ok((await leaves()) === "0,0,1,0", `switching tabs replaces the view in the same pane (${await leaves()})`);
await page.locator(".sl-tl .sl-nav-tab", { hasText: "Graph" }).click();
await page.waitForSelector(".storyloom-graph .storyloom-graph-stage .storyloom-scrubber.storyloom-glass", { timeout: 5000 }).catch(() => {});
ok((await page.locator(".storyloom-graph-stage > .storyloom-scrubber.storyloom-glass").count()) === 1, "graph scrubber floats over the graph");
await sleep(600);
await shot(page, "p8-graph");
const bf = await page.evaluate(() => { const cs = getComputedStyle(document.querySelector(".storyloom-scrubber")); return { shadow: cs.boxShadow !== "none", bg: cs.backgroundColor }; });
ok(bf.shadow && !/rgba\(0, 0, 0, 0\)/.test(bf.bg), `scrubber floats on a solid surface ${JSON.stringify(bf)}`);
for (const t of ["Characters", "Locations", "Lore"]) await page.locator(".storyloom-graph .sl-cx-chips .sl-cx-chip", { hasText: t }).click();
await sleep(300);
ok(/Everything is filtered out/.test(await page.locator(".storyloom-graph-stage .sl-empty").innerText().catch(() => "")), "graph explains an all-filtered view");
for (const t of ["Characters", "Locations", "Lore"]) await page.locator(".storyloom-graph .sl-cx-chips .sl-cx-chip", { hasText: t }).click();
await sleep(300);
ok((await page.locator(".storyloom-graph-stage .sl-empty").count()) === 0, "empty state goes away when types come back");

// ---- One ribbon button with a menu ----
ok((await page.locator('.side-dock-ribbon-action[aria-label="Motif"]').count()) === 1 && (await page.locator('.side-dock-ribbon-action[aria-label="Motif: Sync chapter"]').count()) === 1, "ribbon: one Motif menu button plus Sync chapter");
await page.locator('.side-dock-ribbon-action[aria-label="Motif"]').click();
await sleep(300);
const items = await page.locator(".menu .menu-item-title").allInnerTexts();
ok(["Chapters", "Codex", "Story timeline", "Story graph", "Cast", "Story assistant", "New chapter", "New character", "Setup guide", "Settings"].every((x) => items.includes(x)), `menu lists views and actions: ${items.join(", ")}`);
await shot(page, "p8-menu");
await page.locator(".menu .menu-item", { hasText: /^Codex$/ }).click();
await sleep(500);
ok((await activeType()) === "storyloom-codex", "menu opens the codex");

// ---- Status bar ----
await page.evaluate(() => window.app.workspace.openLinkText("Manuscript/03 - The Harbor.md", "", false));
await sleep(1200);
const status = () => page.locator(".status-bar .sl-status").innerText().catch(() => "");
ok(/Chapter 3 of 3\s*The Harbor/.test(await status()), `status bar shows the chapter: ${await status()}`);
await page.evaluate(async () => { const p = window.app.plugins.plugins.motif; const f = p.activeMarkdownFile(); await p.markStateSynced(f, await window.app.vault.read(f)); });
await sleep(800);
ok((await page.locator(".status-bar .sl-status .sl-status-dot").count()) === 0, "no dot while the story state is up to date");
await page.evaluate(() => { const e = window.app.workspace.activeEditor.editor; e.replaceRange(" She left.", { line: e.lastLine(), ch: e.getLine(e.lastLine()).length }); });
await sleep(1000);
ok((await page.locator(".status-bar .sl-status .sl-status-dot").count()) === 1, "typing marks the chapter as needing a story-state update");
await page.locator(".status-bar .sl-status").click();
await sleep(300);
const sm = await page.locator(".menu .menu-item-title").allInnerTexts();
ok(sm.includes("Sync chapter") && sm.includes("Next chapter"), `status menu has chapter actions: ${sm.join(", ")}`);
await shot(page, "p8-status");
await page.keyboard.press("Escape");
await page.evaluate(() => window.app.workspace.openLinkText("Start Here.md", "", false));
await sleep(800);
ok(!(await page.locator(".status-bar .sl-status").isVisible()), "status bar item hides outside chapters");

// ---- Sync: writes straight to the codex (no review), and a re-sync replaces what the last sync wrote ----
const elias = "Codex/Characters/Elias Crane.md";
const ch3 = "Manuscript/03 - The Harbor.md";
await page.evaluate((p) => window.app.workspace.openLinkText(p, "", false), ch3);
await sleep(1000);
ok((await page.locator(".workspace-leaf.mod-active .view-action.sl-header-sync").count()) === 1, "chapter header has a Sync button");
const before3 = (await read(elias)) ?? "";
await page.locator(".workspace-leaf.mod-active .view-action.sl-header-sync").click();
await sleep(2500);
ok((await page.locator(".storyloom-review-modal").count()) === 0, "sync doesn't ask for approval");
const after3 = (await read(elias)) ?? "";
const ch3Lines = (t) => t.split("\n").filter((l) => /^- ch 3 \|/.test(l));
ok(ch3Lines(after3).length > ch3Lines(before3).length && /agrees to help Mara/.test(after3), "sync wrote Elias's chapter 3 changes");
ok(await exists("Codex/Characters/Captain Rook.md"), "sync created the new character");
const notice = await page.locator(".notice").allInnerTexts();
ok(notice.some((n) => /synced chapter 3/i.test(n) && /1 new note/.test(n)), `sync reports what it recorded: ${notice.find((n) => /synced/i.test(n))}`);
// Writing notes: underlined in the chapter, counted in the Cast panel, fixed or dismissed from a hover card.
await sleep(500);
ok((await page.locator(".workspace-leaf.mod-active .cm-content .sl-wn").count()) === 2, `sync underlined the writing notes it found (${await page.locator(".workspace-leaf.mod-active .cm-content .sl-wn").count()}; quotes not in the chapter are dropped)`);
ok(/2 writing notes/.test(await page.locator(".status-bar .sl-status").innerText()), "status bar counts the writing notes");
// The AI review switch in the chapter's header turns the notes off and back on.
const clearNotices = () => page.locator(".notice").evaluateAll((ns) => ns.forEach((n) => n.remove()));
await clearNotices();
const reviewBtn = page.locator(".workspace-leaf.mod-active .view-action.sl-header-review");
ok((await reviewBtn.count()) === 1 && (await reviewBtn.getAttribute("class")).includes("is-active"), "chapter header has an AI review switch, on by default");
await reviewBtn.click();
await sleep(500);
ok((await page.locator(".workspace-leaf.mod-active .cm-content .sl-wn").count()) === 0 && !(await reviewBtn.getAttribute("class")).includes("is-active") && !/notes/.test(await page.locator(".status-bar .sl-status").innerText()), "turning AI review off hides the notes");
await clearNotices();
await reviewBtn.click();
await sleep(500);
ok((await page.locator(".workspace-leaf.mod-active .cm-content .sl-wn").count()) === 2, "turning it back on brings the same notes back");
await page.locator(".notice").evaluateAll((ns) => ns.forEach((n) => n.remove()));
await page.locator(".workspace-leaf.mod-active .cm-content .sl-wn-word-choice").first().hover();
await page.waitForSelector(".sl-wn-card", { timeout: 4000 }).catch(() => {});
await sleep(300);
const card = await page.locator(".sl-wn-card").innerText().catch(() => "");
ok(/Word choice/.test(card) && /paced the length/.test(card), "hovering a note shows what's wrong and the fix");
ok((await page.locator(".cm-tooltip .storyloom-hover:not(.sl-wn-card)").count()) === 0, "the character card stays out of the way over a writing note");
await shot(page, "p8-writing-note");
await page.locator(".sl-wn-card button", { hasText: "Fix" }).click();
await sleep(600);
const fixed = (await read(ch3)) ?? (await page.evaluate(() => window.app.workspace.activeEditor.editor.getValue()));
const live = await page.evaluate(() => window.app.workspace.getLeavesOfType("markdown").map((l) => l.view.editor.getValue()).join("\n"));
ok(/Mara paced the length of the quay/.test(live), "Fix replaces the text in the chapter");
ok((await page.locator(".workspace-leaf.mod-active .cm-content .sl-wn").count()) === 1, "the fixed note goes away");
await page.mouse.move(5, 5);
await sleep(300);
await page.locator(".workspace-leaf.mod-active .cm-content .sl-wn").first().hover();
await page.waitForSelector(".sl-wn-card", { timeout: 4000 }).catch(() => {});
await page.locator(".sl-wn-card button", { hasText: "Dismiss" }).click();
await sleep(500);
ok((await page.locator(".workspace-leaf.mod-active .cm-content .sl-wn").count()) === 0 && (await page.evaluate((p) => window.app.plugins.plugins.motif.notesFor(p).length, ch3)) === 0, "Dismiss removes a note for good");
void fixed;

// Pretend an earlier sync wrote a line the chapter no longer supports, then re-sync from the ribbon.
await page.evaluate(async ([elias, ch3]) => {
	const p = window.app.plugins.plugins.motif;
	const f = window.app.vault.getAbstractFileByPath(elias);
	const stale = "- ch 3 | status: Asleep at his desk";
	await window.app.vault.process(f, (t) => t.replace("## Timeline\n", `## Timeline\n${stale}\n`));
	p.settings.syncedLines[ch3] = [...(p.settings.syncedLines[ch3] ?? []), { path: elias, line: stale }];
	await p.saveSettings();
}, [elias, ch3]);
await page.evaluate((p) => window.app.workspace.openLinkText(p, "", false), ch3);
await sleep(500);
await page.locator('.side-dock-ribbon-action[aria-label="Motif: Sync chapter"]').click();
await sleep(2500);
const resynced = (await read(elias)) ?? "";
ok(!/Asleep at his desk/.test(resynced), "re-sync removed the line the chapter no longer supports");
ok(ch3Lines(resynced).length === ch3Lines(after3).length, `re-sync replaced its own lines instead of duplicating them (${ch3Lines(after3).length} → ${ch3Lines(resynced).length})`);
ok(/- ch 2 \| /.test(resynced) || !/- ch 2 \| /.test(before3), "hand-written lines for other chapters stay");

// ---- Layout: codex detail never overlaps the grid; inline panel stays inside the editor ----
await page.evaluate(() => window.app.commands.executeCommandById("motif:open-codex"));
await sleep(600);
await page.locator(".sl-cx-card").first().click();
await sleep(600);
const cx = await page.evaluate(() => {
	const g = document.querySelector(".sl-cx-grid"), d = document.querySelector(".sl-cx-detail");
	const gr = g.getBoundingClientRect(), dr = d.getBoundingClientRect();
	return { hidden: getComputedStyle(g).display === "none", gridRight: Math.round(gr.right), detailLeft: Math.round(dr.left), width: Math.round(document.querySelector(".sl-cx").getBoundingClientRect().width) };
});
ok(cx.hidden || cx.gridRight <= cx.detailLeft + 1, `codex detail doesn't overlap the cards ${JSON.stringify(cx)}`);
await page.locator(".sl-cx-detail .sl-cx-close").click().catch(() => {});
await page.evaluate(() => window.app.commands.executeCommandById("motif:open-cast"));
await page.evaluate(() => window.app.commands.executeCommandById("motif:open-codex"));
await sleep(800);
const clipped = await page.evaluate(() => [...document.querySelectorAll(".sl-cx-card")].filter((c) => c.scrollHeight > c.offsetHeight + 1).length);
ok(clipped === 0, `codex cards are never cut off in a narrow pane (${clipped} clipped)`);
await page.evaluate(() => window.app.workspace.openLinkText("Manuscript/03 - The Harbor.md", "", false));
await sleep(800);
await page.evaluate(() => { const leaf = window.app.workspace.getLeavesOfType("markdown")[0]; window.app.workspace.setActiveLeaf(leaf, { focus: true }); const e = leaf.view.editor; e.focus(); e.setSelection({ line: 4, ch: 0 }, { line: 4, ch: 40 }); });
await sleep(300);
await page.keyboard.press("Control+k");
await page.waitForSelector(".storyloom-glass-panel", { timeout: 5000 }).catch(() => {});
await sleep(500);
const inl = await page.evaluate(() => {
	const p = document.querySelector(".storyloom-glass-panel").getBoundingClientRect();
	const b = document.querySelector(".workspace-leaf.mod-active .cm-scroller").getBoundingClientRect();
	return { left: Math.round(p.left), right: Math.round(p.right), boxLeft: Math.round(b.left), boxRight: Math.round(b.right) };
});
ok(inl.left >= inl.boxLeft && inl.right <= inl.boxRight, `inline edit panel stays inside the editor ${JSON.stringify(inl)}`);
await page.keyboard.press("Escape");
await sleep(300);

// ---- Dark mode hover card: no light box behind the glass ----
await page.evaluate(() => window.app.changeTheme("obsidian"));
await page.evaluate(() => window.app.workspace.openLinkText("Manuscript/03 - The Harbor.md", "", false));
await sleep(1000);
await page.locator('.cm-content [data-storyloom-entity="Elias Crane"]').first().hover();
await page.waitForSelector(".cm-tooltip > .storyloom-hover", { timeout: 5000 }).catch(() => {});
await sleep(500);
const wrap = await page.evaluate(() => { const w = document.querySelector(".cm-tooltip > .storyloom-hover")?.parentElement; if (!w) return null; const cs = getComputedStyle(w); return [cs.backgroundColor, cs.borderTopWidth, cs.boxShadow].join(" | "); });
ok(wrap === "rgba(0, 0, 0, 0) | 0px | none", `hover wrapper is invisible in dark mode (${wrap})`);
await shot(page, "p8-dark-hover");
await page.mouse.move(5, 5);
await page.evaluate(() => window.app.changeTheme("moonstone"));
await sleep(300);

// ---- Empty vault: empty states and scaffolding ----
await page.evaluate(async () => {
	const v = window.app.vault;
	for (const p of ["Manuscript", "Codex", "Templates", "Book.md"]) { const f = v.getAbstractFileByPath(p); if (f) await v.delete(f, true); }
	await window.app.plugins.plugins.motif.index.rebuild();
});
await sleep(1200);
await page.evaluate(() => window.app.commands.executeCommandById("motif:open-codex"));
await sleep(600);
ok(/Your codex is empty/.test(await page.locator(".sl-cx .sl-empty").innerText().catch(() => "")), "codex empty state");
ok((await page.locator(".sl-cx .sl-empty button", { hasText: "New character" }).count()) === 1, "codex empty state offers New character");
await shot(page, "p8-empty-codex");
await page.locator(".sl-cx .sl-nav-tab", { hasText: "Chapters" }).click();
await sleep(600);
ok(/No chapters yet/.test(await page.locator(".sl-ch .sl-empty").innerText().catch(() => "")), "chapters empty state");
await shot(page, "p8-empty-chapters");
await page.locator(".sl-ch .sl-nav-tab", { hasText: "Timeline" }).click();
await sleep(600);
ok(/Nothing on the timeline yet/.test(await page.locator(".sl-tl .sl-empty").innerText().catch(() => "")), "timeline empty state");
await page.evaluate(() => window.app.commands.executeCommandById("motif:open-cast"));
await sleep(800);
ok(/No cast yet/.test(await page.locator(".storyloom-cast .sl-empty").innerText().catch(() => "")), "cast empty state");

await page.locator(".sl-tl .sl-nav-tab", { hasText: "Chapters" }).click();
await sleep(500);
await page.locator(".sl-ch .sl-empty button", { hasText: "Set up my book" }).click();
await page.waitForSelector(".modal.sl-setup");
await page.locator(".sl-setup-footer button.mod-cta").click();
await sleep(300);
const plan = await page.locator(".sl-setup-plan").innerText();
ok(["Manuscript/", "Codex/Characters/", "Codex/Locations/", "Codex/Lore/", "Templates/", "Book.md", "Templates/Chapter.md", "Templates/Character.md"].every((x) => plan.includes(x)), "book step lists everything it will create");
await page.locator(".sl-setup-field input").fill("The Salt Road");
await shot(page, "p8-setup-2");
await page.locator(".sl-setup-footer button.mod-cta", { hasText: "Create" }).click();
await page.waitForSelector(".sl-setup-tip", { timeout: 8000 }).catch(() => {});
ok((await exists("Manuscript")) && (await exists("Codex/Characters")) && (await exists("Templates/Lore.md")), "folders and templates created");
ok(/^# The Salt Road/m.test((await read("Book.md")) ?? ""), "Book note uses the title");
await page.locator(".modal.sl-setup .modal-close-button").click();
await sleep(300);

await page.locator(".sl-ch .sl-empty button", { hasText: "New chapter" }).click();
await page.waitForSelector(".modal input");
await page.locator(".modal input").fill("Departure");
await page.keyboard.press("Enter");
await sleep(1500);
const ch = (await read("Manuscript/01 - Departure.md")) ?? "";
ok(/type: chapter/.test(ch) && /chapter: 1/.test(ch) && /pov:/.test(ch), "New chapter uses the created template");

ok(!logs.some((l) => /pageerror|Uncaught/.test(l)), "no page errors");
await app.close();
