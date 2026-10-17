// Copy the built plugin into the sample vault: My Book/.obsidian/plugins/motif/
import { copyFileSync, mkdirSync } from "fs";
import { join } from "path";

const target = join("My Book", ".obsidian", "plugins", "motif");
mkdirSync(target, { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) {
	copyFileSync(f, join(target, f));
	console.log(`copied ${f} -> ${target}`);
}
