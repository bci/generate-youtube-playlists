/**
 * Per-channel "seen" (watched) ledger.
 *
 * YouTube's Data API cannot tell us what has been watched: the channel's
 * watchHistory playlist has been an empty placeholder since 2016 and there is no
 * replacement endpoint. So "seen" is inferred from the one signal we do control —
 * a video we know was in the playlist and is no longer there was taken out on
 * purpose, i.e. watched.
 *
 *   known -> every videoId ever observed in the playlist
 *   seen  -> ids that were once known and later found missing
 *
 * `seen` accumulates and is never pruned by a later sync re-adding the video, so
 * the record survives the nightly run putting a watched video back.
 *
 * Stored as one JSON file per playlist under `state/`; see {@link ledgerFileName}.
 *
 * @module seen
 */

import fs from 'fs/promises';
import path from 'path';

/**
 * The in-memory ledger for one playlist.
 *
 * @typedef {object} Ledger
 * @property {?string} playlistId - The playlist the sets describe, or null before the
 *   playlist exists. A change of id means the playlist was recreated.
 * @property {Set<string>} known - Every videoId ever observed in the playlist.
 * @property {Set<string>} seen - Ids that were once known and later found missing,
 *   or banked as watched from another signal.
 */

/** Playlist titles are channel handles, but don't trust that for a file name. */
const UNSAFE_FILENAME_CHARS = /[^A-Za-z0-9._-]+/g;

/**
 * The ledger's file name for a playlist title.
 *
 * Every run of characters outside `[A-Za-z0-9._-]` becomes one underscore, so two titles
 * that differ only in those characters share a file.
 *
 * @param {string} playlistTitle - The playlist's title.
 * @returns {string} A safe `<name>.json`; `unnamed.json` for an empty title.
 */
export function ledgerFileName(playlistTitle) {
  const base = String(playlistTitle || '').trim().replace(UNSAFE_FILENAME_CHARS, '_');
  return `${base || 'unnamed'}.json`;
}

/**
 * Full path of a playlist's ledger file.
 *
 * @param {string} stateDir - The state directory.
 * @param {string} playlistTitle - The playlist's title.
 * @returns {string} `<stateDir>/<ledgerFileName(playlistTitle)>`.
 */
export function ledgerPath(stateDir, playlistTitle) {
  return path.join(stateDir, ledgerFileName(playlistTitle));
}

/**
 * A ledger with no history, for a playlist never seen before.
 *
 * @returns {Ledger} A fresh ledger with no playlist id and empty sets.
 */
export function emptyLedger() {
  return { playlistId: null, known: new Set(), seen: new Set() };
}

/**
 * Read a ledger from disk. A missing or unreadable file starts fresh.
 *
 * @param {string} stateDir - The state directory.
 * @param {string} playlistTitle - The playlist's title.
 * @returns {Promise<Ledger>} The stored ledger, or {@link emptyLedger} on any error.
 */
export async function loadLedger(stateDir, playlistTitle) {
  try {
    const data = JSON.parse(await fs.readFile(ledgerPath(stateDir, playlistTitle), 'utf8'));
    return {
      playlistId: data.playlistId ?? null,
      known: new Set(Array.isArray(data.known) ? data.known : []),
      seen: new Set(Array.isArray(data.seen) ? data.seen : []),
    };
  } catch {
    return emptyLedger();
  }
}

/**
 * Write a ledger to disk as sorted, pretty-printed JSON, so diffs of `state/` stay
 * readable.
 *
 * @param {string} stateDir - The state directory; created if missing.
 * @param {string} playlistTitle - The playlist's title.
 * @param {Ledger} ledger - What to store.
 * @returns {Promise<void>}
 * @throws {Error} When the directory or file cannot be written.
 */
export async function saveLedger(stateDir, playlistTitle, ledger) {
  await fs.mkdir(stateDir, { recursive: true });
  const body = JSON.stringify(
    {
      playlistId: ledger.playlistId ?? null,
      known: [...ledger.known].sort(),
      seen: [...ledger.seen].sort(),
    },
    null,
    2
  );
  await fs.writeFile(ledgerPath(stateDir, playlistTitle), `${body}\n`);
}

/**
 * Fold one run's observation of the playlist into the ledger.
 * Pure — returns a new ledger and what changed, mutating nothing.
 *
 * Two cases reset the ledger rather than declaring a pile of videos watched,
 * because in both of them "absent from the playlist" stops meaning "removed":
 *  - playlistId is null: the playlist doesn't exist, so everything is trivially absent.
 *  - playlistId changed: the old playlist was deleted and a new one created, so
 *    `known` describes a playlist that no longer exists.
 *
 * @param {Ledger} ledger - The ledger as loaded; not modified.
 * @param {object} observation - What this run saw.
 * @param {?string} observation.playlistId - The playlist's current id, or null when it
 *   does not exist.
 * @param {Set<string>|string[]} observation.currentIds - Video ids in the playlist now.
 * @returns {{ledger: Ledger, newlyRemoved: Set<string>, reset: boolean}} The updated
 *   ledger, the ids this observation newly marks as watched, and whether history was
 *   discarded.
 */
export function updateLedger(ledger, { playlistId, currentIds }) {
  const current = currentIds instanceof Set ? currentIds : new Set(currentIds || []);

  if (!playlistId) {
    return { ledger: emptyLedger(), newlyRemoved: new Set(), reset: ledger.known.size > 0 };
  }

  const recreated = !!ledger.playlistId && ledger.playlistId !== playlistId;
  const known = recreated ? new Set() : new Set(ledger.known);
  const seen = recreated ? new Set() : new Set(ledger.seen);

  const newlyRemoved = new Set();
  for (const id of known) {
    if (!current.has(id) && !seen.has(id)) newlyRemoved.add(id);
  }
  for (const id of newlyRemoved) seen.add(id);
  for (const id of current) known.add(id);

  return { ledger: { playlistId, known, seen }, newlyRemoved, reset: recreated };
}
