// Credentials test: verifies that the secrets in .env are present AND actually
// authenticate. These checks hit the OAuth token endpoints only (no YouTube Data
// API quota is consumed). If a group of env vars is absent, that group is skipped
// so the pure unit tests still pass on a fresh checkout.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // no .env — individual tests below will skip
}

const GOOGLE_VARS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'];
const GRAPH_VARS = ['MS365_TENANT_ID', 'MS365_CLIENT_ID', 'MS365_CLIENT_SECRET'];
const ALL_VARS = [...GOOGLE_VARS, ...GRAPH_VARS, 'MS365_FROM_ADDRESS', 'REPORT_TO'];

test('all required env vars are present in .env', (t) => {
  const anyPresent = ALL_VARS.some((k) => process.env[k]);
  if (!anyPresent) return t.skip('no .env configured');
  const missing = ALL_VARS.filter((k) => !process.env[k]);
  assert.deepEqual(missing, [], `Missing env vars: ${missing.join(', ')}`);
});

test('Google OAuth refresh token is valid (refreshes an access token)', async (t) => {
  if (GOOGLE_VARS.some((k) => !process.env[k])) return t.skip('Google env vars missing');
  const { getAuthorizedClient } = await import('../src/auth.js');
  const auth = await getAuthorizedClient();
  const res = await auth.getAccessToken(); // uses OAuth token endpoint, not YouTube quota
  assert.ok(res && res.token, 'expected an access token from the refresh token');
});

test('Microsoft Graph credentials are valid (acquires a token)', async (t) => {
  if (GRAPH_VARS.some((k) => !process.env[k])) return t.skip('Graph env vars missing');
  const { getGraphToken } = await import('../src/email.js');
  const token = await getGraphToken();
  assert.ok(token, 'expected a Graph access token');
});
