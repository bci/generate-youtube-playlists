import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { authenticate } from '@google-cloud/local-auth';
import { google } from 'googleapis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ENV_PATH = path.join(ROOT, '.env');

// YouTube (manage playlists). Gmail is NOT used — email goes via Microsoft Graph.
export const SCOPES = ['https://www.googleapis.com/auth/youtube'];

/**
 * Build an authorized OAuth2 client from env vars (GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN).
 * googleapis auto-refreshes the access token from the refresh token on each call.
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

/** Upsert a KEY=value line in the .env file. */
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
