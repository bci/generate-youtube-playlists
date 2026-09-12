import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isQuotaError,
  isManualSortError,
  playlistUrl,
  parseISODuration,
  applyInserts,
} from '../src/youtube.js';

test('parseISODuration parses ISO 8601 durations to seconds', () => {
  assert.equal(parseISODuration('PT1M'), 60);
  assert.equal(parseISODuration('PT59S'), 59);
  assert.equal(parseISODuration('PT1H2M3S'), 3723);
  assert.equal(parseISODuration('PT3M'), 180);
  assert.equal(parseISODuration(''), 0);
  assert.equal(parseISODuration(undefined), 0);
});

test('isQuotaError detects quota / rate-limit reasons', () => {
  const mk = (reason) => ({ response: { data: { error: { errors: [{ reason }] } } } });
  assert.equal(isQuotaError(mk('quotaExceeded')), true);
  assert.equal(isQuotaError(mk('rateLimitExceeded')), true);
  assert.equal(isQuotaError(mk('dailyLimitExceeded')), true);
  assert.equal(isQuotaError(mk('notFound')), false);
  assert.equal(isQuotaError(new Error('boom')), false);
});

test('playlistUrl builds a playlist URL', () => {
  assert.equal(playlistUrl('PL123'), 'https://www.youtube.com/playlist?list=PL123');
});

// ---- applyInserts (core insert logic) with a mock YouTube client ----

function mockYoutube({ quotaAfter = Infinity } = {}) {
  const inserts = [];
  let count = 0;
  return {
    inserts,
    playlistItems: {
      insert: async ({ requestBody }) => {
        count++;
        if (count > quotaAfter) {
          const e = new Error('quota');
          e.response = { data: { error: { errors: [{ reason: 'quotaExceeded' }] } } };
          throw e;
        }
        inserts.push(requestBody.snippet);
        return { data: {} };
      },
    },
    playlists: {
      insert: async () => ({ data: { id: 'NEWPL', snippet: { title: 'new' } } }),
    },
  };
}

function makeStatus() {
  const uploads = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({
    videoId: id,
    publishedAt: `2020-01-0${i + 1}`,
    title: id,
  }));
  const existingIds = new Set(['a', 'b', 'd']); // missing: c (idx 2), e (idx 4)
  return {
    playlist: { id: 'PL' },
    uploads,
    existingIds,
    missing: uploads.filter((v) => !existingIds.has(v.videoId)),
    added: 0,
    quotaHit: false,
    playlistTitle: 'test',
    channel: { handle: '@test' },
    channelTitle: 'test',
  };
}

test('applyInserts adds only missing videos at chronological positions', async () => {
  const yt = mockYoutube();
  const st = makeStatus();
  await applyInserts(yt, st, {});
  assert.equal(st.added, 2);
  assert.deepEqual(yt.inserts.map((s) => s.resourceId.videoId), ['c', 'e']);
  assert.deepEqual(yt.inserts.map((s) => s.position), [2, 4]);
  assert.equal(st.action, 'updated');
});

test('applyInserts stops and flags quota on quota error', async () => {
  const yt = mockYoutube({ quotaAfter: 1 });
  const st = makeStatus();
  await applyInserts(yt, st, {});
  assert.equal(st.added, 1);
  assert.equal(st.quotaHit, true);
});

test('applyInserts marks up-to-date when nothing is missing', async () => {
  const yt = mockYoutube();
  const uploads = [{ videoId: 'a', publishedAt: '2020', title: 'a' }];
  const st = {
    playlist: { id: 'PL' },
    uploads,
    existingIds: new Set(['a']),
    missing: [],
    added: 0,
    quotaHit: false,
    playlistTitle: 'test',
    channel: { handle: '@test' },
    channelTitle: 'test',
  };
  await applyInserts(yt, st, {});
  assert.equal(st.added, 0);
  assert.equal(st.action, 'up to date');
  assert.equal(yt.inserts.length, 0);
});

test('applyInserts creates the playlist when it does not exist', async () => {
  const yt = mockYoutube();
  const uploads = ['a', 'b'].map((id, i) => ({ videoId: id, publishedAt: `2020-0${i + 1}`, title: id }));
  const st = {
    playlist: null,
    uploads,
    existingIds: new Set(),
    missing: uploads.slice(),
    added: 0,
    quotaHit: false,
    playlistTitle: 'NewPl',
    channel: { handle: '@n' },
    channelTitle: 'n',
  };
  await applyInserts(yt, st, {});
  assert.equal(st.action, 'created');
  assert.equal(st.added, 2);
  assert.equal(st.playlistId, 'NEWPL');
});

test('applyInserts respects maxAdds', async () => {
  const yt = mockYoutube();
  const st = makeStatus(); // 2 missing
  await applyInserts(yt, st, { maxAdds: 1 });
  assert.equal(st.added, 1);
});

// ---- playlists whose sort order was changed away from "Manual" ---------------

test('isManualSortError spots a refused positional insert', () => {
  const byReason = { response: { data: { error: { errors: [{ reason: 'manualSortRequired' }] } } } };
  const byMessage = {
    response: {
      data: { error: { message: 'Playlist should use manual sorting to support position.' } },
    },
  };
  assert.equal(isManualSortError(byReason), true);
  assert.equal(isManualSortError(byMessage), true);
  assert.equal(isManualSortError({ response: { data: { error: { errors: [{ reason: 'quotaExceeded' }] } } } }), false);
  assert.equal(isManualSortError(new Error('boom')), false);
});

// Rejects any insert carrying a position, exactly as YouTube does once the playlist
// is sorted by anything other than "Manual".
function mockUnsortedYoutube() {
  const inserts = [];
  let refused = 0;
  return {
    inserts,
    refusedCount: () => refused,
    playlistItems: {
      insert: async ({ requestBody }) => {
        if (requestBody.snippet.position !== undefined) {
          refused++;
          const e = new Error('manual sort');
          e.response = {
            data: {
              error: {
                errors: [{ reason: 'manualSortRequired' }],
                message: 'Playlist should use manual sorting to support position.',
              },
            },
          };
          throw e;
        }
        inserts.push(requestBody.snippet);
        return { data: {} };
      },
    },
  };
}

test('applyInserts appends (and flags) when the playlist is not manually sorted', async () => {
  const yt = mockUnsortedYoutube();
  const st = makeStatus();
  await applyInserts(yt, st, {});
  assert.equal(st.added, 2, 'the run still adds every missing video');
  assert.equal(st.manualSortRequired, true, 'flagged so the report can ask for a fix');
  assert.deepEqual(yt.inserts.map((s) => s.resourceId.videoId), ['c', 'e']);
  assert.deepEqual(yt.inserts.map((s) => s.position), [undefined, undefined]);
  assert.equal(yt.refusedCount(), 1, 'only the first video pays for a refused positional call');
  assert.equal(st.action, 'updated');
  assert.equal(st.quotaHit, false);
});
