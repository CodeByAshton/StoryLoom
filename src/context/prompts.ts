/** Every system and user prompt lives here. */

export const PROSE_RULES = `Rules:
- Write in the author's voice as shown in the voice sample, and match the point of view and tense of the current chapter.
- Never invent facts that contradict the codex states provided. Characters can only be where the codex says they are, and only know what they know.
- Output prose only: no preamble, no headings, no commentary, no quotation marks around the whole answer, and never phrases like "Here's a continuation:".`;

export function system(role: string, context: string): string {
	return `You are ${role} working inside the author's novel-writing notebook.

${context ? `Below is the book's context.\n\n${context}\n\n` : ""}${PROSE_RULES}`;
}

const CO_WRITER = "a skilled fiction co-writer";
const EDITOR = "an experienced developmental editor";

export interface Prompt {
	system: string;
	user: string;
}

export function continuePrompt(ctx: string, words: number, direction: string): Prompt {
	return {
		system: system(CO_WRITER, ctx),
		user: `Continue the chapter from exactly where the text stops. Write about ${words} words.${
			direction ? `\nDirection from the author: ${direction}` : ""
		}\nStart mid-flow if the text stops mid-sentence. Return only the new prose.`,
	};
}

export const REWRITE_PRESETS: Record<string, string> = {
	"More vivid": "Make it more vivid with concrete sensory detail and stronger verbs.",
	Tighter: "Make it tighter: cut filler, redundancy and weak modifiers while keeping every beat.",
	"More tension": "Raise the tension: sharper stakes, shorter beats, more friction.",
	"Show, don't tell": "Show, don't tell: replace stated emotions and summaries with action, dialogue and physical detail.",
	"Change POV": "Rewrite from a different character's point of view present in the scene (keep the same events).",
};

export const VERSION_SEPARATOR = "=== VERSION";

export function rewritePrompt(ctx: string, passage: string, instruction: string, count = 3): Prompt {
	return {
		system: system(CO_WRITER, ctx),
		user: `Rewrite the passage below. ${instruction}
Give ${count} distinct alternatives. Start each with a line "${VERSION_SEPARATOR} N ===" and then the rewritten passage only.

Passage:
<<<
${passage}
>>>`,
	};
}

/** Split a multi-version response. Falls back to the whole text as one version. */
export function parseVersions(text: string): string[] {
	const parts = text
		.split(/^\s*=+\s*VERSION\s*\d+\s*=*\s*$/im)
		.map((p) => p.trim())
		.filter(Boolean);
	return parts.length ? parts : [text.trim()];
}

export const SENSES = ["Sight", "Sound", "Smell", "Touch", "Taste/metaphor"];

export function describePrompt(ctx: string, subject: string): Prompt {
	return {
		system: system(CO_WRITER, ctx),
		user: `Describe the following (a person, place or object from the story) through the senses, in the book's voice.
Return exactly five lines, each starting with its label: ${SENSES.map((s) => `"${s}:"`).join(", ")}. One or two sentences per line, ready to drop into the prose.

Subject:
<<<
${subject}
>>>`,
	};
}

export function parseSenses(text: string): { label: string; text: string }[] {
	const out: { label: string; text: string }[] = [];
	for (const line of text.split("\n")) {
		const m = /^\s*[-*]?\s*\**\s*(Sight|Sound|Smell|Touch|Taste(?:\s*\/\s*metaphor)?|Metaphor)\s*\**\s*:\s*\**\s*(.+)$/i.exec(line);
		if (m) out.push({ label: m[1], text: m[2].trim() });
	}
	return out.length ? out : [{ label: "Description", text: text.trim() }];
}

export function expandPrompt(ctx: string, passage: string): Prompt {
	return {
		system: system(CO_WRITER, ctx),
		user: `Expand the passage below to roughly twice its length. Deepen the beat with interiority, sensory detail and pacing, but add no new plot events. Return only the expanded passage.

<<<
${passage}
>>>`,
	};
}

export const BRAINSTORM_TOPICS: Record<string, string> = {
	"What happens next": "what could happen next in the story, given where things stand",
	"Character names": "names for a new character who fits this book's world and tone (give a one-line note on each)",
	"Plot twists": "plot twists that are surprising but consistent with what has been established",
	Obstacles: "obstacles or complications for the protagonist in the current situation",
};

export function brainstormPrompt(ctx: string, topic: string): Prompt {
	return {
		system: `You are ${CO_WRITER} brainstorming with the author.\n\n${ctx}\n\nStay consistent with the codex. Be specific to this book, not generic.`,
		user: `Brainstorm ${topic}. Give a numbered list of 8–10 ideas, one or two sentences each. No preamble.`,
	};
}

export function summarizePrompt(ctx: string): Prompt {
	return {
		system: `You are ${EDITOR} keeping the book's chapter summaries.\n\n${ctx}`,
		user: "Summarize the current chapter in 3–5 sentences: who is where, what happens, and what changes (relationships, knowledge, injuries). Plain prose, no preamble, no headings.",
	};
}

export function critiquePrompt(ctx: string): Prompt {
	return {
		system: `You are ${EDITOR}. Be candid, specific and kind.\n\n${ctx}`,
		user: `Critique the current chapter. Use these Markdown headings: "## Pacing", "## Clarity", "## Character consistency", "## Dialogue", "## Top 3 fixes". Quote short lines from the text to support points. Keep it under 700 words.`,
	};
}

export function continuityPrompt(ctx: string): Prompt {
	return {
		system: `You are a meticulous continuity editor.\n\n${ctx}`,
		user: `Find possible continuity errors in the current chapter: contradictions with the codex states (who is where, who is with whom, injuries, what characters know, relationships) or with earlier chapter summaries.
Return only JSON:
{"issues": [{"quote": "exact short quote from the chapter", "conflict": "the codex fact or earlier event it contradicts", "fix": "suggested fix", "severity": "high|medium|low"}]}
The quote must be copied verbatim from the chapter so it can be located. Return {"issues": []} if there are none.`,
	};
}

export const STATE_SCHEMA = `{
  "timeline": [
    { "entity": "Exact Codex Name", "fields": { "location": "[[Place]]", "status": "Injured", "with": "[[A]], [[B]]", "knows": "a new fact they learned" }, "note": "one-line summary of what they did" }
  ],
  "relationships": [
    { "from": "Exact Codex Name", "to": "Exact Codex Name", "label": "rival", "fromChapter": 7, "endsPrevious": true }
  ],
  "newEntities": [
    { "name": "Full Name", "type": "character|location|lore|item|faction", "description": "one line", "aliases": ["Short"] }
  ]
}`;

export function stateUpdatePrompt(ctx: string, chapter: number): Prompt {
	return {
		system: `You maintain a novel's story bible. You read a chapter and record how the story state changed.\n\n${ctx}`,
		user: `Read chapter ${chapter} and report what changed for each entity compared with the codex states (which are as of the previous chapter).
Return only JSON matching this schema:
${STATE_SCHEMA}

Guidance:
- Only include fields that changed in this chapter. Use wikilinks like [[Old Harbor]] for places and people in the codex.
- "with" lists who the character ends the chapter with; use "—" if they end up alone.
- "knows" is only for important new knowledge.
- Use exact codex names for "entity", "from" and "to".
- relationships: only new or changed relationships; set "endsPrevious": true if it replaces the previous relationship between the pair. "fromChapter" is ${chapter}.
- newEntities: important named people, places, things or groups that are not in the codex yet.
- Empty arrays are fine.`,
	};
}

export const JSON_RETRY = "Return only valid JSON matching this schema, with no other text:";

export function extractEntitiesPrompt(ctx: string, known: string[]): Prompt {
	return {
		system: `You maintain a novel's story bible.\n\n${ctx}`,
		user: `List proper nouns in the current chapter (people, places, objects, organisations, concepts) that are NOT already in the codex.
Already known: ${known.join(", ") || "(none)"}.
Return only JSON: {"newEntities": [{"name": "...", "type": "character|location|lore|item|faction", "description": "one line based on the chapter", "aliases": []}]}`,
	};
}

export function inlineEditPrompt(ctx: string, opts: { instruction: string; selection: string; before: string; after: string; insert: boolean }): Prompt {
	const task = opts.insert
		? `Write new text to insert at the cursor (marked ⟨CURSOR⟩). Instruction: ${opts.instruction}
Return only the text to insert.`
		: `Rewrite the selected span (between ⟦ and ⟧) following this instruction: ${opts.instruction}
Return only the replacement text for the selected span — not the surrounding text. Match its POV and tense, and preserve paragraph breaks unless the instruction says otherwise.`;
	const middle = opts.insert ? "⟨CURSOR⟩" : `⟦${opts.selection}⟧`;
	return {
		system: system(CO_WRITER, ctx),
		user: `${task}

Surrounding text:
<<<
${opts.before}${middle}${opts.after}
>>>`,
	};
}

export function chatSystem(ctx: string): string {
	return `You are the author's story assistant. You know their book from the context below and answer questions about it: where characters are, plot holes, voice consistency, ideas.
Ground answers in the context and say when something isn't recorded. Refer to characters, places and chapters with [[wikilinks]] using their exact note names. Use Markdown.

${ctx}`;
}

/** Strip wrappers models sometimes add despite instructions. */
export function cleanProse(text: string): string {
	let t = text.replace(/\r\n/g, "\n").trim();
	const fence = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(t);
	if (fence) t = fence[1].trim();
	t = t.replace(/^(?:sure[,!.]?\s*)?here(?:'s| is| are)[^\n]{0,80}:\s*\n+/i, "");
	t = t.replace(/^<<<\s*\n?/, "").replace(/\n?\s*>>>$/, "");
	if (/^"[^"]*"$/.test(t) && !t.slice(1, -1).includes('"')) t = t.slice(1, -1);
	return t;
}
