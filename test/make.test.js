import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLEAN_PATHS,
  channelLines,
  eatenMakeFlags,
  envKeysSet,
  findTarget,
  handleOf,
  invocation,
  meetsEngine,
  removeChannel,
  renderHelp,
  renderPlist,
  suggestions,
  getEnvValue,
  parseClock,
  setEnvValue,
  setPlistTime,
  shimTargetBlock,
  spliceBetween,
  targetGroups,
  toCliArgs,
  validEmail,
  watchdogTime,
} from '../make.js';

// The one that matters most: `clean` must never learn to tidy state/. The watched ledger
// lives there and a deletion without it becomes a delete/re-add loop at 100 quota units
// per video per night (CLAUDE.md section 11).
test('clean never touches state/', () => {
  assert.ok(!CLEAN_PATHS.includes('state'));
  assert.ok(!CLEAN_PATHS.some((p) => p.startsWith('state')));
  assert.deepEqual(CLEAN_PATHS, ['logs', 'report.html']);
});

test('toCliArgs promotes key=value to a flag and leaves everything else alone', () => {
  assert.deepEqual(toCliArgs(['max=1']), ['--max=1']);
  assert.deepEqual(toCliArgs(['max-removals=0']), ['--max-removals=0']);
  assert.deepEqual(toCliArgs(['@Handle']), ['@Handle']);
  assert.deepEqual(toCliArgs(['--dry-run']), ['--dry-run']);
  // A value containing = survives intact: only the first = separates the key.
  assert.deepEqual(toCliArgs(['shorts-title=A=B']), ['--shorts-title=A=B']);
});

test('eatenMakeFlags names the flags make swallows', () => {
  // `make run --dry-run` leaves MAKEFLAGS=n: make took it as its own -n, so the recipe is
  // echoed and nothing runs, which reads as a dry run that worked.
  assert.equal(eatenMakeFlags('n').length, 1);
  assert.match(eatenMakeFlags('n')[0], /--dry-run/);
  // `--max=1` is matched as an abbreviation of make's --max-load and becomes -l 1.
  assert.match(eatenMakeFlags('l 1')[0], /--max/);
  // A command-line variable assignment is not an option letter.
  assert.deepEqual(eatenMakeFlags('ARGS=--report-watched'), []);
  assert.deepEqual(eatenMakeFlags(''), []);
  assert.deepEqual(eatenMakeFlags(undefined), []);
});

test('handleOf ignores comments and blanks, and normalises the handle', () => {
  assert.equal(handleOf('@SomeChannel'), 'somechannel');
  assert.equal(handleOf('SomeChannel after=2026-01-01'), 'somechannel');
  assert.equal(handleOf('   @SomeChannel   '), 'somechannel');
  assert.equal(handleOf('# a comment'), null);
  assert.equal(handleOf(''), null);
});

test('channelLines reports 1-based line numbers through comments', () => {
  const lines = channelLines('# header\n\n@First\n@Second shorts=only\n');
  assert.deepEqual(
    lines.map((l) => [l.handle, l.lineNo]),
    [
      ['first', 3],
      ['second', 4],
    ]
  );
});

test('removeChannel drops only the named line and returns it verbatim', () => {
  const content = '# keep me\n@First after=2026-01-01\n@Second\n';
  const { content: out, removed } = removeChannel(content, '@First');
  assert.deepEqual(removed, ['@First after=2026-01-01']);
  assert.ok(out.includes('# keep me'));
  assert.ok(out.includes('@Second'));
  assert.ok(!out.includes('@First'));
});

test('removeChannel matches without the @ and ignoring case', () => {
  const { removed } = removeChannel('@SomeChannel\n', 'somechannel');
  assert.deepEqual(removed, ['@SomeChannel']);
});

// AGENTS.md: the working tree is deliberately mixed and git normalizes on checkout, so
// rewriting a file's endings as a side effect turns a one-line edit into a whole-file diff.
test('removeChannel keeps the file’s existing line endings', () => {
  const { content } = removeChannel('@First\r\n@Second\r\n', '@First');
  assert.ok(content.includes('\r\n'));
  assert.ok(!/[^\r]\n/.test(content));
});

test('envKeysSet reports names only, and ignores empty values', () => {
  const set = envKeysSet('GOOGLE_CLIENT_ID=abc123\nACCOUNT_LABEL=\nREPORT_TO="x@example.com"\n# C=d\n');
  assert.ok(set.has('GOOGLE_CLIENT_ID'));
  assert.ok(set.has('REPORT_TO'));
  assert.ok(!set.has('ACCOUNT_LABEL'), 'an empty value is not "set"');
  assert.ok(!set.has('C'), 'a commented line is not a key');
  // This repo is public and doctor output gets pasted into issues: no value may escape.
  assert.ok(![...set].some((k) => k.includes('abc123')));
});

test('meetsEngine compares against the package.json floor', () => {
  assert.equal(meetsEngine('v20.12.0', '>=20.12.0'), true);
  assert.equal(meetsEngine('v22.0.0', '>=20.12.0'), true);
  assert.equal(meetsEngine('v20.11.1', '>=20.12.0'), false);
  assert.equal(meetsEngine('v18.20.4', '>=20.12.0'), false);
});

test('renderPlist fills both documented placeholders', () => {
  const out = renderPlist('<string>__REPO_DIR__/run-sync.sh</string><string>__RUN_AS_USER__</string>', {
    repoDir: '/Users/someone/repo',
    user: 'someone',
  });
  assert.ok(out.includes('/Users/someone/repo/run-sync.sh'));
  assert.ok(out.includes('<string>someone</string>'));
  assert.ok(!out.includes('__'));
});

test('invocation names the shim for the platform', () => {
  assert.equal(invocation('win32'), '.\\build.ps1');
  assert.equal(invocation('darwin'), 'make');
});

test('every target has a summary and a run function, with no duplicate names', () => {
  const items = targetGroups().flatMap((g) => g.items);
  const names = items.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'duplicate target name');
  for (const t of items) {
    assert.ok(t.summary, `${t.name} has no summary`);
    assert.equal(typeof t.run, 'function', `${t.name} has no run()`);
  }
});

// help is generated from the registry, so a target that exists is a target that is
// documented - the failure this replaces is a hand-maintained menu going stale.
test('renderHelp lists every registered target', () => {
  const groups = targetGroups();
  const help = renderHelp(groups, { how: 'make' });
  for (const t of groups.flatMap((g) => g.items)) {
    assert.ok(help.includes(t.name), `help omits ${t.name}`);
  }
});

test('renderHelp tells make users about the swallowed-flag rule, and PowerShell users not to', () => {
  assert.match(renderHelp(targetGroups(), { how: 'make' }), /ARGS=/);
  assert.doesNotMatch(renderHelp(targetGroups(), { how: '.\\build.ps1' }), /ARGS=/);
});

test('findTarget and suggestions', () => {
  const groups = targetGroups();
  assert.equal(findTarget(groups, 'dry-run').name, 'dry-run');
  assert.equal(findTarget(groups, 'nope'), null);
  assert.ok(suggestions(groups, 'instal').includes('install'));
  assert.ok(suggestions(groups, 'channel').includes('add-channel'));
  assert.deepEqual(suggestions(groups, 'xyzzy'), []);
});

// --- configuration editing ---------------------------------------------------------

test('setEnvValue rewrites in place and leaves everything else alone', () => {
  const before = '# who gets the report\nREPORT_TO=old@example.com\nGOOGLE_CLIENT_ID=abc\n';
  const after = setEnvValue(before, 'REPORT_TO', 'new@example.com');
  assert.ok(after.includes('REPORT_TO=new@example.com'));
  assert.ok(after.includes('# who gets the report'), 'comments survive');
  assert.ok(after.includes('GOOGLE_CLIENT_ID=abc'), 'other keys survive');
  assert.ok(!after.includes('old@example.com'));
});

test('setEnvValue appends a key that is not there yet', () => {
  assert.equal(setEnvValue('A=1\n', 'SYNC_AT', '03:00'), 'A=1\nSYNC_AT=03:00\n');
  assert.equal(setEnvValue('', 'SYNC_AT', '03:00'), 'SYNC_AT=03:00\n');
});

test('setEnvValue keeps CRLF files on CRLF', () => {
  assert.equal(setEnvValue('A=1\r\n', 'B', '2'), 'A=1\r\nB=2\r\n');
});

test('getEnvValue reads a key and strips quotes', () => {
  assert.equal(getEnvValue('REPORT_TO="a@example.com"\n', 'REPORT_TO'), 'a@example.com');
  assert.equal(getEnvValue('A=1\n', 'MISSING'), null);
});

test('validEmail catches the shape that would silently fail to deliver', () => {
  assert.ok(validEmail('a@example.com'));
  assert.ok(!validEmail('example.com'), 'no @');
  assert.ok(!validEmail('a@example'), 'no dot in the domain');
  assert.ok(!validEmail('a b@example.com'), 'whitespace');
});

// HHMM is canonical because it is the only spelling that survives every shell: a colon is
// a rule separator to make, which dies parsing the Makefile before make.js runs, and
// quoting does not help - the shell strips it first.
test('parseClock takes four-digit HHMM, and tolerates HH:MM', () => {
  assert.deepEqual(parseClock('0300'), { hour: 3, minute: 0 });
  assert.deepEqual(parseClock('2330'), { hour: 23, minute: 30 });
  assert.deepEqual(parseClock('0000'), { hour: 0, minute: 0 });
  assert.deepEqual(parseClock('04:30'), { hour: 4, minute: 30 }, 'still accepted, just not taught');
  for (const bad of ['3pm', '2400', '0360', '430', '', '04-30']) {
    assert.throws(() => parseClock(bad), /is not a time/, `accepted "${bad}"`);
  }
});

// The gap is the watchdog's whole purpose: on the sync's own schedule it is silent in
// exactly the case it exists to catch.
test('the watchdog follows the sync by six hours, wrapping past midnight', () => {
  assert.deepEqual(watchdogTime({ hour: 3, minute: 0 }), { hour: 9, minute: 0 });
  assert.deepEqual(watchdogTime({ hour: 21, minute: 30 }), { hour: 3, minute: 30 });
  assert.deepEqual(watchdogTime({ hour: 18, minute: 0 }), { hour: 0, minute: 0 });
});

test('setPlistTime rewrites only the StartCalendarInterval times', () => {
  const xml = `<dict><key>StartCalendarInterval</key><dict><key>Hour</key><integer>3</integer>` +
    `<key>Minute</key><integer>0</integer></dict><key>Nice</key><integer>5</integer></dict>`;
  const out = setPlistTime(xml, { hour: 21, minute: 45 });
  assert.ok(out.includes('<key>Hour</key><integer>21</integer>'));
  assert.ok(out.includes('<key>Minute</key><integer>45</integer>'));
  assert.ok(out.includes('<key>Nice</key><integer>5</integer>'), 'other integers are untouched');
});

test('the shim target list is generated between markers, in place', () => {
  const markers = { start: '# >>> targets >>>', end: '# <<< targets <<<' };
  const before = `head\n${markers.start}\nstale\n${markers.end}\ntail\n`;
  assert.equal(spliceBetween(before, markers, '#  fresh'), `head\n${markers.start}\n#  fresh\n${markers.end}\ntail\n`);
  assert.equal(spliceBetween('no markers here', markers, 'x'), null);
});

test('shimTargetBlock names every target under its group', () => {
  const block = shimTargetBlock(targetGroups(), '#   ');
  for (const name of targetGroups().flatMap((g) => g.items.map((t) => t.name))) {
    assert.ok(block.includes(name), `shim list omits ${name}`);
  }
  assert.ok(block.includes('Housekeeping'), 'group titles are kept');
});
