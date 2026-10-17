/**
 * Google OAuth for the YouTube Data API: the authorized client every run uses, and the
 * one-time interactive flow (`npm run authorize`) that mints its refresh token.
 *
 * Every credential comes from `.env` (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
 * GOOGLE_REFRESH_TOKEN). Nothing here is hard-coded, because this repo is public
 * (CLAUDE.md section 12).
 *
 * @module auth
 */

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { authenticate } from '@google-cloud/local-auth';
import { google } from 'googleapis';

/** Directory holding this module (`src/`). */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** Repository root, one level above `src/`. */
const ROOT = path.resolve(__dirname, '..');
/** The `.env` file the refresh token is written back into. */
const ENV_PATH = path.join(ROOT, '.env');

/**
 * OAuth scopes requested by `npm run authorize`.
 *
 * YouTube (manage playlists). Gmail is NOT used — email goes via Microsoft Graph.
 *
 * @type {string[]}
 */
export const SCOPES = ['https://www.googleapis.com/auth/youtube'];

/**
 * Build an authorized OAuth2 client from env vars (GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN).
 * googleapis auto-refreshes the access token from the refresh token on each call.
 *
 * @returns {Promise<import('googleapis').Auth.OAuth2Client>} A client carrying the refresh
 *   token; no network call is made until it is first used.
 * @throws {Error} When GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing, or when
 *   GOOGLE_REFRESH_TOKEN is missing (the message says to run `npm run authorize`).
 */
export async function getAuthorizedClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret) {
    throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env.');
  }
  if (!refreshToken) {
    throw new Error(
      'Missing GOOGLE_REFRESH_TOKEN in .env. Run:\n\n    npm run authorize\n\n' +
        'and sign in as the Google account that owns (or will own) the playlists.'
    );
  }

  const client = new google.auth.OAuth2(clientId, clientSecret);
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

/**
 * Upsert a KEY=value line in the .env file.
 *
 * Rewrites the key's line in place when it exists and appends otherwise, so every other
 * line of `.env` (comments included) is left as it was. A missing `.env` is created.
 *
 * @param {string} key - Variable name; used verbatim in a regular expression, so only
 *   pass plain identifiers.
 * @param {string} value - Value to store.
 * @returns {Promise<void>}
 * @throws {Error} When `.env` cannot be written.
 */
async function upsertEnv(key, value) {
  let env = '';
  try {
    env = await fs.readFile(ENV_PATH, 'utf8');
  } catch {
    // no .env yet
  }
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(env)) {
    env = env.replace(re, line);
  } else {
    if (env && !env.endsWith('\n')) env += '\n';
    env += line + '\n';
  }
  await fs.writeFile(ENV_PATH, env);
}

/**
 * Run the interactive browser OAuth flow (used by `npm run authorize`).
 * Builds a temporary client file from the env client id/secret so @google-cloud/local-auth
 * can run the loopback flow, then saves the resulting refresh token back into .env.
 * The temporary file holds the client secret, so it is removed in a `finally` whether
 * or not the flow succeeds.
 *
 * @returns {Promise<void>}
 * @throws {Error} When the client id/secret are missing, when the browser flow fails, or
 *   when Google returns no refresh token (the message says how to revoke and retry).
 */
export async function runAuthFlow() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env.');
  }

  // local-auth needs a client secret file on disk; write a temp one from env.
  const tmp = path.join(os.tmpdir(), `yt-oauth-${process.pid}.json`);
  await fs.writeFile(
    tmp,
    JSON.stringify({
      installed: {
        client_id: clientId,
        client_secret: clientSecret,
        auth_uri: 'https://accounts.google.com/o/oauth2/auth',
        token_uri: 'https://oauth2.googleapis.com/token',
        redirect_uris: ['http://localhost'],
      },
    })
  );

  try {
    const client = await authenticate({ scopes: SCOPES, keyfilePath: tmp });
    const refreshToken = client.credentials?.refresh_token;
    if (!refreshToken) {
      throw new Error(
        'No refresh token returned. Revoke prior access at https://myaccount.google.com/permissions and retry.'
      );
    }
    await upsertEnv('GOOGLE_REFRESH_TOKEN', refreshToken);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}
