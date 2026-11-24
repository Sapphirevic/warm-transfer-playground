'use strict';

// Usage: npm run tunnel
// Opens an ngrok tunnel to the local server and writes its public URL into
// PUBLIC_BASE_URL in .env. Leave it running; start (or restart) the server after it.
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
require('dotenv').config({ path: envPath, quiet: true });

const ngrok = require('@ngrok/ngrok');

const port = Number(process.env.PORT) || 3000;
const authtoken = (process.env.NGROK_AUTHTOKEN || '').trim();

if (!authtoken) {
  console.error('NGROK_AUTHTOKEN is empty. Copy your token from https://dashboard.ngrok.com/get-started/your-authtoken into .env.');
  process.exit(1);
}

function saveUrl(url) {
  const before = fs.readFileSync(envPath, 'utf8');
  const line = `PUBLIC_BASE_URL=${url}`;
  const after = /^PUBLIC_BASE_URL=.*$/m.test(before)
    ? before.replace(/^PUBLIC_BASE_URL=.*$/m, line)
    : `${before.replace(/\s*$/, '')}\n${line}\n`;
  if (after === before) return false;
  fs.writeFileSync(envPath, after);
  return true;
}

(async () => {
  const listener = await ngrok.forward({ addr: port, authtoken });
  const url = listener.url();
  const changed = saveUrl(url);

  console.log(`ngrok tunnel: ${url} -> http://localhost:${port}`);
  console.log(changed ? 'PUBLIC_BASE_URL in .env was updated. Restart the server so it picks up the new URL.' : 'PUBLIC_BASE_URL in .env already had this URL.');
  console.log(`ElevenLabs tool URL: ${url}/tool/request-transfer`);
  console.log('Leave this running. Press Ctrl+C to close the tunnel.');

  // Keep the process (and with it the tunnel) alive.
  setInterval(() => {}, 1 << 30);
  process.on('SIGINT', async () => {
    await ngrok.disconnect();
    process.exit(0);
  });
})().catch((err) => {
  console.error(`Could not start the ngrok tunnel: ${err.message}`);
  process.exit(1);
});
