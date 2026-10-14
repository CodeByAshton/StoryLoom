# Start Here

Welcome to your book vault. It runs **Storyloom**, a writing plugin that keeps track of your story while you write it: who your characters are, where they are, and how they feel about each other, chapter by chapter.

Everything is stored in plain notes. You can read and edit every bit of it by hand.

## The folders

- **Book** — your book's bible: premise, tone, style guide and a *voice sample*. The AI copies this voice.
- **Manuscript** — one note per chapter. Each one has a `chapter` number at the top; that number decides the order.
- **Codex** — your characters, locations and lore. Each note has a *Timeline* and *Relationships* section.
- **Templates** — the starting point for new notes.

## A short tour (with the sample story)

The first time you open this vault, Obsidian asks whether you trust it. Choose **Trust author and enable plugins** so Storyloom can run.

1. Open **Manuscript → 01 - The Manor**. Character and place names are underlined. Hover one to see where that character is *as of this chapter*.
2. Open chapter 3 and hover **Mara** again: she has moved, she's injured, and she knows something new.
3. Click the **people icon** in the left ribbon to open the **Cast** panel. It shows everyone in the current chapter.
4. Click the **network icon** to open the **Story graph**. Drag the chapter slider and watch relationships and meetings change.
5. Click the **table icon** to open the **Story timeline**: characters down the side, chapters across the top.

## Using the AI

1. Open **Settings → Storyloom** and paste an API key (Anthropic by default; OpenAI, OpenRouter, Ollama and LM Studio also work). Click **Test**.
2. In a chapter, **select a sentence and press Cmd/Ctrl+K**. Type what you want ("make it tenser") and press Enter. Press **Tab** to accept or **Esc** to reject. One undo brings the original back.
3. Right-click in a chapter for more tools: continue writing, rewrite, describe, expand, brainstorm.
4. When you finish a chapter, run **Update story state** (in the Cast panel or the command palette). The AI proposes timeline and relationship changes; you tick what's right and click Apply.

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
