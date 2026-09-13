# Work Log

Newest first. Absolute dates only.

## 2026-09-12 (later still)

### macOS scheduling — FEAT-0009

Built what `docs/prompts/prompt-macos-support-v1.md` briefed: `run-sync.sh`,
`run-watchdog.sh`, two LaunchDaemon templates in `launchd/`, and a README `## Scheduling`
section split into `### Windows` and `### macOS`. `src/` was not touched and no dependency
was added, exactly as the brief predicted. v1 is marked superseded and
`prompt-macos-support-v2.md` now describes what actually shipped.

**Daemons, not Agents — and this reversed the brief.** v1 leaned LaunchAgent on the
assumption of a home Mac that stays logged in. The real deployment is a shared family
machine: a parent configures the tool while logged in, children use their own accounts, and
at 3 AM nobody is logged in at all. An Agent lives inside a GUI login session, so it would
be skipped on precisely the nights the sync needs to run — no log, no error, no report, and
indistinguishable from the sync breaking. That is the same failure the Windows task had
before `-LogonType S4U`, which is the strongest argument available that it is worth avoiding
twice.

**`UserName` is the reason a Daemon is not a regression.** A daemon runs as root by default,
which would salt `state/` and `logs/` with root-owned files the user can no longer rewrite,
and read `.env` with privilege this tool has no use for. `man launchd.plist` was checked
rather than assumed on two points: `UserName` executes the job as a named account while the
job itself still starts in the system domain, and it is honoured **only** in that domain —
so the key exists because of the Daemon choice, not in spite of it. The same man page settled
the brief's open question about sleep: a missed `StartCalendarInterval` fires at the next
wake, and several missed ones coalesce into a single run.

**Node resolution went in the wrapper rather than `EnvironmentVariables` in the plist.** The
brief allowed either. One mechanism beats two: with resolution in the script, a by-hand test
exercises the same code launchd will, so the two tests differ only in who started the job.
Each wrapper logs the binary it chose, and logs `FATAL` with the `PATH` it saw if it finds
none — "no node" and "nothing to sync" otherwise produce the same silence in a log file.

The trap is real and was confirmed here, not taken on faith: under
`env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin` (a daemon's environment, no `HOME`, invoked from
`/`), `command -v node` finds nothing and the fallback resolves `/opt/homebrew/bin/node`.

**Plists are templates, because the repo is public.** A loadable plist needs an absolute path
into someone's home directory and an account name; `__REPO_DIR__` / `__RUN_AS_USER__` plus a
`sed` line in the README keeps both out of a tracked file, in the same spirit as
`.env.example`. The label prefix is `local.`, not a company or personal domain, for the same
reason.

**The sync wrapper was never run for real as a test.** It hardcodes `--email-on-change`, so
running it against the migrated credentials would have been a full live sync — the thing
CLAUDE.md §11 says not to do to exercise a change. It was tested through a `sed`-generated
twin differing only in `--dry-run`, then deleted.

**The migration, which was the actual risk, is clear.** After `.env`, `state/` and
`config/channels.txt` came across from the Windows machine, the dry run proposed **1** insert
across 7 playlists, with 70 / 45 / 16 / 12 videos held out as watched. An empty ledger would
have proposed hundreds at 50 units apiece. This is worth recording as the cheap check it is:
one dry run distinguishes "the ledger migrated" from "several days of quota is about to be
spent re-adding deliberately deleted videos", and nothing else does.

**Built and verified here, but NOT deployed here.** Windows remains the live host. The two
daemons were installed on the Mac long enough to verify them under launchd and then booted
out, so as of 2026-09-12 nothing is scheduled on the Mac at all. That is deliberate and not
a half-finished migration: invariant 10 allows exactly one machine per account, and leaving
both scheduled overnight would have been exactly what invariant 10 forbids.
So `state/last-run.json` on the Mac will go stale, and that is expected rather than a
symptom — do not go looking for a broken sync. The macOS support is finished and ready; it
is waiting on a decision to move hosts, which is a separate act from building it.

**Why not an Agent, and why not cron — asked during review, so it is written down.** Three
things get conflated under "launchd needs root". Running as the user is not the root part:
`UserName` is the S4U analogue and the job never runs as root. `sudo` is install-time only,
because `/Library/LaunchDaemons` is `root:wheel` and launchd refuses a plist there that is
not. What actually requires the system domain is running with nobody logged in — a
LaunchAgent loads into `gui/<uid>`, which exists only from GUI login. Worth noting honestly
that `man launchctl` says a `user/<uid>` domain "may exist independently of a logged-in
user", so a user-domain agent is not flatly impossible; what could not be tested here is a
reboot with nobody ever logging in, and the cost of being wrong is silently missed nights.

cron is the better challenge to the design, because it genuinely does what Windows S4U does
without admin: `/usr/bin/crontab` is setuid, and jobs run as the user whether or not anyone
is logged in. It was rejected for one reason, and not the deprecation — **cron skips a job
whose time passed while the Mac was asleep, silently**, where launchd runs it at the next
wake and coalesces several misses into one. For a 3 AM job on a machine that sleeps, that is
the difference between a late run and a missed night with no record, which is the exact
distinction this project keeps paying to learn. The trade accepted: one sudo at install, in
exchange for sleep behaviour.

**Verified under launchd the same day, and the brief was right that it is a separate test.**
Installing to `/Library/LaunchDaemons` needs `sudo`, which this session could not provide —
macOS `tty_tickets` means a `sudo -v` in the user's own terminal does not carry into a
session without a TTY, so there is no way to hand sudo across. The install was pasted by
hand instead, including a temporary third daemon on a calendar trigger a few minutes out, so
that what got tested was launchd *starting the job on a schedule* rather than a
`launchctl kickstart`, which skips the trigger entirely.

It fired at 16:08:05 on a 16:08 trigger, resolved `/opt/homebrew/bin/node` through the
wrapper's fallback, added the one video the dry run had predicted, emailed the report, and
exited 0 with both launchd std logs empty.

The result worth recording is the **file ownership**: `report.html`, `logs/sync.log` and
`state/*.json` all came out owned by the user, not root. That is the whole `UserName`
argument demonstrated rather than asserted — without the key, a daemon would have salted
`state/` with root-owned ledgers that the next run, running as the user, could not rewrite.
Which failure would look like: the ledger silently stops recording watches, and pruned
videos start coming back.

**A rule that was true by accident is now written down as invariant 10.** Until today there
was one deployment platform, so "exactly one machine syncs an account" never needed saying.
With two platforms it does: the ledger is per-machine, so if the Windows tasks stay enabled
after the Mac takes over, the two ledgers agree only until the next video is watched — then
the stale side re-adds what the other pruned, and the pair trade the video back and forth at
50 units a write, nightly. That is invariant 1 broken by deployment rather than by code, and
no run can detect it, because nothing inside a run can see the other machine.

Recorded in the sync prompt's invariant list, the AGENTS.md guardrails, and the README's
`## Scheduling` intro — the platform-neutral intro deliberately, not the macOS subsection,
because two Windows machines would break it just as thoroughly. Worth the three places
because the symptom (a couple of videos reappearing) looks trivial next to its cost, so
nobody would go looking for a rule about it.

One unrelated thing noticed and deliberately not fixed: `npm install` rewrites
`package-lock.json` (its `license` and `engines` are stale relative to `package.json`). That
change was reverted to keep this diff to the task; it will reappear for whoever runs
`npm install` next.

## 2026-09-12 (later)

### Feature manifest, and a brief for macOS support

Added `features.yaml` and `docs/prompts/prompt-macos-support-v1.md`. No behaviour changed —
no source file was touched, no test added or removed. Nothing shipped, so there is no new
`VERSIONS.md` entry: `FEAT-0009` is `Unreleased` until the macOS work lands.

**Why a manifest at all.** `VERSIONS.md` answers "what shipped when" and this file answers
"why is it shaped that way", but neither answers "what exists, and what is still planned"
without reading them end to end. The schema is lifted from the `features.yaml` in two other
repos rather than invented here, so the three read the same way.

It carries nine entries, not one. Eight backfill what already exists; a manifest listing
only an unbuilt feature would misrepresent the project to the first person who opened it.
All eight are dated 2026-09-12 because that is when the public repo begins — the squash left
no earlier dates to claim, and the file's header says so rather than implying these features
were written that day.

**The macOS brief is a different genre of prompt** from the sync one, and the distinction is
now recorded in AGENTS.md: the sync prompt describes the system as it *is*, this one
describes work that does not exist yet and names the `FEAT-NNNN` it tracks. Getting those
confused would put wishes into a document that is meant to be trustworthy about reality.

Two findings went into the brief that were verified here rather than assumed:

- **`src/` is already platform-neutral** — no `process.platform` branching, every path built
  with `path.join`/`path.resolve` from `__dirname`, and `os.tmpdir()` the only `os` use. So
  macOS support is an ops-only change and `src/` should not need to move at all.
- **`.githooks/pre-push` is already POSIX sh**, so it needs no port.

The brief also carries the launchd `PATH` trap — a launchd job gets a minimal `PATH` that
excludes both Homebrew locations, so a wrapper calling plain `node` works in Terminal and
fails every night under launchd. That is why its acceptance criteria list "run by hand" and
"run by launchd" as two separate tests: passing the first proves nothing about the second.
Two claims in it are explicitly marked verify-don't-trust, since it was written without a
Mac available — the exact `launchctl bootstrap` invocation, and whether a missed
`StartCalendarInterval` fires on wake.

**Conventions updated to match.** AGENTS.md now covers all three tracking files and the
`features.yaml` rules (stable `FEAT-NNNN` ids, never renumbered; valid YAML, with nothing
enforcing it automatically; a feature is not done while its entry says `planned`). CLAUDE.md
gained §13 stating that the bookkeeping is part of the change rather than a follow-up —
which matters more here than in most repos, because the history was squashed and these files
are now the project's only memory.

## 2026-09-12

### Initial release

The repository starts here. Everything below describes the system as it stands at the first
commit, not the path that got there.

**What it is.** A single-purpose Node.js CLI that maintains one private, chronological
YouTube playlist per channel on the account's own profile, deletes the videos that have been
watched, writes an HTML report and optionally emails it. No server, no database, no build
step. It runs unattended from a Windows scheduled task, with a second task watching the
first.

**Why the run is phased.** Quota is a hard daily budget — 10,000 units, and every write
(`playlistItems.insert`, `playlistItems.delete`, `videos.rate`) costs 50, so roughly 200
writes a day across every channel. The run therefore reads the full state of every channel
before it writes anything, so a mid-run quota stop still produces a report that is true.
Removals go before inserts, so the day's budget clears the deletion pile before backfilling.
Inserts go smallest-backlog-first, so a nearly-complete channel finishes rather than having
its quota eaten by a large backfill; the order of `config/channels.txt` is irrelevant.

**Why the watched ledger is permanent.** YouTube exposes no watch history —
`relatedPlaylists.watchHistory` was deprecated in 2016 and the field is now absent, and the
documented `HL` playlist id returns zero items *without an error*, so anything built on it
concludes in silence that nothing was ever watched. Three signals feed one ledger instead: a
Like (the one gesture a TV remote can send), a removal by hand, and a manually curated
`Watched` playlist the tool only ever reads. The ledger never forgets, because a delete
without a memory becomes a delete/re-add loop at 100 units per video per night.

**Why a cutoff deletion is forgotten rather than banked.** `after=` removals are dropped
from `known` instead of being recorded in `seen`. Treated as watches they would mark an
entire back catalogue viewed, and moving the date later would hold all of it out for good.

**Why one channel is read once.** The expensive reads — the uploads listing and the Shorts
probe — are charged per channel, not per playlist. `shorts=split` asks for two playlists from
one channel, so phase 1 is split at that seam: `readChannel()` resolves, lists, applies the
cutoff and partitions Shorts once, and `getPlaylistStatus()` diffs each playlist against that
single read. The cutoff is applied *before* the Shorts probe, because the probe is what an
out-of-scope video would otherwise cost.

**Why a malformed channel line is fatal.** The file is read before a single unit of quota is
spent, and every setting in it has a silent-failure mode that looks like something else went
wrong — a typo'd `shorts=` value producing an empty playlist is indistinguishable from a
handle that failed to resolve.

**Why the manual-sort fallback exists.** `playlistItems.insert` refuses a `position` unless
the playlist uses Manual sorting, and the Data API exposes no field to set the order back.
Changing the sort in the YouTube UI therefore failed every insert. The run now falls back to
a position-less append after the *first* refusal — one wasted call per run, not one per video
— and both the report and the console say so, since the fix is a manual change in the UI.

**Why the scheduled task needs `-LogonType S4U`.** A task registered to run only when the
user is logged on is skipped in silence on every night nobody is signed in. It writes no log,
so the failure is invisible to anything that reads logs — which is also why every completed
run writes a heartbeat and a second task alerts when that heartbeat goes stale.

**Public-repo rules.** No addresses, account names, tenant/project/playlist ids or channel
lists in tracked files. Recipients live in `.env`, the channel list in `config/channels.txt`,
both git-ignored with tracked `.example` templates beside them. `logs/`, `state/` and
`report.html` stay ignored: they carry video ids, channel names and viewing habits.

**State at this commit:** 125 tests passing, lint clean at `--max-warnings=0`, MIT licensed.
