/**
 * checks.js - everything `make ci` can find that lint and the test suite cannot.
 *
 * The point is to catch, before a push, the mistakes this project has decided matter:
 * a secret or an id in a tracked file (CLAUDE.md section 12), a features.yaml that no
 * longer parses (AGENTS.md says nothing enforces this - now something does), a CRLF
 * shell wrapper that will fail at 3 AM, a change that skipped its bookkeeping.
 *
 * Two rules shape the design:
 *
 * 1. Every check runs. None short-circuits the others, because "fix one, run again,
 *    find the next" is how a pre-push check becomes something people skip. The report
 *    at the end lists everything at once.
 * 2. The rules are pure functions over data - they take file contents and return
 *    findings - so each one is testable without a repo, a network or a git history.
 *    The gathering is the only impure part.
 *
 * A finding is { check, level: 'error' | 'warn', message }. Errors fail the build.
 * Warnings are printed and counted but do not, because a warning that blocks a push is
 * an error wearing a disguise, and the honest fix is to promote it.
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import YAML from 'yaml';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

const error = (check, message) => ({ check, level: 'error', message });
const warn = (check, message) => ({ check, level: 'warn', message });

// ---------------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------------

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

/**
 * Is this tool on PATH? By trying to run it rather than by asking a shell: passing an
 * args array with shell:true is deprecated in current Node (DEP0190) and prints a warning
 * on every check run. A missing binary fails with ENOENT; a present one may exit non-zero
 * for an unknown flag, and that still answers the question.
 */
function has(cmd) {
  return spawnSync(cmd, ['--version'], { encoding: 'utf8' }).error?.code !== 'ENOENT';
}

/** Every tracked file, with its content. Binary and very large files are skipped. */
export function trackedFiles() {
  const listed = git(['ls-files']);
  if (!listed.ok) return [];
  const out = [];
  for (const rel of listed.out.split('\n').filter(Boolean)) {
    const full = path.join(ROOT, rel);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue; // listed but deleted in the working tree; git will notice, we need not
    }
    if (!stat.isFile() || stat.size > 2_000_000) continue;
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) continue; // binary
    out.push({ path: rel, content: buf.toString('utf8') });
  }
  return out;
}

// ---------------------------------------------------------------------------------
// The rules - pure, one exported function each
// ---------------------------------------------------------------------------------

const STATUSES = ['planned', 'in-dev', 'in-test', 'complete', 'deferred'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date, not merely a well-shaped string. 2026-02-30 is neither. */
function realDate(value) {
  if (!ISO_DATE.test(String(value))) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * features.yaml, against the rules AGENTS.md states. It says outright that nothing
 * enforces this and there is no CI for it; an entry that lies is worse than no entry,
 * because it is trusted.
 *
 * `source` is the raw text and `versions` the text of VERSIONS.md, so that `release:`
 * can be checked against the releases that actually exist.
 */
export function checkManifest(source, versions) {
  const found = [];
  let doc;
  try {
    doc = YAML.parse(source);
  } catch (err) {
    return [error('manifest', `features.yaml is not valid YAML: ${err.message.split('\n')[0]}`)];
  }
  if (!doc || typeof doc !== 'object') return [error('manifest', 'features.yaml is empty')];

  if (!realDate(doc.updated)) {
    found.push(error('manifest', `top-level updated: "${doc.updated}" is not a real YYYY-MM-DD date`));
  }
  const componentIds = new Set((doc.components || []).map((c) => c.id));
  const releases = new Set(
    [...String(versions).matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1].split(/\s+[-—]\s+/)[0].trim())
  );

  const seen = new Set();
  let previous = null;
  for (const f of doc.features || []) {
    const id = f.id;
    const at = `features.yaml ${id || '(no id)'}`;
    if (!/^FEAT-\d{4}$/.test(String(id))) {
      found.push(error('manifest', `${at}: id must be FEAT-NNNN, zero-padded`));
      continue;
    }
    if (seen.has(id)) found.push(error('manifest', `${at}: duplicate id`));
    seen.add(id);
    // Ids ascend with added:, because they are referenced from prompts and commit
    // messages and must never be renumbered to restore order.
    if (previous && id <= previous) found.push(error('manifest', `${at}: ids must ascend (after ${previous})`));
    previous = id;

    if (!f.title) found.push(error('manifest', `${at}: no title`));
    if (!f.description) found.push(error('manifest', `${at}: no description`));
    if (!STATUSES.includes(f.status)) {
      found.push(error('manifest', `${at}: status "${f.status}" is not one of ${STATUSES.join(', ')}`));
    }
    for (const key of ['added', 'updated']) {
      if (!realDate(f[key])) found.push(error('manifest', `${at}: ${key}: "${f[key]}" is not a real date`));
    }
    if (realDate(f.added) && realDate(f.updated) && f.updated < f.added) {
      found.push(error('manifest', `${at}: updated (${f.updated}) is before added (${f.added})`));
    }
    for (const c of f.components || []) {
      if (!componentIds.has(c)) found.push(error('manifest', `${at}: unknown component "${c}"`));
    }
    // release: names the VERSIONS.md release that LAST changed the feature, so a value
    // naming nothing is a feature whose history cannot be found.
    if (f.release !== 'Unreleased' && !releases.has(f.release)) {
      found.push(error('manifest', `${at}: release "${f.release}" is not a heading in VERSIONS.md`));
    }
  }
  return found;
}

/**
 * Markdown links pointing at paths inside the repo. Documentation rot is a warning, not
 * a failure: a stale link misleads a reader, it does not break a run.
 */
export function checkLinks(files, existsAt = (p) => fs.existsSync(path.join(ROOT, p)), isIgnored = () => false) {
  const found = [];
  for (const file of files) {
    if (!file.path.endsWith('.md')) continue;
    for (const m of file.content.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = m[1];
      // External links, anchors and mailto: are somebody else's problem.
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const bare = target.split('#')[0];
      if (!bare) continue;
      // Relative to the file that contains the link, not to the repo root: the prompts in
      // docs/prompts/ link to each other by bare filename, and resolving those from the
      // root reported every one of them as broken.
      const from = target.startsWith('/')
        ? bare.replace(/^\//, '')
        : path.posix.normalize(path.posix.join(path.posix.dirname(file.path), bare));
      if (existsAt(from)) continue;
      // A git-ignored path is not part of the repo, so its absence here is expected rather
      // than rot: .agent-pipe/ is created on demand by the agent-pipe skill and is
      // deliberately never committed. Warning about it on every run would make this check
      // the thing people stop reading.
      if (isIgnored(from)) continue;
      found.push(warn('links', `${file.path} links to ${target}, which does not exist`));
    }
  }
  return found;
}

// Addresses at these domains are documentation, not somebody's mailbox.
const SAFE_MAIL = /@example\.(com|net|org)$/;
// package-lock.json carries the npm maintainers' own addresses; it is generated, not written.
const NOT_OURS = new Set(['package-lock.json']);

/**
 * The public-repo scan (CLAUDE.md section 12). Errors, every one: a push is not
 * reversible, and a secret that reaches GitHub is a secret that has to be rotated
 * whether or not the commit is later removed.
 *
 * `handles` is the local channel list when there is one, so the check catches a real
 * channel name that wandered into a tracked example.
 */
export function scanSecrets(files, handles = []) {
  const found = [];
  const patterns = [
    // Google's real client-id shape. The .env.example placeholder does not match it.
    [/\b\d{6,}-[a-z0-9]{20,}\.apps\.googleusercontent\.com\b/, 'a Google OAuth client id'],
    [/\bGOCSPX-[A-Za-z0-9_-]{20,}\b/, 'a Google client secret'],
    [/\b1\/\/[A-Za-z0-9_-]{30,}\b/, 'a Google refresh token'],
    [/\bPL[A-Za-z0-9_-]{16,}\b/, 'a YouTube playlist id'],
    [/\bUC[A-Za-z0-9_-]{22}\b/, 'a YouTube channel id'],
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/, 'a tenant or client GUID'],
  ];

  for (const file of files) {
    if (NOT_OURS.has(file.path)) continue;
    for (const [re, what] of patterns) {
      const m = re.exec(file.content);
      if (m) found.push(error('secrets', `${file.path} contains what looks like ${what}`));
    }
    for (const m of file.content.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) {
      if (!SAFE_MAIL.test(m[0])) {
        found.push(error('secrets', `${file.path} contains the address ${m[0]} - use example.com`));
      }
    }
    for (const handle of handles) {
      // Word-boundary match so a handle that is also an ordinary word does not fire on prose.
      if (new RegExp(`@${handle}\\b`, 'i').test(file.content)) {
        found.push(error('secrets', `${file.path} names @${handle} from your channel list`));
      }
    }
  }
  return found;
}

/** Files that must never be tracked, however tempting. */
const MUST_BE_IGNORED = [
  /^\.env$/,
  /^\.env\./,
  /^config\/channels\.txt$/,
  /^state\//,
  /^logs\//,
  /^report\.html$/,
  /^docs\/turnover\//,
  // The agent-pipe mailbox: working notes and proposed diffs between two Claude sessions
  // sharing this tree. Conversation, not history, and `git add -f` is all it would take.
  /^\.agent-pipe\//,
];

export function checkIgnored(files) {
  return files
    .filter((f) => MUST_BE_IGNORED.some((re) => re.test(f.path)) && f.path !== '.env.example')
    .map((f) => error('secrets', `${f.path} is tracked but must be git-ignored`));
}

/**
 * Line endings, for the three kinds .gitattributes pins. A CRLF shell wrapper fails as
 * `/bin/sh^M: bad interpreter` and a CRLF Makefile runs `node make.js version\r` - both
 * report a missing command rather than a line ending, and both fail unattended.
 */
export function checkEndings(files) {
  return files
    .filter((f) => /\.(sh|plist)$/.test(f.path) || f.path === 'Makefile')
    .filter((f) => f.content.includes('\r\n'))
    .map((f) => error('endings', `${f.path} has CRLF line endings; .gitattributes pins it to LF`));
}

/**
 * CLAUDE.md section 13: the bookkeeping is part of the change. The git history was
 * squashed when this repo went public, so WORKLOG.md, VERSIONS.md and features.yaml
 * *are* the project's memory - there is no commit log behind them to reconstruct from.
 *
 * A warning rather than an error: a genuine one-line typo fix should not be blocked, and
 * a check that blocks legitimate work is a check people learn to bypass.
 */
export function checkBookkeeping(changed) {
  const code = changed.filter((p) => /^(src\/|test\/)/.test(p) || ['make.js', 'checks.js', 'Makefile', 'build.ps1'].includes(p));
  if (!code.length) return [];
  const books = ['WORKLOG.md', 'VERSIONS.md', 'features.yaml'].filter((b) => !changed.includes(b));
  if (!books.length) return [];
  return [
    warn(
      'bookkeeping',
      `${code.length} code file(s) changed but ${books.join(', ')} did not. ` +
        'The diff shows what changed; these say why, and there is no commit log behind them.'
    ),
  ];
}

/** Node against the engines floor, and a lockfile that exists. */
export function checkEngines(pkg, version = process.version) {
  const found = [];
  const floor = pkg.engines?.node;
  if (!floor) return [warn('engines', 'package.json declares no engines.node floor')];
  const want = floor.replace(/^[^\d]*/, '').split('.').map(Number);
  const have = version.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < want.length; i++) {
    if ((have[i] || 0) > (want[i] || 0)) break;
    if ((have[i] || 0) < (want[i] || 0)) {
      found.push(error('engines', `node ${version} is below the declared floor ${floor}`));
      break;
    }
  }
  return found;
}

/**
 * Every check name this file can emit must have a row in the README's check table.
 *
 * The gap this closes was real and was found by hand: `targets` shipped emitting findings
 * with no row describing it, so the table quietly documented 11 of 12 checks. That is the
 * same drift checkDocumentedTargets() already guards for targets, so it lives under the
 * same `docs` name and the same warning level.
 *
 * The names are scanned out of the source rather than kept in a list beside it, because a
 * list is one more thing to forget to update - which is the defect, not the fix. Scanning
 * has its own failure mode, though: a regex that silently matches nothing would report a
 * clean bill forever, so finding no names at all is itself a finding.
 */
export function checkDocumentedChecks(source, readme) {
  const names = [...new Set([...String(source).matchAll(/\b(?:error|warn)\(\s*'([a-z-]+)'/g)].map((m) => m[1]))];
  if (!names.length) {
    return [error('docs', 'no check names found in checks.js - the scan in checkDocumentedChecks has broken')];
  }
  // Only the check table, so a target of the same name in the targets table cannot stand in
  // for a missing row here.
  const table = /\| Check \| Level \|[\s\S]*?(?:\n\n|$)/.exec(String(readme))?.[0] || '';
  return names
    .filter((name) => !new RegExp(`\\|\\s*\`${name}\``).test(table))
    .map((name) => warn('docs', `check "${name}" has no row in the README check table`));
}

/** Every target `make help` prints should be findable in the README. */
export function checkDocumentedTargets(targetNames, readme) {
  return targetNames
    .filter((name) => !new RegExp(`\`${name}[\`,]`).test(readme))
    .map((name) => warn('docs', `target "${name}" is not mentioned in README.md`));
}

/**
 * The target list embedded in Makefile and build.ps1 against the registry that produced
 * it. An error, not a warning: a stale list is a menu that lies about what exists, which
 * is the failure the generated block was added to prevent - four separate reports of
 * "I do not see target X" for targets that were already there.
 */
export function checkShims(expected, current) {
  const found = [];
  for (const [file, want] of Object.entries(expected)) {
    if (current[file] === undefined) {
      found.push(error('shims', `${file} has no >>> targets >>> block; run \`make sync-shims\``));
    } else if (current[file] !== want) {
      found.push(error('shims', `${file}'s target list is out of date; run \`make sync-shims\``));
    }
  }
  return found;
}

/**
 * Every documented argument must survive a make command line.
 *
 * Two characters cannot: a colon, which make reads as a rule separator and dies on while
 * still parsing the Makefile - before make.js runs, so no useful message is possible - and
 * a leading `--`, which make claims as its own option. Both were found the hard way, by
 * `change-run-time 04:30` and by `run --max=1`, so this keeps them from being reintroduced
 * in a new target's argument spec where the same discovery would have to happen again.
 */
export function checkTargetArgs(targets) {
  const found = [];
  for (const { name, args } of targets) {
    if (!args) continue;
    if (args.includes(':')) {
      found.push(error('targets', `${name}'s arguments contain ":" - make reads it as a rule separator (use HHMM, not HH:MM)`));
    }
    // Anywhere, not just at a word boundary: the first attempt anchored on whitespace and
    // missed "[--max=N]", where the -- follows a bracket.
    if (args.includes('--')) {
      found.push(error('targets', `${name}'s arguments contain a raw --flag - make claims those; use key=value`));
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------
// The impure checks - external tools, used only when they are there
// ---------------------------------------------------------------------------------

function checkPlists() {
  // plutil is macOS-only. A malformed plist is rejected by launchd at bootstrap with a
  // message about the path, so catching it here is worth the platform-specific branch.
  if (!has('plutil')) return [warn('plists', 'plutil not available; plist syntax not checked')];
  const found = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'launchd'))) {
    if (!f.endsWith('.plist')) continue;
    const r = spawnSync('plutil', ['-lint', path.join('launchd', f)], { cwd: ROOT, encoding: 'utf8' });
    if (r.status !== 0) found.push(error('plists', `launchd/${f}: ${(r.stdout || r.stderr).trim()}`));
  }
  return found;
}

function checkShell() {
  if (!has('shellcheck')) return [warn('shell', 'shellcheck not available; wrappers not checked')];
  const scripts = fs.readdirSync(ROOT).filter((f) => f.endsWith('.sh'));
  if (!scripts.length) return [];
  // -s sh because the wrappers are POSIX sh on purpose: the macOS /bin/bash is 3.2 and a
  // daemon cannot count on a newer one.
  const r = spawnSync('shellcheck', ['-s', 'sh', ...scripts], { cwd: ROOT, encoding: 'utf8' });
  if (r.status === 0) return [];
  return [warn('shell', `shellcheck found issues:\n${(r.stdout || r.stderr).trim()}`)];
}

function checkAudit() {
  // A command string with shell:true rather than an args array, for the same DEP0190
  // reason as has(); npm on Windows is a .cmd and cannot be spawned without a shell.
  const r = spawnSync('npm audit --json', { cwd: ROOT, encoding: 'utf8', shell: true });
  let v;
  try {
    v = JSON.parse(r.stdout).metadata.vulnerabilities;
  } catch {
    // Offline, or a registry that would not answer. Not a reason to fail a push.
    return [warn('audit', 'npm audit could not run (offline?); dependencies not checked')];
  }
  const bad = ['critical', 'high', 'moderate', 'low'].filter((k) => v[k] > 0).map((k) => `${v[k]} ${k}`);
  if (!bad.length) return [];
  return [warn('audit', `npm audit reports ${bad.join(', ')} - run \`npm audit\` for detail`)];
}

// ---------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------

/** The channel handles configured locally, so the secret scan knows what to look for. */
function localHandles() {
  try {
    return fs
      .readFileSync(path.join(ROOT, 'config', 'channels.txt'), 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(/\s+/)[0].replace(/^@/, ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/** What has changed against the upstream branch, working tree included. */
function changedPaths() {
  const upstream = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!upstream.ok) return null; // no upstream: nothing to compare a push against
  const diff = git(['diff', '--name-only', upstream.out]);
  if (!diff.ok) return null;
  const staged = git(['ls-files', '--others', '--exclude-standard']);
  return [...new Set([...diff.out.split('\n'), ...staged.out.split('\n')].filter(Boolean))];
}

/** Is this path git-ignored? Only consulted for links that are already missing. */
function gitIgnores(rel) {
  return spawnSync('git', ['check-ignore', '-q', rel], { cwd: ROOT }).status === 0;
}

const read = (p) => {
  try {
    return fs.readFileSync(path.join(ROOT, p), 'utf8');
  } catch {
    return '';
  }
};

export async function runAllChecks({ targetNames = [], targets = [], shims = null } = {}) {
  const files = trackedFiles();
  const changed = changedPaths();

  const findings = [
    ...checkManifest(read('features.yaml'), read('VERSIONS.md')),
    ...checkLinks(files, undefined, gitIgnores),
    ...scanSecrets(files, localHandles()),
    ...checkIgnored(files),
    ...checkEndings(files),
    ...checkEngines(JSON.parse(read('package.json'))),
    ...checkDocumentedTargets(targetNames, read('README.md')),
    ...checkDocumentedChecks(read('checks.js'), read('README.md')),
    ...(shims ? checkShims(shims.expected, shims.current) : []),
    ...checkTargetArgs(targets),
    ...checkPlists(),
    ...checkShell(),
    ...checkAudit(),
  ];

  if (changed === null) {
    findings.push(warn('bookkeeping', 'no upstream branch to compare against; bookkeeping not checked'));
  } else {
    findings.push(...checkBookkeeping(changed));
  }
  return findings;
}
