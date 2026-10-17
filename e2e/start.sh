#!/bin/bash
# Restart Obsidian on display :99 with a fresh copy of the vault.
S=${MOTIF_E2E_DIR:-/tmp/motif-e2e}
REPO=$(cd "$(dirname "$0")/.." && pwd)
OBSIDIAN=${OBSIDIAN_BIN:-$S/obs/squashfs-root/obsidian}
pkill -f -- "$OBSIDIAN --no-sandbox"; sleep 1
if [ "$1" != "keep" ]; then rm -rf $S/vault && mkdir -p $S/shots && cp -r "$REPO/My Book" $S/vault; fi
pgrep Xvfb >/dev/null || (Xvfb :99 -screen 0 1400x900x24 >/dev/null 2>&1 &)
sleep 1
(DISPLAY=:99 $OBSIDIAN --no-sandbox --disable-gpu --remote-debugging-port=9222 > $S/obs.log 2>&1 &)
for i in $(seq 1 30); do curl -s localhost:9222/json/list | grep -q index.html && break; sleep 1; done
sleep 3
