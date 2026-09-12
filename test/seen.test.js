import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  emptyLedger,
  ledgerFileName,
  loadLedger,
  saveLedger,
  updateLedger,
} from '../src/seen.js';

const ids = (set) => [...set].sort();
const mk = (playlistId, known, seen = []) => ({
  playlistId,
  known: new Set(known),
  seen: new Set(seen),
});

test('first run banks what is in the playlist and marks nothing watched', () => {
  const r = updateLedger(emptyLedger(), { playlistId: 'PL1', currentIds: new Set(['a', 'b']) });
  assert.deepEqual(ids(r.ledger.known), ['a', 'b']);
  assert.deepEqual(ids(r.ledger.seen), []);
  assert.deepEqual(ids(r.newlyRemoved), []);
});

test('a video that disappears from the playlist is marked watched', () => {
  const r = updateLedger(mk('PL1', ['a', 'b', 'c']), {
    playlistId: 'PL1',
    currentIds: new Set(['a', 'c']),
  });
  assert.deepEqual(ids(r.newlyRemoved), ['b']);
  assert.deepEqual(ids(r.ledger.seen), ['b']);
});

test('watched stays watched after a later sync re-adds the video', () => {
  // The nightly run puts 'b' back because skipping is not enabled yet.
  const r = updateLedger(mk('PL1', ['a', 'b', 'c'], ['b']), {
    playlistId: 'PL1',
    currentIds: new Set(['a', 'b', 'c']),
  });
  assert.deepEqual(ids(r.ledger.seen), ['b'], 'the watched record must survive a re-add');
  assert.deepEqual(ids(r.newlyRemoved), [], 'and must not be re-reported as a new removal');
});

test('an already-watched video removed again is not re-reported', () => {
  const r = updateLedger(mk('PL1', ['a', 'b'], ['b']), {
    playlistId: 'PL1',
    currentIds: new Set(['a']),
  });
  assert.deepEqual(ids(r.newlyRemoved), []);
  assert.deepEqual(ids(r.ledger.seen), ['b']);
});

test('videos added this run become known', () => {
  const r = updateLedger(mk('PL1', ['a']), { playlistId: 'PL1', currentIds: new Set(['a', 'z']) });
  assert.deepEqual(ids(r.ledger.known), ['a', 'z']);
});

test('a missing playlist resets instead of marking everything watched', () => {
  // playlistId null = the playlist does not exist, so "absent" means nothing.
  const r = updateLedger(mk('PL1', ['a', 'b', 'c']), { playlistId: null, currentIds: new Set() });
  assert.equal(r.reset, true);
  assert.deepEqual(ids(r.ledger.seen), [], 'must not declare the whole playlist watched');
  assert.deepEqual(ids(r.ledger.known), []);
});

test('a recreated playlist (new id) resets the ledger', () => {
  const r = updateLedger(mk('PL_OLD', ['a', 'b'], ['b']), {
    playlistId: 'PL_NEW',
    currentIds: new Set(['a']),
  });
  assert.equal(r.reset, true);
  assert.deepEqual(ids(r.ledger.seen), []);
  assert.deepEqual(ids(r.ledger.known), ['a']);
  assert.equal(r.ledger.playlistId, 'PL_NEW');
});

test('clearing an existing playlist marks all of it watched', () => {
  // Legitimate: the family watched everything and emptied the playlist.
  const r = updateLedger(mk('PL1', ['a', 'b']), { playlistId: 'PL1', currentIds: new Set() });
  assert.equal(r.reset, false);
  assert.deepEqual(ids(r.ledger.seen), ['a', 'b']);
});

test('updateLedger does not mutate its input', () => {
  const before = mk('PL1', ['a', 'b']);
  updateLedger(before, { playlistId: 'PL1', currentIds: new Set(['a']) });
  assert.deepEqual(ids(before.known), ['a', 'b']);
  assert.deepEqual(ids(before.seen), []);
});

test('ledgerFileName sanitises titles', () => {
  assert.equal(ledgerFileName('SomeChannel'), 'SomeChannel.json');
  assert.equal(ledgerFileName('a/b\\c'), 'a_b_c.json');
  assert.equal(ledgerFileName('  '), 'unnamed.json');
});

test('save then load round-trips a ledger', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seen-'));
  try {
    await saveLedger(dir, 'Chan', mk('PL1', ['a', 'b'], ['b']));
    const back = await loadLedger(dir, 'Chan');
    assert.equal(back.playlistId, 'PL1');
    assert.deepEqual(ids(back.known), ['a', 'b']);
    assert.deepEqual(ids(back.seen), ['b']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('loading a missing or corrupt ledger starts fresh', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'seen-'));
  try {
    const missing = await loadLedger(dir, 'Nope');
    assert.deepEqual(ids(missing.known), []);

    await fs.writeFile(path.join(dir, 'Bad.json'), '{not json');
    const corrupt = await loadLedger(dir, 'Bad');
    assert.deepEqual(ids(corrupt.known), []);
    assert.deepEqual(ids(corrupt.seen), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
