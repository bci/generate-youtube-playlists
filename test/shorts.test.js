import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChannelSpec,
  parseArgs,
  summaryLine,
  tokenizeChannelLine,
  targetsFor,
} from '../src/index.js';
import { readChannel, getPlaylistStatus, applyInserts } from '../src/youtube.js';
import { statusNote, buildHtml, sortByChannel } from '../src/report.js';

// ---- tokenizing -------------------------------------------------------------

test('fields are whitespace-separated, but a quoted value may contain spaces', () => {
  assert.deepEqual(tokenizeChannelLine('@Chan'), ['@Chan']);
  assert.deepEqual(tokenizeChannelLine('@Chan  after=2026-01-01   older=keep'), [
    '@Chan',
    'after=2026-01-01',
    'older=keep',
  ]);
  assert.deepEqual(
    tokenizeChannelLine('@Chan shorts-title="Build Weird (Clips)" older=keep'),
    ['@Chan', 'shorts-title="Build Weird (Clips)"', 'older=keep']
  );
});

test('an unbalanced quote is fatal, not split into nonsense fields', () => {
  // Without the check, the leftover fragment surfaces as `Unrecognised field "Weird"`,
  // which names a piece of the title rather than the actual mistake.
  assert.throws(() => tokenizeChannelLine('@Chan shorts-title="Build Weird'), /Unbalanced/);
  assert.throws(() => parseChannelSpec('@Chan shorts-title="Build Weird'), /Unbalanced/);
});

// ---- the shorts field -------------------------------------------------------

test('Shorts are excluded unless the channel says otherwise', () => {
  assert.equal(parseChannelSpec('@Chan').shorts, 'no');
  for (const mode of ['no', 'yes', 'only', 'split']) {
    assert.equal(parseChannelSpec(`@Chan shorts=${mode}`).shorts, mode);
  }
});

test('the shorts field is case-insensitive, like the others', () => {
  assert.equal(parseChannelSpec('@Chan Shorts=Split').shorts, 'split');
  assert.equal(parseChannelSpec('@Chan SHORTS=ONLY').shorts, 'only');
});

test('shorts= stands on its own, without a cutoff', () => {
  // Regression: the "older= needs an after= date" guard fired on any line with fields
  // but no date, which made `@Chan shorts=split` a fatal config error.
  const spec = parseChannelSpec('@Chan shorts=split');
  assert.equal(spec.after, null);
  assert.equal(spec.shorts, 'split');
  // ...and that guard still catches the line it was written for.
  assert.throws(() => parseChannelSpec('@Chan older=keep'), /needs an after= date/);
});

test('the fields combine, in any order', () => {
  for (const line of [
    '@Chan after=2026-01-01 older=keep shorts=split',
    '@Chan shorts=split older=keep after=2026-01-01',
  ]) {
    const spec = parseChannelSpec(line);
    assert.equal(spec.after.toISOString(), '2026-01-01T00:00:00.000Z', line);
    assert.equal(spec.removeBefore, false, line);
    assert.equal(spec.shorts, 'split', line);
  }
});

test('a bad shorts value or field name is an error, not a silent no-op', () => {
  // The whole reason a bad line throws: a silently-ignored shorts= leaves the second
  // playlist uncreated, or a Shorts-only channel with the empty playlist the field
  // exists to fix — and both look like the tool having missed the channel.
  assert.throws(() => parseChannelSpec('@Chan shorts=true'), /needs one of/);
  assert.throws(() => parseChannelSpec('@Chan shorts=both'), /needs one of/);
  assert.throws(() => parseChannelSpec('@Chan shorts='), /needs a value/);
  assert.throws(() => parseChannelSpec('@Chan shorts-yes'), /Unrecognised field/);
  assert.throws(() => parseChannelSpec('@Chan no-shorts'), /Unrecognised field/);
  // The messages name what is allowed, and quote what was actually written.
  assert.throws(() => parseChannelSpec('@Chan shorts=maybe'), /got "maybe"/);
  assert.throws(() => parseChannelSpec('@Chan shorts'), /shorts=no\|yes\|only\|split/);
});

// ---- the shorts playlist title ----------------------------------------------

test('split names the Shorts playlist after the channel, only does not', () => {
  // A split channel has a sibling to avoid colliding with; a shorts=only channel has
  // just the one playlist and no reason to wear a suffix.
  assert.deepEqual(targetsFor(parseChannelSpec('@Chan shorts=split'), 'Chan'), [
    { playlistTitle: 'Chan', want: 'videos' },
    { playlistTitle: 'Chan (Shorts)', want: 'shorts' },
  ]);
  assert.deepEqual(targetsFor(parseChannelSpec('@Chan shorts=only'), 'Chan'), [
    { playlistTitle: 'Chan', want: 'shorts' },
  ]);
});

test('shorts-title= overrides whichever playlist holds the Shorts', () => {
  const split = parseChannelSpec('@Chan shorts=split shorts-title="Chan Clips"');
  assert.equal(split.shortsTitle, 'Chan Clips');
  assert.deepEqual(targetsFor(split, 'Chan'), [
    { playlistTitle: 'Chan', want: 'videos' },
    { playlistTitle: 'Chan Clips', want: 'shorts' },
  ]);
  const only = parseChannelSpec('@Chan shorts=only shorts-title="Chan Clips"');
  assert.deepEqual(targetsFor(only, 'Chan'), [
    { playlistTitle: 'Chan Clips', want: 'shorts' },
  ]);
});

test('a shorts title with no Shorts playlist to name is an error', () => {
  // shorts=no and shorts=yes have no Shorts playlist, so the line is a mistake rather
  // than a harmless extra: its author expected one to exist.
  assert.throws(
    () => parseChannelSpec('@Chan shorts-title="Clips"'),
    /needs shorts=split or shorts=only/
  );
  assert.throws(
    () => parseChannelSpec('@Chan shorts=yes shorts-title="Clips"'),
    /needs shorts=split or shorts=only/
  );
  assert.throws(() => parseChannelSpec('@Chan shorts=split shorts-title=""'), /needs a value/);
});

test('every mode but split asks for exactly one playlist', () => {
  for (const mode of ['no', 'yes', 'only']) {
    assert.equal(targetsFor(parseChannelSpec(`@Chan shorts=${mode}`), 'Chan').length, 1, mode);
  }
  assert.equal(targetsFor(parseChannelSpec('@Chan'), 'Chan').length, 1, 'default');
  assert.equal(targetsFor(parseChannelSpec('@Chan shorts=split'), 'Chan').length, 2);
});

// ---- the flag ---------------------------------------------------------------

test('--shorts= takes the same values as the field and defaults to off', () => {
  assert.equal(parseArgs([]).shorts, null);
  assert.equal(parseArgs(['--shorts=split']).shorts, 'split');
  assert.equal(parseArgs(['@Chan', '--shorts=only', '--dry-run']).shorts, 'only');
  assert.throws(() => parseArgs(['--shorts=please']), /needs one of/);
});

// ---- readChannel / getPlaylistStatus ----------------------------------------

/**
 * Counts what a run actually asks YouTube for, so a test can assert that a split
 * channel is read once rather than twice.
 *
 * The Shorts probe's authoritative step is an HTTP HEAD, which no test here may make.
 * So every duration is 10 minutes — over the 180s gate, meaning nothing is ever
 * short-listed and the probe never reaches the network. Tests that need a channel with
 * actual Shorts place the partition on the read by hand instead, which is the seam
 * getPlaylistStatus() actually consumes.
 */
function stubYouTube({ uploads, playlists = {} }) {
  const calls = { uploadsList: 0, videosList: 0, playlistRead: [] };
  const inserted = [];
  return {
    calls,
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
      list: async () => ({
        data: {
          items: Object.entries(playlists).map(([title, id]) => ({
            id,
            snippet: { title },
          })),
        },
      }),
      insert: async () => ({ data: { id: 'NEW', snippet: { title: 'new' } } }),
    },
    videos: {
      list: async ({ id }) => {
        calls.videosList++;
        return {
          data: {
            items: id.map((v) => ({ id: v, contentDetails: { duration: 'PT10M' } })),
          },
        };
      },
    },
    playlistItems: {
      list: async ({ playlistId }) => {
        if (playlistId === 'UU1') {
          calls.uploadsList++;
          return {
            data: {
              items: uploads.map((id) => ({
                contentDetails: { videoId: id, videoPublishedAt: '2026-08-01T00:00:00Z' },
                snippet: { title: id },
              })),
            },
          };
        }
        calls.playlistRead.push(playlistId);
        return { data: { items: [] } };
      },
      insert: async ({ requestBody }) => {
        inserted.push([
          requestBody.snippet.playlistId,
          requestBody.snippet.resourceId.videoId,
        ]);
        return { data: {} };
      },
    },
  };
}

test('shorts=yes skips the probe entirely, not just its verdict', async () => {
  // Worth asserting on its own: the probe costs a videos.list unit per 50 ids plus an
  // HTTP HEAD per candidate. The one mode that mixes everything into a single playlist
  // never needs the partition, so it should pay for neither.
  const yt = stubYouTube({ uploads: ['a', 'b', 'c'], playlists: { Chan: 'PL1' } });
  const read = await readChannel(yt, '@Chan', { classifyShorts: false });
  assert.equal(yt.calls.videosList, 0, 'no duration lookup at all');
  assert.deepEqual(
    read.videos.map((v) => v.videoId),
    ['a', 'b', 'c']
  );
  assert.deepEqual(read.shorts, [], 'nothing was classified');

  const s = await getPlaylistStatus(yt, read, { playlistTitle: 'Chan' });
  assert.equal(s.totalVideos, 3, 'every upload belongs to the one playlist');
  assert.equal(s.shortsExcluded, 0);
  assert.equal(s.shortsMixedIn, true);
  assert.equal(s.shortsOnly, false);
});

test('separating Shorts runs the duration lookup', async () => {
  const yt = stubYouTube({ uploads: ['a', 'b'], playlists: { Chan: 'PL1' } });
  const read = await readChannel(yt, '@Chan', { classifyShorts: true });
  assert.equal(yt.calls.videosList, 1, 'the duration lookup happens');
  // Both are 10 minutes long, so nothing is short-listed and nothing is separated.
  assert.deepEqual(read.shorts, []);
  const s = await getPlaylistStatus(yt, read, { playlistTitle: 'Chan', want: 'videos' });
  assert.equal(s.shortsMixedIn, false, 'the partition ran, it just found no Shorts');
  assert.equal(s.totalVideos, 2);
});

test('want picks which half of one read a playlist is for', async () => {
  const yt = stubYouTube({
    uploads: ['vid1', 'vid2'],
    playlists: { Chan: 'PL1', 'Chan (Shorts)': 'PL2' },
  });
  const read = await readChannel(yt, '@Chan', { classifyShorts: true });
  // Hand-place the partition, so this asserts the slicing rather than the probe.
  read.shorts = read.videos.slice(1);
  read.videos = read.videos.slice(0, 1);

  const videos = await getPlaylistStatus(yt, read, { playlistTitle: 'Chan', want: 'videos' });
  assert.deepEqual(
    videos.missing.map((v) => v.videoId),
    ['vid1']
  );
  assert.equal(videos.shortsExcluded, 1, 'the one it does not hold');
  assert.equal(videos.shortsOnly, false);

  const shorts = await getPlaylistStatus(yt, read, {
    playlistTitle: 'Chan (Shorts)',
    want: 'shorts',
  });
  assert.deepEqual(
    shorts.missing.map((v) => v.videoId),
    ['vid2']
  );
  assert.equal(shorts.shortsOnly, true);
  assert.equal(
    shorts.shortsExcluded,
    0,
    'on the Shorts playlist they are the contents, not an exclusion'
  );
});

test('a split channel is read once and diffed twice', async () => {
  // The reason readChannel is a separate function. Everything charged per channel —
  // the handle resolution, the uploads listing, and above all the Shorts probe — must
  // happen once no matter how many playlists the line asks for.
  const yt = stubYouTube({
    uploads: ['vid', 'other'],
    playlists: { Chan: 'PL1', 'Chan (Shorts)': 'PL2' },
  });
  const spec = parseChannelSpec('@Chan shorts=split');
  const read = await readChannel(yt, '@Chan', { classifyShorts: spec.shorts !== 'yes' });
  const targets = targetsFor(spec, read.channel.name);
  const statuses = [];
  for (const target of targets) statuses.push(await getPlaylistStatus(yt, read, target));

  assert.equal(yt.calls.uploadsList, 1, 'one uploads listing for two playlists');
  assert.equal(yt.calls.videosList, 1, 'one Shorts probe for two playlists');
  assert.deepEqual(yt.calls.playlistRead, ['PL1', 'PL2'], 'but each playlist is read');
  assert.deepEqual(
    statuses.map((s) => s.playlistTitle),
    ['Chan', 'Chan (Shorts)']
  );
  assert.deepEqual(
    statuses.map((s) => s.want),
    ['videos', 'shorts']
  );
});

test('each playlist of a split channel keeps its own watched ledger', async () => {
  // The ledger is keyed by playlist title, so this falls out for free — but it is the
  // property that stops a watched Short from being read as a removal from the videos
  // playlist, and vice versa.
  const yt = stubYouTube({
    uploads: ['vid'],
    playlists: { Chan: 'PL1', 'Chan (Shorts)': 'PL2' },
  });
  const asked = [];
  const read = await readChannel(yt, '@Chan', { classifyShorts: true });
  for (const target of targetsFor(parseChannelSpec('@Chan shorts=split'), 'Chan')) {
    await getPlaylistStatus(yt, read, {
      ...target,
      getLedger: async (title) => {
        asked.push(title);
        return { playlistId: null, known: new Set(), seen: new Set() };
      },
    });
  }
  assert.deepEqual(asked, ['Chan', 'Chan (Shorts)'], 'two ledgers, one per playlist');
});

test('a Shorts playlist is created describing itself as Shorts', async () => {
  // Two playlists whose titles differ only by a suffix, so the description is the only
  // thing telling them apart in YouTube's own UI.
  const created = [];
  const yt = stubYouTube({ uploads: ['a'] });
  yt.playlists.insert = async ({ requestBody }) => {
    created.push(requestBody.snippet);
    return { data: { id: 'NEW', snippet: { title: requestBody.snippet.title } } };
  };
  const read = await readChannel(yt, '@Chan', { classifyShorts: true });
  read.shorts = read.videos;
  read.videos = [];
  const st = await getPlaylistStatus(yt, read, {
    playlistTitle: 'Chan (Shorts)',
    want: 'shorts',
  });
  await applyInserts(yt, st, {});
  assert.equal(created.length, 1);
  assert.equal(created[0].title, 'Chan (Shorts)');
  assert.match(created[0].description, /all Shorts from @Chan/);
});

// ---- reporting --------------------------------------------------------------

test('the report says which side of the split a playlist is', () => {
  assert.match(statusNote({ action: 'updated', shortsOnly: true }), /shorts only/);
  assert.match(statusNote({ action: 'updated', shortsMixedIn: true }), /shorts mixed in/);
  assert.equal(statusNote({ action: 'updated' }), 'updated', 'silent by default');
});

test('a split channel names where its Shorts went, rather than calling them skipped', () => {
  // "Skipped" is only true when nothing else holds them.
  assert.match(
    statusNote({ action: 'updated', shortsExcluded: 12, shortsSibling: 'Chan (Shorts)' }),
    /12 shorts in “Chan \(Shorts\)”/
  );
  assert.match(statusNote({ action: 'updated', shortsExcluded: 12 }), /12 shorts skipped/);
});

test('the console line says it too', () => {
  assert.match(
    summaryLine({ totalVideos: 40, videoCount: 40, action: 'up to date', shortsOnly: true }),
    /shorts only/
  );
  assert.match(
    summaryLine({
      totalVideos: 40,
      videoCount: 40,
      action: 'up to date',
      shortsExcluded: 3,
      shortsSibling: 'Chan (Shorts)',
    }),
    /3 shorts -> Chan \(Shorts\)/
  );
});

test('two rows of one channel sort deterministically', () => {
  // A split channel contributes two rows under one handle; without the playlist tie
  // break their order depended on which finished first.
  const rows = [
    { handle: '@Chan', playlistTitle: 'Chan (Shorts)' },
    { handle: '@Alpha', playlistTitle: 'Alpha' },
    { handle: '@Chan', playlistTitle: 'Chan' },
  ];
  assert.deepEqual(
    sortByChannel(rows).map((s) => s.playlistTitle),
    ['Alpha', 'Chan', 'Chan (Shorts)']
  );
  assert.deepEqual(sortByChannel(rows), sortByChannel([...rows].reverse()), 'stable');
});

test('the report footnote explains Shorts only when Shorts are in play', () => {
  const row = (over) => ({
    handle: '@A',
    playlistTitle: 'A',
    totalVideos: 40,
    videoCount: 40,
    action: 'up to date',
    ...over,
  });
  assert.match(buildHtml([row({ shortsOnly: true })], {}), /only its Shorts/);
  assert.match(buildHtml([row({ shortsExcluded: 4 })], {}), /only its Shorts/);
  assert.doesNotMatch(buildHtml([row({})], {}), /only its Shorts/);
});
