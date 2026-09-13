# YT-MARKER-001 — sync marker playlist: implementation brief

**Status:** SUPERSEDED by [prompt-sync-marker-v2.md](prompt-sync-marker-v2.md) (2026-09-12) ·
**Written:** 2026-09-12 · **Applies to:** `src/`, tests · **Tracks:** FEAT-0010

> Kept for the reasoning that shaped the work, not as a description of it. It shipped on
> 2026-09-12 with no design changes; read v2 for what was built and what it was tested
> against.

Like [prompt-macos-support-v1.md](prompt-macos-support-v1.md), this describes work that has
**not been done**. It is a brief, not a description of the system. Supersede it with a `-v2`
when the work lands, and fold the durable parts into
[prompt-youtube-playlist-sync-v1.md](prompt-youtube-playlist-sync-v1.md).

---

## 1. Goal

Make **invariant 10** — exactly one machine syncs a given YouTube account — *observable*.

Today it is a deployment rule enforced by nothing: a run cannot see the other machine, so
two schedulers pointed at one account drift apart silently and start trading videos back and
forth at 50 quota units per write, nightly. The symptom (a couple of watched videos
reappearing) looks trivial next to its cost, so nobody investigates it.

The fix is a claim left on the account itself, where the other machine can see it: a private,
empty marker playlist titled **`gyp-sync-<key>`**. A run that finds a marker with a different
key knows another installation owns this account, and says so.

## 2. Behaviour to build

In phase 1, before any write:

| Found | Do |
| ----- | -- |
| No `gyp-sync-*` playlist | Create `gyp-sync-<ourkey>` (private, empty). **Not on `--dry-run`.** |
| `gyp-sync-<ourkey>` | Nothing. This is us. Silent — no report line, no log noise. |
| `gyp-sync-<otherkey>` | **Report it.** Console, `report.html`, and the email. Sync proceeds. |

With `--claim-sync`, the last row instead renames the existing marker to `gyp-sync-<ourkey>`
via `playlists.update` and continues normally.

**`--claim-sync` is interactive-only: refuse it when there is no TTY.** This is what makes
the flap structurally impossible rather than merely discouraged — the flag cannot be put in
`run-sync.sh`, a plist, or a Scheduled Task and have it take effect, so "both machines
auto-replace" is not reachable even by misconfiguration. Taking an account away from another
machine is a decision a person makes once, in front of a terminal, not something a nightly
job does.

- **Test `process.stdin.isTTY`, not `process.stdout.isTTY`.** Running a wrapper by hand
  redirects stdout into `logs/sync.log` while stdin stays a terminal, so keying off stdout
  would refuse a legitimate interactive claim. Under launchd and Task Scheduler stdin is
  `/dev/null` or absent, which is the signal we want. (Over SSH, `ssh -t` gives a TTY.)
- **Fatal, before any quota is spent** — not a warning that continues. The precedent is the
  existing treatment of a malformed channel setting, and the distinction from the "never
  block" rule above is worth stating: a foreign marker is a *condition on the account*, may
  be a false positive, and is nobody's mistake, so it reports. `--claim-sync` in a scheduled
  job is an *operator configuration error*, is never what anyone intended, and should stop
  loudly the first time rather than be silently ignored every night for a year. The error
  message should name the flag and say to run it from a terminal.

## 3. The decisions, and the options rejected

**Report, never block.** A conflict does not stop the run. A false positive — a hostname
change, or a marker left behind by a machine that has already been retired — would otherwise
silently stop the nightly sync, which is precisely the failure `src/watchdog.js` exists to
catch, self-inflicted. A nag is recoverable; a stopped sync nobody notices is what this
project keeps learning about.

**Replacement is explicit (`--claim-sync`), never automatic.** This is the important one. If
both machines replaced a foreign marker on sight, they would flap: the Mac renames it tonight,
Windows renames it back tomorrow, 50 units a write, forever — the same delete/re-add shape
invariant 1 exists to prevent, with both sides looking locally correct. Automatic takeover
also defeats the purpose: the second machine would quietly assume ownership and nobody would
ever be told.

**Rejected: auto-replace after N quiet days.** Attractive, because it would clean up after a
retired machine on its own. It needs a freshness signal in the marker, and the only place to
put one is the playlist's title or description — both of which cost a 50-unit
`playlists.update` *every run* to keep current. That is a quarter of a day's write budget
spent on bookkeeping. The manual path costs nothing: delete the stale `gyp-sync-*` playlist
in the YouTube UI and the next run creates its own.

**The key is the hostname, not a generated id.** A uuid stored in `state/` is the obvious
choice and it is wrong: the documented host-move procedure copies `state/` across, so both
machines would carry the same key and detect nothing — the guard would be defeated by our own
runbook, in exactly the case it was built for. A hostname also behaves correctly for two
checkouts on one machine (same key, no false alarm), and it names the offending machine in
the report, which is the thing you actually want to know at 7am. Its cost is that macOS
renames itself on some network changes, producing an occasional spurious report — tolerable
only because of the "never block" rule above, so these two decisions stand or fall together.

Sanitise the hostname to `[A-Za-z0-9-]` for the title, and match case-insensitively —
`findPlaylistByTitle` already lowercases, and YouTube titles are not case-sensitive in
practice.

## 4. Quota

- **Detection: ~1 unit per run.** `playlists.list` is 1 unit per page of 50, and the account
  has far fewer playlists than that. Note that `findPlaylistByTitle` already pages this same
  list once per playlist, so the run is already paying this several times over; a single
  prefix scan is not a new class of cost.
- **Creation: 50 units, once ever.**
- **`--claim-sync`: 50 units**, only when asked. `playlists.update` (rename) rather than
  `playlists.delete` + `playlists.insert`, which would be 100 and would orphan the id.

## 5. Shape

Keep the decision **pure**, per the AGENTS.md convention that `seen.js`, `report.js` and
`checkStale()` follow — something like `classifyMarker(titles, ourKey)` returning
`{ state: 'none' | 'ours' | 'foreign', key }`. Then the whole rule is testable with an array
of strings: no API client, no network, no mocked pagination. The API call and the create /
rename belong in `src/youtube.js` beside the other playlist operations.

Watch for two interactions:

- **The marker must never be mistaken for a channel playlist.** Find-or-create matches an
  exact title, so a collision needs a channel literally handled `@gyp-sync-…`; still, do not
  let the marker enter the per-playlist loop, and do not give it a `state/` ledger.
- **`--email-on-change` must treat a conflict as worth sending.** It currently emails on real
  progress, errors and quota stops. A machine conflict that only appears in `report.html` on
  a box nobody logs into is a warning nobody reads.

## 6. Acceptance criteria

1. Fresh account, no marker, real run → one private empty `gyp-sync-<host>` playlist appears.
2. Same run repeated → no second playlist, no report line, nothing in the log.
3. `--dry-run` against an account with no marker → creates nothing, and says what it would do.
4. Hand-create `gyp-sync-someotherbox` → next run reports the conflict in console,
   `report.html` and the email, **and still syncs**.
5. `--claim-sync` against that account → the playlist is renamed, not duplicated; the account
   still has exactly one `gyp-sync-*` playlist, and the next run is silent.
6. `--claim-sync` with stdin not a TTY → exits with a clear message naming the flag,
   **before** any API call. Verify it the way it will actually fail: from the wrapper, or
   `node src/index.js --claim-sync < /dev/null`, not by reasoning about it.
7. `classifyMarker()` unit tests cover none / ours / foreign / more than one marker present.
   Decide and document what "two foreign markers" means — reporting both is probably right,
   since it means three machines.
8. `npm test` and `npm run lint` pass.

## 7. Known limitation, to state in the README

**It only helps once every machine runs a version that writes the marker.** A machine on an
older build syncs on happily and is never reported — it is invisible to the new one *and*
cannot see it. Until the Windows box is updated too, the marker tells you "another machine
was here", not "no other machine is here".
