'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const twilio = require('twilio');
const { E164_RE } = require('./config');
const { createReportStore, buildReport, renderList, renderDetail } = require('./reports');

const { VoiceResponse } = twilio.twiml;

const CALL_SID_RE = /^CA[0-9a-f]{32}$/i;
const CALL_ENDED = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);
const MAX_PROMPTS = 3;
const FALLBACK_FIRST_MESSAGE = 'Sorry, no technician is available right now. Can I take a message?';
const RESIDENT_ANNOUNCEMENT = 'A technician has answered. Connecting you now.';
const TECH_ANNOUNCEMENT = 'Connecting you to the resident.';
const LOGGED_FIELDS = [
  'CallSid', 'ParentCallSid', 'CallStatus', 'Direction', 'From', 'To', 'AnsweredBy', 'MachineDetectionDuration',
  'Digits', 'StatusCallbackEvent', 'ConferenceSid', 'FriendlyName', 'RecordingSid', 'RecordingStatus',
  'CallDuration', 'SipResponseCode',
];

const secs = (from, to) => `${((to - from) / 1000).toFixed(1)}s`;
const roomName = (residentCallSid) => `room-${residentCallSid}`;

/**
 * Live call state is in memory (it's a playground): restart the server and running
 * calls are forgotten. Finished transfer reports are kept as JSON files in reports/.
 *
 * @param {object} deps
 * @param {object} deps.config        from loadConfig()
 * @param {object} deps.client        Twilio REST client (or a fake in tests)
 * @param {Function} deps.registerCall  from createRegisterCall()
 * @param {Function} [deps.logger]
 */
function createApp({ config, client, registerCall, logger = console.log }) {
  const app = express();
  app.disable('x-powered-by');

  const base = config.publicBaseUrl;
  const reports = createReportStore(config.reportsDir);
  const connectingFile = path.join(config.publicDir, 'connecting.mp3');
  const residentCalls = new Map(); // resident CallSid -> { direction, number, ended }
  const transfers = new Map(); //     resident CallSid -> transfer (see /tool/request-transfer)

  const log = (message) => logger(`${new Date().toISOString()} ${message}`);

  // ---------------------------------------------------------------- middleware

  // Twilio signs the *public* URL it called. Behind ngrok the local URL is
  // http://localhost:3000/..., so we must rebuild the URL from PUBLIC_BASE_URL.
  function validateTwilio(req, res, next) {
    const url = base + req.originalUrl;
    const signature = req.get('X-Twilio-Signature') || '';
    const valid = twilio.validateRequest(config.twilioAuthToken, signature, url, req.body || {});

    const fields = LOGGED_FIELDS.filter((key) => req.body && req.body[key] !== undefined)
      .map((key) => `${key}=${req.body[key]}`)
      .join(' ');
    log(`WEBHOOK ${req.method} ${req.originalUrl} ${fields}${valid ? '' : ' [INVALID SIGNATURE - rejected]'}`);

    if (!valid) return res.status(403).send('Invalid Twilio signature');
    next();
  }

  // ElevenLabs tool calls (and our own /start-call) are not Twilio requests,
  // so they authenticate with a shared secret header instead.
  function requireToolSecret(req, res, next) {
    const given = Buffer.from(req.get('X-Tool-Secret') || '');
    const expected = Buffer.from(config.toolSecret);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      log(`REJECTED ${req.method} ${req.originalUrl}: missing or wrong X-Tool-Secret`);
      return res.status(401).json({ status: 'error', message: 'Missing or wrong X-Tool-Secret header' });
    }
    next();
  }

  // Reports contain phone numbers and call summaries, so they are only served to a
  // browser on this machine. Anything that came in through the tunnel carries
  // forwarding headers added by ngrok, which the sender cannot remove.
  function localOnly(req, res, next) {
    const remote = req.socket.remoteAddress || '';
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    const forwarded = req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers.forwarded;
    if (!loopback || forwarded) {
      log(`REJECTED ${req.method} ${req.originalUrl}: reports are local-only`);
      return res.status(403).send('Reports are only available at http://localhost on the machine running the server.');
    }
    next();
  }

  const twilioHook = [express.urlencoded({ extended: false }), validateTwilio];
  const secretHook = [express.json(), requireToolSecret];
  const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const sendTwiml = (res, vr) => res.type('text/xml').send(vr.toString());

  // ---------------------------------------------------------------- helpers

  function timing(t, event, detail = '') {
    const now = Date.now();
    log(`TIMING resident=${t.residentCallSid} ${event} +${secs(t.startedAt, now)} after tool call${detail ? ` ${detail}` : ''}`);
    return now;
  }

  function logTimingSummary(t) {
    const start = t.startedAt;
    const winner = t.techs[t.winner];
    const rows = [
      ['tool_call', start],
      ['first_tech_ringing', t.timings.first_tech_ringing],
      ['tech_answered', winner.answeredAt],
      ['tech_pressed_1', winner.pressedAt],
      ['resident_joined', t.timings.resident_joined],
    ].map(([name, at]) => `  ${name.padEnd(19)} ${at ? `${new Date(at).toISOString()}  +${secs(start, at)}` : '(not seen)'}`);
    log(
      `TIMING SUMMARY resident=${t.residentCallSid} winner=tech#${t.winner} ${winner.number}\n${rows.join('\n')}\n` +
        `  => resident waited ${secs(start, t.timings.resident_joined)} from tool call to joining the technician`
    );
  }

  function saveReport(t) {
    try {
      reports.save(buildReport(t, config.dialMode));
    } catch (err) {
      log(`ERROR could not save report for resident=${t.residentCallSid}: ${err.message}`);
    }
  }

  // The transfer is over, one way or another: store the result and print the one-line summary.
  function finish(t, result, at = Date.now()) {
    if (t.result) return;
    t.result = result;
    t.finishedAt = at;
    saveReport(t);

    const outcomes = t.techs
      .filter((tech) => tech.dialledAt)
      .map((tech) => `${tech.number}=${tech.outcome || 'calling'}`)
      .join(', ');
    const who = result === 'connected' ? ` technician=${t.techs[t.winner].number}` : '';
    log(
      `TRANSFER ${result.toUpperCase()} resident=${t.residentNumber} call=${t.residentCallSid}${who} ` +
        `waited=${secs(t.startedAt, at)} mode=${config.dialMode} tried=[${outcomes || 'nobody'}] report=/reports/${t.residentCallSid}`
    );
  }

  // Both legs get the same room settings. Either side leaving ends the conference
  // (endConferenceOnExit), and whoever is first hears the hold audio from waitUrl.
  function conferenceTwiml(residentCallSid, { say, play } = {}) {
    const callback = `${base}/conference/status?resident=${residentCallSid}`;
    const vr = new VoiceResponse();
    if (play) vr.play(play);
    else if (say) vr.say(say);
    vr.dial().conference(
      {
        startConferenceOnEnter: true,
        endConferenceOnExit: true,
        beep: false,
        waitUrl: config.holdMusicUrl,
        waitMethod: 'GET',
        record: 'record-from-start',
        recordingStatusCallback: callback,
        recordingStatusCallbackMethod: 'POST',
        recordingStatusCallbackEvent: 'completed',
        statusCallback: callback,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['start', 'end', 'join', 'leave'],
      },
      roomName(residentCallSid)
    );
    return vr;
  }

  function sayAndHangup(res, text) {
    const vr = new VoiceResponse();
    if (text) vr.say(text);
    vr.hangup();
    sendTwiml(res, vr);
  }

  const twilioError = (err) => `${err.code ? `Twilio error ${err.code}: ` : ''}${err.message}`;

  // Ends one technician call. Twilio needs a different status depending on where the
  // call is: "canceled" for queued/ringing, "completed" for a call that was answered.
  async function endTechCall(t, i, why) {
    const tech = t.techs[i];
    if (!tech.callSid || tech.callEnded) return;
    const label = `tech#${i} ${tech.number} call=${tech.callSid}`;
    const status = tech.callStatus === 'in-progress' ? 'completed' : 'canceled';

    try {
      const call = await client.calls(tech.callSid).update({ status });
      log(`CANCEL ${label} was=${tech.callStatus} sent status=${status} (${why})`);
      // "canceled" does nothing to a call that was picked up in the meantime.
      if (status !== 'canceled' || !call || call.status !== 'in-progress') return;
      log(`CANCEL ${label} was answered in the meantime, sending status=completed`);
    } catch (err) {
      log(`ERROR cancel ${label} with status=${status} failed (${why}): ${twilioError(err)}`);
      if (status !== 'canceled') return;
    }

    try {
      await client.calls(tech.callSid).update({ status: 'completed' });
      log(`CANCEL ${label} sent status=completed (${why})`);
    } catch (err) {
      log(`ERROR cancel ${label} with status=completed failed (${why}): ${twilioError(err)}`);
    }
  }

  // Ends every technician call for this resident (optionally sparing the winner).
  function cancelTechs(t, { except = -1, why }) {
    t.techs.forEach((tech, i) => {
      if (i === except) return;
      if (tech.dialledAt) setOutcome(t, i, 'canceled', why);
      endTechCall(t, i, why);
    });
  }

  // ---------------------------------------------------------------- technician search

  function startSearch(t) {
    log(`SEARCH start resident=${t.residentCallSid} mode=${config.dialMode} techs=${t.techs.map((x) => x.number).join(',')}`);
    if (config.dialMode === 'parallel') {
      // One separate call per technician (not one <Dial> with several <Number>s),
      // so a voicemail picking up can only ever fail its own leg.
      t.techs.forEach((_, i) => dialTech(t, i));
    } else {
      dialNext(t);
    }
  }

  function dialNext(t) {
    if (t.status !== 'searching') return;
    t.cursor += 1;
    if (t.cursor >= t.techs.length) return allFailed(t);
    dialTech(t, t.cursor);
  }

  async function dialTech(t, i) {
    const tech = t.techs[i];
    const query = `resident=${t.residentCallSid}&tech=${i}`;
    tech.dialledAt = Date.now();
    tech.callStatus = 'queued';
    saveReport(t);
    try {
      const call = await client.calls.create({
        to: tech.number,
        from: config.twilioPhoneNumber,
        url: `${base}/tech/answered?${query}`,
        method: 'POST',
        timeout: config.ringTimeoutSec,
        // Async AMD: the brief starts as soon as the technician picks up, and the
        // detection result arrives separately on /tech/amd a few seconds later.
        machineDetection: 'Enable',
        asyncAmd: 'true',
        asyncAmdStatusCallback: `${base}/tech/amd?${query}`,
        asyncAmdStatusCallbackMethod: 'POST',
        statusCallback: `${base}/tech/status?${query}`,
        statusCallbackMethod: 'POST',
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      });
      tech.callSid = call.sid;
      log(`DIAL tech#${i} ${tech.number} call=${call.sid} resident=${t.residentCallSid}`);
      saveReport(t);
      // The search may have ended (winner found / resident hung up) while Twilio was creating the call.
      if (t.status !== 'searching') {
        setOutcome(t, i, 'canceled', 'dialled after the search ended');
        endTechCall(t, i, 'dialled after the search ended');
      }
    } catch (err) {
      log(`ERROR could not dial tech#${i} ${tech.number}: ${twilioError(err)}`);
      resolveTech(t, i, 'failed', `could not dial: ${twilioError(err)}`);
    }
  }

  // Records a technician's final outcome exactly once:
  // accepted | declined | no-answer | busy | voicemail | canceled | failed
  function setOutcome(t, i, outcome, detail) {
    const tech = t.techs[i];
    if (tech.outcome) return false;
    tech.outcome = outcome;
    tech.detail = detail;
    tech.outcomeAt = Date.now();
    log(`TECH tech#${i} ${tech.number} call=${tech.callSid || '-'} -> ${outcome} (${detail}) resident=${t.residentCallSid}`);
    saveReport(t);
    return true;
  }

  // Same, for outcomes that mean "this technician is not taking it": moves the search on.
  function resolveTech(t, i, outcome, detail) {
    if (!setOutcome(t, i, outcome, detail)) return;
    if (t.status !== 'searching') return;

    if (config.dialMode === 'parallel') {
      if (t.techs.every((tech) => tech.outcome)) allFailed(t);
    } else if (i === t.cursor) {
      dialNext(t);
    }
  }

  async function allFailed(t) {
    if (t.status !== 'searching') return;
    t.status = 'failed';
    t.timings.all_failed = timing(t, 'all_technicians_failed', '-> sending resident to /twilio/fallback');
    finish(t, 'no technician', t.timings.all_failed);
    try {
      await client.calls(t.residentCallSid).update({ url: `${base}/twilio/fallback`, method: 'POST' });
    } catch (err) {
      log(`ERROR could not redirect resident=${t.residentCallSid} to fallback: ${twilioError(err)}`);
    }
  }

  // Runs after the winning technician's TwiML (their <Dial><Conference>) has been sent.
  async function bridgeResident(t, winnerIndex) {
    // Use a recorded announcement if one has been dropped into public/, otherwise speak it.
    const announcement = fs.existsSync(connectingFile)
      ? { play: `${base}/public/connecting.mp3` }
      : { say: RESIDENT_ANNOUNCEMENT };
    try {
      // Replacing the resident's TwiML ends the <Connect><Stream> to ElevenLabs, i.e. Ava drops off.
      await client.calls(t.residentCallSid).update({ twiml: conferenceTwiml(t.residentCallSid, announcement).toString() });
      log(`BRIDGE resident=${t.residentCallSid} announcement=${announcement.play ? 'connecting.mp3' : 'spoken'} then ${roomName(t.residentCallSid)}`);
    } catch (err) {
      log(`ERROR could not move resident=${t.residentCallSid} into the conference: ${twilioError(err)}`);
      t.status = 'cancelled';
      finish(t, 'resident hung up');
      const winner = t.techs[winnerIndex];
      const vr = new VoiceResponse();
      vr.say('Sorry, the resident is no longer on the line. Goodbye.');
      vr.hangup();
      client.calls(winner.callSid).update({ twiml: vr.toString() }).catch(() => endTechCall(t, winnerIndex, 'resident gone'));
    }
  }

  // ---------------------------------------------------------------- resident call

  async function connectToAgent(req, res, { direction, firstMessage }) {
    const { CallSid, From, To } = req.body;
    try {
      const xml = await registerCall({ fromNumber: From, toNumber: To, direction, callSid: CallSid, firstMessage });
      log(`REGISTER-CALL ok resident=${CallSid} direction=${direction}${firstMessage ? ' with first-message override' : ''}`);
      res.type('text/xml').send(xml);
    } catch (err) {
      log(`ERROR register-call failed resident=${CallSid}: ${err.message}`);
      sayAndHangup(res, 'Sorry, we are having trouble connecting you right now. Please try again later.');
    }
  }

  app.get('/health', (req, res) => res.json({ ok: true }));

  // Optional audio files, e.g. public/connecting.mp3 for the resident's announcement.
  app.use('/public', express.static(config.publicDir));

  // Outbound start (default way to test): rings the person playing the resident.
  app.post('/start-call', secretHook, wrap(async (req, res) => {
    const to = String((req.body && req.body.to) || '').trim();
    if (!E164_RE.test(to)) {
      return res.status(400).json({ status: 'error', message: 'Body must be {"to": "+15551234567"} (E.164)' });
    }
    const call = await client.calls.create({
      to,
      from: config.twilioPhoneNumber,
      url: `${base}/twilio/outbound-answer`,
      method: 'POST',
      statusCallback: `${base}/twilio/resident-status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });
    residentCalls.set(call.sid, { direction: 'outbound', number: to, ended: false });
    log(`START-CALL resident=${call.sid} to=${to}`);
    res.json({ status: 'calling', call_sid: call.sid });
  }));

  app.post('/twilio/outbound-answer', twilioHook, wrap(async (req, res) => {
    const { CallSid, To } = req.body;
    if (!residentCalls.has(CallSid)) residentCalls.set(CallSid, { direction: 'outbound', number: To, ended: false });
    await connectToAgent(req, res, { direction: 'outbound' });
  }));

  app.post('/twilio/inbound', twilioHook, wrap(async (req, res) => {
    const { CallSid, From } = req.body;
    residentCalls.set(CallSid, { direction: 'inbound', number: From, ended: false });
    await connectToAgent(req, res, { direction: 'inbound' });

    // Inbound calls only report hang-ups if the number has a "Call status changes" URL.
    // To avoid touching the shared number's config, attach the callback to this one call.
    const timer = setTimeout(() => {
      client.calls(CallSid)
        .update({ statusCallback: `${base}/twilio/resident-status`, statusCallbackMethod: 'POST' })
        .then(() => log(`STATUS-CALLBACK attached to inbound resident=${CallSid}`))
        .catch((err) => log(`WARN could not attach status callback to resident=${CallSid}: ${twilioError(err)}`));
    }, 1000);
    timer.unref();
  }));

  // Resident's call changed state. If it ended mid-search, stop everything.
  app.post('/twilio/resident-status', twilioHook, (req, res) => {
    const { CallSid, CallStatus } = req.body;
    res.sendStatus(204);
    if (!CALL_ENDED.has(CallStatus)) return;

    const resident = residentCalls.get(CallSid);
    if (resident) resident.ended = true;

    const t = transfers.get(CallSid);
    if (t && (t.status === 'searching' || t.status === 'bridging')) {
      t.status = 'cancelled';
      t.timings.resident_hung_up = timing(t, 'resident_hung_up', '-> cancelling all technician calls');
      cancelTechs(t, { why: 'resident hung up' });
      finish(t, 'resident hung up', t.timings.resident_hung_up);
    }
  });

  // All technicians failed: reconnect the resident to Ava with a different opening line.
  app.post('/twilio/fallback', twilioHook, wrap(async (req, res) => {
    const known = residentCalls.get(req.body.CallSid);
    const direction = known ? known.direction : String(req.body.Direction || '').startsWith('outbound') ? 'outbound' : 'inbound';
    await connectToAgent(req, res, { direction, firstMessage: FALLBACK_FIRST_MESSAGE });
  }));

  // ---------------------------------------------------------------- ElevenLabs tool

  app.post('/tool/request-transfer', secretHook, (req, res) => {
    const callSid = String((req.body && req.body.call_sid) || '').trim();
    const summary = String((req.body && req.body.summary) || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    log(`TOOL request-transfer call_sid=${callSid || '(missing)'} summary=${JSON.stringify(summary)}`);

    if (!CALL_SID_RE.test(callSid)) {
      return res.status(400).json({ status: 'error', message: 'call_sid is missing or not a Twilio call SID. Is the tool sending the {{call_sid}} dynamic variable?' });
    }
    const resident = residentCalls.get(callSid);
    if (!resident || resident.ended) {
      return res.status(404).json({ status: 'error', message: 'No live call with that call_sid on this server.' });
    }

    const existing = transfers.get(callSid);
    if (existing) {
      const message = existing.status === 'failed'
        ? 'No technician is available right now. Offer to take a message.'
        : 'A technician search is already running for this call. Ask the resident to keep holding.';
      return res.json({ status: existing.status === 'failed' ? 'unavailable' : 'searching', message });
    }

    const now = Date.now();
    const t = {
      residentCallSid: callSid,
      residentNumber: resident.number,
      direction: resident.direction,
      summary: summary || 'A resident needs help from a technician.',
      status: 'searching', // searching -> bridging -> connected -> ended | failed | cancelled
      result: null, //        connected | no technician | resident hung up
      winner: null,
      cursor: -1,
      startedAt: now,
      finishedAt: null,
      techs: config.techNumbers.map((number) => ({
        number,
        callSid: null,
        callStatus: null, // last status Twilio reported for the call
        callEnded: false,
        outcome: null,
        detail: null,
        answeredBy: null,
        dialledAt: null,
        ringingAt: null,
        answeredAt: null,
        pressedAt: null,
        outcomeAt: null,
      })),
      timings: {},
    };
    transfers.set(callSid, t);
    timing(t, 'tool_call');
    saveReport(t);

    // Answer the tool straight away; the search carries on after this response.
    res.json({
      status: 'searching',
      message: 'Searching for a technician now. Tell the resident you are finding someone and stay on the line with them. The call is handed over automatically when a technician accepts.',
    });
    setImmediate(() => startSearch(t));
  });

  // ---------------------------------------------------------------- technician legs

  function techContext(req) {
    const t = transfers.get(req.query.resident);
    const i = Number.parseInt(req.query.tech, 10);
    if (!t || !t.techs[i]) return null;
    const tech = t.techs[i];
    if (!tech.callSid && req.body.CallSid) tech.callSid = req.body.CallSid;
    return { t, i, tech };
  }

  function markAnswered(t, i) {
    const tech = t.techs[i];
    tech.callStatus = 'in-progress';
    if (tech.answeredAt) return;
    tech.answeredAt = timing(t, 'tech_answered', `tech#${i} ${tech.number}`);
    saveReport(t);
  }

  // Technician picked up (attempt 1), or the prompt is being repeated (attempt 2, 3).
  // With async AMD this runs immediately on pickup, before we know if it is a machine.
  app.post('/tech/answered', twilioHook, (req, res) => {
    const ctx = techContext(req);
    if (!ctx) return sayAndHangup(res, 'This request is no longer active. Goodbye.');
    const { t, i, tech } = ctx;
    const attempt = Number.parseInt(req.query.attempt, 10) || 1;

    if (attempt === 1) markAnswered(t, i);

    if (t.status !== 'searching' || tech.outcome) {
      setOutcome(t, i, 'canceled', 'search already over');
      return sayAndHangup(res, 'This request has already been handled. Goodbye.');
    }
    if (attempt > MAX_PROMPTS) {
      resolveTech(t, i, 'declined', `no key pressed after ${MAX_PROMPTS} prompts`);
      return sayAndHangup(res, 'No response received. Goodbye.');
    }

    const query = `resident=${t.residentCallSid}&tech=${i}`;
    const vr = new VoiceResponse();
    const gather = vr.gather({ numDigits: 1, timeout: 6, action: `${base}/tech/accept?${query}`, method: 'POST' });
    gather.say(`${t.summary} Press 1 to connect to the resident.`);
    // No key pressed: Twilio falls through to here and we ask again.
    vr.redirect({ method: 'POST' }, `${base}/tech/answered?${query}&attempt=${attempt + 1}`);
    sendTwiml(res, vr);
  });

  // Async answering-machine detection result. Only a machine changes anything.
  app.post('/tech/amd', twilioHook, (req, res) => {
    res.sendStatus(204);
    const ctx = techContext(req);
    if (!ctx) return;
    const { t, i, tech } = ctx;
    const answeredBy = req.body.AnsweredBy || 'unknown';
    tech.answeredBy = answeredBy;
    tech.callStatus = 'in-progress'; // detection only runs on a call that was picked up
    log(`AMD tech#${i} ${tech.number} call=${tech.callSid} answeredBy=${answeredBy} resident=${t.residentCallSid}`);

    if (!/^(machine|fax)/.test(answeredBy)) return saveReport(t);
    if (tech.outcome === 'accepted') {
      // They pressed 1, so a person is there whatever the detector thinks.
      log(`AMD tech#${i} reported ${answeredBy} after the technician accepted: ignored`);
      return saveReport(t);
    }
    // Voicemail counts as a decline for this technician only.
    resolveTech(t, i, 'voicemail', `answering machine (${answeredBy})`);
    endTechCall(t, i, 'answering machine detected');
  });

  // Technician pressed a key.
  app.post('/tech/accept', twilioHook, (req, res) => {
    const ctx = techContext(req);
    if (!ctx) return sayAndHangup(res, 'This request is no longer active. Goodbye.');
    const { t, i, tech } = ctx;
    const digits = req.body.Digits || '';

    if (digits !== '1') {
      resolveTech(t, i, 'declined', `pressed ${digits || 'nothing'}`);
      return sayAndHangup(res, 'Okay. Goodbye.');
    }

    // The lock. Node handles one request at a time and there is no await between
    // this check and the assignment below, so only one technician can get through.
    if (t.status !== 'searching' || tech.outcome) {
      const gone = t.status === 'cancelled';
      setOutcome(t, i, 'canceled', gone ? 'resident already hung up' : 'another technician accepted first');
      return sayAndHangup(res, gone ? 'Sorry, the resident has hung up. Goodbye.' : 'Another technician has already taken this call. Goodbye.');
    }
    t.status = 'bridging';
    t.winner = i;
    tech.pressedAt = timing(t, 'tech_pressed_1', `tech#${i} ${tech.number}`);
    setOutcome(t, i, 'accepted', 'pressed 1');
    log(`WINNER tech#${i} ${tech.number} call=${tech.callSid} resident=${t.residentCallSid}`);

    // Straight away: stop every other technician's phone.
    cancelTechs(t, { except: i, why: 'another technician accepted' });

    // Order matters: technician goes into the room first, then the resident is moved in.
    res.on('finish', () => bridgeResident(t, i));
    sendTwiml(res, conferenceTwiml(t.residentCallSid, { say: TECH_ANNOUNCEMENT }));
  });

  // Status callbacks for technician calls: ringing, answered, and how the call ended.
  app.post('/tech/status', twilioHook, (req, res) => {
    res.sendStatus(204);
    const ctx = techContext(req);
    if (!ctx) return;
    const { t, i, tech } = ctx;
    const status = req.body.CallStatus;
    tech.callStatus = status;

    if (status === 'ringing') {
      if (!tech.ringingAt) tech.ringingAt = Date.now();
      if (!t.timings.first_tech_ringing) {
        t.timings.first_tech_ringing = timing(t, 'first_tech_ringing', `tech#${i} ${tech.number}`);
      }
      saveReport(t);
    } else if (status === 'in-progress') {
      markAnswered(t, i);
      // Picked up at the same moment we cancelled: "canceled" no longer works, so hang up.
      if (tech.outcome === 'canceled') endTechCall(t, i, 'answered after being cancelled');
    } else if (CALL_ENDED.has(status)) {
      tech.callEnded = true;
      // "completed" means they picked up and the call ended without them accepting.
      if (status === 'completed') resolveTech(t, i, 'declined', 'call ended without pressing 1');
      else if (status === 'no-answer' || status === 'busy' || status === 'canceled') resolveTech(t, i, status, `Twilio reported ${status}`);
      else resolveTech(t, i, 'failed', `Twilio reported ${status}`);
    }
  });

  // ---------------------------------------------------------------- conference

  // Conference events (start / join / leave / end) and the recording callback.
  app.post('/conference/status', twilioHook, (req, res) => {
    res.sendStatus(204);
    const t = transfers.get(req.query.resident);
    const body = req.body;

    if (body.RecordingSid) {
      log(`RECORDING ${body.RecordingStatus} sid=${body.RecordingSid} conference=${body.ConferenceSid} duration=${body.RecordingDuration}s url=${body.RecordingUrl}`);
      return;
    }
    if (!t) return;

    if (body.StatusCallbackEvent === 'participant-join' && body.CallSid === t.residentCallSid && !t.timings.resident_joined) {
      t.status = 'connected';
      t.timings.resident_joined = timing(t, 'resident_joined', `conference=${body.ConferenceSid}`);
      logTimingSummary(t);
      finish(t, 'connected', t.timings.resident_joined);
    } else if (body.StatusCallbackEvent === 'conference-end') {
      if (t.status === 'connected') t.status = 'ended';
      log(`CONFERENCE ended ${body.FriendlyName} conference=${body.ConferenceSid}`);
    }
  });

  // ---------------------------------------------------------------- reports

  app.get('/reports', localOnly, (req, res) => {
    const all = reports.list();
    if (req.query.format === 'json') return res.json(all);
    res.type('html').send(renderList(all));
  });

  app.get('/reports/:sid', localOnly, (req, res) => {
    const report = reports.get(req.params.sid);
    if (!report) return res.status(404).send('No report for that call SID.');
    if (req.query.format === 'json') return res.json(report);
    res.type('html').send(renderDetail(report));
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log(`ERROR ${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: err.message });
  });

  return { app, state: { residentCalls, transfers } };
}

module.exports = { createApp, FALLBACK_FIRST_MESSAGE };
