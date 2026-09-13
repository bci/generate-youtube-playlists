# Generate YouTube Playlists

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/Node-%E2%89%A5%2020.12-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org/) [![YouTube Data API](https://img.shields.io/badge/YouTube%20Data%20API-v3-FF0000?logo=youtube&logoColor=white)](https://developers.google.com/youtube/v3) [![Scheduling: Windows](https://img.shields.io/badge/Scheduling-Windows-0078D4?logo=windows&logoColor=white)](#windows) [![Scheduling: macOS](https://img.shields.io/badge/Scheduling-macOS-000000?logo=apple&logoColor=white)](#macos)

Given a YouTube channel handle (e.g. `@SomeChannel`), this tool creates a **private**
playlist on your YouTube account named after that channel and fills it with
**all of the channel's videos, oldest → newest**. Reruns are idempotent: if the
playlist already exists it is updated (only missing videos are appended). When finished
it builds an HTML report table and can email it to the address you configure.

## Contents

- [What you get](#what-you-get)
- [Requirements](#requirements)
- [One-time setup](#one-time-setup)
- [Usage](#usage) — [flags](#flags), [per-channel settings](#per-channel-settings)
- [Scheduling](#scheduling) — [Windows](#windows), [macOS](#macos), and [the watchdog](#the-watchdog)
- [Email](#email)
- [Watched videos — delete once viewed](#watched-videos--delete-once-viewed)
- [Quota — important for large channels](#quota--important-for-large-channels)
- [How it works](#how-it-works)
- [Tests](#tests)
- [Files](#files)
- [License](#license)

## What you get

- One private playlist per channel, named after the channel handle without the `@` (e.g. `@SomeChannel` → playlist `SomeChannel`).
- Videos in oldest → newest order.
- Shorts left out by default; per channel you can mix them in, collect only them, or
  `shorts=split` them into a second playlist of their own.
- Idempotent: safe to rerun — existing playlists are updated, not duplicated.
- An HTML report (`report.html`) listing every playlist with its link, optionally emailed.

## Requirements

| Requirement | Why |
| ----------- | --- |
| **Node.js 20.12+** (20.12 / 21.7 or newer) | `process.loadEnvFile()` reads `.env` with no dependency; global `fetch` and `AbortSignal.timeout` are also assumed. Enforced by `engines` in `package.json`. |
| **A Google account** to own the playlists | Every playlist is created, filled and pruned on this one account. |
| **A Google Cloud project** with **YouTube Data API v3** enabled, plus an OAuth **Desktop app** client | The tool acts as a person, not a service account — playlists belong to an account. Setup below. |
| **Windows or macOS** — *only* for the scheduling | `run-sync.cmd` / `run-watchdog.cmd` drive two Windows Scheduled Tasks; `run-sync.sh` / `run-watchdog.sh` and the templates in `launchd/` drive two macOS LaunchDaemons. Only these wrappers are platform-specific — the Node code is cross-platform, so on Linux drive `npm start` from cron instead. |
| **Microsoft 365 app registration** with `Mail.Send` — *optional* | Only for the emailed report. Without it, skip `--email` and read `report.html`. |

Beyond that it is `npm install`. There is no database and no long-running service: the only
persistent state is `state/*.json` (the watched ledger) and the generated `report.html`.

---

## One-time setup

### 1. Google Cloud project + OAuth client

The client ID/secret and the refresh token live in `.env` (git-ignored). To set one up from
scratch:

1. Go to <https://console.cloud.google.com/> and create (or pick) a project.
2. **APIs & Services → Library** → enable **YouTube Data API v3**.
3. **APIs & Services → OAuth consent screen**:
   - User type: **External** (or Internal if your domain is a Workspace org).
   - Add the playlist-owning account as a **Test user**.
4. **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Desktop app** → download the JSON.
5. Copy `.env.example` to `.env` and fill in `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
   from that JSON (plus the Microsoft 365 email vars). `.env` is git-ignored.

### 2. Install dependencies

```powershell
npm install
```

### 3. Authorize (opens a browser)

```powershell
npm run authorize
```

A browser opens. **Sign in as the account that will own the playlists** and approve YouTube
access. The refresh token
is written to `.env` (`GOOGLE_REFRESH_TOKEN`) so future runs need no browser.

> Note on the "unverified app" screen: because this is your own OAuth client in testing
> mode, Google shows a warning. Click **Advanced → Go to (app) → Continue**. This is
> expected for a private tool used only by your own account.

> **Testing-mode refresh tokens expire after 7 days.** If every channel suddenly fails with
> `invalid_grant`, that is the cause. Either re-run `npm run authorize` on that cadence, or
> set the consent screen to **In production** — a published app's refresh tokens do not
> expire on a timer, and no Google verification is required while you are its only user.

---

## Usage

Process a single channel (dry run — shows what *would* happen, changes nothing):

```powershell
npm start -- @SomeChannel --dry-run
```

Actually create/update the playlist for one channel:

```powershell
npm start -- @SomeChannel
```

Process every channel listed in `config/channels.txt` (no argument = use the config):

```powershell
npm start
```

Create/update playlists **and** email the report to `REPORT_TO`:

```powershell
npm start -- --email
```

### Flags

| Flag              | Meaning                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `@handle`         | Process just this channel (repeatable). Omit to use `config/channels.txt`. |
| `--email`         | Email the report to `REPORT_TO` (see [Email](#email)).                    |
| `--email-on-change` | Email only when a run actually changed something (added videos, hit quota, or errored). Used by the scheduled task. |
| `--dry-run`       | Resolve channels and report what would change, but make no edits.        |
| `--max=N`         | Add at most N videos this run (per channel) — useful for staying under quota. |
| `--report-watched` | Detect and report watched (liked) videos without deleting — see [Watched videos](#watched-videos--delete-once-viewed). |
| `--ignore-watched` | Skip watched detection entirely. Already-pruned videos are still never re-added. |
| `--unlike`        | Clear the like after deleting a watched video (+50 units each).           |
| `--max-removals=N` | Delete at most N videos this run, across all channels.                  |
| `--claim-sync`    | Take over this account's [sync marker](#the-sync-marker) from another machine. Terminal only. |
| `--after=YYYY-MM-DD` | Only collect videos published on or after this day. |
| `--older=keep\|remove` | What to do with videos already in a playlist that fall below the cutoff. `keep` is the escape hatch for trying a cutoff on a real run. |
| `--shorts=no\|yes\|only\|split` | How to treat Shorts. `split` gives each channel a second, Shorts-only playlist. |
| `--config=PATH`   | Use a different channel list file.                                       |

### Adding channels to the recurring list

`config/channels.txt` is **git-ignored** — it is your list, not the project's. The tracked
template is [`config/channels.example.txt`](config/channels.example.txt). Copy it once:

```powershell
Copy-Item config/channels.example.txt config/channels.txt
```

Then edit it: one channel per line, `#` for comments, leading `@` optional. A bare
handle is all most channels need; the optional `key=value` settings below tune the rest.
A run with no channel argument reads this file; a run with one ignores it. If the file is
missing, the tool says so and points at the template instead of failing with a bare
`ENOENT`.

### Per-channel settings

A channel line is a handle plus optional `key=value` settings, in any order:

```
@Handle [after=YYYY-MM-DD] [older=keep|remove] [shorts=no|yes|only|split] [shorts-title="..."]
```

A malformed setting is a **fatal error**, not a warning. The file is read before a
single unit of quota is spent, and each of these has a silent-failure mode that looks
like something else went wrong.

#### Publish-date cutoffs — `after=` and `older=`

```
@ABigChannel after=2026-01-01                only videos from 1 Jan 2026 onward
@ABigChannel after=2026-01-01 older=remove   ...and delete the older ones (default)
@ABigChannel after=2026-01-01 older=keep     ...and leave the older ones alone
```

The date is **UTC and inclusive** — `after=2026-01-01` keeps a video published on
1 January. `2026-02-30` is rejected rather than rolling over to 2 March.

**`older=remove` is the default, and it costs quota.** The date describes what the
playlist should hold, not just what to add next, so anything older is deleted from it.
Each deletion is 50 units against a budget of roughly 200 writes a day, which means a
long back catalogue takes several nights to clear — and the videos do not come back if
you move the date later. Use `older=keep` to gate new additions only.

Cutoff deletions are deliberately **not** recorded as watched. The watched ledger
forgets those ids instead, so removing a cutoff later lets the run backfill normally
rather than holding the videos out for good.

#### Shorts — `shorts=` and `shorts-title=`

Shorts are **excluded by default**, on every channel. A channel's Shorts are usually
clips of its real videos, and a playlist meant to be watched end to end does not want
them.

```
@ANormalChannel shorts=no      one playlist, Shorts left out          (the default)
@AMixedChannel  shorts=yes     one playlist, Shorts mixed in
@AShortsChannel shorts=only    one playlist, only Shorts
@ABothChannel   shorts=split   TWO playlists: "ABothChannel" + "ABothChannel (Shorts)"
```

- **`shorts=only`** is for a channel that posts nothing but Shorts. Under the default
  its playlist comes out empty, which looks exactly like a broken handle.
- **`shorts=split`** is for a channel that posts both and you want them apart. It is
  the one setting that makes a single line describe **two playlists**.
- **`shorts-title="..."`** renames whichever playlist holds the Shorts. Quote it if it
  contains spaces. `split` defaults to `<Name> (Shorts)`; `only` has nothing to collide
  with, so it defaults to plain `<Name>`.

```
@ABothChannel shorts=split shorts-title="A Both Channel — Clips"
```

Two properties of `split` worth knowing, because they are the reason it is built this
way rather than as two channel lines:

- **The channel is read once.** Resolving the handle, listing the uploads and above all
  the Shorts probe (a `videos.list` unit per 50 ids plus an HTTP `HEAD` per candidate)
  are charged per *channel*, not per playlist. The partition into videos and Shorts was
  already being computed to exclude them, so the second playlist is nearly free to
  determine — it only costs the writes.
- **Each playlist keeps its own watched ledger,** keyed by playlist title. Liking a
  Short marks it watched in the Shorts playlist and nowhere else.

Turning Shorts on **backfills** every Short at 50 quota units each, so pace the first
runs with `--max=N`. Turning it back off does **not** remove the Shorts already in a
playlist, and because Shorts are interleaved chronologically rather than bunched at one
end, new videos inserted afterwards can land out of order until they are removed by
hand. (Same limitation as a video saved to a playlist by hand from another channel.)

#### Trying a setting before committing it

`--after=`, `--older=` and `--shorts=` take the same values and apply to the whole run,
overriding the file:

```powershell
npm start -- @ABigChannel --after=2026-01-01 --dry-run    # nothing is written
npm start -- @ABothChannel --shorts=split --dry-run
npm start -- --after=2026-01-01 --older=keep              # real run, no deletions
```

`--older=keep` also disarms an `older=remove` cutoff already in the file, for one run,
without needing `--dry-run`.
---

## Scheduling

Nothing here runs on its own — a scheduler has to drive it. **3:00 AM** is the trigger worth
picking on either platform: quota resets around midnight Pacific, so an early-morning run
starts with the full budget. Whichever wrapper runs, it syncs every channel in
`config/channels.txt`, writes `report.html`, and appends its output to `logs/sync.log`.
Watched videos are deleted as part of every run — see
[Watched videos](#watched-videos--delete-once-viewed).

> **One machine per YouTube account — Windows *or* macOS, never both, and never two of
> either.** The watched ledger lives in `state/` on the machine that wrote it, so a second
> scheduler works from a copy that stays correct only until the next video is watched. After
> that the stale side re-adds what the live side pruned, and the two trade the video back
> and forth at 50 quota units per write, every night. Nothing in a run can detect the other
> machine, so this is a deployment rule, not something the tool can enforce.
>
> Switching hosts is therefore two steps in order: copy `state/` (plus `.env` and
> `config/channels.txt`) to the new machine, **then** disable the old machine's jobs —
> `Disable-ScheduledTask "YouTube Playlist Sync"` and its watchdog on Windows,
> `sudo launchctl bootout system/local.youtube-playlists.sync` and its watchdog on macOS.

### The sync marker

Because that rule is easy to break by accident and expensive when broken, each run leaves
a claim where the *other* machine can see it: a private, empty playlist named
**`gyp-sync-<machine>`**, keyed to the hostname. It holds no videos and is ignored by
everything else.

| What the run finds | What it does |
| ------------------ | ------------ |
| No marker | Creates its own. 50 units, once ever. Not on `--dry-run`. |
| Its own marker | Nothing at all — the normal case, every night. |
| Another machine's marker | **Reports it** in the console, `report.html` and the email. The sync still runs. |

It reports rather than refuses on purpose: a marker can be stale through nobody's fault —
a retired machine that was never cleaned up, or a hostname changed by a new network — and a
guard that stopped the nightly sync on a false positive would be worse than the problem.

To take over an account (after disabling the sync on the other machine):

```sh
npm start -- --claim-sync
```

**`--claim-sync` only works from a terminal.** Run from a scheduled job it exits with an
error, before touching the network. That is what keeps two machines from taking the account
back from each other every night at 50 units a write — the flag cannot be put in
`run-sync.sh`, a plist or a Scheduled Task and have any effect. If both markers already
exist, delete the other one by hand in the YouTube UI instead; the next run re-claims.

> **It only helps once every machine runs a build that has it.** A machine on an older
> version syncs on happily and is never reported. Until both are updated, the marker tells
> you "another machine was here", never "no other machine is here".

### Windows

Drive it from a Windows Scheduled Task pointing at [`run-sync.cmd`](run-sync.cmd).
Register it once, from the repo root:

```powershell
$action  = New-ScheduledTaskAction -Execute "$PWD\run-sync.cmd" -WorkingDirectory $PWD
$trigger = New-ScheduledTaskTrigger -Daily -At 3am
Register-ScheduledTask -TaskName "YouTube Playlist Sync" -Action $action -Trigger $trigger `
  -User $env:USERNAME -LogonType S4U
```

> **`-LogonType S4U` is the part that matters.** A task registered to run only when the
> user is logged on is *silently skipped* on every night nobody is logged in — no log, no
> error, no report. It looks identical to the sync failing, and it cost several missed
> nights to spot. S4U ("service for user") runs it whether or not anyone is signed in.

- Inspect / change it: Task Scheduler, or `Get-ScheduledTask "YouTube Playlist Sync"`.
- Run it on demand: `Start-ScheduledTask "YouTube Playlist Sync"` (or just run `run-sync.cmd`).
- The machine has to be awake at 3 AM. The task can be set to wake from sleep; it cannot
  power on a machine that is off.

### macOS

Two **LaunchDaemons** drive the shell wrappers [`run-sync.sh`](run-sync.sh) and
[`run-watchdog.sh`](run-watchdog.sh). Templates for both live in [`launchd/`](launchd/);
they carry placeholders for the repo path and the account to run as.

> **Daemons, not Agents — this is the macOS version of the `-LogonType S4U` lesson above.**
> A LaunchAgent runs only inside a logged-in GUI session, so on a shared machine where
> nobody is signed in at 3 AM it is skipped in silence: no log, no error, no report, and it
> looks exactly like the sync failing. A LaunchDaemon runs from boot regardless of who is
> logged in. The `UserName` key is what keeps that from meaning *run as root* — the job
> starts in the privileged system domain but executes as the named account, so `state/`,
> `logs/` and `.env` keep their ownership instead of collecting root-owned files. Note that
> `UserName` is honoured **only** in the system domain; it does nothing in an Agent.

Install both, from the repo root:

```sh
mkdir -p logs   # launchd opens StandardOutPath before exec — a missing dir fails the job

for job in sync watchdog; do
  sed -e "s|__REPO_DIR__|$PWD|g" -e "s|__RUN_AS_USER__|$(id -un)|g" \
    "launchd/local.youtube-playlists.$job.plist" > "/tmp/$job.plist"
  sudo install -o root -g wheel -m 644 "/tmp/$job.plist" \
    "/Library/LaunchDaemons/local.youtube-playlists.$job.plist"
  sudo launchctl bootstrap system "/Library/LaunchDaemons/local.youtube-playlists.$job.plist"
done
```

> Files in `/Library/LaunchDaemons` **must be owned by `root:wheel` with mode 644** or
> launchd refuses to load them — and it complains about the path's ownership, saying nothing
> about your job, which is a confusing way to learn this. `install -o root -g wheel -m 644`
> sets all three in one step.

- Check it loaded: `sudo launchctl print system/local.youtube-playlists.sync`
- Run it on demand: `sudo launchctl kickstart -k system/local.youtube-playlists.sync`
- Remove it: `sudo launchctl bootout system/local.youtube-playlists.sync`
- `launchctl load` / `unload` are the deprecated forms; `bootstrap` / `bootout` replace them.
- **Node is resolved inside the wrappers, not by the plists.** A daemon's `PATH` is
  `/usr/bin:/bin:/usr/sbin:/sbin`, and Homebrew installs node to `/opt/homebrew/bin` (Apple
  Silicon) or `/usr/local/bin` (Intel) — neither is on it. A wrapper that simply calls
  `node` therefore works every time you test it in a terminal and fails every night under
  launchd. Each wrapper tries `PATH` first, then both Homebrew locations, logs which binary
  it picked, and logs a `FATAL` line rather than dying quietly if it finds none.
- A Mac **asleep** at 3 AM still syncs — launchd runs a missed calendar interval at the next
  wake, coalescing several missed ones into a single run. A Mac that is **powered off** does
  not. `sudo pmset repeat wakeorpoweron MTWRFSU 02:55:00` is the analogue of the Windows
  wake-from-sleep checkbox.
- Keep the checkout out of `~/Desktop`, `~/Documents` and `~/Downloads`. Those are
  TCC-protected, and a daemon reading them needs Full Disk Access granted by hand.

#### Why a daemon, and not an Agent or cron

Reasonable question, since both alternatives avoid `sudo`. Three things are easy to conflate:

- **Running as you is not the root part.** `UserName` is launchd's equivalent of the Windows
  task's `-LogonType S4U`: the job runs as your account, and every file it writes is owned by
  you. Nothing at 3 AM runs as root.
- **`sudo` is install-time only.** `/Library/LaunchDaemons` is `root:wheel` and launchd
  refuses a plist there that isn't, so registering the job needs admin once. Running it never
  does.
- **The system domain is the part that needs admin, and it is needed for logged-out runs.**
  A LaunchAgent loads into `gui/<uid>`, created when the user logs in at the GUI — no login,
  no job. (`man launchctl` notes a `user/<uid>` domain "may exist independently of a
  logged-in user", so an agent there is not flatly impossible; what is untested is a reboot
  with nobody ever logging in, and being wrong about that means silently missed nights.)

**cron would work without admin** — `/usr/bin/crontab` is setuid, so you can install your own
crontab, and jobs run as you whether or not anyone is logged in. It is rejected for one
reason, and it is not the deprecation: **cron silently skips a job whose time passed while
the Mac was asleep.** launchd runs it at the next wake instead (§ `StartCalendarInterval` in
`man launchd.plist`), coalescing several missed intervals into one run. For a 3 AM job on a
machine that sleeps, cron turns a late run into a missed night with no record — the failure
this project already learned to design against. If you do prefer cron, pair it with
`sudo pmset repeat wakeorpoweron MTWRFSU 02:55:00` so the machine is genuinely awake, and
treat the watchdog as your only backstop.

### The watchdog

A scheduled task that never fires writes no log, so its failure is invisible to anything
that reads logs. Every completed sync therefore writes a heartbeat to
`state/last-run.json`, and a second task watches *that*:

```sh
npm run watchdog -- --dry-run     # check staleness, send nothing
npm run watchdog                  # email an alert if the sync has gone quiet
```

It emails `ERROR_ALERT_TO` when the last successful run is older than **36 hours** —
deliberately two missed nights, so one late run stays silent. `--max-age-hours=N` changes
the threshold. Register [`run-watchdog.cmd`](run-watchdog.cmd) (Windows) or
[`run-watchdog.sh`](run-watchdog.sh) (macOS) on its own trigger, the same way as above, at a
time when the sync has already had its chance to run — the macOS template uses **09:00**.
Its own trigger is the point: a watchdog sharing the sync's schedule is silent in exactly
the case it exists to catch.

## Email

Email is **optional**. The report is sent via the **Microsoft 365 Graph API**
(client-credentials flow). Credentials and recipients live in `.env` (git-ignored) — none of
them are hard-coded in the source. See [`.env.example`](.env.example):

```
MS365_TENANT_ID=...
MS365_CLIENT_ID=...
MS365_CLIENT_SECRET=...
MS365_FROM_ADDRESS=sender@example.com   # must be a real, licensed mailbox
REPORT_TO=reports@example.com           # gets progress reports
ERROR_ALERT_TO=operator@example.com     # gets failures + watched previews (defaults to REPORT_TO)
ACCOUNT_LABEL=                          # optional label in the report header
```

The app registration needs the **`Mail.Send`** *application* permission with admin consent.
`--email-on-change` (used by the scheduled task) only emails on runs that added videos, hit
quota, or errored.

Two things that cost time to discover:

> **The sender must be a real mailbox.** Graph rejects an address with nothing behind it —
> `404 "requested user ... is invalid"` — including a Google identity that merely shares the
> domain. Use a licensed M365 mailbox, or create a shared mailbox for the purpose.

> **Gmail is not an option** unless the playlist account genuinely has a Gmail mailbox. A
> Google identity created on a domain hosted by Microsoft 365 does not.

## Watched videos — delete once viewed

The workflow: **finish a video on the Apple TV, press Like on the remote.** The next sync
deletes it from the playlist and never puts it back.

### Why "Like" and not actual watch history

YouTube does not expose watch history. `relatedPlaylists.watchHistory` was deprecated in
2016, and on a current account the field is **absent entirely** — the response contains only
`likes` and `uploads`. Forcing the documented `HL` playlist id returns `0 items,
totalResults=0` **without an error**, so code built on it silently concludes you have
watched nothing, forever. `videos.getRating` works but reports like/dislike/none, which is
not the same question. There is no OAuth scope for history and no replacement endpoint.

So "Like" is used as a deliberate *I'm done with this* gesture — the one signal available
from a TV remote.

### Three signals, one ledger

A video counts as watched if **any** of these is true:

1. it was **liked** — read from the system `LL` playlist (one button on the TV remote), or
2. it was saved to a manually-created playlist named **`Watched`** on the same account
   (tvOS: *Save → Watched*; unambiguous, and no public like), or
3. it was in the channel playlist and is **no longer there** — i.e. removed by hand.

All three feed `state/<Channel>.json` (git-ignored), which is permanent: a later sync
re-adding a video does not erase the record, and neither does un-liking it or emptying the
`Watched` playlist.

The `Watched` playlist is **read-only** to the tool — it is never added to, removed from, or
deleted. Rename it with `--watched-playlist=NAME`.

> **A like is per-account, not per-playlist.** `LL` holds only the playlist account's own
> likes, and it is private. Another YouTube user liking the same video has no effect here.
> But *anyone signed into that account* liking a video in a managed playlist marks it
> watched — on a shared household account that includes someone who liked it because they
> enjoyed it, not because everyone finished it. The `Watched` playlist avoids that ambiguity.

**The ledger is load-bearing, not bookkeeping.** Without it, deleting a watched video just
means the next run sees it missing from the playlist and re-adds it — 50 units to delete,
50 to re-add, every night forever. The ledger is what makes the deletion stick.

### Usage

**Deleting watched videos is the default** — every run prunes them, including the nightly
task. Opting out is explicit, and no opt-out ever re-adds a video the ledger already knows
you watched.

```powershell
npm start                                 # detect + delete watched videos (the default)
npm start -- --report-watched             # detect + report; deletes nothing, adds run normally
npm start -- --ignore-watched             # skip detection entirely; deletes nothing
npm start -- --dry-run                    # preview only; no adds, no deletes
```

| Flag                | Meaning                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| *(none)*            | Delete watched videos and never re-add them. **This is the default.**       |
| `--report-watched`  | Detect and report watched videos. **Deletes nothing** and does not change what gets added. |
| `--ignore-watched`  | Skip the watched signals altogether (no Liked / "Watched" playlist reads). Deletes nothing. The ledger is still honoured, so previously-pruned videos stay gone. |
| `--prune-watched`   | Accepted but redundant — it asks for the default. Kept so existing callers keep working. |
| `--unlike`          | Also clear the like after deleting. **Costs another 50 units per video** — the ledger already remembers, so this is cosmetic (keeps the Liked list tidy). |
| `--max-removals=N`  | Delete at most N videos this run, across all channels.                      |
| `--watched-playlist=NAME` | Name of the manually-curated watched playlist. Default `Watched`. Missing playlist = signal simply unused. |

Note `--report-watched` differs from `--dry-run`: dry-run suppresses *everything* including
adds, so the nightly sync would stop working. Report mode only holds back the deletions.

The never-re-add guard is unconditional. It used to be tied to the delete flag, which meant
a flagless run would put back every video a previous prune had deleted, at 50 quota units
each; no flag combination does that now.

Removals run in **phase 1.5**, before inserts, so the day's quota clears the
watched pile before backfilling new videos.

### Email during the preview period

With `--email-on-change`, a run that detects watched videos emails the report to
`ERROR_ALERT_TO` (subject *"watched videos detected (preview)"*), not to `REPORT_TO` — the
report audience's mail stays reserved for real playlist progress. Quiet nights send nothing.

### Quota

`playlistItems.delete` costs 50 units, same as an insert — so ~200 deletions/day, drawn from
the same budget as adds. Adding `--unlike` costs another 50 each (`videos.rate` is a write),
halving that to ~100. Reading the like signal is ~1 unit per 50 likes, once per run.

### Things worth knowing

- **A like means "delete this."** If someone likes a video they want to *keep*, it gets
  removed. With `--unlike` the keep-signal is destroyed too.
- **Likes must be on the playlist-owning account.** Someone liking from their own account
  is invisible. (The same is true of the removal signal — editing those playlists already
  requires being on that account.)
- **`--dry-run` still updates the ledger.** It makes no YouTube changes, but watched
  detection cannot work without persisting state.
- **First run banks a baseline** and marks nothing watched; detection starts from the second
  run onward.
- **Emptying a whole playlist marks all of it watched.** Intended, but there's no undo short
  of editing the JSON.
- **Deleting and recreating a playlist resets its ledger** (the tool notices the playlist id
  changed), as does a playlist that does not exist yet — otherwise every video would be
  declared watched at once.
- **Videos the channel itself deletes are not counted** as watched; they could never be
  re-added anyway.
- The ledger is local to this machine and git-ignored. Deleting `state/` loses the watched
  history and re-baselines on the next run.

## Quota — important for large channels

Adding a video to a playlist costs **50 units**, and the default YouTube Data API quota
is **10,000 units/day** → roughly **200 video-adds per day**.

This tool only adds *missing* videos, so:

- A channel with fewer than ~200 videos syncs in one run.
- A bigger channel: run it once a day (or use `--max=180`); each run resumes where the
  last left off because it skips videos already in the playlist. When the daily quota is
  hit mid-run, the report flags it with ⚠ and you just rerun the next day.

You can request a higher quota from Google Cloud if needed.

---

## How it works

The run has two phases so the report is accurate even if inserts run out of quota:

**Phase 1 — status (reads only, all channels first):** for each channel, resolve the handle
→ channel + "uploads" playlist, list every uploaded video oldest → newest (skipping
deleted/private entries and videos below the channel's cutoff, then splitting Shorts off
from the rest), find the existing playlist, and compute what's missing. A channel is read
once here even when its line asks for two playlists — see
[Per-channel settings](#per-channel-settings).
This is cheap and captures a full status snapshot for *every* channel up front.

**Phase 1.5 — removals (writes):** delete the videos that should not be in the playlist,
before backfilling, so the day's quota clears the deletion pile first. Two unrelated reasons
land here: the video is watched, or it falls below the channel's `after=` cutoff. They share
one pass and one `--max-removals` ceiling, because they share the same daily write budget.

**Phase 2 — inserts (writes):** create the playlist if needed and add only the missing
videos, each at its correct chronological position, until quota runs out. Because status was
already captured in phase 1, a mid-way quota stop still leaves the report showing accurate
current counts for all channels (later channels are flagged "quota limit hit — will continue
on the next run").

**Playlist sort order must be "Manual".** Inserting a video at a position only works on a
manually-sorted playlist. If the sort order is changed in the YouTube UI (to "Date added",
"Most popular", …) YouTube rejects every positional insert with *"Playlist should use manual
sorting to support position."* — and the API has no field to set the order back. When that
happens the run appends the videos at the end instead (so it still makes progress) and the
report says the sort order needs restoring: open the playlist on YouTube, set **Sort → Manual**,
and the next run goes back to inserting in chronological position.

**Report:** write `report.html`, print a console summary, and (optionally) email — progress
to `REPORT_TO`, errors and watched-video previews to `ERROR_ALERT_TO`.

## Tests

```powershell
npm test
```

Uses Node's built-in test runner (`node --test`, no dependencies). Covers report building
and sorting, quota detection, duration parsing, and the positional-insert logic (with a
mocked YouTube client). `test/credentials.test.js` also verifies the real `.env` credentials
authenticate — it refreshes a Google OAuth token and acquires a Microsoft Graph token (OAuth
endpoints only; **no YouTube quota is consumed**). If a credential group is absent, that
check is skipped so the pure unit tests still pass.

### Lint

```powershell
npm run lint   # eslint .
```

### Pre-push hook (lint + tests)

A committed hook in `.githooks/pre-push` runs `npm run lint` then `npm test` and **blocks the
push if either fails**. Enable it once per clone:

```powershell
git config core.hooksPath .githooks
```

## Files

| Path                    | Purpose                                          |
| ----------------------- | ------------------------------------------------ |
| `src/index.js`          | CLI entry point + two-phase workflow             |
| `src/youtube.js`        | Channel resolve, uploads listing, playlist sync  |
| `src/email.js`          | Microsoft Graph report sender                     |
| `src/report.js`         | Shared HTML report builder                        |
| `src/seen.js`           | Watched-video ledger (removal = watched)          |
| `src/marker.js`         | Sync marker — which machine owns this account      |
| `state/*.json`          | Per-channel watched ledger — local, git-ignored   |
| `src/auth.js`           | Google OAuth2 (built from .env vars)             |
| `src/authorize.js`      | One-time browser authorization                   |
| `src/heartbeat.js`      | Writes/reads `state/last-run.json`; the staleness rule |
| `src/watchdog.js`       | Alerts when the sync stops running at all         |
| `run-sync.cmd`          | Windows scheduled-task wrapper for the nightly sync |
| `run-watchdog.cmd`      | Windows scheduled-task wrapper for the watchdog   |
| `run-sync.sh`           | macOS LaunchDaemon wrapper for the nightly sync   |
| `run-watchdog.sh`       | macOS LaunchDaemon wrapper for the watchdog       |
| `launchd/*.plist`       | macOS LaunchDaemon templates (repo path + user are placeholders) |
| `config/channels.example.txt` | Tracked template for the channel list       |
| `config/channels.txt`   | Your recurring channel list — git-ignored         |
| `.env`                  | All secrets (Google OAuth + Microsoft Graph) — git-ignored |
| `AGENTS.md`, `CLAUDE.md` | Project context and working rules for AI agents |
| `WORKLOG.md`, `VERSIONS.md` | What changed and why, and what shipped when |
| `features.yaml`         | Feature manifest — what exists, what is planned   |
| `docs/prompts/`         | Durable prompts describing the system             |
| `LICENSE`               | MIT license                                       |

## License

[MIT](LICENSE). Published as-is: this is a personal tool that solves one household
problem, not a supported product. Issues and pull requests are welcome but may sit —
forking is entirely reasonable.
