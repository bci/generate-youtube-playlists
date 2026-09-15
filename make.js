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
 * This file is tooling and imports nothing from src/ at load time - see targets() for
 * why the two places that need src/ import it lazily.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { runAllChecks } from './checks.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const IS_WINDOWS = process.platform === 'win32';
const IS_MACOS = process.platform === 'darwin';

const CHANNELS = path.join(ROOT, 'config', 'channels.txt');
const CHANNELS_TEMPLATE = path.join(ROOT, 'config', 'channels.example.txt');
const ENV_FILE = path.join(ROOT, '.env');
const ENV_TEMPLATE = path.join(ROOT, '.env.example');
const STATE_DIR = path.join(ROOT, 'state');
const LOG_DIR = path.join(ROOT, 'logs');
const REPORT = path.join(ROOT, 'report.html');
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
function fail(message) {
  throw new Fail(message);
}

// ---------------------------------------------------------------------------------
// Running things
// ---------------------------------------------------------------------------------

/**
 * Run a command with the terminal attached, echoing it first. The echo is not decoration:
 * several targets invoke `sudo`, and seeing the exact command before being asked for a
 * password is what makes it reviewable rather than something to approve blind.
 */
function run(cmd, args = [], { check = true, cwd = ROOT } = {}) {
  console.log(`\n$ ${[cmd, ...args].join(' ')}`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (r.error) fail(`could not run ${cmd}: ${r.error.message}`);
  if (check && r.status !== 0) fail(`${cmd} exited ${r.status}`);
  return r.status ?? 1;
}

/** Same, but capture the output instead of showing it. For probing, never for work. */
function capture(cmd, args = []) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), error: r.error };
}

/**
 * Run the tool itself. process.execPath rather than "node" for the same reason the
 * launchd wrappers resolve node by hand: it is the interpreter already running, so it
 * cannot be a different or missing one.
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

/** Quote a string for a PowerShell single-quoted literal. */
function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

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
 */
export function eatenMakeFlags(makeflags) {
  const letters = String(makeflags || '').trim().split(/\s+/)[0] || '';
  if (!letters || letters.includes('=')) return []; // a variable assignment, not options
  return [
    ...(letters.includes('n') ? ['--dry-run (make read it as its own -n)'] : []),
    ...(letters.includes('l') ? ['--max=N (make read it as its own -l N)'] : []),
  ];
}

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

const exists = (p) => fs.existsSync(p);
const rel = (p) => path.relative(ROOT, p) || '.';

/**
 * The line ending a file already uses. AGENTS.md: the working tree is deliberately
 * mixed and git normalizes on checkout, so rewriting a file's endings as a side effect
 * turns a one-line change into a whole-file diff.
 */
function eolOf(content) {
  return content.includes('\r\n') ? '\r\n' : '\n';
}

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
 */
async function channelParser() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'index.js')).href);
  return mod.parseChannelSpec;
}

function readChannels() {
  if (!exists(CHANNELS)) {
    fail(`no ${rel(CHANNELS)} yet - run \`${invocation()} setup\` first`);
  }
  return fs.readFileSync(CHANNELS, 'utf8');
}

/** The handle a channel line names, lowercased and without its @, or null for a comment. */
export function handleOf(line) {
  const t = String(line).trim();
  if (!t || t.startsWith('#')) return null;
  return t.split(/\s+/)[0].replace(/^@/, '').toLowerCase();
}

/** Every channel line in the file, in order, with its 1-based line number. */
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
 */
export function setEnvValue(content, key, value) {
  const eol = eolOf(content);
  const re = new RegExp(`^(\\s*${key}\\s*=).*$`, 'm');
  if (re.test(content)) return content.replace(re, `${key}=${value}`);
  const body = content && !content.endsWith(eol) ? content + eol : content;
  return `${body}${key}=${value}${eol}`;
}

/** Read one key out of a .env file without loading the rest into this process. */
export function getEnvValue(content, key) {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*(.*)$`, 'm').exec(String(content));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

/**
 * An address, checked only for the shape that would silently fail to deliver. This is
 * not an RFC validator and does not try to be: the real test is whether mail arrives,
 * and the failure worth catching here is a typo like a missing @ that would otherwise
 * surface as a Graph error at 3 AM in a log nobody reads.
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
 */
export function parseClock(text) {
  const m = /^([01]\d|2[0-3]):?([0-5]\d)$/.exec(String(text).trim());
  if (!m) {
    fail(`"${text}" is not a time. Use four-digit 24-hour HHMM, e.g. 0430 or 1500.`);
  }
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

const clockString = ({ hour, minute }) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

/**
 * The watchdog's time, six hours after the sync's.
 *
 * The gap is the whole point of the watchdog, not a detail: sharing the sync's schedule
 * makes it silent in exactly the case it exists to catch, and the gap also lets a slow or
 * retrying sync finish before its heartbeat is judged. So moving the sync moves the
 * watchdog with it rather than leaving the two to collide.
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

/** The configured run times, falling back to the defaults the templates carry. */
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

/** Fill a launchd plist template. The placeholders are the two the templates document. */
export function renderPlist(template, { repoDir, user }) {
  return template.replace(/__REPO_DIR__/g, repoDir).replace(/__RUN_AS_USER__/g, user);
}

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

function uninstallMac() {
  for (const job of Object.values(JOBS)) {
    run('sudo', ['launchctl', 'bootout', `system/${job.label}`], { check: false });
    run('sudo', ['rm', '-f', `${DAEMON_DIR}/${job.label}.plist`]);
  }
  console.log('\nBoth daemons removed. state/ and logs/ are untouched.');
}

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

/** How this tool is invoked on the platform running it, for help text and messages. */
export function invocation(platform = process.platform) {
  return platform === 'win32' ? '.\\build.ps1' : 'make';
}

/** Credentials the tool cannot run without, and the ones only email needs. */
const REQUIRED_ENV = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
const EMAIL_ENV = ['MS365_TENANT_ID', 'MS365_CLIENT_ID', 'MS365_CLIENT_SECRET', 'MS365_FROM_ADDRESS', 'REPORT_TO'];

/**
 * Which keys in a .env file have a non-empty value. Names only - this repo is public
 * (CLAUDE.md section 12) and doctor's output is the kind of thing that gets pasted into
 * an issue, so no value ever leaves this function.
 */
export function envKeysSet(content) {
  const set = new Set();
  for (const line of String(content).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && m[2].trim().replace(/^["']|["']$/g, '')) set.add(m[1]);
  }
  return set;
}

/** Node's own version against the floor in package.json engines. */
export function meetsEngine(current, required) {
  const want = String(required).replace(/^[^\d]*/, '').split('.').map(Number);
  const have = String(current).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < want.length; i++) {
    if ((have[i] || 0) > (want[i] || 0)) return true;
    if ((have[i] || 0) < (want[i] || 0)) return false;
  }
  return true;
}

function ok(label, detail) {
  return { level: 'ok', label, detail };
}
function warn(label, detail) {
  return { level: 'warn', label, detail };
}
function bad(label, detail) {
  return { level: 'bad', label, detail };
}

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
    const set = envKeysSet(fs.readFileSync(ENV_FILE, 'utf8'));
    const missing = REQUIRED_ENV.filter((k) => !set.has(k));
    checks.push(
      missing.length
        ? bad('.env credentials', `${missing.join(', ')} not set`)
        : ok('.env credentials', 'Google client id, secret and refresh token set')
    );
    const noMail = EMAIL_ENV.filter((k) => !set.has(k));
    checks.push(
      noMail.length
        ? warn('.env email', `${noMail.join(', ')} not set - the report will not be emailed`)
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
      checks.push(ok('channel list', `${lines.length} channel${lines.length === 1 ? '' : 's'}, all lines parse`));
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

  const hooks = capture('git', ['config', 'core.hooksPath']).out;
  checks.push(
    hooks === '.githooks'
      ? ok('git hooks', 'pre-push runs lint and tests')
      : warn('git hooks', `core.hooksPath is "${hooks || 'unset'}" - run \`${invocation()} setup\``)
  );

  return checks;
}

/** The heartbeat, read the way the watchdog reads it. */
async function heartbeatLine() {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src', 'heartbeat.js')).href);
  const hb = await mod.readHeartbeat(STATE_DIR);
  const check = mod.checkStale(hb, new Date());
  const counts = hb ? ` (${hb.channels ?? '?'} channels, +${hb.added ?? 0} added, -${hb.removed ?? 0} removed)` : '';
  return `${check.stale ? 'STALE' : 'ok'}: ${check.reason}${counts}`;
}

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

export function targetGroups() {
  return [
    {
      title: 'Setting up',
      items: [
        {
          name: 'setup',
          summary: 'install dependencies, enable the pre-push hook, create .env and channels.txt',
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
          run() {
            node([path.join('src', 'authorize.js')]);
          },
        },
        {
          name: 'change-email',
          args: '<address>',
          summary: 'set REPORT_TO in .env - who receives the run report',
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
          run(words) {
            node([path.join('src', 'index.js'), '--dry-run', ...toCliArgs(words)]);
          },
        },
        {
          name: 'run',
          args: '[channel] [key=value...]',
          summary: 'sync for real: every channel in config/channels.txt, or just the one named',
          run(words) {
            node([path.join('src', 'index.js'), ...toCliArgs(words)]);
          },
        },
        {
          name: 'nightly',
          summary: 'exactly what the scheduled job runs (--email-on-change), by hand',
          run(words) {
            node([path.join('src', 'index.js'), '--email-on-change', ...toCliArgs(words)]);
          },
        },
        {
          name: 'watchdog',
          summary: 'staleness check; emails ERROR_ALERT_TO if no sync has finished in 36h',
          run(words) {
            node([path.join('src', 'watchdog.js'), ...toCliArgs(words)]);
          },
        },
        {
          name: 'watchdog-dry',
          summary: 'the same check with nothing sent',
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
          run() {
            requireNotScheduled('unclaim');
            node([path.join('src', 'index.js'), '--unclaim-sync']);
          },
        },
        {
          name: 'unclaim-all',
          summary: 'clear every claim on the account - the next machine to sync takes it',
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
          async run() {
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
          run() {
            requireKnownPlatform('install');
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
          run() {
            requireKnownPlatform('uninstall');
            return IS_MACOS ? uninstallMac() : uninstallWindows();
          },
        },
        {
          name: 'change-run-time',
          args: '<HHMM>',
          summary: 'move the nightly sync (the watchdog follows, six hours later)',
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
          name: 'version',
          summary: 'what this checkout is: package version, commit, node, platform',
          run() {
            const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
            const sha = capture('git', ['rev-parse', '--short', 'HEAD']).out || 'unknown';
            const dirty = capture('git', ['status', '--porcelain']).out ? ' (dirty)' : '';
            console.log(`\n  ${pkg.name} ${pkg.version}`);
            console.log(`  commit   ${sha}${dirty}`);
            console.log(`  node     ${process.version} (needs ${pkg.engines?.node})`);
            console.log(`  platform ${process.platform} ${process.arch}`);
            console.log(`  version string: ${new Date().toISOString().slice(0, 10).replace(/-/g, '.')}-${sha}`);
          },
        },
        { name: 'help', summary: 'this list', run: () => console.log(renderHelp(targetGroups())) },
      ],
    },
  ];
}

// ---------------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------------

/** Wrap `text` to `width`, indenting every line after the first by `indent` spaces. */
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

export const SHIM_MARKERS = {
  'Makefile': { start: '# >>> targets >>>', end: '# <<< targets <<<', prefix: '#   ' },
  'build.ps1': { start: '    # >>> targets >>>', end: '    # <<< targets <<<', prefix: '    #   ' },
};

/** Replace whatever sits between the markers with `body`. Returns null if absent. */
export function spliceBetween(content, { start, end }, body) {
  const a = content.indexOf(start);
  const b = content.indexOf(end);
  if (a === -1 || b === -1 || b < a) return null;
  return `${content.slice(0, a + start.length)}\n${body}\n${content.slice(b)}`;
}

/** The shim contents the registry currently implies, keyed by filename. */
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

/** What the shims say now, and what the registry says they should say. */
function shimState() {
  const current = Object.fromEntries(
    Object.keys(SHIM_MARKERS).map((f) => [f, fs.readFileSync(path.join(ROOT, f), 'utf8')])
  );
  return { current, expected: renderShims(targetGroups(), current) };
}

/** Every target name, for the docs check and the shim list. */
export function allTargetNames(groups = targetGroups()) {
  return groups.flatMap((g) => g.items.map((t) => t.name));
}

/** Print findings grouped by level, worst first, and summarise. */
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

export function findTarget(groups, name) {
  return groups.flatMap((g) => g.items).find((t) => t.name === name) || null;
}

/** Targets whose names are close enough to `name` to be worth suggesting. */
export function suggestions(groups, name) {
  const all = groups.flatMap((g) => g.items.map((t) => t.name));
  const n = String(name).toLowerCase();
  return all.filter((t) => t.startsWith(n.slice(0, 3)) || t.includes(n) || n.includes(t));
}

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
