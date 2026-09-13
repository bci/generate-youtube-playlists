# Work Log

Newest first. Absolute dates only.

## 2026-09-12 (later still)

### Sync marker built — FEAT-0010

Implemented to the brief written earlier the same day; nothing in the design changed on
contact with the code, which is worth noting because the brief was written before reading
`findPlaylistByTitle` and could easily have been wrong about the cost.

**Where the pieces went.** `src/marker.js` holds the decisions and is pure —
`classifyMarker`, `checkClaimSync`, `machineKey` take data and return data, so the entire
rule is tested with arrays of strings and no mocked pagination. `src/youtube.js` gained
`listMyPlaylists` (the marker is matched on a *prefix*, which the existing early-returning
exact-title search cannot answer) and `renamePlaylist`. `src/index.js` calls the check once,
after the client is built and before the channels are read.

**`playlists.update` replaces the snippet rather than patching it**, so the description has
to be resent or it is silently cleared. That is safe only because this is called on a marker
whose description the tool owns, and the comment on `renamePlaylist` says so — reaching for
it to rename a channel playlist would quietly wipe a description.

**Three small decisions that are easy to get wrong:**

- **An empty hostname must not yield a bare `gyp-sync-`**, which would prefix-match every
  marker as ours and inverts the guard into the opposite of a guard. `machineKey('')` returns
  `unknown`, and there is a test that says why.
- **A foreign marker wins even when ours is also present.** Two markers means two
  installations whichever one we are, and it is exactly the state a half-finished host move
  leaves behind. `--claim-sync` refuses that case rather than renaming, since renaming would
  leave two playlists with the same title; deleting the other by hand is free.
- **The hostname's domain is dropped.** macOS reports `name.local` on one network and
  `name.lan` on another, and a key that moved with the DHCP lease would report a conflict
  against itself.

**Verified against the live account.** The TTY refusal exits 1 before any API call, tested
the way it will actually fail (`node src/index.js --claim-sync < /dev/null`) rather than by
reasoning about it. A `gyp-sync-otherbox` marker was then planted on the account — via the
same `createPlaylist` the tool uses, not by hand in the UI — and a run detected it, named
the machine in the console, the summary and the report banner, paged `ERROR_ALERT_TO` rather
than the report audience, and **still synced**. `--claim-sync` from a terminal renamed it to
`gyp-sync-thisbox`.

The detail worth keeping from that: the surviving marker has the **same playlist id** as the
planted one, which is the evidence that it renamed rather than deleted and recreated — 50
units instead of 100. And `npm start -- --claim-sync` preserves stdin's TTY, so the form the
README documents does work; that was worth testing rather than assuming, since if npm had
interfered the guard would have refused legitimate claims and looked like a bug in the rule.

**The create-on-first-run branch is tested with a mocked client, not live**, because
exercising it for real means deleting the marker and letting a run rebuild it: 100 units to
cover three lines. `test/marker-run.test.js` covers every branch that way — claim, silence,
report, rename, the refuse-when-both-exist case, three machines, and a `playlists.list`
failure, which must never be the reason the nightly dies. 23 new tests, 148 total.

### The decision to build it — FEAT-0010

Added the `features.yaml` entry and `docs/prompts/prompt-sync-marker-v1.md`. Nothing was
built and no source file was touched, so there is no `VERSIONS.md` entry: FEAT-0010 is
`planned` until the work lands.

**Why it exists.** Invariant 10 (one machine per account) was written earlier today, and it
is enforced by nothing — a run cannot see the other machine. The proposal is to leave the
claim where the other machine *can* see it: a private, empty playlist named
`gyp-sync-<key>`. A foreign key means another installation owns this account.

The cost works out in its favour, which is why it is worth doing at all: `playlists.list` is
1 unit per page and the account has one page, so detection is ~1 unit a run — and
`findPlaylistByTitle` already pages that same list once per playlist, so the run pays this
several times over already. Creation is 50 units, once, ever.

**Two options were rejected, and the reasons are the part worth keeping:**

- **Auto-replace a foreign marker.** The obvious behaviour, and it flaps: if both machines
  replace on sight, the Mac renames the marker tonight and Windows renames it back tomorrow,
  50 units a write, forever, with both sides looking locally correct. It is invariant 1's
  delete/re-add loop wearing a different hat. It also defeats the point — the second machine
  would assume ownership quietly and nobody would be told. So replacement is explicit,
  behind `--claim-sync` — **and that flag is interactive-only, fatal when stdin is not a
  TTY.** Explicitness alone is a convention, and conventions get automated away: nothing
  stops someone adding `--claim-sync` to `run-sync.sh` or a plist to "fix" a nightly warning,
  at which point both machines are auto-replacing again and the flap is back. Refusing
  without a TTY makes the loop unreachable rather than merely discouraged. Taking an account
  away from another machine is a decision a person makes once, in front of a terminal.

  Two details that are easy to get wrong and are recorded in the brief: test
  `process.stdin.isTTY`, not `stdout` — running a wrapper by hand redirects stdout into
  `logs/sync.log` while stdin stays a terminal, so keying off stdout would refuse a
  legitimate claim. And make it fatal before any API call rather than a warning that
  continues: a foreign marker is a condition on the account and may be nobody's mistake, so
  it reports; `--claim-sync` in a scheduled job is an operator error that is never what
  anyone intended, so it should stop loudly the first night instead of being silently
  ignored every night for a year.
- **A generated uuid in `state/` as the key.** The natural choice, and it is defeated by our
  own runbook: the host-move procedure says to copy `state/` across, so both machines would
  carry the same key and detect nothing — in precisely the scenario the guard is for. The
  hostname is used instead. It also stays correctly quiet for two checkouts on one machine,
  and it names the offending box in the report, which is what you want to know at 7am. Its
  weakness is that macOS renames itself on some network changes; that is only tolerable
  because a conflict reports rather than blocks, so those two decisions stand or fall
  together.

**Reporting, not blocking**, for the same reason the watchdog exists: a false positive that
silently stops the nightly sync would be this project's favourite failure mode, self-inflicted.

Known limit, to be stated in the README when it ships: it only helps once *every* machine
runs a build that writes the marker. Until the Windows box is updated, the marker can tell
you "another machine was here" but never "no other machine is here".

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
both scheduled overnight would have been the very failure FEAT-0010 was written to detect.
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

**`docs/turnover/` is git-ignored**, and carried between machines by hand the way `.env` and
`state/` already are. A turnover note names which host is live, which is idle and what each
is scheduled to do — that is operational detail about a deployment, and this repo is public.
It gets a row in the AGENTS.md state table rather than a tracked template, since like
`state/` there is no schema to template; the note is prose written for one occasion.

**A `.gitattributes` pins the new scripts to LF**, added the same day and before the Windows
checkout pulled them. The repo had no line-ending rules at all, and the working tree is
deliberately mixed, so the file stays narrow — `*.sh` and `*.plist` only, never `* text=auto`,
which would renormalize exactly the files AGENTS.md says not to touch. Verified with
`git check-attr` that nothing already tracked changes. Without it, a CRLF checkout on Windows
committed back would give the Mac `/bin/sh^M: bad interpreter` at 3 AM, unattended — and that
error reads as "the wrapper is broken" rather than "the line endings changed", which is the
kind of misdirection that costs an evening.

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
