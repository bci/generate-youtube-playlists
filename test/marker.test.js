import test from 'node:test';
import assert from 'node:assert/strict';
import {
  machineKey,
  markerTitle,
  markerKeyOf,
  classifyMarker,
  checkClaimSync,
  conflictMessage,
} from '../src/marker.js';
import { buildHtml } from '../src/report.js';
import { parseArgs } from '../src/index.js';

const pl = (title) => ({ id: `id-${title}`, title });

test('machineKey drops the domain, which is the half that churns', () => {
  // The same Mac reports .local on one network and .lan on another; a key that moved
  // with the DHCP lease would report a conflict against itself.
  assert.equal(machineKey('thisbox.local'), 'thisbox');
  assert.equal(machineKey('thisbox.lan'), 'thisbox');
  assert.equal(machineKey('thisbox'), 'thisbox');
});

test('machineKey sanitises to what survives a playlist title', () => {
  assert.equal(machineKey("Kent's Mac mini"), 'Kent-s-Mac-mini');
  assert.equal(machineKey('  spaced  '), 'spaced');
  assert.equal(machineKey('--edges--'), 'edges');
});

test('an empty hostname never yields a bare prefix', () => {
  // `gyp-sync-` alone would prefix-match every marker as ours, inverting the guard.
  assert.equal(machineKey(''), 'unknown');
  assert.equal(machineKey(null), 'unknown');
  assert.equal(machineKey('...'), 'unknown');
  assert.equal(markerTitle(machineKey('')), 'gyp-sync-unknown');
});

test('classifyMarker: an unclaimed account', () => {
  const found = classifyMarker([pl('Bravo'), pl('Watched')], 'thisbox');
  assert.equal(found.state, 'none');
  assert.equal(found.ours, null);
  assert.deepEqual(found.foreign, []);
});

test('classifyMarker: our own claim is the silent case', () => {
  const found = classifyMarker([pl('Bravo'), pl('gyp-sync-thisbox')], 'thisbox');
  assert.equal(found.state, 'ours');
  assert.equal(found.ours.title, 'gyp-sync-thisbox');
  assert.deepEqual(found.foreign, []);
});

test('classifyMarker matches case-insensitively, as YouTube titles do', () => {
  assert.equal(classifyMarker([pl('GYP-Sync-Thisbox')], 'thisbox').state, 'ours');
});

test('classifyMarker: another machine holds the account', () => {
  const found = classifyMarker([pl('gyp-sync-otherbox')], 'thisbox');
  assert.equal(found.state, 'foreign');
  assert.equal(found.foreign.length, 1);
  assert.equal(markerKeyOf(found.foreign[0].title), 'otherbox');
});

test('a foreign marker wins even when ours is also present', () => {
  // Two markers means two installations, whichever one we are — and this is the state
  // a half-finished host move leaves behind, so it must not read as "ours".
  const found = classifyMarker([pl('gyp-sync-thisbox'), pl('gyp-sync-otherbox')], 'thisbox');
  assert.equal(found.state, 'foreign');
  assert.ok(found.ours, 'ours is still reported, so the caller knows it cannot rename');
  assert.equal(found.foreign.length, 1);
});

test('three machines are all named, not just the first', () => {
  const found = classifyMarker(
    [pl('gyp-sync-otherbox'), pl('gyp-sync-oldbox'), pl('gyp-sync-thisbox')],
    'thisbox'
  );
  assert.equal(found.foreign.length, 2);
  const msg = conflictMessage(found);
  assert.match(msg, /machines/);
  assert.match(msg, /otherbox/);
  assert.match(msg, /oldbox/);
});

test('a playlist merely starting with the prefix is still a marker, not a channel', () => {
  assert.equal(classifyMarker([pl('gyp-sync-')], 'thisbox').state, 'foreign');
  // ...but an unrelated playlist is left alone.
  assert.equal(classifyMarker([pl('gypsum')], 'thisbox').state, 'none');
});

test('--claim-sync is refused without a terminal', () => {
  // The whole anti-flap guarantee: the flag cannot work from launchd or Task Scheduler,
  // so two machines cannot take the account back from each other nightly.
  const msg = checkClaimSync({ claimSync: true }, false);
  assert.ok(msg, 'expected a refusal');
  assert.match(msg, /--claim-sync needs a terminal/);
});

test('--claim-sync is allowed from a terminal, and absent flags never refuse', () => {
  assert.equal(checkClaimSync({ claimSync: true }, true), null);
  assert.equal(checkClaimSync({ claimSync: false }, false), null);
  assert.equal(checkClaimSync({}, false), null);
});

test('parseArgs understands --claim-sync and defaults it off', () => {
  assert.equal(parseArgs([]).claimSync, false);
  assert.equal(parseArgs(['--claim-sync']).claimSync, true);
});

test('the report carries the conflict above the table, and omits it otherwise', () => {
  const summaries = [{ handle: '@A', playlistTitle: 'A', totalVideos: 1, alreadyPresent: 1 }];
  const warning = 'Another machine "otherbox" is syncing this account.';
  const html = buildHtml(summaries, { warning });
  assert.match(html, /otherbox/);
  // Before the table, because it is about the account rather than any one playlist.
  assert.ok(html.indexOf('otherbox') < html.indexOf('<table'));
  assert.doesNotMatch(buildHtml(summaries, {}), /otherbox/);
});
