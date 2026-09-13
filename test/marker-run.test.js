import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import { checkSyncMarker } from '../src/index.js';
import { machineKey, markerTitle } from '../src/marker.js';

// The branch selection in checkSyncMarker, against a mocked client — the live account
// covers the rename path, but the create path only fires on a first run or after
// someone deletes the marker, and testing that for real costs 100 units to exercise
// three lines. Mocking is also how every other YouTube test here works.

const OUR_TITLE = markerTitle(machineKey(os.hostname()));

function fakeYouTube(titles) {
  const calls = { insert: [], update: [] };
  return {
    calls,
    playlists: {
      list: async () => ({
        data: { items: titles.map((t, i) => ({ id: `PL${i}`, snippet: { title: t } })) },
      }),
      insert: async (params) => {
        calls.insert.push(params);
        return { data: { id: 'PLnew', snippet: { title: params.requestBody.snippet.title } } };
      },
      update: async (params) => {
        calls.update.push(params);
        return { data: { id: params.requestBody.id, snippet: params.requestBody.snippet } };
      },
    },
  };
}

test('an unclaimed account is claimed, once, with a private playlist', async () => {
  const yt = fakeYouTube(['Bravo', 'Watched']);
  const warning = await checkSyncMarker(yt, { dryRun: false, claimSync: false });

  assert.equal(warning, null, 'claiming is not something to warn about');
  assert.equal(yt.calls.insert.length, 1);
  const body = yt.calls.insert[0].requestBody;
  assert.equal(body.snippet.title, OUR_TITLE);
  assert.equal(body.status.privacyStatus, 'private');
  assert.match(body.snippet.description, /generate-youtube-playlists/);
});

test('--dry-run claims nothing', async () => {
  // A dry run that created a playlist would be a dry run that spent 50 units.
  const yt = fakeYouTube(['Bravo']);
  const warning = await checkSyncMarker(yt, { dryRun: true, claimSync: false });
  assert.equal(warning, null);
  assert.equal(yt.calls.insert.length, 0);
});

test('our own marker is silent and costs nothing', async () => {
  const yt = fakeYouTube(['Bravo', OUR_TITLE]);
  const warning = await checkSyncMarker(yt, { dryRun: false, claimSync: false });
  assert.equal(warning, null);
  assert.equal(yt.calls.insert.length, 0);
  assert.equal(yt.calls.update.length, 0);
});

test("another machine's marker is reported and nothing is written", async () => {
  const yt = fakeYouTube(['gyp-sync-otherbox']);
  const warning = await checkSyncMarker(yt, { dryRun: false, claimSync: false });
  assert.match(warning, /otherbox/);
  assert.equal(yt.calls.insert.length, 0, 'a foreign marker must not be duplicated');
  assert.equal(yt.calls.update.length, 0, 'taking over requires --claim-sync');
});

test('--claim-sync renames the foreign marker rather than making a second one', async () => {
  const yt = fakeYouTube(['gyp-sync-otherbox']);
  const warning = await checkSyncMarker(yt, { dryRun: false, claimSync: true });

  assert.equal(warning, null, 'a completed claim leaves nothing to report');
  assert.equal(yt.calls.insert.length, 0);
  assert.equal(yt.calls.update.length, 1);
  assert.equal(yt.calls.update[0].requestBody.id, 'PL0');
  assert.equal(yt.calls.update[0].requestBody.snippet.title, OUR_TITLE);
  // playlists.update replaces the snippet, so an omitted description would be cleared.
  assert.ok(yt.calls.update[0].requestBody.snippet.description);
});

test('--claim-sync refuses when our marker already exists alongside theirs', async () => {
  // Renaming would leave two playlists with the same title; deleting the other by hand
  // costs nothing. This is the state a half-finished host move leaves behind.
  const yt = fakeYouTube([OUR_TITLE, 'gyp-sync-otherbox']);
  const warning = await checkSyncMarker(yt, { dryRun: false, claimSync: true });
  assert.match(warning, /otherbox/);
  assert.equal(yt.calls.update.length, 0);
});

test('--claim-sync with --dry-run writes nothing but still reports', async () => {
  const yt = fakeYouTube(['gyp-sync-otherbox']);
  const warning = await checkSyncMarker(yt, { dryRun: true, claimSync: true });
  assert.match(warning, /otherbox/);
  assert.equal(yt.calls.update.length, 0);
});

test('three machines: one claim per run, and the rest are still reported', async () => {
  const yt = fakeYouTube(['gyp-sync-otherbox', 'gyp-sync-oldbox']);
  const warning = await checkSyncMarker(yt, { dryRun: false, claimSync: true });
  assert.equal(yt.calls.update.length, 1, 'claiming is the expensive direction — one per run');
  assert.ok(warning, 'the remaining marker is still worth reporting');
});

test('a failure to read the marker never fails the sync', async () => {
  // The guard must not become the reason the nightly run dies.
  const yt = {
    playlists: {
      list: async () => {
        throw new Error('quotaExceeded');
      },
    },
  };
  const warning = await checkSyncMarker(yt, { dryRun: false, claimSync: false });
  assert.equal(warning, null);
});
