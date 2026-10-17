# Start Here

Welcome to your book vault. It runs **Storyloom**, a writing plugin that keeps track of your story while you write it: who your characters are, where they are, and how they feel about each other, chapter by chapter.

Everything is stored in plain notes. You can read and edit every bit of it by hand.

## The folders

- **Book** — your book's bible: premise, tone, style guide and a *voice sample*. The AI copies this voice.
- **Manuscript** — one note per chapter. Each one has a `chapter` number at the top; that number decides the order.
- **Codex** — your characters, locations and lore. Open it from the **Storyloom button** (the feather) in the left ribbon: searchable cards, and a detail panel with each entry's relationships and timeline. (The Codex folder is hidden from the file list to keep it tidy; turn that off in Settings → Storyloom.) Each entry is still a plain note with a *Timeline* and *Relationships* section.
- **Templates** — the starting point for new notes.

## A short tour (with the sample story)

The first time you open this vault, Obsidian asks whether you trust it. Choose **Trust author and enable plugins** so Storyloom can run. Storyloom then shows a short **setup guide** to connect an AI. You can skip it and reopen it later from the Storyloom menu.

Everything Storyloom has is behind the **feather button** in the left ribbon. Chapters, Codex, Timeline and Graph also share a tab bar at the top, so you can switch between them in one tab. When you're in a chapter, the status bar at the bottom shows which chapter it is. A dot means you've edited it since it was last synced. Click it for chapter actions.

1. Open **Manuscript → 01 - The Manor**. Character and place names are underlined. Hover one to see where that character is *as of this chapter*.
2. Open chapter 3 and hover **Mara** again: she has moved, she's injured, and she knows something new.
3. Open **Cast** from the feather menu. It shows everyone in the current chapter.
4. Open the **Story graph** (the **Graph** tab). Drag the chapter slider and watch relationships and meetings change.
5. Open **Chapters**: a card per chapter with its summary, point of view, cast and word count. Drag cards to reorder chapters (the codex timelines follow automatically), or switch to **Board** and drag chapters between Draft, Revised and Final.
6. Open the **Story timeline** (the **Timeline** tab): one lane per character, with their location as a coloured bar across the chapters they stay there. Hover any square to see that character as of that chapter; switch to **Locations** to see who is where.

## Using the AI

1. Use the setup guide, or open **Settings → Storyloom**, and pick how to connect:
   - **Claude Code (your Claude subscription)**, if Claude Code is installed on this computer: sign in once by running `claude` in a terminal, then click **Check**. No API key needed; usage counts toward your plan.
   - Or paste an API key (Anthropic, OpenAI, OpenRouter), or point it at Ollama or LM Studio.
   Then click **Test**.
2. In a chapter, **select a sentence and press Cmd/Ctrl+K**. Type what you want ("make it tenser") and press Enter. Press **Tab** to accept or **Esc** to reject. One undo brings the original back.
3. Right-click in a chapter for more tools: continue writing, rewrite, describe, expand, brainstorm.
4. When you finish a chapter, click **Sync chapter**: the refresh button in the left ribbon, the same icon in the chapter's header, or the button in the Cast panel. Storyloom reads the chapter and records what changed in the codex: who moved, who learned what, who met whom. If you later rewrite the chapter, sync it again and the record follows.
5. Sync also does an **AI review** of the writing: typos, grammar, a wrong word, a run-on sentence. Each one gets a wavy underline; hover it to **Fix** or **Dismiss** it. The spell-check icon at the top of the chapter turns AI review on and off.

Inside a note, Cmd/Ctrl+K belongs to Storyloom instead of Obsidian's "Insert Markdown link". You can pick a different key in **Settings → Storyloom → Inline edit key**.

## How the codex is written

In a character note:

```
## Relationships
- [[Arthur Vane]]: reluctant ally (ch 1-2)
- [[Arthur Vane]]: rival (ch 3+)

## Timeline
- ch 1 | location: [[Blackwood Manor]] | status: Safe | with: [[Arthur Vane]]
- ch 2 | status: Injured | note: shot in the shoulder
```

- `(ch 1-2)` means chapters 1 to 2; `(ch 3+)` means from chapter 3 on; no range means always.
- Each timeline line changes only the keys it lists. Use `—` to clear a key (e.g. `with: —`).
- `knows:` adds to what a character knows; it doesn't replace it.

## Removing the sample story

When you're ready to write your own book, open the command palette (Cmd/Ctrl+P) and run **Storyloom: Clear sample content**. It removes the sample chapters and codex notes and keeps this note, `Book.md`, your templates and your settings. Then rewrite `Book.md` for your own book.

Your API key is stored, unencrypted, in `.obsidian/plugins/storyloom/data.json`. Don't share or sync that file.
