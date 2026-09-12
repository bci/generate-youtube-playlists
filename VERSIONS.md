# Versions

Version strings follow the format `YYYY.MM.DD-<commitID>`. There is no build step in this
project, so the version is documentary — it names the commit a deployment came from, and
`package.json` keeps a plain semver for tooling.

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
