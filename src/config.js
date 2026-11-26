'use strict';

const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const E164_RE = /^\+[1-9]\d{6,14}$/;

const REQUIRED = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_PHONE_NUMBER',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_AGENT_ID',
  'TECH_NUMBERS',
  'PUBLIC_BASE_URL',
  'TOOL_SECRET',
  'TWILIO_AGENT_APP_SID',
];

function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !(env[key] || '').trim());
  if (missing.length) {
    const hint = missing.length === 1 && missing[0] === 'TWILIO_AGENT_APP_SID'
      ? 'run "node scripts/setup-agent-app.js" to create the TwiML App and fill it in'
      : 'copy .env.example to .env and fill it in';
    throw new Error(`Missing required env vars: ${missing.join(', ')} (${hint})`);
  }

  const agentAppSid = env.TWILIO_AGENT_APP_SID.trim();
  if (!/^AP[0-9a-f]{32}$/i.test(agentAppSid)) {
    throw new Error('TWILIO_AGENT_APP_SID must be a TwiML App SID (AP followed by 32 hex characters)');
  }

  const techNumbers = env.TECH_NUMBERS.split(',').map((n) => n.trim()).filter(Boolean);
  const badNumbers = [...techNumbers, env.TWILIO_PHONE_NUMBER.trim()].filter((n) => !E164_RE.test(n));
  if (badNumbers.length) {
    throw new Error(`These numbers are not E.164 (e.g. +15551234567): ${badNumbers.join(', ')}`);
  }

  // Technicians are always called one at a time on this branch. DIAL_MODE is no longer
  // read; a leftover "parallel" only produces a startup warning so nobody thinks it applies.
  const warnings = [];
  const dialModeSetting = (env.DIAL_MODE || '').trim().toLowerCase();
  if (dialModeSetting && dialModeSetting !== 'sequential') {
    warnings.push(`DIAL_MODE=${env.DIAL_MODE.trim()} is ignored: technicians are always called one at a time on this branch. Set DIAL_MODE=sequential (valid on every branch) to silence this.`);
  }

  // Branch "iris-troubleshoots-while-searching": no hold music by default. Iris stays with
  // the resident and helps them troubleshoot while technicians are called. Set a number of
  // seconds (e.g. HOLD_MUSIC_DELAY_SEC=5) to bring the music back.
  const holdSetting = (env.HOLD_MUSIC_DELAY_SEC || 'off').trim().toLowerCase();
  const holdDelayMs = holdSetting === 'off' ? null : Number(holdSetting) * 1000;
  if (holdDelayMs !== null && !(holdDelayMs >= 0)) {
    throw new Error(`HOLD_MUSIC_DELAY_SEC must be a number of seconds or "off", got "${env.HOLD_MUSIC_DELAY_SEC}"`);
  }

  const resumeSetting = (env.HOLD_MUSIC_RESUME_SEC || '13').trim();
  const holdResumeMs = Number(resumeSetting) * 1000;
  if (!(holdResumeMs >= 0)) {
    throw new Error(`HOLD_MUSIC_RESUME_SEC must be a number of seconds, got "${env.HOLD_MUSIC_RESUME_SEC}"`);
  }

  const publicBaseUrl = env.PUBLIC_BASE_URL.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(publicBaseUrl)) {
    throw new Error('PUBLIC_BASE_URL must start with https:// (your ngrok URL, no trailing path)');
  }

  return {
    port: Number(env.PORT) || 3000,
    publicBaseUrl,
    twilioAccountSid: env.TWILIO_ACCOUNT_SID.trim(),
    twilioAuthToken: env.TWILIO_AUTH_TOKEN.trim(),
    twilioPhoneNumber: env.TWILIO_PHONE_NUMBER.trim(),
    elevenLabsApiKey: env.ELEVENLABS_API_KEY.trim(),
    elevenLabsAgentId: env.ELEVENLABS_AGENT_ID.trim(),
    // Optional: the agent branch to run (ElevenLabs agent versioning, "agtbrch_…").
    // Empty = the agent's main branch.
    elevenLabsBranchId: (env.ELEVENLABS_BRANCH_ID || '').trim() || null,
    elevenLabsApiBase: (env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').trim().replace(/\/+$/, ''),
    toolSecret: env.TOOL_SECRET.trim(),
    // Called in this order, one at a time.
    techNumbers,
    warnings,
    ringTimeoutSec: Number(env.RING_TIMEOUT_SEC) || 20,
    // TwiML App whose Voice URL is PUBLIC_BASE_URL/twilio/agent-leg. Iris joins the call through it.
    agentAppSid,
    // Hold music for the resident while technicians are called. It starts this long after
    // the tool call, so Iris can finish saying "please hold". null = no hold music.
    holdDelayMs,
    // When a technician does not take the call, the resident comes off hold so Iris can tell
    // them. This is how long after that the music starts again (and Iris is muted again).
    holdResumeMs,
    // Cues to Iris wait for nobody to be talking for this long (D23)...
    cueQuietGapMs: Number(env.CUE_QUIET_GAP_MS) >= 0 && env.CUE_QUIET_GAP_MS !== undefined && env.CUE_QUIET_GAP_MS !== '' ? Number(env.CUE_QUIET_GAP_MS) : 700,
    // ...but never longer than this before they are sent anyway.
    cueMaxWaitMs: Number(env.CUE_MAX_WAIT_MS) > 0 ? Number(env.CUE_MAX_WAIT_MS) : 8000,
    holdMusicUrl: (env.HOLD_MUSIC_URL || 'http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical').trim(),
    // After a call ends, when to ask ElevenLabs for the transcript (it takes a moment to be ready).
    transcriptRetryMs: [5_000, 20_000, 60_000],
    // Transfer reports (one JSON file per resident call) and optional audio such as connecting.mp3.
    reportsDir: path.join(PROJECT_ROOT, 'reports'),
    publicDir: path.join(PROJECT_ROOT, 'public'),
  };
}

module.exports = { loadConfig, E164_RE };
