# Work Log

Newest first. Absolute dates only.

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
