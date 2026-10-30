#!/usr/bin/env node
/**
 * make.js - every build, run and maintenance action this project has, in one place.
 *
 * `Makefile` and `build.ps1` are shims that forward here. They exist so the habitual
 * `make <target>` on macOS and `.\build.ps1 <target>` on Windows both work without
 * either platform installing something it does not ship: Windows has no make, macOS has
 * no PowerShell. Node is the only interpreter this project can already assume on both
 * (package.json pins >= 20.12), so it is the only place the logic can live without being
 * written twice in two languages and tested on one platform.
 *
 * Adding a target means adding one entry to GROUPS. `help` is rendered from that list,
 * so the printed menu cannot drift from what actually runs, and neither shim needs
 * touching.
 *
 * This file is tooling and imports nothing from src/ at load time - see channelParser()
 * for why the places that need src/ (it, verifyGoogleCredentials(), heartbeatLine() and
 * the list-channels target) import it lazily.
 *
 * @module make
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
// checks.js is deliberately NOT imported here - see loadChecks() below.

/** Repository root (this file lives there). */
const ROOT = path.dirname(fileURLToPath(import.meta.url));
/** Running on Windows (Task Scheduler, PowerShell). */
const IS_WINDOWS = process.platform === 'win32';
/** Running on macOS (launchd, sudo). */
const IS_MACOS = process.platform === 'darwin';

/** The local channel list. */
const CHANNELS = path.join(ROOT, 'config', 'channels.txt');
/** The tracked channel-list template. */
const CHANNELS_TEMPLATE = path.join(ROOT, 'config', 'channels.example.txt');
/** The local credentials and settings file. */
const ENV_FILE = path.join(ROOT, '.env');
/** The tracked .env template. */
const ENV_TEMPLATE = path.join(ROOT, '.env.example');
/** Watched ledgers and the heartbeat; never deleted by any target. */
const STATE_DIR = path.join(ROOT, 'state');
/** Wrapper logs. */
const LOG_DIR = path.join(ROOT, 'logs');
/** The last run's HTML report. */
const REPORT = path.join(ROOT, 'report.html');
/** The release history `release` edits. */
const VERSIONS_MD = path.join(ROOT, 'VERSIONS.md');
/** The feature manifest `release` edits. */
const FEATURES_YAML = path.join(ROOT, 'features.yaml');
/**
 * The release kit's archive name. Spelled out rather than taken from package.json's `name`,
 * because it is what someone downloads and unzips on a machine that knows nothing about npm.
 */
const KIT_NAME = 'youtube-playlists';
/** Where macOS LaunchDaemon plists are installed. */
const DAEMON_DIR = '/Library/LaunchDaemons';

/**
 * The two scheduled jobs, under the names each platform's scheduler knows them by.
 *
 * Identity only - no times. Those come from scheduleTimes(), which reads SYNC_AT and
 * WATCHDOG_AT out of .env and falls back to 03:00 with the watchdog six hours behind,
 * because a watchdog sharing the sync's schedule is silent in exactly the case it exists
 * to catch.
 */
const JOBS = {
  sync: {
    key: 'sync',
    label: 'local.youtube-playlists.sync',
    taskName: 'YouTube Playlist Sync',
    wrapper: IS_WINDOWS ? 'run-sync.cmd' : 'run-sync.sh',
  },
  watchdog: {
    key: 'watchdog',
    label: 'local.youtube-playlists.watchdog',
    taskName: 'YouTube Playlist Sync Watchdog',
    wrapper: IS_WINDOWS ? 'run-watchdog.cmd' : 'run-watchdog.sh',
  },
};

/**
 * What `clean` deletes. `state/` is deliberately absent and must stay absent: the
 * watched ledger lives there, and a deletion without that memory becomes a
 * delete/re-add loop costing 100 quota units per video per night, forever
 * (CLAUDE.md section 11). Exported so a test can assert it, because the day someone
 * adds "and state" to make clean tidy is the day that loop starts.
 */
export const CLEAN_PATHS = ['logs', 'report.html'];

/** A failure with a message worth printing on its own, rather than a stack trace. */
class Fail extends Error {}
/**
 * Stop the current target with a message for the user.
 *
 * @param {string} message - What went wrong and, ideally, what to do.
 * @returns {never}
 * @throws {Fail} Always.
 */
function fail(message) {
  throw new Fail(message);
}

/**
 * Load checks.js on demand rather than at the top of this file.
 *
 * It imports `yaml`, a devDependency, so a static import makes make.js itself unloadable
 * wherever dev dependencies were skipped - which is precisely the machine `from-release`
 * exists for. It runs `npm install --omit=dev`, so a static import left a release kit
 * unable to run the one target that sets it up: make.js failed to parse before any target
 * was even chosen, with a module-resolution stack rather than anything actionable.
 *
 * @returns {Promise<typeof import('./checks.js')>} The checks module.
 * @throws {Fail} When a dev dependency is missing (with instructions).
 * @throws {Error} Any other import failure.
 */
async function loadChecks() {
  try {
    return await import('./checks.js');
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      fail(
        'the checks need development dependencies, which are not installed here.\n' +
          '  Run `npm install` (without --omit=dev) to get them.\n' +
          '  A release kit installs runtime dependencies only, so `check`, `ci` and\n' +
          '  `release` are not available on a deployment machine - by design: the gate\n' +
          '  belongs on the machine the code is edited on.'
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------
// Running things
// ---------------------------------------------------------------------------------

/**
 * Run a command with the terminal attached, echoing it first. The echo is not decoration:
 * several targets invoke `sudo`, and seeing the exact command before being asked for a
 * password is what makes it reviewable rather than something to approve blind.
 *
 * @param {string} cmd - Executable.
 * @param {string[]} [args=[]] - Arguments (no shell is involved).
 * @param {object} [options]
 * @param {boolean} [options.check=true] - Fail on a non-zero exit.
 * @param {string} [options.cwd=ROOT] - Working directory.
 * @returns {number} The exit status (1 when the process was killed by a signal).
 * @throws {Fail} When the command cannot start, or exits non-zero with `check` on.
 */
function run(cmd, args = [], { check = true, cwd = ROOT } = {}) {
  console.log(`\n$ ${[cmd, ...args].join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.error) fail(`could not run ${cmd}: ${r.error.message}`);
  if (check && r.status !== 0) fail(`${cmd} exited ${r.status}`);
  return r.status ?? 1;
}

/**
 * Same, but capture the output instead of showing it. For probing, never for work.
 *
 * @param {string} cmd - Executable.
 * @param {string[]} [args=[]] - Arguments.
 * @returns {{status: ?number, out: string, error: (Error|undefined)}} Exit status,
 *   stdout and stderr joined and trimmed, and the spawn error if it could not start.
 */
function capture(cmd, args = []) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), error: r.error };
}

/**
 * Run the tool itself. process.execPath rather than "node" for the same reason the
 * launchd wrappers resolve node by hand: it is the interpreter already running, so it
 * cannot be a different or missing one.
 *
 * @param {string[]} args - Script path and its arguments.
 * @returns {number} The exit status.
 * @throws {Fail} When node exits non-zero.
 */
function node(args) {
  return run(process.execPath, args);
}

/**
 * Delegate to an npm script, so package.json stays the single definition of what
 * linting and testing mean - change it there and `make lint` follows.
 *
 * shell:true on Windows because Node >= 18.20 refuses to spawn a .cmd (npm's Windows
 * entry point) without it; the arguments here are fixed strings, so nothing is
 * interpolated into that shell.
 *
 * @param {string} script - An npm script name (or `install`).
 * @returns {number} 0 on success.
 * @throws {Fail} When npm cannot start or exits non-zero.
 */
function npmScript(script) {
  if (!IS_WINDOWS) return run('npm', ['run', script]);
  console.log(`\n$ npm run ${script}`);
  // A command string, not an args array: shell:true with an args array is deprecated in
  // current Node (DEP0190). The script name is one of our own fixed strings.
  const r = spawnSync(`npm run ${script}`, { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.error) fail(`could not run npm: ${r.error.message}`);
  if (r.status !== 0) fail(`npm run ${script} exited ${r.status}`);
  return 0;
}

/**
 * Quote a string for a PowerShell single-quoted literal.
 *
 * @param {*} s - Value to quote (stringified first).
 * @returns {string} `'...'` with embedded single quotes doubled.
 */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/**
 * Run a PowerShell command line (Windows), without the user's profile and with the
 * execution policy bypassed for this one call.
 *
 * @param {string} script - The command text; quote values with {@link psQuote}.
 * @returns {number} The exit status.
 * @throws {Fail} When PowerShell cannot start or exits non-zero.
 */
function powershell(script) {
  return run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
}

// ---------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------

/**
 * Turn the words after a target name into arguments for src/index.js.
 *
 *   "@Handle"     passes through - a channel
 *   --report-watched   passes through - already a flag
 *   max=1         becomes --max=1
 *
 * The bare `key=value` spelling exists because a raw `--flag` cannot survive a make
 * command line: make claims those for itself. Two of them fail silently and both are
 * safety flags, which is why this is a supported spelling rather than a convenience -
 * see guardMakeAteFlags() below.
 *
 * @param {string[]} words - Words after the target name.
 * @returns {string[]} The same words, with `key=value` turned into `--key=value`.
 */
export function toCliArgs(words) {
  return words.map((w) => (/^[A-Za-z][A-Za-z0-9-]*=/.test(w) ? `--${w}` : w));
}

/**
 * Refuse to run when make has eaten a tool flag.
 *
 * `make run --dry-run` does not pass --dry-run to anything: make takes it as its own
 * -n, prints the recipe and executes nothing, which reads as a dry run that worked.
 * `make dry-run max=1 --max=1` is worse - make matches --max as an abbreviation of its
 * own --max-load and silently becomes `-l 1`, so the cap on writes against a live
 * account quietly disappears. Both leave MAKEFLAGS carrying the letter make kept.
 *
 * The Makefile marks the recipe with `+` so it still runs under -n; this is what it
 * runs for, turning a plausible-looking no-op into an error that names the fix.
 *
 * @param {?string} makeflags - The MAKEFLAGS environment variable.
 * @returns {string[]} A description of each tool flag make swallowed; empty when none.
 */
export function eatenMakeFlags(makeflags) {
  const letters = String(makeflags || '').trim().split(/\s+/)[0] || '';
  if (!letters || letters.includes('=')) return []; // a variable assignment, not options
  return [
    ...(letters.includes('n') ? ['--dry-run (make read it as its own -n)'] : []),
    ...(letters.includes('l') ? ['--max=N (make read it as its own -l N)'] : []),
  ];
}

/**
 * Fail when MAKEFLAGS shows make swallowed `--dry-run` or `--max`; see
 * {@link eatenMakeFlags}.
 *
 * @returns {void}
 * @throws {Fail} When a flag was swallowed.
 */
function guardMakeAteFlags() {
  const eaten = eatenMakeFlags(process.env.MAKEFLAGS);
  if (!eaten.length) return;
  fail(
    `make consumed a flag meant for this tool:\n  ${eaten.join('\n  ')}\n` +
      'Raw --flags cannot be written on a make command line. Use the key=value form\n' +
      "(make dry-run max=1), a dedicated target, or ARGS='...' for anything else."
  );
}

// ---------------------------------------------------------------------------------
// Small filesystem helpers
// ---------------------------------------------------------------------------------

/**
 * Whether a path exists.
 *
 * @param {string} p - Absolute path.
 * @returns {boolean} True when it exists.
 */
const exists = (p) => fs.existsSync(p);
/**
 * A path relative to the repository root, for messages.
 *
 * @param {string} p - Absolute path.
 * @returns {string} The relative path, or `.` for the root itself.
 */
const rel = (p) => path.relative(ROOT, p) || '.';

/**
 * The line ending a file already uses. AGENTS.md: the working tree is deliberately
 * mixed and git normalizes on checkout, so rewriting a file's endings as a side effect
 * turns a one-line change into a whole-file diff.
 *
 * @param {string} content - File text.
 * @returns {string} `\r\n` when the file contains any CRLF, else `\n`.
 */
function eolOf(content) {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Copy a template into place unless the target already exists.
 *
 * @param {string} from - Template path.
 * @param {string} to - Destination path.
 * @param {string} what - What the user should do with the new file, for the message.
 * @returns {string} One line saying what happened.
 * @throws {Fail} When the template is missing.
 */
function copyIfMissing(from, to, what) {
  if (exists(to)) return `${rel(to)} already exists, left alone`;
  if (!exists(from)) fail(`missing template ${rel(from)}`);
  fs.copyFileSync(from, to);
  return `created ${rel(to)} from ${rel(from)} - ${what}`;
}

// ---------------------------------------------------------------------------------
// config/channels.txt editing
// ---------------------------------------------------------------------------------

/**
 * src/index.js pulls in googleapis, which costs about a second to load. Importing it at
 * the top of this file would put that second in front of `make help` and `make lint`,
 * so the two targets that genuinely need the project's own parser import it lazily.
 * Reusing parseChannelSpec is the point: add-channel validates a line with exactly the
 * code that will read it at 3 AM, rather than a second, subtly different parser.
 *
 * @returns {Promise<(line: string) => object>} src/index.js's parseChannelSpec.
 */
async function channelParser() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'index.js')).href);
  return mod.parseChannelSpec;
}

/**
 * Read config/channels.txt.
 *
 * @returns {string} Its text.
 * @throws {Fail} When it does not exist yet (with the setup command to run).
 */
function readChannels() {
  if (!exists(CHANNELS)) {
    fail(`no ${rel(CHANNELS)} yet - run \`${invocation()} setup\` first`);
  }
  return fs.readFileSync(CHANNELS, 'utf8');
}

/**
 * The handle a channel line names, lowercased and without its @, or null for a comment.
 *
 * @param {string} line - One line of the channel list.
 * @returns {?string} The handle, or null for a blank or `#` line.
 */
export function handleOf(line) {
  const t = String(line).trim();
  if (!t || t.startsWith('#')) return null;
  return t.split(/\s+/)[0].replace(/^@/, '').toLowerCase();
}

/**
 * Every channel line in the file, in order, with its 1-based line number.
 *
 * @param {string} content - channels.txt text.
 * @returns {Array<{text: string, lineNo: number, handle: string}>} Non-comment lines only.
 */
export function channelLines(content) {
  return content
    .split(/\r?\n/)
    .map((text, i) => ({ text, lineNo: i + 1, handle: handleOf(text) }))
    .filter((l) => l.handle !== null);
}

/**
 * Drop every line naming `handle`. Returns the new content and what was removed, so the
 * caller can print the removed line verbatim: the settings on it (`after=`, a custom
 * `shorts-title=`) are not recoverable from anywhere else once the line is gone.
 *
 * @param {string} content - channels.txt text.
 * @param {string} handle - Handle to drop, with or without `@` (case-insensitive).
 * @returns {{content: string, removed: string[]}} The new text, in the file's own line
 *   ending, and the trimmed lines removed.
 */
export function removeChannel(content, handle) {
  const want = String(handle).replace(/^@/, '').toLowerCase();
  const eol = eolOf(content);
  const removed = [];
  const kept = content.split(/\r?\n/).filter((text) => {
    if (handleOf(text) !== want) return true;
    removed.push(text.trim());
    return false;
  });
  return { content: kept.join(eol), removed };
}

// ---------------------------------------------------------------------------------
// .env editing
// ---------------------------------------------------------------------------------

/**
 * Set one key in a .env file, in place. Returns the new content.
 *
 * Rewrites the key's line where it already exists and appends otherwise, leaving every
 * other line - comments included - exactly as it was. That matters more here than it
 * looks: .env is the only copy of the OAuth refresh token on this machine, and a helper
 * that regenerated the file from parsed key/value pairs would quietly drop the comments
 * that say what each key is for.
 *
 * @param {string} content - .env text.
 * @param {string} key - Variable name; used in a regular expression, so plain identifiers only.
 * @param {string} value - Value to store.
 * @returns {string} The new .env text.
 */
export function setEnvValue(content, key, value) {
  const eol = eolOf(content);
  const re = new RegExp(`^(\\s*${key}\\s*=).*$`, 'm');
  // A replacer function, not a string: in a replacement string `$&`, `$1` and `$'` are
  // patterns, so a value containing one would be rewritten on its way into .env.
  if (re.test(content)) return content.replace(re, () => `${key}=${value}`);
  const body = content && !content.endsWith(eol) ? content + eol : content;
  return `${body}${key}=${value}${eol}`;
}

/**
 * Read one key out of a .env file without loading the rest into this process.
 *
 * @param {string} content - .env text.
 * @param {string} key - Variable name.
 * @returns {?string} The value with one layer of surrounding quotes removed, or null
 *   when the key is absent.
 */
export function getEnvValue(content, key) {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm').exec(String(content));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

/**
 * An address, checked only for the shape that would silently fail to deliver. This is
 * not an RFC validator and does not try to be: the real test is whether mail arrives,
 * and the failure worth catching here is a typo like a missing @ that would otherwise
 * surface as a Graph error at 3 AM in a log nobody reads.
 *
 * @param {string} address - Candidate address.
 * @returns {boolean} True for the shape `name@example.com`, with no whitespace.
 */
export function validEmail(address) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(address).trim());
}

/**
 * A four-digit 24-hour time, `HHMM`, as {hour, minute}.
 *
 * Four digits rather than `HH:MM` because it is the only spelling that survives every
 * shell this project is driven from, and that consistency is the point: a colon is a rule
 * separator to make, so `make change-run-time 04:30` dies with "multiple target patterns"
 * while the Makefile is still being parsed - before any of this code runs, so it cannot be
 * reported from here with a useful message. Quoting does not help either: the shell strips
 * the quotes before make ever sees the word. Verified for "04:30", '04:30' and 04\:30.
 *
 * Zero-padded `HH:MM` is still accepted, because it is what people type and it is harmless
 * wherever the shell allows it. It is simply not what the docs teach - and the tolerance is
 * narrower than "HH:MM" suggests: `4:30` and `430` are both rejected, so a time is always
 * four digits whether or not it carries a colon.
 *
 * @param {string} text - `HHMM` or `HH:MM`.
 * @returns {{hour: number, minute: number}} The parsed time.
 * @throws {Fail} When it is not a valid four-digit 24-hour time.
 */
export function parseClock(text) {
  const m = /^([01]\d|2[0-3]):?([0-5]\d)$/.exec(String(text).trim());
  if (!m) {
    fail(`"${text}" is not a time. Use four-digit 24-hour HHMM, e.g. 0430 or 1500.`);
  }
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/**
 * Format a time as `HH:MM`, the form .env and the schedulers use.
 *
 * @param {{hour: number, minute: number}} time - The time.
 * @returns {string} Zero-padded `HH:MM`.
 */
const clockString = ({ hour, minute }) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

/**
 * The watchdog's time, six hours after the sync's.
 *
 * The gap is the whole point of the watchdog, not a detail: sharing the sync's schedule
 * makes it silent in exactly the case it exists to catch, and the gap also lets a slow or
 * retrying sync finish before its heartbeat is judged. So moving the sync moves the
 * watchdog with it rather than leaving the two to collide.
 *
 * @param {{hour: number, minute: number}} time - The sync's time.
 * @returns {{hour: number, minute: number}} Six hours later, wrapping past midnight.
 */
export function watchdogTime({ hour, minute }) {
  return { hour: (hour + 6) % 24, minute };
}

/**
 * Point a rendered plist at a different time of day.
 *
 * Done by substitution rather than by adding __SYNC_HOUR__ placeholders to the templates,
 * because the README documents installing them by hand with `sed` on the two placeholders
 * that exist. A third would leave that documented path producing a plist with a literal
 * __SYNC_HOUR__ in it, which launchd rejects while complaining about the file.
 *
 * @param {string} xml - Plist text.
 * @param {{hour: number, minute: number}} time - New run time.
 * @returns {string} The plist with Hour and Minute inside StartCalendarInterval replaced.
 */
export function setPlistTime(xml, { hour, minute }) {
  return xml.replace(
    /(<key>StartCalendarInterval<\/key>\s*<dict>)([\s\S]*?)(<\/dict>)/,
    (_all, open, body, close) =>
      open +
      body
        .replace(/(<key>Hour<\/key>\s*<integer>)\d+(<\/integer>)/, `$1${hour}$2`)
        .replace(/(<key>Minute<\/key>\s*<integer>)\d+(<\/integer>)/, `$1${minute}$2`) +
      close
  );
}

/**
 * The configured run times, falling back to the defaults the templates carry.
 *
 * @returns {{sync: {hour: number, minute: number}, watchdog: {hour: number, minute: number}}}
 *   SYNC_AT / WATCHDOG_AT from .env; 03:00 and six hours later by default.
 * @throws {Fail} When a configured time is malformed.
 */
function scheduleTimes() {
  const env = exists(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const sync = getEnvValue(env, 'SYNC_AT');
  const syncAt = sync ? parseClock(sync) : { hour: 3, minute: 0 };
  const watchdog = getEnvValue(env, 'WATCHDOG_AT');
  return { sync: syncAt, watchdog: watchdog ? parseClock(watchdog) : watchdogTime(syncAt) };
}

// ---------------------------------------------------------------------------------
// Scheduled jobs
// ---------------------------------------------------------------------------------

/**
 * Fail on a platform with neither launchd nor Task Scheduler.
 *
 * @param {string} action - Target name, for the message.
 * @returns {void}
 * @throws {Fail} On anything but macOS or Windows.
 */
function requireKnownPlatform(action) {
  if (!IS_MACOS && !IS_WINDOWS) {
    fail(
      `${action} knows launchd (macOS) and Task Scheduler (Windows), not ${process.platform}.\n` +
        'Schedule run-sync.sh yourself - the only requirement is that it runs whether or ' +
        'not anyone is logged in.'
    );
  }
}

/**
 * Refuse an unclaim while this machine is still scheduled to sync.
 *
 * Giving the account up and leaving the job installed undoes itself: tonight's run finds
 * no marker of its own and creates one, at 50 units, and the machine you were handing
 * over to finds the account claimed again. The order that works is uninstall, then
 * unclaim - so this names it rather than letting the sequence look like it worked.
 *
 * @param {string} action - Target name, for the message.
 * @returns {void}
 * @throws {Fail} When the nightly sync job is installed.
 */
function requireNotScheduled(action) {
  const installed = IS_MACOS
    ? exists(`${DAEMON_DIR}/${JOBS.sync.label}.plist`)
    : IS_WINDOWS &&
      capture('powershell.exe', [
        '-NoProfile',
        '-Command',
        `if (Get-ScheduledTask -TaskName ${psQuote(JOBS.sync.taskName)} -ErrorAction SilentlyContinue) { 'yes' }`,
      ]).out === 'yes';
  if (!installed) return;
  fail(
    `${action} refused: the nightly sync is still installed on this machine, so tonight\u2019s\n` +
      'run would claim the account straight back at 50 quota units.\n' +
      `Run \`${invocation()} uninstall\` first, or use \`npm start -- --unclaim-sync\` to override.`
  );
}

/**
 * Fill a launchd plist template. The placeholders are the two the templates document.
 *
 * @param {string} template - Plist template text.
 * @param {{repoDir: string, user: string}} values - Repository path and the account to run as.
 * @returns {string} The plist with `__REPO_DIR__` and `__RUN_AS_USER__` replaced.
 */
export function renderPlist(template, { repoDir, user }) {
  return template.replace(/__REPO_DIR__/g, repoDir).replace(/__RUN_AS_USER__/g, user);
}

/**
 * Install (or reinstall) both LaunchDaemons via sudo, at the configured times.
 *
 * @returns {void}
 * @throws {Fail} When a wrapper is missing or a sudo step fails.
 */
function installMac() {
  const user = os.userInfo().username;
  const times = scheduleTimes();
  // launchd opens StandardOutPath before exec, so a missing logs/ fails the job with an
  // error about the path rather than about the job.
  fs.mkdirSync(LOG_DIR, { recursive: true });

  for (const job of Object.values(JOBS)) {
    const wrapper = path.join(ROOT, job.wrapper);
    if (!exists(wrapper)) fail(`missing ${job.wrapper}`);
    // A clone made on Windows loses the exec bit, and launchd's complaint names the
    // path, not the permission.
    fs.chmodSync(wrapper, 0o755);

    const template = fs.readFileSync(path.join(ROOT, 'launchd', `${job.label}.plist`), 'utf8');
    const staged = path.join(os.tmpdir(), `${job.label}.plist`);
    const at = job.key === 'sync' ? times.sync : times.watchdog;
    fs.writeFileSync(staged, setPlistTime(renderPlist(template, { repoDir: ROOT, user }), at));
    const dest = `${DAEMON_DIR}/${job.label}.plist`;

    // Unload an existing copy first so install is repeatable; bootstrap refuses a label
    // that is already loaded, and that refusal looks like the install failing.
    run('sudo', ['launchctl', 'bootout', `system/${job.label}`], { check: false });
    // /Library/LaunchDaemons must be root:wheel 644 or launchd rejects the job while
    // complaining about the path's ownership. install sets all three in one step.
    run('sudo', ['install', '-o', 'root', '-g', 'wheel', '-m', '644', staged, dest]);
    run('sudo', ['launchctl', 'bootstrap', 'system', dest]);
    fs.rmSync(staged, { force: true });
  }
  console.log(
    `\nInstalled as LaunchDaemons running as ${user}: sync ${clockString(times.sync)}, ` +
      `watchdog ${clockString(times.watchdog)}.`
  );
  console.log('A Mac asleep at 3 AM still syncs at the next wake; one powered off does not.');
  console.log('  sudo pmset repeat wakeorpoweron MTWRFSU 02:55:00   # if it sleeps');
}

/**
 * Register (or re-register) both scheduled tasks, at the configured times.
 *
 * @returns {void}
 * @throws {Fail} When PowerShell fails.
 */
function installWindows() {
  const times = scheduleTimes();
  // -LogonType S4U is the load-bearing part: a task registered to run only when the user
  // is logged on is silently skipped on every night nobody is signed in - no log, no
  // error, no report, indistinguishable from the sync failing. -Force makes this
  // repeatable rather than erroring on a task that already exists.
  for (const job of Object.values(JOBS)) {
    const exe = path.join(ROOT, job.wrapper);
    const at = clockString(job.key === 'sync' ? times.sync : times.watchdog);
    powershell(
      "$ErrorActionPreference='Stop'; " +
        `$a = New-ScheduledTaskAction -Execute ${psQuote(exe)} -WorkingDirectory ${psQuote(ROOT)}; ` +
        `$t = New-ScheduledTaskTrigger -Daily -At ${psQuote(at)}; ` +
        `Register-ScheduledTask -TaskName ${psQuote(job.taskName)} -Action $a -Trigger $t ` +
        '-User $env:USERNAME -LogonType S4U -Force | Out-Null'
    );
  }
  console.log(
    `\nRegistered: "${JOBS.sync.taskName}" ${clockString(times.sync)}, ` +
      `"${JOBS.watchdog.taskName}" ${clockString(times.watchdog)}.`
  );
  console.log('The machine has to be awake at 3 AM; the task can wake it, not power it on.');
}

/**
 * Unload and delete both LaunchDaemons via sudo. state/ and logs/ are left alone.
 *
 * @returns {void}
 * @throws {Fail} When deleting a plist fails.
 */
function uninstallMac() {
  for (const job of Object.values(JOBS)) {
    run('sudo', ['launchctl', 'bootout', `system/${job.label}`], { check: false });
    run('sudo', ['rm', '-f', `${DAEMON_DIR}/${job.label}.plist`]);
  }
  console.log('\nBoth daemons removed. state/ and logs/ are untouched.');
}

/**
 * Unregister both scheduled tasks. state\ and logs\ are left alone.
 *
 * @returns {void}
 * @throws {Fail} When PowerShell fails.
 */
function uninstallWindows() {
  for (const job of Object.values(JOBS)) {
    powershell(
      `Unregister-ScheduledTask -TaskName ${psQuote(job.taskName)} -Confirm:$false ` +
        '-ErrorAction SilentlyContinue'
    );
  }
  console.log('\nBoth tasks removed. state\\ and logs\\ are untouched.');
}

// ---------------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------------
//
// One entry per target: { name, args, summary, run }. `help` is rendered from this
// list, so a target that exists is a target that is documented.

/**
 * How this tool is invoked on the platform running it, for help text and messages.
 *
 * @param {string} [platform=process.platform] - A `process.platform` value.
 * @returns {string} `.\build.ps1` on Windows, `make` elsewhere.
 */
export function invocation(platform = process.platform) {
  return platform === 'win32' ? '.\\build.ps1' : 'make';
}

/** Credentials the tool cannot run without, and the ones only email needs. */
/** Google credentials a sync cannot run without. */
const REQUIRED_ENV = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
/** Variables only the report email needs. */
const EMAIL_ENV = ['MS365_TENANT_ID', 'MS365_CLIENT_ID', 'MS365_CLIENT_SECRET', 'MS365_FROM_ADDRESS', 'REPORT_TO'];

/**
 * Which keys in a .env file have a non-empty value. Names only - this repo is public
 * (CLAUDE.md section 12) and doctor's output is the kind of thing that gets pasted into
 * an issue, so no value ever leaves this function.
 *
 * @param {string} content - .env text.
 * @returns {Set<string>} Names of keys with a non-empty (unquoted) value.
 */
export function envKeysSet(content) {
  const set = new Set();
  for (const line of String(content).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && m[2].trim().replace(/^["']|["']$/g, '')) set.add(m[1]);
  }
  return set;
}

/**
 * Key -> value from a .env-style file. envKeysSet's sibling, keeping the values.
 *
 * @param {string} content - .env text.
 * @returns {Map<string, string>} Every key, with one layer of surrounding quotes removed.
 */
export function envValues(content) {
  const out = new Map();
  for (const line of String(content).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) out.set(m[1], m[2].trim().replace(/^["']|["']$/g, ''));
  }
  return out;
}

/**
 * Which of `keys` still carry the value .env.example ships.
 *
 * A placeholder is defined as "identical to what the template says" rather than as
 * anything that looks suspicious. That needs no judgement about what a real client id
 * resembles, and it cannot drift: change the template and this follows automatically.
 *
 * It matters because `from-release` and `setup` both create .env by copying the template,
 * so every variable is non-empty from the moment the file exists. Checking that a value
 * is set therefore proves nothing at all on a fresh machine - which is exactly the machine
 * about to be handed a 3 AM scheduled task.
 *
 * @param {string} envText - .env text.
 * @param {string} exampleText - .env.example text.
 * @param {string[]} keys - Keys to test.
 * @returns {string[]} The keys whose non-empty value equals the template's.
 */
export function placeholderKeys(envText, exampleText, keys) {
  const env = envValues(envText);
  const example = envValues(exampleText);
  return keys.filter((k) => {
    const v = env.get(k);
    return Boolean(v) && example.has(k) && v === example.get(k);
  });
}

/**
 * Turn an OAuth failure into something worth acting on. The raw errors name a field in a
 * JSON body, which does not tell someone standing at a new machine what to do next.
 *
 * @param {*} err - Error from the OAuth token exchange.
 * @returns {string} An actionable reason, or the raw message when none matches.
 */
export function oauthReason(err) {
  const msg = String(err?.response?.data?.error_description || err?.response?.data?.error || err?.message || err);
  if (/invalid_grant/i.test(msg)) {
    return 'the refresh token is expired, revoked, or belongs to a different client - run `authorize` again';
  }
  if (/invalid_client|unauthorized_client/i.test(msg)) {
    return 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not a valid pair for this project';
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|socket hang up/i.test(msg)) {
    return `cannot reach Google's OAuth endpoint (${msg})`;
  }
  return msg;
}

/**
 * Prove the Google credentials are real, by exchanging the refresh token for an access
 * token.
 *
 * This hits the OAuth token endpoint, which costs NO YouTube Data API quota - the same
 * property test/credentials.test.js relies on - so it is safe to run on every doctor and
 * before every install. It is also the strongest check available without spending quota:
 * it proves the client id, the secret and the refresh token are a working set, not merely
 * three non-empty strings.
 *
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>} Whether the exchange worked.
 */
async function verifyGoogleCredentials() {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    // A missing or unreadable .env is reported by the caller, which knows more about it.
  }
  try {
    const { getAuthorizedClient } = await import('./src/auth.js');
    const auth = await getAuthorizedClient();
    const res = await auth.getAccessToken();
    if (!res?.token) return { ok: false, reason: 'the OAuth token endpoint returned no access token' };
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: oauthReason(err) };
  }
}

/**
 * Refuse to schedule a job whose credentials have never been shown to work.
 *
 * This is the one check that has to be a gate rather than a report. Everything else here
 * is run by someone who is watching; a scheduled task runs at 3 AM at a machine nobody is
 * sitting at, and a credential failure there is silent - the sync exits, no report is
 * written, and the only signal is the watchdog 36 hours later. Installing is the last
 * moment a person is present to be told.
 *
 * Email credentials deliberately do NOT gate: without them the run still does its work and
 * writes report.html, so a missing mailbox is a degraded feature and not a dead job.
 *
 * @returns {Promise<void>}
 * @throws {Fail} When .env is missing, a Google key is unset or still the placeholder,
 *   or the token exchange fails.
 */
async function requireRealGoogleCredentials() {
  if (!exists(ENV_FILE)) {
    fail(`no .env - run \`${invocation()} from-release\` (or \`setup\`), then fill in the Google credentials.`);
  }
  const envText = fs.readFileSync(ENV_FILE, 'utf8');
  const set = envKeysSet(envText);
  const missing = REQUIRED_ENV.filter((k) => !set.has(k));
  if (missing.length) {
    fail(
      `${missing.join(', ')} is not set in .env.\n` +
        '  The nightly job cannot authenticate without it, and would fail silently at 3 AM.'
    );
  }

  const exampleText = exists(ENV_TEMPLATE) ? fs.readFileSync(ENV_TEMPLATE, 'utf8') : '';
  const stillTemplate = placeholderKeys(envText, exampleText, REQUIRED_ENV);
  if (stillTemplate.length) {
    fail(
      `${stillTemplate.join(', ')} still hold the values from .env.example.\n` +
        '  .env is created by copying that template, so every variable is non-empty from\n' +
        '  the start - being "set" is not evidence of anything. Fill these in, then run\n' +
        `  \`${invocation()} authorize\`.`
    );
  }

  console.log('\n  Checking the YouTube credentials actually work (no quota is spent) ...');
  const google = await verifyGoogleCredentials();
  if (!google.ok) {
    fail(
      `the Google credentials do not work: ${google.reason}\n\n` +
        '  Nothing has been scheduled. A job installed now would fail every night at 3 AM\n' +
        '  without sending anything, because the report is only mailed after a run that\n' +
        `  authenticated. Fix the credentials, confirm with \`${invocation()} doctor\`, then\n` +
        '  install again.'
    );
  }
  console.log('  Credentials verified.');
}

/**
 * Refuse to schedule a job that has nothing to do.
 *
 * Same shape as the placeholder credentials: config/channels.txt is created by copying
 * config/channels.example.txt, and every example in it is commented out, so an untouched
 * file is valid, parses cleanly and syncs nothing at all. A scheduled task on top of it
 * runs every night, succeeds, reports zero channels and looks entirely healthy - and the
 * watchdog stays quiet, because the sync really did finish.
 *
 * @returns {Promise<void>}
 * @throws {Fail} When channels.txt is missing, has no channel lines, or has a line the
 *   tool's own parser rejects.
 */
async function requireAtLeastOneChannel() {
  if (!exists(CHANNELS)) {
    fail(
      `no ${rel(CHANNELS)} - run \`${invocation()} from-release\` (or \`setup\`), then add a channel with\n` +
        `  \`${invocation()} add-channel "@Handle"\`.`
    );
  }
  const lines = channelLines(fs.readFileSync(CHANNELS, 'utf8'));
  if (!lines.length) {
    fail(
      `${rel(CHANNELS)} has no channels in it.\n` +
        '  It is copied from the template, whose examples are all commented out, so an\n' +
        '  untouched file is valid and syncs nothing. A job scheduled on it would run every\n' +
        '  night, do no work, and report success - the watchdog would never fire.\n' +
        `  Add one with \`${invocation()} add-channel "@Handle"\`.`
    );
  }
  // Parse with the tool's own parser: a malformed line is fatal at 3 AM.
  const parse = await channelParser();
  for (const l of lines) {
    try {
      parse(l.text.trim());
    } catch (err) {
      fail(`${rel(CHANNELS)} line ${l.lineNo}: ${err.message.split('\n')[0]}`);
    }
  }
  console.log(`  ${lines.length} channel${lines.length === 1 ? '' : 's'} configured.`);
}

/**
 * Node's own version against the floor in package.json engines.
 *
 * @param {string} current - Running version, e.g. `v20.12.0`.
 * @param {string} required - The engines range, e.g. `>=20.12.0` (only the number is read).
 * @returns {boolean} True when `current` is at or above the floor.
 */
export function meetsEngine(current, required) {
  const want = String(required).replace(/^[^\d]*/, '').split('.').map(Number);
  const have = String(current).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < want.length; i++) {
    if ((have[i] || 0) > (want[i] || 0)) return true;
    if ((have[i] || 0) < (want[i] || 0)) return false;
  }
  return true;
}

/**
 * One `doctor` result line.
 *
 * @typedef {object} DoctorCheck
 * @property {'ok'|'warn'|'bad'} level - `bad` fails doctor.
 * @property {string} label - What was checked.
 * @property {string} detail - What was found.
 */

/**
 * A passing doctor line.
 *
 * @param {string} label - What was checked.
 * @param {string} detail - What was found.
 * @returns {DoctorCheck} Level `ok`.
 */
function ok(label, detail) {
  return { level: 'ok', label, detail };
}
/**
 * A doctor line worth reading that does not fail.
 *
 * @param {string} label - What was checked.
 * @param {string} detail - What was found.
 * @returns {DoctorCheck} Level `warn`.
 */
function warn(label, detail) {
  return { level: 'warn', label, detail };
}
/**
 * A failing doctor line.
 *
 * @param {string} label - What was checked.
 * @param {string} detail - What was found.
 * @returns {DoctorCheck} Level `bad`.
 */
function bad(label, detail) {
  return { level: 'bad', label, detail };
}

/**
 * Everything `doctor` checks: Node, dependencies, .env (including a live, quota-free
 * token exchange), the channel list, the ledger directory and the git hook.
 *
 * @returns {Promise<DoctorCheck[]>} One line per check, in display order.
 */
async function doctorChecks() {
  const checks = [];
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const floor = pkg.engines?.node || '>=20.12.0';

  checks.push(
    meetsEngine(process.version, floor)
      ? ok('node', `${process.version} (needs ${floor})`)
      : bad('node', `${process.version} is below ${floor}`)
  );

  checks.push(
    exists(path.join(ROOT, 'node_modules'))
      ? ok('dependencies', 'node_modules present')
      : bad('dependencies', `not installed - run \`${invocation()} setup\``)
  );

  if (!exists(ENV_FILE)) {
    checks.push(bad('.env', `missing - run \`${invocation()} setup\`, then fill it in`));
  } else {
    const envText = fs.readFileSync(ENV_FILE, 'utf8');
    const set = envKeysSet(envText);
    const exampleText = exists(ENV_TEMPLATE) ? fs.readFileSync(ENV_TEMPLATE, 'utf8') : '';

    const missing = REQUIRED_ENV.filter((k) => !set.has(k));
    const stillTemplate = placeholderKeys(envText, exampleText, REQUIRED_ENV);
    if (missing.length) {
      checks.push(bad('.env credentials', `${missing.join(', ')} not set`));
    } else if (stillTemplate.length) {
      // .env is created by copying .env.example, so "set" is the default state of every
      // variable. Saying so is the difference between "Ready" and the truth.
      checks.push(
        bad('.env credentials', `${stillTemplate.join(', ')} still hold the .env.example placeholder - fill them in`)
      );
    } else {
      checks.push(ok('.env credentials', 'Google client id, secret and refresh token set'));
    }

    // The live proof. Costs no YouTube quota, and is the only check here that can tell a
    // plausible-looking credential from a working one.
    if (!missing.length && !stillTemplate.length) {
      const google = await verifyGoogleCredentials();
      checks.push(
        google.ok
          ? ok('youtube auth', 'refresh token exchanges for an access token')
          : bad('youtube auth', google.reason)
      );
    } else {
      checks.push(warn('youtube auth', 'not checked - fill the Google credentials in first'));
    }

    const noMail = EMAIL_ENV.filter((k) => !set.has(k));
    const mailTemplate = placeholderKeys(envText, exampleText, EMAIL_ENV);
    checks.push(
      noMail.length
        ? warn('.env email', `${noMail.join(', ')} not set - the report will not be emailed`)
        : mailTemplate.length
          ? warn('.env email', `${mailTemplate.join(', ')} still hold placeholders - the report will not be emailed`)
          : ok('.env email', 'Microsoft Graph sender and recipient set')
    );
  }

  if (!exists(CHANNELS)) {
    checks.push(bad('channel list', `no ${rel(CHANNELS)} - run \`${invocation()} setup\``));
  } else {
    // Parse with the tool's own parser: a malformed line is fatal at 3 AM, and finding
    // that out here costs nothing while finding it out then costs a night.
    try {
      const parse = await channelParser();
      const lines = channelLines(fs.readFileSync(CHANNELS, 'utf8'));
      for (const l of lines) parse(l.text.trim());
      // Zero is not a passing state. channels.txt is copied from the template, whose
      // examples are all commented, so an untouched file parses perfectly and syncs
      // nothing - which reads as "all lines parse" unless it is called out.
      checks.push(
        lines.length
          ? ok('channel list', `${lines.length} channel${lines.length === 1 ? '' : 's'}, all lines parse`)
          : bad('channel list', `no channels yet - add one with \`${invocation()} add-channel "@Handle"\``)
      );
    } catch (err) {
      checks.push(bad('channel list', err.message.split('\n')[0]));
    }
  }

  const ledgers = exists(STATE_DIR) ? fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json')) : [];
  checks.push(
    exists(STATE_DIR)
      ? ok('watched ledger', `state/ holds ${ledgers.length} file${ledgers.length === 1 ? '' : 's'}`)
      : warn('watched ledger', 'state/ does not exist yet - the first run creates it')
  );

  // A release kit is an export of tracked files, so it has no .git and no push to hook.
  // Advising `setup` there sends someone to a command that fails on a directory that is
  // not a repository, in the one workflow least equipped to tell that from a real problem.
  if (!exists(path.join(ROOT, '.git'))) {
    checks.push(ok('git hooks', 'not a git checkout - no pre-push hook needed here'));
  } else {
    const hooks = capture('git', ['config', 'core.hooksPath']).out;
    checks.push(
      hooks === '.githooks'
        ? ok('git hooks', 'pre-push runs lint and tests')
        : warn('git hooks', `core.hooksPath is "${hooks || 'unset'}" - run \`${invocation()} setup\``)
    );
  }

  return checks;
}

/**
 * The heartbeat, read the way the watchdog reads it.
 *
 * @returns {Promise<string>} `ok: ...` or `STALE: ...`, with the last run's counts.
 */
async function heartbeatLine() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'heartbeat.js')).href);
  const hb = await mod.readHeartbeat(STATE_DIR);
  const check = mod.checkStale(hb, new Date());
  const counts = hb ? ` (${hb.channels ?? '?'} channels, +${hb.added ?? 0} added, -${hb.removed ?? 0} removed)` : '';
  return `${check.stale ? 'STALE' : 'ok'}: ${check.reason}${counts}`;
}

/**
 * Whether each LaunchDaemon is installed, and at what time. No sudo.
 *
 * @returns {string[]} Lines to print.
 */
function jobStatusMac() {
  const lines = [];
  for (const [key, job] of Object.entries(JOBS)) {
    const plist = `${DAEMON_DIR}/${job.label}.plist`;
    // Deliberately no sudo here: `launchctl print system/...` needs root, and a status
    // command that prompts for a password is a status command nobody runs. The plist's
    // presence answers "is it installed"; the heartbeat answers "is it working".
    const at = clockString(key === 'sync' ? scheduleTimes().sync : scheduleTimes().watchdog);
    lines.push(`  ${key.padEnd(9)} ${exists(plist) ? `installed (${at})` : 'not installed'}  ${plist}`);
  }
  lines.push('');
  lines.push(`  detail: sudo launchctl print system/${JOBS.sync.label}`);
  return lines;
}

/**
 * Last run, result and missed runs for each scheduled task.
 *
 * @returns {string[]} Lines to print.
 */
function jobStatusWindows() {
  const lines = [];
  for (const [key, job] of Object.entries(JOBS)) {
    const r = capture('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$i = Get-ScheduledTaskInfo -TaskName ${psQuote(job.taskName)} -ErrorAction SilentlyContinue; ` +
        'if ($i) { "last={0} result={1} missed={2}" -f $i.LastRunTime, $i.LastTaskResult, $i.NumberOfMissedRuns } ' +
        'else { "not installed" }',
    ]);
    lines.push(`  ${key.padEnd(9)} ${r.out || 'not installed'}`);
  }
  return lines;
}

/**
 * One make target.
 *
 * @typedef {object} Target
 * @property {string} name - What follows `make` / `.\build.ps1`.
 * @property {string} [args] - Argument synopsis for help; must contain no `:` or `--`.
 * @property {string} summary - One line for help and the shim lists.
 * @property {(words: string[]) => (void|number|Promise<void>)} run - Does the work, given
 *   the words after the target name. Fails by throwing {@link Fail}.
 */

/**
 * A titled group of targets, as help prints them.
 *
 * @typedef {object} TargetGroup
 * @property {string} title - Group heading.
 * @property {Target[]} items - Targets in display order.
 */

/**
 * The target registry: every target, grouped and ordered as help prints them. Built on
 * each call so `summary` can reflect the platform.
 *
 * @returns {TargetGroup[]} Every group.
 */
export function targetGroups() {
  return [
    {
      title: 'Setting up',
      items: [
        {
          name: 'setup',
          summary: 'install dependencies, enable the pre-push hook, create .env and channels.txt',
          /**
           * The `setup` target.
           *
           * @returns {void}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run() {
            npmScript('install');
            // The hook is opt-in per clone by design (git will not honour a hooks
            // directory it was not pointed at), so this is the one step a fresh clone
            // always forgets.
            run('git', ['config', 'core.hooksPath', '.githooks']);
            for (const line of [
              copyIfMissing(ENV_TEMPLATE, ENV_FILE, 'fill in your credentials'),
              copyIfMissing(CHANNELS_TEMPLATE, CHANNELS, 'put your own handles in it'),
            ]) {
              console.log(`  ${line}`);
            }
            fs.mkdirSync(LOG_DIR, { recursive: true });
            console.log(`\nNext: edit .env, then \`${invocation()} authorize\`, then \`${invocation()} doctor\`.`);
          },
        },
        {
          name: 'authorize',
          summary: 'one-time Google OAuth in a browser; writes GOOGLE_REFRESH_TOKEN to .env',
          /**
           * The `authorize` target.
           *
           * @returns {void}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run() {
            node([path.join('src', 'authorize.js')]);
          },
        },
        {
          name: 'change-email',
          args: '<address>',
          summary: 'set REPORT_TO in .env - who receives the run report',
          /**
           * The `change-email` target.
           *
           * @param {string[]} words - Words after the target name.
           * @returns {void}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run(words) {
            const [address, ...rest] = words;
            if (!address) fail('change-email needs an address, e.g. change-email you@example.com');
            if (rest.length) fail(`change-email takes one address; got ${words.length}`);
            if (!validEmail(address)) fail(`"${address}" does not look like an email address`);
            if (!exists(ENV_FILE)) fail(`no .env yet - run \`${invocation()} setup\` first`);

            const before = fs.readFileSync(ENV_FILE, 'utf8');
            const was = getEnvValue(before, 'REPORT_TO');
            fs.writeFileSync(ENV_FILE, setEnvValue(before, 'REPORT_TO', address));
            console.log(`\n  REPORT_TO: ${was || '(unset)'} -> ${address}`);

            // ERROR_ALERT_TO falls back to REPORT_TO, so changing one silently moves the
            // other whenever it was never set separately. Say which happened.
            const alert = getEnvValue(before, 'ERROR_ALERT_TO');
            console.log(
              alert
                ? `  ERROR_ALERT_TO is set separately (${alert}) and was not changed.`
                : '  ERROR_ALERT_TO is unset, so failures and watched previews go there too.'
            );
            console.log('\n  .env is git-ignored; nothing about this is published.');
          },
        },
        {
          name: 'doctor',
          summary: 'check this checkout can run at all: node, credentials, channel list, hooks',
          /**
           * The `doctor` target.
           *
           * @returns {Promise<void>}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          async run() {
            const checks = await doctorChecks();
            const mark = { ok: 'ok  ', warn: 'warn', bad: 'FAIL' };
            const pad = Math.max(...checks.map((c) => c.label.length));
            console.log('');
            for (const c of checks) console.log(`  ${mark[c.level]}  ${c.label.padEnd(pad)}  ${c.detail}`);
            const failed = checks.filter((c) => c.level === 'bad');
            console.log('');
            if (failed.length) fail(`${failed.length} check${failed.length === 1 ? '' : 's'} failed`);
            console.log('  Ready.');
          },
        },
      ],
    },
    {
      title: 'Running the sync',
      items: [
        {
          name: 'dry-run',
          args: '[channel] [key=value...]',
          summary: 'read everything, write nothing - always the first thing to run',
          /**
           * The `dry-run` target.
           *
           * @param {string[]} words - Words after the target name.
           * @returns {void}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run(words) {
            node([path.join('src', 'index.js'), '--dry-run', ...toCliArgs(words)]);
          },
        },
        {
          name: 'run',
          args: '[channel] [key=value...]',
          summary: 'sync for real: every channel in config/channels.txt, or just the one named',
          /**
           * The `run` target.
           *
           * @param {string[]} words - Words after the target name.
           * @returns {void}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run(words) {
            node([path.join('src', 'index.js'), ...toCliArgs(words)]);
          },
        },
        {
          name: 'nightly',
          summary: 'exactly what the scheduled job runs (--email-on-change), by hand',
          /**
           * The `nightly` target.
           *
           * @param {string[]} words - Words after the target name.
           * @returns {void}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run(words) {
            node([path.join('src', 'index.js'), '--email-on-change', ...toCliArgs(words)]);
          },
        },
        {
          name: 'watchdog',
          summary: 'staleness check; emails ERROR_ALERT_TO if no sync has finished in 36h',
          /**
           * The `watchdog` target.
           *
           * @param {string[]} words - Words after the target name.
           * @returns {void}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run(words) {
            node([path.join('src', 'watchdog.js'), ...toCliArgs(words)]);
          },
        },
        {
          name: 'watchdog-dry',
          summary: 'the same check with nothing sent',
          /**
           * The `watchdog-dry` target.
           *
           * @returns {void}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run() {
            node([path.join('src', 'watchdog.js'), '--dry-run']);
          },
        },
      ],
    },
    {
      title: 'Channels',
      items: [
        {
          name: 'list-channels',
          summary: 'the configured channels and the playlists each one asks for',
          /**
           * The `list-channels` target.
           *
           * @returns {Promise<void>}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          async run() {
            const parse = await channelParser();
            const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'index.js')).href);
            const lines = channelLines(readChannels());
            if (!lines.length) return console.log('\n  No channels configured yet.');
            console.log('');
            for (const l of lines) {
              const spec = parse(l.text.trim());
              const name = spec.handle.replace(/^@/, '');
              const playlists = mod.targetsFor(spec, name).map((t) => `"${t.playlistTitle}"`);
              const bits = [
                spec.after ? `after=${spec.after.toISOString().slice(0, 10)}` : null,
                spec.after ? `older=${spec.removeBefore ? 'remove' : 'keep'}` : null,
                spec.shorts === 'no' ? null : `shorts=${spec.shorts}`,
              ].filter(Boolean);
              console.log(`  @${name.padEnd(24)} ${playlists.join(' + ')}${bits.length ? `   [${bits.join(' ')}]` : ''}`);
            }
            console.log(`\n  ${lines.length} channel line(s) in ${rel(CHANNELS)}.`);
          },
        },
        {
          name: 'add-channel',
          args: '<@Handle> [after=…] [older=keep|remove] [shorts=no|yes|only|split]',
          summary: 'append a validated line to config/channels.txt',
          /**
           * The `add-channel` target.
           *
           * @param {string[]} words - Words after the target name.
           * @returns {Promise<void>}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          async run(words) {
            const [handle, ...settings] = words;
            if (!handle) fail('add-channel needs a handle, e.g. add-channel "@SomeChannel"');
            if (handle.startsWith('-')) fail(`"${handle}" looks like a flag, not a handle`);
            const line = [handle.startsWith('@') ? handle : `@${handle}`, ...settings].join(' ');

            // Validate with the parser that will read this line at 3 AM rather than a
            // second one written here: a malformed setting is fatal to the whole run,
            // and every one of them has a silent-failure mode that looks like something
            // else went wrong.
            const parse = await channelParser();
            parse(line);

            const content = readChannels();
            const want = handleOf(line);
            const already = channelLines(content).find((l) => l.handle === want);
            if (already) fail(`${rel(CHANNELS)}:${already.lineNo} already has it:\n  ${already.text.trim()}`);

            const eol = eolOf(content);
            const body = content.endsWith(eol) || content === '' ? content : content + eol;
            fs.writeFileSync(CHANNELS, `${body}${line}${eol}`);
            console.log(`\n  added to ${rel(CHANNELS)}:\n    ${line}`);
            console.log(`\n  Nothing has been created on YouTube yet. Check the cost first:`);
            console.log(`    ${invocation()} dry-run "${handle}"`);
          },
        },
        {
          name: 'remove-channel',
          args: '<@Handle>',
          summary: 'drop a line from config/channels.txt (leaves the playlist and ledger alone)',
          /**
           * The `remove-channel` target.
           *
           * @param {string[]} words - Words after the target name.
           * @returns {void}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run(words) {
            const [handle] = words;
            if (!handle) fail('remove-channel needs a handle');
            const { content, removed } = removeChannel(readChannels(), handle);
            if (!removed.length) fail(`no line for ${handle} in ${rel(CHANNELS)}`);
            fs.writeFileSync(CHANNELS, content);
            // Printed verbatim because the settings on the line are not recoverable from
            // anywhere else once it is gone.
            console.log(`\n  removed from ${rel(CHANNELS)}:`);
            for (const line of removed) console.log(`    ${line}`);
            console.log('\n  The playlist on YouTube and its watched ledger in state/ are untouched:');
            console.log('  this only stops future runs from maintaining it. Delete the playlist by hand');
            console.log('  in the YouTube UI if you want it gone.');
          },
        },
      ],
    },
    {
      title: 'The account',
      items: [
        {
          name: 'claim',
          summary: 'take this account’s sync marker over from another machine (50 quota units)',
          /**
           * The `claim` target.
           *
           * @returns {void}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run() {
            // --claim-sync refuses to run without a TTY, which is what makes two machines
            // claiming an account back from each other nightly unreachable rather than
            // merely discouraged. Passing stdio through keeps that check meaningful.
            node([path.join('src', 'index.js'), '--claim-sync']);
          },
        },
        {
          name: 'unclaim',
          summary: 'give this machine\u2019s claim up, so another machine can take the account',
          /**
           * The `unclaim` target.
           *
           * @returns {void}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run() {
            requireNotScheduled('unclaim');
            node([path.join('src', 'index.js'), '--unclaim-sync']);
          },
        },
        {
          name: 'unclaim-all',
          summary: 'clear every claim on the account - the next machine to sync takes it',
          /**
           * The `unclaim-all` target.
           *
           * @returns {void}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run() {
            requireNotScheduled('unclaim-all');
            node([path.join('src', 'index.js'), '--unclaim-all']);
          },
        },
      ],
    },
    {
      title: 'Quality',
      items: [
        { name: 'test', summary: 'the full node:test suite', run: () => npmScript('test') },
        { name: 'lint', summary: 'eslint, --max-warnings=0', run: () => npmScript('lint') },
        {
          name: 'check',
          summary: 'everything lint and the tests cannot see: secrets, manifest, links, endings',
          /**
           * The `check` target.
           *
           * @returns {Promise<void>}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          async run() {
            const { runAllChecks } = await loadChecks();
            const findings = await runAllChecks({
              targetNames: allTargetNames(),
              targets: targetGroups().flatMap((g) => g.items),
              shims: shimState(),
            });
            report(findings);
            if (findings.some((f) => f.level === 'error')) fail('check found errors');
          },
        },
        {
          name: 'ci',
          summary: 'lint, tests and every check - what the pre-push hook runs. Reports all failures',
          /**
           * The `ci` target.
           *
           * @returns {Promise<void>}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          async run() {
            // Deliberately does not stop at the first failure. "Fix one, run again, find
            // the next" is how a pre-push gate becomes something people skip with
            // --no-verify, so everything runs and the report at the end lists it all.
            const failed = [];
            for (const [label, script] of [['lint', 'lint'], ['tests', 'test']]) {
              try {
                npmScript(script);
              } catch {
                failed.push(label);
              }
            }
            const { runAllChecks } = await loadChecks();
            const findings = await runAllChecks({
              targetNames: allTargetNames(),
              targets: targetGroups().flatMap((g) => g.items),
              shims: shimState(),
            });
            report(findings);
            if (findings.some((f) => f.level === 'error')) failed.push('checks');
            if (failed.length) fail(`failed: ${failed.join(', ')}`);
            console.log('  Lint, tests and checks all passed.');
          },
        },
        {
          name: 'sync-shims',
          summary: 'regenerate the target list inside Makefile and build.ps1',
          /**
           * The `sync-shims` target.
           *
           * @returns {void}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run() {
            const current = Object.fromEntries(
              Object.keys(SHIM_MARKERS).map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')])
            );
            const next = renderShims(targetGroups(), current);
            let changed = 0;
            for (const [file, content] of Object.entries(next)) {
              if (content === current[file]) continue;
              fs.writeFileSync(path.join(ROOT, file), content);
              console.log(`  updated ${file}`);
              changed += 1;
            }
            console.log(changed ? '' : '\n  Both shims already list every target.');
          },
        },
      ],
    },
    {
      title: 'The scheduled job',
      items: [
        {
          name: 'status',
          summary: 'is the nightly job installed, and when did a sync last finish',
          /**
           * The `status` target.
           *
           * @returns {Promise<void>}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          async run() {
            requireKnownPlatform('status');
            console.log(`\n  Scheduled jobs (${IS_MACOS ? 'launchd' : 'Task Scheduler'}):`);
            for (const line of IS_MACOS ? jobStatusMac() : jobStatusWindows()) console.log(line);
            console.log(`\n  Heartbeat: ${await heartbeatLine()}`);
          },
        },
        {
          name: 'install',
          summary: `register the nightly sync and the watchdog (${IS_MACOS ? 'needs sudo, once' : 'Task Scheduler'})`,
          /**
           * The `install` target.
           *
           * @returns {Promise<void>}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          async run() {
            requireKnownPlatform('install');
            await requireRealGoogleCredentials();
            await requireAtLeastOneChannel();
            // One machine per account: a second scheduler re-adds what the first pruned,
            // because the watched ledger is per-machine (AGENTS.md). Say so before
            // installing rather than after the videos start reappearing.
            console.log('\n  One machine syncs an account. If another machine already runs this,');
            console.log(`  disable its jobs first, copy its state/ across, then \`${invocation()} claim\`.`);
            return IS_MACOS ? installMac() : installWindows();
          },
        },
        {
          name: 'uninstall',
          summary: 'remove both scheduled jobs; state/, logs/ and the playlists are untouched',
          /**
           * The `uninstall` target.
           *
           * @returns {void}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run() {
            requireKnownPlatform('uninstall');
            return IS_MACOS ? uninstallMac() : uninstallWindows();
          },
        },
        {
          name: 'change-run-time',
          args: '<HHMM>',
          summary: 'move the nightly sync (the watchdog follows, six hours later)',
          /**
           * The `change-run-time` target.
           *
           * @param {string[]} words - Words after the target name.
           * @returns {void}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run(words) {
            const [when, ...rest] = words;
            if (!when) {
              fail(
                'change-run-time needs a four-digit 24-hour time.\n' +
                  `  ${invocation()} change-run-time 0430`
              );
            }
            if (rest.length) fail('change-run-time takes one time');
            const sync = parseClock(when);
            const watchdog = watchdogTime(sync);
            if (!exists(ENV_FILE)) fail(`no .env yet - run \`${invocation()} setup\` first`);

            let env = fs.readFileSync(ENV_FILE, 'utf8');
            env = setEnvValue(env, 'SYNC_AT', clockString(sync));
            env = setEnvValue(env, 'WATCHDOG_AT', clockString(watchdog));
            fs.writeFileSync(ENV_FILE, env);
            console.log(`\n  sync     ${clockString(sync)}`);
            console.log(`  watchdog ${clockString(watchdog)}  (six hours later, deliberately)`);
            console.log(
              '\n  The watchdog moves with the sync because a watchdog on the sync\u2019s own schedule\n' +
                '  is silent in exactly the case it exists to catch, and the gap lets a slow run\n' +
                '  finish before its heartbeat is judged.'
            );

            // Written to .env, but the scheduler holds its own copy of the time: without a
            // reinstall the change is real in the config and invisible on the machine.
            const installed = IS_MACOS
              ? exists(`${DAEMON_DIR}/${JOBS.sync.label}.plist`)
              : capture('powershell.exe', [
                  '-NoProfile',
                  '-Command',
                  `if (Get-ScheduledTask -TaskName ${psQuote(JOBS.sync.taskName)} -ErrorAction SilentlyContinue) { 'yes' }`,
                ]).out === 'yes';
            if (!installed) {
              return console.log(`\n  No job installed yet; \`${invocation()} install\` will use this time.`);
            }
            console.log('\n  Reinstalling both jobs so the scheduler picks the new time up.');
            return IS_MACOS ? installMac() : installWindows();
          },
        },
        {
          name: 'run-now',
          summary: 'trigger the scheduled sync immediately, through the scheduler itself',
          /**
           * The `run-now` target.
           *
           * @returns {number|void} The command's exit status, when one was run.
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run() {
            requireKnownPlatform('run-now');
            // Through the scheduler rather than by calling node: this is how to find out
            // whether the job's own environment works, which is where unattended runs
            // fail (no PATH, no login session, wrong working directory).
            if (IS_MACOS) return run('sudo', ['launchctl', 'kickstart', '-k', `system/${JOBS.sync.label}`]);
            return powershell(`Start-ScheduledTask -TaskName ${psQuote(JOBS.sync.taskName)}`);
          },
        },
      ],
    },
    {
      title: 'Housekeeping',
      items: [
        {
          name: 'report',
          summary: 'open the last run’s report.html',
          /**
           * The `report` target.
           *
           * @returns {number|void} The command's exit status, when one was run.
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run() {
            if (!exists(REPORT)) fail('no report.html yet - run a sync first');
            if (IS_MACOS) return run('open', [REPORT]);
            if (IS_WINDOWS) return powershell(`Start-Process ${psQuote(REPORT)}`);
            console.log(`\n  ${REPORT}`);
          },
        },
        {
          name: 'logs',
          args: '[lines]',
          summary: 'the tail of logs/sync.log (default 40 lines)',
          /**
           * The `logs` target.
           *
           * @param {string[]} words - Words after the target name.
           * @returns {void}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run(words) {
            // Read and slice here rather than shelling out: Windows has no tail, and the
            // point of this file is that a target works the same on both platforms.
            const file = path.join(LOG_DIR, 'sync.log');
            if (!exists(file)) fail(`no ${rel(file)} yet`);
            const n = Number.parseInt(words[0], 10) || 40;
            const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
            console.log(`\n--- ${rel(file)}, last ${n} lines ---`);
            console.log(lines.slice(-n).join('\n'));
          },
        },
        {
          name: 'clean',
          summary: 'delete logs/ and report.html - never state/, which holds the watched ledger',
          /**
           * The `clean` target.
           *
           * @returns {void}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run() {
            for (const p of CLEAN_PATHS) {
              const full = path.join(ROOT, p);
              if (!exists(full)) continue;
              fs.rmSync(full, { recursive: true, force: true });
              console.log(`  removed ${p}`);
            }
            console.log('\n  state/ kept: it is the ledger of what has already been watched, and');
            console.log('  losing it makes the next run re-add every video it previously pruned.');
          },
        },
        {
          name: 'from-release',
          summary: 'set a release kit up on a machine with no dev tooling: deps, .env, channels, next steps',
          /**
           * The `from-release` target.
           *
           * @returns {void}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run() {
            // A kit is an export of tracked files, so it has no .git. `setup` would try to
            // point git at .githooks here and fail on a directory that is not a repository -
            // and the pre-push hook it enables is meaningless on a box that never pushes.
            const isKit = !exists(path.join(ROOT, '.git'));
            console.log(`\n  Setting up in ${ROOT}`);
            console.log(`  Source: ${isKit ? 'release kit (no git checkout)' : 'git checkout'}`);

            // --omit=dev: the deployment box runs the sync, it does not lint or push. This
            // skips eslint and leaves `make ci` unavailable here, which is the right trade -
            // the gate belongs on the machine the code is edited on.
            console.log('\n  Installing runtime dependencies (this takes a minute).');
            if (!IS_WINDOWS) {
              run('npm', ['install', '--omit=dev']);
            } else {
              console.log('\n$ npm install --omit=dev');
              const r = spawnSync('npm install --omit=dev', { cwd: ROOT, stdio: 'inherit', shell: true });
              if (r.error) fail(`could not run npm: ${r.error.message}`);
              if (r.status !== 0) {
                fail(
                  'npm install failed.\n' +
                    '  The usual cause is no route to the npm registry. This kit deliberately does\n' +
                    '  not vendor its dependencies (they are 239 MB), so the first run needs network.'
                );
              }
            }

            if (!isKit) run('git', ['config', 'core.hooksPath', '.githooks']);

            for (const line of [
              copyIfMissing(ENV_TEMPLATE, ENV_FILE, 'fill in your credentials'),
              copyIfMissing(CHANNELS_TEMPLATE, CHANNELS, 'put your own handles in it'),
            ]) {
              console.log(`  ${line}`);
            }
            fs.mkdirSync(LOG_DIR, { recursive: true });

            const me = invocation();
            console.log(`
  Dependencies are in. Three things left, in this order:

    1. Edit .env
       Google credentials (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) are required.
       The email variables are optional - without them you read report.html instead.
       README.md, "One-time setup", has the Google Cloud walkthrough.

    2. Edit config/channels.txt
       One @Handle per line. \`${me} add-channel "@Handle"\` appends a validated line.

    3. \`${me} authorize\`   - opens a browser once and writes the refresh token to .env
       \`${me} doctor\`      - confirms this machine can actually run
       \`${me} dry-run\`     - reads everything, writes nothing. Always run this first.
       \`${me} install\`     - registers the 3 AM sync and the watchdog

  Day to day, nothing needs doing - but when something looks wrong:

    ${me} status     is the job installed, and when did a sync last finish
    ${me} report     open the last run's report
    ${me} logs       the tail of logs/sync.log
    ${me} doctor     re-check credentials, config and the Node version

  One machine syncs one account. If another machine has been syncing this
  account, disable its schedule first - two schedulers undo each other's
  deletions at 50 quota units a write. ${me} claim takes the account over.`);
          },
        },
        {
          name: 'release',
          args: '[dry=1]',
          summary: 'cut a release: name the Unreleased section after HEAD, tag it, publish it on GitHub',
          /**
           * The `release` target.
           *
           * @param {string[]} words - Words after the target name.
           * @returns {Promise<void>}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          async run(words) {
            const dry = words.some((w) => w === 'dry=1' || w === 'dry=true');
            const rest = words.filter((w) => !/^dry=/.test(w));
            if (rest.length) {
              fail(
                `release takes no arguments except dry=1, got: ${rest.join(' ')}\n` +
                  '  The version is derived from today and HEAD; it is not something to pass in.'
              );
            }
            await cutRelease({ dry });
          },
        },
        {
          name: 'version',
          summary: 'what this checkout is: package version, commit, node, platform',
          /**
           * The `version` target.
           *
           * @returns {void}
           * @throws {Fail} When the target cannot do its job; the message says why.
           */
          run() {
            const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
            const sha = capture('git', ['rev-parse', '--short', 'HEAD']).out || 'unknown';
            const dirty = capture('git', ['status', '--porcelain']).out ? ' (dirty)' : '';
            console.log(`\n  ${pkg.name} ${pkg.version}`);
            console.log(`  commit   ${sha}${dirty}`);
            console.log(`  node     ${process.version} (needs ${pkg.engines?.node})`);
            console.log(`  platform ${process.platform} ${process.arch}`);
            console.log(`  version string: ${versionString(sha)}`);
          },
        },
        { name: 'help', summary: 'this list', run: () => console.log(renderHelp(targetGroups())) },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------------
// Releasing
// ---------------------------------------------------------------------------------

/**
 * The version string a checkout at `sha` would release as: `YYYY.MM.DD-<short sha>`.
 *
 * Documentary, not semantic - there is no build step, so the only thing a version can
 * usefully name is the commit a deployment came from. Shared with `make version` so the
 * string it previews and the string `make release` writes cannot drift apart.
 *
 * @param {string} sha - Short commit id.
 * @param {Date} [now=new Date()] - Release date (UTC).
 * @returns {string} `YYYY.MM.DD-<sha>`.
 */
export function versionString(sha, now = new Date()) {
  return `${now.toISOString().slice(0, 10).replace(/-/g, '.')}-${sha}`;
}

/**
 * Turn the `## Unreleased` heading into a released one, preserving the description.
 *
 * The ` \u2014 ` separator is load-bearing: checks.js reads a release's *name* as
 * everything before the first spaced dash, so changing the separator here silently
 * renames every release and breaks the features.yaml `release:` cross-reference.
 *
 * Pure, so the format is testable without a git checkout or a network.
 *
 * @param {string} unreleasedHeading - The `## Unreleased ...` line.
 * @param {string} version - From {@link versionString}.
 * @param {string} date - `YYYY-MM-DD`.
 * @returns {string} `## <version> — <date>`, plus ` (<description>)` when there was one.
 */
export function releaseHeading(unreleasedHeading, version, date) {
  // The separator is optional: a bare "## Unreleased" is a legitimate heading, and a
  // required dash here would silently turn the whole heading into the description.
  const desc = String(unreleasedHeading).replace(/^##\s+Unreleased\s*(?:[-\u2014]\s*)?/, '').trim();
  return `## ${version} \u2014 ${date}${desc ? ` (${desc})` : ''}`;
}

/**
 * Split VERSIONS.md into the Unreleased heading, its body, and the rest.
 * Returns null when there is no Unreleased section at all.
 *
 * @param {string} text - VERSIONS.md text.
 * @returns {?{lines: string[], start: number, end: number, heading: string, body: string}}
 *   All lines, the heading's index, the index of the next `## ` heading (or the line
 *   count), the heading itself and the trimmed body.
 */
export function unreleasedSection(text) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => /^##\s+Unreleased\b/.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { lines, start, end, heading: lines[start], body: lines.slice(start + 1, end).join('\n').trim() };
}

/**
 * Cut a release: name the Unreleased section after HEAD, repoint every feature that
 * pointed at "Unreleased", verify, commit, tag and publish on GitHub.
 *
 * The order is deliberate. The books are rewritten *before* `ci` runs, because the
 * features.yaml `release:` values and the VERSIONS.md headings are cross-checked against
 * each other (checkManifest) - verifying the old state would prove nothing about the
 * state being shipped. If that verification fails the edits are rolled back, so a failed
 * release leaves the tree exactly as it found it rather than half-renamed.
 *
 * The tag is pushed before the GitHub release is created because `gh release create`
 * against a tag the remote has never seen creates the tag itself, from whatever the
 * remote's default branch happens to point at - which is not necessarily what was tested.
 *
 * @param {{dry: boolean}} options - `dry` previews and changes nothing.
 * @returns {Promise<void>}
 * @throws {Fail} On a dirty tree, an existing tag, an empty Unreleased section, no gh
 *   access, failed verification (after rolling back), or any failing git/gh step.
 */
async function cutRelease({ dry }) {
  // A release names a commit, so the tree has to *be* that commit. Tagging a dirty tree
  // publishes a name for something nobody else can check out.
  const dirty = capture('git', ['status', '--porcelain']).out;
  if (dirty) {
    fail(
      'the working tree has uncommitted changes.\n' +
        '  A release tags a commit; commit or stash first, so the tag names what was tested.'
    );
  }

  const sha = capture('git', ['rev-parse', '--short', 'HEAD']).out;
  if (!sha) fail('not a git checkout - there is no commit to name a release after');

  const today = new Date().toISOString().slice(0, 10);
  const version = versionString(sha);

  if (capture('git', ['rev-parse', '-q', '--verify', `refs/tags/${version}`]).status === 0) {
    fail(`tag ${version} already exists - this commit was released today already`);
  }

  const section = unreleasedSection(fs.readFileSync(VERSIONS_MD, 'utf8'));
  if (!section) fail(`no "## Unreleased" heading in ${rel(VERSIONS_MD)} - there is nothing to release`);
  if (!section.body) fail(`the Unreleased section in ${rel(VERSIONS_MD)} is empty - nothing to release`);

  // Probe authorisation before doing any work. gh resolves credentials per host, not per
  // repo, so the active account can easily be one with no write access here - and that
  // failure would otherwise surface only at the very last step, after the tag was pushed.
  const who = capture('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  if (who.error) fail('gh is not installed - it is what creates the GitHub release');
  if (who.status !== 0) {
    fail(
      `gh cannot reach this repository:\n  ${who.out}\n` +
        '  Check `gh auth status`: the active account may not have write access here.'
    );
  }

  const heading = releaseHeading(section.heading, version, today);
  const featuresBefore = fs.readFileSync(FEATURES_YAML, 'utf8');
  const repointed = featuresBefore.split('release: Unreleased').length - 1;

  console.log(`\n  releasing ${version}`);
  console.log(`  repo      ${who.out}`);
  console.log(`  heading   ${heading}`);
  console.log(`  features  ${repointed} entry(s) move from Unreleased to ${version}`);
  console.log(`  notes     ${section.body.split('\n').length} line(s) from the Unreleased section`);

  if (dry) {
    console.log('\n  dry run: nothing written, nothing tagged, nothing published.');
    console.log(`  Run \`${invocation()} release\` to do it for real.`);
    return;
  }

  // --- edit the books -------------------------------------------------------------
  const versionLines = [...section.lines];
  versionLines[section.start] = heading;
  fs.writeFileSync(VERSIONS_MD, versionLines.join('\n'));

  const featuresAfter = featuresBefore
    .split('release: Unreleased')
    .join(`release: ${version}`)
    .replace(/^updated: .*$/m, `updated: ${today}`);
  fs.writeFileSync(FEATURES_YAML, featuresAfter);

  /** Restore VERSIONS.md and features.yaml to what they were before the edit. */
  const rollback = () => {
    fs.writeFileSync(VERSIONS_MD, section.lines.join('\n'));
    fs.writeFileSync(FEATURES_YAML, featuresBefore);
  };

  // --- verify what is about to ship, not what was there before ---------------------
  console.log('\n  Verifying the renamed manifest before anything is published.');
  try {
    npmScript('lint');
    npmScript('test');
    const { runAllChecks } = await loadChecks();
    const findings = await runAllChecks({
      targetNames: allTargetNames(),
      targets: targetGroups().flatMap((g) => g.items),
      shims: shimState(),
    });
    report(findings);
    if (findings.some((f) => f.level === 'error')) throw new Fail('checks found errors against the renamed manifest');
  } catch (err) {
    rollback();
    fail(
      `${err.message}\n  The release was abandoned and VERSIONS.md / features.yaml were ` +
        'restored, so the tree is as you left it.'
    );
  }

  // --- commit, tag, push ------------------------------------------------------------
  run('git', ['add', rel(VERSIONS_MD), rel(FEATURES_YAML)]);
  run('git', ['commit', '-m', `Release ${version}`]);
  run('git', ['tag', '-a', version, '-m', `Release ${version}`]);
  run('git', ['push', 'origin', 'HEAD']);
  run('git', ['push', 'origin', version]);

  // --- publish ----------------------------------------------------------------------
  // Notes go through a file rather than an argument: the body is multi-line Markdown and
  // passing it inline would be at the mercy of the shell on whichever platform runs this.
  const notes = path.join(os.tmpdir(), `gyp-release-${version}.md`);
  fs.writeFileSync(notes, `${section.body}\n`);

  // The kit is `git archive` of the tag, not a copy of the working directory. That is a
  // safety property, not a convenience: it can only contain tracked files, so .env,
  // state/ and logs/ cannot reach a public release asset even by mistake (CLAUDE.md 12).
  // It deliberately does not vendor node_modules - 239 MB per release, frozen at release
  // time - so `from-release` runs npm install on first use.
  const kit = path.join(os.tmpdir(), `${KIT_NAME}-${version}.zip`);
  run('git', ['archive', '--format=zip', `--prefix=${KIT_NAME}-${version}/`, '-o', kit, version]);
  const kitSize = (fs.statSync(kit).size / 1024).toFixed(0);
  console.log(`\n  kit ${path.basename(kit)} (${kitSize} KB)`);

  try {
    run('gh', ['release', 'create', version, '--title', version, '--notes-file', notes, kit]);
  } finally {
    fs.rmSync(notes, { force: true });
    fs.rmSync(kit, { force: true });
  }

  console.log(`\n  Released ${version}.`);
  console.log(`  Add the next change under a new "## Unreleased" heading in ${rel(VERSIONS_MD)}.`);
}

// ---------------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------------

/**
 * Wrap `text` to `width`, indenting every line after the first by `indent` spaces.
 *
 * @param {string} text - Text to wrap at whitespace.
 * @param {number} width - Maximum line length (a single longer word is kept whole).
 * @param {number} indent - Spaces before each continuation line.
 * @returns {string} The wrapped text.
 */
function wrap(text, width, indent) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out.join(`\n${' '.repeat(indent)}`);
}

/**
 * The text `make help` prints: every target with its summary and argument synopsis,
 * then examples and the argument rules.
 *
 * @param {TargetGroup[]} groups - The registry.
 * @param {object} [options]
 * @param {string} [options.how=invocation()] - `make` or `.\build.ps1`.
 * @param {number} [options.width=96] - Wrap width.
 * @returns {string} The help text.
 */
export function renderHelp(groups, { how = invocation(), width = 96 } = {}) {
  const names = groups.flatMap((g) => g.items.map((t) => t.name));
  const col = Math.max(...names.map((n) => n.length)) + 2;
  const indent = col + 2;
  const out = [`\nUsage: ${how} <target> [arguments]\n`];
  for (const group of groups) {
    out.push(`${group.title}`);
    for (const t of group.items) {
      out.push(`  ${t.name.padEnd(col)}${wrap(t.summary, width - indent, indent)}`);
      if (t.args) out.push(`  ${' '.repeat(col)}${how} ${t.name} ${t.args}`);
    }
    out.push('');
  }
  out.push('Examples');
  for (const line of [
    [`${how} doctor`, 'is this checkout able to run at all'],
    [`${how} dry-run`, 'what a full sync would do, writing nothing'],
    [`${how} dry-run "@SomeChannel"`, 'the same, one channel only'],
    [`${how} run "@SomeChannel" max=1`, 'sync it for real, at most one insert'],
    [`${how} add-channel "@SomeChannel" shorts=split`, 'add it with its Shorts split out'],
    [`${how} ci`, 'lint and the full test suite'],
    [`${how} install`, 'register the 3 AM job and the watchdog'],
  ]) {
    out.push(`  ${line[0].padEnd(46)}${line[1]}`);
  }
  out.push('');
  out.push('Arguments  (the same in make and build.ps1, on purpose)');
  out.push('  "@Handle"    always quoted. @ begins a splatting expression in PowerShell, and a');
  out.push('               bare handle there expands to nothing at all.');
  out.push('  key=value    settings and flags alike: max=1, shorts=split, after=2026-01-01.');
  out.push('               Not --max=1 - make claims raw --flags for itself.');
  out.push('  0430         times are four-digit 24-hour. A colon is a rule separator to make,');
  out.push('               and quoting does not help: the shell strips it before make looks.');
  if (how === 'make') {
    out.push('');
    out.push("  make only: a raw --flag with no key=value spelling goes in ARGS='--report-watched'.");
  }
  return out.join('\n');
}

/**
 * The target list as the shims carry it.
 *
 * The shims forward every goal through one generic rule, which is what keeps them from
 * needing an edit per target - but it also means neither file mentions a target by name,
 * so opening the Makefile to find out whether `uninstall` exists shows nothing. That is a
 * real way to use a Makefile, so the list is generated into both files between markers,
 * `sync-shims` rewrites it, and `check` fails when it has drifted. Generated rather than
 * hand-kept because a hand-kept list is exactly the stale menu this design set out to
 * avoid.
 *
 * @param {TargetGroup[]} groups - The registry.
 * @param {string} prefix - Comment prefix for each line in that shim's language.
 * @returns {string} The block, without the markers.
 */
export function shimTargetBlock(groups, prefix) {
  const names = groups.flatMap((g) => g.items.map((t) => t.name));
  const col = Math.max(...names.map((n) => n.length)) + 2;
  const out = [];
  for (const group of groups) {
    out.push(`${prefix}${group.title}`);
    for (const t of group.items) out.push(`${prefix}  ${t.name.padEnd(col)}${t.summary}`);
  }
  return out.join('\n');
}

/**
 * Where each shim carries its generated target list: marker lines and the per-line
 * comment prefix.
 *
 * @type {Object<string, {start: string, end: string, prefix: string}>}
 */
export const SHIM_MARKERS = {
  'Makefile': { start: '# >>> targets >>>', end: '# <<< targets <<<', prefix: '#   ' },
  'build.ps1': { start: '    # >>> targets >>>', end: '    # <<< targets <<<', prefix: '    #   ' },
};

/**
 * Replace whatever sits between the markers with `body`. Returns null if absent.
 *
 * @param {string} content - File text.
 * @param {{start: string, end: string}} markers - Marker lines.
 * @param {string} body - New text between them.
 * @returns {?string} The new file text, or null when a marker is missing or out of order.
 */
export function spliceBetween(content, { start, end }, body) {
  const a = content.indexOf(start);
  const b = content.indexOf(end);
  if (a === -1 || b === -1 || b < a) return null;
  return `${content.slice(0, a + start.length)}\n${body}\n${content.slice(b)}`;
}

/**
 * The shim contents the registry currently implies, keyed by filename.
 *
 * @param {TargetGroup[]} groups - The registry.
 * @param {Object<string, string>} current - Current shim text by file name.
 * @returns {Object<string, string>} New text for each shim that has its markers.
 */
export function renderShims(groups, current) {
  const out = {};
  for (const [file, markers] of Object.entries(SHIM_MARKERS)) {
    const body = shimTargetBlock(groups, markers.prefix);
    const next = spliceBetween(current[file] ?? '', markers, body);
    if (next !== null) out[file] = next;
  }
  return out;
}

// ---------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------

/**
 * What the shims say now, and what the registry says they should say.
 *
 * @returns {{current: Object<string, string>, expected: Object<string, string>}} Both.
 */
function shimState() {
  const current = Object.fromEntries(
    Object.keys(SHIM_MARKERS).map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')])
  );
  return { current, expected: renderShims(targetGroups(), current) };
}

/**
 * Every target name, for the docs check and the shim list.
 *
 * @param {TargetGroup[]} [groups=targetGroups()] - The registry.
 * @returns {string[]} Names in display order.
 */
export function allTargetNames(groups = targetGroups()) {
  return groups.flatMap((g) => g.items.map((t) => t.name));
}

/**
 * Print findings grouped by level, worst first, and summarise.
 *
 * @param {import('./checks.js').Finding[]} findings - What the checks returned.
 * @returns {void}
 */
function report(findings) {
  const errors = findings.filter((f) => f.level === 'error');
  const warnings = findings.filter((f) => f.level === 'warn');
  console.log('');
  for (const f of [...errors, ...warnings]) {
    console.log(`  ${f.level === 'error' ? 'FAIL' : 'warn'}  ${f.check.padEnd(12)}  ${f.message}`);
  }
  if (!findings.length) console.log('  No findings.');
  console.log(`\n  ${errors.length} error(s), ${warnings.length} warning(s).`);
  // Warnings do not fail the build on purpose: a warning that blocks a push is an error
  // wearing a disguise, and the honest fix is to promote it rather than to teach people
  // --no-verify.
}

/**
 * Look a target up by exact name.
 *
 * @param {TargetGroup[]} groups - The registry.
 * @param {string} name - Target name.
 * @returns {?Target} The target, or null.
 */
export function findTarget(groups, name) {
  return groups.flatMap((g) => g.items).find((t) => t.name === name) || null;
}

/**
 * Targets whose names are close enough to `name` to be worth suggesting.
 *
 * @param {TargetGroup[]} groups - The registry.
 * @param {string} name - What was typed.
 * @returns {string[]} Names sharing its first three letters, or containing / contained in it.
 */
export function suggestions(groups, name) {
  const all = groups.flatMap((g) => g.items.map((t) => t.name));
  const n = String(name).toLowerCase();
  return all.filter((t) => t.startsWith(n.slice(0, 3)) || t.includes(n) || n.includes(t));
}

/**
 * Dispatch one target. No target (or help) prints the help.
 *
 * @param {string[]} argv - Target name followed by its words.
 * @returns {Promise<void>}
 * @throws {Fail} On an unknown target, a swallowed make flag, or the target's own failure.
 */
async function main(argv) {
  const groups = targetGroups();
  const [name, ...words] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') {
    console.log(renderHelp(groups));
    return;
  }
  guardMakeAteFlags();
  const target = findTarget(groups, name);
  if (!target) {
    const near = suggestions(groups, name);
    fail(
      `unknown target "${name}"${near.length ? `\nDid you mean: ${near.join(', ')}?` : ''}\n` +
        `Run \`${invocation()}\` with no target for the full list.`
    );
  }
  await target.run(words);
}

/** True when this file is the process entry point rather than imported by a test. */
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err) => {
    if (err instanceof Fail) {
      console.error(`\n${err.message}\n`);
      process.exit(1);
    }
    // A malformed channel line arrives here as a plain Error from the project's own
    // parser, and its message is the useful part; the stack is not.
    console.error(`\n${err.message || err}\n`);
    process.exit(1);
  });
}
