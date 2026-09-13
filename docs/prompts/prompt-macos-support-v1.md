# YT-MACOS-001 — macOS support: implementation brief

**Status:** SUPERSEDED by [prompt-macos-support-v2.md](prompt-macos-support-v2.md) (2026-09-12) · **Written:** 2026-09-12 · **Applies to:** ops only · **Tracks:** FEAT-0009

> Kept for the reasoning behind the work, not as a description of it. The work landed on
> 2026-09-12; read v2 for what was actually built, which differs from this brief in two
> places (LaunchDaemons rather than Agents, and the `launchctl` invocation that implies).

Unlike [prompt-youtube-playlist-sync-v1.md](prompt-youtube-playlist-sync-v1.md), which
describes the system as it *is*, this document describes work that has **not been done**.
It is a brief: hand it to whoever (or whatever) implements macOS support, and supersede it
with a `-v2` once the work lands and the behaviour belongs in the sync prompt instead.

---

## 1. Goal

Run the nightly sync and the watchdog unattended on macOS, with the same guarantees the
Windows scheduled tasks give today: a run every night, output appended to a log, and an
alert when runs stop happening.

The Mac is the **always-connected home machine**. It is not a laptop that travels, and it
is not the Apple TV. Do not design for intermittent connectivity — a plain nightly calendar
trigger is correct.

## 2. What already works — do not re-solve these

Verified on 2026-09-12:

- **`src/` is already platform-neutral.** No `process.platform` branching, no hardcoded
  separators. Every path is built with `path.join` / `path.resolve` from `__dirname`, and
  the only `os` use is `os.tmpdir()` in `src/auth.js`. **This change should not need to
  modify `src/` at all.** If you find yourself adding platform branching to `src/`, stop
  and reconsider — it almost certainly belongs in the wrapper.
- **`.githooks/pre-push` is already POSIX sh** and needs no port. It still has to be
  enabled once per clone: `git config core.hooksPath .githooks`.
- **The test suite is platform-neutral** and should pass unmodified. If it does not, that
  is a finding worth reporting, not something to paper over.

## 3. What to build

### 3a. `run-sync.sh` and `run-watchdog.sh`

Shell equivalents of `run-sync.cmd` and `run-watchdog.cmd`. Read those two files first —
they are short, and every line in them exists for a reason. The behaviour to reproduce:

1. Change to the script's own directory, so the job works regardless of the working
   directory launchd hands it.
2. Create `logs/` if it does not exist.
3. Resolve the node binary, with a fallback (see 3b — this is the part that bites).
4. Append a start banner with a timestamp to the log.
5. Run `node src/index.js --email-on-change` (sync) or `node src/watchdog.js` (watchdog),
   appending both stdout and stderr to `logs/sync.log` / `logs/watchdog.log`.
6. Append a finish line carrying the exit code.

Keep the explanatory comments from the `.cmd` files. They record why the flags are what
they are, and that reasoning is platform-independent.

Make them executable and commit the executable bit.

### 3b. The node-path problem — the most likely cause of a silent failure

`run-sync.cmd` already falls back to an explicit node path when `where node` fails, because
a scheduled task can start before the installer's PATH entry is visible to it. **macOS has
a worse version of this problem.** A launchd job does not inherit your login shell
environment: it gets a minimal `PATH`, typically only `/usr/bin:/bin:/usr/sbin:/sbin`.
Homebrew installs node to `/opt/homebrew/bin` (Apple Silicon) or `/usr/local/bin` (Intel).
Neither is on that PATH.

So a wrapper that simply calls `node` works perfectly when tested in Terminal and fails
every single night under launchd, logging `node: command not found` — if it manages to log
at all. Resolve the binary explicitly, or set `PATH` inside the plist via
`EnvironmentVariables`. Whichever you choose, **test it under launchd**, not just in a
shell. See section 6.

### 3c. Two LaunchAgents

One for the sync, one for the watchdog, in `~/Library/LaunchAgents/`. Reverse-DNS labels.

Keys that matter:

- `Label` — must match the filename.
- `ProgramArguments` — absolute path to the wrapper script.
- `StartCalendarInterval` — Hour 3, Minute 0 for the sync, matching the Windows task.
  Quota resets around midnight Pacific, so early morning has the full budget.
- `StandardOutPath` / `StandardErrorPath` — belt and braces. The wrapper already redirects
  into `logs/`, but if the wrapper itself fails to start, these are the only record.
- Give the watchdog its **own trigger at a different time** from the sync. This is
  deliberate and load-bearing: if it shared the sync's schedule it would be silent in
  exactly the case it exists to catch. A few hours after the sync is right.

Load with `launchctl bootstrap gui/$(id -u) <plist>`. `launchctl load` is the deprecated
form; prefer `bootstrap` and `bootout` — but **verify the exact invocation against
`man launchctl` on the actual macOS version**. This interface has changed more than once,
and this brief was written without a Mac to hand.

**LaunchAgent vs LaunchDaemon:** an Agent runs in the user's GUI session and therefore only
while that user is logged in; a Daemon runs at boot regardless. This is the direct analogue
of the Windows `-LogonType S4U` lesson recorded in FEAT-0008 — an interactive-only task is
skipped in silence on every night nobody is logged on. Decide deliberately which you want
and record why in the README. An Agent is usually right for a home Mac that stays logged
in; a Daemon is safer if it does not.

**Two things to verify rather than take from this document:**

- Whether a `StartCalendarInterval` job missed because the Mac was asleep runs on wake. I
  believe launchd does fire missed calendar intervals on wake, unlike the Windows case, but
  confirm in `man launchd.plist` before relying on it.
- Waking the machine is a separate concern either way. `pmset repeat wakeorpoweron` is the
  mechanism, and the analogue of the wake-from-sleep checkbox on the Windows task. A Mac
  that is fully powered off will not run the job.

### 3d. README

Extend the **Scheduling (Windows)** section so both platforms are covered. Keep the Windows
content — it is still correct, and the repo is public. A `## Scheduling` section with
`### Windows` and `### macOS` subsections is probably cleanest. Update the table of
contents, and the Requirements table, which currently claims the Windows scheduling files
are the only platform-specific part.

Update the `## Files` table with the new scripts and the plists.

## 4. The migration — higher risk than the scheduling

**Copy `state/` and `.env` to the Mac before the first run.** Both are git-ignored, so a
fresh clone will not bring them.

`state/` holds the watched ledger. If the first run on the Mac starts with an empty
`state/`, the ledger does not know anything has been watched, so **every video ever watched
and pruned becomes eligible for re-adding, at 50 quota units each.** There are several
hundred such videos across the current channel list. At roughly 200 writes a day that is
multiple days of quota spent putting back exactly what was deliberately removed — and the
ledger then records them as present, so undoing it means deleting them again at another 50
units apiece.

`.env` holds the Google refresh token, so copying it also avoids re-running
`npm run authorize`. Re-authorizing is harmless if preferred; the ledger is not recoverable
from anywhere else.

Sequence that avoids the trap:

1. Copy `.env`, `state/` and `config/channels.txt` across. `config/channels.txt` is also
   git-ignored — without it the tool has no channel list at all.
2. `npm install`
3. `npm test` and `npm run lint` — both should pass before anything touches the network.
4. `npm start -- --dry-run`, and **read the report before writing anything.** If it
   proposes adding hundreds of videos, the ledger did not come across. Stop and fix that
   rather than letting a real run proceed.
5. Only then run for real, bounded: `npm start -- --max=1 --max-removals=1`.

Note that `--max=N` is **per channel** while `--max-removals=N` is **shared across all
channels** — see the flags table in the README. With seven playlists, `--max=1` authorizes
up to seven inserts, not one.

## 5. Hard constraints

- **Do not modify `src/`.** See section 2. This is an ops change.
- **No new dependencies.** The project has two runtime dependencies; adding a third needs a
  reason, and a shell script plus two plists need none.
- **Do not "fix" line endings.** The working tree is deliberately mixed and git normalizes
  on checkout. Changing a file's endings turns a three-line diff into a whole-file one.
- **Lint and tests must pass.** `npm run lint` is `--max-warnings=0` and the pre-push hook
  enforces both. Do not silence a finding with a disable comment.
- **No addresses, ids or channel names in tracked files.** The repo is public. New scripts
  read recipients from `.env` like everything else, and never default to a real mailbox.

## 6. Acceptance criteria

1. `./run-sync.sh` run by hand appends a start banner, the run output, and a finish line
   with an exit code to `logs/sync.log`.
2. The same script run **by launchd** does the same thing. This is the test that catches
   the PATH problem, and it is not the same test as the one above. Trigger it on demand
   with `launchctl kickstart -k gui/$(id -u)/<label>` rather than waiting for 3 AM.
3. `./run-watchdog.sh` writes to `logs/watchdog.log` and sends nothing while the heartbeat
   in `state/last-run.json` is fresh.
4. Age or remove `state/last-run.json` and confirm the watchdog alerts. Use
   `npm run watchdog -- --dry-run` first so it reports without emailing.
5. `npm test` and `npm run lint` pass on macOS.
6. A dry run produces the same per-playlist figures the Windows machine reports for the
   same channel list. Divergence means the ledger or the config did not migrate.

## 7. Bookkeeping when the work lands

Required by the repo conventions in [AGENTS.md](../../AGENTS.md), in the same change:

- `features.yaml` — move FEAT-0009 to `complete`, set `release` and `updated`.
- `VERSIONS.md` — a new release entry.
- `WORKLOG.md` — a dated entry recording what was done and, more importantly, **why** —
  especially anything learned about launchd that the next person would otherwise
  rediscover. The PATH problem in 3b belongs there if it bites.
- This file — supersede it with a `-v2` describing the shipped behaviour, and fold the
  durable parts into the sync prompt.
