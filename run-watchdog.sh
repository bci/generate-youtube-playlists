#!/bin/sh
# Sync watchdog (called by the local.youtube-playlists.watchdog LaunchDaemon).
#
# Emails ERROR_ALERT_TO ONLY when state/last-run.json shows no successful sync in the
# last 36 hours. A quiet nightly stays quiet; this fires on the absence of runs,
# which is the failure the sync itself cannot report (a skipped job writes no log).
#
# Runs on its own trigger deliberately: if it shared the sync's schedule it would be
# silent in exactly the case it exists to catch.

set -u

cd "$(dirname "$0")" || exit 1

[ -d logs ] || mkdir -p logs
LOG="logs/watchdog.log"

# Same node resolution as run-sync.sh, and for the same reason: a LaunchDaemon's PATH does
# not include Homebrew. Kept inline rather than shared, mirroring the two .cmd wrappers —
# each script stands alone, so neither can be broken by an edit to the other.
NODE_BIN=""
for candidate in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    NODE_BIN="$candidate"
    break
  fi
done

echo "[watchdog] $(date '+%Y-%m-%d %H:%M:%S %Z')" >> "$LOG"

if [ -z "$NODE_BIN" ]; then
  echo "[watchdog] FATAL: no node binary found (PATH=$PATH)" >> "$LOG"
  echo "[watchdog] finished (exit 127)" >> "$LOG"
  exit 127
fi

"$NODE_BIN" src/watchdog.js >> "$LOG" 2>&1
status=$?

echo "[watchdog] finished (exit $status)" >> "$LOG"
exit "$status"
