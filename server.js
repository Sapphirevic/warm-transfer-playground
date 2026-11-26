'use strict';

require('dotenv').config({ quiet: true });

const twilio = require('twilio');
const { loadConfig } = require('./src/config');
const { createRegisterCall, createConversationApi } = require('./src/elevenlabs');
const { createApp } = require('./src/app');

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`Config error: ${err.message}`);
  process.exit(1);
}

const client = twilio(config.twilioAccountSid, config.twilioAuthToken);
const { app } = createApp({
  config,
  client,
  registerCall: createRegisterCall(config),
  conversations: createConversationApi(config),
});

// Express 5 calls this with an error if the server could not start (for example the
// port is already taken). Without this check it would print "listening" and then exit.
app.listen(config.port, (err) => {
  if (err) {
    const hint = err.code === 'EADDRINUSE'
      ? `Port ${config.port} is already in use by another program. Stop that program, or set PORT in .env to a free port (then update the ngrok tunnel to match).`
      : err.message;
    console.error(`Could not start the server: ${hint}`);
    process.exit(1);
  }
  console.log(`Warm-transfer playground listening on http://localhost:${config.port}`);
  console.log(`  public URL  : ${config.publicBaseUrl}`);
  console.log('  dial mode   : one at a time, in this order; Iris tells the resident each time one does not pick up');
  console.log(`  technicians : ${config.techNumbers.join(', ')}`);
  console.log(`  ring timeout: ${config.ringTimeoutSec}s`);
  console.log(`  transfer    : agent stays on the call (Iris leg via TwiML App ${config.agentAppSid})`);
  console.log(`  hold music  : ${config.holdDelayMs === null
    ? 'off'
    : `starts ${config.holdDelayMs / 1000}s after the tool call, back ${config.holdResumeMs / 1000}s after each update`}`);
  for (const warning of config.warnings) console.log(`WARN ${warning}`);
  console.log(`  reports     : http://localhost:${config.port}/reports`);
  console.log('Start a test call with:  node scripts/start-call.js +15551234567');
});
