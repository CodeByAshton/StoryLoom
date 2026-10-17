// Connects to an Obsidian started with --remote-debugging-port=9222 (see start.sh).
import { chromium } from "playwright-core";
const S = process.env.STORYLOOM_E2E_DIR ?? "/tmp/storyloom-e2e";
export async function launch() {
	const browser = await chromium.connectOverCDP("http://localhost:9222");
	const page = browser.contexts()[0].pages().find((p) => p.url().includes("index.html"));
	const logs = [];
	page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
	page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
	for (let i = 0; i < 40; i++) {
		const loaded = await page.evaluate(() => !!window.app?.plugins?.plugins?.motif).catch(() => false);
		if (loaded) break;
		const trust = page.getByText("Trust author and enable plugins");
		if (await trust.count()) await trust.first().click().catch(() => {});
		await page.waitForTimeout(500);
	}
	// The setup guide opens on first run; tests that want it call openSetup() themselves.
	if (!process.env.KEEP_SETUP) {
		await page.waitForTimeout(400);
		await page.evaluate(async () => {
			const p = window.app.plugins.plugins.motif;
			if (!p) return;
			p.settings.onboarded = true;
			await p.saveSettings();
			document.querySelectorAll(".modal.sl-setup").forEach((m) => m.closest(".modal-container")?.querySelector(".modal-close-button")?.click());
		});
	}
	return { browser, page, logs, app: { close: () => browser.close() } };
}
export const shot = (page, name) => page.screenshot({ path: `${S}/shots/${name}.png` });
