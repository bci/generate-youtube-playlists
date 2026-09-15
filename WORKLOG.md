# Work Log

Newest first. Absolute dates only.

## 2026-09-15

### The report rendered as mojibake, and the bytes were never wrong

`make report` showed `â€"` where an em dash belonged, `âš ï¸` for the warning triangle and
`â€œ` for a curly quote. The obvious reading — something wrote the file in the wrong encoding
— was wrong, and checking that first is what made the fix a one-liner instead of a rewrite of
the writer. `file -I` reports `charset=utf-8`, `iconv -f UTF-8` round-trips clean, and the em
dash on disk is `e2 80 94`. The bytes were correct the whole time.

What was missing was the *declaration*. `buildHtml()` opened with
`<!doctype html><html><body …>` — no `<head>`, no `<meta charset>`. That is invisible over
HTTP, where the server supplies `Content-Type`, and this report is never served over HTTP: it
is opened as a `file://` URL by `make report` and handed to Graph as a mail body. With no
header to fall back on the browser guesses the locale default, which on the Windows box is
cp1252, and every multi-byte sequence breaks apart on screen.

Fixed by adding a `<head>` with `<meta charset="utf-8">`. The test asserts it is present *and*
within the first 1024 bytes, because that is as far as browsers read before giving up and
guessing anyway — a charset pushed past that boundary by some later addition to the template
would be a silent regression of exactly this bug.

Not changed: the Graph send path. It passes `contentType: 'HTML'` and Graph handles the
transport encoding itself, so the meta tag is belt-and-braces there rather than the fix. The
symptom was reported against the file, and the file is what was broken.


### An agent-pipe session, and the two defects it found

Set up the mailbox at `.agent-pipe/` with `cli` (the terminal session) as the single writer,
because that is the side holding the gates: `make ci`, the pre-push hook, the quota rules.
The pipe README was tailored to name those by file rather than left generic — the skill is
right that an untailored one makes the writer rule read as ceremony.

Two real defects came out of it, and the interesting part is that neither was found by the
side that wrote the code.

**The check table documented 11 of 12 checks.** `targets` (`checkTargetArgs`) was emitting
findings with no row describing it. I found it while drafting a message asking the other
session to look for exactly that class of thing — which is its own lesson: the question was
worth asking before the answer was worth outsourcing. Fixed, and then, on Kent's call, made
unrepeatable: the `docs` check now verifies every check name `checks.js` emits has a row in
that table. Scanned from the source rather than kept in a list beside it, because a list is
one more thing to forget to update. Scanning's own failure mode — a regex that quietly
matches nothing and reports a clean bill forever — is covered by treating "no names found"
as a finding.

**`JOBS.sync.at` and `JOBS.watchdog.at` were dead, in a stale format.** Left behind by
FEAT-0014, which moved the times to `scheduleTimes()`. Nothing read them, and they still
said `'3:00am'` — neither the `HHMM` the CLI takes nor the `HH:MM` `clockString()` writes.
Dead code in a stale format is the worse kind: the next person to reach for `job.at` gets a
string nothing else in the file would accept. The `JOBS` doc-comment still claimed to carry
the hours, so that went too.

That one also exercised the protocol properly. The other session was mid-cross-check of
default schedule times when I found it, so the fix went out as a **rule-5 claim on
`make.js`** before the edit — telling them their staged copy was going stale and not to
spend a turn on it. That is the mechanism doing the job it exists for rather than being
ceremony, which is the only evidence worth having about a convention.

Worth recording about the channel itself: the other side verified out-of-tree, staging a
copy into its own sandbox and running the suite there — 207/207, matching. An independent
run on a copy is worth more than the writer re-running its own tests, and it cost the writer
nothing.

### `.agent-pipe/` is now actually git-ignored

The link check's one standing warning turned out to be pointing at something real. CLAUDE.md
describes the agent-pipe mailbox as "gitignored, so it holds working notes, not history" —
and it was not in `.gitignore` at all. The skill creates `.agent-pipe/` on demand when two
Claude sessions share this tree, and it holds conversation and proposed diffs; in a public
repo that is precisely the category that must never be pushed by accident. Now ignored, and
added to the checker's must-be-ignored list so that `git add -f` is caught rather than
trusted.

The warning itself was also wrong to emit. A git-ignored path is not part of the repo, so
its absence in a fresh checkout is expected rather than rot, and the link check now skips
ignored targets — consulted only for links that are already missing, so it costs nothing on
the common path. A checker with one permanent known-false warning teaches people to skim
past the whole report, which is the same failure as the thirteen false positives the
relative-path bug produced.

### Releasing a claim, pre-push checks, a configurable schedule — FEAT-0012/0013/0014

**Unclaim completes a pair that was half-built.** FEAT-0010 could take an account over but
not give one up; the README's answer to "how do I release it" was to delete the marker
playlist by hand in the YouTube UI. `--unclaim-sync` deletes our own marker, `--unclaim-all`
deletes every marker so the next machine to sync takes the account. The second also resolves
the case `checkSyncMarker()` names and refuses: with two markers present it will not claim,
because renaming onto an existing title would leave two playlists called the same thing.

It gets its own terminal-only check rather than sharing `--claim-sync`'s, because the reason
is worse rather than similar. An unattended claim flaps at 50 units a write. An unattended
*unclaim* costs 100 a night indefinitely — the next run finds no marker and creates one:
release, recreate, release — and **each half of that loop looks entirely correct in the log**,
which is why it needs to be unreachable rather than discouraged. `make unclaim` also refuses
while the nightly job is still installed here, since tonight's run would claim the account
straight back; uninstall first, then unclaim, and `npm start -- --unclaim-sync` overrides.

**`ci` now runs everything and reports everything.** The old one was lint-then-test and
stopped at the first failure. Two things changed. It no longer short-circuits — "fix one, run
again, find the next" is precisely how a pre-push gate becomes something people skip with
`--no-verify` — and it gained `make check`, which looks for what lint and the tests cannot
see.

The two checks that justify the whole thing are the ones enforcing rules this repo already
*states*. CLAUDE.md §12 says no addresses, ids or channel names in tracked files; that is now
checked on every tracked file at error level, because a push is not reversible and a secret
that reaches GitHub has to be rotated whether or not the commit is later removed. And
AGENTS.md said of `features.yaml`: "Nothing enforces this automatically — there is no CI for
it in this repo." That sentence was true when written and is now false, and the line has been
rewritten rather than left to mislead.

Error versus warning is a deliberate boundary, not a mood. Errors fail; warnings print and do
not. **A warning that blocks a push is an error wearing a disguise**, and the honest response
is to promote it rather than to teach people to bypass the hook. The bookkeeping check — code
changed against upstream while WORKLOG/VERSIONS/features.yaml did not — is a warning for
exactly that reason: it must not block a genuine one-line typo fix.

`yaml` is the first new devDependency since eslint, and it needs the justification AGENTS.md
asks for. A hand-written parser for a restricted subset would accept files that real YAML
rejects, which is the wrong direction for a check whose whole job is "this still parses".
Shelling out to python3+pyyaml needs no npm dependency but degrades to *skipped* on any
machine without it — including, most likely, the Windows host that actually pushes, which is
the one place the check has to work. 2.9.1, zero transitive dependencies.

**Two bugs in the checker, both found by running it rather than by reading it.** Links were
resolved from the repo root instead of from the file containing them, so all thirteen
cross-references between the `docs/prompts/` files were reported as broken — a checker whose
first output is thirteen false positives is a checker nobody runs twice. And probing for an
external tool with `shell: true` plus an args array printed a DEP0190 deprecation on every
run. Both fixed before it shipped. This is the same lesson as the PowerShell guard last
session: a guard that has not been run is not yet a guard.

**The shims now name their targets, because four separate reports said they should.** Over
this session came "I do not see target uninstall", then `remove-channel`, then
`list-channels` — every one of them a target that already existed and worked. The cause was
the design: one generic forwarding rule means no target name appears in the Makefile, so
reading the file, which is a perfectly ordinary way to use a Makefile, shows nothing. Both
shims now carry a generated list between `>>> targets >>>` markers. Generated, not
hand-kept, with `make sync-shims` to write it and a `shims` check to fail when it drifts —
otherwise it becomes exactly the stale menu the generic design existed to avoid.

**One syntax for both shims, which cost `HH:MM`.** The shims were drifting apart in the
small ways that matter: `--max=1` worked in `build.ps1` but not under make, and a time had
to be written `at=04:30` under make and `04:30` in PowerShell. A command learned on the Mac
therefore failed on the Windows box, which defeats the point of having one implementation
behind two shims.

The fix is that both now take the same arguments in the same order, and the casualty is the
colon. `make change-run-time 04:30` does not merely mis-parse — make reads the colon as a
rule separator and dies with `multiple target patterns` **while parsing the Makefile**,
before `make.js` is reached, so the code cannot report it however good the error message
would have been. Quoting was the obvious escape and does not work: the shell strips the
quotes before make ever sees the word. Verified for `"04:30"`, `'04:30'` and `04\:30`, all
three identical failures. So times are four-digit `0430`. `HH:MM` is still parsed, because
it is what people type and it is harmless where the shell allows it — it is simply not what
the documentation teaches.

The `at=04:30` workaround shipped earlier in this same session and was removed rather than
kept as an alias: a spelling that exists only under make is exactly the inconsistency the
change set out to delete. And because this trap was found twice now in two different shapes
(`--max=1`, then `04:30`), `checkTargetArgs()` fails the build if any target's documented
arguments contain a colon or a raw `--flag`. The next person to add a target does not get to
rediscover it.

**`change-run-time` moves the watchdog too, and that is the whole design.** Setting the sync
to 09:00 while the watchdog stayed at 09:00 would have silently collided them, and a watchdog
on the sync's own schedule is silent in exactly the case it exists to catch. So the watchdog
follows six hours behind, always, and the command says so. The time reaches the plist by
substitution into the rendered XML rather than by adding `__SYNC_HOUR__` placeholders to the
templates: the README documents installing those by hand with `sed` on the two placeholders
that exist, and a third would leave that documented path emitting a plist with a literal
`__SYNC_HOUR__` in it — which launchd rejects while complaining about the file rather than
the value.

`change-email` was added in the same pass, and rewrites the single `REPORT_TO` line rather
than regenerating `.env` from parsed pairs. `.env` is the only copy of the OAuth refresh
token on this machine, and a regenerating helper would quietly drop the comments that say
what each key is for.

### The secrets check had a hole, found by committing

Adopting the managed core block from `bci/claude-config` was a seven-line insertion with no
deletions — this repo's §1–10 was already byte-identical to the canonical, which is the
result that says the extraction was faithful. The interesting part was what happened next.

**`make ci` went red immediately after the commit, and it was right.** Eight `secrets`
errors, all in `test/checks.test.js` — the fake client ids, playlist ids and non-example.com
addresses that exist precisely so the scanner can be proven to reject them.

The reason it appeared only *after* committing is the actual defect: `trackedFiles()` used
`git ls-files`, which does not see a file until it is tracked. So a secret in a file added
during a session passed every check, and would have been caught by the commit *after* the one
that leaked it — which for an irreversible push is exactly one commit too late. Now scans
`git ls-files` plus `--others --exclude-standard`, so a new file is checked before it is
committed. Verified by dropping an untracked file with an address in it and watching `check`
fail.

The fixtures themselves needed an exemption, and the shape of it matters. Weakening them to
`example.com` would have deleted the test. A blanket skip for `test/**` would mean a real
secret in a test file is never caught. So a file may opt out of one named check by saying so
**with a reason** — `checks-allow: secrets — planted fixtures…` — and a bare `checks-allow:
secrets` does not match. An exemption that costs nothing is the silent way past the one check
guarding a mistake that cannot be undone.

### Task runner built — FEAT-0011

**The question was which task runner, not whether.** The obvious answer — a `Makefile` for
macOS and a `build.ps1` for Windows, each implementing the targets — is what this rejects.
It writes every target twice in two shell dialects and tests one of them per machine, and
the cost is not hypothetical here: `add-channel` edits `config/channels.txt`, which already
has a parser in `src/index.js`, so that shape would have produced a second parser in `sed`
and a third in PowerShell. The version that shipped imports the real one and validates a
new line with exactly the code that will read it at 3 AM.

Node decided the language rather than preference. `package.json` pins 20.12+, so Node is
the only interpreter both platforms are guaranteed to have; `make` is absent on Windows and
PowerShell on macOS, which is the whole reason the question exists. So `make.js` holds
every target, gets linted and tested with the rest of the project, and `Makefile` and
`build.ps1` are ~40-line shims that never change when a target is added. `help` is rendered
from the target registry, so the printed menu cannot drift from what runs.

**Four silent failure modes, found by testing rather than reasoning.** Each one produces
output that reads as success, which is why they are guarded rather than documented:

- `make test` finds the `test/` **directory**, decides it is up to date, and runs nothing —
  the same trap waits on `config/`, `docs/`, `logs/` and `state/`. Fixed with `.PHONY` over
  `MAKECMDGOALS`.
- `make run --dry-run` never passes `--dry-run` to anything. Make takes it as its own `-n`,
  prints the recipe and executes nothing. The recipe is now marked `+` so it runs even
  under `-n`, and `make.js` refuses when `MAKEFLAGS` shows what make kept.
- `make run --max=1` is worse: make matches `--max` as an abbreviation of `--max-load` and
  silently becomes `-l 1`, so the cap on writes against a live account disappears. Same
  guard. The supported spelling is `max=1`, which survives because make hands `key=value`
  words over in `MAKEOVERRIDES`; `ARGS='...'` is the escape hatch for anything else.
- In PowerShell an unquoted `@Handle` is a splatting expression that expands to `$null`,
  and PowerShell **drops nulls** when building a native command's argv. So `run @One` and
  `run` are indistinguishable by the time Node sees them — and the second syncs every
  channel in the list. The guard has to live in `build.ps1`, where `$args` still holds the
  null; a first attempt in `make.js` could never have fired. It uses `-contains` rather
  than a `Where-Object` pipeline because the pipeline matches correctly and then *emits the
  `$null` it matched*, making `if (...)` false — a guard that silently never fires, which
  is the exact failure shape it was written to catch.

**`clean` deliberately cannot delete `state/`,** and a test asserts it. The watched ledger
lives there and losing it makes the next run re-add every video it previously pruned, at
50 units a write (CLAUDE.md §11). `remove-channel` is the same thought: it prints the line
it removed verbatim, because the settings on it are not recoverable from anywhere else, and
says plainly that the playlist and the ledger are untouched.

**`doctor` is the target with the least obvious value and possibly the most.** It checks
node against the `engines` floor, the presence of each required `.env` key **by name only**
(this repo is public and that output gets pasted into issues), that every channel line
parses, and whether `core.hooksPath` is set. Running it on this clone immediately found
that the pre-push hook was never enabled here — which is exactly the class of thing nobody
discovers until a push breaks something.

**What is not verified.** The Windows scheduling half (`Register-ScheduledTask`,
`Get-ScheduledTaskInfo`, `Start-ScheduledTask`) is written to the form the README already
documents but has not been run on Windows; only the shim's argument handling was tested,
against pwsh 7.6 on macOS. `setup`, `install`, `uninstall`, `run-now`, `authorize` and
`claim` are unexercised for the same reasons they need care: they install system jobs, need
a browser, or spend quota.

**One mistake worth recording.** While testing the splatting guard I used `run` as the
target, assuming the guard would stop it. It did not — that attempt is the one described
above that could never fire — and a full Phase 1 sync ran against the live account. No
writes occurred (every channel reported `0 to add`, Phase 2 inserted nothing, no removals,
the foreign marker was reported and not claimed), so the cost was read quota only. But it
did write this Mac's heartbeat, `report.html`, and one newly-seen watch into a ledger on a
machine that is supposed to be inert. CLAUDE.md §11 says to exercise a change with
`--dry-run` and a small `--max`, never a full sync, and the reason it says so is that a
guard you have not yet proved is not a guard. Harmless targets (`version`, `list-channels`)
are what the remaining tests used.

### Handover completed, and two findings from it

**The Windows host claimed the account.** One marker remains, named for that machine, with
the same playlist id as the one it took over — so `--claim-sync` renamed rather than
recreated, 50 units not 100, as designed. The Mac stays inert: verified today that nothing is
in launchd, `/Library/LaunchDaemons`, `~/Library/LaunchAgents` or cron.

**PowerShell needs the handle quoted, and every Windows-facing example in this repo was
wrong.** `@` begins a splatting/array expression in PowerShell, so `npm start -- @Handle`
does not pass the handle through as text — it is read as the variable `$Handle`, and the
error names a variable the reader never wrote. The examples in README.md and AGENTS.md sit
in ```powershell blocks and showed it bare, on the platform AGENTS.md names as the
deployment target; they had never worked as written.

**Double quotes, not single — this corrects the first version of this entry.** The fix as
first pushed used `'@Handle'` and said the quotes were harmless in `cmd.exe`. They are not.
Tested rather than assumed, by running both forms through `node -e` under each shell:

```
cmd.exe    '@SomeChannel'  ->  ["'@SomeChannel'"]   quotes passed through; broken
cmd.exe    "@SomeChannel"  ->  ["@SomeChannel"]     correct
PowerShell either form     ->  ["@SomeChannel"]     correct
```

`cmd.exe` has no concept of single quotes and hands them to the program as part of the
argument, so the single-quoted form fails there — and `cmd.exe` is not hypothetical here:
`run-sync.cmd` is what the Scheduled Task invokes, so it is a shell someone debugging this
tool is likely to be sitting in. `"@Handle"` is the only form correct in all three shells
this project touches, POSIX included, which is why `src/authorize.js` uses it: that line
prints a suggested command without knowing which shell will read it.

**Why it survived this long.** Nothing automated passes a handle — `run-sync.cmd` and the
Scheduled Task call `npm start` with no positional argument and read `config/channels.txt`.
The handle form is only ever typed by a person debugging one channel, which is the worst
place to hide a broken example because it is reached during an incident.

Coverage beyond the first pass: `config/channels.example.txt`, `config/channels.txt` and
`src/authorize.js` carried the same bare form and are now quoted too. The channel-line
*format* at README §"A channel line is…" is deliberately **not** quoted — it documents a
file format, not a shell command, and quoting it would be a regression. One explanatory note
in the README, not two; comment columns inside the two affected fences were re-padded so the
added characters did not leave them ragged.

Rejected: leaving the examples bare and explaining the quoting in prose alone. The person who
needs that explanation is mid-error and copying a line, not reading the paragraph above it.

**The hostname key churned within three days, which is the marker's predicted weakness now
observed.** `os.hostname()` on the Mac went from `locasta` to `Mac.lan` — while
`scutil --get ComputerName` and `LocalHostName` both still read `locasta`. `os.hostname()`
returns the network-derived name, so `machineKey()` is built from the least stable of the
three names macOS keeps: a live machine in that position stops recognising its own claim and
reports a conflict against itself.

It argues *for* the design rather than against it. Had a foreign marker been fatal instead of
reportable, a router handing out a different name would have stopped the nightly sync — the
exact self-inflicted outage the "report, never block" rule was chosen to avoid. The evidence
also arrived in the mildest possible form: the Windows host's first post-pull run correctly
reported the Mac's stale marker while the Mac had nothing scheduled, costing one email and no
quota. The three candidate fixes and why none is free are recorded in
`docs/prompts/prompt-sync-marker-v2.md` §3a rather than acted on.

### A remote-side rule, after two hosts fixed one bug twice

Added a guardrail beside invariant 10: one machine pushes at a time, and `git fetch` before
you *start* rather than only before you push. The live host owns the remote; the idle machine
proposes through `docs/turnover/` or the mailbox.

**What it is and is not protecting.** Git already refuses a non-fast-forward, so no commit
was ever at risk of being silently lost — the structural guarantee was never missing. What
was unprotected is duplicated effort: both hosts independently found and fixed the same
PowerShell quoting bug, and the collision was caught by a hand-carried turnover doc plus a
`git fetch`, neither of which is structural. The rule is written to say exactly that, because
a reader who mistakes it for the thing preventing data loss will also mistake its absence for
danger and reach for something heavier than it needs.

**The duplicate was not wasted, as it happens.** The Windows host's fix was the better one —
double quotes rather than single, because single quotes are not quote characters in
`cmd.exe` and would have been passed through as literal apostrophes, turning the handle into
`'@Handle'`. It also caught two places the Mac missed: the example printed by
`src/authorize.js` on completion, and the comments in `config/channels.example.txt`. The
first of those matters most — that hint reaches the user at the moment they are most likely
to copy it verbatim. Recorded because "the duplicate work produced a better answer" is a real
outcome, and a rule written to prevent duplication should be honest that this is what it
sometimes costs.

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
