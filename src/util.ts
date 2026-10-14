import { stripFrontmatter } from "./codex/parse";

export function wordCount(text: string): number {
	return (stripFrontmatter(text).match(/[\p{L}\p{N}'’-]+/gu) ?? []).length;
}
