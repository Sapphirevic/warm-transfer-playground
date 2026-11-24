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
];

function loadConfig(env = process.env) {
  const missing = REQUIRED.filter((key) => !(env[key] || '').trim());
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')} (copy .env.example to .env and fill it in)`);
  }

  const techNumbers = env.TECH_NUMBERS.split(',').map((n) => n.trim()).filter(Boolean);
  const badNumbers = [...techNumbers, env.TWILIO_PHONE_NUMBER.trim()].filter((n) => !E164_RE.test(n));
  if (badNumbers.length) {
    throw new Error(`These numbers are not E.164 (e.g. +15551234567): ${badNumbers.join(', ')}`);
  }

  const dialMode = (env.DIAL_MODE || 'sequential').trim().toLowerCase();
  if (!['sequential', 'parallel'].includes(dialMode)) {
    throw new Error(`DIAL_MODE must be "sequential" or "parallel", got "${env.DIAL_MODE}"`);
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
    elevenLabsApiBase: (env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').trim().replace(/\/+$/, ''),
    toolSecret: env.TOOL_SECRET.trim(),
    techNumbers,
    dialMode,
    ringTimeoutSec: Number(env.RING_TIMEOUT_SEC) || 20,
    holdMusicUrl: (env.HOLD_MUSIC_URL || 'http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical').trim(),
    // Transfer reports (one JSON file per resident call) and optional audio such as connecting.mp3.
    reportsDir: path.join(PROJECT_ROOT, 'reports'),
    publicDir: path.join(PROJECT_ROOT, 'public'),
  };
}

module.exports = { loadConfig, E164_RE };
