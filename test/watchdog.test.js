import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStale, buildAlertHtml } from '../src/heartbeat.js';
import { parseWatchdogArgs } from '../src/watchdog.js';

const NOW = new Date('2026-08-21T09:00:00Z');
const hoursAgo = (h) => ({ finishedAt: new Date(NOW.getTime() - h * 3_600_000).toISOString() });

test('a run inside the window is not stale', () => {
  assert.equal(checkStale(hoursAgo(6), NOW).stale, false);
  assert.equal(checkStale(hoursAgo(30), NOW).stale, false);
});

test('36h default tolerates one late run but not two missed nights', () => {
  // A daily 3AM task seen at 3AM yesterday is ~30h old by 9AM today: still fine.
  assert.equal(checkStale(hoursAgo(35.9), NOW).stale, false);
  assert.equal(checkStale(hoursAgo(36.1), NOW).stale, true);
  // The failure this exists to catch: six nights skipped, as happened 2026-08-12..17.
  const gone = checkStale(hoursAgo(24 * 6), NOW);
  assert.equal(gone.stale, true);
  assert.match(gone.reason, /144\.0h ago/);
});

test('a missing or unreadable heartbeat counts as stale', () => {
  assert.equal(checkStale(null, NOW).stale, true);
  assert.match(checkStale(null, NOW).reason, /no successful run/);
  assert.equal(checkStale({}, NOW).stale, true);
  assert.equal(checkStale({ finishedAt: 'not a date' }, NOW).stale, true);
  assert.match(checkStale({ finishedAt: 'not a date' }, NOW).reason, /unreadable timestamp/);
});

test('the threshold is configurable', () => {
  assert.equal(checkStale(hoursAgo(10), NOW, 8).stale, true);
  assert.equal(checkStale(hoursAgo(10), NOW, 12).stale, false);
});

test('parseWatchdogArgs defaults to 36h and accepts an override', () => {
  assert.deepEqual(parseWatchdogArgs([]), { maxAgeHours: 36, dryRun: false });
  assert.equal(parseWatchdogArgs(['--max-age-hours=12']).maxAgeHours, 12);
  assert.equal(parseWatchdogArgs(['--dry-run']).dryRun, true);
  // Garbage must not silently disable the check by becoming NaN.
  assert.equal(parseWatchdogArgs(['--max-age-hours=abc']).maxAgeHours, 36);
});

test('the alert names the last run and stays useful when there was never one', () => {
  const withRun = buildAlertHtml(
    { finishedAt: '2026-08-15T10:01:00Z', channels: 5, added: 2, removed: 1 },
    checkStale(hoursAgo(140), NOW)
  );
  assert.match(withRun, /2026-08-15T10:01:00Z/);
  assert.match(withRun, /5 channels/);
  assert.match(withRun, /YouTube Playlist Sync/);

  const never = buildAlertHtml(null, checkStale(null, NOW));
  assert.match(never, /never/);
  assert.doesNotMatch(never, /undefined/);
});

test('--max-age-hours=0 means 0, not the default', () => {
  // `parseFloat(x) || 36` swallowed an explicit 0, so the flag silently did nothing.
  assert.equal(parseWatchdogArgs(['--max-age-hours=0']).maxAgeHours, 0);
  assert.equal(checkStale({ finishedAt: NOW.toISOString() }, NOW, 0).stale, false);
  assert.equal(checkStale(hoursAgo(0.5), NOW, 0).stale, true);
});
