import path from 'path';
import { fileURLToPath } from 'url';
import { runAuthFlow } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.resolve(__dirname, '..', '.env');

// Load client id/secret from .env before running the flow.
try {
  process.loadEnvFile(ENV_PATH);
} catch {
  // .env missing — runAuthFlow will report the missing vars.
}

// One-time interactive authorization.
// Opens a browser -> sign in as the playlist-owning Google account -> approve YouTube.
// The resulting refresh token is saved back into .env (GOOGLE_REFRESH_TOKEN).
try {
  console.log('Opening a browser for Google sign-in...');
  console.log('IMPORTANT: sign in as the Google account that will own the playlists.\n');
  await runAuthFlow();
  console.log('\n✅ Authorized. GOOGLE_REFRESH_TOKEN saved to .env');
  console.log('\nYou can now run the workflow with:  npm start -- "@SomeChannel"');
} catch (err) {
  console.error('\n❌ Authorization failed:\n');
  console.error(err.message || err);
  process.exit(1);
}
