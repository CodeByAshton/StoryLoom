# Storyloom

An AI novel-writing plugin for Obsidian. It combines Sudowrite-style writing tools with Novelcrafter-style story tracking: characters, locations, lore, relationships, and **where every character is at any point in the story**. It uses your own API key, with no subscription and no separate app.

Everything lives in plain Markdown notes that you can edit by hand. The plugin keeps no hidden database.

## Quick start

1. `npm install && npm run vault`. This builds the plugin and copies it into the sample vault.
2. Open the `My Book/` folder as a vault in Obsidian (1.5+). When Obsidian asks, choose **Trust author and enable plugins**.
3. Read `Start Here.md` in the vault. It walks through the sample story, the hover cards, the Cast panel, the graph and the timeline.
4. In **Settings → Storyloom**, choose **Claude Code (your Claude subscription)** if you have Claude Code installed, or paste an API key. Then click **Test**.

To use Storyloom in an existing vault, copy `main.js`, `manifest.json` and `styles.css` into `<vault>/.obsidian/plugins/storyloom/`. Then enable the plugin and set the Manuscript, Codex and Book paths in its settings.

## What it does

| Area | Features |
|---|---|
| **Inline edit** | Select text and press Cmd/Ctrl+K (or click the **Ask AI** pill), then type an instruction or pick a chip. A floating glass panel streams the answer in, then shows a word-by-word diff. Your text never moves and the note isn't touched until you press **Tab**. **Esc** discards; there's also Retry and a "refine" field. Accepting is a single undo step. With no selection it writes at the cursor. |
| **Writing tools** | Continue writing, Rewrite (2–3 versions), Describe (five senses), Expand, Brainstorm, Summarize chapter (writes to `summary`), Critique, Continuity check (click an issue to jump to the line). Available from the command palette and the editor's right-click menu. |
| **Codex** | Character, location and lore notes with `## Relationships` (chapter ranges) and `## Timeline` (`- ch N \| key: value`). |
| **State as of chapter N** | Entity names are underlined in chapters. Hovering one shows that entity's state as of the current chapter. Cmd/Ctrl+click opens the note. |
| **Story-state updater** | Reads a chapter and proposes timeline lines, relationship changes and new entities. You review and edit each item before anything is written. Running it twice adds nothing. |
| **Views** | Codex (its own button: searchable cards and a detail panel; the Codex folder can be hidden from the file explorer), Cast panel (right sidebar), Story graph (with a chapter scrubber), Story timeline (swimlanes: location bars spanning chapters, status/knowledge markers, a Locations mode showing who is where), Story assistant chat (`@` mentions). |
| **Housekeeping** | New chapter (auto-numbered), New character/location/lore, next/previous chapter, word count by chapter, Export manuscript, Clear sample content. |

## Providers

- **Claude Code (your Claude subscription).** Desktop only. Storyloom runs the Claude Code app installed on your computer (`claude -p`), so requests use whatever Claude Code is signed in with, such as a Pro or Max plan. Storyloom never reads, stores or forwards your Claude login; you sign in once by running `claude` in a terminal. Each run is tool-less, uses safe mode (your CLAUDE.md, plugins and hooks aren't loaded), isn't saved to your Claude Code history, and starts outside your vault. Usage counts toward your plan's limits. Anthropic's terms allow your own subscription for your own use of Claude Code; for anything shared with other people, use an API key.

- **Anthropic** (default model `claude-sonnet-5-5`). Effort and refusal-fallback options are in settings. Claude 4.7+ models reject custom `temperature`, so it's only sent to older models.
- **OpenAI-compatible**: OpenAI, OpenRouter, Ollama (`http://localhost:11434/v1`, no key), LM Studio, or any custom base URL.

Answers stream in as they're written. Streaming uses `fetch`. If a provider blocks that from inside Obsidian (for example a local server without CORS enabled), Storyloom quietly falls back to Obsidian's `requestUrl` for the rest of the session. With Anthropic, the stable part of the context (book, codex, earlier summaries) is sent as a cached prompt block. Repeated requests while you work on one chapter then pay full price only for the chapter text. Your key is stored unencrypted in `.obsidian/plugins/storyloom/data.json`. The vault's `.gitignore` excludes that file.

## Data formats

```markdown
## Relationships
- [[Arthur Vane]]: reluctant ally (ch 1-6)
- [[Arthur Vane|Vane]]: rival (ch 7+)
- [[Elias Crane]]: former partner

## Timeline
- ch 1 | location: [[Blackwood Manor]] | status: Safe | with: [[Arthur Vane]] | note: arrives
- ch 4 | status: Injured
- ch 7 | location: [[Old Harbor]] | with: — | knows: Arthur lied about the ledger
```

- `(ch 3)` and `(ch 3+)` mean from chapter 3 on, `(ch 1-6)` is inclusive, and no range means always.
- Later timeline entries override earlier ones. `—`, `-` or `none` clears a key, and `knows` accumulates instead of overriding.
- Names and aliases are matched case-sensitively, on whole words.

## Development

```
npm run build    # type-check + bundle main.js
npm test         # vitest: parsers, state resolver, writers, JSON, LLM clients + streaming, context builder, diff, graph model, sample vault
npm run vault    # build and install into My Book/
npm run dev      # watch mode
```

```
src/
  main.ts              plugin entry, commands, AI tool flows
  settings.ts          settings + tab
  ai.ts                context gathering, preview, JSON retry
  llm/                 provider-agnostic client, Anthropic, OpenAI-compatible, JSON extraction
  codex/               parse.ts / state.ts / write.ts (pure, tested), index.ts, apply.ts
  context/             builder.ts (budgeted context, pure), prompts.ts (every prompt)
  editor/              highlight.ts, hover.ts, inlineEdit.ts (CM6)
  views/               cast, graph (+ pure graphModel), timeline, chat, shared card
  modals/              result, instruction, review, report, timeline entry
```

Series support can come from pointing the Codex folder setting at a shared folder.

## License

Apache-2.0
