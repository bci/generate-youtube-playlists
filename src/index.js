import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { getAuthorizedClient } from './auth.js';
import {
  makeYouTube,
  readChannel,
  getPlaylistStatus,
  applyInserts,
  applyRemovals,
  getLikedVideoIds,
  getWatchedPlaylistIds,
  listMyPlaylists,
  createPlaylist,
  renamePlaylist,
} from './youtube.js';
import {
  machineKey,
  markerTitle,
  classifyMarker,
  checkClaimSync,
  conflictMessage,
} from './marker.js';
import { loadLedger, saveLedger } from './seen.js';
import { writeHeartbeat } from './heartbeat.js';
import { sendReport } from './email.js';
import { buildHtml, sortByChannel } from './report.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG = path.join(ROOT, 'config', 'channels.txt');
const REPORT_PATH = path.join(ROOT, 'report.html');
const STATE_DIR = path.join(ROOT, 'state');

// Load .env (Graph email credentials) if present.
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env — email will fail with a clear message if attempted.
}

// Recipients are deployment configuration, never hard-coded: this repo is public and
// the mailing list is not. ERROR_ALERT_TO separates operator noise (failures, watched
// previews) from the audience that only wants to hear about real playlist progress; it
// falls back to REPORT_TO when there is nobody separate to page.
const REPORT_TO = process.env.REPORT_TO;
const ERROR_ALERT_TO = process.env.ERROR_ALERT_TO || REPORT_TO;
// Optional label for the report header, e.g. the account that owns the playlists.
const ACCOUNT_LABEL = process.env.ACCOUNT_LABEL || '';
// The `shorts=` modes, in the order the docs introduce them. `split` is the only
// one that makes a channel line describe two playlists instead of one.
const SHORTS_MODES = ['no', 'yes', 'only', 'split'];
const REPORT_SUBJECT = 'YouTube Playlists — Update';
const ERROR_SUBJECT = 'YouTube Playlists — sync error';
const MARKER_SUBJECT = 'YouTube Playlists — another machine is syncing this account';
// Written into the marker playlist itself, because the person who finds an unexplained
// empty playlist on their account will look here before they look in a repo.
const MARKER_DESCRIPTION =
  'Marker left by generate-youtube-playlists so it can tell whether another machine is ' +
  'already syncing this account. Empty on purpose. Deleting it makes the next run claim ' +
  'the account again.';
const WATCHED_SUBJECT = 'YouTube Playlists — watched videos detected (preview)';

/**
 * A cap of 0 means "do none of this", so it cannot be folded into the unlimited
 * default. `parseInt(x, 10) || Infinity` did exactly that, which inverted the flag:
 * --max-removals=0, passed to hold removals back, authorised unlimited removals.
 */
function parseLimit(raw, flag) {
  const n = parseInt(raw, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  console.warn(`Ignoring unparseable limit: ${flag}`);
  return Infinity;
}

export function parseArgs(argv) {
  const opts = {
    channels: [],
    email: false,
    emailOnChange: false,
    dryRun: false,
    maxAdds: Infinity,
    ignoreWatched: false,
    reportWatched: false,
    unlike: false,
    maxRemovals: Infinity,
    watchedPlaylist: 'Watched',
    claimSync: false,
    after: null,
    older: null,
    shorts: null,
    config: DEFAULT_CONFIG,
  };
  for (const arg of argv) {
    if (arg === '--email') opts.email = true;
    else if (arg === '--email-on-change') opts.emailOnChange = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    // Pruning is the default; --prune-watched is still accepted so older callers
    // (run-sync.cmd, the scheduled task, anything in a shell history) keep working.
    else if (arg === '--prune-watched') opts.ignoreWatched = false;
    else if (arg === '--ignore-watched') opts.ignoreWatched = true;
    else if (arg === '--report-watched') opts.reportWatched = true;
    else if (arg === '--unlike') opts.unlike = true;
    else if (arg === '--claim-sync') opts.claimSync = true;
    else if (arg.startsWith('--max-removals='))
      opts.maxRemovals = parseLimit(arg.slice(15), arg);
    else if (arg.startsWith('--watched-playlist='))
      opts.watchedPlaylist = arg.slice(19);
    else if (arg.startsWith('--max=')) opts.maxAdds = parseLimit(arg.slice(6), arg);
    // Run-wide versions of the channel-list fields, for trying one out before
    // committing it to channels.txt. Each takes the same values as its field and
    // overrides the file, so `--dry-run` plus a flag answers "what would this do?"
    // without editing anything.
    else if (arg.startsWith('--after=')) opts.after = parseCutoff(arg.slice(8), arg);
    else if (arg.startsWith('--older=')) opts.older = parseOlder(arg.slice(8), arg);
    else if (arg.startsWith('--shorts=')) opts.shorts = parseShorts(arg.slice(9), arg);
    else if (arg.startsWith('--config=')) opts.config = arg.slice(9);
    else if (arg.startsWith('--')) console.warn(`Ignoring unknown flag: ${arg}`);
    else opts.channels.push(arg);
  }
  // Deleting watched videos is what the nightly wants, so it is the default: opting
  // out is explicit. --report-watched still detects and reports without deleting.
  opts.pruneWatched = !opts.ignoreWatched && !opts.reportWatched;
  return opts;
}

// Google error messages sometimes embed HTML (e.g. the quota link). Strip it.
function cleanErr(err) {
  const raw = err?.response?.data?.error?.message || err?.message || String(err);
  return raw.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * A channel's `after=` cutoff: date-only, UTC midnight, and inclusive of the day
 * named — `after=2026-01-01` keeps a video published on 1 January. A timestamp is
 * not accepted: YouTube publish times are UTC and a whole-day boundary is the only
 * one anyone reasons about here.
 *
 * Throws rather than warning-and-ignoring. The config is read once, before a single
 * quota unit is spent, and a typo that silently meant "no cutoff" would backfill a
 * whole back catalogue — or, worse, delete on the wrong side of a date.
 */
function parseCutoff(raw, context) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`after= needs a YYYY-MM-DD date, got "${raw}" in: ${context}`);
  }
  const d = new Date(`${raw}T00:00:00Z`);
  // Date rolls an impossible day over rather than rejecting it — 2026-02-30 parses
  // happily as 2026-03-02. Round-tripping is what catches that, and a cutoff two
  // days off the one that was written is exactly the wrong side of a deletion.
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) {
    throw new Error(`"${raw}" is not a real date, in: ${context}`);
  }
  return d;
}

/** `older=` accepts only these two, and says so naming what was actually written. */
function parseOlder(raw, context) {
  const value = String(raw).trim().toLowerCase();
  if (value !== 'keep' && value !== 'remove') {
    throw new Error(`older= needs keep or remove, got "${raw}" in: ${context}`);
  }
  return value;
}

/**
 * `shorts=` accepts only the four modes. Fatal on anything else for the same reason a
 * bad date is: a silently-ignored `shorts=split` leaves the second playlist
 * uncreated, which looks exactly like the tool having missed the channel's Shorts.
 */
function parseShorts(raw, context) {
  const value = String(raw).trim().toLowerCase();
  if (!SHORTS_MODES.includes(value)) {
    throw new Error(
      `shorts= needs one of ${SHORTS_MODES.join(', ')}, got "${raw}" in: ${context}`
    );
  }
  return value;
}

/**
 * Split a channel line into fields. Whitespace-separated, except that a value may be
 * double-quoted so a playlist title can contain spaces:
 *
 *     @Handle shorts=split shorts-title="Build Weird (Clips)"
 *
 * An unbalanced quote is fatal rather than being split into nonsense fields, because
 * the "Unrecognised field" it would otherwise produce names a fragment of the title
 * instead of the actual mistake.
 */
export function tokenizeChannelLine(line) {
  const text = String(line).trim();
  if ((text.match(/"/g) || []).length % 2 !== 0) {
    throw new Error(`Unbalanced " in channel line: ${text}`);
  }
  return text.match(/\S*"[^"]*"\S*|\S+/g) || [];
}

/** Strip the quotes a tokenized value may carry, and require something inside. */
function unquote(raw, key, line) {
  const value = /^"(.*)"$/.exec(raw)?.[1] ?? raw;
  if (!value.trim()) throw new Error(`${key}= needs a value, in channel line: ${line}`);
  return value.trim();
}

/**
 * Parse one channel line from config/channels.txt. Every field is `key=value`, and
 * they are order-independent:
 *
 *     @Handle                                   every video, no Shorts (the default)
 *     @Handle after=2026-01-01                  only videos published on/after that UTC day
 *     @Handle after=2026-01-01 older=remove     ...and delete older ones (the default)
 *     @Handle after=2026-01-01 older=keep       ...and leave older ones already there
 *     @Handle shorts=no                         exclude Shorts (the default)
 *     @Handle shorts=yes                        one playlist, Shorts mixed in
 *     @Handle shorts=only                       one playlist, Shorts only
 *     @Handle shorts=split                      TWO playlists: videos, and Shorts
 *     @Handle shorts=split shorts-title="..."   name the Shorts playlist yourself
 *
 * `shorts=split` is the reason a line can describe more than one playlist; see
 * targetsFor(). Its second playlist defaults to `<Name> (Shorts)`, while `shorts=only`
 * has no collision to avoid and so defaults to plain `<Name>` — either way
 * `shorts-title=` overrides whichever playlist holds the Shorts.
 *
 * `older=remove` is the default, because an `after=` date describes what the playlist
 * should hold, not merely what to add next. It is the expensive default: a delete costs
 * 50 quota units against a budget of roughly 200 writes a day, so dropping a cutoff
 * onto a long-standing playlist spends real budget over several nights, and the videos
 * do not come back if the date is later moved. `older=keep` gives the add-gating
 * without the deletions, and the report names the cutoff on every run.
 *
 * A malformed field throws. The config is read once, before a single quota unit is
 * spent, and every one of these settings has a silent-failure mode that looks like
 * something else: an ignored date backfills a back catalogue or deletes on the wrong
 * side of a line, and an ignored `shorts=` leaves a Shorts-only channel with the empty
 * playlist the field exists to fix.
 */
export function parseChannelSpec(line) {
  const [handle, ...fields] = tokenizeChannelLine(line);
  const spec = {
    handle,
    after: null,
    removeBefore: true,
    shorts: 'no',
    shortsTitle: null,
  };
  let sawOlder = false;
  for (const field of fields) {
    const kv = /^([A-Za-z-]+)=(.*)$/.exec(field);
    const key = kv?.[1]?.toLowerCase();
    if (key === 'after') {
      spec.after = parseCutoff(unquote(kv[2], 'after', line), line);
    } else if (key === 'older') {
      spec.removeBefore = parseOlder(unquote(kv[2], 'older', line), line) === 'remove';
      sawOlder = true;
    } else if (key === 'shorts') {
      spec.shorts = parseShorts(unquote(kv[2], 'shorts', line), line);
    } else if (key === 'shorts-title') {
      spec.shortsTitle = unquote(kv[2], 'shorts-title', line);
    } else {
      throw new Error(
        `Unrecognised field "${field}" in channel line: ${line}\n` +
          '  expected: @Handle [after=YYYY-MM-DD] [older=keep|remove]' +
          ' [shorts=no|yes|only|split] [shorts-title="..."]'
      );
    }
  }
  // older= says what to do about videos below the cutoff, so on its own it is not a
  // harmless no-op — it is a line whose author expected a date to be in effect.
  if (sawOlder && !spec.after) {
    throw new Error(`older= needs an after= date, in channel line: ${line}`);
  }
  // Likewise a Shorts title with no Shorts playlist to name: the author expected one.
  if (spec.shortsTitle && spec.shorts !== 'split' && spec.shorts !== 'only') {
    throw new Error(
      `shorts-title= needs shorts=split or shorts=only, in channel line: ${line}`
    );
  }
  return spec;
}

/**
 * The playlists one channel line asks for, in the order they should be worked.
 * All modes but `split` yield exactly one; `split` yields the videos playlist under
 * the channel's own name and the Shorts beside it under a suffixed one.
 *
 * `want` is what getPlaylistStatus() slices out of the single per-channel read, so
 * both targets of a split channel are diffed against one listing and one Shorts probe.
 */
export function targetsFor(spec, name) {
  switch (spec.shorts) {
    case 'split':
      return [
        { playlistTitle: name, want: 'videos' },
        { playlistTitle: spec.shortsTitle || `${name} (Shorts)`, want: 'shorts' },
      ];
    case 'only':
      // Nothing to collide with, so this channel's one playlist keeps its own name
      // unless the line asked for something else.
      return [{ playlistTitle: spec.shortsTitle || name, want: 'shorts' }];
    default:
      // shorts=no separated them and wants the videos half; shorts=yes never
      // separated them, so 'videos' is everything the channel uploaded.
      return [{ playlistTitle: name, want: 'videos' }];
  }
}

async function readChannelConfig(configPath) {
  let content;
  try {
    content = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    // A fresh clone has the template but not the list — say so rather than
    // surfacing a bare ENOENT from a path the reader has never heard of.
    throw new Error(
      `No channel list at ${configPath}. Copy config/channels.example.txt to ` +
        'config/channels.txt and add your handles, or pass a channel on the command line.',
      { cause: err }
    );
  }
  return content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map(parseChannelSpec);
}

/**
 * One console line per channel. The emailed report is deliberately just
 * added/removed/total, so the watched-ledger internals — how many videos are known
 * watched, how many are being held out of re-adds — surface here instead, where
 * whoever is debugging the nightly reads them.
 */
export function summaryLine(s) {
  // Liked, saved to the "Watched" playlist and removed-by-hand are three signals for
  // one thing; the running total is what matters, so show them as a single delta.
  const fresh = (s.justLiked || 0) + (s.justSaved || 0) + (s.justWatched || 0);
  return [
    `${s.videoCount ?? s.totalVideos}/${s.totalVideos} videos`,
    s.action,
    s.dryRun && s.toAdd ? `${s.toAdd} to add` : null,
    !s.dryRun && s.added ? `+${s.added}` : null,
    s.previewRemovals && s.toRemove?.length ? `${s.toRemove.length} WOULD REMOVE` : null,
    !s.previewRemovals && s.removed ? `-${s.removed} removed` : null,
    s.seenCount ? `${s.seenCount} watched${fresh ? ` (+${fresh})` : ''}` : null,
    s.wouldSkip ? `${s.wouldSkip} held out` : null,
    s.shortsExcluded
      ? `${s.shortsExcluded} shorts ${s.shortsSibling ? `-> ${s.shortsSibling}` : 'skipped'}`
      : null,
    s.shortsOnly ? 'shorts only' : null,
    s.shortsMixedIn ? 'shorts mixed in' : null,
    s.after ? `after ${s.after} (${s.outOfScope} older excluded)` : null,
    s.manualSortRequired ? 'SORT-NOT-MANUAL' : null,
    s.quotaHit ? 'QUOTA-HIT' : null,
  ]
    .filter(Boolean)
    .join('  ');
}

function printConsole(summaries, warning) {
  console.log('\n=== Summary ===');
  // Repeated at the end as well as where it was found: phase 1 scrolls a long way up
  // on a seven-playlist run, and this is the line that must not be missed.
  if (warning) console.log(`  ⚠️  ${warning}\n`);
  for (const s of sortByChannel(summaries)) {
    if (s.error) {
      console.log(`  ${s.handle.padEnd(20)}  ERROR: ${s.error}`);
      continue;
    }
    console.log(`  ${s.handle.padEnd(20)}  ${summaryLine(s)}`);
    if (s.url) console.log(`  ${''.padEnd(20)}  ${s.url}`);
  }
}

/**
 * Claim this account, or report that another machine already holds it.
 *
 * Runs in phase 1, before any write, and returns the warning to carry into the report
 * and the email — or null when there is nothing to say, which is every normal night.
 *
 * A conflict never stops the run. The marker can be wrong in ways that are nobody's
 * mistake (a machine retired without deleting its marker; a hostname changed by a new
 * network), and a guard that stops the nightly sync on a false positive would be this
 * project's own favourite failure mode, self-inflicted. It reports instead.
 */
export async function checkSyncMarker(youtube, opts) {
  const key = machineKey(os.hostname());
  const ourTitle = markerTitle(key);

  let playlists;
  try {
    playlists = await listMyPlaylists(youtube);
  } catch (err) {
    // The guard must never be the reason the sync fails.
    console.warn(`\n⚠️  Could not check the sync marker: ${cleanErr(err)}`);
    return null;
  }

  const found = classifyMarker(playlists, key);

  // The normal case, every night: our own claim, already there. Say nothing.
  if (found.state === 'ours') return null;

  if (found.state === 'none') {
    if (opts.dryRun) {
      console.log(`\n(--dry-run) Would claim this account as "${ourTitle}".`);
      return null;
    }
    try {
      await createPlaylist(youtube, ourTitle, MARKER_DESCRIPTION);
      console.log(`\nClaimed this account as "${ourTitle}".`);
    } catch (err) {
      // 50 units that did not land. Worth a line, not worth failing the run.
      console.warn(`\n⚠️  Could not create the sync marker: ${cleanErr(err)}`);
    }
    return null;
  }

  const message = conflictMessage(found);

  if (!opts.claimSync) {
    console.warn(`\n⚠️  ${message}`);
    return message;
  }

  if (opts.dryRun) {
    console.log(`\n(--dry-run) Would claim this account as "${ourTitle}".`);
    return message;
  }

  // Our marker is already there alongside someone else's, so there is nothing to
  // rename onto — two playlists would end up with the same title. Deleting the other
  // one is the user's call, and costs them nothing in the YouTube UI.
  if (found.ours) {
    console.warn(
      `\n⚠️  ${message}\n   --claim-sync cannot help here: "${ourTitle}" already exists. ` +
        'Delete the other marker playlist by hand.'
    );
    return message;
  }

  const [take, ...rest] = found.foreign;
  try {
    await renamePlaylist(youtube, take.id, ourTitle, MARKER_DESCRIPTION);
    console.log(`\n(--claim-sync) Took over "${take.title}" → "${ourTitle}".`);
  } catch (err) {
    console.warn(`\n⚠️  Could not claim the sync marker: ${cleanErr(err)}`);
    return message;
  }
  if (rest.length) {
    // Three or more machines. One rename per run, deliberately: claiming is the
    // expensive direction, and a loop of them is the thing this flag must not become.
    console.warn(
      `\n⚠️  ${rest.length} other marker(s) remain. Run --claim-sync again, or delete them by hand.`
    );
    return message;
  }
  return null;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // Before anything reaches the network: --claim-sync from a scheduled job is an
  // operator error, never an intention, so it stops here rather than being ignored
  // nightly for a year. A malformed channel setting is treated the same way.
  const claimRefusal = checkClaimSync(opts, Boolean(process.stdin.isTTY));
  if (claimRefusal) {
    console.error(`\n❌ ${claimRefusal}`);
    process.exit(1);
  }

  // A channel named on the command line has no config line, so --after= is the only
  // way to give it a cutoff; without one it means the whole channel, as it always did.
  let channels = opts.channels.map((handle) => ({
    handle,
    after: null,
    removeBefore: true,
    shorts: 'no',
    shortsTitle: null,
  }));
  if (channels.length === 0) {
    channels = await readChannelConfig(opts.config);
    if (channels.length === 0) {
      console.error(`No channels given and none found in ${opts.config}.`);
      process.exit(1);
    }
    console.log(`No channel argument — using ${channels.length} channel(s) from config.`);
  }
  // The flags win over the file, so an ad-hoc "just this window" run needs no edit,
  // and `--older=keep` can disarm a `remove` cutoff for one run without --dry-run.
  if (opts.after || opts.older || opts.shorts) {
    channels = channels.map((c) => ({
      ...c,
      after: opts.after || c.after,
      removeBefore: opts.older ? opts.older === 'remove' : c.removeBefore,
      shorts: opts.shorts || c.shorts,
    }));
  }

  const auth = await getAuthorizedClient();
  const youtube = makeYouTube(auth);

  // Before the channels: whose account is this? One list call, and it decides nothing
  // about what the run does — only what the report says at the end.
  const markerWarning = await checkSyncMarker(youtube, opts);

  // --report-watched detects and reports watched videos but deletes nothing and
  // leaves add behaviour alone; --prune-watched actually removes them.
  const watchedSignal = !opts.ignoreWatched;

  // The "Like" button is the watched signal: read the account's liked videos once
  // (1 unit per 50 likes) and let every channel intersect against it.
  let likedIds = new Set();
  let watchedIds = new Set();
  if (watchedSignal) {
    likedIds = await getLikedVideoIds(youtube);
    // Second signal: a manually-curated "Watched" playlist (read-only).
    const saved = await getWatchedPlaylistIds(youtube, opts.watchedPlaylist);
    watchedIds = saved.ids;
    console.log(
      `\nWatched signals: ${likedIds.size} liked video(s); ` +
        (saved.found
          ? `${watchedIds.size} in the "${opts.watchedPlaylist}" playlist`
          : `no "${opts.watchedPlaylist}" playlist found (create one to use that signal)`) +
        `${opts.pruneWatched ? '' : ' — report only, nothing will be deleted'}.`
    );
  }

  // PHASE 1 — read the current status of every playlist first (cheap), so the
  // report reflects all of them even if inserts later run out of quota.
  //
  // One read per channel, one status per playlist. A `shorts=split` line asks for two
  // playlists from one channel, and everything expensive here is charged per channel
  // rather than per playlist — the uploads listing, and above all the Shorts probe. So
  // readChannel() runs once and both targets are diffed against its result.
  console.log('\n== Phase 1: reading status of all channels ==');
  const summaries = [];
  for (const spec of channels) {
    const { handle, after, removeBefore } = spec;
    process.stdout.write(`\n[status] ${handle} ... `);
    let read;
    try {
      read = await readChannel(youtube, handle, {
        after,
        // shorts=yes is the one mode that puts everything in one playlist regardless,
        // so it is the one mode that can skip the probe entirely.
        classifyShorts: spec.shorts !== 'yes',
        onProgress: (msg) => process.stdout.write(`\n    ${handle}: ${msg} ...`),
      });
    } catch (err) {
      const msg = cleanErr(err);
      console.log(`FAILED: ${msg}`);
      // The whole line failed, so report it once rather than once per target.
      summaries.push({ handle, error: msg, totalVideos: 0, dryRun: opts.dryRun });
      continue;
    }

    const targets = targetsFor(spec, read.channel.name);
    if (targets.length > 1) console.log(`${targets.length} playlists`);
    for (const target of targets) {
      const label = targets.length > 1 ? `${handle} → ${target.playlistTitle}` : handle;
      if (targets.length > 1) process.stdout.write(`  [status] ${label} ... `);
      try {
        const s = await getPlaylistStatus(youtube, read, {
          ...target,
          getLedger: (title) => loadLedger(STATE_DIR, title),
          likedIds,
          watchedIds,
          // Always on: once a video is known watched, nothing re-adds it. Tying this
          // to the delete flag meant a flagless run would put back everything a
          // previous prune deleted, at 50 quota units each.
          honourSeen: true,
          after,
          removeBefore,
        });
        s.dryRun = opts.dryRun;
        // Removals are a preview unless pruning is actually switched on.
        s.previewRemovals = !opts.pruneWatched || opts.dryRun;
        // Where a split channel's Shorts went. Only the config knows there is a
        // sibling at all, so the report is told here rather than by getPlaylistStatus.
        if (target.want === 'videos' && targets.length > 1) {
          s.shortsSibling = targets.find((t) => t.want === 'shorts').playlistTitle;
        }
        console.log(
          `${s.alreadyPresent}/${s.totalVideos} in playlist, ${s.toAdd} to add` +
            (s.shortsExcluded
              ? `, ${s.shortsExcluded} shorts ${s.shortsSibling ? 'split off' : 'skipped'}`
              : '') +
            (s.shortsOnly ? ', shorts only' : '') +
            (s.shortsMixedIn ? ', shorts mixed in' : '') +
            (s.after ? `, after ${s.after} (${s.outOfScope} older excluded)` : '') +
            (s.toDrop?.length ? `, ${s.toDrop.length} to drop` : '')
        );
        summaries.push(s);
      } catch (err) {
        const msg = cleanErr(err);
        console.log(`FAILED: ${msg}`);
        summaries.push({
          handle,
          playlistTitle: target.playlistTitle,
          error: msg,
          totalVideos: 0,
          dryRun: opts.dryRun,
        });
      }
    }
  }

  // PHASE 2 — apply inserts until quota runs out. Status from phase 1 is preserved
  // for every channel regardless of how far the inserts get.
  if (opts.dryRun) {
    for (const s of summaries) {
      if (s.error) continue;
      const wouldChange = s.toAdd || s.toRemove?.length || s.toDrop?.length;
      s.action = !s.playlist ? 'would create' : wouldChange ? 'would update' : 'up to date';
    }
  } else {
    // PHASE 1.5 — delete before backfilling, so the day's quota clears the deletion
    // pile before spending anything on new videos.
    // Two unrelated reasons to delete, governed by different switches: the video is
    // watched (--ignore-watched / --report-watched opt out for the whole run) or it
    // predates the channel's `after=` cutoff (that channel's own keep/remove decides).
    // Both draw on the same ~200 writes a day, so they go through one pass under one
    // --max-removals ceiling rather than racing each other for the budget.
    const removalsFor = (s) => [
      ...(opts.pruneWatched ? s.toRemove || [] : []),
      ...(s.toDrop || []),
    ];
    if (summaries.some((s) => !s.error && removalsFor(s).length)) {
      console.log('\n== Phase 1.5: removing watched and out-of-scope videos ==');
      let removalBudget = opts.maxRemovals;
      for (const s of summaries) {
        const items = removalsFor(s);
        if (s.error || !items.length || removalBudget <= 0) continue;
        process.stdout.write(`\n[prune] ${s.handle} ... `);
        try {
          await applyRemovals(youtube, s, {
            items,
            maxRemovals: removalBudget,
            unlike: opts.unlike,
            onProgress: (msg) => process.stdout.write(`\n    ${s.handle}: ${msg} ...`),
          });
          removalBudget -= s.removed;
          console.log(`removed ${s.removed}${s.unliked ? `, unliked ${s.unliked}` : ''}${s.quotaHit ? ', quota hit' : ''}`);
        } catch (err) {
          s.error = cleanErr(err);
          console.log(`FAILED: ${s.error}`);
        }
      }
    }

    console.log('\n== Phase 2: adding videos ==');
    // Process smallest backlog first (using phase-1 status) so nearly-complete
    // channels finish before a large backfill consumes the day's quota. This makes
    // channels.txt order irrelevant to prioritization.
    const workOrder = [...summaries].sort(
      (a, b) => (a.toAdd ?? Infinity) - (b.toAdd ?? Infinity)
    );
    let quotaExhausted = false;
    for (const s of workOrder) {
      if (s.error) continue;
      if (s.toAdd === 0 && s.playlist) continue; // already up to date
      if (quotaExhausted) {
        s.quotaHit = true; // couldn't get to it this run
        continue;
      }
      process.stdout.write(`\n[sync] ${s.handle} ... `);
      try {
        await applyInserts(youtube, s, {
          maxAdds: opts.maxAdds,
          onProgress: (msg) => process.stdout.write(`\n    ${s.handle}: ${msg} ...`),
        });
        console.log(`${s.action} (+${s.added}${s.quotaHit ? ', quota hit' : ''})`);
        if (s.quotaHit) quotaExhausted = true;
      } catch (err) {
        s.error = cleanErr(err);
        console.log(`FAILED: ${s.error}`);
      }
    }
  }

  // Persist the watched ledger AFTER phase 2, so videos inserted this run count as
  // "known" — otherwise removing one of them later would look like it was never added.
  // A channel that errored during phase 1.5/2 still has an accurate existingIds set,
  // and skipping its save was how a single failing channel stopped banking watched
  // videos for days on end. Only a phase-1 failure (no ledger) has nothing to save.
  for (const s of summaries) {
    if (!s.ledger || !s.playlistId) continue;
    for (const id of s.existingIds) s.ledger.known.add(id);
    try {
      await saveLedger(STATE_DIR, s.playlistTitle, s.ledger);
    } catch (err) {
      console.error(`\n⚠️  Could not save watched ledger for ${s.handle}: ${cleanErr(err)}`);
    }
  }

  const html = buildHtml(summaries, {
    dryRun: opts.dryRun,
    account: ACCOUNT_LABEL,
    warning: markerWarning,
  });
  await fs.writeFile(REPORT_PATH, html);

  // Heartbeat for the watchdog (src/watchdog.js). A dry run is not a real run, so it
  // deliberately does not refresh this — otherwise testing by hand would mask an
  // otherwise-dead nightly.
  if (!opts.dryRun) {
    await writeHeartbeat(STATE_DIR, {
      finishedAt: new Date().toISOString(),
      channels: summaries.length,
      added: summaries.reduce((n, s) => n + (s.added || 0), 0),
      removed: summaries.reduce((n, s) => n + (s.removed || 0), 0),
      errors: summaries.filter((s) => s.error).length,
    });
  }
  printConsole(summaries, markerWarning);
  console.log(`\nHTML report written to: ${REPORT_PATH}`);

  if (opts.dryRun) {
    console.log('\n(--dry-run) Skipping email.');
  } else {
    const hasProgress = summaries.some((s) => s.added > 0 || s.removed > 0 || s.quotaHit);
    const hasError = summaries.some((s) => s.error);
    // A conflict that only reaches report.html is a warning nobody reads — the file
    // sits on a machine nobody logs into. It pages the operator like an error does.
    const hasConflict = Boolean(markerWarning);

    // The report audience hears about progress: always on --email, or on
    // --email-on-change when a run made real playlist progress (videos added, or
    // quota reached mid-fill).
    const emailReport = opts.email || (opts.emailOnChange && hasProgress);
    // Failures page the operator instead, on the unattended --email-on-change path,
    // and so does another machine syncing this account.
    const alertOperator = opts.emailOnChange && (hasError || hasConflict);
    // While removals are preview-only, the watched report goes to the operator
    // rather than the report audience, whose mail stays reserved for progress. An
    // error alert already carries the same report, so don't send twice.
    // Any newly-detected watched video is worth reporting, not just ones that are
    // still in the playlist — a video removed by hand leaves nothing to remove.
    const previewOperator =
      opts.emailOnChange &&
      !hasError &&
      !hasConflict &&
      summaries.some(
        (s) =>
          s.previewRemovals &&
          (s.toRemove?.length || s.justLiked || s.justSaved || s.justWatched)
      );

    // A configured recipient is the one precondition every send shares; checking it
    // once here beats three identical Graph failures in the log.
    if ((emailReport || alertOperator || previewOperator) && !REPORT_TO && !ERROR_ALERT_TO) {
      console.error(
        '\n❌ No email recipient configured — set REPORT_TO (and optionally ERROR_ALERT_TO) in .env.'
      );
      process.exitCode = 1;
      return;
    }

    if (emailReport) {
      try {
        const from = await sendReport({ to: REPORT_TO, subject: REPORT_SUBJECT, html });
        console.log(`\n📧 Report emailed from ${from} to ${REPORT_TO}.`);
      } catch (err) {
        console.error(`\n❌ Report email failed: ${cleanErr(err)}`);
        process.exitCode = 1;
      }
    }

    if (alertOperator) {
      try {
        const subject = hasError ? ERROR_SUBJECT : MARKER_SUBJECT;
        const from = await sendReport({ to: ERROR_ALERT_TO, subject, html });
        console.log(`\n⚠️  Alert emailed from ${from} to ${ERROR_ALERT_TO}.`);
      } catch (err) {
        console.error(`\n❌ Error-alert email failed: ${cleanErr(err)}`);
        process.exitCode = 1;
      }
    }

    if (previewOperator) {
      try {
        const from = await sendReport({
          to: ERROR_ALERT_TO,
          subject: WATCHED_SUBJECT,
          html,
        });
        console.log(`\n📧 Watched-video preview emailed from ${from} to ${ERROR_ALERT_TO}.`);
      } catch (err) {
        console.error(`\n❌ Watched-preview email failed: ${cleanErr(err)}`);
        process.exitCode = 1;
      }
    }

    if (!emailReport && !alertOperator && !previewOperator) {
      console.log(
        opts.emailOnChange
          ? '\n(--email-on-change) No changes this run — email skipped.'
          : `\n(Pass --email to send the report${REPORT_TO ? ` to ${REPORT_TO}` : ' — set REPORT_TO in .env first'}.)`
      );
    }
  }
}

// Only run the workflow when executed directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error('\nFatal error:', err.message || err);
    process.exit(1);
  });
}
