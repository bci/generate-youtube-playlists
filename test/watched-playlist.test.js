/**
 * Tests for reading the curated "Watched" playlist by title.
 *
 * @module test/watched-playlist
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { getWatchedPlaylistIds } from '../src/youtube.js';

// Mock enough of the client for findPlaylistByTitle + getPlaylistItemMap.
/**
 * A read-only client with the given playlists and their items.
 *
 * @param {object} [fixture]
 * @param {Array<object>} [fixture.playlists=[]] - playlists.list items.
 * @param {Object<string, string[]>} [fixture.itemsByPlaylist={}] - Playlist id -> video ids.
 * @returns {object} The mock client.
 */
function mockYoutube({ playlists = [], itemsByPlaylist = {} } = {}) {
  return {
    playlists: {
      list: async () => ({ data: { items: playlists } }),
    },
    playlistItems: {
      list: async ({ playlistId }) => ({
        data: {
          items: (itemsByPlaylist[playlistId] || []).map((vid) => ({
            id: `ITEM_${vid}`,
            contentDetails: { videoId: vid },
          })),
        },
      }),
    },
  };
}

test('getWatchedPlaylistIds reads the playlist by title', async () => {
  const yt = mockYoutube({
    playlists: [{ id: 'PLW', snippet: { title: 'Watched' }, contentDetails: { itemCount: 2 } }],
    itemsByPlaylist: { PLW: ['a', 'b'] },
  });
  const res = await getWatchedPlaylistIds(yt, 'Watched');
  assert.equal(res.found, true);
  assert.deepEqual([...res.ids].sort(), ['a', 'b']);
});

test('a missing Watched playlist is not an error', async () => {
  const yt = mockYoutube({ playlists: [{ id: 'PLX', snippet: { title: 'Something else' } }] });
  const res = await getWatchedPlaylistIds(yt, 'Watched');
  assert.equal(res.found, false);
  assert.equal(res.ids.size, 0);
});

test('the title match is case-insensitive', async () => {
  const yt = mockYoutube({
    playlists: [{ id: 'PLW', snippet: { title: 'watched' } }],
    itemsByPlaylist: { PLW: ['a'] },
  });
  const res = await getWatchedPlaylistIds(yt, 'Watched');
  assert.equal(res.found, true);
  assert.deepEqual([...res.ids], ['a']);
});
