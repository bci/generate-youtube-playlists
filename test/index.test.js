import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/index.js';

test('parseArgs defaults', () => {
  const o = parseArgs([]);
  assert.deepEqual(o.channels, []);
  assert.equal(o.email, false);
  assert.equal(o.emailOnChange, false);
  assert.equal(o.dryRun, false);
  assert.equal(o.maxAdds, Infinity);
});

test('parseArgs collects channels and flags', () => {
  const o = parseArgs(['@A', '@B', '--email-on-change', '--dry-run', '--max=50']);
  assert.deepEqual(o.channels, ['@A', '@B']);
  assert.equal(o.emailOnChange, true);
  assert.equal(o.dryRun, true);
  assert.equal(o.maxAdds, 50);
});

test('parseArgs handles --email and --config', () => {
  const o = parseArgs(['--email', '--config=foo.txt']);
  assert.equal(o.email, true);
  assert.equal(o.config, 'foo.txt');
});
