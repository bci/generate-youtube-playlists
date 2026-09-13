# YT-MACOS-002 — macOS support: what shipped

**Status:** shipped and verified under launchd · **Written:** 2026-09-12 ·
**Applies to:** ops only · **Tracks:** FEAT-0009 ·
**Supersedes:** [prompt-macos-support-v1.md](prompt-macos-support-v1.md)

The v1 document was a brief: it described work that had not been done, and was written
without a Mac to hand. This one describes what was actually built and what testing it
survived. The durable parts — that scheduling is the only platform-specific surface, and
that both platforms share the "runs only when someone is logged in" trap — have been folded
into [prompt-youtube-playlist-sync-v1.md](prompt-youtube-playlist-sync-v1.md) §11, which is
where a reader looking for current behaviour will go.

`src/` was not modified, as v1 §2 predicted. No dependency was added. The test suite passed
unmodified on macOS: 125 tests, lint clean at `--max-warnings=0`.

---

## 1. What exists now

| File | Role |
| ---- | ---- |
| `run-sync.sh` | POSIX-sh mirror of `run-sync.cmd` — runs `src/index.js --email-on-change` |
| `run-watchdog.sh` | POSIX-sh mirror of `run-watchdog.cmd` — runs `src/watchdog.js` |
| `launchd/local.youtube-playlists.sync.plist` | LaunchDaemon template, 03:00 daily |
| `launchd/local.youtube-playlists.watchdog.plist` | LaunchDaemon template, 09:00 daily |

README gained a `## Scheduling` section with `### Windows` and `### macOS` subsections; the
Windows content is unchanged.

## 2. The decisions, and why

**LaunchDaemon, not LaunchAgent.** v1 §3c left this open and leaned Agent. The answer is
Daemon, because the deployment is a shared family Mac: the parent configures the tool while
logged in, and nobody at all is logged in at 3 AM. An Agent lives in a GUI login session, so
it would be skipped in silence on exactly those nights — the same failure the Windows task
had before `-LogonType S4U`, and it looks identical to the sync breaking.

**cron was the serious alternative, and it loses on sleep.** It deserves recording because
it does exactly what the Windows task does without admin: `/usr/bin/crontab` is setuid, so a
user installs their own crontab, and jobs run as that user whether or not anyone is logged
in. The disqualifier is not that Apple deprecated it — it is that **cron silently skips a job
whose time passed while the machine was asleep**, where launchd runs it at the next wake and
coalesces several missed intervals into one. On a 3 AM job that is the difference between a
late run and a missed night that leaves no trace, which is the failure class this whole
project is shaped around. The cost of choosing launchd is one `sudo` at install time.

**`UserName`, so a Daemon does not mean root.** A daemon runs as root by default, which
would leave root-owned files in `state/` and `logs/` that the user could no longer rewrite,
and would read `.env` with more privilege than this needs. `UserName` starts the job in the
system domain but executes it as the named account. `man launchd.plist` was checked rather
than assumed: the key is honoured **only** in the privileged system domain — it does nothing
in an Agent — so this option exists *because* of the Daemon choice, not in spite of it.

**Node is resolved in the wrapper, not via `EnvironmentVariables` in the plist.** v1 §3b
allowed either. One mechanism is better than two: the wrappers try `PATH`, then
`/opt/homebrew/bin/node`, then `/usr/local/bin/node`, and the same code runs whether launchd
or a human started them — so testing by hand exercises the real resolution path. Each
wrapper logs the binary it picked, and logs a `FATAL` line with the `PATH` it saw if it finds
none, because "no node" and "nothing to sync" otherwise look the same in a log.

**Plists are templates with `__REPO_DIR__` / `__RUN_AS_USER__` placeholders.** A working
plist needs an absolute path into someone's home directory and an account name; this repo is
public (CLAUDE.md §12), so neither can be committed. `sed` at install time keeps the tracked
file honest.

**Label prefix `local.`, not a company or personal domain** — a public file should not carry
either, and `local.` is the conventional neutral choice.

**Watchdog at 09:00, six hours after the sync.** Its own trigger is load-bearing: a watchdog
sharing the sync's schedule is silent in precisely the case it exists to catch. The gap also
lets a slow or retrying sync finish before its heartbeat is judged.

**`RunAtLoad` is false on both.** A sync writes to a real account at 50 units per change; it
should happen on its schedule, not on every boot or every time someone reloads the job.

## 3. What was verified, and how

Against the live account on 2026-09-12, after `.env`, `state/` and `config/channels.txt`
were copied from the Windows machine:

1. **`run-watchdog.sh` by hand** — wrote to `logs/watchdog.log`, reported a 4.4h-old
   heartbeat, sent nothing.
2. **The sync wrapper by hand**, via a `sed`-generated twin differing only in `--dry-run`
   instead of `--email-on-change`, since running the real one is a full live sync and
   CLAUDE.md §11 forbids testing that way. Banner, run output and an exit line all landed in
   `logs/sync.log`.
3. **The ledger migrated intact** — the dry run proposed **1** insert across 7 playlists,
   with 70 / 45 / 16 / 12 videos held out as watched. A ledger that had not come across
   would have proposed hundreds, at 50 units each. This is the failure v1 §4 called the
   highest-risk step, and the dry run is what catches it.
4. **The `PATH` trap, directly.** `env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin` (a daemon's
   environment, no `HOME`, invoked from `/`) confirms `command -v node` finds nothing, and
   the wrapper then resolves `/opt/homebrew/bin/node` and completes normally.
5. **Watchdog staleness** — heartbeat aged to 76.5h, `--dry-run` reported it would alert,
   then the real file was restored byte-for-byte and the quiet result reconfirmed.
6. **`npm test` (125 pass) and `npm run lint` (clean)** on macOS 26.6.2, Node 26.8.1.

## 4. Verified under launchd

Done on 2026-09-12, and worth describing because *how* it was tested matters. The install
was pasted by hand into a terminal — macOS `tty_tickets` keys a cached sudo credential to
the terminal that authenticated, so `sudo -v` in one session cannot hand sudo to another.
A temporary third daemon was installed alongside the two real ones with a calendar trigger
a few minutes out, so what got tested was **launchd starting the job on a schedule**;
`launchctl kickstart` would have skipped the trigger, which is half the mechanism.

Result: fired at 16:08:05 on a 16:08 trigger, resolved `/opt/homebrew/bin/node` through the
wrapper fallback, made the single change the preceding dry run had predicted, emailed the
report, exited 0, both launchd std logs empty.

The finding worth keeping is the **file ownership**: `report.html`, `logs/sync.log` and
`state/*.json` all came out owned by the user rather than root, which demonstrates the
`UserName` argument instead of asserting it. Without the key, a daemon writes root-owned
ledgers into `state/`, and the next run — as the user — cannot rewrite them. That failure
would present as the ledger quietly ceasing to record watches, with pruned videos returning.

Remember to remove a temporary test daemon once it has served its purpose; one with both
`Hour` and `Minute` set fires *daily*, not once.

## 4a. One rule v1 did not state, now an invariant

Adding a second platform made explicit something that was previously true by accident:
**exactly one machine syncs a given YouTube account** — Windows or macOS, never both, and
never two of either. The watched ledger lives in `state/` on the machine that wrote it, so a
second scheduler works from a copy that is correct only until the next video is watched;
after that the stale side re-adds what the live side pruned, and the two trade the video back
and forth at 50 units a write, nightly. It is invariant 1 broken by deployment rather than by
code, and it cannot be enforced in code, because nothing inside a run can see the other
machine.

It is recorded in three places rather than only in this document, because a rule that only
lives in a superseded-brief-successor is a rule nobody will find: invariant 10 of
[prompt-youtube-playlist-sync-v1.md](prompt-youtube-playlist-sync-v1.md) §2, the guardrails
list in [AGENTS.md](../../AGENTS.md), and the README's `## Scheduling` intro — deliberately
the platform-neutral intro rather than the macOS subsection, since it applies just as much to
two Windows machines.

A host move is therefore two ordered steps: copy `state/`, `.env` and `config/channels.txt`
to the new machine, **then** disable the old machine's jobs.

## 5. Corrections to v1

- v1 §3c asked whether a missed `StartCalendarInterval` fires on wake. `man launchd.plist`
  on macOS 26.6.2: it does, and several missed intervals coalesce into a single run. A
  powered-off Mac still misses it; `pmset repeat wakeorpoweron` is the answer there.
- v1 §3c suggested `bootstrap gui/$(id -u)`. That is the Agent form. The Daemon form is
  `sudo launchctl bootstrap system <plist>`, and the file must be `root:wheel` mode 644 or
  launchd rejects it with a path-ownership error that says nothing about the job.
- v1 §3a asked for the `.cmd` comments to be preserved, and they were — but two are now
  wrong on macOS and were rewritten rather than copied: the Windows node fallback path, and
  "scheduled task", which is a Windows noun.
