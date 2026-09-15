import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import { runUnclaim } from '../src/index.js';
import { checkUnclaimSync, machineKey, markerTitle, planUnclaim } from '../src/marker.js';

const OUR_KEY = machineKey(os.hostname());
const OURS = markerTitle(OUR_KEY);

// Same shape as marker-run.test.js: a mocked client, never the real API. Exercising this
// for real would cost 50 units per marker per assertion.
function fakeYouTube(titles, { failOn = null } = {}) {
  const deleted = [];
  return {
    deleted,
    playlists: {
      list: async () => ({
        data: { items: titles.map((t, i) => ({ id: `PL${i}`, snippet: { title: t } })) },
      }),
      delete: async ({ id }) => {
        const title = titles[Number(id.slice(2))];
        if (title === failOn) throw new Error('refused');
        deleted.push(title);
      },
    },
  };
}

// --- the pure decision -------------------------------------------------------------

test('planUnclaim releases only our own marker by default', () => {
  const plan = planUnclaim([{ id: 'a', title: OURS }, { id: 'b', title: 'gyp-sync-otherbox' }], OUR_KEY);
  assert.equal(plan.action, 'delete');
  assert.deepEqual(plan.targets.map((p) => p.title), [OURS]);
  // The foreign marker is left, so the account is still claimed and the caller must say so.
  assert.equal(plan.remaining.length, 1);
});

test('planUnclaim with all releases every marker, ours and theirs', () => {
  const plan = planUnclaim([{ id: 'a', title: OURS }, { id: 'b', title: 'gyp-sync-otherbox' }], OUR_KEY, {
    all: true,
  });
  assert.equal(plan.targets.length, 2);
  assert.equal(plan.remaining.length, 0, 'nothing is left, so the account is free');
});

test('planUnclaim refuses to delete a foreign marker without all', () => {
  const plan = planUnclaim([{ id: 'b', title: 'gyp-sync-otherbox' }], OUR_KEY);
  assert.equal(plan.action, 'none');
  assert.match(plan.reason, /otherbox/);
  assert.match(plan.reason, /--unclaim-all|--claim-sync/);
});

test('planUnclaim on an unclaimed account does nothing', () => {
  const plan = planUnclaim([{ id: 'x', title: 'Watched' }], OUR_KEY, { all: true });
  assert.equal(plan.action, 'none');
  assert.match(plan.reason, /no sync marker/);
});

test('planUnclaim ignores playlists that are not markers', () => {
  const plan = planUnclaim([{ id: 'x', title: 'Watched' }, { id: 'y', title: OURS }], OUR_KEY, { all: true });
  assert.deepEqual(plan.targets.map((p) => p.title), [OURS]);
});

// --- the terminal-only rule --------------------------------------------------------

test('unclaim needs a terminal, and names the flag that was used', () => {
  assert.equal(checkUnclaimSync({ unclaimSync: true }, true), null, 'a TTY may unclaim');
  assert.match(checkUnclaimSync({ unclaimSync: true }, false), /--unclaim-sync needs a terminal/);
  assert.match(checkUnclaimSync({ unclaimAll: true }, false), /--unclaim-all needs a terminal/);
  assert.equal(checkUnclaimSync({}, false), null, 'no flag, nothing to refuse');
});

// --- the operation -----------------------------------------------------------------

test('runUnclaim deletes our marker and leaves the rest', async () => {
  const yt = fakeYouTube([OURS, 'gyp-sync-otherbox', 'Watched']);
  const code = await runUnclaim(yt, { unclaimAll: false, dryRun: false });
  assert.equal(code, 0);
  assert.deepEqual(yt.deleted, [OURS]);
});

test('runUnclaim with unclaimAll deletes every marker', async () => {
  const yt = fakeYouTube([OURS, 'gyp-sync-otherbox', 'Watched']);
  const code = await runUnclaim(yt, { unclaimAll: true, dryRun: false });
  assert.equal(code, 0);
  assert.deepEqual(yt.deleted.sort(), [OURS, 'gyp-sync-otherbox'].sort());
  assert.ok(!yt.deleted.includes('Watched'), 'only markers are ever deleted');
});

// 50 units a marker: a dry run must cost nothing but the listing.
test('runUnclaim writes nothing on a dry run', async () => {
  const yt = fakeYouTube([OURS, 'gyp-sync-otherbox']);
  const code = await runUnclaim(yt, { unclaimAll: true, dryRun: true });
  assert.equal(code, 0);
  assert.deepEqual(yt.deleted, []);
});

test('runUnclaim reports nothing to do rather than failing', async () => {
  const yt = fakeYouTube(['Watched']);
  assert.equal(await runUnclaim(yt, { unclaimAll: true, dryRun: false }), 0);
  assert.deepEqual(yt.deleted, []);
});

// One marker that cannot be deleted must not strand the others: with --unclaim-all the
// point is to leave the account clear, and a partial success is still progress.
test('runUnclaim keeps going when one delete fails, and reports failure only if none landed', async () => {
  const yt = fakeYouTube([OURS, 'gyp-sync-otherbox'], { failOn: OURS });
  assert.equal(await runUnclaim(yt, { unclaimAll: true, dryRun: false }), 0);
  assert.deepEqual(yt.deleted, ['gyp-sync-otherbox']);

  const allFail = fakeYouTube([OURS], { failOn: OURS });
  assert.equal(await runUnclaim(allFail, { unclaimAll: true, dryRun: false }), 1);
});

test('runUnclaim survives a listing failure without throwing', async () => {
  const yt = { playlists: { list: async () => { throw new Error('network'); } } };
  assert.equal(await runUnclaim(yt, { unclaimAll: false, dryRun: false }), 1);
});
