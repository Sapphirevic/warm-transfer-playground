'use strict';

// Branch "agent-stays-on-call": the resident, Iris and the technician share one
// Twilio conference. The resident is in the room from the first second, Iris is
// added to it as her own call leg (a TwiML App that returns the ElevenLabs
// register-call TwiML), and a technician who presses 1 simply joins the same room.
// Nobody is moved, so Iris's conversation carries on while the technician is there.
// While the technician is in the room Iris is muted: she listens but is not heard.
//
// Branch "sequential-with-updates": technicians are called strictly one at a time, in
// TECH_NUMBERS order. When one does not take the call, the server plays a short cue to
// Iris's leg only ("Technician 1 did not pick up. Calling technician 2 now."), takes the
// resident off hold and unmutes Iris, so she can tell the resident in her own words.
// HOLD_MUSIC_RESUME_SEC later the music comes back while the next technician is called.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const twilio = require('twilio');
const { E164_RE } = require('./config');
const { createReportStore, buildReport, buildTranscript, renderList, renderDetail } = require('./reports');

const { VoiceResponse } = twilio.twiml;

const CALL_SID_RE = /^CA[0-9a-f]{32}$/i;
const CALL_ENDED = new Set(['completed', 'busy', 'no-answer', 'failed', 'canceled']);
const MAX_PROMPTS = 3;
const FALLBACK_FIRST_MESSAGE = 'Sorry, no technician is available right now. Can I take a message?';
const TECH_ANNOUNCEMENT = 'Connecting you to the resident.';
// Spoken into the room for everyone. Iris hears them like anything else said on the
// call, so her prompt can react to these exact phrases.
const ANNOUNCEMENTS = {
  joined: 'A technician has joined the call.',
  unavailable: 'No technician is available right now.',
  // Cue to Iris only (D29): after "A technician has joined the call" her prompt keeps her
  // silent (skip_turn), so without this she does not answer the resident once the technician
  // has gone. Worded as an instruction so it works without a prompt change.
  left: 'The technician has left the call. Please speak to the caller again.',
};
// Played to Iris's leg only (the resident does not hear it) when technician i (0-based)
// did not take the call and another one is about to be called. Iris's prompt reacts to it.
// Numbers, not phone numbers, so Iris has nothing private to read out.
const techUpdateLine = (i) => `Technician ${i + 1} did not pick up. Calling technician ${i + 2} now.`;
const LOGGED_FIELDS = [
  'CallSid', 'ParentCallSid', 'CallStatus', 'Direction', 'From', 'To', 'AnsweredBy', 'MachineDetectionDuration',
  'Digits', 'StatusCallbackEvent', 'ConferenceSid', 'FriendlyName', 'ParticipantLabel', 'RecordingSid',
  'RecordingStatus', 'RecordingDuration', 'RecordingChannels', 'CallDuration', 'SipResponseCode',
  'TranscriptionEvent', 'Track',
];
const RECORDING_SID_RE = /^RE[0-9a-f]{32}$/i;

const secs = (from, to) => `${((to - from) / 1000).toFixed(1)}s`;
const roomName = (residentCallSid) => `room-${residentCallSid}`;
// Twilio sends recording start times as e.g. "Thu, 26 Nov 2026 11:54:30 +0000".
const isoFromTwilio = (value) => {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/**
 * Live call state is in memory (it's a playground): restart the server and running
 * calls are forgotten. Finished transfer reports are kept as JSON files in reports/.
 *
 * @param {object} deps
 * @param {object} deps.config        from loadConfig()
 * @param {object} deps.client        Twilio REST client (or a fake in tests)
 * @param {Function} deps.registerCall  from createRegisterCall()
 * @param {object} [deps.conversations] from createConversationApi(); without it reports have no transcript
 * @param {Function} [deps.logger]
 * @param {Function} [deps.fetchImpl] used to download recordings for the report page
 */
function createApp({ config, client, registerCall, conversations = null, logger = console.log, fetchImpl = globalThis.fetch }) {
  const app = express();
  app.disable('x-powered-by');

  const base = config.publicBaseUrl;
  // Twilio recordings of each person's own line and live transcripts (see "Twilio media").
  const recordLegs = config.recordLegs === true;
  const liveTranscription = config.liveTranscription === true;
  const liveTranscriptionIrisLeg = liveTranscription && config.liveTranscriptionIrisLeg === true;
  const reports = createReportStore(config.reportsDir);
  const connectingFile = path.join(config.publicDir, 'connecting.mp3');
  const residentCalls = new Map(); // resident CallSid -> call record (see newResidentCall)
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
    // Who-is-talking events arrive several times a second; logging each would drown the log.
    const speechEvent = /^participant-speech-/.test(String((req.body && req.body.StatusCallbackEvent) || ''));
    if (!speechEvent || !valid) {
      log(`WEBHOOK ${req.method} ${req.originalUrl} ${fields}${valid ? '' : ' [INVALID SIGNATURE - rejected]'}`);
    }

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

  const twilioError = (err) => `${err.code ? `Twilio error ${err.code}: ` : ''}${err.message}`;

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
      ['technician_joined', t.timings.technician_joined],
    ].map(([name, at]) => `  ${name.padEnd(19)} ${at ? `${new Date(at).toISOString()}  +${secs(start, at)}` : '(not seen)'}`);
    log(
      `TIMING SUMMARY resident=${t.residentCallSid} winner=tech#${t.winner} ${winner.number}\n${rows.join('\n')}\n` +
        `  => resident waited ${secs(start, t.timings.technician_joined)} from tool call to the technician joining`
    );
  }

  function saveReport(t) {
    try {
      reports.save(buildReport(t));
    } catch (err) {
      log(`ERROR could not save report for resident=${t.residentCallSid}: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------- transcripts

  const transcriptFetches = new Map(); // resident CallSid -> fetch in progress

  function storeTranscript(residentCallSid, transcript) {
    const t = transfers.get(residentCallSid);
    if (t) {
      t.transcript = transcript;
      return saveReport(t);
    }
    // After a restart the call is no longer in memory: update the saved file directly.
    const stored = reports.get(residentCallSid);
    if (stored) reports.save({ ...stored, transcript });
  }

  // Fetches the conversation(s) for one resident call from ElevenLabs and stores the
  // transcript with the report. Does nothing once the transcript is final.
  function refreshTranscript(residentCallSid) {
    if (!conversations) return Promise.resolve();
    const stored = reports.get(residentCallSid);
    if (!stored || (stored.transcript && stored.transcript.status === 'final')) return Promise.resolve();
    if (transcriptFetches.has(residentCallSid)) return transcriptFetches.get(residentCallSid);

    const fetching = (async () => {
      let transcript;
      try {
        // Iris's conversation starts before the tool call, so look back generously.
        const startedAfter = Math.floor(Date.parse(stored.started_at) / 1000) - 6 * 3600;
        transcript = buildTranscript(await conversations.forCall(residentCallSid, startedAfter));
        const lines = transcript.conversations.reduce((n, c) => n + c.entries.length, 0);
        log(`TRANSCRIPT resident=${residentCallSid} ${transcript.status}: ${transcript.conversations.length} conversation(s), ${lines} line(s)`);
      } catch (err) {
        log(`ERROR could not fetch transcript for resident=${residentCallSid}: ${err.message}`);
        // Keep whatever we already had and say why it could not be refreshed.
        transcript = {
          status: 'unavailable',
          fetched_at: new Date().toISOString(),
          error: err.message,
          conversations: (stored.transcript && stored.transcript.conversations) || [],
        };
      }
      storeTranscript(residentCallSid, transcript);
    })().finally(() => transcriptFetches.delete(residentCallSid));

    transcriptFetches.set(residentCallSid, fetching);
    return fetching;
  }

  // ElevenLabs needs a little while after the call to finish the transcript, so try a few times.
  function scheduleTranscript(residentCallSid) {
    if (!conversations || !transfers.has(residentCallSid)) return;
    for (const delay of config.transcriptRetryMs || []) {
      setTimeout(() => refreshTranscript(residentCallSid), delay).unref();
    }
  }

  // ---------------------------------------------------------------- Twilio media
  //
  // Next to the room recording, Twilio records each person's own line (dual-channel: their
  // voice on one channel, everything they hear on the other) and transcribes each line live:
  //   resident leg   : the resident + everything they hear (Iris, hold music, technician)
  //   technician leg : the brief and "Press 1", then the technician + everything they hear
  //   Iris's leg     : live transcript only; she hears the whole room (her own leg is not recorded)
  // Twilio also transcribes every recording after the call (Conversational Intelligence,
  // set up on the account); the report page fetches those transcripts by recording SID.

  const mediaFor = (residentCallSid) => {
    const resident = residentCalls.get(residentCallSid);
    return resident ? resident.media : null;
  };

  // Saves the report if this call has one (only calls where Iris asked for a technician do).
  function persistMedia(residentCallSid) {
    const t = transfers.get(residentCallSid);
    if (t) saveReport(t);
  }

  const legName = (leg, technician) => (leg === 'technician' ? `technician ${technician}` : leg);

  function upsertRecording(residentCallSid, entry) {
    const media = mediaFor(residentCallSid);
    if (!media || !entry.recording_sid) return;
    const known = media.recordings.find((r) => r.recording_sid === entry.recording_sid);
    const fresh = Object.fromEntries(Object.entries(entry).filter(([, v]) => v !== null && v !== undefined));
    if (known) Object.assign(known, fresh);
    else media.recordings.push({ kind: null, technician: null, call_sid: null, conference_sid: null, channels: null, status: null, duration_seconds: null, started_at: null, error: null, ...fresh });
    persistMedia(residentCallSid);
  }

  // <Start><Transcription> for one call leg: both directions, each line sent to
  // /twilio/live-transcription tagged with its track (inbound = the person on this line,
  // outbound = what they hear).
  function addLiveTranscription(vr, residentCallSid, leg, { tech = null, name = leg } = {}) {
    const query = `resident=${residentCallSid}&leg=${leg}${tech === null ? '' : `&tech=${tech}`}`;
    vr.start().transcription({
      name,
      track: 'both_tracks',
      partialResults: false,
      statusCallbackUrl: `${base}/twilio/live-transcription?${query}`,
      statusCallbackMethod: 'POST',
    });
  }

  // Iris's TwiML comes from ElevenLabs. The live transcription is put in front of its
  // <Connect><Stream>, so it runs for as long as her leg does.
  function withIrisLiveTranscription(xml, residentCallSid, joins) {
    const vr = new VoiceResponse();
    addLiveTranscription(vr, residentCallSid, 'iris', { name: `iris-${joins}` });
    const start = vr.toString().replace(/^[\s\S]*?<Response>/, '').replace(/<\/Response>\s*$/, '');
    if (!/<Response[^>]*>/.test(xml)) {
      log(`ERROR live transcription not added to Iris's leg: the register-call TwiML has no <Response> (resident=${residentCallSid})`);
      return xml;
    }
    return xml.replace(/<Response[^>]*>/, (open) => open + start);
  }

  // Starts the dual-channel recording of the resident's own line once they are in the room.
  async function startResidentRecording(residentCallSid) {
    const resident = residentCalls.get(residentCallSid);
    if (!recordLegs || !resident || resident.ended || resident.legRecordingRequested) return;
    resident.legRecordingRequested = true;
    try {
      const recording = await client.calls(residentCallSid).recordings.create({
        recordingChannels: 'dual',
        trim: 'do-not-trim',
        recordingStatusCallback: `${base}/twilio/recording-status?resident=${residentCallSid}&leg=resident`,
        recordingStatusCallbackMethod: 'POST',
        recordingStatusCallbackEvent: ['in-progress', 'completed', 'absent'],
      });
      log(`RECORDING resident line started sid=${recording.sid} resident=${residentCallSid}`);
      upsertRecording(residentCallSid, {
        kind: 'resident', recording_sid: recording.sid, call_sid: residentCallSid, channels: 2,
        status: recording.status || 'in-progress', started_at: new Date().toISOString(),
      });
    } catch (err) {
      log(`ERROR could not start recording the resident's line resident=${residentCallSid}: ${twilioError(err)}`);
      const media = mediaFor(residentCallSid);
      if (media) {
        media.live_events.push({ leg: 'resident', technician: null, event: 'recording-error', at: new Date().toISOString(), detail: twilioError(err) });
        persistMedia(residentCallSid);
      }
    }
  }

  // Twilio's post-call transcript (Conversational Intelligence) of one recording, if the
  // account made one. Read only: the Intelligence service and its settings are not touched.
  async function fetchIntelligence(recordingSid) {
    const fetchedAt = new Date().toISOString();
    const found = await client.intelligence.v2.transcripts.list({ sourceSid: recordingSid, limit: 20 });
    if (!found.length) {
      return { status: 'none', transcript_sid: null, service_sid: null, transcripts_found: 0, fetched_at: fetchedAt, error: null, sentences: [], operator_results: [] };
    }
    const pick = found.find((x) => x.status === 'completed') || found[0];
    const result = {
      status: pick.status, transcript_sid: pick.sid, service_sid: pick.serviceSid, transcripts_found: found.length,
      fetched_at: fetchedAt, error: null, sentences: [], operator_results: [],
    };
    if (pick.status !== 'completed') return result;

    const sentences = await client.intelligence.v2.transcripts(pick.sid).sentences.list({ redacted: false, limit: 1000 });
    result.sentences = sentences.map((s) => ({
      channel: s.mediaChannel,
      text: s.transcript,
      start: Number(s.startTime),
      end: Number(s.endTime),
      confidence: s.confidence === null || s.confidence === undefined ? null : Number(s.confidence),
    }));
    const operators = await client.intelligence.v2.transcripts(pick.sid).operatorResults.list({ redacted: false }).catch(() => []);
    result.operator_results = operators.map((o) => ({
      name: o.name,
      type: o.operatorType,
      result: o.jsonResults ?? o.textGenerationResults ?? o.predictedLabel ?? o.extractResults ?? null,
    }));
    return result;
  }

  function storeIntelligence(residentCallSid, recordingSid, result) {
    const t = transfers.get(residentCallSid);
    if (t && t.media) {
      t.media.intelligence[recordingSid] = result;
      return saveReport(t);
    }
    // After a restart the call is no longer in memory: update the saved file directly.
    const stored = reports.get(residentCallSid);
    if (!stored || !stored.twilio) return;
    stored.twilio.intelligence = { ...(stored.twilio.intelligence || {}), [recordingSid]: result };
    reports.save(stored);
  }

  const intelligenceFetches = new Map(); // resident CallSid -> fetch in progress

  // Fetches Twilio's post-call transcript for every finished recording that does not
  // have a completed one yet. Called when a report page is opened.
  function refreshTwilioTranscripts(residentCallSid) {
    if (!client.intelligence) return Promise.resolve();
    const stored = reports.get(residentCallSid);
    if (!stored || !stored.twilio) return Promise.resolve();
    const done = stored.twilio.intelligence || {};
    const todo = (stored.twilio.recordings || [])
      .filter((r) => r.status === 'completed' && RECORDING_SID_RE.test(r.recording_sid || ''))
      .filter((r) => !done[r.recording_sid] || done[r.recording_sid].status !== 'completed');
    if (!todo.length) return Promise.resolve();
    if (intelligenceFetches.has(residentCallSid)) return intelligenceFetches.get(residentCallSid);

    const fetching = (async () => {
      for (const recording of todo) {
        let result;
        try {
          result = await fetchIntelligence(recording.recording_sid);
          log(`TWILIO-TRANSCRIPT ${recording.kind}${recording.technician ? ` ${recording.technician}` : ''} recording=${recording.recording_sid} ${result.status}: ${result.sentences.length} sentence(s)`);
        } catch (err) {
          log(`ERROR could not fetch Twilio's transcript of recording=${recording.recording_sid}: ${twilioError(err)}`);
          result = { ...(done[recording.recording_sid] || { sentences: [], operator_results: [] }), status: 'unavailable', error: twilioError(err), fetched_at: new Date().toISOString() };
        }
        storeIntelligence(residentCallSid, recording.recording_sid, result);
      }
    })().finally(() => intelligenceFetches.delete(residentCallSid));
    intelligenceFetches.set(residentCallSid, fetching);
    return fetching;
  }

  // The transfer is over, one way or another: store the result and print the one-line summary.
  function finish(t, result, at = Date.now()) {
    if (t.result) return;
    t.result = result;
    t.finishedAt = at;
    clearTimeout(t.holdTimer); // no more hold music once the search is over
    saveReport(t);

    const outcomes = t.techs
      .filter((tech) => tech.dialledAt)
      .map((tech) => `${tech.number}=${tech.outcome || 'calling'}`)
      .join(', ');
    const who = result === 'connected' ? ` technician=${t.techs[t.winner].number}` : '';
    log(
      `TRANSFER ${result.toUpperCase()} resident=${t.residentNumber} call=${t.residentCallSid}${who} ` +
        `waited=${secs(t.startedAt, at)} tried=[${outcomes || 'nobody'}] report=/reports/${t.residentCallSid}`
    );
  }

  function newResidentCall({ direction, number, twilioNumber }) {
    return {
      direction,
      number,
      twilioNumber,
      ended: false,
      conferenceSid: null,
      present: new Set(), // call SIDs in the room right now
      // state: none -> joining -> in -> left
      agent: { state: 'none', callSid: null, joins: 0, firstMessage: null, muted: false, pendingCue: null },
      onHold: false, //                    resident is hearing hold music
      roomQueue: Promise.resolve(), //     see inOrder()
      speaking: new Set(), //              call SIDs talking right now (Twilio speaker events)
      cueQueue: [], //                     cues to Iris waiting for a pause (see queueCue)
      cueGapTimer: null,
      cueMaxTimer: null,
      pendingHandover: null, //            set while waiting for Iris to finish a sentence (handOver)
      handoverIntroTimer: null, //         waiting for Iris to start introducing the technician (D32)
      handoverTimer: null,
      handoverGraceTimer: null,
      legRecordingRequested: false, //     the resident's own line is being recorded
      // Twilio recordings and transcripts for this call. Collected from the first second,
      // before any report exists; the transfer report shares this object (t.media).
      media: newMedia(),
    };
  }

  function newMedia() {
    return {
      settings: {
        record_legs: recordLegs,
        live_transcription: liveTranscription,
        live_transcription_iris_leg: liveTranscriptionIrisLeg,
      },
      recordings: [], //      [{ kind, technician, recording_sid, call_sid, channels, status, ... }]
      live_transcript: [], // [{ leg, technician, track, text, confidence, at }]
      live_events: [], //     [{ leg, technician, event, at, detail }] started / stopped / error
      intelligence: {}, //    recording SID -> Twilio's post-call transcript of that recording
    };
  }

  // The shared room. Only the resident ends it by leaving: if the technician hangs up
  // the resident is still with Iris, and if Iris drops the resident and technician carry on.
  // liveResident: also start the live transcription of the resident's line (the
  // technician's is started earlier, before their brief, see /tech/answered).
  function conferenceTwiml(residentCallSid, { say, endConferenceOnExit, liveResident = false, muted = false }) {
    const callback = `${base}/conference/status?resident=${residentCallSid}`;
    const vr = new VoiceResponse();
    if (liveResident && liveTranscription) addLiveTranscription(vr, residentCallSid, 'resident');
    if (say) vr.say(say);
    vr.dial().conference(
      {
        startConferenceOnEnter: true,
        endConferenceOnExit,
        ...(muted ? { muted: true } : {}),
        beep: false,
        // Silence instead of hold music for the second or two before Iris joins.
        waitUrl: '',
        // Iris's replies now pass through the conference mixer, so keep its buffering low.
        jitterBufferSize: 'small',
        record: 'record-from-start',
        recordingStatusCallback: callback,
        recordingStatusCallbackMethod: 'POST',
        recordingStatusCallbackEvent: 'completed',
        statusCallback: callback,
        statusCallbackMethod: 'POST',
        // "speaker": Twilio reports when each participant starts and stops talking, so cues
        // to Iris can wait for a pause (only the first participant's setting counts).
        statusCallbackEvent: ['start', 'end', 'join', 'leave', 'speaker'],
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

  // ---------------------------------------------------------------- Iris's leg

  // Adds Iris to the resident's room as a separate call leg. Twilio "calls" our TwiML
  // App, which asks /twilio/agent-leg for TwiML, and that returns the ElevenLabs stream.
  async function addAgent(residentCallSid, { firstMessage = null } = {}) {
    const resident = residentCalls.get(residentCallSid);
    if (!resident || resident.ended || !resident.conferenceSid) return;
    const { agent } = resident;
    if (agent.state === 'joining' || agent.state === 'in') return;

    agent.state = 'joining';
    agent.firstMessage = firstMessage;
    agent.joins += 1;
    try {
      const participant = await client.conferences(resident.conferenceSid).participants.create({
        from: config.twilioPhoneNumber,
        to: `app:${config.agentAppSid}?resident=${residentCallSid}`,
        label: `iris-${agent.joins}`,
        beep: 'false',
        startConferenceOnEnter: true,
        endConferenceOnExit: false,
        jitterBufferSize: 'off',
      });
      if (!agent.callSid) agent.callSid = participant.callSid;
      log(`AGENT adding Iris to ${roomName(residentCallSid)} leg=${participant.callSid}${firstMessage ? ' with first-message override' : ''}`);
    } catch (err) {
      agent.state = 'none';
      log(`ERROR could not add Iris to the call resident=${residentCallSid}: ${twilioError(err)}`);
      const vr = new VoiceResponse();
      vr.say('Sorry, we are having trouble connecting you right now. Please try again later.');
      vr.hangup();
      client.calls(residentCallSid).update({ twiml: vr.toString() }).catch(() => {});
    }
  }

  // Which resident call is this Iris leg for? Normally the custom parameter says so.
  function residentForAgentLeg(body) {
    const named = body.resident || body.Param_resident;
    if (named && residentCalls.has(named)) return named;
    // Fallback if Twilio did not pass the parameter through: the one call waiting for Iris.
    const waiting = [...residentCalls].filter(([, call]) => !call.ended && call.agent.state === 'joining');
    return waiting.length === 1 ? waiting[0][0] : null;
  }

  // Voice URL of the TwiML App. Returns the ElevenLabs <Connect><Stream> for Iris's leg.
  app.post('/twilio/agent-leg', twilioHook, wrap(async (req, res) => {
    const residentCallSid = residentForAgentLeg(req.body);
    const resident = residentCallSid && residentCalls.get(residentCallSid);
    if (!resident) {
      log('ERROR /twilio/agent-leg could not tell which resident call this is for');
      return sayAndHangup(res);
    }
    const outbound = resident.direction === 'outbound';
    const { firstMessage } = resident.agent;
    try {
      let xml = await registerCall({
        fromNumber: outbound ? resident.twilioNumber : resident.number,
        toNumber: outbound ? resident.number : resident.twilioNumber,
        direction: resident.direction,
        // Iris's {{call_sid}} is the resident's call, which is what request_transfer needs.
        callSid: residentCallSid,
        firstMessage,
      });
      log(`REGISTER-CALL ok resident=${residentCallSid} direction=${resident.direction}${firstMessage ? ' with first-message override' : ''}`);
      if (liveTranscriptionIrisLeg) xml = withIrisLiveTranscription(xml, residentCallSid, resident.agent.joins);
      res.type('text/xml').send(xml);
    } catch (err) {
      log(`ERROR register-call failed resident=${residentCallSid}: ${err.message}`);
      // Spoken on Iris's leg, so the resident hears it in the room.
      sayAndHangup(res, 'Sorry, we are having trouble connecting you right now. Please try again later.');
    }
  }));

  // While a technician is in the room Iris must not be heard. Muting her leg guarantees
  // that whatever the model decides to say. She still hears everything, so her
  // transcript keeps covering the conversation. Resolves to true if the change was made.
  function setAgentMuted(residentCallSid, muted, why) {
    const resident = residentCalls.get(residentCallSid);
    if (!resident || resident.ended || !resident.conferenceSid) return Promise.resolve(false);
    const { agent } = resident;
    if (agent.state !== 'in' || !agent.callSid || agent.muted === muted) return Promise.resolve(false);
    agent.muted = muted;
    return inOrder(resident, async () => {
      if (resident.ended || agent.state !== 'in') { agent.muted = !muted; return false; } // call over meanwhile
      try {
        await client.conferences(resident.conferenceSid).participants(agent.callSid).update({ muted });
        log(`AGENT Iris ${muted ? 'muted' : 'unmuted'} in ${roomName(residentCallSid)} (${why})`);
        recordPeriod(residentCallSid, 'mutePeriods', muted);
        return true;
      } catch (err) {
        agent.muted = !muted;
        log(`ERROR could not ${muted ? 'mute' : 'unmute'} Iris in ${roomName(residentCallSid)}: ${twilioError(err)}`);
        return false;
      }
    });
  }

  // Iris can be muted and unmuted, and the resident put on hold and taken off it, several
  // times in one search (once per technician update). Each change that Twilio accepted
  // opens or closes a period on the transfer, so the report knows exactly when.
  function recordPeriod(residentCallSid, field, on) {
    const t = transfers.get(residentCallSid);
    if (!t) return;
    const periods = t[field];
    const open = periods.at(-1);
    if (on && !(open && open.to === null)) periods.push({ from: Date.now(), to: null });
    else if (!on && open && open.to === null) open.to = Date.now();
    saveReport(t);
  }

  // Changes to one room (hold, mute, announcements) are sent to Twilio one after
  // another, so that for example "take off hold" can never overtake "put on hold".
  function inOrder(resident, task) {
    const run = resident.roomQueue.then(task);
    resident.roomQueue = run.catch(() => {});
    return run;
  }

  // Hold music for the resident while technicians are being called. A participant on
  // hold hears the music instead of the room, and the room does not hear them.
  // Resolves to true if the change was made.
  function setResidentHold(residentCallSid, hold, why) {
    const resident = residentCalls.get(residentCallSid);
    if (!resident || resident.ended || !resident.conferenceSid || resident.onHold === hold) return Promise.resolve(false);
    resident.onHold = hold;
    const options = hold ? { hold: true, holdUrl: config.holdMusicUrl, holdMethod: 'GET' } : { hold: false };
    return inOrder(resident, async () => {
      try {
        await client.conferences(resident.conferenceSid).participants(residentCallSid).update(options);
        log(`HOLD resident=${residentCallSid} ${hold ? 'on hold with music' : 'off hold'} (${why})`);
        recordPeriod(residentCallSid, 'holdPeriods', hold);
        return true;
      } catch (err) {
        resident.onHold = !hold;
        log(`ERROR could not ${hold ? 'put resident on hold' : 'take resident off hold'} resident=${residentCallSid}: ${twilioError(err)}`);
        return false;
      }
    });
  }

  // A few seconds after Iris asks for a technician (long enough for her to say
  // "please hold"), and again a few seconds after each technician update, the resident
  // gets music and Iris is muted. Only while the search is still running.
  function startHold(t) {
    t.holdTimer = null;
    if (t.status !== 'searching') return;
    setResidentHold(t.residentCallSid, true, 'searching for a technician');
    setAgentMuted(t.residentCallSid, true, 'resident is on hold');
  }

  // There is at most one pending "music on" per transfer: a new one replaces the old.
  function scheduleHold(t, delayMs) {
    clearTimeout(t.holdTimer);
    t.holdTimer = setTimeout(() => startHold(t), delayMs);
    t.holdTimer.unref();
  }

  function endHold(t, why) {
    return setResidentHold(t.residentCallSid, false, why);
  }

  // Plays a short line (or public/connecting.mp3) to everyone in the room.
  // Queued behind any pending hold or mute change, so the resident is off hold (and
  // Iris silenced or given her voice back) before the line is spoken.
  function announce(residentCallSid, kind) {
    const resident = residentCalls.get(residentCallSid);
    if (!resident || !resident.conferenceSid) return;
    inOrder(resident, () => client.conferences(resident.conferenceSid)
      .update({ announceUrl: `${base}/conference/announce?kind=${kind}`, announceMethod: 'POST' })
      .then(() => log(`ANNOUNCE "${ANNOUNCEMENTS[kind]}" in ${roomName(residentCallSid)}`))
      .catch((err) => log(`ERROR could not announce "${kind}" in ${roomName(residentCallSid)}: ${twilioError(err)}`)));
  }

  app.post('/conference/announce', twilioHook, (req, res) => {
    const kind = req.query.kind;
    const vr = new VoiceResponse();
    const tech = Number.parseInt(req.query.tech, 10);
    if (kind === 'tech-update' && tech >= 0) vr.say(techUpdateLine(tech));
    else if (kind === 'joined' && fs.existsSync(connectingFile)) vr.play(`${base}/public/connecting.mp3`);
    else vr.say(ANNOUNCEMENTS[kind] || ANNOUNCEMENTS.joined);
    sendTwiml(res, vr);
  });

  // Plays a cue to Iris's leg only. The resident and the technician do not hear it;
  // Iris hears it and her prompt tells her what to say. Resolves to true if Twilio took it.
  function cueAgent(residentCallSid, query, text) {
    const resident = residentCalls.get(residentCallSid);
    const { agent } = resident;
    return inOrder(resident, () => client.conferences(resident.conferenceSid).participants(agent.callSid)
      .update({ announceUrl: `${base}/conference/announce?${query}`, announceMethod: 'POST' })
      .then(() => {
        log(`CUE to Iris only "${text}" in ${roomName(residentCallSid)}`);
        return true;
      })
      .catch((err) => {
        log(`ERROR could not send the cue "${text}" to Iris in ${roomName(residentCallSid)}: ${twilioError(err)}`);
        return false;
      }));
  }

  // Cues to Iris wait for a pause (decision.md D23). Played while someone is talking, a cue
  // is lost in the caller's speech (and delays Iris's reply) or cuts Iris off mid-sentence.
  // A cue is sent once nobody has been talking for CUE_QUIET_GAP_MS, or after CUE_MAX_WAIT_MS
  // at the latest. onDone(sent) runs when it has been sent, or skipped because Iris is not in
  // the room; it is not called for a cue dropped because the call moved on.
  function queueCue(residentCallSid, query, text, onDone) {
    const resident = residentCalls.get(residentCallSid);
    if (!resident || resident.ended) return;
    resident.cueQueue.push({ query, text, queuedAt: Date.now(), onDone });
    if (resident.speaking.size) log(`CUE waiting for a pause before "${text}" (someone is talking)`);
    pumpCues(residentCallSid);
  }

  function pumpCues(residentCallSid) {
    const resident = residentCalls.get(residentCallSid);
    if (!resident || resident.ended || !resident.cueQueue.length) return;
    if (!resident.cueMaxTimer) {
      resident.cueMaxTimer = setTimeout(() => sendNextCue(residentCallSid, 'waited the maximum time'), config.cueMaxWaitMs);
    }
    clearTimeout(resident.cueGapTimer);
    resident.cueGapTimer = null;
    if (resident.speaking.size) return; // a speech-stop event calls this again
    resident.cueGapTimer = setTimeout(() => {
      resident.cueGapTimer = null;
      if (!resident.speaking.size) sendNextCue(residentCallSid, 'pause');
    }, config.cueQuietGapMs);
  }

  function sendNextCue(residentCallSid, why) {
    const resident = residentCalls.get(residentCallSid);
    if (!resident) return;
    clearTimeout(resident.cueGapTimer);
    clearTimeout(resident.cueMaxTimer);
    resident.cueGapTimer = null;
    resident.cueMaxTimer = null;
    const cue = resident.cueQueue.shift();
    if (!cue || resident.ended) return;
    const waited = ((Date.now() - cue.queuedAt) / 1000).toFixed(1);
    const { agent } = resident;
    if (agent.state !== 'in' || !agent.callSid) {
      log(`CUE skipped "${cue.text}": Iris is not in ${roomName(residentCallSid)}`);
      if (cue.onDone) cue.onDone(false);
    } else {
      log(`CUE ready after ${waited}s (${why}): "${cue.text}"`);
      cueAgent(residentCallSid, cue.query, cue.text).then((sent) => { if (cue.onDone) cue.onDone(sent); });
    }
    if (resident.cueQueue.length) pumpCues(residentCallSid);
  }

  // Throws away queued cues that are no longer true (e.g. a technician joined meanwhile).
  // keep(cue): cues still true are kept and stay queued (the wrap-up cue, D31).
  function dropCues(residentCallSid, why, keep = () => false) {
    const resident = residentCalls.get(residentCallSid);
    if (!resident) return;
    clearTimeout(resident.cueGapTimer);
    clearTimeout(resident.cueMaxTimer);
    resident.cueGapTimer = null;
    resident.cueMaxTimer = null;
    const kept = resident.cueQueue.filter(keep);
    const dropped = resident.cueQueue.length - kept.length;
    if (dropped) log(`CUE dropped ${dropped} waiting cue(s) (${why})`);
    resident.cueQueue = kept;
    if (kept.length) pumpCues(residentCallSid);
  }

  // ---------------------------------------------------------------- handoff (D30, D33)
  //
  // A technician has pressed 1 and is in the room. No spoken cue to Iris here: on real calls
  // they cut her off and her prompt answered "Technician here..." with skip_turn (D33).
  // What does work on real calls is the update_transfer reply: she calls it after each
  // answer from the caller and speaks right after it. So:
  //
  //  1. The technician joins muted and is put on hold ("One moment please", then silence).
  //  2. Iris's next update_transfer reply tells her to hand over in one sentence. At that
  //     moment the technician comes off hold, still muted, so they hear just that sentence.
  //  3. When she has said it and been quiet for HANDOVER_GRACE_MS: Iris muted, technician
  //     unmuted, and Iris alone hears "A technician has joined the call" (her cue to stay
  //     silent).
  //  Fallback: no update_transfer call within HANDOVER_REPLY_WAIT_MS (8 s), or she does not
  //  start talking within HANDOVER_WRAPUP_WAIT_MS of the reply: once she is quiet, Iris is
  //  muted, the technician brought in and the whole room hears "A technician has joined the
  //  call". HANDOVER_MAX_WAIT_MS (30 s) is the overall safety net.

  // Reply to the first update_transfer after the technician pressed 1 (D34).
  const JOINING_REPLY = 'A technician has accepted and is joining the call in a few seconds, already briefed. Finish your point in a few words, then tell the caller in one short sentence that the technician is joining now, for example: "Good news, a technician is joining us now." Do not ask a new question.';

  const HANDOVER_REPLY = 'The technician has joined, is listening, and already has the brief. Say one short sentence handing the caller over to the technician, for example: "The technician is with us now, I\'ll hand you over." Do not repeat the details and do not ask anything else.';

  function handOver(residentCallSid, t) {
    const resident = residentCalls.get(residentCallSid);
    if (!resident) return;
    const techSid = t.winner !== null ? t.techs[t.winner].callSid : null;
    const irisSid = resident.agent.callSid;
    const irisTalking = () => Boolean(irisSid && resident.speaking.has(irisSid));
    let phase = 'awaiting-reply'; // -> handing-over -> done (or fallback -> done)
    let spoke = false; //          Iris started a sentence after the handover reply
    let techOffHold = false;

    if (!irisSid || resident.agent.state !== 'in') {
      // No Iris to hand over: straight in, and the whole room is told.
      log('HANDOVER Iris is not in the room: technician unmuted, room told');
      t.handoffBy = 'room announcement';
      bringInTechnician(residentCallSid, techSid, { unhold: false });
      endHold(t, 'technician joined');
      announce(residentCallSid, 'joined');
      return;
    }

    const clearTimers = () => {
      clearTimeout(resident.handoverTimer);
      clearTimeout(resident.handoverGraceTimer);
      clearTimeout(resident.handoverIntroTimer);
      resident.handoverTimer = null;
      resident.handoverGraceTimer = null;
      resident.handoverIntroTimer = null;
    };
    const complete = (why, { roomAnnouncement }) => {
      if (phase === 'done') return;
      phase = 'done';
      clearTimers();
      resident.pendingHandover = null;
      if (resident.ended) return;
      log(`HANDOVER ${why}: muting Iris, the technician can talk now`);
      timing(t, 'handoff_done');
      t.handoffBy = roomAnnouncement ? 'room announcement' : 'iris';
      saveReport(t);
      setAgentMuted(residentCallSid, true, 'technician joined');
      bringInTechnician(residentCallSid, techSid, { unhold: !techOffHold });
      endHold(t, 'technician joined');
      if (roomAnnouncement) announce(residentCallSid, 'joined');
      else queueCueNow(residentCallSid, 'kind=joined', ANNOUNCEMENTS.joined); // Iris only
    };
    // Runs fn once Iris has been quiet for the grace period (never mid-sentence).
    const whenQuiet = (fn) => {
      clearTimeout(resident.handoverGraceTimer);
      resident.handoverGraceTimer = setTimeout(() => {
        resident.handoverGraceTimer = null;
        if (!irisTalking()) fn();
      }, config.handoverGraceMs);
    };
    const fallback = (why) => {
      if (phase === 'done' || phase === 'fallback') return;
      phase = 'fallback';
      log(`HANDOVER ${why}: bringing the technician in once Iris is quiet, with the room announcement`);
      const go = () => complete('fallback', { roomAnnouncement: true });
      if (irisTalking()) return; // her speech-stop moves it on
      whenQuiet(go);
    };

    if (techSid) holdTechnician(residentCallSid, techSid);
    // Already told (reply right after the technician pressed 1, D34): she is saying it or
    // has said it. Bring the technician in once she has, and is quiet.
    if (t.joinReplyAt) {
      phase = 'handing-over';
      spoke = Boolean(t.irisSpokeAfterJoinReply);
      log(`HANDOVER technician on hold; Iris ${spoke ? 'has told' : 'is about to tell'} the caller the technician is joining`);
    } else {
      log('HANDOVER technician on hold; Iris hands over in her next update_transfer reply');
    }

    resident.pendingHandover = {
      // From /tool/update-transfer: the reply that asks Iris to hand over (once).
      takeReply() {
        if (phase !== 'awaiting-reply') return null;
        phase = 'handing-over';
        clearTimeout(resident.handoverIntroTimer);
        timing(t, 'handoff_reply_sent');
        log('HANDOVER Iris asked (update_transfer reply) to hand over; technician off hold, still muted');
        techOffHold = true;
        bringInTechnician(residentCallSid, techSid, { unhold: true, unmute: false });
        resident.handoverIntroTimer = setTimeout(() => {
          if (phase === 'handing-over' && !spoke) fallback(`Iris did not start talking within ${config.handoverWrapUpWaitMs / 1000}s of the reply`);
        }, config.handoverWrapUpWaitMs);
        return HANDOVER_REPLY;
      },
      // From /conference/status: Iris's speech events.
      irisSpeech(started) {
        if (started) {
          clearTimeout(resident.handoverGraceTimer);
          resident.handoverGraceTimer = null;
          if (phase === 'handing-over' && !spoke) {
            spoke = true;
            timing(t, 'handoff_iris_speaking');
          }
          return;
        }
        if (phase === 'handing-over' && spoke) whenQuiet(() => complete('Iris handed over', { roomAnnouncement: false }));
        else if (phase === 'fallback') whenQuiet(() => complete('fallback', { roomAnnouncement: true }));
      },
      cancel(why) {
        if (phase === 'done') return;
        phase = 'done';
        clearTimers();
        resident.pendingHandover = null;
        log(`HANDOVER cancelled: ${why}`);
      },
    };
    if (phase === 'handing-over') {
      if (spoke && !irisTalking()) whenQuiet(() => complete('Iris told the caller', { roomAnnouncement: false }));
      else if (!spoke) {
        const left = Math.max(0, config.handoverWrapUpWaitMs - (Date.now() - t.joinReplyAt));
        resident.handoverIntroTimer = setTimeout(() => {
          if (phase === 'handing-over' && !spoke) fallback(`Iris did not start talking within ${config.handoverWrapUpWaitMs / 1000}s of the reply`);
        }, left);
      }
    } else {
      resident.handoverIntroTimer = setTimeout(() => fallback(`no update_transfer call within ${config.handoverReplyWaitMs / 1000}s`), config.handoverReplyWaitMs);
    }
    resident.handoverTimer = setTimeout(() => {
      log(`WARN HANDOVER not finished after ${config.handoverMaxWaitMs / 1000}s; bringing the technician in now`);
      complete('waited the maximum time', { roomAnnouncement: true });
    }, config.handoverMaxWaitMs);
  }

  // A cue to Iris that is sent straight away (she is muted by then, so it cannot cut her off).
  function queueCueNow(residentCallSid, query, text) {
    const resident = residentCalls.get(residentCallSid);
    if (!resident || resident.ended || resident.agent.state !== 'in') return;
    cueAgent(residentCallSid, query, text);
  }

  // The technician waits on hold while Iris finishes (D30): they hear "One moment please",
  // then silence, and the room does not hear them.
  function holdTechnician(residentCallSid, techSid) {
    const resident = residentCalls.get(residentCallSid);
    return inOrder(resident, async () => {
      try {
        await client.conferences(resident.conferenceSid).participants(techSid)
          .update({ hold: true, holdUrl: `${base}/conference/tech-hold`, holdMethod: 'POST' });
        log(`HOLD technician call=${techSid} on hold while Iris finishes`);
        recordPeriod(residentCallSid, 'techHoldPeriods', true);
      } catch (err) {
        log(`ERROR could not put the technician on hold call=${techSid}: ${twilioError(err)}`);
      }
    });
  }

  // unhold: take the technician off hold (they hear the room); unmute: they can be heard.
  function bringInTechnician(residentCallSid, techSid, { unhold, unmute = true }) {
    const resident = residentCalls.get(residentCallSid);
    if (!techSid) return Promise.resolve();
    const options = { ...(unhold ? { hold: false } : {}), ...(unmute ? { muted: false } : {}) };
    return inOrder(resident, async () => {
      if (resident.ended || !resident.present.has(techSid)) return;
      try {
        await client.conferences(resident.conferenceSid).participants(techSid).update(options);
        log(`HOLD technician call=${techSid}${unhold ? ' off hold' : ''}${unhold && unmute ? ' and' : ''}${unmute ? ' unmuted: connected to the resident' : ', still muted: hears Iris introduce them'}`);
        if (unhold) recordPeriod(residentCallSid, 'techHoldPeriods', false);
      } catch (err) {
        log(`ERROR could not bring in the technician call=${techSid}: ${twilioError(err)}`);
      }
    });
  }

  app.post('/conference/tech-hold', twilioHook, (req, res) => {
    const vr = new VoiceResponse();
    vr.say('One moment please.');
    vr.pause({ length: 30 });
    sendTwiml(res, vr);
  });

  // Technician i did not take the call and technician i+1 is about to be called.
  // The cue goes to Iris's leg only: the resident never hears it, they hear Iris say it.
  //   1. cue to Iris ("Technician 1 did not pick up. Calling technician 2 now.")
  //   2. Iris unmuted and the resident taken off hold, while the cue is still playing,
  //      so both are ready by the time she answers it
  //   3. HOLD_MUSIC_RESUME_SEC later: music on and Iris muted again, unless the search
  //      has ended by then (a technician accepted, or nobody is left)
  function updateResident(t, i) {
    const resident = residentCalls.get(t.residentCallSid);
    if (!resident || resident.ended || !resident.conferenceSid) return;
    const { agent } = resident;
    if (agent.state !== 'in' || !agent.callSid) {
      log(`UPDATE skipped for tech#${i}: Iris is not in ${roomName(t.residentCallSid)} to tell the resident`);
      return;
    }

    clearTimeout(t.holdTimer); // the music must not start while she is speaking
    t.holdTimer = null;
    const at = Date.now();
    const update = { tech: i, at, cuedAt: null, via: null, fallbackTimer: null };
    t.residentUpdates.push(update);
    saveReport(t);
    log(`UPDATE technician ${i + 1} did not take the call, Iris tells the resident +${secs(t.startedAt, at)} after tool call`);

    // The audio cue: everything that belongs with it happens when it is actually sent
    // (after a pause): Iris's voice back, music off, and the music-back timer.
    const sendAudioCue = () => queueCue(t.residentCallSid, `kind=tech-update&tech=${i}`, techUpdateLine(i), (sent) => {
      update.cuedAt = Date.now();
      update.via = 'audio cue';
      saveReport(t);
      if (!sent || t.status !== 'searching') return;
      setAgentMuted(t.residentCallSid, false, `telling the resident technician ${i + 1} did not pick up`);
      endHold(t, `Iris is telling the resident technician ${i + 1} did not pick up`);
      if (config.holdDelayMs !== null) scheduleHold(t, config.holdResumeMs);
    });

    // With hold music the resident cannot hear Iris until she is unmuted, so the cue goes now.
    if (config.holdDelayMs !== null) return sendAudioCue();

    // Without hold music (D26): the news goes to Iris in her next update_transfer reply, as
    // text, so nothing is played over anyone. Only if she makes no such call within
    // UPDATE_FALLBACK_MS is the audio cue used.
    update.fallbackTimer = setTimeout(() => {
      update.fallbackTimer = null;
      if (update.cuedAt || t.status !== 'searching') return;
      log(`UPDATE no update_transfer call within ${config.updateFallbackMs} ms: using the audio cue for technician ${i + 1}`);
      sendAudioCue();
    }, config.updateFallbackMs);
  }

  // Search news Iris has not been told yet, for the update_transfer reply (D26). Marks it
  // delivered and cancels its audio-cue fallback. Returns the status text for Iris.
  function statusForIris(t) {
    if (t.status !== 'searching') return null;
    const news = t.residentUpdates.filter((u) => !u.cuedAt);
    const calling = `Technician ${t.cursor + 1} is being called now.`;
    if (!news.length) return `No change: technician ${t.cursor + 1} is still being called. Do not mention it; keep troubleshooting.`;
    const now = Date.now();
    for (const u of news) {
      clearTimeout(u.fallbackTimer);
      u.fallbackTimer = null;
      u.cuedAt = now;
      u.via = 'tool reply';
    }
    dropCues(t.residentCallSid, 'news given in the update_transfer reply instead');
    saveReport(t);
    const failed = news.map((u) => `Technician ${u.tech + 1} did not pick up.`).join(' ');
    log(`UPDATE told Iris in the update_transfer reply: "${failed} ${calling}"`);
    // Keep the thread of the conversation (D35): on real calls "tell the caller, then carry
    // on" made her drop the caller's last answer and restart ("let's keep going").
    return `${failed} ${calling} First respond to what the caller just said, in a few words. Then tell them in one short sentence that the technician did not pick up and you are calling the next one. Then continue the troubleshooting exactly where you left off: the next step or question, without repeating anything already asked or answered.`;
  }

  // ---------------------------------------------------------------- technician calls

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

  // One technician at a time, in TECH_NUMBERS order.
  function startSearch(t) {
    log(`SEARCH start resident=${t.residentCallSid} one at a time techs=${t.techs.map((x) => x.number).join(',')}`);
    dialNext(t);
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
    // Proof of one-at-a-time calling: how long after the previous technician's outcome
    // this one was dialled. The same numbers are in the report's "Call sequence".
    const prev = t.techs[i - 1];
    if (prev && prev.outcomeAt) {
      log(`SEQUENCE tech#${i} ${tech.number} dialled ${tech.dialledAt - prev.outcomeAt} ms after tech#${i - 1}'s outcome (${prev.outcome}) resident=${t.residentCallSid}`);
    }
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
        // The technician's own line, from the moment they pick up: the brief, "Press 1",
        // then their part of the call. Their voice on one channel, what they hear on the other.
        ...(recordLegs ? {
          record: true,
          recordingChannels: 'dual',
          trim: 'do-not-trim',
          recordingStatusCallback: `${base}/twilio/recording-status?${query}&leg=technician`,
          recordingStatusCallbackMethod: 'POST',
          recordingStatusCallbackEvent: ['in-progress', 'completed', 'absent'],
        } : {}),
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
  // Every such outcome (no answer, busy, voicemail, declined, failed) gets the same update
  // to the resident; the last technician failing goes to "no technician" instead.
  function resolveTech(t, i, outcome, detail) {
    if (!setOutcome(t, i, outcome, detail)) return;
    if (t.status !== 'searching' || i !== t.cursor) return;
    if (i + 1 < t.techs.length) updateResident(t, i);
    dialNext(t);
  }

  // Nobody took it. Only Iris tells the resident (D12): she gets a cue that only she
  // hears, and the resident hears her apology once. Twilio's voice never says it to the
  // room. If Twilio refuses the cue, the error is logged and nothing else is played.
  // If her leg is still connecting, the cue waits and is sent the moment she joins.
  // If her leg has dropped, she is brought back with the fallback first message.
  function noTechnician(t) {
    t.status = 'failed';
    t.timings.all_failed = timing(t, 'all_technicians_failed');
    finish(t, 'no technician', t.timings.all_failed);

    const resident = residentCalls.get(t.residentCallSid);
    if (!resident || resident.ended) return;
    const { agent } = resident;
    if (agent.state === 'in' && agent.callSid) {
      // Any technician update still waiting is out of date now. Then the cue (after a
      // pause), and with it music off and Iris's voice back on.
      dropCues(t.residentCallSid, 'search over: no technician');
      queueCue(t.residentCallSid, 'kind=unavailable', ANNOUNCEMENTS.unavailable, () => {
        setAgentMuted(t.residentCallSid, false, 'no technician available');
        endHold(t, 'no technician available');
      });
    } else if (agent.state === 'joining') {
      endHold(t, 'no technician available');
      agent.pendingCue = { query: 'kind=unavailable', text: ANNOUNCEMENTS.unavailable };
      log(`AGENT Iris is still joining ${roomName(t.residentCallSid)}: "${ANNOUNCEMENTS.unavailable}" will be cued when she is in`);
    } else {
      endHold(t, 'no technician available');
      log(`AGENT Iris is not in the room, bringing her back for resident=${t.residentCallSid}`);
      addAgent(t.residentCallSid, { firstMessage: FALLBACK_FIRST_MESSAGE });
    }
  }

  function allFailed(t) {
    if (t.status === 'searching') noTechnician(t);
  }

  // The resident's call is over. Stops a running search.
  function residentGone(residentCallSid, why) {
    const resident = residentCalls.get(residentCallSid);
    if (!resident || resident.ended) return;
    resident.ended = true;
    dropCues(residentCallSid, 'resident gone');
    if (resident.pendingHandover) resident.pendingHandover.cancel('the resident left');
    clearTimeout(resident.handoverTimer);
    clearTimeout(resident.handoverGraceTimer);
    clearTimeout(resident.handoverIntroTimer);
    resident.pendingHandover = null;
    log(`RESIDENT gone resident=${residentCallSid} (${why})`);
    scheduleTranscript(residentCallSid);

    const t = transfers.get(residentCallSid);
    if (t && (t.status === 'searching' || t.status === 'bridging')) {
      t.status = 'cancelled';
      t.timings.resident_hung_up = timing(t, 'resident_hung_up', '-> cancelling all technician calls');
      cancelTechs(t, { why: 'resident hung up' });
      finish(t, 'resident hung up', t.timings.resident_hung_up);
    }
  }

  // A resident left alone in the room would just hear silence, so end the call.
  function endIfResidentAlone(residentCallSid) {
    const resident = residentCalls.get(residentCallSid);
    if (!resident || resident.ended || !resident.conferenceSid) return;
    const t = transfers.get(residentCallSid);
    const searching = t && (t.status === 'searching' || t.status === 'bridging');
    const alone = resident.present.size === 1 && resident.present.has(residentCallSid);
    if (!alone || searching || resident.agent.state === 'joining') return;

    log(`CONFERENCE resident=${residentCallSid} is alone in the room, ending the call`);
    client.conferences(resident.conferenceSid)
      .update({ status: 'completed' })
      .catch((err) => log(`ERROR could not end conference ${resident.conferenceSid}: ${twilioError(err)}`));
  }

  // ---------------------------------------------------------------- resident call

  app.get('/health', (req, res) => res.json({ ok: true }));

  // Optional audio files, e.g. public/connecting.mp3 for the "technician joined" announcement.
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
    residentCalls.set(call.sid, newResidentCall({ direction: 'outbound', number: to, twilioNumber: config.twilioPhoneNumber }));
    log(`START-CALL resident=${call.sid} to=${to}`);
    res.json({ status: 'calling', call_sid: call.sid });
  }));

  // Both ways in put the resident straight into their own room. Iris is added as soon
  // as Twilio reports the resident has joined (see /conference/status).
  function residentIntoRoom(res, residentCallSid) {
    log(`RESIDENT resident=${residentCallSid} -> ${roomName(residentCallSid)}, Iris will be added`);
    sendTwiml(res, conferenceTwiml(residentCallSid, { endConferenceOnExit: true, liveResident: true }));
  }

  app.post('/twilio/outbound-answer', twilioHook, (req, res) => {
    const { CallSid, From, To } = req.body;
    if (!residentCalls.has(CallSid)) {
      residentCalls.set(CallSid, newResidentCall({ direction: 'outbound', number: To, twilioNumber: From }));
    }
    residentIntoRoom(res, CallSid);
  });

  app.post('/twilio/inbound', twilioHook, (req, res) => {
    const { CallSid, From, To } = req.body;
    residentCalls.set(CallSid, newResidentCall({ direction: 'inbound', number: From, twilioNumber: To }));
    residentIntoRoom(res, CallSid);
  });

  // Status of an outbound-started resident call. (For inbound calls the conference
  // ending tells us the same thing, so the number's own settings stay untouched.)
  app.post('/twilio/resident-status', twilioHook, (req, res) => {
    const { CallSid, CallStatus } = req.body;
    res.sendStatus(204);
    if (CALL_ENDED.has(CallStatus)) residentGone(CallSid, `call ${CallStatus}`);
  });

  // ---------------------------------------------------------------- ElevenLabs tool

  app.post('/tool/request-transfer', secretHook, (req, res) => {
    const callSid = String((req.body && (req.body.call_sid || req.body.parent_call_sid)) || '').trim();
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
      if (existing.status === 'failed') {
        return res.json({ status: 'unavailable', message: 'No technician is available right now. Offer to take a message.' });
      }
      if (existing.status === 'connected') {
        return res.json({ status: 'connected', message: 'A technician is on the call with the resident now. Say nothing and let them talk.' });
      }
      return res.json({ status: 'searching', message: 'A technician search is already running for this call. Ask the resident to keep holding.' });
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
        endedAt: null, // when Twilio reported this technician's line closed
      })),
      timings: {},
      holdTimer: null, //      pending "music on" (see scheduleHold)
      holdPeriods: [], //      [{ from, to }] resident on hold music
      mutePeriods: [], //      [{ from, to }] Iris muted
      techHoldPeriods: [], //  [{ from, to }] technician on hold while Iris finished (D30)
      residentUpdates: [], //  [{ tech, at }] "technician N did not pick up" cues sent to Iris
      messages: [], //         [{ text, at }] messages Iris took with the take_message tool
      progress: null, //       latest troubleshooting progress (update_transfer), used in the brief
      progressUpdates: [], //  [{ text, at, used }] every progress sentence Iris sent
      media: resident.media, // Twilio recordings and transcripts, collected since the call started
    };
    transfers.set(callSid, t);
    timing(t, 'tool_call');
    saveReport(t);

    const holdDelayMs = config.holdDelayMs;
    // Branch "iris-troubleshoots-while-searching": with hold music off (the default here)
    // Iris stays with the resident during the search and helps them troubleshoot.
    const whileSearching = holdDelayMs === null
      // She has already told the caller before calling the tool (her prompt), so the reply
      // must not ask her to say it again: on a real call that made her say it twice.
      ? 'You have already told the resident you are reaching out to a technician, so do not say it again. ' +
        'Go straight on: while technicians are being called, help the resident troubleshoot the problem: ask short questions about it and suggest simple, safe checks they can do. ' +
        'Never suggest electrical, gas or structural work, and if anything sounds dangerous (gas smell, sparks, smoke, flooding) tell them to get to safety and call emergency services. '
      : 'Say one short sentence asking the resident to hold while you connect them with a technician, then say nothing more. ' +
        `Hold music starts for the resident in about ${Math.round(holdDelayMs / 1000)} seconds and they cannot hear you while it plays. `;

    const afterUpdate = holdDelayMs === null
      // Keep the thread (D35): on call CA9eb7…3a09 she led with the news and "let's keep
      // going", dropping what the caller had just said ("I have my plunger now").
      ? 'then continue the troubleshooting exactly where you left off: respond to what the caller last said and go on with the next step, without restarting or repeating anything already asked. '
      : 'then say nothing more: the hold music comes back a few seconds later. ';

    // Answer the tool straight away; the search carries on after this response.
    res.json({
      status: 'searching',
      message:
        `Searching for a technician now. Technicians are called one at a time. ${whileSearching}` +
        `You stay on the call. If you hear "Technician 1 did not pick up. Calling technician 2 now." (or the same with other numbers), the resident can hear you: ` +
        `tell them in one short sentence that technician 1 did not pick up and you are now trying the next one, ${afterUpdate}` +
        `When you hear "${ANNOUNCEMENTS.joined}", a technician is talking with the resident: say nothing at all from then on, do not introduce anyone and do not answer, even if spoken to. ` +
        `If you hear "${ANNOUNCEMENTS.unavailable}", the search is over: apologise and offer to take a message${holdDelayMs === null ? '' : ' (the resident can hear you again; stop calling skip_turn)'}. ` +
        'If they give one, call the take_message tool with it, then tell them it is saved for the maintenance team, and keep replying to them until they are done. ' +
        'While troubleshooting, each time you learn something the technician should know (what the resident sees, what they have checked or done, what you advised), ' +
        'call the update_transfer tool with one short sentence summarising the progress so far. The technician hears the latest one when they answer. ' +
        'Call it after each answer from the caller: its reply also tells you if a technician did not pick up, and then you tell the caller in one short sentence.',
    });
    setImmediate(() => startSearch(t));
    // Give Iris time to say "please hold" before the music replaces her.
    if (holdDelayMs !== null) scheduleHold(t, holdDelayMs);
  });

  // The brief a technician hears: the summary from request_transfer, plus the latest
  // troubleshooting progress from update_transfer if Iris has sent any (D24).
  function briefFor(t) {
    const sentence = (s) => (/[.!?]$/.test(s) ? s : `${s}.`);
    const summary = sentence(t.summary);
    return t.progress ? `${summary} Progress so far: ${sentence(t.progress)}` : summary;
  }

  // Iris reports troubleshooting progress during the search. Only the latest sentence is
  // used in the technician brief (built when a technician answers); all are kept in the report.
  app.post('/tool/update-transfer', secretHook, (req, res) => {
    const callSid = String((req.body && (req.body.call_sid || req.body.parent_call_sid)) || '').trim();
    const text = String((req.body && req.body.progress) || '').replace(/\s+/g, ' ').trim().slice(0, 300);

    if (!CALL_SID_RE.test(callSid)) {
      log(`TOOL update-transfer rejected: call_sid=${callSid || '(missing)'} is not a Twilio call SID`);
      return res.status(400).json({ status: 'error', message: 'call_sid is missing or not a Twilio call SID. Is the tool sending the {{call_sid}} dynamic variable?' });
    }
    if (!text) {
      return res.status(400).json({ status: 'error', message: 'progress is empty. Send one short sentence on what has been found or done so far.' });
    }
    const t = transfers.get(callSid);
    if (!t) {
      log(`TOOL update-transfer rejected: no search running for call_sid=${callSid}`);
      return res.status(404).json({ status: 'error', message: 'No technician search for this call yet. Call request_transfer first.' });
    }
    if (t.status !== 'searching') {
      // Too late for a brief, but kept for the report.
      t.progressUpdates.push({ text, at: Date.now(), used: false });
      saveReport(t);
      log(`PROGRESS resident=${callSid} (after the search, not briefed): ${JSON.stringify(text)}`);
      // A technician accepted and is joining (or has joined): Iris wraps up instead of
      // starting a new question that would be cut off at the handover (D27).
      const joining = t.status === 'bridging' || t.status === 'connected';
      const resident = residentCalls.get(callSid);
      let handover = t.status === 'connected' && resident && resident.pendingHandover ? resident.pendingHandover.takeReply() : null;
      // The first reply after the technician pressed 1 (they join a few seconds later): Iris
      // tells the caller herself. On call CA73ec…5b8a the old "finish your point" reply left
      // her silent and the handover fell back to Twilio's announcement (D34).
      if (!handover && t.status === 'bridging' && !t.joinReplyAt) {
        t.joinReplyAt = Date.now();
        timing(t, 'handoff_join_reply_sent');
        log('HANDOVER technician accepted: Iris asked (update_transfer reply) to tell the caller the technician is joining');
        handover = JOINING_REPLY;
      }
      const message = handover || (joining
        ? 'A technician has accepted and is joining the call now. Finish your current point in a few words and do not ask a new question or start a new topic.'
        : 'Noted. The search is already over, so carry on with the caller.');
      return res.json({ status: 'noted', message });
    }
    t.progress = text;
    t.progressUpdates.push({ text, at: Date.now(), used: true });
    saveReport(t);
    log(`PROGRESS resident=${callSid} +${secs(t.startedAt, Date.now())} after tool call: ${JSON.stringify(text)}`);
    const status = statusForIris(t);
    res.json({ status: 'noted', message: `Saved for the technician brief. ${status || 'Keep troubleshooting with the caller.'}` });
  });

  // Iris took a message for the maintenance team (usually after "No technician is
  // available"). It is saved into this call's transfer report and logged. Several
  // messages on one call are all kept, in order.
  app.post('/tool/take-message', secretHook, (req, res) => {
    const callSid = String((req.body && (req.body.call_sid || req.body.parent_call_sid)) || '').trim();
    const text = String((req.body && req.body.message) || '').replace(/\s+/g, ' ').trim().slice(0, 1000);

    if (!CALL_SID_RE.test(callSid)) {
      log(`TOOL take-message rejected: call_sid=${callSid || '(missing)'} is not a Twilio call SID`);
      return res.status(400).json({ status: 'error', message: 'call_sid is missing or not a Twilio call SID. Is the tool sending the {{call_sid}} dynamic variable?' });
    }
    if (!text) {
      log(`TOOL take-message rejected: empty message call_sid=${callSid}`);
      return res.status(400).json({ status: 'error', message: 'The message is empty. Ask the caller what they would like to pass on, then call take_message again.' });
    }
    if (!residentCalls.has(callSid)) {
      log(`TOOL take-message rejected: unknown call_sid=${callSid}`);
      return res.status(404).json({ status: 'error', message: 'No call with that call_sid on this server.' });
    }

    const at = Date.now();
    const t = transfers.get(callSid);
    if (t) {
      t.messages.push({ text, at });
      saveReport(t);
      log(`MESSAGE resident=${t.residentNumber} call=${callSid} saved to report (#${t.messages.length}): ${JSON.stringify(text)}`);
    } else {
      // No technician was asked for on this call, so there is no report to put it in.
      log(`MESSAGE call=${callSid} (no transfer on this call, kept in this log only): ${JSON.stringify(text)}`);
    }
    res.json({ status: 'saved', message: 'The message is saved for the maintenance team. Tell the caller it is saved, then ask if there is anything else.' });
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
    // Started once, before the brief, and kept for the rest of the technician's call.
    if (attempt === 1 && liveTranscription) addLiveTranscription(vr, t.residentCallSid, 'technician', { tech: i, name: `technician-${i + 1}` });
    // Built now, when the technician answers, so it carries the latest troubleshooting
    // progress Iris reported with update_transfer (decision.md D24).
    const brief = briefFor(t);
    tech.briefing = brief;
    if (attempt === 1) log(`BRIEF tech#${i} ${tech.number}: "${brief}"`);
    saveReport(t);
    // The brief is said in full, outside the key-press step, so pressing 1 cannot cut it
    // short (D32: on a real call the technician pressed 1 two seconds into the brief and
    // never heard the progress). Only then: "Press 1".
    vr.say(brief);
    const gather = vr.gather({ numDigits: 1, timeout: 6, action: `${base}/tech/accept?${query}`, method: 'POST' });
    gather.say('Press 1 to connect to the resident.');
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

    // The lock. Only one technician is called at a time, but a key press can still arrive
    // after the search has ended (resident hung up, or a stale call). Node handles one
    // request at a time and there is no await between this check and the assignment.
    const resident = residentCalls.get(t.residentCallSid);
    const gone = t.status === 'cancelled' || !resident || resident.ended;
    if (gone || t.status !== 'searching' || tech.outcome) {
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

    // Progress Iris reported after this technician's brief is read to them now, before
    // they join, so they always arrive with the latest context (D26).
    // 1 can only be pressed after the whole brief has been said, so it was heard (D32).
    tech.heardBriefing = tech.briefing;
    let say = TECH_ANNOUNCEMENT;
    if (t.progress && !(tech.heardBriefing || '').includes(t.progress)) {
      const latest = /[.!?]$/.test(t.progress) ? t.progress : `${t.progress}.`;
      say = `Update: ${latest} ${TECH_ANNOUNCEMENT}`;
      tech.acceptUpdate = latest;
      log(`BRIEF tech#${i} update on accepting: "${latest}"`);
      saveReport(t);
    }

    // The technician joins the room where the resident and Iris already are. Nobody is
    // moved, so Iris stays. The technician leaving does not end the call for the others.
    // They join muted, so they cannot talk over Iris before the handover puts them on hold
    // (D30); the handover unmutes them once she has finished.
    sendTwiml(res, conferenceTwiml(t.residentCallSid, { say, endConferenceOnExit: false, muted: true }));
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
      if (!tech.endedAt) {
        tech.endedAt = Date.now();
        saveReport(t);
      }
      if (t.winner === i && t.status === 'bridging') {
        // Pressed 1 but dropped before reaching the room.
        log(`TECH tech#${i} ${tech.number} accepted but the call ended before joining the room`);
        return noTechnician(t);
      }
      // "completed" means they picked up and the call ended without them accepting.
      if (status === 'completed') resolveTech(t, i, 'declined', 'call ended without pressing 1');
      else if (status === 'no-answer' || status === 'busy' || status === 'canceled') resolveTech(t, i, status, `Twilio reported ${status}`);
      else resolveTech(t, i, 'failed', `Twilio reported ${status}`);
    }
  });

  // ---------------------------------------------------------------- conference

  function whoIs(residentCallSid, resident, t, body) {
    if (body.CallSid === residentCallSid) return 'resident';
    if (String(body.ParticipantLabel || '').startsWith('iris-') || body.CallSid === resident.agent.callSid) return 'agent';
    if (t && t.winner !== null && t.techs[t.winner].callSid === body.CallSid) return 'technician';
    return 'unknown';
  }

  // Conference events (start / join / leave / end) and the recording callback.
  // This is where we learn who is actually in the room.
  app.post('/conference/status', twilioHook, (req, res) => {
    res.sendStatus(204);
    const residentCallSid = req.query.resident;
    const resident = residentCalls.get(residentCallSid);
    const t = transfers.get(residentCallSid);
    const body = req.body;

    if (body.RecordingSid) {
      log(`RECORDING ${body.RecordingStatus} sid=${body.RecordingSid} conference=${body.ConferenceSid} duration=${body.RecordingDuration}s url=${body.RecordingUrl}`);
      upsertRecording(residentCallSid, {
        kind: 'room',
        recording_sid: body.RecordingSid,
        conference_sid: body.ConferenceSid || null,
        channels: Number(body.RecordingChannels) || 1,
        status: body.RecordingStatus || null,
        duration_seconds: body.RecordingDuration ? Number(body.RecordingDuration) : null,
        started_at: isoFromTwilio(body.RecordingStartTime),
        error: body.ErrorCode && body.ErrorCode !== '0' ? `Twilio error ${body.ErrorCode}` : null,
      });
      return;
    }
    if (!resident) return;
    if (body.ConferenceSid && !resident.conferenceSid) resident.conferenceSid = body.ConferenceSid;

    const event = body.StatusCallbackEvent;
    if (event === 'participant-join') {
      const who = whoIs(residentCallSid, resident, t, body);
      resident.present.add(body.CallSid);
      log(`CONFERENCE ${who} joined ${roomName(residentCallSid)} call=${body.CallSid} (now ${resident.present.size} in the room)`);

      if (who === 'resident') {
        addAgent(residentCallSid);
        startResidentRecording(residentCallSid);
      } else if (who === 'agent') {
        resident.agent.state = 'in';
        resident.agent.callSid = body.CallSid;
        resident.agent.muted = false; // a leg always joins unmuted
        // A cue that came up while her leg was still connecting (see noTechnician).
        const pending = resident.agent.pendingCue;
        if (pending) {
          resident.agent.pendingCue = null;
          queueCue(residentCallSid, pending.query, pending.text);
        }
      } else if (who === 'technician' && t.status === 'bridging') {
        t.status = 'connected';
        dropCues(residentCallSid, 'technician joined'); // a waiting "did not pick up" is no longer true
        t.timings.technician_joined = timing(t, 'technician_joined', `conference=${body.ConferenceSid}`);
        logTimingSummary(t);
        finish(t, 'connected', t.timings.technician_joined);
        handOver(residentCallSid, t);
      }
    } else if (event === 'participant-speech-start' || event === 'participant-speech-stop') {
      // Who is talking, so cues to Iris can wait for a pause (see queueCue).
      if (event === 'participant-speech-start') resident.speaking.add(body.CallSid);
      else resident.speaking.delete(body.CallSid);
      // A handoff in progress follows Iris's speech: each step waits until she has been
      // quiet for the grace period, and waits again if she carries on (see handOver, D30, D32).
      // Iris started talking after being told the technician is joining: that is her handover (D34).
      if (event === 'participant-speech-start' && body.CallSid === resident.agent.callSid && t && t.joinReplyAt && !t.irisSpokeAfterJoinReply) {
        t.irisSpokeAfterJoinReply = true;
      }
      if (body.CallSid === resident.agent.callSid && resident.pendingHandover) {
        resident.pendingHandover.irisSpeech(event === 'participant-speech-start');
      }
      // One short line per event (instead of the raw webhook) to see what Twilio reports.
      const nameOf = (sid) => (sid === residentCallSid ? 'resident'
        : sid === resident.agent.callSid ? 'Iris'
          : t && t.winner !== null && t.techs[t.winner].callSid === sid ? 'technician'
            : `call ${String(sid).slice(0, 8)}…`);
      const talking = [...resident.speaking].map(nameOf).join(', ') || 'nobody';
      log(`SPEECH ${nameOf(body.CallSid)} ${event === 'participant-speech-start' ? 'started' : 'stopped'} talking (talking now: ${talking})${resident.cueQueue.length ? ` [${resident.cueQueue.length} cue(s) waiting]` : ''}`);
      pumpCues(residentCallSid);
    } else if (event === 'participant-leave') {
      const who = whoIs(residentCallSid, resident, t, body);
      resident.present.delete(body.CallSid);
      resident.speaking.delete(body.CallSid);
      pumpCues(residentCallSid);
      log(`CONFERENCE ${who} left ${roomName(residentCallSid)} call=${body.CallSid} (now ${resident.present.size} in the room)`);

      if (who === 'agent') resident.agent.state = 'left';
      if (who === 'technician') {
        // Left before Iris finished her sentence: there is nobody to hand over to any more.
        if (resident.pendingHandover) resident.pendingHandover.cancel('the technician left before Iris was muted');
        // The resident is alone with Iris again, so she needs her voice back, and she
        // needs to be told: she has been silent (skip_turn) since the technician joined (D29).
        setAgentMuted(residentCallSid, false, 'technician left');
        if (resident.present.has(residentCallSid)) queueCue(residentCallSid, 'kind=left', ANNOUNCEMENTS.left);
      }
      if (who === 'resident') residentGone(residentCallSid, 'left the room');
      else endIfResidentAlone(residentCallSid);
    } else if (event === 'conference-end') {
      log(`CONFERENCE ended ${body.FriendlyName} conference=${body.ConferenceSid}`);
      if (t && t.status === 'connected') t.status = 'ended';
      residentGone(residentCallSid, 'conference ended');
    }
  });

  // ---------------------------------------------------------------- Twilio media callbacks

  // Status of the resident-line and technician-line recordings (the room recording reports
  // to /conference/status instead).
  app.post('/twilio/recording-status', twilioHook, (req, res) => {
    res.sendStatus(204);
    const residentCallSid = req.query.resident;
    const body = req.body;
    if (!body.RecordingSid) return;
    const isTech = req.query.leg === 'technician';
    const technician = isTech ? Number.parseInt(req.query.tech, 10) + 1 : null;
    upsertRecording(residentCallSid, {
      kind: isTech ? 'technician' : 'resident',
      technician,
      recording_sid: body.RecordingSid,
      call_sid: body.CallSid || null,
      channels: Number(body.RecordingChannels) || null,
      status: body.RecordingStatus || null,
      duration_seconds: body.RecordingDuration ? Number(body.RecordingDuration) : null,
      started_at: isoFromTwilio(body.RecordingStartTime),
      error: body.ErrorCode && body.ErrorCode !== '0' ? `Twilio error ${body.ErrorCode}` : null,
    });
    log(`RECORDING ${legName(isTech ? 'technician' : 'resident', technician)} line ${body.RecordingStatus} sid=${body.RecordingSid} duration=${body.RecordingDuration || '-'}s resident=${residentCallSid}`);
  });

  // Live transcription callbacks: one per finished sentence on one track of one leg,
  // plus started / stopped / error events.
  app.post('/twilio/live-transcription', twilioHook, (req, res) => {
    res.sendStatus(204);
    const residentCallSid = req.query.resident;
    const media = mediaFor(residentCallSid);
    if (!media) return;
    const body = req.body;
    const leg = ['resident', 'technician', 'iris'].includes(req.query.leg) ? req.query.leg : 'unknown';
    const technician = leg === 'technician' ? Number.parseInt(req.query.tech, 10) + 1 : null;
    const event = body.TranscriptionEvent;

    if (event === 'transcription-content') {
      if (body.Final === 'false') return; // partial results are not requested, but just in case
      let text = '';
      let confidence = null;
      try {
        const data = JSON.parse(body.TranscriptionData || '{}');
        text = String(data.transcript || '');
        confidence = data.confidence === undefined ? null : Number(data.confidence);
      } catch {
        text = String(body.TranscriptionData || '');
      }
      text = text.trim();
      if (!text) return;
      const at = Date.parse(body.Timestamp || '');
      media.live_transcript.push({
        leg, technician, track: body.Track || null, text, confidence,
        at: new Date(Number.isFinite(at) ? at : Date.now()).toISOString(),
        call_sid: body.CallSid || null,
      });
      log(`LIVE ${legName(leg, technician)} ${body.Track || '?'}: ${JSON.stringify(text)}`);
    } else if (event) {
      const detail = body.TranscriptionError || body.TranscriptionErrorCode || null;
      media.live_events.push({ leg, technician, event, at: new Date().toISOString(), detail, call_sid: body.CallSid || null });
      log(`LIVE ${legName(leg, technician)} ${event}${detail ? `: ${detail}` : ''}`);
    }
    persistMedia(residentCallSid);
  });

  // ---------------------------------------------------------------- reports

  app.get('/reports', localOnly, (req, res) => {
    const all = reports.list();
    if (req.query.format === 'json') return res.json(all);
    res.type('html').send(renderList(all));
  });

  app.get('/reports/:sid', localOnly, wrap(async (req, res) => {
    if (!reports.get(req.params.sid)) return res.status(404).send('No report for that call SID.');
    // Opening the page fetches the latest transcript (until it is final), but never
    // keeps the browser waiting long if ElevenLabs is slow.
    await Promise.race([
      Promise.all([refreshTranscript(req.params.sid), refreshTwilioTranscripts(req.params.sid)]),
      new Promise((resolve) => { setTimeout(resolve, 9000).unref(); }),
    ]);
    const report = reports.get(req.params.sid);
    if (req.query.format === 'json') return res.json(report);
    res.type('html').send(renderDetail(report));
  }));

  // Plays one of this call's Twilio recordings in the report page. The server downloads it
  // from Twilio with the account credentials, so the browser never needs them.
  app.get('/reports/:sid/recordings/:file', localOnly, wrap(async (req, res) => {
    const report = reports.get(req.params.sid);
    const recordingSid = String(req.params.file).replace(/\.mp3$/i, '');
    const known = report && report.twilio && (report.twilio.recordings || []).some((r) => r.recording_sid === recordingSid);
    if (!RECORDING_SID_RE.test(recordingSid) || !known) return res.status(404).send('No such recording for this call.');
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.twilioAccountSid}/Recordings/${recordingSid}.mp3`;
    const auth = Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64');
    const response = await fetchImpl(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!response.ok) return res.status(502).send(`Twilio answered HTTP ${response.status} for recording ${recordingSid}.`);
    res.type('audio/mpeg').send(Buffer.from(await response.arrayBuffer()));
  }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log(`ERROR ${req.method} ${req.originalUrl}: ${err.stack || err.message}`);
    if (!res.headersSent) res.status(500).json({ status: 'error', message: err.message });
  });

  return { app, state: { residentCalls, transfers } };
}

module.exports = { createApp, FALLBACK_FIRST_MESSAGE, ANNOUNCEMENTS, techUpdateLine };
