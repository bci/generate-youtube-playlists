import { google } from 'googleapis';
import { emptyLedger, updateLedger } from './seen.js';

export function makeYouTube(auth) {
  return google.youtube({ version: 'v3', auth });
}

/** True if an API error is a quota / rate-limit error. */
export function isQuotaError(err) {
  const reasons = err?.response?.data?.error?.errors?.map((e) => e.reason) || [];
  return reasons.some((r) =>
    ['quotaExceeded', 'dailyLimitExceeded', 'rateLimitExceeded', 'userRateLimitExceeded'].includes(r)
  );
}

/**
 * True if YouTube refused a positional insert because the playlist is not on
 * "Manual" sorting. Picking any other sort order in the YouTube UI ("Date added",
 * "Most popular", ...) makes every insert that carries a position fail.
 */
export function isManualSortError(err) {
  const reasons = err?.response?.data?.error?.errors?.map((e) => e.reason) || [];
  if (reasons.includes('manualSortRequired')) return true;
  const msg = err?.response?.data?.error?.message || err?.message || '';
  return /manual sorting/i.test(msg);
}

function normalizeHandle(raw) {
  const h = String(raw).trim().replace(/^@/, '');
  return { handle: h, display: `@${h}` };
}

/**
 * Resolve an @handle to its channel and uploads playlist.
 * Uses channels.list?forHandle (1 quota unit) with a search fallback (100 units).
 */
export async function resolveChannel(youtube, rawHandle) {
  const { handle, display } = normalizeHandle(rawHandle);

  let res = await youtube.channels.list({
    part: ['snippet', 'contentDetails'],
    forHandle: handle,
    maxResults: 1,
  });

  let item = res.data.items?.[0];

  if (!item) {
    // Fallback: search for the channel by handle text.
    const search = await youtube.search.list({
      part: ['snippet'],
      q: display,
      type: ['channel'],
      maxResults: 1,
    });
    const channelId = search.data.items?.[0]?.snippet?.channelId;
    if (channelId) {
      res = await youtube.channels.list({
        part: ['snippet', 'contentDetails'],
        id: [channelId],
        maxResults: 1,
      });
      item = res.data.items?.[0];
    }
  }

  if (!item) {
    throw new Error(`Could not find a YouTube channel for "${display}".`);
  }

  const uploads = item.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) {
    throw new Error(`Channel "${display}" has no uploads playlist (no public videos?).`);
  }

  return {
    id: item.id,
    title: item.snippet?.title || display,
    handle: display, // "@SomeChannel" — for display/reporting
    name: handle, // "SomeChannel" — used as the playlist title (no @)
    uploadsPlaylistId: uploads,
  };
}

/**
 * Get every uploaded video for a channel, sorted OLDEST -> NEWEST.
 * Skips private/deleted entries (which have no videoPublishedAt).
 */
export async function getAllUploads(youtube, uploadsPlaylistId) {
  const videos = [];
  let pageToken;
  do {
    const res = await youtube.playlistItems.list({
      part: ['snippet', 'contentDetails'],
      playlistId: uploadsPlaylistId,
      maxResults: 50,
      pageToken,
    });
    for (const it of res.data.items || []) {
      const videoId = it.contentDetails?.videoId;
      const publishedAt = it.contentDetails?.videoPublishedAt;
      if (!videoId || !publishedAt) continue; // deleted/private -> skip
      videos.push({ videoId, publishedAt, title: it.snippet?.title || videoId });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  videos.sort((a, b) => new Date(a.publishedAt) - new Date(b.publishedAt));
  return videos;
}

/** Find an existing playlist (owned by the account) by exact title, case-insensitive. */
export async function findPlaylistByTitle(youtube, title) {
  const target = title.trim().toLowerCase();
  let pageToken;
  do {
    const res = await youtube.playlists.list({
      part: ['snippet', 'contentDetails'],
      mine: true,
      maxResults: 50,
      pageToken,
    });
    for (const pl of res.data.items || []) {
      if ((pl.snippet?.title || '').trim().toLowerCase() === target) {
        return {
          id: pl.id,
          title: pl.snippet.title,
          itemCount: pl.contentDetails?.itemCount ?? null,
        };
      }
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return null;
}

/**
 * Every playlist on the account, id + title.
 *
 * 1 unit per page of 50, so effectively free — and the run already pays this several
 * times over, since findPlaylistByTitle pages the same list once per playlist looking
 * for an exact title. This exists because the sync marker is matched on a *prefix*,
 * which that early-returning exact-match search cannot answer.
 */
export async function listMyPlaylists(youtube) {
  const out = [];
  let pageToken;
  do {
    const res = await youtube.playlists.list({
      part: ['snippet'],
      mine: true,
      maxResults: 50,
      pageToken,
    });
    for (const pl of res.data.items || []) {
      out.push({ id: pl.id, title: pl.snippet?.title || '' });
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

/**
 * Rename a playlist (50 units). Used only to take over a sync marker.
 *
 * playlists.update replaces the snippet rather than patching it, so the description
 * has to be resent or it is cleared. That is safe here precisely because this is only
 * ever called on a marker, whose description this tool owns; do not reach for it to
 * rename a channel playlist without handling that.
 */
export async function renamePlaylist(youtube, playlistId, title, description) {
  const res = await youtube.playlists.update({
    part: ['snippet'],
    requestBody: { id: playlistId, snippet: { title, description } },
  });
  return { id: res.data.id, title: res.data.snippet.title };
}

export async function createPlaylist(youtube, title, description) {
  const res = await youtube.playlists.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: { title, description },
      status: { privacyStatus: 'private' },
    },
  });
  return { id: res.data.id, title: res.data.snippet.title, itemCount: 0 };
}

/**
 * Map of videoId -> playlistItemId for everything in a playlist.
 * The playlistItemId (not the videoId) is what playlistItems.delete needs.
 */
export async function getPlaylistItemMap(youtube, playlistId) {
  const items = new Map();
  let pageToken;
  do {
    const res = await youtube.playlistItems.list({
      part: ['contentDetails', 'id'],
      playlistId,
      maxResults: 50,
      pageToken,
    });
    for (const it of res.data.items || []) {
      const vid = it.contentDetails?.videoId;
      if (vid && !items.has(vid)) items.set(vid, it.id);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return items;
}

/**
 * The videoIds the account has liked, read from the system "LL" playlist.
 * One list call per 50 likes — cheaper than polling videos.getRating per playlist
 * item, and it scales with the number of likes rather than the playlist size.
 */
export async function getLikedVideoIds(youtube) {
  const ids = new Set();
  let pageToken;
  do {
    const res = await youtube.playlistItems.list({
      part: ['contentDetails'],
      playlistId: 'LL',
      maxResults: 50,
      pageToken,
    });
    for (const it of res.data.items || []) {
      const vid = it.contentDetails?.videoId;
      if (vid) ids.add(vid);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return ids;
}

/**
 * videoIds sitting in a manually-curated "Watched" playlist, found by title.
 * Read-only — the tool never writes to this playlist. Returns an empty set (and
 * found:false) when it doesn't exist, so a missing playlist is not an error.
 */
export async function getWatchedPlaylistIds(youtube, title) {
  const playlist = await findPlaylistByTitle(youtube, title);
  if (!playlist) return { ids: new Set(), found: false };
  const items = await getPlaylistItemMap(youtube, playlist.id);
  return { ids: new Set(items.keys()), found: true, playlistId: playlist.id };
}

export async function removeFromPlaylist(youtube, playlistItemId) {
  await youtube.playlistItems.delete({ id: playlistItemId });
}

/** Clear the like on a video (rating -> none). Costs 50 units, same as a delete. */
export async function clearRating(youtube, videoId) {
  await youtube.videos.rate({ id: videoId, rating: 'none' });
}

export async function addVideoToPlaylist(youtube, playlistId, videoId, position) {
  const snippet = {
    playlistId,
    resourceId: { kind: 'youtube#video', videoId },
  };
  // position places the item at a specific 0-based index (keeps oldest->newest order).
  if (Number.isInteger(position)) snippet.position = position;
  await youtube.playlistItems.insert({
    part: ['snippet'],
    requestBody: { snippet },
  });
}

// ---- Shorts detection -------------------------------------------------------
// A video longer than this cannot be a Short, so we skip the URL check for it.
const SHORT_MAX_SECONDS = 180;

export function parseISODuration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return 0;
  return (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
}

async function getDurations(youtube, ids) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const res = await youtube.videos.list({
      part: ['contentDetails'],
      id: chunk,
      maxResults: 50,
    });
    for (const it of res.data.items || []) {
      map.set(it.id, parseISODuration(it.contentDetails?.duration));
    }
  }
  return map;
}

// Authoritative Short check: /shorts/<id> stays (HTTP 200) for a real Short,
// but redirects (3xx) to /watch for a normal video.
async function isShortByUrl(videoId) {
  try {
    // Bounded: this runs 20-wide over every short-listed candidate, so one hung
    // socket would otherwise stall the whole run with no output.
    const r = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    return r.status === 200;
  } catch {
    return false; // on network error, don't drop the video
  }
}

// Retry a call on transient errors (network aborts, 5xx). Never retry when
// isFatal(err) is true (e.g. quota errors — retrying just wastes attempts).
export async function withRetry(fn, { retries = 4, baseDelayMs = 1000, isFatal } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (isFatal && isFatal(err)) throw err;
      attempt++;
      if (attempt > retries) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * attempt));
    }
  }
}

// Run async fn over items with bounded concurrency.
async function mapLimit(items, limit, fn) {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      await fn(items[cur], cur);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker())
  );
}

/**
 * Split a list of videos into `{ videos, shorts }`, preserving order in both.
 * Only videos <= SHORT_MAX_SECONDS trigger the URL check (done concurrently),
 * so long-form channels incur zero extra network calls and big channels stay fast.
 *
 * This used to return the non-Shorts plus a count and throw the Shorts themselves
 * away. `shorts=split` needs both halves, and the partition was already being
 * computed here — so the second playlist costs no extra reads or HEAD requests.
 */
export async function partitionShorts(youtube, videos, onProgress) {
  const durations = await getDurations(
    youtube,
    videos.map((v) => v.videoId)
  );
  const candidates = videos
    .filter((v) => {
      const secs = durations.get(v.videoId) ?? 0;
      return secs > 0 && secs <= SHORT_MAX_SECONDS;
    })
    .map((v) => v.videoId);

  const shortSet = new Set();
  let done = 0;
  await mapLimit(candidates, 20, async (id) => {
    if (await isShortByUrl(id)) shortSet.add(id);
    done++;
    if (onProgress && (done % 50 === 0 || done === candidates.length)) {
      onProgress(`checked ${done}/${candidates.length} short-candidates`);
    }
  });

  return {
    videos: videos.filter((v) => !shortSet.has(v.videoId)),
    shorts: videos.filter((v) => shortSet.has(v.videoId)),
  };
}

export function playlistUrl(playlistId) {
  return `https://www.youtube.com/playlist?list=${playlistId}`;
}

/**
 * A channel's `after=` cutoff rendered back as the YYYY-MM-DD it was written as.
 * The cutoff is a UTC midnight, so slicing the ISO string is exact, not a rounding.
 */
export function cutoffLabel(after) {
  return after ? after.toISOString().slice(0, 10) : null;
}

/**
 * PHASE 1, part one (reads only): read one channel.
 *
 * Split out from the per-playlist diff below because a channel can feed more than one
 * playlist — `shorts=split` gives it two — and everything here is charged per channel,
 * not per playlist: resolving the handle, listing every upload, and above all the
 * Shorts probe (a videos.list unit per 50 ids plus an HTTP HEAD per short-listed
 * candidate). Reading once and diffing twice is the whole point of the seam.
 *
 * Returns the channel plus its uploads already partitioned three ways:
 *   videos     in scope, not Shorts        (or everything, when classifyShorts is off)
 *   shorts     in scope, Shorts            (empty when classifyShorts is off)
 *   outOfScope below the `after=` cutoff, deliberately NOT classified — see below
 */
export async function readChannel(youtube, rawHandle, opts = {}) {
  const { after = null, classifyShorts = true, onProgress } = opts;
  const progress = typeof onProgress === 'function' ? onProgress : () => {};

  const channel = await resolveChannel(youtube, rawHandle);

  let uploads = await getAllUploads(youtube, channel.uploadsPlaylistId);
  progress(`${uploads.length} uploads found`);

  // The channel's `after=` cutoff is applied here, ahead of the Shorts probe, because
  // an out-of-scope video should cost nothing: the probe spends a videos.list unit per
  // 50 ids plus an HTTP HEAD per short-listed candidate, and a cutoff on an
  // 800-video channel exists precisely to stop paying for the back catalogue.
  //
  // That ordering leaves outOfScope unclassified — we never learn which of them are
  // Shorts. It does not matter: the only thing done with them is to delete the ones
  // found in a given playlist, and playlist membership already tells the two targets
  // of a split channel apart better than a Short/video label would.
  const outOfScope = [];
  if (after) {
    const cutoff = after.getTime();
    const inScope = [];
    for (const v of uploads) {
      if (new Date(v.publishedAt).getTime() >= cutoff) inScope.push(v);
      else outOfScope.push(v);
    }
    uploads = inScope;
    progress(`${outOfScope.length} published before ${cutoffLabel(after)} are out of scope`);
  }

  // Shorts are separated by default: a channel's Shorts are usually clips of its real
  // videos, and a playlist meant to be watched through does not want them mixed in.
  // `shorts=yes` is the one mode that needs no partition — everything goes into one
  // playlist regardless — so it skips the probe's cost entirely.
  const split = classifyShorts
    ? await partitionShorts(youtube, uploads, progress)
    : { videos: uploads, shorts: [] };

  return { channel, videos: split.videos, shorts: split.shorts, outOfScope, classifyShorts };
}

/**
 * PHASE 1, part two (reads only): diff one playlist against what it should hold.
 *
 * Takes a readChannel() result, so two playlists fed by the same channel share one
 * read. `want` picks which half of that read this playlist is for:
 *
 *   'videos'  the non-Shorts half — or everything, if the read did not classify
 *   'shorts'  the Shorts half
 *
 * Does NOT write anything, so calling this for every playlist first captures an
 * accurate status snapshot before any (quota-hungry) inserts run.
 * Returns a status object carrying both report fields and the data phase 2 needs.
 */
export async function getPlaylistStatus(youtube, read, opts = {}) {
  const {
    playlistTitle = read.channel.name,
    want = 'videos',
    getLedger,
    likedIds = new Set(),
    watchedIds = new Set(),
    honourSeen = false,
    after = null,
    removeBefore = true,
  } = opts;

  const { channel, outOfScope } = read;
  const uploads = want === 'shorts' ? read.shorts : read.videos;
  // Only meaningful on a videos playlist that actually ran the probe: it is the count
  // this playlist does not hold because they are Shorts. On a Shorts playlist they are
  // the contents, and with shorts=yes nothing was separated at all.
  const shortsExcluded =
    want === 'videos' && read.classifyShorts ? read.shorts.length : 0;

  const playlist = await findPlaylistByTitle(youtube, playlistTitle);
  let playlistItems = new Map();
  if (playlist) playlistItems = await getPlaylistItemMap(youtube, playlist.id);
  const existingIds = new Set(playlistItems.keys());

  let missing = uploads.filter((v) => !existingIds.has(v.videoId));

  // Out-of-scope videos already sitting in the playlist. `remove` (the default for a
  // channel carrying a cutoff) queues them for deletion; `keep` leaves them alone and
  // the date then only gates new adds. Tagged `outOfScope` so applyRemovals can tell
  // the two deletion reasons apart: a cutoff delete is not a watch.
  const outOfScopeIds = new Set(outOfScope.map((v) => v.videoId));
  const toDrop = removeBefore
    ? outOfScope
        .filter((v) => playlistItems.has(v.videoId))
        .map((v) => ({
          videoId: v.videoId,
          title: v.title,
          playlistItemId: playlistItems.get(v.videoId),
          // --unlike retires a spent watch signal. A cutoff delete is not one, so it
          // never spends the extra 50 units on clearing a rating.
          liked: false,
          outOfScope: true,
        }))
    : [];

  // Watched-video tracking (see src/seen.js). Two signals feed one ledger:
  //   - the video was removed from the playlist by hand
  //   - the video was liked (the Apple TV "Like" button), passed in as likedIds
  let ledger = emptyLedger();
  let newlyRemoved = new Set();
  let ledgerReset = false;
  if (getLedger) {
    const update = updateLedger(await getLedger(playlistTitle), {
      playlistId: playlist?.id || null,
      currentIds: existingIds,
    });
    ({ ledger, newlyRemoved } = update);
    ledgerReset = update.reset;
  }

  // A video the channel itself deleted also vanishes from the playlist; it isn't
  // "watched" and could never be re-added, so only count videos still uploaded.
  const uploadIds = new Set(uploads.map((v) => v.videoId));
  const stillUploaded = (id) => uploadIds.has(id);

  // Videos of THIS channel that were liked, or saved to the "Watched" playlist,
  // are watched. Banked into the ledger so the record survives the optional
  // un-like cleanup — and so it holds even if the source list is later edited.
  const justLiked = [];
  const justSaved = [];
  for (const v of uploads) {
    if (ledger.seen.has(v.videoId)) continue;
    if (likedIds.has(v.videoId)) {
      ledger.seen.add(v.videoId);
      justLiked.push(v.videoId);
    } else if (watchedIds.has(v.videoId)) {
      ledger.seen.add(v.videoId);
      justSaved.push(v.videoId);
    }
  }

  // Watched videos still sitting in the playlist are the deletion candidates.
  const toRemove = uploads
    .filter((v) => ledger.seen.has(v.videoId) && playlistItems.has(v.videoId))
    .map((v) => ({
      videoId: v.videoId,
      title: v.title,
      playlistItemId: playlistItems.get(v.videoId),
      liked: likedIds.has(v.videoId),
    }));

  // Never re-add a watched video. Without this the nightly run would put back
  // everything we just deleted, at 50 units each, forever.
  const wouldSkip = missing.filter((v) => ledger.seen.has(v.videoId)).length;
  if (honourSeen) missing = missing.filter((v) => !ledger.seen.has(v.videoId));

  return {
    playlistItems,
    toRemove,
    toDrop,
    outOfScopeIds, // applyInserts needs these to place inserts below the cutoff
    after: cutoffLabel(after),
    outOfScope: outOfScope.length,
    // Standing context for the report, not per-run counts. `want` also tells
    // applyInserts which kind of playlist to describe when it creates one.
    want,
    shortsOnly: want === 'shorts',
    shortsMixedIn: want === 'videos' && !read.classifyShorts,
    justLiked: justLiked.length,
    justSaved: justSaved.length,
    removed: 0,
    unliked: 0,
    handle: channel.handle,
    channelTitle: channel.title,
    playlistTitle,
    // data for phase 2
    channel,
    uploads,
    playlist, // {id,title,itemCount} or null
    existingIds,
    missing, // ordered oldest->newest
    ledger, // updated in memory; index.js persists it after phase 2
    // report fields
    playlistId: playlist?.id || null,
    url: playlist ? playlistUrl(playlist.id) : null,
    totalVideos: uploads.length,
    shortsExcluded,
    alreadyPresent: existingIds.size,
    toAdd: missing.length,
    ledgerReset,
    // removals noticed on this run
    justWatched: [...newlyRemoved].filter(stillUploaded).length,
    // every watched video we know of that is still on the channel
    seenCount: [...ledger.seen].filter(stillUploaded).length,
    wouldSkip,
    added: 0,
    videoCount: existingIds.size, // updated by phase 2 as videos are added
    action: playlist ? (missing.length ? 'needs update' : 'up to date') : 'will create',
    quotaHit: false,
    error: null,
  };
}

/**
 * PHASE 1.5 (writes): delete videos from the playlist.
 *
 * Runs before inserts so a freed-up playlist is reported accurately, and so the
 * day's quota goes to clearing deletions before backfilling new ones.
 *
 * `items` says what to delete, because there are two unrelated reasons to: the video
 * is watched (status.toRemove, already in ledger.seen so phase 2 will not re-add it)
 * or it predates the channel's `after=` cutoff (status.toDrop, excluded from
 * status.uploads so phase 2 never sees it). The caller decides which apply — they are
 * governed by different flags — and passes one combined list, so a single
 * maxRemovals ceiling covers the day's whole write budget.
 */
export async function applyRemovals(youtube, status, opts = {}) {
  const { items = status.toRemove, maxRemovals = Infinity, unlike = false, onProgress } = opts;
  const progress = typeof onProgress === 'function' ? onProgress : () => {};

  for (const item of items) {
    if (status.removed >= maxRemovals) break;
    try {
      await withRetry(() => removeFromPlaylist(youtube, item.playlistItemId), {
        isFatal: isQuotaError,
      });
      status.existingIds.delete(item.videoId);
      status.playlistItems.delete(item.videoId);
      status.removed++;

      // A cutoff delete is not a watch. Forgetting the id keeps next run's
      // updateLedger from reading its absence from the playlist as "removed by hand",
      // which would bank it as watched — and then holding it out for good if the
      // cutoff were ever lifted. Nothing re-adds it while the cutoff stands, because
      // it is not in status.uploads at all.
      if (item.outOfScope) status.ledger?.known.delete(item.videoId);

      // Optional tidy-up: drop the like now that it has done its job. Purely
      // cosmetic — the ledger is what remembers — and it costs another 50 units.
      if (unlike && item.liked) {
        try {
          await withRetry(() => clearRating(youtube, item.videoId), { isFatal: isQuotaError });
          status.unliked++;
        } catch (err) {
          if (isQuotaError(err)) {
            status.quotaHit = true;
            break;
          }
          // Clearing the like is cosmetic — the ledger is what remembers — so a
          // failure here must not abandon the deletions still queued behind it.
          progress(`could not clear the like on ${item.videoId}: ${err?.message || err}`);
        }
      }
      if (status.removed % 25 === 0) progress(`removed ${status.removed}/${items.length}`);
    } catch (err) {
      if (isQuotaError(err)) {
        status.quotaHit = true;
        break;
      }
      throw err;
    }
  }

  status.videoCount = status.existingIds.size;
  return status;
}

/**
 * PHASE 2 (writes): create the playlist if needed and insert missing videos in
 * chronological position, up to maxAdds or until quota runs out. Mutates and
 * returns the status object from getPlaylistStatus.
 */
export async function applyInserts(youtube, status, opts = {}) {
  const { maxAdds = Infinity, onProgress } = opts;
  const progress = typeof onProgress === 'function' ? onProgress : () => {};

  const existedBefore = !!status.playlist;

  if (status.missing.length === 0 && existedBefore) {
    status.action = 'up to date';
    return status;
  }

  if (!existedBefore) {
    // A split channel creates two playlists whose titles differ by a suffix, so the
    // description is the only thing telling them apart in YouTube's own UI.
    const kind = status.want === 'shorts' ? 'Shorts' : 'videos';
    const window = status.after ? ` published on or after ${status.after},` : '';
    const playlist = await createPlaylist(
      youtube,
      status.playlistTitle,
      `Auto-generated playlist of all ${kind} from ${status.channel.handle} ` +
        `(${status.channelTitle}),${window} oldest to newest.`
    );
    status.playlist = playlist;
    status.playlistId = playlist.id;
    status.url = playlistUrl(playlist.id);
    status.existingIds = new Set();
  }

  // Only ever insert what phase 1 put in `missing` — that list has already had the
  // watched-video ledger applied. Walking `uploads` minus `existingIds` instead would
  // re-add everything phase 1.5 just pruned, because applyRemovals drops those ids
  // from existingIds. That is the delete/re-add loop the ledger exists to prevent.
  const insertable = new Set(status.missing.map((v) => v.videoId));

  // Walk the full target list oldest->newest, tracking the position within the
  // playlist itself (`pos`), which skips over watched videos that are permanently
  // absent. Inserting at `pos` keeps the playlist strictly chronological instead of
  // dumping late videos at the bottom.
  //
  // Positional inserts require the playlist to be on "Manual" sorting. The first
  // refusal switches this run to plain appends, so a playlist whose sort order was
  // changed by hand costs one rejected call, not one per video.
  let usePosition = true;
  const insertFatal = (err) => isQuotaError(err) || isManualSortError(err);

  // Videos below the channel's `after=` cutoff that are still in the playlist — a
  // `keep` channel, or a `remove` channel whose deletions have not all landed yet —
  // sit above every in-scope video, because the cutoff is a date and the playlist is
  // oldest -> newest. The walk below only counts videos it finds in status.uploads,
  // which the cutoff has already emptied of them, so it has to start past them:
  // from 0, every new video would be inserted at the top of the playlist instead.
  let pos = 0;
  if (status.outOfScopeIds?.size) {
    for (const id of status.existingIds) if (status.outOfScopeIds.has(id)) pos++;
  }
  for (let i = 0; i < status.uploads.length; i++) {
    const v = status.uploads[i];
    if (status.existingIds.has(v.videoId)) {
      pos++;
      continue;
    }
    if (!insertable.has(v.videoId)) continue; // watched — never re-add
    if (status.added >= maxAdds) break;
    try {
      try {
        await withRetry(
          () =>
            addVideoToPlaylist(
              youtube,
              status.playlist.id,
              v.videoId,
              usePosition ? pos : undefined
            ),
          { isFatal: insertFatal }
        );
      } catch (err) {
        if (!usePosition || !isManualSortError(err)) throw err;
        // The playlist's sort order was changed away from "Manual" in the YouTube UI.
        // Nothing here can change it back — the API exposes no ordering field — so
        // append instead: adding the videos out of order beats adding none, and the
        // report asks for the sort order to be restored.
        usePosition = false;
        status.manualSortRequired = true;
        await withRetry(() => addVideoToPlaylist(youtube, status.playlist.id, v.videoId), {
          isFatal: insertFatal,
        });
      }
      status.existingIds.add(v.videoId);
      status.added++;
      pos++;
      if (status.added % 25 === 0) progress(`added ${status.added}/${status.missing.length}`);
    } catch (err) {
      if (isQuotaError(err)) {
        status.quotaHit = true;
        break;
      }
      throw err;
    }
  }

  status.videoCount = status.existingIds.size;
  status.action = !existedBefore ? 'created' : status.added > 0 ? 'updated' : 'up to date';
  return status;
}
