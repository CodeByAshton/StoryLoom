import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: { alias: { obsidian: fileURLToPath(new URL("./tests/obsidian-stub.ts", import.meta.url)) } },
	test: { include: ["tests/**/*.test.ts"], setupFiles: ["tests/setup.ts"] },
});
