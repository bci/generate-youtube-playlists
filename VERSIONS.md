# Versions

Version strings follow the format `YYYY.MM.DD-<commitID>`. There is no build step in this
project, so the version is documentary — it names the commit a deployment came from, and
`package.json` keeps a plain semver for tooling.

## Unreleased — macOS scheduling (FEAT-0009), the sync marker (FEAT-0010), the task runner (FEAT-0011), releasing a claim (FEAT-0012), pre-push checks (FEAT-0013) and a configurable schedule (FEAT-0014)

**The report declares its encoding.** `report.html` now carries `<meta charset="utf-8">`
(FEAT-0005). It is read as a `file://` URL and as a mail body, neither of which supplies a
`Content-Type`, so without the declaration the browser fell back to the locale default —
cp1252 on the Windows host — and every em dash, curly quote and the warning triangle rendered
as mojibake. The file's bytes were valid UTF-8 throughout; only the label was missing.

**Releasing a claim.** `--unclaim-sync` deletes this machine's sync marker; `--unclaim-all`
deletes every marker, leaving the account for whichever machine syncs first. This completes
the pair FEAT-0010 left open — claiming existed, releasing meant deleting a playlist by hand
in the YouTube UI — and it resolves the one case `checkSyncMarker()` explicitly cannot: with
two markers present it refuses to claim, because renaming onto an existing title would leave
two playlists with the same name.

Terminal-only, with its own check rather than sharing `--claim-sync`'s, because the reason is
worse: an unattended claim flaps at 50 units a write, but an unattended *unclaim* costs 100 a
night forever — the next run finds no marker and creates one, release, recreate, release — and
each half of that loop looks entirely correct in the log. `make unclaim` additionally refuses
while the nightly job is still installed here, since tonight's run would claim the account
straight back; the order that works is uninstall, then unclaim.

**Pre-push checks.** `make check` finds what lint and the tests cannot, and `make ci` now runs
lint, the tests **and** every check, reporting all failures at once instead of stopping at the
first. Two guardrails this repo states but nothing enforced now have teeth: the public-repo
rule (CLAUDE.md §12) is checked on every tracked file at error level, and `features.yaml` —
of which AGENTS.md said "nothing enforces this automatically, there is no CI for it in this
repo" — is parsed and checked against its own documented rules. That sentence is now false.

Errors fail the build; warnings print and do not. A warning that blocks a push is an error
wearing a disguise, and the honest fix is to promote it rather than to teach people
`--no-verify`. Adds `yaml` (2.9.1, no transitive dependencies) — the first new devDependency
since eslint, because the alternatives were a parser for a restricted subset that would accept
files real YAML rejects, or python3+pyyaml, which degrades to "skipped" on the Windows host
that actually pushes.

**A configurable schedule.** `make change-run-time 0430` moves the nightly sync, stores it as
`SYNC_AT` in `.env`, moves the watchdog to six hours later, and reinstalls both jobs so the
scheduler picks it up. The watchdog follows rather than staying put because the gap is its
whole purpose: on the sync's own schedule it is silent in exactly the case it exists to catch.

**Both shims now take the same arguments in the same order**, so a command learned on one
machine works unchanged on the other. That is what forced four-digit `0430` over `04:30`: a
colon is a rule separator to make, which dies with `multiple target patterns` while still
*parsing* the Makefile — before `make.js` runs, so no useful message is possible — and
quoting does not help, because the shell strips it first. An `at=04:30` form under make only
was tried and dropped; a shim-specific spelling is precisely the inconsistency being removed.
`make check` now fails if any target's documented arguments contain a colon or a raw
`--flag`, so neither trap can come back through a new target.

**The shims now list their targets.** A fully generic shim names no target, so opening the
Makefile to find out whether `uninstall` exists showed nothing — reported four times, for four
targets that already existed. Both shims now carry a generated list between markers,
`make sync-shims` writes it, and `make check` fails when it drifts, so it cannot become the
stale hand-kept menu the generic design was avoiding. `make change-email` was added alongside.


**One target per action, on both platforms.** `make <target>` on macOS and
`.\build.ps1 <target>` on Windows now cover setup, `doctor`, `dry-run`, `run`,
`add-channel`, `install`, `status`, `ci` and the rest; either shim with no target prints
the list. Both are ~40-line shims over `make.js`, which holds the only implementation.

Two implementations were the obvious shape and are what this rejects: writing every target
twice, in two shell dialects, tests only one of them per machine — and `add-channel`
would have grown a second `channels.txt` parser in `sed` and a third in PowerShell beside
the real one in `src/index.js`. It reuses that parser instead, so a line is validated by
the same code that reads it at 3 AM. Node decided the language: `package.json` already
pins 20.12+, so it is the only interpreter guaranteed on both platforms, while `make` is
absent on Windows and PowerShell on macOS.

Four silent failure modes were found and guarded, all of them the "looks like it worked"
kind. `make test` finds the `test/` **directory**, calls it up to date and runs nothing
(fixed with `.PHONY`). `make run --dry-run` is taken as make's own `-n`, so the recipe is
echoed and nothing executes — reading exactly like a dry run that worked. `make run
--max=1` is matched as an abbreviation of make's `--max-load` and becomes `-l 1`, quietly
removing the cap on writes against a live account. And in PowerShell an unquoted
`@Handle` is a splatting expression that expands to `$null`, which PowerShell then
**drops** when building a native command's argv — so `run @One` and `run` are identical by
the time Node sees them, and the second syncs every channel. The first three are caught by
`make.js`, the last by `build.ps1`, each naming the fix.

Not yet run on Windows: the scheduling half uses the `Register-ScheduledTask` form the
README already documents, but only the shim's argument handling has been verified there
(against pwsh 7.6 on macOS). 16 new tests, 164 total.

**Sync marker.** Each run leaves a private, empty playlist named `gyp-sync-<hostname>` on the
account, recording which machine owns the nightly sync. No marker → create one (50 units,
once). Its own → silence. **Another machine's → report it** in the console, `report.html` and
the email, while still syncing normally. Detection costs ~1 unit, since `playlists.list` is 1
per page and the run already pages that list for every playlist.

It reports rather than blocks because a marker can be stale through nobody's fault — a
retired machine, a hostname changed by a new network — and a guard that stopped the nightly
sync on a false positive would be worse than what it prevents. `--claim-sync` takes an
account over, and is **refused without a terminal**: that is what makes two machines claiming
it back from each other nightly unreachable rather than merely discouraged, since the flag
cannot work from launchd or Task Scheduler. The key is the hostname rather than a stored id,
because the host-move runbook copies `state/` and a stored id would give both machines the
same key. Known limit: it only sees machines running a build that writes a marker.

Verified against the live account: a planted foreign marker was detected, reported in all
three places and paged the operator while the sync ran on, and `--claim-sync` took it over —
renaming the existing playlist rather than replacing it, so 50 units rather than 100.



Second deployment platform, ops only: `src/` is unchanged, no dependency was added, and the
125-test suite passes unmodified on macOS.

**macOS unattended runs.** `run-sync.sh` and `run-watchdog.sh` are POSIX-sh mirrors of the
two `.cmd` wrappers, driven by two **LaunchDaemons** built from the templates in `launchd/`
(sync 03:00, watchdog 09:00). Daemons rather than Agents because the target is a shared
machine where nobody is logged in at 3 AM, and an Agent — which lives in a GUI login session
— would be skipped in silence on exactly those nights. That is the macOS form of the
`-LogonType S4U` lesson the Windows task already carries. The `UserName` key keeps a daemon
from meaning *root*, so `state/`, `logs/` and `.env` keep their ownership; it is honoured
only in the privileged system domain, so it is available because of the Daemon choice rather
than despite it.

**The node-path trap, handled in the wrapper.** A launchd daemon's `PATH` is
`/usr/bin:/bin:/usr/sbin:/sbin`, which contains neither Homebrew location, so a wrapper that
calls plain `node` works every time it is tested in a terminal and fails every night under
launchd. Both wrappers try `PATH`, then `/opt/homebrew/bin/node`, then `/usr/local/bin/node`,
log which they picked, and log a `FATAL` line rather than dying quietly if they find none.

**Plists are tracked as templates**, with `__REPO_DIR__` and `__RUN_AS_USER__` placeholders
filled in by `sed` at install time — a working plist would otherwise commit an absolute home
path and an account name to a public repo.

**README** gained a `## Scheduling` section with `### Windows` (unchanged) and `### macOS`.

**Verified under launchd** on 2026-09-12, on a real calendar trigger rather than a manual
kickstart: the job fired on time, resolved node through the wrapper fallback, ran as the
`UserName` account (every file it wrote is owned by that user, not root), made the one
change the preceding dry run predicted, emailed the report, and exited 0.

**Docs fix, no behaviour change.** Every `@Handle` usage example is now quoted —
`npm start -- "@SomeChannel"`. Unquoted, `@` is PowerShell's splatting sigil and the handle
was parsed as an unset variable, so the one-channel examples in `README.md` and `AGENTS.md`
had never run on the documented deployment platform. Double quotes rather than single, being
the only form also correct in `cmd.exe` and in the macOS `sh` wrappers.

## 2026.09.12 — 2026-09-12 (Initial release)

First public version. The repository starts here; nothing precedes it.

**Sync:** resolve `@handle` -> channel -> uploads playlist, list every upload oldest ->
newest, find-or-create a **private** playlist named after the handle, and insert the missing
videos at their chronological positions. Reruns are idempotent. Two phases — read everything
first, then write — so a mid-run quota stop still leaves an accurate report. Inserts run
smallest-backlog-first so a nearly-complete channel finishes before a large backfill consumes
the day's quota. Inserts retry on transient network aborts, never on quota errors or
permanent 400s.

**Channel settings**, uniform `key=value` and order-independent:
`@Handle [after=YYYY-MM-DD] [older=keep|remove] [shorts=no|yes|only|split] [shorts-title="..."]`.
A malformed setting is fatal before a single unit of quota is spent, because every one of
them has a silent-failure mode that looks like something else went wrong.

**Publish-date window (`after=` / `older=`):** the date is UTC and inclusive. `older=remove`
(default) deletes anything below the cutoff; `older=keep` gates additions only. A cutoff
deletion is *forgotten* by the ledger rather than banked as a watch — otherwise lifting the
date later would hold that whole back catalogue out permanently.

**Shorts (`shorts=`):** `no` (default), `yes`, `only`, or `split`. Shorts are excluded by
default because a channel's Shorts are usually clips of its real videos. `split` gives one
channel two playlists from a **single read** — the uploads listing and the Shorts probe are
charged per channel, not per playlist — so phase 1 is split into `readChannel()` and
`getPlaylistStatus()`. Each playlist keeps its own watched ledger.

**Watched-video pruning, on by default** (`--ignore-watched` opts out, `--report-watched`
detects without deleting). YouTube exposes no watch history: `relatedPlaylists.watchHistory`
was deprecated in 2016 and is now absent, and the documented `HL` playlist id returns zero
items *without an error*, so anything built on it silently concludes nothing was watched.
Three signals feed one ledger instead — a Like, a by-hand removal, and a manually curated
`Watched` playlist (read-only to the tool). Ledgers in `state/` are permanent by design: a
later sync re-adding a video does not erase the record, which is what stops a delete/re-add
loop costing 100 units per video per night.

**Manual-sort fallback:** `playlistItems.insert` refuses a `position` unless the playlist
uses Manual sorting, and the Data API exposes no field to set the order back. After the first
refusal the run appends without a position (one wasted call per run, not one per video) and
the report says so.

**Report + email:** an HTML report, one row per playlist, with Added / Removed / In playlist
columns and a short status note; emailed via the Microsoft 365 Graph API (client-credentials
flow) when asked. Optional — without it, read `report.html`.

**Reliability:** every completed run writes `state/last-run.json`; a second scheduled task
(`src/watchdog.js`) emails an alert when the last successful run is older than 36 hours — two
missed nights, so one late run stays silent.

**Known limit:** there is no `shorts=remove` to match `older=remove`. Turning Shorts off
leaves the ones already in a playlist, and unlike a cutoff the insert-position walk cannot
compensate — excluded Shorts are interleaved chronologically rather than bunched at the old
end, so there is no count to start past.

**Tests:** 125, `node --test`, mocked YouTube clients. Lint clean at `--max-warnings=0`.
