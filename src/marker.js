/**
 * The sync marker — a private, empty playlist named `gyp-sync-<key>` that records
 * which machine owns the nightly sync for this account.
 *
 * It exists because the "one machine per account" rule is enforced by nothing: a run
 * cannot see the other machine, so two schedulers pointed at one account drift apart
 * silently and then trade videos back and forth — one deletes what it believes was
 * watched, the other re-adds it from a ledger that never saw the watch — at 50 quota
 * units per write, nightly. The symptom (a couple of videos reappearing) looks far
 * too small to investigate, which is exactly why it needs to announce itself.
 *
 * The claim is left on the account rather than on disk because the account is the only
 * thing both machines can see.
 *
 * Everything here is pure: it takes the playlist titles the API already returned and
 * returns a decision, so the rule is testable without a client, a network or a key.
 */

export const MARKER_PREFIX = 'gyp-sync-';

// Playlist titles are free text; a key is not. Keep it to what reads back unambiguously
// in a title, so `gyp-sync-<key>` can be split on the prefix without escaping rules.
const UNSAFE_KEY_CHARS = /[^A-Za-z0-9-]+/g;

/**
 * A machine key from a hostname.
 *
 * The domain part is dropped: macOS reports `name.local` on one network and `name.lan`
 * on another for the same Mac, and a key that changes with the DHCP lease would report
 * a conflict against itself. The leading label is the stable half.
 */
export function machineKey(hostname) {
  const host = String(hostname || '').trim().split('.')[0];
  const key = host.replace(UNSAFE_KEY_CHARS, '-').replace(/^-+|-+$/g, '');
  // Never return an empty key: `gyp-sync-` alone would match every marker as "ours",
  // which turns the guard into the opposite of a guard.
  return key || 'unknown';
}

export function markerTitle(key) {
  return `${MARKER_PREFIX}${key}`;
}

/** The key half of a marker title, for reporting which machine holds the claim. */
export function markerKeyOf(title) {
  return String(title || '').trim().slice(MARKER_PREFIX.length) || '(unnamed)';
}

const isMarker = (p) => (p?.title || '').trim().toLowerCase().startsWith(MARKER_PREFIX);

/**
 * Classify the account's playlists against our own key.
 *
 *   none    — no marker at all; this account is unclaimed, so claim it
 *   ours    — exactly our marker; say nothing, this is the normal case every night
 *   foreign — at least one marker that is not ours; another machine is syncing here
 *
 * A foreign marker wins even when ours is also present: two markers means two
 * installations, whichever one we are. Matching is case-insensitive because YouTube
 * titles are, and `findPlaylistByTitle` already compares that way.
 */
export function classifyMarker(playlists, ourKey) {
  const ourTitle = markerTitle(ourKey).trim().toLowerCase();
  const markers = (playlists || []).filter(isMarker);
  const ours = markers.find((p) => p.title.trim().toLowerCase() === ourTitle) || null;
  const foreign = markers.filter((p) => p !== ours);

  if (foreign.length) return { state: 'foreign', ours, foreign };
  if (ours) return { state: 'ours', ours, foreign: [] };
  return { state: 'none', ours: null, foreign: [] };
}

/**
 * Why `--claim-sync` is refused without a terminal.
 *
 * Returns a message to fail on, or null to proceed. Taking an account away from
 * another machine is a decision a person makes once, in front of a terminal — and
 * requiring one is what makes the flap *unreachable* rather than merely discouraged:
 * if both machines could claim automatically, each would take the account back from
 * the other every night at 50 units a write. The flag cannot be usefully added to
 * run-sync.sh, a plist or a Scheduled Task, so that loop has no way to start.
 *
 * stdin, not stdout, is the thing to test: running a wrapper by hand redirects stdout
 * into logs/sync.log while stdin stays a terminal, and refusing that would be refusing
 * a legitimate claim. Under launchd and Task Scheduler stdin is /dev/null or absent.
 */
export function checkClaimSync({ claimSync }, isTty) {
  if (!claimSync || isTty) return null;
  return (
    '--claim-sync needs a terminal: it takes this account away from another machine, ' +
    'which is a decision to make by hand rather than from a scheduled job. ' +
    'Run it from a terminal, or drop the flag.'
  );
}

/** One line naming the machines that hold a foreign claim. */
export function conflictMessage(classification) {
  const keys = classification.foreign.map((p) => markerKeyOf(p.title));
  const who = keys.length === 1 ? `"${keys[0]}"` : keys.map((k) => `"${k}"`).join(', ');
  const machines = keys.length === 1 ? 'machine' : 'machines';
  return (
    `Another ${machines} ${who} is syncing this account. ` +
    'Two machines sharing one account re-add each other’s deletions at 50 quota units ' +
    'a write. Disable the sync on the other machine, then run --claim-sync here from a ' +
    'terminal; or if it is this machine that should stop, disable the schedule here.'
  );
}
