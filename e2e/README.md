# End-to-end checks (optional)

These scripts drive a real Obsidian over the Chrome DevTools protocol. They check the in-app acceptance tests: hover state, graph scrubbing, timeline, live refresh, inline edit and undo, Continue writing, error messages, the story-state updater, and Clear sample content.
AI calls go to `fakeserver.mjs`, a fake OpenAI-compatible server on `localhost:11434` (the Ollama port) that records each request.

```bash
export STORYLOOM_E2E_DIR=/tmp/storyloom-e2e            # scratch: vault copy, screenshots
export OBSIDIAN_BIN=/path/to/obsidian                    # e.g. an extracted Obsidian AppImage
npm run vault                                            # build into My Book/
(cd e2e && npm i --no-save playwright-core@1)
# Register $STORYLOOM_E2E_DIR/vault in ~/.config/obsidian/obsidian.json with "open": true.
node e2e/fakeserver.mjs &                      # streams, with CORS (like a configured Ollama)
PORT=11435 CORS=0 node e2e/fakeserver.mjs &    # no CORS, to test the non-streaming fallback
# part5 also needs a fake `claude` at $STORYLOOM_E2E_DIR/fake-claude/claude (see part5.mjs) and,
# optionally, a wrapper that runs the real CLI with an invalid key (REAL_CLAUDE_ISOLATED).
for p in part1 part2 part3 part4 part5 part6 part7; do e2e/start.sh && node e2e/$p.mjs; done
```

On a headless Linux box, `start.sh` starts Xvfb on display :99. Each script prints PASS or FAIL lines.
