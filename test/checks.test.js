import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkBookkeeping,
  checkDocumentedChecks,
  checkDocumentedTargets,
  checkEndings,
  checkEngines,
  checkIgnored,
  checkLinks,
  checkManifest,
  checkShims,
  checkTargetArgs,
  scanSecrets,
} from '../checks.js';

const errors = (findings) => findings.filter((f) => f.level === 'error');
const VERSIONS = '# Versions\n\n## Unreleased — things\n\n## 2026.09.12 — the first release\n';

const MANIFEST = `
version: 1
updated: 2026-09-15
components:
  - id: core
    name: Node CLI
    path: src
features:
  - id: FEAT-0001
    title: A thing
    description: It does a thing.
    components: [core]
    status: complete
    release: 2026.09.12
    added: 2026-09-12
    updated: 2026-09-12
`;

test('a healthy manifest produces nothing', () => {
  assert.deepEqual(checkManifest(MANIFEST, VERSIONS), []);
});

// AGENTS.md says outright that nothing enforces this and there is no CI for it. This is
// the check that changes that, so it has to actually fire.
test('malformed YAML is reported, not thrown', () => {
  const found = checkManifest('features:\n  - id: [unclosed\n', VERSIONS);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /not valid YAML/);
});

test('a bad status, id or date is caught', () => {
  assert.match(checkManifest(MANIFEST.replace('status: complete', 'status: done'), VERSIONS)[0].message, /status "done"/);
  assert.match(checkManifest(MANIFEST.replace('FEAT-0001', 'FEAT-1'), VERSIONS)[0].message, /zero-padded/);
  assert.match(checkManifest(MANIFEST.replace('added: 2026-09-12', 'added: 2026-02-30'), VERSIONS)[0].message, /not a real date/);
});

test('ids must be unique and ascending, because they are never renumbered', () => {
  const two = MANIFEST + `  - id: FEAT-0001
    title: B
    description: B.
    components: [core]
    status: planned
    release: Unreleased
    added: 2026-09-13
    updated: 2026-09-13
`;
  assert.ok(errors(checkManifest(two, VERSIONS)).some((f) => /duplicate id/.test(f.message)));
});

test('a release that names no VERSIONS.md heading is caught', () => {
  const found = checkManifest(MANIFEST.replace('release: 2026.09.12', 'release: 2026.01.01'), VERSIONS);
  assert.match(found[0].message, /not a heading in VERSIONS.md/);
});

test('an unknown component is caught', () => {
  const found = checkManifest(MANIFEST.replace('components: [core]', 'components: [nope]'), VERSIONS);
  assert.match(found[0].message, /unknown component "nope"/);
});

// --- the public-repo scan ----------------------------------------------------------

test('example.com addresses are fine; a real one is not', () => {
  assert.deepEqual(scanSecrets([{ path: 'README.md', content: 'mail reports@example.com today' }]), []);
  const found = scanSecrets([{ path: 'README.md', content: 'mail someone@acme.co today' }]);
  assert.equal(found[0].level, 'error');
  assert.match(found[0].message, /someone@acme\.co/);
});

test('credentials and ids are caught', () => {
  const cases = [
    ['123456789012-abcdefghijklmnopqrstuvwxyz12.apps.googleusercontent.com', /client id/],
    ['GOCSPX-abcdefghijklmnopqrstuvwxyz1', /client secret/],
    ['1//0abcdefghijklmnopqrstuvwxyzABCDEFGHIJ', /refresh token/],
    ['PLabcdefghijklmnopq', /playlist id/],
    ['UCabcdefghijklmnopqrstuv', /channel id/],
    ['5f0e8a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b', /GUID/],
  ];
  for (const [secret, expected] of cases) {
    const found = scanSecrets([{ path: 'notes.md', content: `value: ${secret}` }]);
    assert.ok(found.length, `no finding for ${secret}`);
    assert.match(found[0].message, expected);
  }
});

test('the .env.example placeholder is not mistaken for a real client id', () => {
  const content = 'GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com';
  assert.deepEqual(scanSecrets([{ path: '.env.example', content }]), []);
});

test('package-lock.json is not scanned for addresses', () => {
  assert.deepEqual(scanSecrets([{ path: 'package-lock.json', content: '"email": "i@izs.me"' }]), []);
});

test('a real channel handle in a tracked file is caught', () => {
  const found = scanSecrets([{ path: 'README.md', content: 'try @MyPrivateChannel' }], ['MyPrivateChannel']);
  assert.match(found[0].message, /names @MyPrivateChannel/);
});

test('files that must be git-ignored are caught if tracked', () => {
  const found = checkIgnored([
    { path: '.env', content: '' },
    { path: 'state/seen.json', content: '' },
    { path: '.agent-pipe/to-cli/msg.md', content: '' },
    { path: '.env.example', content: '' },
    { path: 'src/index.js', content: '' },
  ]);
  assert.equal(found.length, 3);
  assert.ok(found.every((f) => f.level === 'error'));
});

// --- the rest ----------------------------------------------------------------------

test('links resolve relative to the file that contains them', () => {
  const files = [{ path: 'docs/prompts/a.md', content: '[b](b.md) [root](../../AGENTS.md) [gone](nope.md)' }];
  const exists = (p) => ['docs/prompts/b.md', 'AGENTS.md'].includes(p);
  const found = checkLinks(files, exists);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /nope\.md/);
});

// .agent-pipe/ is created on demand by the agent-pipe skill and never committed, so a link
// to it is correct even though the path is absent in a fresh checkout.
test('links to git-ignored paths are not reported as broken', () => {
  const files = [{ path: 'CLAUDE.md', content: '[pipe](.agent-pipe/README.md) [gone](nope.md)' }];
  const found = checkLinks(files, () => false, (p) => p.startsWith('.agent-pipe/'));
  assert.equal(found.length, 1);
  assert.match(found[0].message, /nope\.md/);
});

test('external links and anchors are left alone', () => {
  const files = [{ path: 'a.md', content: '[x](https://e.com) [y](#usage) [z](mailto:a@example.com)' }];
  assert.deepEqual(checkLinks(files, () => false), []);
});

// A CRLF wrapper fails as `/bin/sh^M: bad interpreter` at 3 AM, unattended.
test('CRLF is caught in the files .gitattributes pins to LF', () => {
  const found = checkEndings([
    { path: 'run-sync.sh', content: '#!/bin/sh\r\necho hi\r\n' },
    { path: 'Makefile', content: 'all:\r\n\techo\r\n' },
    { path: 'launchd/a.plist', content: '<plist>\r\n' },
    { path: 'README.md', content: 'fine\r\n' },
    { path: 'run-watchdog.sh', content: '#!/bin/sh\necho\n' },
  ]);
  assert.equal(found.length, 3, 'README.md is not pinned, and the LF wrapper is fine');
  assert.ok(found.every((f) => f.level === 'error'));
});

test('bookkeeping fires only when code changed without it', () => {
  assert.deepEqual(checkBookkeeping(['README.md']), [], 'docs-only change needs no worklog');
  assert.deepEqual(checkBookkeeping(['src/index.js', 'WORKLOG.md', 'VERSIONS.md', 'features.yaml']), []);
  const found = checkBookkeeping(['src/index.js', 'make.js']);
  assert.equal(found.length, 1);
  assert.equal(found[0].level, 'warn', 'a warning: it must not block a genuine typo fix');
  assert.match(found[0].message, /WORKLOG.md/);
});

test('engines is checked against the running node', () => {
  const pkg = { engines: { node: '>=20.12.0' } };
  assert.deepEqual(checkEngines(pkg, 'v22.1.0'), []);
  assert.deepEqual(checkEngines(pkg, 'v20.12.0'), []);
  assert.equal(errors(checkEngines(pkg, 'v20.11.9')).length, 1);
});

test('undocumented targets are reported', () => {
  const readme = 'we have `run` and `test` here';
  const found = checkDocumentedTargets(['run', 'test', 'mystery'], readme);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /mystery/);
});

// Four separate "I do not see target X" reports for targets that already existed are why
// the shims carry a generated list at all; a stale one would be the same failure again.
test('a stale or missing shim target list is an error', () => {
  assert.deepEqual(checkShims({ Makefile: 'a' }, { Makefile: 'a' }), []);
  assert.match(checkShims({ Makefile: 'a' }, { Makefile: 'b' })[0].message, /out of date/);
  assert.match(checkShims({ Makefile: 'a' }, {})[0].message, /no >>> targets >>> block/);
});

// The colon in change-run-time's first spelling killed make while it was still parsing the
// Makefile - before make.js ran, so no useful message was possible. This keeps a new
// target from reintroducing either character in its argument spec.
test('arguments that cannot survive a make command line are errors', () => {
  assert.match(checkTargetArgs([{ name: 't', args: '<HH:MM>' }])[0].message, /rule separator/);
  assert.match(checkTargetArgs([{ name: 't', args: '[--max=N]' }])[0].message, /key=value/);
  assert.deepEqual(checkTargetArgs([{ name: 't', args: '<HHMM> [shorts=split]' }]), []);
  assert.deepEqual(checkTargetArgs([{ name: 't' }]), [], 'a target with no arguments is fine');
});

// `targets` shipped emitting findings with no row describing it, so the table documented 11
// of 12 checks. Found by hand; this is what stops the next one.
test('a check with no row in the README table is reported', () => {
  const readme = '| Check | Level | What |\n| --- | --- | --- |\n| `secrets` | error | x |\n\n';
  const found = checkDocumentedChecks("error('secrets', 'a'); warn('newcheck', 'b');", readme);
  assert.equal(found.length, 1);
  assert.match(found[0].message, /"newcheck" has no row/);
  assert.deepEqual(checkDocumentedChecks("error('secrets', 'a')", readme), []);
});

// A row in the targets table must not stand in for a missing row in the check table.
test('only the check table counts', () => {
  const readme = '| Target |\n| `newcheck` |\n\n| Check | Level |\n| `secrets` | error |\n\n';
  assert.equal(checkDocumentedChecks("warn('newcheck', 'b')", readme).length, 1);
});

// Scanning the source beats keeping a list beside it, but a regex that silently matches
// nothing would report a clean bill forever - so finding no names is itself a finding.
test('a scan that finds nothing reports itself rather than passing', () => {
  const found = checkDocumentedChecks('no calls here', '| Check | Level |\n');
  assert.equal(found.length, 1);
  assert.match(found[0].message, /scan in checkDocumentedChecks has broken/);
});
