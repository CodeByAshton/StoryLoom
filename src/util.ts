import { stripFrontmatter } from "./codex/parse";

export function wordCount(text: string): number {
	return (stripFrontmatter(text).match(/[\p{L}\p{N}'’-]+/gu) ?? []).length;
}

/** Small, fast string hash (djb2), for "has this chapter's prose changed?" checks. */
export function hashText(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

/** Fingerprint of a chapter's prose; frontmatter edits (summary, status) don't count. */
export function proseHash(text: string): string {
	return hashText(stripFrontmatter(text).trim());
}
