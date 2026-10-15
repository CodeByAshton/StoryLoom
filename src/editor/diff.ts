/** Word-level diff for showing a rewrite against the original. Pure. */

export type DiffPart = { kind: "same" | "add" | "del"; text: string };

/** Split into words and the whitespace/punctuation between them, keeping everything. */
export function tokenize(text: string): string[] {
	return text.match(/\s+|[\p{L}\p{N}'’-]+|[^\s\p{L}\p{N}]/gu) ?? [];
}

/**
 * LCS over tokens. Falls back to "all deleted, all added" for very long inputs
 * so a huge selection can't stall the editor.
 */
export function diffWords(before: string, after: string, maxCells = 4_000_000): DiffPart[] {
	const a = tokenize(before);
	const b = tokenize(after);
	if (a.length * b.length > maxCells) return merge([{ kind: "del", text: before }, { kind: "add", text: after }]);
	const n = a.length;
	const m = b.length;
	const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const out: DiffPart[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			out.push({ kind: "same", text: a[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ kind: "del", text: a[i++] });
		else out.push({ kind: "add", text: b[j++] });
	}
	while (i < n) out.push({ kind: "del", text: a[i++] });
	while (j < m) out.push({ kind: "add", text: b[j++] });
	return merge(out);
}

function merge(parts: DiffPart[]): DiffPart[] {
	const out: DiffPart[] = [];
	for (const p of parts) {
		if (!p.text) continue;
		const last = out[out.length - 1];
		if (last && last.kind === p.kind) last.text += p.text;
		else out.push({ ...p });
	}
	return out;
}

/** Share of the original that survived, 0..1. Used to decide whether a diff view is readable. */
export function similarity(parts: DiffPart[]): number {
	const same = parts.filter((p) => p.kind === "same").reduce((n, p) => n + p.text.length, 0);
	const del = parts.filter((p) => p.kind === "del").reduce((n, p) => n + p.text.length, 0);
	return same + del === 0 ? 0 : same / (same + del);
}
