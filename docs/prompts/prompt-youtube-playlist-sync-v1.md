# YT-SYNC-001 — YouTube playlist sync: current state

**Status:** live · **Last verified:** 2026-09-04 · **Applies to:** the whole repo

A durable description of what this tool does today and why it is built this way. Written to
be handed to someone (or something) with no prior context: read this before changing
behaviour, and update it in the same change when behaviour moves. It describes the system as
it *is*, not a wish list.

---

## 1. Purpose

For each YouTube channel handle it is given, maintain **one private playlist on the
account's own YouTube profile** containing **every non-Short video from that channel, in
oldest → newest order**, minus the ones already watched. Then report what happened.

A channel line may narrow "every video" with a publish-date cutoff, or change what happens
to the channel's Shorts (§3a) — and `shorts=split` makes one line ask for **two**
playlists. So the unit of work is a playlist, not a channel, and the exact contents are
"every video this playlist's settings say belongs in it, oldest → newest, minus the
watched ones".

It runs unattended every night and is expected to be boring: no output on a quiet night, a
short email when something changed, and a different email to a different person when
something broke.

## 2. Hard invariants

Violating any of these is a bug, however good the reason looks:

1. **A watched video is never re-added.** Under any flag combination, on any run. The ledger
   (§5) is the memory that makes this true; without it, delete-then-re-add costs 100 quota
   units per video per night, forever.
2. **Playlist title is the playlist's identity.** By default it is the handle without the
   `@` (`@SomeChannel` → `SomeChannel`); `shorts=split` / `shorts=only` can add or rename
   a Shorts playlist beside it (§3a). Find-or-create, and the watched ledger's filename,
   both key off this title — which is what gives a split channel's two playlists two
   independent ledgers for free. The match is on the exact title, case-insensitively; a
   playlist renamed by hand causes a *second* playlist to be created, not an update.
3. **Every playlist is created `private`.**
4. **The `Watched` playlist is read-only to the tool.** Never added to, removed from, or
   deleted.
5. **Reads happen before writes.** Phase 1 snapshots every channel before a single write, so
   a mid-run quota stop still produces an accurate report for channels never reached.
6. **A permanent API failure is never retried.** Retrying spends 50 units and cannot succeed.
7. **No identity in tracked files.** Recipients, the account label and the channel list are
   configuration; see §9.
8. **One channel is read once,** however many playlists its line asks for. Handle
   resolution, the uploads listing and the Shorts probe are charged per channel; the
   `readChannel()`/`getPlaylistStatus()` seam (§3) exists to keep it that way.
9. **A cutoff deletion is not a watch.** Deleting a video for falling below a channel's
   `after=` date removes its id from `known` rather than banking it in `seen`, so lifting
   the cutoff later backfills normally instead of holding the videos out for good.

## 3. The run, in phases

| Phase | Writes? | What happens |
| ----- | ------- | ------------ |
| **1a — read channel** | no | Per *channel*: resolve handle → channel → uploads playlist; list every upload oldest → newest; apply the publish-date cutoff; partition Shorts off (unless `shorts=yes`, which needs no partition). Everything charged per channel happens here, once. |
| **1b — diff playlist** | no | Per *playlist* the channel feeds: take the `want` slice of that read; find the existing playlist; read its items; load and update the ledger; compute `missing`, `toRemove` and `toDrop`. |
| **1.5 — removals** | yes | Delete what should not be in the playlist. Runs *first* so the day's quota clears the deletion pile before backfilling. Two unrelated reasons share one pass and one `--max-removals` ceiling: the video is watched (`toRemove`) or it falls below the cutoff (`toDrop`). |
| **2 — inserts** | yes | Insert `missing` at chronological positions, **smallest backlog first**, until `--max` or quota. |
| **report** | — | `report.html`, console summary, `state/last-run.json` heartbeat, then email. |

Smallest-backlog-first means the order of `config/channels.txt` has no effect on
prioritisation: a nearly-complete playlist finishes before an 800-video backfill starts.
It sorts over playlists, so a split channel's two halves are prioritised independently.

## 3a. Per-channel settings

A line in `config/channels.txt` is a handle plus optional `key=value` settings, in any
order:

```
@Handle [after=YYYY-MM-DD] [older=keep|remove] [shorts=no|yes|only|split] [shorts-title="..."]
```

Values may be double-quoted so a playlist title can contain spaces; an unbalanced quote
is fatal, because the "Unrecognised field" it would otherwise raise names a fragment of
the title rather than the mistake.

**Every malformed setting throws**, aborting the run before any quota is spent, rather
than warning and falling back to a default. Each one has a silent-failure mode that
mimics a different fault: an ignored date backfills a whole back catalogue or deletes on
the wrong side of a line, and an ignored `shorts=` leaves a playlist empty or a second
playlist uncreated — both of which look like the tool having missed the channel.

`--after=`, `--older=` and `--shorts=` apply the same settings run-wide and override the
file, which is how a setting is tried before being committed to it.

### Publish-date cutoff — `after=` and `older=`

The date is **UTC and inclusive** — `after=2026-01-01` keeps a video published on
1 January. `2026-02-30` is rejected by round-tripping the parse, because `Date` rolls it
over to 2 March rather than refusing it.

The cutoff is applied in phase 1 **before the Shorts probe**, deliberately: the probe
costs a `videos.list` unit per 50 ids plus an HTTP `HEAD` per short-listed candidate, and
a cutoff exists precisely to stop paying for the back catalogue. That leaves `outOfScope`
unclassified — we never learn which of them are Shorts — and it does not matter, because
the only thing done with them is to delete the ones found in a given playlist, and
playlist membership already separates a split channel's two targets better than a
Short/video label would.

`older=remove` is the default, because the date describes what the playlist should
*hold*, not merely what to add next. It is the expensive default — 50 units a video
against ~200 writes a day, so a long back catalogue takes several nights to clear, and
the videos do not come back if the date is moved later. `older=keep` gates additions only.

Two consequences worth knowing:

- **Insert positions.** `applyInserts` derives each position by walking the in-scope
  uploads, which no longer contain the pre-cutoff videos. Any of those still in the
  playlist sit *above* every in-scope one, so the walk starts past them — counted live
  from `existingIds`, which is also correct mid-way through a multi-night `remove`.
- **`older=keep` leaves the playlist larger than the in-scope total**, so "In playlist"
  can exceed the video count. The report names the cutoff on every run so that reads as
  a setting rather than a fault.

### Shorts — `shorts=` and `shorts-title=`

Excluded by default, on every channel: a channel's Shorts are usually clips of its real
videos, and a playlist meant to be watched end to end does not want them.

| Mode | Playlists | Probe? | `want` |
| ---- | --------- | ------ | ------ |
| `no` (default) | one, Shorts left out | yes | `videos` |
| `yes` | one, Shorts mixed in | **no** | `videos` (= everything) |
| `only` | one, Shorts only | yes | `shorts` |
| `split` | **two** | yes | `videos` + `shorts` |

`shorts=yes` is the one mode that needs no partition, so it is the one mode that skips
`partitionShorts` entirely — making it *cheaper* than the default, not dearer. The 180s
gate and the URL probe (§6) only exist on the paths that classify.

`shorts=only` exists because a channel that posts nothing but Shorts gets an empty
playlist under the default, which is indistinguishable from a broken handle.

`shorts=split` is the only setting that makes one channel line describe two playlists,
and it is why phase 1 is split in two (§3). Its second playlist defaults to
`<Name> (Shorts)`; `shorts=only` has no sibling to collide with and so defaults to plain
`<Name>`. `shorts-title=` overrides whichever playlist holds the Shorts, and is rejected
on `shorts=no`/`shorts=yes` because there is no such playlist for it to name.

What makes `split` cheap: `partitionShorts` already computed both halves in order to
exclude one of them — it used to return the non-Shorts plus a count and discard the rest.
So the second playlist costs nothing extra to *determine*; it costs only its writes.

Two asymmetries, both intended:

- **Turning Shorts on backfills** every Short at 50 units each; `--max=N` paces it.
- **Turning it back off leaves them in the playlist.** There is no `shorts=remove` to
  match `older=remove`, and the position walk cannot compensate the way it does for a
  cutoff: excluded Shorts are interleaved chronologically rather than bunched at the old
  end, so there is no count to start past. New inserts can land out of order until they
  are removed by hand — the same limitation as a hand-added video from another channel
  (§11).

## 4. Quota economics — the constraint everything bends around

Default YouTube Data API budget: **10,000 units/day**, resetting ~midnight Pacific.

| Call | Units | Note |
| ---- | ----- | ---- |
| `playlistItems.insert` / `.delete`, `videos.rate` | **50** | ~200 writes/day, total, across all channels |
| `playlistItems.list`, `playlists.list`, `videos.list`, `channels.list` | 1 | per page (50 items) |
| `search.list` | **100** | fallback only, when handle resolution fails |

Consequences baked into the design: the tool only ever adds what is missing (so a large
channel resumes across days); it stops gracefully and flags `quotaHit` rather than failing;
`--unlike` is off by default because it doubles the cost of a deletion for a cosmetic
benefit; and when quota is exhausted even *read* calls start returning 403, so the report
must already be accurate by then.

## 5. The watched ledger (`src/seen.js`, `state/<Playlist>.json`)

**Why it exists:** YouTube exposes no watch history. `relatedPlaylists.watchHistory` was
deprecated in 2016 and is now absent from the response; the documented `HL` playlist id
returns `0 items, totalResults=0` *without an error*, so anything built on it silently
concludes nothing was ever watched. There is no OAuth scope for history and no replacement.

**Three signals, one ledger.** A video counts as watched if any of these is true:

1. it was **liked** on the account (read once per run from the system `LL` playlist — one
   button on a TV remote, which is the whole point);
2. it was saved to a manually-curated playlist named **`Watched`** (unambiguous, and leaves
   no public like);
3. it was in the channel playlist and is **no longer there** — removed by hand.

**Shape:** `{ playlistId, known: Set, seen: Set }`. `known` is every video id ever observed
in the playlist; `seen` is the watched set. Both are permanent — a later sync re-adding a
video does not erase the record, and neither does un-liking it or emptying `Watched`.

**Two resets, deliberately.** If the playlist does not exist, or its id changed (deleted and
recreated), the ledger resets instead of declaring every video watched — in both cases
"absent from the playlist" has stopped meaning "removed".

**Edges that are intended, not bugs:** emptying a playlist marks all of it watched; a
`--dry-run` still persists the ledger (detection cannot work otherwise); the first run banks
a baseline and marks nothing; a video the *channel* deleted is not counted as watched,
because it could never be re-added anyway.

## 6. Shorts exclusion

`partitionShorts()`. Runs for every mode but `shorts=yes` (§3a), and returns both halves —
which is what `shorts=split` puts in two playlists. Two gates, cheapest first: a video
longer than **180s** cannot be a Short, so only shorter
candidates get the authoritative check — a `HEAD` on `https://www.youtube.com/shorts/<id>`
with `redirect: 'manual'`, where **200 = a Short** and a 3xx redirect to `/watch` = a normal
video. Run 20-wide, bounded by a 10s timeout per request. A network error keeps the video
rather than dropping it.

## 7. Failure handling

- **Quota errors** (`quotaExceeded`, `dailyLimitExceeded`, `rateLimitExceeded`,
  `userRateLimitExceeded`) → set `quotaHit`, stop cleanly, report it, resume next run.
- **Manual-sort refusal** (`manualSortRequired`, *"Playlist should use manual sorting to
  support position"*) → the playlist's sort order was changed in the YouTube UI, and the API
  has no field to change it back. Fall back to a position-less append for the rest of the
  run and tell the reader to restore **Sort → Manual**. Adding videos out of order beats
  adding none.
- **Transient aborts / 5xx** → `withRetry`, backing off, 4 attempts.
- **Anything permanent** → fatal to `withRetry`, per invariant 6.
- **A channel that throws** → recorded on that channel's row; every other channel continues.
- **Never running at all** → the sync cannot report this, so `src/watchdog.js` does: every
  completed run writes `state/last-run.json`, and a separate scheduled task alerts when the
  last success is older than 36 hours (two missed nights, so one late run stays silent).

## 8. Interface

```
npm start -- [@handle ...] [flags]        # no handle = every channel in config/channels.txt
```

| Flag | Effect |
| ---- | ------ |
| `--dry-run` | Report what would change. No adds, no deletes, no email. Still updates the ledger. |
| `--email` | Always email the report to `REPORT_TO`. |
| `--email-on-change` | Email only on real progress; errors and watched previews go to `ERROR_ALERT_TO` instead. What the scheduled task runs. |
| `--max=N` | At most N adds per channel this run. |
| `--max-removals=N` | At most N deletions this run, across all channels (both reasons). `0` means none. |
| `--after=YYYY-MM-DD` | Run-wide publish-date cutoff; overrides the dates in the channel list. |
| `--older=keep|remove` | Run-wide `older=`. `keep` gates additions on the cutoff but deletes nothing, disarming an `older=remove` for one run without needing `--dry-run`. |
| `--shorts=no|yes|only|split` | Run-wide `shorts=`; overrides the channel list. |
| `--report-watched` | Detect and report watched videos; delete nothing. Adds run normally. |
| `--ignore-watched` | Skip the watched signals entirely. The never-re-add guard still applies. |
| `--prune-watched` | Redundant (asks for the default); kept so older callers keep working. |
| `--unlike` | Clear the like after deleting. Costs another 50 units each; cosmetic. |
| `--watched-playlist=NAME` | Name of the manually-curated watched playlist. Default `Watched`. |
| `--config=PATH` | Alternate channel list. |

**Report contract:** one row per *playlist* — Channel, Playlist (linked), Added, Removed,
In playlist, Status. A split channel contributes two rows under one handle, sorted by
handle then playlist title so their order is stable; the videos row names the sibling
holding its Shorts rather than calling them "skipped". A dash means "nothing happened"; dry runs and preview modes state an
intent ("18 to add", "3 would remove") rather than a number that did not happen. An errored
channel's message spans the full row. Ledger internals stay in the console summary, not the
email.

**Email routing:** progress → `REPORT_TO`. Errors and watched-video previews →
`ERROR_ALERT_TO` (falls back to `REPORT_TO`). A quiet night sends nothing.

## 9. Configuration and secrets

Everything identifying is configuration, and every piece of it is git-ignored:

| File | Contains | Tracked template |
| ---- | -------- | ---------------- |
| `.env` | Google OAuth (client id/secret/refresh token), Microsoft Graph creds, `REPORT_TO`, `ERROR_ALERT_TO`, `ACCOUNT_LABEL` | `.env.example` |
| `config/channels.txt` | the channel list, with each channel's `key=value` settings (§3a) | `config/channels.example.txt` |
| `state/*.json` | watched ledgers, run heartbeat | — |
| `report.html`, `logs/` | last run's output | — |

Nothing in `src/` defaults to a real address: a send with no recipient configured fails with
a message naming the variable to set.

Two operational facts that cost time to rediscover: **the Graph sender must be a real,
licensed mailbox** (a Google identity sharing the domain gets a 404), and **a Google OAuth
client left in testing mode issues refresh tokens that expire after 7 days** — publishing the
consent screen ("In production") fixes it without needing verification for a single user.

## 10. Testing

`node --test`, no framework. The YouTube client is mocked everywhere; the only test that
touches the network is `test/credentials.test.js`, which hits OAuth token endpoints (**no
Data API quota**) and skips itself when the matching env vars are absent, so a fresh clone
still passes. `npm run lint` is `--max-warnings=0` and the pre-push hook runs both.

Keep new logic pure where it can be — `seen.js`, `report.js` and `checkStale()` take data
and return data, which is why the ledger, the report and the staleness rule are testable
without a clock, a mailbox or an API key.

## 11. Known limits

- **Ordering depends on the playlist staying on Manual sort**, which the API cannot enforce
  or restore (§7).
- **A like is per-account.** On a shared account, someone liking a video because they enjoyed
  it marks it watched for everyone. The `Watched` playlist is the unambiguous alternative.
- **The ledger is local to one machine** and git-ignored. Deleting `state/` loses the watched
  history and re-baselines on the next run.
- **Videos added to a playlist by hand from another channel** are invisible to the tool: it
  only ever reasons about the uploads of the channel that playlist belongs to.
- **Scheduled tasks are Windows-only.** The Node code is not.
