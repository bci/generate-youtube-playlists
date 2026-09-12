import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyRemovals,
  applyInserts,
  readChannel,
  getPlaylistStatus,
} from '../src/youtube.js';
import { parseArgs, summaryLine } from '../src/index.js';
import { buildHtml } from '../src/report.js';

function mockYoutube({ quotaAfterDeletes = Infinity } = {}) {
  const deleted = [];
  const rated = [];
  return {
    deleted,
    rated,
    playlistItems: {
      delete: async ({ id }) => {
        if (deleted.length >= quotaAfterDeletes) {
          const e = new Error('quota');
          e.response = { data: { error: { errors: [{ reason: 'quotaExceeded' }] } } };
          throw e;
        }
        deleted.push(id);
        return { data: {} };
      },
    },
    videos: {
      rate: async ({ id, rating }) => {
        rated.push([id, rating]);
        return { data: {} };
      },
    },
  };
}

function makeStatus() {
  const toRemove = [
    { videoId: 'a', title: 'a', playlistItemId: 'ITEM_A', liked: true },
    { videoId: 'b', title: 'b', playlistItemId: 'ITEM_B', liked: true },
  ];
  return {
    toRemove,
    existingIds: new Set(['a', 'b', 'c']),
    playlistItems: new Map([
      ['a', 'ITEM_A'],
      ['b', 'ITEM_B'],
      ['c', 'ITEM_C'],
    ]),
    removed: 0,
    unliked: 0,
    quotaHit: false,
  };
}

test('applyRemovals deletes watched videos by playlistItemId', async () => {
  const yt = mockYoutube();
  const st = makeStatus();
  await applyRemovals(yt, st, {});
  assert.deepEqual(yt.deleted, ['ITEM_A', 'ITEM_B']);
  assert.equal(st.removed, 2);
  assert.deepEqual([...st.existingIds], ['c'], 'removed videos leave the playlist set');
  assert.equal(st.videoCount, 1);
});

test('applyRemovals leaves likes alone by default', async () => {
  const yt = mockYoutube();
  await applyRemovals(yt, makeStatus(), {});
  assert.deepEqual(yt.rated, [], 'un-liking costs 50 units each, so it must be opt-in');
});

test('applyRemovals clears ratings when unlike is on', async () => {
  const yt = mockYoutube();
  const st = makeStatus();
  await applyRemovals(yt, st, { unlike: true });
  assert.deepEqual(yt.rated, [
    ['a', 'none'],
    ['b', 'none'],
  ]);
  assert.equal(st.unliked, 2);
});

test('applyRemovals respects maxRemovals', async () => {
  const yt = mockYoutube();
  const st = makeStatus();
  await applyRemovals(yt, st, { maxRemovals: 1 });
  assert.equal(st.removed, 1);
  assert.deepEqual(yt.deleted, ['ITEM_A']);
});

test('applyRemovals stops and flags quota', async () => {
  const yt = mockYoutube({ quotaAfterDeletes: 1 });
  const st = makeStatus();
  await applyRemovals(yt, st, {});
  assert.equal(st.removed, 1);
  assert.equal(st.quotaHit, true);
});

test('applyRemovals is a no-op when nothing is watched', async () => {
  const yt = mockYoutube();
  const st = makeStatus();
  st.toRemove = [];
  await applyRemovals(yt, st, {});
  assert.equal(st.removed, 0);
  assert.deepEqual(yt.deleted, []);
});

test('parseArgs handles the prune flags', () => {
  const o = parseArgs(['--prune-watched', '--unlike', '--max-removals=20']);
  assert.equal(o.pruneWatched, true);
  assert.equal(o.unlike, true);
  assert.equal(o.maxRemovals, 20);

  const d = parseArgs([]);
  assert.equal(d.pruneWatched, true, 'pruning is the default');
  assert.equal(d.ignoreWatched, false);
  assert.equal(d.reportWatched, false);
  assert.equal(d.unlike, false, 'unliking still costs 50 units, so it stays opt-in');
  assert.equal(d.maxRemovals, Infinity);
});

test('--ignore-watched opts out of detecting and deleting', () => {
  const o = parseArgs(['--ignore-watched']);
  assert.equal(o.ignoreWatched, true);
  assert.equal(o.pruneWatched, false, 'nothing may be deleted');
});

test('--prune-watched is still accepted, since old callers pass it', () => {
  // run-sync.cmd, the scheduled task and shell history all carry the old flag.
  assert.equal(parseArgs(['--prune-watched']).pruneWatched, true);
  // Later flags still win, so an explicit opt-out is not overridden by habit.
  assert.equal(parseArgs(['--prune-watched', '--ignore-watched']).pruneWatched, false);
});

test('--report-watched is not --prune-watched', () => {
  const o = parseArgs(['--report-watched']);
  assert.equal(o.reportWatched, true);
  assert.equal(o.pruneWatched, false, 'report mode must never enable deletion');
  assert.equal(o.dryRun, false, 'report mode must still let adds run');
});

const reportRow = (over) => ({
  handle: '@A',
  playlistTitle: 'A',
  url: 'https://example.test/pl',
  totalVideos: 10,
  videoCount: 10,
  action: 'up to date',
  ...over,
});

test('report mode phrases removals as a preview, not as done', () => {
  const html = buildHtml([
    reportRow({ previewRemovals: true, toRemove: [{ videoId: 'a' }, { videoId: 'b' }], removed: 0 }),
  ]);
  assert.match(html, /2 would remove/);
  assert.doesNotMatch(html, /−2/, 'preview must not claim anything was deleted');
});

test('prune mode reports what was actually removed', () => {
  const html = buildHtml([
    reportRow({ previewRemovals: false, toRemove: [{ videoId: 'a' }], removed: 1 }),
  ]);
  assert.match(html, /−1/);
  assert.doesNotMatch(html, /would remove/);
});

test('both watched signals reach the console total, not the emailed report', () => {
  // Liked and saved-to-"Watched" used to be spelled out as separate phrases in the
  // report; they are one number now, and the breakdown lives on the status object.
  const row = reportRow({ previewRemovals: true, justLiked: 1, justSaved: 2, seenCount: 9 });
  assert.match(summaryLine(row), /9 watched \(\+3\)/);

  const html = buildHtml([row]);
  assert.doesNotMatch(html, /newly liked/);
  assert.doesNotMatch(html, /newly saved to Watched/);
});

test('parseArgs defaults the Watched playlist name and allows an override', () => {
  assert.equal(parseArgs([]).watchedPlaylist, 'Watched');
  assert.equal(parseArgs(['--watched-playlist=Seen It']).watchedPlaylist, 'Seen It');
});

test('the nightly command line prunes watched videos but never unlikes', () => {
  // Mirrors run-sync.cmd, which no longer passes a watched flag at all — pruning is
  // the default. --unlike must stay off: the like is the signal, and dropping it
  // costs another 50 quota units per video.
  const o = parseArgs(['--email-on-change']);
  assert.equal(o.pruneWatched, true);
  assert.equal(o.reportWatched, false);
  assert.equal(o.unlike, false);
  assert.equal(o.dryRun, false);
});

test('--report-watched still detects without deleting', () => {
  // The documented way back to preview mode, so it has to keep working.
  const o = parseArgs(['--email-on-change', '--report-watched']);
  assert.equal(o.reportWatched, true);
  assert.equal(o.pruneWatched, false);
});

// Regression: prune followed by insert must not re-add the pruned videos.
// applyRemovals drops pruned ids from existingIds, so an insert loop keyed only on
// "in uploads but not in existingIds" would put every one of them straight back.
test('applyInserts never re-adds videos that applyRemovals just pruned', async () => {
  const inserted = [];
  const youtube = {
    playlistItems: {
      delete: async () => ({ data: {} }),
      insert: async ({ requestBody }) => {
        inserted.push([
          requestBody.snippet.resourceId.videoId,
          requestBody.snippet.position,
        ]);
        return { data: {} };
      },
    },
  };

  const uploads = [
    { videoId: 'a', title: 'a' }, // watched -> pruned
    { videoId: 'b', title: 'b' }, // stays
    { videoId: 'c', title: 'c' }, // watched -> pruned
    { videoId: 'd', title: 'd' }, // genuinely new -> the only legal insert
  ];

  const status = {
    channel: { handle: '@x' },
    playlist: { id: 'PL1' },
    playlistTitle: 'x',
    uploads,
    existingIds: new Set(['a', 'b', 'c']),
    playlistItems: new Map([
      ['a', 'ITEM_A'],
      ['b', 'ITEM_B'],
      ['c', 'ITEM_C'],
    ]),
    // phase 1 already applied the ledger: only 'd' is insertable
    missing: [{ videoId: 'd', title: 'd' }],
    toRemove: [
      { videoId: 'a', title: 'a', playlistItemId: 'ITEM_A', liked: true },
      { videoId: 'c', title: 'c', playlistItemId: 'ITEM_C', liked: true },
    ],
    removed: 0,
    added: 0,
    unliked: 0,
    quotaHit: false,
  };

  await applyRemovals(youtube, status);
  assert.equal(status.removed, 2);

  await applyInserts(youtube, status);

  assert.deepEqual(
    inserted.map(([id]) => id),
    ['d'],
    'only the genuinely-new video may be inserted'
  );
  assert.equal(status.added, 1);
  // 'b' is the sole survivor ahead of 'd', so 'd' belongs at position 1, not 3.
  assert.equal(inserted[0][1], 1, 'insert position skips permanently-absent watched videos');
});

/**
 * Minimal YouTube stub for the phase-1 reads: one channel with two uploads, one of
 * which is already in the playlist. `classifyShorts: false` keeps the duration
 * lookup and the Shorts URL probe (real HTTP) out of the test.
 */
function stubYouTube({ uploads, inPlaylist }) {
  return {
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
                items: uploads.map((id) => ({
                  contentDetails: { videoId: id, videoPublishedAt: '2020-01-01T00:00:00Z' },
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
    },
  };
}

test('a watched video is never queued for re-adding, whatever the flags say', async () => {
  // The guard used to be wired to the delete flag (honourSeen: opts.pruneWatched), so a
  // run without --prune-watched would put back everything a previous prune deleted, at
  // 50 quota units each. getPlaylistStatus must hold it back unconditionally now.
  const youtube = stubYouTube({ uploads: ['watched', 'fresh'], inPlaylist: [] });
  const ledger = { playlistId: 'PL1', known: new Set(['watched']), seen: new Set(['watched']) };

  const read = await readChannel(youtube, '@Chan', { classifyShorts: false });
  const status = await getPlaylistStatus(youtube, read, {
    getLedger: async () => ledger,
    honourSeen: true,
  });

  assert.deepEqual(
    status.missing.map((v) => v.videoId),
    ['fresh'],
    'the watched video must not be queued'
  );
  assert.equal(status.wouldSkip, 1, 'and it is reported as held back');
});

test('parseArgs never yields a combination that turns the re-add guard off', () => {
  // index.js passes honourSeen: true unconditionally; this pins the flag surface that
  // used to control it, so reintroducing an opt-out fails here.
  for (const argv of [[], ['--report-watched'], ['--ignore-watched'], ['--dry-run']]) {
    const o = parseArgs(argv);
    assert.equal('honourSeen' in o, false, `${argv.join(' ') || '(no flags)'} must not expose one`);
  }
});

test('a limit of 0 means none, not unlimited', () => {
  // `parseInt(x, 10) || Infinity` turned --max-removals=0 — passed to hold removals
  // back — into permission to remove without limit. Same for --max=0 and adds.
  assert.equal(parseArgs(['--max-removals=0']).maxRemovals, 0);
  assert.equal(parseArgs(['--max=0']).maxAdds, 0);
  // Unparseable still falls back to unlimited, and says so.
  assert.equal(parseArgs(['--max=abc']).maxAdds, Infinity);
  assert.equal(parseArgs([]).maxAdds, Infinity);
  assert.equal(parseArgs([]).maxRemovals, Infinity);
});

test('a failed un-like does not abandon the remaining deletions', async () => {
  const yt = mockYoutube();
  // Clearing a like is cosmetic — the ledger is the real record — so a failure
  // there must not cost the deletions queued behind it.
  yt.videos.rate = async () => {
    throw new Error('rate limit on the ratings endpoint');
  };
  const st = makeStatus();
  await applyRemovals(yt, st, { unlike: true });
  assert.deepEqual(yt.deleted, ['ITEM_A', 'ITEM_B'], 'both videos still deleted');
  assert.equal(st.removed, 2);
  assert.equal(st.unliked, 0);
  assert.equal(st.quotaHit, false);
});
