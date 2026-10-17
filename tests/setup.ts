// The plugin runs in Obsidian, where `window` is the global object; give Node the same.
(globalThis as { window?: unknown }).window ??= globalThis;
