#!/bin/sh
# Nightly YouTube playlist sync (called by the local.youtube-playlists.sync LaunchDaemon).
# Emails REPORT_TO (via Microsoft Graph) only on runs that changed something.
#
# Watched videos (liked, or saved to the "Watched" playlist) are DELETED from the channel
# playlists by default. The seen-ledger in state/ keeps them from being re-added later.
# For detect-and-report-only, add --report-watched. To skip the watched signals entirely,
# add --ignore-watched. Neither one ever re-adds a video already pruned.
#
# POSIX sh on purpose: /bin/sh, no bashisms. The macOS /bin/bash is 3.2 (2007) and a
# daemon cannot count on a newer one being installed.

set -u

# Work from the script's own directory, so the job behaves the same however launchd or a
# shell invoked it. Every path in the Node code is relative to the repo root.
cd "$(dirname "$0")" || exit 1

[ -d logs ] || mkdir -p logs
LOG="logs/sync.log"

# Resolve node explicitly. A LaunchDaemon inherits none of your login environment: its PATH
# is /usr/bin:/bin:/usr/sbin:/sbin, and Homebrew installs node to /opt/homebrew/bin (Apple
# Silicon) or /usr/local/bin (Intel). Neither is on that PATH, so a wrapper that just calls
# `node` works every time you test it in a terminal and fails every night under launchd.
NODE_BIN=""
for candidate in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -n "$candidate" ] && [ -x "$candidate" ]; then
    NODE_BIN="$candidate"
    break
  fi
done

{
  echo "================================================================"
  echo "Run started $(date '+%Y-%m-%d %H:%M:%S %Z')"
} >> "$LOG"

if [ -z "$NODE_BIN" ]; then
  # Say so in the log rather than dying quietly — this is the failure mode the loop above
  # exists to prevent, and it looks identical to "the sync found nothing to do".
  echo "FATAL: no node binary found (PATH=$PATH)" >> "$LOG"
  echo "Run finished $(date '+%Y-%m-%d %H:%M:%S %Z') (exit 127)" >> "$LOG"
  exit 127
fi
echo "Using node: $NODE_BIN ($("$NODE_BIN" -v 2>&1))" >> "$LOG"

"$NODE_BIN" src/index.js --email-on-change >> "$LOG" 2>&1
status=$?

echo "Run finished $(date '+%Y-%m-%d %H:%M:%S %Z') (exit $status)" >> "$LOG"
exit "$status"
