'use strict';

// Usage: node scripts/setup-agent-app.js
//
// Ava joins the call as her own leg. Twilio reaches that leg through a TwiML App
// whose Voice URL is PUBLIC_BASE_URL/twilio/agent-leg. This script creates that
// TwiML App in your Twilio account (or updates its URL if TWILIO_AGENT_APP_SID is
// already set) and writes the SID into .env. Run it again whenever PUBLIC_BASE_URL changes.
const { envPath, setEnvValue } = require('./env-file');

require('dotenv').config({ path: envPath, quiet: true });

const twilio = require('twilio');

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
const publicBaseUrl = (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
const existingSid = (process.env.TWILIO_AGENT_APP_SID || '').trim();

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !/^https:\/\//.test(publicBaseUrl)) {
  console.error('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and an https PUBLIC_BASE_URL must be set in .env first.');
  process.exit(1);
}

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const voiceUrl = `${publicBaseUrl}/twilio/agent-leg`;

(async () => {
  if (existingSid) {
    const updated = await client.applications(existingSid).update({ voiceUrl, voiceMethod: 'POST' });
    console.log(`Updated TwiML App ${updated.sid}: Voice URL is now ${voiceUrl}`);
    return;
  }

  const created = await client.applications.create({
    friendlyName: 'Warm transfer playground - Ava leg',
    voiceUrl,
    voiceMethod: 'POST',
  });
  setEnvValue('TWILIO_AGENT_APP_SID', created.sid);
  console.log(`Created TwiML App ${created.sid} with Voice URL ${voiceUrl}`);
  console.log('TWILIO_AGENT_APP_SID was written to .env. Restart the server.');
})().catch((err) => {
  console.error(`Twilio rejected the request: ${err.code ? `error ${err.code}: ` : ''}${err.message}`);
  process.exit(1);
});
