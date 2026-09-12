import fs from 'fs/promises';
import path from 'path';

export const HEARTBEAT_FILE = 'last-run.json';

/**
 * A run that finished writes a heartbeat. The watchdog reads it instead of parsing
 * logs/sync.log: a skipped run leaves no log line at all, which is exactly the case
 * that has to be detectable, and "no log line" is indistinguishable from a rotated
 * or truncated log.
 */
export async function writeHeartbeat(stateDir, { finishedAt, channels, added, removed, errors }) {
  await fs.mkdir(stateDir, { recursive: true });
  const body = JSON.stringify({ finishedAt, channels, added, removed, errors }, null, 2);
  await fs.writeFile(path.join(stateDir, HEARTBEAT_FILE), `${body}\n`);
}

export async function readHeartbeat(stateDir) {
  try {
    return JSON.parse(await fs.readFile(path.join(stateDir, HEARTBEAT_FILE), 'utf8'));
  } catch {
    return null; // never run, or the file was removed — the watchdog treats both as stale
  }
}

/**
 * Decide whether the sync has gone quiet. Pure, so the thresholds are testable
 * without a clock or a mailbox.
 *
 * `maxAgeHours` defaults to 36: a daily task has to miss its slot AND the following
 * one before this fires, so a single late or manually-deferred run stays silent.
 */
export function checkStale(heartbeat, now, maxAgeHours = 36) {
  if (!heartbeat?.finishedAt) {
    return { stale: true, ageHours: null, reason: 'no successful run has ever been recorded' };
  }
  const finished = new Date(heartbeat.finishedAt);
  if (Number.isNaN(finished.getTime())) {
    return { stale: true, ageHours: null, reason: `unreadable timestamp "${heartbeat.finishedAt}"` };
  }
  const ageHours = (now.getTime() - finished.getTime()) / 3_600_000;
  if (ageHours > maxAgeHours) {
    return {
      stale: true,
      ageHours,
      reason: `last successful run was ${ageHours.toFixed(1)}h ago (limit ${maxAgeHours}h)`,
    };
  }
  return { stale: false, ageHours, reason: `last successful run was ${ageHours.toFixed(1)}h ago` };
}

/** Plain-text-ish HTML for the alert. Deliberately short: it is read on a phone. */
export function buildAlertHtml(heartbeat, check, { taskName = 'YouTube Playlist Sync' } = {}) {
  const last = heartbeat?.finishedAt
    ? `${heartbeat.finishedAt} (${heartbeat.channels ?? '?'} channels, ` +
      `+${heartbeat.added ?? 0} added, -${heartbeat.removed ?? 0} removed)`
    : 'never';
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#222">
  <h2 style="color:#b00">YouTube playlist sync has gone quiet</h2>
  <p>${check.reason}.</p>
  <p><b>Last successful run:</b> ${last}</p>
  <p style="color:#666">
    The scheduled task is <b>${taskName}</b>. Worth checking, in order:
    <br>1. <code>Get-ScheduledTaskInfo "${taskName}"</code> — LastTaskResult and NumberOfMissedRuns.
    <br>2. <code>Microsoft-Windows-TaskScheduler/Operational</code> event log — why a run was skipped.
    <br>3. <code>logs/sync.log</code> — whether the run started and then failed.
  </p>
  <p style="color:#999;font-size:12px">
    Sent by the sync watchdog, which runs on its own schedule so it can still speak up
    when the sync itself does not.
  </p>
  </body></html>`;
}
