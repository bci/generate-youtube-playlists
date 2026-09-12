import test from 'node:test';
import assert from 'node:assert/strict';
import { parseChannelSpec, parseArgs, summaryLine } from '../src/index.js';
import {
  cutoffLabel,
  readChannel,
  getPlaylistStatus,
  applyRemovals,
  applyInserts,
} from '../src/youtube.js';
import { removedCell, statusNote, buildHtml } from '../src/report.js';

// ---- parsing a channel line -------------------------------------------------

test('a bare handle means the whole channel, as it always did', () => {
  assert.deepEqual(parseChannelSpec('@Chan'), {
    handle: '@Chan',
    after: null,
    removeBefore: true,
    shorts: 'no',
    shortsTitle: null,
  });
});

test('after= sets a UTC-midnight cutoff', () => {
  const spec = parseChannelSpec('@Chan after=2026-01-01');
  assert.equal(spec.after.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(cutoffLabel(spec.after), '2026-01-01');
});

test('older=remove is the default, older=keep opts out of the deletions', () => {
  assert.equal(parseChannelSpec('@Chan after=2026-01-01').removeBefore, true);
  assert.equal(parseChannelSpec('@Chan after=2026-01-01 older=remove').removeBefore, true);
  assert.equal(parseChannelSpec('@Chan after=2026-01-01 older=keep').removeBefore, false);
});

test('the field names and values are case-insensitive', () => {
  // Written by hand in a text file, so After=/Older=KEEP all have to land.
  assert.equal(cutoffLabel(parseChannelSpec('@Chan After=2026-06-15').after), '2026-06-15');
  assert.equal(parseChannelSpec('@Chan after=2026-06-15 OLDER=Keep').removeBefore, false);
  assert.equal(parseChannelSpec('@Chan after=2026-06-15 older=REMOVE').removeBefore, true);
});

test('extra whitespace between the fields is fine', () => {
  const spec = parseChannelSpec('@Chan   after=2026-01-01    older=keep');
  assert.equal(cutoffLabel(spec.after), '2026-01-01');
  assert.equal(spec.removeBefore, false);
});

test('a malformed line throws instead of silently meaning "no cutoff"', () => {
  // The whole point of failing loudly: `older=remove` is the default, so a typo that
  // fell back to "no cutoff" would either backfill a back catalogue or delete on the
  // wrong side of a date — and the config is read before a quota unit is spent.
  assert.throws(() => parseChannelSpec('@Chan after=01/01/2026'), /YYYY-MM-DD/);
  assert.throws(() => parseChannelSpec('@Chan after=2026-1-1'), /YYYY-MM-DD/);
  assert.throws(() => parseChannelSpec('@Chan after=2026-02-30'), /not a real date/);
  assert.throws(() => parseChannelSpec('@Chan after=2026-13-01'), /not a real date/);
  assert.throws(() => parseChannelSpec('@Chan after='), /needs a value/);
  assert.throws(() => parseChannelSpec('@Chan since=2026-01-01'), /Unrecognised field/);
  assert.throws(() => parseChannelSpec('@Chan older=maybe'), /needs keep or remove/);
  // older= on its own is a line whose author expected a date to be in effect.
  assert.throws(() => parseChannelSpec('@Chan older=keep'), /needs an after= date/);
});

// ---- the flags --------------------------------------------------------------

test('--after= and --older= default to off', () => {
  const o = parseArgs([]);
  assert.equal(o.after, null);
  assert.equal(o.older, null);
});

test('--after= parses to the same cutoff a config line would give', () => {
  const o = parseArgs(['@Chan', '--after=2026-01-01']);
  assert.equal(cutoffLabel(o.after), '2026-01-01');
  assert.deepEqual(o.channels, ['@Chan']);
  assert.equal(parseArgs(['--older=keep']).older, 'keep');
});

test('a bad --after= or --older= is fatal, not a warning', () => {
  assert.throws(() => parseArgs(['--after=yesterday']), /YYYY-MM-DD/);
  assert.throws(() => parseArgs(['--older=nope']), /needs keep or remove/);
});

// ---- what falls in and out of scope -----------------------------------------

/**
 * classifyShorts: false keeps the duration lookup and the Shorts URL probe (real
 * HTTP) out of these tests — the cutoff is what is under test, not the partition.
 */
function stubYouTube({ uploads, inPlaylist }) {
  const deleted = [];
  const inserted = [];
  return {
    deleted,
    inserted,
    channels: {
      list: async () => ({
        data: {
          items: [
            {
              id: 'UC1',
              snippet: { title: 'Chan' },
              contentDetails: { relatedPlaylists: { uploads: 'UU1' } },
            },
          ],
        },
      }),
    },
    playlists: {
      list: async () => ({ data: { items: [{ id: 'PL1', snippet: { title: 'Chan' } }] } }),
    },
    playlistItems: {
      list: async ({ playlistId }) =>
        playlistId === 'UU1'
          ? {
              data: {
                items: uploads.map(([id, publishedAt]) => ({
                  contentDetails: { videoId: id, videoPublishedAt: publishedAt },
                  snippet: { title: id },
                })),
              },
            }
          : {
              data: {
                items: inPlaylist.map((id) => ({
                  id: `item-${id}`,
                  contentDetails: { videoId: id },
                })),
              },
            },
      delete: async ({ id }) => {
        deleted.push(id);
        return { data: {} };
      },
      insert: async ({ requestBody }) => {
        inserted.push([
          requestBody.snippet.resourceId.videoId,
          requestBody.snippet.position,
        ]);
        return { data: {} };
      },
    },
  };
}

const UPLOADS = [
  ['old1', '2019-05-01T00:00:00Z'],
  ['old2', '2025-12-31T23:59:59Z'], // one second short of the cutoff
  ['edge', '2026-01-01T00:00:00Z'], // exactly the cutoff — inclusive, so in scope
  ['new1', '2026-03-01T00:00:00Z'],
];
const CUTOFF = new Date('2026-01-01T00:00:00Z');

/** One channel, one playlist, with the cutoff applied. Returns [status, client]. */
async function statusFor(over = {}) {
  const yt = stubYouTube({ uploads: UPLOADS, inPlaylist: ['old1', 'old2', 'edge'] });
  const opts = { after: CUTOFF, classifyShorts: false, ...over };
  const read = await readChannel(yt, '@Chan', opts);
  return [await getPlaylistStatus(yt, read, opts), yt];
}

test('the cutoff day itself is in scope, the second before it is not', async () => {
  const [s] = await statusFor();
  assert.deepEqual(
    s.uploads.map((v) => v.videoId),
    ['edge', 'new1'],
    'inclusive of the named day, exclusive of everything before it'
  );
  assert.equal(s.totalVideos, 2);
  assert.equal(s.outOfScope, 2);
  assert.equal(s.after, '2026-01-01');
});

test('an out-of-scope video is never queued for adding', async () => {
  const [s] = await statusFor();
  assert.deepEqual(
    s.missing.map((v) => v.videoId),
    ['new1']
  );
});

test('remove queues the out-of-scope videos that are actually in the playlist', async () => {
  const [s] = await statusFor();
  // old1 and old2 are in the playlist; nothing else out of scope is.
  assert.deepEqual(
    s.toDrop.map((d) => d.videoId),
    ['old1', 'old2']
  );
  assert.deepEqual(
    s.toDrop.map((d) => d.playlistItemId),
    ['item-old1', 'item-old2']
  );
  assert.equal(
    s.toDrop.every((d) => d.outOfScope === true),
    true,
    'tagged, so applyRemovals can tell a cutoff delete from a watch'
  );
  assert.equal(
    s.toDrop.some((d) => d.liked),
    false,
    '--unlike retires a spent watch signal; a cutoff delete is not one'
  );
});

test('older=keep queues nothing for deletion', async () => {
  const [s] = await statusFor({ removeBefore: false });
  assert.deepEqual(s.toDrop, []);
  assert.deepEqual(
    s.missing.map((v) => v.videoId),
    ['new1'],
    'the date still gates adds'
  );
});

test('no cutoff means the whole channel, and no drops', async () => {
  const [s] = await statusFor({ after: null });
  assert.equal(s.totalVideos, 4);
  assert.equal(s.outOfScope, 0);
  assert.equal(s.after, null);
  assert.deepEqual(s.toDrop, []);
  assert.deepEqual(
    s.missing.map((v) => v.videoId),
    ['new1']
  );
});

test('a cutoff does not turn out-of-scope videos into watched ones', async () => {
  // They are absent from the playlist by policy, not because anyone watched them.
  // Counting them would inflate seenCount and fire the watched-preview email.
  const [s] = await statusFor({
    getLedger: async () => ({ playlistId: 'PL1', known: new Set(), seen: new Set() }),
  });
  assert.equal(s.seenCount, 0);
  assert.equal(s.justWatched, 0);
  assert.equal(s.toRemove.length, 0);
});

// ---- the deletions ----------------------------------------------------------

test('a cutoff delete is forgotten by the ledger, not banked as a watch', async () => {
  // If it stayed in ledger.known, next run would see it missing from the playlist,
  // call it "removed by hand" -> watched, and then hold it out for good if the
  // cutoff were ever lifted. Nothing re-adds it while the cutoff stands anyway.
  const yt = stubYouTube({ uploads: UPLOADS, inPlaylist: [] });
  const st = {
    existingIds: new Set(['old1', 'watched1']),
    playlistItems: new Map(),
    ledger: {
      playlistId: 'PL1',
      known: new Set(['old1', 'watched1']),
      seen: new Set(['watched1']),
    },
    removed: 0,
    unliked: 0,
    quotaHit: false,
  };
  await applyRemovals(yt, st, {
    items: [
      { videoId: 'watched1', playlistItemId: 'item-watched1', liked: true },
      { videoId: 'old1', playlistItemId: 'item-old1', outOfScope: true },
    ],
  });
  assert.equal(st.removed, 2);
  assert.equal(st.ledger.known.has('old1'), false, 'the cutoff delete is forgotten');
  assert.equal(st.ledger.known.has('watched1'), true, 'the watched one is still remembered');
  assert.equal(st.ledger.seen.has('old1'), false, 'and it is not a watch');
});

test('one maxRemovals ceiling covers both reasons to delete', async () => {
  // Watched deletes and cutoff deletes come out of the same ~200 writes a day, so a
  // shared list under a shared ceiling is the only way --max-removals=1 means one.
  const yt = stubYouTube({ uploads: UPLOADS, inPlaylist: [] });
  const st = {
    existingIds: new Set(['a', 'b']),
    playlistItems: new Map(),
    removed: 0,
    unliked: 0,
    quotaHit: false,
  };
  await applyRemovals(yt, st, {
    items: [
      { videoId: 'a', playlistItemId: 'item-a', liked: true },
      { videoId: 'b', playlistItemId: 'item-b', outOfScope: true },
    ],
    maxRemovals: 1,
  });
  assert.equal(st.removed, 1);
  assert.deepEqual(yt.deleted, ['item-a']);
});

// ---- the inserts ------------------------------------------------------------

test('older=keep does not push new videos above the videos it kept', async () => {
  // applyInserts derives each position by walking status.uploads, which the cutoff
  // has emptied of the old videos. Starting that walk at 0 would insert new1 at
  // position 0 — above the two 2019/2025 videos still sitting at the top.
  const [st, yt] = await statusFor({ removeBefore: false });
  await applyInserts(yt, st, {});
  assert.deepEqual(yt.inserted, [['new1', 3]], 'after old1, old2 and edge');
});

test('with older=remove, the position closes up as the old videos go', async () => {
  const [st, yt] = await statusFor();
  await applyRemovals(yt, st, { items: st.toDrop });
  await applyInserts(yt, st, {});
  assert.deepEqual(yt.deleted, ['item-old1', 'item-old2']);
  assert.deepEqual(yt.inserted, [['new1', 1]], 'only "edge" is left above it');
});

test('a cutoff whose deletions ran out of quota still places inserts correctly', async () => {
  // Half-deleted is the normal state of a fresh cutoff on a long playlist: 50 units
  // a video means it takes several nights. The position has to track what is
  // actually still there, not what the config wishes were gone.
  const [st, yt] = await statusFor();
  await applyRemovals(yt, st, { items: st.toDrop, maxRemovals: 1 });
  await applyInserts(yt, st, {});
  assert.deepEqual(yt.inserted, [['new1', 2]], 'one straggler plus "edge"');
});

// ---- reporting --------------------------------------------------------------

test('the report names the cutoff, so a shrunken total reads as a setting', () => {
  const note = statusNote({ action: 'updated', after: '2026-01-01', outOfScope: 712 });
  assert.match(note, /only videos after 2026-01-01/);
  assert.match(note, /712 older excluded/);
  assert.equal(statusNote({ action: 'updated' }), 'updated', 'silent without a cutoff');
});

test('the console line names the cutoff too', () => {
  const line = summaryLine({
    totalVideos: 20,
    videoCount: 20,
    action: 'up to date',
    after: '2026-01-01',
    outOfScope: 712,
  });
  assert.match(line, /after 2026-01-01 \(712 older excluded\)/);
});

test('a dry run counts both reasons to remove', () => {
  assert.equal(removedCell({ dryRun: true, toRemove: [1], toDrop: [1, 2] }), '3 to remove');
});

test('a real run can delete for the cutoff while only previewing the watched ones', () => {
  // --ignore-watched / --report-watched suppress the watched deletions, but a
  // channel's older= setting is its own decision, so both can be live at once.
  assert.equal(
    removedCell({ previewRemovals: true, toRemove: [1, 2], toDrop: [1], removed: 1 }),
    '−1, 2 would remove'
  );
  // And the pre-existing single-reason cases still read the same.
  assert.equal(removedCell({ previewRemovals: true, toRemove: [1, 2] }), '2 would remove');
  assert.equal(removedCell({ previewRemovals: false, toDrop: [1], removed: 1 }), '−1');
  assert.equal(removedCell({ removed: 0 }), '—');
});

test('the report footnote appears only when a cutoff is in play', () => {
  const row = (over) => ({
    handle: '@A',
    playlistTitle: 'A',
    totalVideos: 2,
    videoCount: 2,
    action: 'up to date',
    ...over,
  });
  assert.match(buildHtml([row({ after: '2026-01-01' })], {}), /only videos after/);
  assert.doesNotMatch(buildHtml([row({})], {}), /only videos after/);
});
