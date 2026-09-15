# generate-youtube-playlists — project context

## What this is

A single-purpose Node.js CLI. For each YouTube channel it is given, it maintains a
**private playlist on the account's own YouTube profile**, named after the handle without
the `@`, holding **every non-Short video from that channel in oldest → newest order** —
then deletes the ones that have been watched, writes an HTML report, and optionally
emails it.

Each channel line can narrow or widen that with `key=value` settings: `after=` /`older=`
for a publish-date window, and `shorts=` for whether its Shorts are excluded, mixed in,
the only contents, or **split into a second playlist of their own**. So one channel line
can describe more than one playlist — the unit of work is a playlist, not a channel.

It runs unattended: a Windows scheduled task at 3 AM, plus a second scheduled task
(the watchdog) that speaks up when the first one stops running.

There is no server, no database and no build step. State is three things on disk:

| Path | What it holds | Tracked? |
| ---- | ------------- | -------- |
| `.env` | Google OAuth + Microsoft Graph credentials, recipients | no (`.env.example` is) |
| `config/channels.txt` | the channel list + each channel's `key=value` settings | no (`config/channels.example.txt` is) |
| `state/*.json` | per-playlist watched ledger + `last-run.json` heartbeat | no |
| `report.html`, `logs/` | last run's report and console log | no |
| `docs/turnover/` | handover notes for whoever picks the work up on another machine | no |

## Layout

```
src/index.js      CLI entry: channel-line parsing, the phased workflow, reporting, email
src/youtube.js    Everything that talks to the YouTube Data API
src/seen.js       The watched ledger — pure functions over {known, seen} sets
src/report.js     HTML report builder (pure; shared by the run and the tests)
src/email.js      Microsoft Graph sender (client-credentials flow)
src/auth.js       Google OAuth2 client from env vars + the interactive authorize flow
src/authorize.js  `npm run authorize` entry point
src/heartbeat.js  Writes/reads state/last-run.json; the pure staleness rule
src/watchdog.js   `npm run watchdog` entry point — alerts when the sync goes quiet
test/*.test.js    node:test, no framework, mocked YouTube clients
```

## Commands

```powershell
npm install
npm run authorize          # one-time browser OAuth, writes GOOGLE_REFRESH_TOKEN to .env
npm start -- '@Handle' --dry-run  # safe: reads only, changes nothing
npm start -- '@Handle'            # one channel (quote it: @ is PowerShell's splat sigil)
npm start                         # every channel in config/channels.txt
npm start -- --email-on-change    # what the scheduled task runs
npm run watchdog -- --dry-run     # staleness check without sending
npm test                          # node --test
npm run lint                      # eslint . --max-warnings=0
```

## The shape of a run

Deliberately phased, because quota runs out mid-run and the report still has to be true.

1. **Phase 1 — read everything, write nothing.** Two steps, and the seam between them
   matters: `readChannel()` resolves the handle, lists the uploads, applies the `after=`
   cutoff and splits Shorts off — all charged *per channel* — and then
   `getPlaylistStatus()` diffs each playlist that channel feeds against its slice of that
   one read. A `shorts=split` line therefore costs one listing and one Shorts probe, not
   two. Produces a full status snapshot for *every* playlist before a single write happens.
   The cutoff is applied before the Shorts probe on purpose — the probe is what an
   out-of-scope video would otherwise cost.
2. **Phase 1.5 — removals.** Delete watched videos, and videos below the cutoff on a
   `remove` channel. First, so the day's quota clears the deletion pile before backfilling;
   one pass and one `--max-removals` ceiling, because both reasons share the write budget.
3. **Phase 2 — inserts.** Smallest backlog first, so nearly-complete channels finish before
   a large backfill eats the budget. `config/channels.txt` order is irrelevant.
4. **Report** — `report.html`, console summary, heartbeat, then email.

## Conventions

- **ESM, no framework.** `"type": "module"`, Node's built-in test runner, `fetch` and
  `process.loadEnvFile` from the platform. Two runtime dependencies (`googleapis`,
  `@google-cloud/local-auth`) and eslint. Adding a third dependency needs a reason.
- **Node 20.12+** (`engines` in `package.json`) — `process.loadEnvFile` is the floor.
- **Lint discipline: never ignore a warning, fix it.** `npm run lint` is
  `--max-warnings=0` and the pre-push hook enforces it. Do not silence a finding with a
  disable comment to make the build pass.
- **Pure where it can be pure.** `seen.js`, `report.js` and `heartbeat.js`'s `checkStale`
  take data and return data, so they are testable without a clock, a mailbox or an API key.
  Keep new logic on that side of the line where possible.
- **Comments explain *why*, and especially why-not.** Most non-obvious lines here exist
  because something failed in production once. Preserve that reasoning when you edit; add
  it when you introduce a rule.
- **Tests mock the YouTube client**, they never call it. `test/credentials.test.js` is the
  one exception: it hits the OAuth token endpoints only (no Data API quota), and skips
  itself when the matching env vars are absent, so a fresh clone still passes.
- **Line endings are mixed in the working tree** (some files CRLF, some LF) and git is set
  to normalize on checkout. Don't "fix" a file's endings as a side effect — it turns a
  three-line change into a whole-file diff.
- **Windows is the deployment target** for the scheduled tasks; the Node code itself is
  platform-neutral. Keep it that way.

## Guardrails

The hard rules live in [CLAUDE.md](CLAUDE.md) §11 (quota and real-account writes) and §12
(this repo is public). In short:

- Test against the live account with `--dry-run`, then `--max=1`. Never a full sync.
- A write costs 50 units; there are ~200 a day. Never retry a permanent failure.
- A video the ledger knows is watched is never re-added, under any flag combination.
- **One machine syncs an account** — Windows or macOS, never both. The ledger is per-machine,
  so a second scheduler re-adds what the first pruned. A host move is: copy `state/`, then
  disable the old host's jobs.
- A cutoff deletion is *forgotten* by the ledger, never banked as a watch — otherwise
  lifting an `after=` date would hold those videos out for good.
- One channel is read once however many playlists its line asks for. The expensive reads
  (uploads listing, Shorts probe) are per channel; don't move them behind the seam.
- No addresses, ids or channel names in tracked files.

## Worklog / versions / features discipline

[WORKLOG.md](WORKLOG.md), [VERSIONS.md](VERSIONS.md) and [features.yaml](features.yaml) are
load-bearing, not afterthoughts. Update them in the same session as the change — don't defer
to a "docs" commit. Use absolute dates (e.g. `2026-09-12`), never relative ones.

They answer different questions, so most changes touch more than one:

| File | Answers |
| ---- | ------- |
| `WORKLOG.md` | What was done, and **why** it is shaped that way |
| `VERSIONS.md` | What shipped, and in which release |
| `features.yaml` | What exists and what is still planned, under stable ids |

### `features.yaml`

The structured rollup — it exists so "is the Shorts split done?" or "what is left for
macOS?" can be answered without reading the source. Its own header comment carries the full
schema. The rules that matter when editing it:

- **One entry per feature. `id` is `FEAT-NNNN`, zero-padded, and never renumbered** — ids
  are referenced from prompts, commit messages and the other repo's manifests. A new
  feature takes the next free id, so ids ascend with `added:`.
- `status` is one of `planned | in-dev | in-test | complete | deferred`.
- `release` names the VERSIONS.md release that *last* changed the feature, or `Unreleased`
  when its newest change hasn't shipped.
- Bump the top-level `updated:` whenever the file changes.
- `notes:` is where the caveats and known limits go — a feature marked `complete` with a
  real limitation is honest; one marked `complete` that quietly isn't, is not.
- **It must stay valid YAML.** Verify after editing, e.g.
  `python -c "import yaml,sys; yaml.safe_load(open('features.yaml',encoding='utf-8'))"`.
  Nothing enforces this automatically — there is no CI for it in this repo.

When a feature lands, the change that lands it also moves its entry to `complete` and sets
`release` and `updated`. A feature is not done while its entry still says `planned`.

### Prompts

Durable prompts describing the system live in [docs/prompts/](docs/prompts/), in two genres,
and it matters which one you are writing:

- **Current state** (e.g. `prompt-youtube-playlist-sync-v1.md`) — describes the system as it
  *is*. When behaviour changes in a way that makes one wrong, update it in the same change.
- **Implementation brief** (e.g. `prompt-macos-support-v1.md`) — describes work *not yet
  done*, and names the `FEAT-NNNN` it tracks. When that work lands, supersede the brief with
  a `-v2` describing what shipped, and fold the durable parts into the current-state prompt.

## What Claude should do by default

- Read before writing. Understand the existing pattern before adding a new one.
- Ask before destructive changes, before anything that spends real quota, and before
  touching files outside the current task.
- Say what you did and why, in the code and in the response.
- Prefer small, reviewable changes over sweeping ones.
- Fix lint and diagnostic warnings on the spot rather than dismissing them as cosmetic.
