import fs from 'fs/promises';
import path from 'path';

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
 */

// Playlist titles are channel handles, but don't trust that for a file name.
const UNSAFE_FILENAME_CHARS = /[^A-Za-z0-9._-]+/g;

export function ledgerFileName(playlistTitle) {
  const base = String(playlistTitle || '').trim().replace(UNSAFE_FILENAME_CHARS, '_');
  return `${base || 'unnamed'}.json`;
}

export function ledgerPath(stateDir, playlistTitle) {
  return path.join(stateDir, ledgerFileName(playlistTitle));
}

export function emptyLedger() {
  return { playlistId: null, known: new Set(), seen: new Set() };
}

/** Read a ledger from disk. A missing or unreadable file starts fresh. */
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
