import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { sendReport } from './email.js';
import { readHeartbeat, checkStale, buildAlertHtml } from './heartbeat.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // No .env — sending will fail with a clear message if an alert is actually due.
}

// Same rule as the sync: the operator's address is configuration, not source.
const ALERT_TO = process.env.ERROR_ALERT_TO || process.env.REPORT_TO;
const ALERT_SUBJECT = 'YouTube playlist sync has not run';

export function parseWatchdogArgs(argv) {
  const opts = { maxAgeHours: 36, dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg.startsWith('--max-age-hours=')) {
      // Not `parseFloat(...) || default`: that turns an explicit 0 into the default.
      const n = parseFloat(arg.slice(16));
      if (Number.isFinite(n) && n >= 0) opts.maxAgeHours = n;
      else console.warn(`Ignoring unparseable --max-age-hours: ${arg}`);
    }
    else if (arg.startsWith('--')) console.warn(`Ignoring unknown flag: ${arg}`);
  }
  return opts;
}

/**
 * Alert only when the sync has gone quiet. Silence stays silent — the point is to
 * page on the absence of runs, not to add mail whose absence has to be noticed.
 */
async function main() {
  const opts = parseWatchdogArgs(process.argv.slice(2));
  const heartbeat = await readHeartbeat(STATE_DIR);
  const check = checkStale(heartbeat, new Date(), opts.maxAgeHours);

  console.log(`Watchdog: ${check.reason}.`);
  if (!check.stale) return;

  if (!ALERT_TO) {
    console.error('❌ Sync is stale but no recipient is configured — set ERROR_ALERT_TO in .env.');
    process.exitCode = 1;
    return;
  }

  if (opts.dryRun) {
    console.log(`(--dry-run) Would alert ${ALERT_TO}.`);
    return;
  }

  try {
    const from = await sendReport({
      to: ALERT_TO,
      subject: ALERT_SUBJECT,
      html: buildAlertHtml(heartbeat, check),
    });
    console.log(`⚠️  Alert emailed from ${from} to ${ALERT_TO}.`);
  } catch (err) {
    // Exit non-zero so the task's LastTaskResult shows the failure even when the
    // alert itself could not be delivered.
    console.error(`❌ Watchdog alert failed to send: ${err?.message || err}`);
    process.exitCode = 1;
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
