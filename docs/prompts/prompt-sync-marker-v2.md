# YT-MARKER-002 — sync marker: what shipped

**Status:** shipped and verified against the live account · **Written:** 2026-09-12 ·
**Applies to:** `src/`, tests · **Tracks:** FEAT-0010 ·
**Supersedes:** [prompt-sync-marker-v1.md](prompt-sync-marker-v1.md)

v1 was the brief. This describes what was built and what it survived. The durable behaviour
now lives in [prompt-youtube-playlist-sync-v1.md](prompt-youtube-playlist-sync-v1.md) §5a and
invariant 10, which is where someone asking "what does this tool do" will look; read this one
for the reasoning behind the shape.

Nothing in the design changed on contact with the code — worth saying, because the brief was
written before reading `findPlaylistByTitle` and could easily have been wrong about the cost.

---

## 1. What exists now

| File | Role |
| ---- | ---- |
| `src/marker.js` | The decisions, pure: `machineKey`, `markerTitle`, `classifyMarker`, `checkClaimSync`, `conflictMessage` |
| `src/youtube.js` | `listMyPlaylists` (prefix match needs the whole list) and `renamePlaylist` |
| `src/index.js` | `--claim-sync`, the TTY guard, and `checkSyncMarker()` called once before the channels are read |
| `src/report.js` | The conflict banner, above the table |
| `test/marker.test.js`, `test/marker-run.test.js` | 23 tests: the pure rules, and every branch against a mocked client |

## 2. Implementation notes that are not obvious from the diff

**`playlists.update` replaces the snippet rather than patching it.** A description not
resent is silently cleared. That is safe here only because the call is made on a marker whose
description this tool owns; the comment on `renamePlaylist` says so, because reaching for it
to rename a *channel* playlist would quietly wipe whatever was there.

**An empty hostname must never produce a bare `gyp-sync-`.** It would prefix-match every
marker as "ours" and turn the guard into the exact opposite of a guard. `machineKey('')`
returns `unknown`, and the test says why rather than just asserting it.

**A foreign marker wins even when ours is also present.** Two markers means two
installations, whichever one we are, and it is precisely the state a half-finished host move
leaves behind. `--claim-sync` refuses that case rather than renaming — renaming would leave
two playlists with the same title — and points at deleting the other by hand, which is free.

**One claim per run, deliberately.** With three markers present, `--claim-sync` takes one and
reports the rest. Claiming is the expensive direction, and a loop of claims is the thing this
flag must never become.

**A `playlists.list` failure returns `null`, not an error.** The guard must never be the
reason the nightly sync dies; there is a test for it.

## 3. Verified

Against the live account, 2026-09-12:

1. **The TTY refusal** exits 1 before any API call — tested as
   `node src/index.js --claim-sync < /dev/null`, the way it will actually fail, rather than
   by reasoning about it.
2. **A planted `gyp-sync-otherbox`** (created through the same `createPlaylist` the tool
   uses) was detected and the machine named in three places: at detection, in the summary,
   and in the report banner above the table.
3. **It paged `ERROR_ALERT_TO`**, not the report audience — a conflict is operator news.
4. **The sync ran on** through the conflict, as designed.
5. **`--claim-sync` from a terminal** renamed the marker to `gyp-sync-thisbox`, and the
   surviving playlist has the **same id** as the planted one — the evidence that it renamed
   rather than deleted and recreated, so 50 units and not 100.
6. **`npm start -- --claim-sync` preserves stdin's TTY.** Worth testing rather than assuming:
   had npm interfered, the guard would have refused legitimate claims and looked like a flaw
   in the rule rather than in the plumbing.
7. 148 tests, lint clean at `--max-warnings=0`.

**Covered by mock rather than live:** the create-on-first-run branch. Exercising it for real
means deleting the marker and letting a run rebuild it — 100 units to cover three lines,
where a mocked client covers it for nothing and is how every other YouTube test here works.

## 4. The limitation to keep repeating

**It only sees machines that write a marker.** A machine on an older build syncs on happily
and is never reported — invisible to the new one, and unable to see it. Until every machine
is updated, the marker can say "another machine was here", never "no other machine is here".
The Windows box has not been updated as of this writing.
