import test from 'node:test';
import assert from 'node:assert/strict';
import {
  esc,
  sortByChannel,
  buildHtml,
  addedCell,
  removedCell,
  statusNote,
} from '../src/report.js';

test('esc escapes HTML special characters', () => {
  assert.equal(esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
  assert.equal(esc('plain text'), 'plain text');
});

test('sortByChannel sorts A-Z by handle, case-insensitive', () => {
  const input = [{ handle: '@Zulu' }, { handle: '@alpha' }, { handle: '@Bravo' }];
  assert.deepEqual(
    sortByChannel(input).map((s) => s.handle),
    ['@alpha', '@Bravo', '@Zulu']
  );
});

test('sortByChannel does not mutate its input', () => {
  const input = [{ handle: '@b' }, { handle: '@a' }];
  const before = [...input];
  sortByChannel(input);
  assert.deepEqual(input, before);
});

test('sortByChannel tolerates rows with no handle (errors)', () => {
  const out = sortByChannel([{ handle: '@b' }, {}, { handle: '@a' }]).map((s) => s.handle);
  assert.deepEqual(out, [undefined, '@a', '@b']); // '' sorts first
});

test('buildHtml renders alphabetically sorted rows with links and notes', () => {
  const summaries = [
    { handle: '@Zoo', playlistTitle: 'Zoo', url: 'https://x/z', totalVideos: 10, videoCount: 10, action: 'up to date', shortsExcluded: 0 },
    { handle: '@Ant', playlistTitle: 'Ant', url: 'https://x/a', totalVideos: 5, videoCount: 3, action: 'updated', added: 3, shortsExcluded: 2 },
  ];
  const html = buildHtml(summaries, {});
  assert.ok(html.indexOf('>@Ant<') < html.indexOf('>@Zoo<'), 'Ant should come before Zoo');
  assert.match(html, /href="https:\/\/x\/a"/);
  assert.match(html, />\+3</); // its own cell now, not prose
  assert.match(html, /2 shorts skipped/);
});

test('buildHtml renders error rows', () => {
  const html = buildHtml([{ handle: '@Bad', error: 'quota exceeded' }], {});
  assert.match(html, /Error: quota exceeded/);
});

test('buildHtml dry-run shows "to add" and dry-run marker', () => {
  const html = buildHtml(
    [{ handle: '@A', playlistTitle: 'A', url: 'u', totalVideos: 5, videoCount: 2, action: 'would update', dryRun: true, toAdd: 3 }],
    { dryRun: true }
  );
  assert.match(html, /dry run/);
  assert.match(html, /3 to add/);
});

test('buildHtml flags quota limit hit', () => {
  const html = buildHtml(
    [{ handle: '@A', playlistTitle: 'A', url: 'u', totalVideos: 800, videoCount: 133, action: 'updated', added: 133, quotaHit: true }],
    {}
  );
  assert.match(html, /quota limit hit/);
});

test('addedCell reports adds, pending adds in dry-run, and a dash for nothing', () => {
  assert.equal(addedCell({ added: 3 }), '+3');
  assert.equal(addedCell({ added: 0 }), '—');
  assert.equal(addedCell({ dryRun: true, toAdd: 4 }), '4 to add');
  assert.equal(addedCell({ dryRun: true, toAdd: 0 }), '—');
});

test('removedCell distinguishes real deletions from detect-only modes', () => {
  assert.equal(removedCell({ removed: 3 }), '−3');
  assert.equal(removedCell({ removed: 0 }), '—');
  // --report-watched and --dry-run both detect without deleting.
  assert.equal(removedCell({ previewRemovals: true, toRemove: [1, 2] }), '2 would remove');
  assert.equal(removedCell({ dryRun: true, toRemove: [1] }), '1 to remove');
  assert.equal(removedCell({ previewRemovals: true, toRemove: [] }), '—');
});

test('statusNote carries words and standing context, not per-run counts', () => {
  assert.equal(statusNote({ action: 'up to date' }), 'up to date');
  assert.equal(
    statusNote({ action: 'updated', shortsExcluded: 12 }),
    'updated, 12 shorts skipped'
  );
  assert.match(statusNote({ action: 'updated', quotaHit: true }), /quota limit hit/);
});

test('statusNote drops the redundant watched-ledger counts', () => {
  // These used to be five overlapping phrases describing the same few videos.
  const note = statusNote({
    action: 'up to date',
    justSaved: 3,
    removed: 3,
    seenCount: 32,
    wouldSkip: 29,
  });
  assert.equal(note, 'updated'); // the 3 removals, and nothing about the ledger
});

test('buildHtml puts added, removed and total in their own columns', () => {
  const html = buildHtml(
    [
      {
        handle: '@A',
        playlistTitle: 'A',
        url: 'u',
        totalVideos: 69,
        videoCount: 37,
        action: 'up to date',
        removed: 3,
        justSaved: 3,
        seenCount: 32,
        wouldSkip: 29,
      },
    ],
    {}
  );
  assert.match(html, /<th[^>]*>Added<\/th>/);
  assert.match(html, /<th[^>]*>Removed<\/th>/);
  assert.match(html, /−3/); // the removal lands in its own cell
  assert.match(html, />37</); // total in playlist
  // The convoluted prose is gone.
  assert.doesNotMatch(html, /newly saved to Watched/);
  assert.doesNotMatch(html, /re-added/);
  assert.doesNotMatch(html, /watched so far/);
});

test('statusNote does not call a run that pruned videos "up to date"', () => {
  assert.equal(statusNote({ action: 'up to date', removed: 3 }), 'updated');
  assert.equal(statusNote({ action: 'up to date', removed: 0 }), 'up to date');
});

test('a dry run with nothing pending is not reported as "would update"', () => {
  // Mirrors the dry-run branch in index.js: only a real pending change earns the label.
  const pending = { action: 'would update', dryRun: true, toAdd: 18 };
  const settled = { action: 'up to date', dryRun: true, toAdd: 0 };
  assert.equal(addedCell(pending), '18 to add');
  assert.equal(addedCell(settled), '—');
  assert.equal(statusNote(settled), 'up to date');
});

test('a playlist that is no longer manually sorted says so in the report', () => {
  const note = statusNote({ action: 'updated', manualSortRequired: true });
  assert.match(note, /Manual/);
  assert.match(note, /appended at the end/);
  // Nothing to warn about while positional inserts still work.
  assert.equal(statusNote({ action: 'updated' }), 'updated');
});

test('an error row spans the whole table', () => {
  const html = buildHtml([{ handle: '@x', error: 'boom' }], {});
  // Six columns in the header: the handle plus five spanned by the message. A
  // colspan short of that left a stray empty cell at the end of the row.
  const headers = html.match(/<th[ >]/g).length; // [ >] so <thead> is not counted
  const span = Number(/colspan="(\d+)"/.exec(html)[1]);
  assert.equal(span + 1, headers);
});

test('the account label is optional', () => {
  const rows = [{ handle: '@x', playlistTitle: 'x', totalVideos: 1 }];
  assert.match(buildHtml(rows, { account: 'someone@example.com' }), /account: someone@example.com/);
  assert.doesNotMatch(buildHtml(rows, {}), /account:/);
});

// The report is full of non-ASCII (em dashes, curly quotes, the warning triangle) and is
// read as a file:// URL, where there is no Content-Type header to fall back on. Without a
// declared charset the browser guesses the locale default — cp1252 on Windows — and every
// one of those characters renders as mojibake. The bytes were always correct UTF-8; only
// the declaration was missing.
test('buildHtml declares UTF-8, so non-ASCII survives a file:// open', () => {
  const html = buildHtml([], {});
  assert.match(html, /<meta charset="utf-8">/i);
  // The charset has to land in the first 1024 bytes or browsers ignore it.
  assert.ok(html.indexOf('charset') < 1024, 'charset must be within the first 1024 bytes');
});
