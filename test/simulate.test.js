'use strict';

// Branch "sequential-with-updates" (built on "agent-stays-on-call").
// Simulates Twilio's webhooks against the real Express app with a fake Twilio
// REST client, so the call logic can be checked without placing calls.
// Requests are signed for PUBLIC_BASE_URL but sent to localhost, which is the
// same situation as running behind ngrok.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const twilio = require('twilio');
const { createApp, FALLBACK_FIRST_MESSAGE, techUpdateLine } = require('../src/app');
const { loadConfig } = require('../src/config');

const AUTH_TOKEN = 'test-auth-token';
const PUBLIC = 'https://playground.example.test';
const TOOL_SECRET = 'test-tool-secret';
const TWILIO_NUMBER = '+15559990000';
const RESIDENT = `CA${'a'.repeat(32)}`;
const RESIDENT_NUMBER = '+15551110000';
const APP_SID = `AP${'b'.repeat(32)}`;
const CONFERENCE = `CF${'c'.repeat(32)}`;
const ROOM = `room-${RESIDENT}`;
const AGENT_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://agent.example.test"/></Connect></Response>';
const FORGED = 'bm90LWEtcmVhbC1zaWduYXR1cmU=';

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

// holdDelayMs: null = no hold music (most tests), a number = music starts that long after the tool call.
// holdResumeMs: how long after a "technician did not pick up" update the music comes back.
// recordLegs / liveTranscription / liveTranscriptionIrisLeg: the Twilio recordings and live
// transcripts merged from full-call-recording. Off unless a test turns them on.
async function setup({ techNumbers = ['+15550000001', '+15550000002'], holdDelayMs = null, holdResumeMs = 40, cueQuietGapMs = 0, cueMaxWaitMs = 1000, handoverMaxWaitMs = 1000, updateFallbackMs = 0, handoverGraceMs = 0, handoverWrapUpWaitMs = 0, recordLegs = false, liveTranscription = false, liveTranscriptionIrisLeg = false } = {}) {
  const created = []; //        calls.create(...)            -> technician calls and /start-call
  const updates = []; //        calls(sid).update(...)
  const legRecordings = []; //  calls(sid).recordings.create(...) -> recording the resident's own line
  const agentLegs = []; //      conferences(sid).participants.create(...) -> Iris joining
  const roomUpdates = []; //    conferences(sid).update(...) -> announcements, ending the room
  const registered = []; //     register-call requests to ElevenLabs
  const logs = [];
  const failUpdatesFor = new Set(); //   call SIDs whose REST updates throw
  const answeredMeanwhile = new Set(); // call SIDs that report in-progress when we try to cancel them
  const mutes = []; //          conferences(sid).participants(callSid).update(...) -> muting Iris
  const holds = []; //          same call with "hold" -> the resident's hold music
  const agentCues = []; //      conferences(sid).participants(callSid).update({ announceUrl }) -> cue to one leg
  const roomActions = []; //    mutes, holds, announcements and room endings, in the order they were sent
  const techUpdates = []; //    conferences(sid).participants(techCallSid).update(...) -> technician hold / release
  const flags = { failAgentAdd: false, failRegister: false, failConversations: false, failMute: false, failAgentCue: false };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-transfer-test-'));
  // Stand-in for the ElevenLabs conversations API: what it would return for a call.
  const elevenLabs = { details: [], lookups: [] };
  const conversations = {
    forCall: async (callSid, startedAfterUnix) => {
      elevenLabs.lookups.push({ callSid, startedAfterUnix });
      if (flags.failConversations) throw new Error('ElevenLabs HTTP 500: upstream error');
      return elevenLabs.details;
    },
  };

  const calls = (sid) => ({
    update: async (options) => {
      updates.push({ sid, ...options });
      if (failUpdatesFor.has(sid)) {
        throw Object.assign(new Error('Call is not in-progress'), { code: 21220 });
      }
      const ignored = options.status === 'canceled' && answeredMeanwhile.has(sid);
      return { sid, status: ignored ? 'in-progress' : options.status || 'in-progress' };
    },
    recordings: {
      create: async (options) => {
        legRecordings.push({ callSid: sid, ...options });
        return { sid: `RE${String(legRecordings.length).padStart(32, '0')}`, status: 'in-progress' };
      },
    },
  });
  calls.create = async (options) => {
    const sid = `CA${String(created.length + 1).padStart(32, '0')}`;
    created.push({ sid, ...options });
    return { sid, status: 'queued' };
  };

  const conferences = (sid) => {
    // conferences(sid).participants(callSid).update(...) mutes or unmutes one participant.
    // ...and with "hold" it puts one participant on hold music or takes them off it.
    const participants = (callSid) => ({
      update: async (options) => {
        // The technician held while Iris finishes, then released (D30).
        if (created.some((c) => c.sid === callSid)) {
          roomActions.push(options.hold ? 'tech:hold' : 'tech:release');
          techUpdates.push({ conferenceSid: sid, callSid, ...options });
          return { callSid };
        }
        if ('announceUrl' in options) {
          const url = new URL(options.announceUrl);
          const techParam = url.searchParams.get('tech');
          roomActions.push(`cue:${url.searchParams.get('kind')}${techParam === null ? '' : `:${techParam}`}`);
          agentCues.push({ conferenceSid: sid, callSid, ...options });
          if (flags.failAgentCue) throw Object.assign(new Error('Participant not found'), { code: 20404 });
          return { callSid };
        }
        if ('hold' in options) {
          roomActions.push(`hold:${options.hold}`);
          holds.push({ conferenceSid: sid, callSid, ...options });
          return { callSid, hold: options.hold };
        }
        roomActions.push(`mute:${options.muted}`);
        mutes.push({ conferenceSid: sid, callSid, ...options });
        if (flags.failMute) throw Object.assign(new Error('Participant not found'), { code: 20404 });
        return { callSid, muted: options.muted };
      },
    });
    participants.create = async (options) => {
      if (flags.failAgentAdd) throw Object.assign(new Error('Application not found'), { code: 21218 });
      const callSid = `CA${'e'.repeat(31)}${agentLegs.length + 1}`;
      agentLegs.push({ conferenceSid: sid, callSid, ...options });
      return { callSid, label: options.label };
    };
    return {
      update: async (options) => {
        roomActions.push(options.announceUrl ? `announce:${new URL(options.announceUrl).searchParams.get('kind')}` : `room:${options.status}`);
        roomUpdates.push({ sid, ...options });
        return { sid };
      },
      participants,
    };
  };

  const config = {
    publicBaseUrl: PUBLIC,
    twilioAuthToken: AUTH_TOKEN,
    twilioPhoneNumber: TWILIO_NUMBER,
    toolSecret: TOOL_SECRET,
    techNumbers,
    warnings: [],
    ringTimeoutSec: 20,
    agentAppSid: APP_SID,
    holdDelayMs,
    holdResumeMs,
    cueQuietGapMs,
    cueMaxWaitMs,
    handoverMaxWaitMs,
    updateFallbackMs,
    handoverGraceMs,
    handoverWrapUpWaitMs,
    holdMusicUrl: 'http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical',
    recordLegs,
    liveTranscription,
    liveTranscriptionIrisLeg,
    transcriptRetryMs: [5],
    reportsDir: path.join(tmp, 'reports'),
    publicDir: path.join(tmp, 'public'),
  };
  const registerCall = async (args) => {
    registered.push(args);
    if (flags.failRegister) throw new Error('register-call HTTP 401: invalid api key');
    return AGENT_TWIML;
  };

  const { app, state } = createApp({ config, client: { calls, conferences }, registerCall, conversations, logger: (line) => logs.push(line) });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const local = `http://localhost:${server.address().port}`;

  // POST a form body the way Twilio does, signed for the public URL.
  async function hook(urlPath, params, { signature } = {}) {
    const sig = signature || twilio.getExpectedTwilioSignature(AUTH_TOKEN, PUBLIC + urlPath, params);
    const response = await fetch(local + urlPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': sig },
      body: new URLSearchParams(params).toString(),
    });
    return { status: response.status, text: await response.text() };
  }

  async function json(urlPath, body, secret = TOOL_SECRET) {
    const response = await fetch(local + urlPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Tool-Secret': secret } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  async function get(urlPath, headers = {}) {
    const response = await fetch(local + urlPath, { headers });
    return { status: response.status, text: await response.text() };
  }

  // A conference status callback for the resident's room.
  async function room(event, params = {}, resident = RESIDENT) {
    const result = await hook(`/conference/status?resident=${resident}`, {
      StatusCallbackEvent: event, ConferenceSid: CONFERENCE, FriendlyName: `room-${resident}`, ...params,
    });
    await tick();
    return result;
  }

  // Iris's leg: Twilio asks the TwiML App URL for TwiML, then reports her in the room.
  async function avaJoins(resident = RESIDENT) {
    const leg = agentLegs.at(-1);
    const answer = await hook('/twilio/agent-leg', { CallSid: `CA${'d'.repeat(32)}`, From: TWILIO_NUMBER, To: `app:${APP_SID}`, resident });
    await room('participant-join', { CallSid: leg.callSid, ParticipantLabel: leg.label }, resident);
    return answer;
  }
  const avaLeaves = () => room('participant-leave', { CallSid: agentLegs.at(-1).callSid, ParticipantLabel: agentLegs.at(-1).label });

  // Resident calls in, lands in the room, Iris is added and joins.
  async function residentIsWithAva() {
    const inbound = await hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: TWILIO_NUMBER, Direction: 'inbound' });
    await room('participant-join', { CallSid: RESIDENT });
    await avaJoins();
    return inbound;
  }

  // ...and then Iris asks for a transfer.
  async function residentAsksForTransfer() {
    await residentIsWithAva();
    const reply = await json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'Leak under the kitchen sink in unit 4B.' });
    await tick();
    return reply;
  }

  const tech = (i) => {
    const query = `resident=${RESIDENT}&tech=${i}`;
    const sid = () => created.find((c) => c.url && c.url.includes(`tech=${i}`)).sid;
    return {
      sid,
      status: (CallStatus) => hook(`/tech/status?${query}`, { CallSid: sid(), CallStatus }),
      // Picks up: the status callback and the TwiML request, as Twilio sends them.
      answered: async (attempt) => {
        if (!attempt) await hook(`/tech/status?${query}`, { CallSid: sid(), CallStatus: 'in-progress' });
        return hook(`/tech/answered?${query}${attempt ? `&attempt=${attempt}` : ''}`, { CallSid: sid(), CallStatus: 'in-progress' });
      },
      amd: (AnsweredBy) => hook(`/tech/amd?${query}`, { CallSid: sid(), AnsweredBy, MachineDetectionDuration: '3200' }),
      press: (Digits) => hook(`/tech/accept?${query}`, { CallSid: sid(), Digits }),
      joins: () => room('participant-join', { CallSid: sid() }),
      leaves: () => room('participant-leave', { CallSid: sid() }),
    };
  };

  // Technician i takes the call and arrives in the room.
  async function techAcceptsAndJoins(i = 0) {
    await tech(i).answered();
    const accept = await tech(i).press('1');
    await tick();
    await tech(i).joins();
    return accept;
  }

  const techCalls = () => created.filter((c) => c.url && c.url.includes('/tech/answered'));
  // Status values sent to Twilio for one call, in order, e.g. ['canceled', 'completed'].
  const endedWith = (sid) => updates.filter((u) => u.sid === sid && u.status).map((u) => u.status);
  const announcements = () => roomUpdates.filter((u) => u.announceUrl).map((u) => new URL(u.announceUrl).searchParams.get('kind'));
  const roomEnded = () => roomUpdates.some((u) => u.status === 'completed');
  const transfer = () => state.transfers.get(RESIDENT);
  const outcomes = () => transfer().techs.map((x) => x.outcome);
  const report = () => JSON.parse(fs.readFileSync(path.join(config.reportsDir, `${RESIDENT}.json`), 'utf8'));
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  return {
    config, state, created, updates, legRecordings, techUpdates, agentLegs, roomUpdates, mutes, holds, agentCues, roomActions, registered, logs, failUpdatesFor, answeredMeanwhile, flags, elevenLabs,
    hook, json, get, room, avaJoins, avaLeaves, residentIsWithAva, residentAsksForTransfer, tech, techAcceptsAndJoins,
    techCalls, endedWith, announcements, roomEnded, transfer, outcomes, report, close,
  };
}

// ---------------------------------------------------------------- call start

test('call start: resident goes into a room and Iris is added to it as her own leg', async (t) => {
  const s = await setup();
  t.after(s.close);

  const inbound = await s.hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: TWILIO_NUMBER, Direction: 'inbound' });
  assert.match(inbound.text, new RegExp(`<Dial><Conference[^>]*>${ROOM}</Conference></Dial>`));
  assert.match(inbound.text, /endConferenceOnExit="true"/, 'the resident leaving ends the call');
  assert.match(inbound.text, /waitUrl=""/, 'silence, not hold music, until Iris joins');
  assert.match(inbound.text, /record="record-from-start"/);
  assert.match(inbound.text, /statusCallbackEvent="start end join leave speaker"/);
  assert.doesNotMatch(inbound.text, /<Connect>/, 'the ElevenLabs stream is not on the resident leg any more');
  assert.equal(s.registered.length, 0);
  assert.equal(s.agentLegs.length, 0, 'Iris is added once the resident is in the room');

  await s.room('participant-join', { CallSid: RESIDENT });
  assert.equal(s.agentLegs.length, 1);
  const leg = s.agentLegs[0];
  assert.equal(leg.conferenceSid, CONFERENCE);
  assert.equal(leg.to, `app:${APP_SID}?resident=${RESIDENT}`);
  assert.equal(leg.from, TWILIO_NUMBER);
  assert.equal(leg.label, 'iris-1');
  assert.equal(leg.endConferenceOnExit, false, 'Iris dropping does not end the call');

  // Twilio asks the TwiML App URL what to do with Iris's leg: the ElevenLabs stream.
  const answer = await s.avaJoins();
  assert.match(answer.text, /<Connect><Stream/);
  assert.deepEqual(s.registered[0], {
    fromNumber: RESIDENT_NUMBER, toNumber: TWILIO_NUMBER, direction: 'inbound', callSid: RESIDENT, firstMessage: null,
  });
  assert.equal(s.state.residentCalls.get(RESIDENT).agent.state, 'in');

  // A repeated join event does not add a second Iris.
  await s.room('participant-join', { CallSid: RESIDENT });
  assert.equal(s.agentLegs.length, 1);
});

test('agent leg: the resident call is found from Param_resident, or from the one call waiting for Iris', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: TWILIO_NUMBER, Direction: 'inbound' });
  await s.room('participant-join', { CallSid: RESIDENT });

  const prefixed = await s.hook('/twilio/agent-leg', { CallSid: `CA${'d'.repeat(32)}`, Param_resident: RESIDENT });
  assert.match(prefixed.text, /<Connect>/);
  const bare = await s.hook('/twilio/agent-leg', { CallSid: `CA${'d'.repeat(32)}` });
  assert.match(bare.text, /<Connect>/);
  assert.deepEqual(s.registered.map((r) => r.callSid), [RESIDENT, RESIDENT]);
});

test('agent leg: if ElevenLabs refuses, the resident hears an apology on that leg', async (t) => {
  const s = await setup();
  t.after(s.close);
  s.flags.failRegister = true;
  await s.hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: TWILIO_NUMBER, Direction: 'inbound' });
  await s.room('participant-join', { CallSid: RESIDENT });

  const answer = await s.hook('/twilio/agent-leg', { CallSid: `CA${'d'.repeat(32)}`, resident: RESIDENT });
  assert.match(answer.text, /<Say>Sorry, we are having trouble connecting you right now/);
  assert.match(answer.text, /<Hangup\/>/);
});

test('Iris cannot be added (for example a wrong TwiML App SID): the resident is told and the call ends', async (t) => {
  const s = await setup();
  t.after(s.close);
  s.flags.failAgentAdd = true;
  await s.hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: TWILIO_NUMBER, Direction: 'inbound' });
  await s.room('participant-join', { CallSid: RESIDENT });

  const told = s.updates.find((u) => u.sid === RESIDENT && u.twiml);
  assert.match(told.twiml, /Sorry, we are having trouble connecting you right now/);
  assert.match(told.twiml, /<Hangup\/>/);
  assert.ok(s.logs.some((line) => line.includes('ERROR could not add Iris') && line.includes('Twilio error 21218')));
});

test('outbound start: /start-call rings the resident, who lands in the room; Iris registers as outbound', async (t) => {
  const s = await setup();
  t.after(s.close);

  assert.equal((await s.json('/start-call', { to: RESIDENT_NUMBER }, null)).status, 401);
  assert.equal((await s.json('/start-call', { to: 'not-a-number' })).status, 400);

  const started = await s.json('/start-call', { to: RESIDENT_NUMBER });
  assert.equal(started.status, 200);
  const sid = started.body.call_sid;
  assert.equal(s.created[0].url, `${PUBLIC}/twilio/outbound-answer`);
  assert.equal(s.created[0].statusCallback, `${PUBLIC}/twilio/resident-status`);

  const answer = await s.hook('/twilio/outbound-answer', { CallSid: sid, From: TWILIO_NUMBER, To: RESIDENT_NUMBER, Direction: 'outbound-api' });
  assert.match(answer.text, new RegExp(`<Conference[^>]*>room-${sid}</Conference>`));

  await s.room('participant-join', { CallSid: sid }, sid);
  assert.equal(s.agentLegs[0].to, `app:${APP_SID}?resident=${sid}`);
  await s.avaJoins(sid);
  assert.deepEqual(s.registered[0], {
    fromNumber: TWILIO_NUMBER, toNumber: RESIDENT_NUMBER, direction: 'outbound', callSid: sid, firstMessage: null,
  });
});

// ---------------------------------------------------------------- transfer

test('accept: the technician joins the same room, nobody is moved, and Iris is still there', async (t) => {
  const s = await setup();
  t.after(s.close);

  const reply = await s.residentAsksForTransfer();
  assert.equal(reply.status, 200);
  assert.equal(reply.body.status, 'searching');
  assert.match(reply.body.message, /When you hear "A technician has joined the call\.".*say nothing at all/, 'the tool reply tells Iris to go silent');

  // Sequential: only the first technician is dialled, with async AMD, 20s timeout and status callbacks.
  assert.equal(s.techCalls().length, 1);
  const dialled = s.techCalls()[0];
  assert.equal(dialled.to, '+15550000001');
  assert.equal(dialled.machineDetection, 'Enable');
  assert.equal(dialled.asyncAmd, 'true');
  assert.equal(dialled.asyncAmdStatusCallback, `${PUBLIC}/tech/amd?resident=${RESIDENT}&tech=0`);
  assert.equal(dialled.timeout, 20);
  assert.deepEqual(dialled.statusCallbackEvent, ['initiated', 'ringing', 'answered', 'completed']);

  await s.tech(0).status('ringing');
  const prompt = await s.tech(0).answered();
  assert.match(prompt.text, /<Gather[^>]*numDigits="1"/);
  assert.match(prompt.text, /Leak under the kitchen sink in unit 4B\. Press 1 to connect to the resident\./);
  await s.tech(0).amd('human');

  const accept = await s.tech(0).press('1');
  assert.match(accept.text, new RegExp(`<Say>Connecting you to the resident\\.</Say><Dial><Conference[^>]*>${ROOM}</Conference>`));
  assert.match(accept.text, /endConferenceOnExit="false"/, 'the technician leaving does not end the call');
  await tick();
  assert.equal(s.transfer().status, 'bridging');

  await s.tech(0).joins();
  assert.equal(s.transfer().status, 'connected');

  // The point of this branch: the resident's call is never touched, so Iris's stream keeps running.
  assert.deepEqual(s.updates.filter((u) => u.sid === RESIDENT), [], 'resident call is not updated');
  assert.equal(s.agentLegs.length, 1, 'Iris was added once and never replaced');
  assert.equal(s.state.residentCalls.get(RESIDENT).agent.state, 'in');
  assert.equal(s.state.residentCalls.get(RESIDENT).present.size, 3, 'resident, Iris and the technician are in the room');
  assert.equal(s.roomEnded(), false);
  assert.equal(s.registered.length, 1, 'no second ElevenLabs conversation');

  // Iris is silenced first, then the room is told the technician has arrived.
  assert.deepEqual(s.roomActions, ['cue:wrapup', 'mute:true', 'tech:release', 'announce:joined']);
  assert.deepEqual(s.mutes, [{ conferenceSid: CONFERENCE, callSid: s.agentLegs[0].callSid, muted: true }], "it is Iris's leg that is muted");
  assert.equal(s.state.residentCalls.get(RESIDENT).agent.muted, true);
  assert.equal(s.roomUpdates[0].sid, CONFERENCE);
  assert.ok(s.logs.some((line) => line.includes('AGENT Iris muted')));
  assert.equal(s.techCalls().length, 1, 'second technician is never dialled');

  const logText = s.logs.join('\n');
  for (const event of ['tool_call', 'first_tech_ringing', 'tech_answered', 'tech_pressed_1', 'technician_joined', 'TIMING SUMMARY']) {
    assert.ok(logText.includes(event), `timing log has ${event}`);
  }
  assert.equal(s.logs.filter((line) => line.includes('TRANSFER CONNECTED')).length, 1, 'one-line summary printed once');

  const report = s.report();
  assert.equal(report.resident_call_sid, RESIDENT);
  assert.equal(report.resident_number, RESIDENT_NUMBER);
  assert.equal(report.summary, 'Leak under the kitchen sink in unit 4B.');
  assert.equal(report.dial_mode, 'sequential');
  assert.equal(report.transfer_style, 'agent stays on the call');
  assert.equal(report.result, 'connected');
  assert.equal(report.connected_technician, '+15550000001');
  assert.equal(typeof report.resident_wait_seconds, 'number');
  assert.ok(report.agent_muted_at, 'the report records when Iris was muted');
  assert.equal(report.agent_unmuted_at, null);
  const [first, second] = report.technicians;
  assert.equal(first.outcome, 'accepted');
  assert.equal(first.answered_by, 'human');
  for (const key of ['dialled', 'ringing', 'answered', 'outcome']) {
    assert.equal(typeof first.seconds_from_tool_call[key], 'number', `seconds_from_tool_call.${key}`);
  }
  assert.equal(second.outcome, 'not-called');

  // If Iris checks again, she is told the technician is there.
  const again = await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'again' });
  assert.equal(again.body.status, 'connected');
});

test('announcements: spoken lines by default, public/connecting.mp3 for "joined" when the file exists', async (t) => {
  const s = await setup();
  t.after(s.close);

  assert.match((await s.hook('/conference/announce?kind=joined', { ConferenceSid: CONFERENCE })).text, /<Say>A technician has joined the call\.<\/Say>/);
  assert.match((await s.hook('/conference/announce?kind=unavailable', { ConferenceSid: CONFERENCE })).text, /<Say>No technician is available right now\.<\/Say>/);
  assert.equal((await s.hook('/conference/announce?kind=joined', { ConferenceSid: CONFERENCE }, { signature: FORGED })).status, 403);

  fs.mkdirSync(s.config.publicDir, { recursive: true });
  fs.writeFileSync(path.join(s.config.publicDir, 'connecting.mp3'), 'not really audio');
  const played = await s.hook('/conference/announce?kind=joined', { ConferenceSid: CONFERENCE });
  assert.match(played.text, new RegExp(`<Play>${PUBLIC}/public/connecting\\.mp3</Play>`));
  assert.doesNotMatch(played.text, /<Say>/);
  assert.equal((await s.get('/public/connecting.mp3')).text, 'not really audio');
});

test('after connecting: the call survives the technician or Iris leaving, and ends when the resident is left alone', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.techAcceptsAndJoins(0);

  // Technician hangs up: the resident is still with Iris, who gets her voice back and is
  // told the technician has gone (D29), in that order.
  await s.tech(0).leaves();
  await tick();
  assert.equal(s.roomEnded(), false);
  assert.equal(s.state.residentCalls.get(RESIDENT).present.size, 2);
  assert.deepEqual(s.roomActions, ['cue:wrapup', 'mute:true', 'tech:release', 'announce:joined', 'mute:false', 'cue:left']);
  assert.equal(s.state.residentCalls.get(RESIDENT).agent.muted, false);
  assert.ok(s.report().agent_unmuted_at);

  // Then Iris's conversation ends too: nobody is left for the resident to talk to.
  await s.avaLeaves();
  assert.equal(s.roomEnded(), true);
  assert.equal(s.roomUpdates.at(-1).sid, CONFERENCE);
});

test('muting: if Twilio refuses the mute it is logged and the room is still told; no mute is attempted when Iris is not there', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  s.flags.failMute = true;
  await s.techAcceptsAndJoins(0);

  assert.deepEqual(s.roomActions, ['cue:wrapup', 'mute:true', 'tech:release', 'announce:joined']);
  assert.ok(s.logs.some((line) => line.includes('ERROR could not mute Iris') && line.includes('Twilio error 20404')));
  assert.equal(s.state.residentCalls.get(RESIDENT).agent.muted, false);
  assert.equal(s.report().agent_muted_at, null, 'the report does not claim she was muted');

  const other = await setup();
  t.after(other.close);
  await other.residentAsksForTransfer();
  await other.avaLeaves();
  await other.techAcceptsAndJoins(0);
  assert.deepEqual(other.roomActions, ['tech:release', 'announce:joined'], 'no Iris to mute or wait for: the technician (who joined muted) is unmuted at once');
});

// ---------------------------------------------------------------- hold music

test('hold music: shortly after the tool call the resident hears music and Iris is muted; both end when the technician joins', async (t) => {
  const s = await setup({ holdDelayMs: 10 });
  t.after(s.close);

  const reply = await s.residentAsksForTransfer();
  assert.match(reply.body.message, /asking the resident to hold/, 'Iris is told to say "please hold" first');
  await tick();

  assert.deepEqual(s.roomActions, ['hold:true', 'mute:true']);
  assert.deepEqual(s.holds[0], {
    conferenceSid: CONFERENCE,
    callSid: RESIDENT,
    hold: true,
    holdUrl: 'http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical',
    holdMethod: 'GET',
  });
  assert.equal(s.mutes[0].callSid, s.agentLegs[0].callSid);
  assert.ok(s.report().hold_started_at);
  assert.ok(s.report().agent_muted_at);
  assert.ok(s.logs.some((line) => line.includes('HOLD') && line.includes('on hold with music')));

  await s.techAcceptsAndJoins(0);
  // Music off first, then the announcement, so the resident hears it. Iris stays muted.
  assert.deepEqual(s.roomActions, ['hold:true', 'mute:true', 'tech:release', 'hold:false', 'announce:joined']);
  assert.deepEqual(s.holds[1], { conferenceSid: CONFERENCE, callSid: RESIDENT, hold: false });
  assert.equal(s.state.residentCalls.get(RESIDENT).agent.muted, true);
  const report = s.report();
  assert.ok(report.hold_ended_at >= report.hold_started_at);
  assert.equal(report.agent_unmuted_at, null);
});

test('hold music: when nobody is available the music stops and Iris gets her voice back before the announcement', async (t) => {
  const s = await setup({ holdDelayMs: 10, holdResumeMs: 500 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  await tick();

  await s.tech(0).status('busy');
  await tick();
  await s.tech(1).status('no-answer');
  await tick();

  // Technician 1 failing gives the update (music off, Iris's voice back); technician 2
  // failing is the end of the list, so "no technician" with nothing left to undo.
  assert.deepEqual(s.roomActions, ['hold:true', 'mute:true', 'cue:tech-update:0', 'mute:false', 'hold:false', 'cue:unavailable']);
  const report = s.report();
  assert.equal(report.result, 'no technician');
  assert.ok(report.hold_ended_at);
  assert.ok(report.agent_unmuted_at);
});

test('hold music, one technician only: nobody to update about, so it goes straight to "no technician"', async (t) => {
  const s = await setup({ holdDelayMs: 10, techNumbers: ['+15550000001'] });
  t.after(s.close);
  await s.residentAsksForTransfer();
  await tick();

  await s.tech(0).status('no-answer');
  await tick();
  assert.deepEqual(s.roomActions, ['hold:true', 'mute:true', 'cue:unavailable', 'mute:false', 'hold:false']);
  assert.equal(s.agentCues.filter((c) => c.announceUrl.includes('kind=tech-update')).length, 0, 'no technician update for the last (only) technician');
});

test('hold music: not started if the search is already over, and can be switched off', async (t) => {
  // Resident hangs up before the music would have started.
  const gone = await setup({ holdDelayMs: 300 });
  t.after(gone.close);
  await gone.residentAsksForTransfer();
  await gone.room('participant-leave', { CallSid: RESIDENT });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(gone.holds, []);

  // A technician accepted before the music would have started.
  const quick = await setup({ holdDelayMs: 600 });
  t.after(quick.close);
  await quick.residentAsksForTransfer();
  await quick.techAcceptsAndJoins(0);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.deepEqual(quick.holds, []);
  assert.deepEqual(quick.roomActions, ['cue:wrapup', 'mute:true', 'tech:release', 'announce:joined']);

  // HOLD_MUSIC_DELAY_SEC=off
  const off = await setup({ holdDelayMs: null });
  t.after(off.close);
  const reply = await off.residentAsksForTransfer();
  assert.match(reply.body.message, /help the resident troubleshoot the problem/);
  await tick();
  assert.deepEqual(off.roomActions, []);
});

test('after connecting: Iris can drop out and the resident and technician carry on', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.techAcceptsAndJoins(0);

  await s.avaLeaves();
  assert.equal(s.roomEnded(), false);
  assert.equal(s.state.residentCalls.get(RESIDENT).agent.state, 'left');

  await s.tech(0).leaves();
  assert.equal(s.roomEnded(), true);
});

test('before any transfer: Iris ending the conversation ends the resident call', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentIsWithAva();
  await s.avaLeaves();
  assert.equal(s.roomEnded(), true);
});

// ---------------------------------------------------------------- technician outcomes

test('decline: first technician presses 2, the second is called and accepts', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).answered();
  const declined = await s.tech(0).press('2');
  assert.match(declined.text, /<Hangup\/>/);
  await tick();
  assert.equal(s.techCalls().length, 2);
  assert.equal(s.techCalls()[1].to, '+15550000002');

  // The declined call finishing afterwards must not advance the search a second time.
  await s.tech(0).status('completed');
  await tick();
  assert.equal(s.techCalls().length, 2);

  await s.techAcceptsAndJoins(1);
  assert.equal(s.transfer().winner, 1);
  assert.deepEqual(s.outcomes(), ['declined', 'accepted']);
  assert.equal(s.report().connected_technician, '+15550000002');
});

test('no answer and busy: recorded as such and the next technician is tried', async (t) => {
  const s = await setup({ techNumbers: ['+15550000001', '+15550000002', '+15550000003'] });
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).status('no-answer');
  await tick();
  assert.equal(s.techCalls().length, 2);
  await s.tech(1).status('busy');
  await tick();
  assert.equal(s.techCalls().length, 3);
  assert.deepEqual(s.outcomes(), ['no-answer', 'busy', null]);
});

test('voicemail (async AMD): brief starts on pickup, a machine result hangs up that technician only', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();

  const prompt = await s.tech(0).answered();
  assert.match(prompt.text, /<Gather/, 'brief starts without waiting for detection');
  assert.equal(s.techCalls().length, 1);

  await s.tech(0).amd('machine_start');
  await tick();
  assert.deepEqual(s.outcomes(), ['voicemail', null]);
  assert.deepEqual(s.endedWith(s.tech(0).sid()), ['completed'], 'answered call is ended with completed');
  assert.equal(s.techCalls().length, 2, 'next technician is dialled');
  assert.equal(s.transfer().status, 'searching');
});

test('async AMD: human and unknown results change nothing, and a machine result after pressing 1 is ignored', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).answered();
  await s.tech(0).amd('unknown');
  assert.deepEqual(s.outcomes(), [null, null]);
  assert.deepEqual(s.endedWith(s.tech(0).sid()), []);

  await s.tech(0).press('1');
  await tick();
  await s.tech(0).amd('machine_start');
  await tick();
  assert.deepEqual(s.outcomes(), ['accepted', null]);
  assert.deepEqual(s.endedWith(s.tech(0).sid()), [], 'winner is not hung up');
});

test('prompt repeats 3 times, then the technician is hung up and the next is tried', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();

  const first = await s.tech(0).answered();
  assert.match(first.text, /<Redirect[^>]*>[^<]*attempt=2<\/Redirect>/);
  assert.match((await s.tech(0).answered(2)).text, /<Gather/);
  assert.match((await s.tech(0).answered(3)).text, /attempt=4/);
  const last = await s.tech(0).answered(4);
  assert.doesNotMatch(last.text, /<Gather/);
  assert.match(last.text, /<Hangup\/>/);
  await tick();
  assert.equal(s.techCalls().length, 2);
  assert.equal(s.outcomes()[0], 'declined');
});

test('accepted but dropped before reaching the room: counts as no technician and Iris is told', async (t) => {
  const s = await setup({ techNumbers: ['+15550000001'] });
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).answered();
  await s.tech(0).press('1');
  await tick();
  await s.tech(0).status('completed');
  await tick();

  assert.equal(s.transfer().status, 'failed');
  assert.equal(s.report().result, 'no technician');
  assert.deepEqual(s.announcements(), [], 'nothing is announced to the room');
  assert.deepEqual(s.agentCues.map((c) => new URL(c.announceUrl).searchParams.get('kind')), ['wrapup', 'unavailable'], 'Iris alone is told: joining at press 1, then that nobody is available');
});

// ---------------------------------------------------------------- nobody available

test('all fail: Iris is still in the room, so only she hears "No technician is available" and the resident hears her say it once', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).status('busy');
  await tick();
  await s.tech(1).status('no-answer');
  await tick();

  assert.equal(s.transfer().status, 'failed');
  assert.deepEqual(s.announcements(), [], 'not announced to the room, so the resident does not hear it twice');
  const last = s.agentCues.at(-1);
  assert.equal(new URL(last.announceUrl).searchParams.get('kind'), 'unavailable');
  assert.equal(last.callSid, s.agentLegs[0].callSid, "sent to Iris's leg");
  assert.ok(s.logs.some((line) => line.includes('CUE to Iris only "No technician is available right now."')));
  assert.deepEqual(s.updates.filter((u) => u.sid === RESIDENT), [], 'resident call is not updated');
  assert.equal(s.agentLegs.length, 1, 'no second Iris');
  assert.equal(s.registered.length, 1, 'same ElevenLabs conversation');
  assert.equal(s.roomEnded(), false);

  const report = s.report();
  assert.equal(report.result, 'no technician');
  assert.equal(report.connected_technician, null);
  assert.equal(typeof report.resident_wait_seconds, 'number');
  assert.deepEqual(report.technicians.map((x) => x.outcome), ['busy', 'no-answer']);
  assert.equal(s.logs.filter((line) => line.includes('TRANSFER NO TECHNICIAN')).length, 1);

  // Iris asking again on the same call does not restart the search.
  const retry = await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'again' });
  assert.equal(retry.body.status, 'unavailable');
  assert.equal(s.techCalls().length, 2);
});

test('all fail after Iris dropped: she is brought back with the first-message override', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.avaLeaves();
  assert.equal(s.roomEnded(), false, 'the search is still running, so the resident keeps waiting');

  await s.tech(0).status('busy');
  await tick();
  await s.tech(1).status('no-answer');
  await tick();

  assert.equal(s.agentLegs.length, 2);
  assert.equal(s.agentLegs[1].label, 'iris-2');
  assert.deepEqual(s.announcements(), []);

  await s.avaJoins();
  assert.equal(s.registered.at(-1).firstMessage, FALLBACK_FIRST_MESSAGE);
  assert.equal(s.registered.at(-1).callSid, RESIDENT);
  assert.equal(s.roomEnded(), false);
});

test('all fail, and Twilio refuses the cue to Iris: the error is logged and Twilio says nothing to the room', async (t) => {
  const s = await setup({ techNumbers: ['+15550000001'] });
  t.after(s.close);
  await s.residentAsksForTransfer();
  s.flags.failAgentCue = true;

  await s.tech(0).status('no-answer');
  await tick();
  assert.deepEqual(s.roomActions, ['cue:unavailable'], 'only the cue to Iris was attempted');
  assert.deepEqual(s.announcements(), [], "never announced to the room in Twilio's voice");
  assert.ok(s.logs.some((line) => line.includes('ERROR could not send the cue "No technician is available right now." to Iris') && line.includes('Twilio error 20404')));
});

test('all fail while Iris is still joining: the cue waits and goes to her the moment she is in', async (t) => {
  const s = await setup({ techNumbers: ['+15550000001'] });
  t.after(s.close);
  await s.hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: TWILIO_NUMBER, Direction: 'inbound' });
  await s.room('participant-join', { CallSid: RESIDENT }); // Iris is being added, not in yet
  await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'Leak.' });
  await tick();
  assert.equal(s.state.residentCalls.get(RESIDENT).agent.state, 'joining');

  await s.tech(0).status('no-answer');
  await tick();
  assert.deepEqual(s.agentCues, [], 'no leg to cue yet');
  assert.deepEqual(s.announcements(), [], "and nothing in Twilio's voice meanwhile");

  await s.avaJoins();
  assert.deepEqual(s.agentCues.map((c) => new URL(c.announceUrl).searchParams.get('kind')), ['unavailable']);
  assert.equal(s.agentCues[0].callSid, s.agentLegs[0].callSid);
  assert.deepEqual(s.announcements(), []);
});

// ---------------------------------------------------------------- resident hangs up

test('resident hangs up while waiting (inbound call): the room ending cancels the ringing technician', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.tech(0).status('ringing');

  // No status callback is configured on an inbound number; the conference tells us.
  await s.room('participant-leave', { CallSid: RESIDENT });
  await s.room('conference-end');
  assert.equal(s.transfer().status, 'cancelled');
  assert.deepEqual(s.endedWith(s.tech(0).sid()), ['canceled'], 'ringing call is ended with canceled');
  assert.ok(s.logs.some((line) => line.includes('CANCEL tech#0') && line.includes('resident hung up')));

  // The cancelled technician call ending must not dial the next technician.
  await s.tech(0).status('canceled');
  await tick();
  assert.equal(s.techCalls().length, 1);
  assert.deepEqual(s.announcements(), []);

  const report = s.report();
  assert.equal(report.result, 'resident hung up');
  assert.deepEqual(report.technicians.map((x) => x.outcome), ['canceled', 'not-called']);
  assert.equal(s.logs.filter((line) => line.includes('TRANSFER RESIDENT HUNG UP')).length, 1);

  // A technician who was already listening and presses 1 is told the resident left.
  const late = await s.tech(0).press('1');
  assert.match(late.text, /resident has hung up/);
  assert.doesNotMatch(late.text, /<Conference/);

  // And the tool no longer accepts that call.
  assert.equal((await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'x' })).status, 404);
});

test('resident hangs up while a technician is listening to the brief: that call is ended with completed', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.tech(0).answered();

  await s.hook('/twilio/resident-status', { CallSid: RESIDENT, CallStatus: 'completed' });
  await tick();
  assert.deepEqual(s.endedWith(s.tech(0).sid()), ['completed']);
  assert.equal(s.report().result, 'resident hung up');
});

// ---------------------------------------------------------------- one at a time, with updates

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('one at a time: only one technician call ever exists, in TECH_NUMBERS order', async (t) => {
  const s = await setup({ techNumbers: ['+15550000001', '+15550000002', '+15550000003'] });
  t.after(s.close);
  await s.residentAsksForTransfer();

  assert.deepEqual(s.techCalls().map((c) => c.to), ['+15550000001'], 'only the first is dialled');
  await s.tech(0).status('ringing');
  await tick();
  assert.equal(s.techCalls().length, 1, 'ringing does not dial anyone else');
  await s.tech(0).status('no-answer');
  await tick();
  assert.deepEqual(s.techCalls().map((c) => c.to), ['+15550000001', '+15550000002']);
  await s.tech(1).status('busy');
  await tick();
  assert.deepEqual(s.techCalls().map((c) => c.to), ['+15550000001', '+15550000002', '+15550000003']);
  assert.equal(s.report().dial_mode, 'sequential');
});

test('update: technician 1 does not pick up -> Iris alone hears the cue, the next technician is dialled', async (t) => {
  const s = await setup();
  t.after(s.close);
  const reply = await s.residentAsksForTransfer();
  assert.match(reply.body.message, /If you hear "Technician 1 did not pick up\. Calling technician 2 now\."/, 'the tool reply tells Iris what the cue means');
  assert.match(reply.body.message, /tell them in one short sentence that technician 1 did not pick up and you are now trying the next one/);

  await s.tech(0).status('ringing');
  await s.tech(0).status('no-answer');
  await tick();

  // The cue goes to Iris's leg only, not to the whole room.
  assert.equal(s.agentCues.length, 1);
  const cue = s.agentCues[0];
  assert.equal(cue.conferenceSid, CONFERENCE);
  assert.equal(cue.callSid, s.agentLegs[0].callSid, "it is Iris's leg that hears it");
  assert.equal(cue.announceUrl, `${PUBLIC}/conference/announce?kind=tech-update&tech=0`);
  assert.deepEqual(s.announcements(), [], 'nothing is announced to the room, so the resident does not hear the cue');
  // Hold music is off in this test: nothing to stop, and Iris was never muted.
  assert.deepEqual(s.roomActions, ['cue:tech-update:0']);

  // What Twilio plays to Iris when it fetches the cue.
  const spoken = await s.hook('/conference/announce?kind=tech-update&tech=0', { ConferenceSid: CONFERENCE });
  assert.match(spoken.text, /<Say>Technician 1 did not pick up\. Calling technician 2 now\.<\/Say>/);
  assert.equal(techUpdateLine(0), 'Technician 1 did not pick up. Calling technician 2 now.');
  assert.doesNotMatch(spoken.text, /\+1555/, 'no phone numbers for Iris to read out');

  assert.deepEqual(s.techCalls().map((c) => c.to), ['+15550000001', '+15550000002'], 'the next technician is dialled straight away');
  assert.equal(s.transfer().status, 'searching');

  const report = s.report();
  assert.equal(report.resident_updates.length, 1);
  assert.equal(report.resident_updates[0].technician, 1);
  assert.equal(report.resident_updates[0].number, '+15550000001');
  assert.equal(report.resident_updates[0].cue, 'Technician 1 did not pick up. Calling technician 2 now.');
  assert.equal(typeof report.resident_updates[0].seconds_from_tool_call, 'number');
  assert.ok(s.logs.some((line) => line.includes('CUE to Iris only "Technician 1 did not pick up.')));

  // Technician 2 takes it: the normal join, no further update.
  await s.techAcceptsAndJoins(1);
  assert.equal(s.report().result, 'connected');
  assert.deepEqual(s.agentCues.map((c) => new URL(c.announceUrl).searchParams.get('kind')), ['tech-update', 'wrapup'], 'no further update, just the wrap-up');
});

test('update: every way of not taking the call gets it (busy, voicemail, declined, no key, could not dial); the last one does not', async (t) => {
  const s = await setup({ techNumbers: ['+15550000001', '+15550000002', '+15550000003', '+15550000004', '+15550000005', '+15550000006'] });
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).status('busy');
  await tick();
  await s.tech(1).answered();
  await s.tech(1).amd('machine_start');
  await tick();
  await s.tech(2).answered();
  await s.tech(2).press('2');
  await tick();
  await s.tech(3).answered();
  await s.tech(3).answered(4); // no key after 3 prompts
  await tick();
  await s.tech(4).status('failed');
  await tick();
  await s.tech(5).status('no-answer'); // the last one: "no technician", not an update
  await tick();

  assert.deepEqual(s.outcomes(), ['busy', 'voicemail', 'declined', 'declined', 'failed', 'no-answer']);
  const cues = s.agentCues.map((c) => new URL(c.announceUrl).searchParams);
  assert.deepEqual(cues.filter((q) => q.get('kind') === 'tech-update').map((q) => q.get('tech')), ['0', '1', '2', '3', '4']);
  assert.equal(cues.at(-1).get('kind'), 'unavailable', 'the last one is told "no technician" instead');
  assert.deepEqual(s.announcements(), []);
  assert.deepEqual(s.report().resident_updates.map((u) => u.technician), [1, 2, 3, 4, 5]);
});

test('update: a late status for an earlier technician does not repeat the update or skip anyone', async (t) => {
  const s = await setup({ techNumbers: ['+15550000001', '+15550000002', '+15550000003'] });
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).answered();
  await s.tech(0).press('2');
  await tick();
  await s.tech(0).status('completed'); // the declined call finishing afterwards
  await tick();

  assert.equal(s.agentCues.length, 1);
  assert.equal(s.techCalls().length, 2, 'technician 3 is not dialled');
});

test('update with hold music: music off and Iris unmuted for the update, back on HOLD_MUSIC_RESUME_SEC later', async (t) => {
  const s = await setup({ holdDelayMs: 10, holdResumeMs: 150, techNumbers: ['+15550000001', '+15550000002', '+15550000003'] });
  t.after(s.close);
  const reply = await s.residentAsksForTransfer();
  assert.match(reply.body.message, /the hold music comes back a few seconds later/);
  await tick();
  assert.deepEqual(s.roomActions, ['hold:true', 'mute:true']);

  await s.tech(0).status('no-answer');
  await tick();
  // Cue to Iris first, then she gets her voice back and the music stops, while the cue plays.
  assert.deepEqual(s.roomActions, ['hold:true', 'mute:true', 'cue:tech-update:0', 'mute:false', 'hold:false']);
  assert.equal(s.mutes.at(-1).callSid, s.agentLegs[0].callSid);
  assert.equal(s.holds.at(-1).callSid, RESIDENT);

  await wait(200);
  assert.deepEqual(s.roomActions.slice(5), ['hold:true', 'mute:true'], 'music back and Iris muted again for the next technician');

  // Same again for technician 2.
  await s.tech(1).status('busy');
  await wait(200);
  assert.deepEqual(s.roomActions.slice(7), ['cue:tech-update:1', 'mute:false', 'hold:false', 'hold:true', 'mute:true']);

  const report = s.report();
  assert.equal(report.hold_periods.length, 3);
  assert.equal(report.agent_mute_periods.length, 3);
  assert.ok(report.hold_periods.slice(0, 2).every((p) => p.from && p.to && p.to >= p.from), 'the first two holds were ended by the updates');
  assert.equal(report.hold_periods[2].to, null, 'still on hold for technician 3');
  assert.equal(report.hold_started_at, report.hold_periods[0].from);
  assert.equal(report.hold_ended_at, null);

  // Technician 3 joins: music off, Iris stays muted, room told.
  await s.techAcceptsAndJoins(2);
  assert.deepEqual(s.roomActions.slice(12), ['tech:release', 'hold:false', 'announce:joined']);
  assert.equal(s.report().agent_mute_periods.at(-1).to, null, 'Iris stays muted with the technician on');
});

test('update with hold music: a technician accepting before the music returns stops it from coming back', async (t) => {
  const s = await setup({ holdDelayMs: 10, holdResumeMs: 200 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  await tick();

  await s.tech(0).status('no-answer');
  await tick();
  await s.techAcceptsAndJoins(1); // well within the 200 ms
  await wait(250);

  assert.deepEqual(s.roomActions, ['hold:true', 'mute:true', 'cue:tech-update:0', 'mute:false', 'hold:false', 'cue:wrapup', 'mute:true', 'tech:release', 'announce:joined']);
});

test('update with hold music: an update before the first hold replaces it, so the music cannot cut Iris off', async (t) => {
  // The first hold is due 300 ms after the tool call; the update comes first and asks for 700 ms.
  // Margins are hundreds of ms so a busy machine cannot make this test flaky.
  const s = await setup({ holdDelayMs: 300, holdResumeMs: 700 });
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).status('failed'); // e.g. an unverified number fails at once
  await wait(400); // past the original 300 ms, well before the new 700 ms
  assert.deepEqual(s.roomActions, ['cue:tech-update:0'], 'the original hold did not fire while Iris is speaking');
  await wait(450); // past 700 ms
  assert.deepEqual(s.roomActions, ['cue:tech-update:0', 'hold:true', 'mute:true']);
});

test('update with hold music: the last technician failing straight after an update gives "no technician", and the music stays off', async (t) => {
  const s = await setup({ holdDelayMs: 10, holdResumeMs: 200 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  await tick();

  await s.tech(0).status('busy');
  await tick();
  await s.tech(1).status('no-answer');
  await wait(250); // past the time the music would have come back

  assert.deepEqual(s.roomActions, ['hold:true', 'mute:true', 'cue:tech-update:0', 'mute:false', 'hold:false', 'cue:unavailable']);
  assert.equal(s.report().result, 'no technician');
});

test('update: skipped when Iris is not in the room, and the search carries on', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.avaLeaves();

  await s.tech(0).status('no-answer');
  await tick();
  assert.deepEqual(s.agentCues, []);
  assert.equal(s.techCalls().length, 2);
  assert.ok(s.logs.some((line) => line.includes('UPDATE skipped for tech#0')));
  assert.deepEqual(s.report().resident_updates, []);
});

test('update: no cue after the resident has hung up', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.room('participant-leave', { CallSid: RESIDENT });

  await s.tech(0).status('canceled');
  await tick();
  assert.deepEqual(s.agentCues, []);
  assert.equal(s.techCalls().length, 1);
});

test('cancel: a ringing call picked up while we were cancelling is ended with completed, and Twilio errors are logged', async (t) => {
  // Picked up in the moment we sent "canceled".
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.tech(0).status('ringing');
  s.answeredMeanwhile.add(s.tech(0).sid());
  await s.room('participant-leave', { CallSid: RESIDENT });
  assert.deepEqual(s.endedWith(s.tech(0).sid()), ['canceled', 'completed']);

  // Twilio rejects every update for the call.
  const other = await setup();
  t.after(other.close);
  await other.residentAsksForTransfer();
  await other.tech(0).status('ringing');
  other.failUpdatesFor.add(other.tech(0).sid());
  await other.room('participant-leave', { CallSid: RESIDENT });
  assert.deepEqual(other.endedWith(other.tech(0).sid()), ['canceled', 'completed'], 'falls back to completed after an error');
  const errors = other.logs.filter((line) => line.includes('ERROR cancel tech#0'));
  assert.equal(errors.length, 2);
  assert.ok(errors[0].includes('Twilio error 21220'));
});

test('config: DIAL_MODE=parallel only warns, and HOLD_MUSIC_RESUME_SEC is read and checked', () => {
  const env = {
    TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`,
    TWILIO_AUTH_TOKEN: 'x',
    TWILIO_PHONE_NUMBER: TWILIO_NUMBER,
    ELEVENLABS_API_KEY: 'x',
    ELEVENLABS_AGENT_ID: 'agent_x',
    TECH_NUMBERS: '+15550000001, +15550000002',
    PUBLIC_BASE_URL: PUBLIC,
    TOOL_SECRET: 'x',
    TWILIO_AGENT_APP_SID: APP_SID,
  };
  const plain = loadConfig(env);
  assert.deepEqual(plain.warnings, []);
  assert.equal(plain.holdResumeMs, 13_000, 'default 13 seconds (see decision.md D13)');
  assert.equal(plain.holdDelayMs, null, 'no hold music by default on this branch: Iris troubleshoots instead');
  assert.equal(loadConfig({ ...env, HOLD_MUSIC_DELAY_SEC: '5' }).holdDelayMs, 5_000, 'music can be switched back on');
  assert.equal('dialMode' in plain, false);
  assert.deepEqual(plain.techNumbers, ['+15550000001', '+15550000002']);

  assert.deepEqual(loadConfig({ ...env, DIAL_MODE: 'sequential' }).warnings, []);
  const parallel = loadConfig({ ...env, DIAL_MODE: 'parallel' });
  assert.equal(parallel.warnings.length, 1);
  assert.match(parallel.warnings[0], /DIAL_MODE=parallel is ignored/);

  assert.equal(loadConfig({ ...env, HOLD_MUSIC_RESUME_SEC: '7.5' }).holdResumeMs, 7_500);
  assert.throws(() => loadConfig({ ...env, HOLD_MUSIC_RESUME_SEC: 'soon' }), /HOLD_MUSIC_RESUME_SEC must be a number/);
});

// The report page has one tab panel per view (merged transcript, ElevenLabs transcript,
// Twilio transcripts, ...) and the same lines can appear in more than one. Checks on one
// view look only inside its panel.
function panelOf(html, id) {
  const start = html.indexOf(`<div class="panel" id="panel-${id}">`);
  assert.ok(start >= 0, `the page has a "${id}" panel`);
  const end = html.indexOf('<div class="panel" id="panel-', start + 1);
  return html.slice(start, end < 0 ? undefined : end);
}

test('transcript: with several mute periods, only Iris lines inside a period are marked "muted, not heard"', () => {
  const { renderDetail } = require('../src/reports');
  const at = (s) => new Date(Date.UTC(2026, 10, 25, 10, 0, s)).toISOString();
  // Tool call at 10:00:00, which ElevenLabs logs at 30s into the conversation (conversation start 09:59:30).
  const report = {
    resident_call_sid: RESIDENT,
    resident_number: RESIDENT_NUMBER,
    started_at: at(0),
    finished_at: at(60),
    result: 'connected',
    connected_technician: '+15550000002',
    transfer_style: 'agent stays on the call',
    technicians: [{ number: '+15550000001', outcome: 'no-answer' }, { number: '+15550000002', outcome: 'accepted' }],
    hold_periods: [{ from: at(5), to: at(25) }, { from: at(35), to: at(60) }],
    agent_mute_periods: [{ from: at(5), to: at(25) }, { from: at(35), to: null }],
    resident_updates: [{ technician: 1, number: '+15550000001', cue: techUpdateLine(0), at: at(25), seconds_from_tool_call: 25 }],
    transcript: {
      status: 'final',
      conversations: [{
        conversation_id: 'c1',
        status: 'done',
        started_at: new Date(Date.parse(at(0)) - 30_000).toISOString(),
        entries: [
          { role: 'tool', text: 'called request_transfer', seconds: 30 },
          { role: 'agent', text: 'Please hold while I find a technician.', seconds: 32 },
          { role: 'agent', text: 'Still looking, hang on.', seconds: 45 },
          { role: 'user', text: 'Technician 1 did not pick up. Calling technician 2 now.', seconds: 55.5 },
          { role: 'agent', text: 'Technician 1 did not pick up, I am trying the next one now.', seconds: 57 },
          { role: 'agent', text: 'Kofi, the resident is in unit 4B.', seconds: 70 },
        ],
      }],
    },
  };
  const page = renderDetail(report);
  const el = panelOf(page, 'elevenlabs');
  const label = (text) => el.match(new RegExp(`<td>([^<]+)</td><td class="text">${text.replace(/[.,]/g, '\\$&')}`))[1];
  assert.equal(label('Please hold while I find a technician.'), 'Iris', 'before the first hold');
  assert.equal(label('Still looking, hang on.'), 'Iris (muted, not heard)', 'during the first hold');
  assert.equal(label('Technician 1 did not pick up, I am trying the next one now.'), 'Iris', 'the update itself was heard');
  assert.equal(label('Kofi, the resident is in unit 4B.'), 'Iris (muted, not heard)', 'during the second mute');
  assert.ok(page.includes('Technician 1 (+15550000001) did not take the call: Iris cued to tell the resident'));
  // Both hold periods, once each, in the ElevenLabs view and in the merged view.
  assert.equal((el.match(/Resident put on hold with music/g) || []).length, 2);
  assert.equal((panelOf(page, 'merged').match(/Resident put on hold with music/g) || []).length, 2);
  assert.match(page, /<th>Resident told<\/th>/);
});

// ---------------------------------------------------------------- reports and security

test('reports: HTML list and detail, local browser only', async (t) => {
  const s = await setup();
  t.after(s.close);

  assert.match((await s.get('/reports')).text, /No transfers yet/);

  await s.residentAsksForTransfer();
  await s.techAcceptsAndJoins(0);

  const list = await s.get('/reports');
  assert.equal(list.status, 200);
  assert.match(list.text, /<table>/);
  assert.ok(list.text.includes(RESIDENT_NUMBER));
  assert.ok(list.text.includes('connected to +15550000001'));
  assert.ok(list.text.includes(`/reports/${RESIDENT}`));

  const detail = await s.get(`/reports/${RESIDENT}`);
  assert.equal(detail.status, 200);
  assert.ok(detail.text.includes('Leak under the kitchen sink in unit 4B.'));
  assert.ok(detail.text.includes('accepted'));
  assert.ok(detail.text.includes('agent stays on the call'));

  assert.equal(JSON.parse((await s.get(`/reports/${RESIDENT}?format=json`)).text).result, 'connected');
  assert.equal((await s.get(`/reports/CA${'f'.repeat(32)}`)).status, 404);
  assert.equal((await s.get('/reports/..%2F.env')).status, 404);

  // A request that came through the tunnel carries forwarding headers and is refused.
  assert.equal((await s.get('/reports', { 'X-Forwarded-For': '203.0.113.9' })).status, 403);
  assert.equal((await s.get(`/reports/${RESIDENT}`, { 'X-Forwarded-Host': 'x.ngrok-free.dev' })).status, 403);
});

test('reports: summary text is HTML-escaped', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentIsWithAva();
  await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: '<script>alert(1)</script> & more' });
  await tick();

  const detail = await s.get(`/reports/${RESIDENT}`);
  assert.ok(!detail.text.includes('<script>alert(1)</script>'));
  assert.ok(detail.text.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; more'));
});

// ---------------------------------------------------------------- transcripts

// An ElevenLabs conversation that began about 30 seconds before the tool call.
// clockSkewSeconds simulates ElevenLabs' clock running ahead of the server's.
function conversationFor(report, { status = 'done', turns, clockSkewSeconds = 0 } = {}) {
  const start = Math.floor(Date.parse(report.started_at) / 1000) - 30 + clockSkewSeconds;
  return {
    conversation_id: 'conv_test1',
    status,
    metadata: { start_time_unix_secs: start, call_duration_secs: 60 },
    analysis: { transcript_summary: 'Resident reported a leak and was connected to a technician.' },
    conversation_initiation_client_data: { dynamic_variables: { call_sid: RESIDENT } },
    transcript: turns || [
      { role: 'agent', time_in_call_secs: 2, message: 'Hello, this is Iris. How can I help?' },
      { role: 'user', time_in_call_secs: 10, message: 'My kitchen sink is leaking.' },
      { role: 'agent', time_in_call_secs: 27, message: 'Let me find a technician for you.', tool_calls: [{ tool_name: 'request_transfer' }] },
      { role: 'user', time_in_call_secs: 45, message: 'Hi, this is Kofi from maintenance.', interrupted: true },
      { role: 'agent', time_in_call_secs: 50, message: 'Kofi, I have Kennedy from unit 4B on the line.' },
    ],
  };
}

test('transcript: fetched from ElevenLabs after the call and shown on the report with speakers and key moments', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.techAcceptsAndJoins(0);
  assert.equal(s.report().transcript, null, 'nothing is fetched while the call is running');

  s.elevenLabs.details = [conversationFor(s.report())];
  await s.room('participant-leave', { CallSid: RESIDENT });
  await s.room('conference-end');
  await tick();

  assert.deepEqual(s.elevenLabs.lookups.map((l) => l.callSid), [RESIDENT], 'looked up by the resident call SID');
  const transcript = s.report().transcript;
  assert.equal(transcript.status, 'final');
  assert.equal(transcript.conversations[0].conversation_id, 'conv_test1');
  assert.equal(transcript.conversations[0].entries.length, 6, '5 spoken lines and 1 tool call');
  assert.ok(s.logs.some((line) => line.includes('TRANSCRIPT') && line.includes('final')));

  const page = (await s.get(`/reports/${RESIDENT}`)).text;
  assert.ok(page.includes('ElevenLabs summary:</strong> Resident reported a leak'));
  const detail = panelOf(page, 'elevenlabs');
  assert.ok(detail.includes('<h2>ElevenLabs transcript</h2>'));
  const order = [
    'My kitchen sink is leaking.',
    'called request_transfer',
    'Iris asked for a technician (request_transfer)',
    'Technician +15550000001 joined the call',
    'Iris muted: she keeps listening but nobody hears her',
    'Hi, this is Kofi from maintenance.',
    'Kofi, I have Kennedy from unit 4B on the line.',
  ].map((text) => detail.indexOf(text));
  assert.ok(order.every((index) => index > 0), 'every line and marker is on the page');
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'lines and key moments are in time order');

  // Before the technician joins the caller side is the resident; afterwards it could be either person.
  assert.match(detail, /<td>Resident<\/td><td class="text">My kitchen sink is leaking\.<\/td>/);
  assert.match(detail, /<td>Resident or technician<\/td><td class="text">Hi, this is Kofi from maintenance\. <em>\(interrupted\)<\/em><\/td>/);
  assert.match(detail, /<td>Iris<\/td><td class="text">Hello, this is Iris\. How can I help\?<\/td>/);
  // Whatever the model produced after she was muted was never heard on the call.
  assert.match(detail, /<tr class="agent unheard"><td>[^<]*<\/td><td>Iris \(muted, not heard\)<\/td><td class="text">Kofi, I have Kennedy from unit 4B on the line\.<\/td>/);

  assert.ok((await s.get('/reports')).text.includes('5 lines'));
  assert.equal(s.elevenLabs.lookups.length, 1, 'a final transcript is not fetched again');
});

test('transcript: speakers and key moments still line up when the ElevenLabs clock is over a minute off', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.techAcceptsAndJoins(0);

  // Seen on a real call: ElevenLabs reported the conversation starting 73 seconds "late".
  s.elevenLabs.details = [conversationFor(s.report(), { clockSkewSeconds: 73 })];
  const detail = panelOf((await s.get(`/reports/${RESIDENT}`)).text, 'elevenlabs');

  const order = [
    'My kitchen sink is leaking.',
    'called request_transfer',
    'Iris asked for a technician (request_transfer)',
    'Technician +15550000001 joined the call',
    'Hi, this is Kofi from maintenance.',
  ].map((text) => detail.indexOf(text));
  assert.ok(order.every((index) => index > 0));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'placed by seconds into the conversation, not by the skewed clock');

  assert.match(detail, /<td>Resident<\/td><td class="text">My kitchen sink is leaking\.<\/td>/);
  assert.match(detail, /<td>Iris<\/td><td class="text">Hello, this is Iris\. How can I help\?<\/td>/, 'her greeting was heard');
  assert.match(detail, /<td>Resident or technician<\/td><td class="text">Hi, this is Kofi from maintenance\./);
  assert.match(detail, /<td>Iris \(muted, not heard\)<\/td><td class="text">Kofi, I have Kennedy from unit 4B on the line\.<\/td>/);
});

test('transcript: opening the report during the call shows what there is so far and refreshes on reload', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();

  s.elevenLabs.details = [conversationFor(s.report(), {
    status: 'in-progress',
    turns: [{ role: 'agent', time_in_call_secs: 2, message: 'Hello, this is Iris.' }],
  })];
  const during = (await s.get(`/reports/${RESIDENT}`)).text;
  assert.ok(during.includes('Hello, this is Iris.'));
  assert.ok(during.includes('still in progress'));
  assert.equal(s.report().transcript.status, 'partial');

  s.elevenLabs.details = [conversationFor(s.report())];
  const after = (await s.get(`/reports/${RESIDENT}`)).text;
  assert.ok(after.includes('My kitchen sink is leaking.'));
  assert.ok(!after.includes('still in progress'));
  assert.equal(s.elevenLabs.lookups.length, 2);
});

test('transcript: nothing found yet, and an ElevenLabs error, are both explained on the page', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();

  assert.ok((await s.get(`/reports/${RESIDENT}`)).text.includes('ElevenLabs has no conversation for this call yet'));
  assert.equal(s.report().transcript.status, 'pending');

  s.elevenLabs.details = [conversationFor(s.report(), { status: 'in-progress' })];
  await s.get(`/reports/${RESIDENT}`);
  s.flags.failConversations = true;
  const failed = (await s.get(`/reports/${RESIDENT}`)).text;
  assert.ok(failed.includes('Could not fetch the transcript from ElevenLabs: ElevenLabs HTTP 500'));
  assert.ok(failed.includes('My kitchen sink is leaking.'), 'lines fetched earlier are kept');
  assert.equal(s.report().transcript.status, 'unavailable');
});

test('transcript: still fetched for an old report after the server has restarted, and text is HTML-escaped', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.techAcceptsAndJoins(0);
  const saved = s.report();

  // A fresh server with the same reports folder and no memory of the call.
  const details = [conversationFor(saved, { turns: [{ role: 'user', time_in_call_secs: 5, message: '<b>water</b> & more' }] })];
  const restarted = createApp({ config: s.config, client: {}, registerCall: async () => '', conversations: { forCall: async () => details }, logger: () => {} });
  const server = await new Promise((resolve) => {
    const listening = restarted.app.listen(0, () => resolve(listening));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const page = await (await fetch(`http://localhost:${server.address().port}/reports/${RESIDENT}`)).text();
  assert.ok(page.includes('&lt;b&gt;water&lt;/b&gt; &amp; more'));
  assert.ok(!page.includes('<b>water</b>'));

  const onDisk = s.report();
  assert.equal(onDisk.transcript.status, 'final');
  assert.equal(onDisk.result, 'connected', 'the rest of the saved report is untouched');
  assert.equal(onDisk.connected_technician, saved.connected_technician);
});

test('security: bad Twilio signature is 403, tool endpoint needs X-Tool-Secret and not a Twilio signature', async (t) => {
  const s = await setup();
  t.after(s.close);

  const forged = await s.hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: TWILIO_NUMBER }, { signature: FORGED });
  assert.equal(forged.status, 403);
  assert.equal(s.state.residentCalls.size, 0);

  for (const urlPath of ['/twilio/agent-leg', `/tech/amd?resident=${RESIDENT}&tech=0`, `/conference/status?resident=${RESIDENT}`]) {
    assert.equal((await s.hook(urlPath, { CallSid: RESIDENT }, { signature: FORGED })).status, 403, urlPath);
  }
  assert.equal(s.registered.length, 0);

  assert.equal((await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'x' }, null)).status, 401);
  assert.equal((await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'x' }, 'wrong-secret')).status, 401);
  assert.equal((await s.json('/tool/request-transfer', { call_sid: 'nope', summary: 'x' })).status, 400);
  // A tool that sends the SID as parent_call_sid is understood too (404 = well-formed, unknown call).
  assert.equal((await s.json('/tool/request-transfer', { parent_call_sid: RESIDENT, summary: 'x' })).status, 404);
  assert.equal((await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'x' })).status, 404, 'unknown call');
});

test('transcript: the server\'s own lines are not labelled "Resident" (cue to Iris only, Twilio room announcement)', () => {
  const { renderDetail } = require('../src/reports');
  const at = (s) => new Date(Date.UTC(2026, 10, 25, 11, 15, s)).toISOString();
  // The lines below are copied from a real call's transcript (2026-11-25, call CA0c45…4d71).
  const report = {
    resident_call_sid: RESIDENT,
    resident_number: RESIDENT_NUMBER,
    started_at: at(0),
    finished_at: at(45),
    result: 'connected',
    connected_technician: '+15550000002',
    transfer_style: 'agent stays on the call',
    technicians: [{ number: '+15550000001', outcome: 'no-answer' }, { number: '+15550000002', outcome: 'accepted' }],
    transcript: {
      status: 'final',
      conversations: [{
        conversation_id: 'c1',
        status: 'done',
        started_at: new Date(Date.parse(at(0)) - 20_000).toISOString(),
        entries: [
          { role: 'tool', text: 'called request_transfer', seconds: 20 },
          { role: 'user', text: 'Technician one did not pick up. Calling technician two now.', seconds: 44 },
          { role: 'agent', text: "Sorry, technician one didn't pick up. I'm trying the next one now, please hold.", seconds: 49 },
          { role: 'user', text: 'Hello? A technician has joined the call.', seconds: 66 },
          { role: 'user', text: 'No technician is available right now.', seconds: 70 },
          { role: 'user', text: 'My bathroom sink is broken.', seconds: 10 },
        ],
      }],
    },
  };
  const page = renderDetail(report);
  const row = (text) => page.match(new RegExp(`<tr class="([^"]+)"><td>[^<]*</td><td>([^<]+)</td><td class="text">${text.replace(/[.?']/g, (c) => (c === "'" ? '&#39;' : `\\${c}`))}`));

  const cue = row('Technician one did not pick up. Calling technician two now.');
  assert.deepEqual([cue[1], cue[2]], ['cue', 'Cue to Iris only (resident did not hear it)']);
  const merged = row('Hello? A technician has joined the call.');
  assert.deepEqual([merged[1], merged[2]], ['announcement', 'Room announcement (Twilio), plus the caller'], '"Hello?" was the caller, the rest was Twilio');
  assert.equal(row('No technician is available right now.')[2], 'Cue to Iris only (resident did not hear it)');
  assert.equal(row('My bathroom sink is broken.')[2], 'Resident', 'ordinary caller lines are unchanged');
  assert.equal(row('Sorry, technician one didn&#39;t pick up. I&#39;m trying the next one now, please hold.')[2], 'Iris');
  assert.ok(page.includes('"Cue to Iris only" lines were played to Iris alone'));
});

// ---------------------------------------------------------------- call sequence (one-at-a-time proof)

test('call sequence: a real search is recorded as one at a time, with the gap before each next call and when each line closed', async (t) => {
  const s = await setup({ techNumbers: ['+15550000001', '+15550000002', '+15550000003'] });
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).status('ringing');
  await s.tech(0).status('no-answer'); // Twilio: line closed and outcome in one go
  await tick();
  await s.tech(1).answered();
  await s.tech(1).amd('machine_start'); // voicemail: outcome now, line hung up by the server
  await tick();
  await s.tech(1).status('completed'); // ...and Twilio reports that line closed afterwards
  await s.techAcceptsAndJoins(2);

  const seq = s.report().sequence;
  assert.equal(seq.one_at_a_time, true);
  assert.equal(seq.technicians_dialled, 3);
  assert.equal(seq.max_offered_the_call_at_once, 1);
  assert.equal(seq.each_dialled_after_previous_outcome, true);
  assert.deepEqual(seq.steps.map((x) => x.technician), [1, 2, 3]);
  assert.equal(seq.steps[0].dialled_ms_after_previous_outcome, null, 'the first has no previous');
  for (const step of seq.steps.slice(1)) {
    assert.equal(typeof step.dialled_ms_after_previous_outcome, 'number');
    assert.ok(step.dialled_ms_after_previous_outcome >= 0, 'dialled only after the previous outcome');
  }
  const techs = s.report().technicians;
  assert.ok(techs[0].line_closed_at && techs[1].line_closed_at, 'line-closed times come from Twilio status callbacks');
  assert.equal(techs[2].line_closed_at, null, 'the winner is still on the call');
  assert.equal(s.logs.filter((line) => line.includes(' SEQUENCE tech#')).length, 2, 'one SEQUENCE log line per next call');
  assert.ok(s.logs.some((line) => /SEQUENCE tech#1 \+15550000002 dialled \d+ ms after tech#0's outcome \(no-answer\)/.test(line)));

  const page = (await s.get(`/reports/${RESIDENT}`)).text;
  assert.ok(page.includes('<h2>Call sequence</h2>'));
  assert.ok(page.includes('One at a time: yes. 3 technicians dialled, never more than 1 being offered the call at the same moment'));
  assert.equal((page.match(/<div class="lane">/g) || []).length, 3, 'one timeline lane per technician');
  assert.ok((await s.get('/reports')).text.includes('one at a time</span> (3)'));
});

test('call sequence: parallel-style overlap is flagged, and a line still closing is reported but is not overlap', () => {
  const { sequenceOf, renderDetail } = require('../src/reports');
  const at = (sec) => new Date(Date.UTC(2026, 10, 25, 12, 0, 0) + sec * 1000).toISOString();

  // Two technicians ringing at the same time, as parallel dialling would do.
  const parallel = sequenceOf([
    { number: '+15550000001', outcome: 'canceled', dialled_at: at(0), outcome_at: at(9) },
    { number: '+15550000002', outcome: 'accepted', dialled_at: at(0.2), outcome_at: at(8) },
  ]);
  assert.equal(parallel.one_at_a_time, false);
  assert.equal(parallel.max_offered_the_call_at_once, 2);
  assert.equal(parallel.each_dialled_after_previous_outcome, false);
  const page = renderDetail({ resident_call_sid: RESIDENT, dial_mode: 'parallel', technicians: [
    { number: '+15550000001', outcome: 'canceled', dialled_at: at(0), outcome_at: at(9) },
    { number: '+15550000002', outcome: 'accepted', dialled_at: at(0.2), outcome_at: at(8) },
  ] });
  assert.ok(page.includes('One at a time: NO. Up to 2 technicians were being offered the call at the same moment'));

  // One at a time, but technician 1's line took 400 ms to close after technician 2 was dialled.
  const sequential = sequenceOf([
    { number: '+15550000001', outcome: 'voicemail', dialled_at: at(0), outcome_at: at(12), line_closed_at: at(12.4) },
    { number: '+15550000002', outcome: 'no-answer', dialled_at: at(12.003), outcome_at: at(32), line_closed_at: at(32) },
    { number: '+15550000003', outcome: 'not-called' },
  ]);
  assert.equal(sequential.one_at_a_time, true);
  assert.equal(sequential.max_offered_the_call_at_once, 1);
  assert.equal(sequential.max_phone_lines_open_at_once, 2, 'the closing line is counted honestly');
  assert.equal(sequential.steps[1].dialled_ms_after_previous_outcome, 3);
  assert.equal(sequential.steps[1].previous_line_still_closing_ms, 397);
  assert.equal(sequential.technicians_dialled, 2, 'a technician never dialled is not part of the sequence');

  // Back-to-back (next dialled at the exact moment of the outcome) is not overlap.
  assert.equal(sequenceOf([
    { outcome: 'busy', dialled_at: at(0), outcome_at: at(5) },
    { outcome: 'busy', dialled_at: at(5), outcome_at: at(9) },
  ]).max_offered_the_call_at_once, 1);
});

// ---------------------------------------------------------------- take_message tool

test('take_message: after "no technician" the message is saved into the report, logged, and shown on both pages', async (t) => {
  const s = await setup({ techNumbers: ['+15550000001'] });
  t.after(s.close);
  const reply = await s.residentAsksForTransfer();
  assert.match(reply.body.message, /call the take_message tool/, 'the tool reply tells Iris about take_message');
  await s.tech(0).status('no-answer');
  await tick();
  assert.equal(s.report().result, 'no technician');

  const saved = await s.json('/tool/take-message', { call_sid: RESIDENT, message: '  Please call me back about   my booking. ' });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.status, 'saved');
  assert.match(saved.body.message, /saved for the maintenance team/);
  await s.json('/tool/take-message', { call_sid: RESIDENT, message: 'Unit 4B <after 5pm> & weekends' });

  const report = s.report();
  assert.deepEqual(report.messages.map((m) => m.text), ['Please call me back about my booking.', 'Unit 4B <after 5pm> & weekends'], 'trimmed, whitespace collapsed, both kept in order');
  assert.ok(report.messages.every((m) => m.at && typeof m.seconds_from_tool_call === 'number'));
  assert.equal(report.result, 'no technician', 'the rest of the report is unchanged');
  assert.ok(s.logs.some((line) => line.includes('MESSAGE resident=+15551110000') && line.includes('(#1): "Please call me back about my booking."')));

  const detail = (await s.get(`/reports/${RESIDENT}`)).text;
  assert.ok(detail.includes('<strong>Please call me back about my booking.</strong>'));
  assert.ok(detail.includes('Unit 4B &lt;after 5pm&gt; &amp; weekends'), 'HTML-escaped');
  assert.ok(!detail.includes('<after 5pm>'));
  const list = (await s.get('/reports')).text;
  assert.ok(list.includes('<th>Message</th>'));
  assert.ok(list.includes('Please call me back about my booking. / Unit 4B &lt;after 5pm&gt; &amp; weekends'));
});

test('take_message: needs the tool secret, a real call_sid, a known call and a non-empty message', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();

  assert.equal((await s.json('/tool/take-message', { call_sid: RESIDENT, message: 'hi' }, null)).status, 401);
  assert.equal((await s.json('/tool/take-message', { call_sid: RESIDENT, message: 'hi' }, 'wrong-secret')).status, 401);
  assert.equal((await s.json('/tool/take-message', { call_sid: 'nope', message: 'hi' })).status, 400);
  const empty = await s.json('/tool/take-message', { call_sid: RESIDENT, message: '   ' });
  assert.equal(empty.status, 400);
  assert.match(empty.body.message, /message is empty/);
  assert.equal((await s.json('/tool/take-message', { call_sid: `CA${'f'.repeat(32)}`, message: 'hi' })).status, 404);
  assert.deepEqual(s.report().messages, [], 'nothing saved by a rejected request');
  // parent_call_sid is accepted too, like request_transfer
  assert.equal((await s.json('/tool/take-message', { parent_call_sid: RESIDENT, message: 'via parent' })).status, 200);
  assert.deepEqual(s.report().messages.map((m) => m.text), ['via parent']);
  // very long messages are cut to 1000 characters
  await s.json('/tool/take-message', { call_sid: RESIDENT, message: 'x'.repeat(1500) });
  assert.equal(s.report().messages.at(-1).text.length, 1000);
});

test('take_message: a message on a call with no transfer is accepted and logged (there is no report to hold it)', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentIsWithAva();

  const saved = await s.json('/tool/take-message', { call_sid: RESIDENT, message: 'Just letting you know the lift is noisy.' });
  assert.equal(saved.status, 200);
  assert.equal(s.state.transfers.size, 0, 'no transfer and no report are created');
  assert.ok(s.logs.some((line) => line.includes('MESSAGE call=') && line.includes('no transfer on this call, kept in this log only') && line.includes('lift is noisy')));
});

// ---------------------------------------------------------------- Iris troubleshoots while searching

test('troubleshooting branch: no hold music, Iris is told to troubleshoot safely, updates are woven in, and she is muted when the technician joins', async (t) => {
  const s = await setup({ holdDelayMs: null }); // the default on this branch
  t.after(s.close);
  const reply = await s.residentAsksForTransfer();
  const msg = reply.body.message;
  assert.match(msg, /help the resident troubleshoot the problem/);
  assert.match(msg, /Never suggest electrical, gas or structural work/);
  assert.match(msg, /gas smell, sparks, smoke, flooding\) tell them to get to safety and call emergency services/);
  assert.match(msg, /then carry on troubleshooting with them while the next technician is called/);
  assert.doesNotMatch(msg, /Hold music starts/);

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(s.holds, [], 'the resident is never put on hold');
  assert.deepEqual(s.mutes, [], 'Iris is not muted during the search');

  await s.tech(0).status('no-answer');
  await tick();
  assert.deepEqual(s.roomActions, ['cue:tech-update:0'], 'the update is only a cue to Iris; nothing to undo');

  await s.techAcceptsAndJoins(1);
  assert.deepEqual(s.roomActions, ['cue:tech-update:0', 'cue:wrapup', 'mute:true', 'tech:release', 'announce:joined'], 'Iris is muted the moment the technician is in the room');
  assert.equal(s.state.residentCalls.get(RESIDENT).agent.muted, true);
  assert.deepEqual(s.report().hold_periods, []);
});

// ---------------------------------------------------------------- cues wait for a pause (D23)

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cueKinds = (s) => s.agentCues.map((c) => new URL(c.announceUrl).searchParams.get('kind'));

test('cue pause: a technician update waits while the resident is talking, then plays after a short pause', async (t) => {
  // Margins of hundreds of ms: s.room() itself waits ~25 ms, so a tight gap made this flaky.
  const s = await setup({ techNumbers: ['+15550000001', '+15550000002', '+15550000003'], cueQuietGapMs: 400, cueMaxWaitMs: 5000 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.room('participant-speech-start', { CallSid: RESIDENT }); // resident is describing the smoke

  await s.tech(0).status('failed');
  await pause(120);
  assert.deepEqual(s.agentCues, [], 'not played over the resident');
  assert.equal(s.techCalls().length, 2, 'the next technician is still dialled at once');
  assert.ok(s.logs.some((line) => line.includes('CUE waiting for a pause before "Technician 1 did not pick up.')));

  await s.room('participant-speech-stop', { CallSid: RESIDENT });
  await pause(100);
  assert.deepEqual(s.agentCues, [], 'waits for the quiet gap, not just the end of a word');
  await pause(500);
  assert.deepEqual(cueKinds(s), ['tech-update'], 'played once the room has been quiet');
  assert.ok(s.logs.some((line) => /CUE ready after \d+\.\ds \(pause\): "Technician 1 did not pick up/.test(line)));
  const update = s.report().resident_updates[0];
  assert.ok(update.cued_at && update.waited_for_pause_seconds >= 0.1, 'the report records when it was played and how long it waited');
});

test('cue pause: a cue never cuts Iris off; it waits until she stops talking', async (t) => {
  const s = await setup({ techNumbers: ['+15550000001', '+15550000002', '+15550000003'], cueQuietGapMs: 40, cueMaxWaitMs: 2000 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  const iris = s.agentLegs[0].callSid;
  await s.room('participant-speech-start', { CallSid: iris }); // Iris is giving safety advice

  await s.tech(0).status('no-answer');
  await pause(100);
  assert.deepEqual(s.agentCues, [], 'not played while Iris is speaking');

  await s.room('participant-speech-start', { CallSid: RESIDENT }); // resident answers straight after
  await s.room('participant-speech-stop', { CallSid: iris });
  await pause(100);
  assert.deepEqual(s.agentCues, [], 'still waiting: the resident is talking now');

  await s.room('participant-speech-stop', { CallSid: RESIDENT });
  await pause(100);
  assert.deepEqual(cueKinds(s), ['tech-update']);
});

test('cue pause: if the talking never stops, the cue plays after the maximum wait', async (t) => {
  const s = await setup({ techNumbers: ['+15550000001', '+15550000002', '+15550000003'], cueQuietGapMs: 40, cueMaxWaitMs: 150 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.room('participant-speech-start', { CallSid: RESIDENT });

  await s.tech(0).status('busy');
  await pause(60);
  assert.deepEqual(s.agentCues, []);
  await pause(160);
  assert.deepEqual(cueKinds(s), ['tech-update'], 'sent anyway so the update is not lost');
  assert.ok(s.logs.some((line) => line.includes('(waited the maximum time)')));
});

test('cue pause: an update still waiting when a technician joins is dropped, never announced', async (t) => {
  const s = await setup({ techNumbers: ['+15550000001', '+15550000002', '+15550000003'], cueQuietGapMs: 40, cueMaxWaitMs: 5000 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.room('participant-speech-start', { CallSid: RESIDENT });
  await s.tech(0).status('no-answer');
  await s.techAcceptsAndJoins(1); // technician 2 accepts while the resident is still talking
  await s.room('participant-speech-stop', { CallSid: RESIDENT });
  await pause(100);
  assert.deepEqual(s.agentCues.map((c) => new URL(c.announceUrl).searchParams.get('kind')), ['wrapup'], '"technician 1 did not pick up" would be out of date; only the wrap-up');
  assert.ok(s.logs.some((line) => line.includes('CUE dropped 1 waiting cue(s) (technician joined)')));
  assert.deepEqual(s.roomActions, ['tech:hold', 'cue:wrapup', 'mute:true', 'tech:release', 'announce:joined'], 'the resident was talking: the wrap-up waited for the pause, the technician on hold meanwhile');
});

test('cue pause: "no technician" waits for a pause too, replaces a waiting update, and talking events stay out of the log', async (t) => {
  const s = await setup({ cueQuietGapMs: 40, cueMaxWaitMs: 5000 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.room('participant-speech-start', { CallSid: RESIDENT });
  await s.tech(0).status('no-answer'); // update waits
  await s.tech(1).status('no-answer'); // the last one: the waiting update is now out of date
  await pause(80);
  assert.deepEqual(s.agentCues, []);
  await s.room('participant-speech-stop', { CallSid: RESIDENT });
  await pause(100);
  assert.deepEqual(cueKinds(s), ['unavailable'], 'only "No technician is available"');
  assert.equal(s.logs.filter((line) => line.includes('participant-speech')).length, 0, 'talking events are not logged as webhooks');
});

test('cue pause: each talking start/stop is logged as one SPEECH line naming who', async (t) => {
  const s = await setup({ cueQuietGapMs: 40, cueMaxWaitMs: 5000 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  const iris = s.agentLegs[0].callSid;
  await s.room('participant-speech-start', { CallSid: RESIDENT });
  await s.tech(0).status('no-answer'); // an update now waits
  await s.room('participant-speech-start', { CallSid: iris });
  await s.room('participant-speech-stop', { CallSid: RESIDENT });
  const lines = s.logs.filter((line) => line.includes(' SPEECH '));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /SPEECH resident started talking \(talking now: resident\)$/);
  assert.match(lines[1], /SPEECH Iris started talking \(talking now: resident, Iris\) \[1 cue\(s\) waiting\]$/);
  assert.match(lines[2], /SPEECH resident stopped talking \(talking now: Iris\) \[1 cue\(s\) waiting\]$/);
});

// ---------------------------------------------------------------- troubleshooting progress in the technician brief (D24)

test('brief: the technician hears the summary plus the latest troubleshooting progress Iris reported', async (t) => {
  const s = await setup();
  t.after(s.close);
  const reply = await s.residentAsksForTransfer();
  assert.match(reply.body.message, /call the update_transfer tool with one short sentence summarising the progress so far/);

  // Before any progress: the summary alone.
  const early = await s.json('/tool/update-transfer', { call_sid: RESIDENT, progress: '  Water is under the sink;   resident turned the valve off ' });
  assert.equal(early.status, 200);
  assert.equal(early.body.status, 'noted');
  await s.json('/tool/update-transfer', { call_sid: RESIDENT, progress: 'Valve is off and the leak has slowed to a drip' });

  const prompt = await s.tech(0).answered();
  assert.match(prompt.text, /Leak under the kitchen sink in unit 4B\. Progress so far: Valve is off and the leak has slowed to a drip\. Press 1 to connect to the resident\./, 'latest progress only, with full stops added');
  assert.ok(s.logs.some((line) => line.includes('BRIEF tech#0') && line.includes('Progress so far: Valve is off')));
  assert.ok(s.logs.some((line) => line.includes('PROGRESS resident=') && line.includes('Water is under the sink; resident turned the valve off')));

  const report = s.report();
  assert.deepEqual(report.progress_updates.map((p) => p.text), ['Water is under the sink; resident turned the valve off', 'Valve is off and the leak has slowed to a drip']);
  assert.ok(report.progress_updates.every((p) => p.in_brief));
  assert.equal(report.technicians[0].briefing, 'Leak under the kitchen sink in unit 4B. Progress so far: Valve is off and the leak has slowed to a drip.');
  const page = (await s.get(`/reports/${RESIDENT}`)).text;
  assert.ok(page.includes('<th>Troubleshooting progress</th>'));
  assert.ok(page.includes('<th>Technician heard</th>'));
});

test('brief: progress sent after the first technician answered reaches the next technician', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  const first = await s.tech(0).answered();
  assert.doesNotMatch(first.text, /Progress so far/, 'nothing reported yet');
  await s.json('/tool/update-transfer', { call_sid: RESIDENT, progress: 'Resident found the main valve and closed it' });
  await s.tech(0).press('2');
  await tick();
  const second = await s.tech(1).answered();
  assert.match(second.text, /Progress so far: Resident found the main valve and closed it\./);
  const repeat = await s.tech(1).answered(2);
  assert.match(repeat.text, /Progress so far: Resident found the main valve and closed it\./, 'repeated prompts carry it too');
});

test('update_transfer: needs the secret, a real call_sid, a running search and non-empty progress; after the search it is kept but not briefed', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentIsWithAva();
  assert.equal((await s.json('/tool/update-transfer', { call_sid: RESIDENT, progress: 'x' }, null)).status, 401);
  assert.equal((await s.json('/tool/update-transfer', { call_sid: 'nope', progress: 'x' })).status, 400);
  const before = await s.json('/tool/update-transfer', { call_sid: RESIDENT, progress: 'x' });
  assert.equal(before.status, 404, 'no search yet');
  assert.match(before.body.message, /Call request_transfer first/);

  await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'Leak.' });
  await tick();
  assert.equal((await s.json('/tool/update-transfer', { call_sid: RESIDENT, progress: '   ' })).status, 400);
  await s.techAcceptsAndJoins(0);
  const late = await s.json('/tool/update-transfer', { call_sid: RESIDENT, progress: 'Technician is fixing it' });
  assert.equal(late.status, 200);
  const last = s.report().progress_updates.at(-1);
  assert.equal(last.text, 'Technician is fixing it');
  assert.equal(last.in_brief, false);
});

// ---------------------------------------------------------------- Iris finishes her sentence before the handover (D25)

test('handover: a technician joining while Iris is talking waits for her to finish, then she is muted and the room told', async (t) => {
  const s = await setup({ handoverMaxWaitMs: 2000 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  const iris = s.agentLegs[0].callSid;
  await s.room('participant-speech-start', { CallSid: iris }); // Iris mid-sentence
  await s.techAcceptsAndJoins(0);
  await tick();
  assert.deepEqual(s.roomActions, ['tech:hold'], 'not muted mid-sentence; the technician waits on hold');
  assert.ok(s.logs.some((line) => line.includes('HANDOVER Iris is talking: the technician waits on hold until she finishes')));
  assert.equal(s.transfer().status, 'connected', 'the transfer itself is connected straight away');

  await s.room('participant-speech-stop', { CallSid: iris });
  await tick();
  assert.deepEqual(s.roomActions, ['tech:hold', 'cue:wrapup', 'mute:true', 'tech:release', 'announce:joined'], 'muted only after she finished and wrapped up, then the technician, then the announcement');
  assert.ok(s.logs.some((line) => line.includes('HANDOVER Iris wrapped up: muting Iris')));
});

test('handover: if Iris keeps talking, she is muted after the maximum wait; if she is quiet, at once', async (t) => {
  const s = await setup({ handoverMaxWaitMs: 120 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.room('participant-speech-start', { CallSid: s.agentLegs[0].callSid });
  await s.techAcceptsAndJoins(0);
  assert.deepEqual(s.roomActions, ['tech:hold']);
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.deepEqual(s.roomActions, ['tech:hold', 'mute:true', 'tech:release', 'announce:joined']);
  assert.ok(s.logs.some((line) => line.includes('HANDOVER waited the maximum time')));
  assert.ok(s.logs.some((line) => line.startsWith('WARN HANDOVER') || line.includes('WARN HANDOVER')), 'the safety net is logged as a warning');

  const quiet = await setup();
  t.after(quiet.close);
  await quiet.residentAsksForTransfer();
  await quiet.techAcceptsAndJoins(0);
  assert.deepEqual(quiet.roomActions, ['cue:wrapup', 'mute:true', 'tech:release', 'announce:joined'], 'Iris not talking: immediate, as before');
});

// ---------------------------------------------------------------- updates via the update_transfer reply (D26)

test('update via tool reply: technician news reaches Iris in her next update_transfer reply, with no audio cue', async (t) => {
  const s = await setup({ techNumbers: ['+15550000001', '+15550000002', '+15550000003'], updateFallbackMs: 5000 });
  t.after(s.close);
  const reply = await s.residentAsksForTransfer();
  assert.match(reply.body.message, /Call it after each answer from the caller: its reply also tells you if a technician did not pick up/);

  const quiet = await s.json('/tool/update-transfer', { call_sid: RESIDENT, progress: 'Fan is dead' });
  assert.match(quiet.body.message, /No change: technician 1 is still being called\. Do not mention it/);

  await s.tech(0).status('no-answer');
  await tick();
  assert.deepEqual(s.agentCues, [], 'no audio cue: it waits for the tool reply');
  assert.equal(s.techCalls().length, 2, 'next technician dialled at once');

  const news = await s.json('/tool/update-transfer', { call_sid: RESIDENT, progress: 'Fan is dead; outlet works' });
  assert.match(news.body.message, /Technician 1 did not pick up\. Technician 2 is being called now\. Tell the caller this briefly in one sentence/);
  const again = await s.json('/tool/update-transfer', { call_sid: RESIDENT, progress: 'Still dead' });
  assert.match(again.body.message, /No change: technician 2 is still being called/, 'told only once');

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(s.agentCues, [], 'the fallback cue never plays once the news was given');
  const u = s.report().resident_updates[0];
  assert.equal(u.delivered_via, 'tool reply');
  assert.ok(u.cued_at);
  assert.ok(s.logs.some((line) => line.includes('UPDATE told Iris in the update_transfer reply: "Technician 1 did not pick up. Technician 2 is being called now."')));
});

test('update via tool reply: two technicians failing before her next call are told together', async (t) => {
  const s = await setup({ techNumbers: ['+15550000001', '+15550000002', '+15550000003'], updateFallbackMs: 5000 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.tech(0).status('busy');
  await tick();
  await s.tech(1).status('no-answer');
  await tick();
  const news = await s.json('/tool/update-transfer', { call_sid: RESIDENT, progress: 'x' });
  assert.match(news.body.message, /Technician 1 did not pick up\. Technician 2 did not pick up\. Technician 3 is being called now\./);
});

test('update fallback: with no update_transfer call in time, the audio cue is used', async (t) => {
  const s = await setup({ techNumbers: ['+15550000001', '+15550000002', '+15550000003'], updateFallbackMs: 250 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.tech(0).status('no-answer');
  await tick();
  assert.deepEqual(s.agentCues, []);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(s.agentCues.map((c) => new URL(c.announceUrl).searchParams.get('kind')), ['tech-update']);
  assert.equal(s.report().resident_updates[0].delivered_via, 'audio cue');
  assert.ok(s.logs.some((line) => line.includes('UPDATE no update_transfer call within 250 ms: using the audio cue')));
});

test('update fallback: a technician accepting before the fallback means no cue at all', async (t) => {
  const s = await setup({ techNumbers: ['+15550000001', '+15550000002'], updateFallbackMs: 100 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.tech(0).status('no-answer');
  await s.techAcceptsAndJoins(1);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(s.agentCues.map((c) => new URL(c.announceUrl).searchParams.get('kind')), ['wrapup'], 'no update cue, only the wrap-up');
});

test('accept: progress reported after the brief is read to the technician when they press 1', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.tech(0).answered(); // brief without progress
  await s.json('/tool/update-transfer', { call_sid: RESIDENT, progress: 'Standing fan is completely dead' });
  const accept = await s.tech(0).press('1');
  assert.match(accept.text, /<Say>Update: Standing fan is completely dead\. Connecting you to the resident\.<\/Say>/);
  assert.equal(s.report().technicians[0].update_on_accept, 'Standing fan is completely dead.');
  assert.ok(s.logs.some((line) => line.includes('BRIEF tech#0 update on accepting: "Standing fan is completely dead."')));

  // Already in the brief: no repeat.
  const other = await setup();
  t.after(other.close);
  await other.residentAsksForTransfer();
  await other.json('/tool/update-transfer', { call_sid: RESIDENT, progress: 'Valve closed' });
  await other.tech(0).answered();
  const plain = await other.tech(0).press('1');
  assert.match(plain.text, /<Say>Connecting you to the resident\.<\/Say>/);
  assert.equal(other.report().technicians[0].update_on_accept, null);
});

test('handover: the safety net is 30 s by default (the technician is on hold meanwhile, D30)', () => {
  const env = { TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'x', TWILIO_PHONE_NUMBER: TWILIO_NUMBER, ELEVENLABS_API_KEY: 'x', ELEVENLABS_AGENT_ID: 'agent_x', TECH_NUMBERS: '+15550000001', PUBLIC_BASE_URL: PUBLIC, TOOL_SECRET: 'x', TWILIO_AGENT_APP_SID: APP_SID };
  const c = loadConfig(env);
  assert.equal(c.handoverMaxWaitMs, 30_000);
  assert.equal(loadConfig({ ...env, HANDOVER_MAX_WAIT_MS: '12000' }).handoverMaxWaitMs, 12_000);
  assert.equal(c.updateFallbackMs, 8_000);
  assert.equal(loadConfig({ ...env, UPDATE_FALLBACK_MS: '0' }).updateFallbackMs, 0);
});

// ---------------------------------------------------------------- handover grace and wrap-up (D27)

test('handover grace: Iris quiet at the join but starting a sentence is not cut off (the 15:37 race)', async (t) => {
  const s = await setup({ handoverGraceMs: 300, handoverMaxWaitMs: 5000 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  const iris = s.agentLegs[0].callSid;
  await s.techAcceptsAndJoins(0); // Iris quiet at this moment
  assert.deepEqual(s.roomActions, ['cue:wrapup', 'tech:hold'], 'not muted at once: grace period, technician on hold');
  await s.room('participant-speech-start', { CallSid: iris }); // her next sentence starts within the grace
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(s.roomActions, ['cue:wrapup', 'tech:hold'], 'still talking after the grace: keep waiting');
  assert.ok(s.logs.some((line) => line.includes('HANDOVER Iris is talking: the technician waits on hold until she finishes')));
  await s.room('participant-speech-stop', { CallSid: iris });
  await tick();
  assert.deepEqual(s.roomActions, ['cue:wrapup', 'tech:hold'], 'a pause is not the end: she gets the grace period to carry on');
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(s.roomActions, ['cue:wrapup', 'tech:hold', 'mute:true', 'tech:release', 'announce:joined'], 'muted only after she finished');
});

test('handover grace: if Iris stays quiet, the handover happens when the grace ends', async (t) => {
  const s = await setup({ handoverGraceMs: 150, handoverMaxWaitMs: 5000 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.techAcceptsAndJoins(0);
  assert.deepEqual(s.roomActions, ['cue:wrapup', 'tech:hold']);
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(s.roomActions, ['cue:wrapup', 'tech:hold', 'mute:true', 'tech:release', 'announce:joined']);
  assert.ok(s.logs.some((line) => line.includes('HANDOVER Iris is quiet: muting Iris')));
});

test('wrap-up: while a technician is joining, update_transfer tells Iris to finish her point and not start a new one', async (t) => {
  const s = await setup({ handoverGraceMs: 0 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.tech(0).answered();
  await s.tech(0).press('1'); // bridging: technician on the way into the room
  await tick();
  const joining = await s.json('/tool/update-transfer', { call_sid: RESIDENT, progress: 'Router restarted, still red' });
  assert.match(joining.body.message, /A technician has accepted and is joining the call now\. Finish your current point in a few words and do not ask a new question/);
  assert.equal(s.report().progress_updates.at(-1).in_brief, false);

  // After everyone has given up, the old message stays.
  const over = await setup({ techNumbers: ['+15550000001'] });
  t.after(over.close);
  await over.residentAsksForTransfer();
  await over.tech(0).status('no-answer');
  await tick();
  const after = await over.json('/tool/update-transfer', { call_sid: RESIDENT, progress: 'x' });
  assert.match(after.body.message, /The search is already over/);
});

test('handover grace: default is 1.5 s', () => {
  const env = { TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'x', TWILIO_PHONE_NUMBER: TWILIO_NUMBER, ELEVENLABS_API_KEY: 'x', ELEVENLABS_AGENT_ID: 'agent_x', TECH_NUMBERS: '+15550000001', PUBLIC_BASE_URL: PUBLIC, TOOL_SECRET: 'x', TWILIO_AGENT_APP_SID: APP_SID };
  assert.equal(loadConfig(env).handoverGraceMs, 1500);
  assert.equal(loadConfig({ ...env, HANDOVER_GRACE_MS: '0' }).handoverGraceMs, 0);
});

// ---------------------------------------------------------------- recordings (merged from full-call-recording)

test('recordings: with recording and live transcripts on, the troubleshooting flow is unchanged and every line is captured', async (t) => {
  const s = await setup({ recordLegs: true, liveTranscription: true, liveTranscriptionIrisLeg: true, handoverMaxWaitMs: 2000 });
  t.after(s.close);

  // The resident's line: live transcript from the first TwiML, own recording once in the room.
  const inbound = await s.hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: TWILIO_NUMBER, Direction: 'inbound' });
  assert.match(inbound.text, /<Start><Transcription[^>]*name="resident"[^>]*track="both_tracks"/);
  assert.match(inbound.text, /<Dial><Conference[^>]*>room-/, 'still goes into the room');
  await s.room('participant-join', { CallSid: RESIDENT });
  assert.equal(s.legRecordings.length, 1);
  assert.equal(s.legRecordings[0].callSid, RESIDENT);
  assert.equal(s.legRecordings[0].recordingChannels, 'dual');

  // Iris's leg: the live transcription goes in front of the ElevenLabs stream.
  const agent = await s.avaJoins();
  assert.match(agent.text, /<Response><Start><Transcription[^>]*name="iris-1"[^>]*\/><\/Start><Connect><Stream/);

  await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'Leak under the kitchen sink in unit 4B.' });
  await tick();
  assert.deepEqual(s.holds, [], 'no hold music on this branch');

  // One at a time, still: technician 1 does not answer, then technician 2 is called.
  assert.equal(s.techCalls().length, 1);
  assert.equal(s.techCalls()[0].record, true, "the technician's own line is recorded");
  assert.equal(s.techCalls()[0].recordingChannels, 'dual');
  await s.tech(0).status('no-answer');
  await tick();
  assert.equal(s.techCalls().length, 2);

  // Technician 2 answers: live transcript starts before the brief, the brief still carries the summary.
  await s.hook(`/tech/status?resident=${RESIDENT}&tech=1`, { CallSid: s.tech(1).sid(), CallStatus: 'in-progress' });
  const brief = await s.hook(`/tech/answered?resident=${RESIDENT}&tech=1`, { CallSid: s.tech(1).sid(), CallStatus: 'in-progress' });
  assert.match(brief.text, /<Start><Transcription[^>]*name="technician-2"[^>]*\/><\/Start>[\s\S]*<Gather/);
  assert.match(brief.text, /Leak under the kitchen sink in unit 4B\./);

  // Handover: Iris is mid-sentence, so she is muted only once she finishes.
  const iris = s.agentLegs[0].callSid;
  await s.room('participant-speech-start', { CallSid: iris });
  await s.tech(1).press('1');
  await tick();
  await s.tech(1).joins();
  await tick();
  assert.deepEqual(s.mutes, [], 'not muted mid-sentence');
  await s.room('participant-speech-stop', { CallSid: iris });
  await tick();
  assert.equal(s.mutes.length, 1);
  assert.equal(s.mutes[0].callSid, iris);

  // Twilio reports the recordings and live transcript lines.
  await s.hook(`/twilio/recording-status?resident=${RESIDENT}&leg=resident`, { CallSid: RESIDENT, RecordingSid: `RE${'0'.repeat(31)}1`, RecordingStatus: 'completed', RecordingDuration: '61', RecordingChannels: '2' });
  await s.hook(`/twilio/recording-status?resident=${RESIDENT}&tech=1&leg=technician`, { CallSid: s.tech(1).sid(), RecordingSid: `RE${'9'.repeat(32)}`, RecordingStatus: 'completed', RecordingDuration: '30', RecordingChannels: '2' });
  await s.room('recording', { RecordingSid: `RE${'8'.repeat(32)}`, RecordingStatus: 'completed', RecordingDuration: '62', RecordingChannels: '1' });
  await s.hook(`/twilio/live-transcription?resident=${RESIDENT}&leg=resident`, {
    TranscriptionEvent: 'transcription-content', Track: 'inbound_track', Final: 'true', CallSid: RESIDENT,
    TranscriptionData: JSON.stringify({ transcript: 'My kitchen sink is leaking.', confidence: 0.93 }),
  });
  await tick();

  const report = s.report();
  assert.equal(report.result, 'connected');
  assert.equal(report.sequence.one_at_a_time, true, 'the sequence proof is still in the report');
  assert.ok(report.technicians[1].briefing, 'the brief is still in the report');
  const kinds = report.twilio.recordings.map((r) => `${r.kind}${r.technician ? ` ${r.technician}` : ''}:${r.status}`).sort();
  assert.deepEqual(kinds, ['resident:completed', 'room:completed', 'technician 2:completed']);
  assert.deepEqual(report.twilio.live_transcript.map((l) => [l.leg, l.track, l.text]), [['resident', 'inbound_track', 'My kitchen sink is leaking.']]);
  assert.deepEqual(report.twilio.settings, { record_legs: true, live_transcription: true, live_transcription_iris_leg: true });

  const page = (await s.get(`/reports/${RESIDENT}`)).text;
  for (const id of ['merged', 'elevenlabs', 'twilio']) panelOf(page, id);
  assert.match(page, /<h2>Call sequence<\/h2>/);
});

test('recordings: with everything off, no line recording or live transcript is requested', async (t) => {
  const s = await setup();
  t.after(s.close);
  const inbound = await s.hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: TWILIO_NUMBER, Direction: 'inbound' });
  assert.doesNotMatch(inbound.text, /<Transcription/);
  await s.room('participant-join', { CallSid: RESIDENT });
  const agent = await s.avaJoins();
  assert.doesNotMatch(agent.text, /<Transcription/);
  await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'Leak.' });
  await tick();
  assert.equal(s.legRecordings.length, 0);
  assert.equal(s.techCalls()[0].record, undefined);
  assert.match(inbound.text, /record="record-from-start"/, 'the room recording is always made');
});

// ---------------------------------------------------------------- technician leaves (D29)

test('technician leaves: Iris is unmuted, then told on her leg only that the technician has gone (the 16:33 silence)', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.techAcceptsAndJoins(0);
  await tick();
  const iris = s.agentLegs[0].callSid;

  await s.tech(0).leaves();
  await tick();
  assert.deepEqual(s.roomActions.slice(-2), ['mute:false', 'cue:left'], 'voice back first, then the cue');
  const cue = s.agentCues.at(-1);
  assert.equal(cue.callSid, iris, "the cue goes to Iris's leg only");
  assert.equal(s.announcements().filter((k) => k === 'left').length, 0, 'not announced to the room');

  // What Twilio says on Iris's leg when it fetches the cue.
  const played = await s.hook('/conference/announce?kind=left', { CallSid: iris });
  assert.match(played.text, /<Say>The technician has left the call\. Please speak to the caller again\.<\/Say>/);
  assert.ok(s.logs.some((line) => line.includes('CUE to Iris only "The technician has left the call.')));
});

test('technician leaves while Iris is still finishing her sentence: no mute, no announcement, she is just told', async (t) => {
  const s = await setup({ handoverMaxWaitMs: 2000 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  const iris = s.agentLegs[0].callSid;
  await s.room('participant-speech-start', { CallSid: iris }); // Iris mid-sentence
  await s.techAcceptsAndJoins(0);
  await tick();
  assert.deepEqual(s.roomActions, ['tech:hold'], 'handover waiting for her sentence, technician on hold');

  await s.tech(0).leaves();
  await s.room('participant-speech-stop', { CallSid: iris });
  await tick();
  assert.ok(s.logs.some((line) => line.includes('HANDOVER cancelled: the technician left before Iris was muted')));
  assert.deepEqual(s.mutes, [], 'never muted: there is nobody to hand over to');
  assert.ok(!s.announcements().includes('joined'), 'the room is not told a technician joined');
  assert.deepEqual(s.roomActions, ['tech:hold', 'cue:left'], 'no release for a technician who has gone');
});

// ---------------------------------------------------------------- technician on hold while Iris finishes (D30)

test('technician hold: joins muted, waits on hold through every pause in Iris\'s turn, then is brought in after she is muted', async (t) => {
  const s = await setup({ handoverGraceMs: 200, handoverMaxWaitMs: 5000, cueQuietGapMs: 150 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  const iris = s.agentLegs[0].callSid;
  await s.room('participant-speech-start', { CallSid: iris }); // Iris mid-sentence

  // The technician's join TwiML: muted, so they cannot talk over Iris before the hold lands.
  await s.tech(0).answered();
  const accept = await s.tech(0).press('1');
  assert.match(accept.text, /<Conference[^>]*muted="true"/);
  await tick();
  await s.tech(0).joins();
  const techSid = s.tech(0).sid();
  assert.deepEqual(s.roomActions, ['tech:hold']);
  assert.deepEqual(s.techUpdates[0], { conferenceSid: CONFERENCE, callSid: techSid, hold: true, holdUrl: `${PUBLIC}/conference/tech-hold`, holdMethod: 'POST' });

  // What the technician hears on hold.
  const hold = await s.hook('/conference/tech-hold', { CallSid: techSid });
  assert.match(hold.text, /<Say>One moment please\.<\/Say><Pause length="30"\/>/);

  // A short pause inside her turn, then more: still no handover.
  await s.room('participant-speech-stop', { CallSid: iris });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await s.room('participant-speech-start', { CallSid: iris });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(s.roomActions, ['tech:hold'], 'a pause inside her turn does not cut her off');
  assert.deepEqual(s.mutes, []);

  // She finishes: the wrap-up cue goes out after a pause, then once she has been quiet for
  // the grace period she is muted and the technician comes in.
  await s.room('participant-speech-stop', { CallSid: iris });
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.deepEqual(s.roomActions, ['tech:hold', 'cue:wrapup', 'mute:true', 'tech:release', 'announce:joined']);
  assert.deepEqual(s.techUpdates[1], { conferenceSid: CONFERENCE, callSid: techSid, hold: false, muted: false });

  const report = s.report();
  assert.equal(report.technician_hold_periods.length, 1);
  assert.ok(report.technician_hold_periods[0].from && report.technician_hold_periods[0].to, 'the hold opened and closed');
  assert.ok(Date.parse(report.technician_hold_periods[0].to) >= Date.parse(report.agent_mute_periods[0].from), 'released only after Iris was muted');
});

test('technician hold: with no Iris in the room, the technician is unmuted straight away (no hold)', async (t) => {
  const s = await setup({ handoverGraceMs: 200 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.avaLeaves();
  await s.tech(0).answered();
  await s.tech(0).press('1');
  await tick();
  await s.tech(0).joins();
  await tick();
  assert.ok(!s.roomActions.includes('tech:hold'));
  assert.deepEqual(s.techUpdates.map((u) => u.muted), [false], 'unmuted once, never held');
});

test('technician leaves after the resident: no cue', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.techAcceptsAndJoins(0);
  await tick();
  await s.room('participant-leave', { CallSid: RESIDENT });
  await s.tech(0).leaves();
  await tick();
  assert.ok(!s.roomActions.includes('cue:left'));
});

test('transcript: the "technician has left" cue is labelled as a cue to Iris only', () => {
  const { renderDetail } = require('../src/reports');
  const at = (sec) => new Date(Date.UTC(2026, 10, 26, 16, 32, sec)).toISOString();
  const report = {
    resident_call_sid: RESIDENT, resident_number: RESIDENT_NUMBER, started_at: at(0), finished_at: at(20), result: 'connected',
    connected_technician: '+15550000001', transfer_style: 'agent stays on the call',
    technicians: [{ number: '+15550000001', outcome: 'accepted', line_closed_at: at(40) }],
    hold_periods: [], agent_mute_periods: [{ from: at(20), to: at(40) }], resident_updates: [],
    transcript: { status: 'final', conversations: [{ conversation_id: 'c1', status: 'done', started_at: new Date(Date.parse(at(0)) - 10_000).toISOString(), entries: [
      { role: 'tool', text: 'called request_transfer', seconds: 10 },
      { role: 'user', text: 'Thanks, I can see the problem now.', seconds: 35 },
      { role: 'user', text: 'The technician has left the call. Please speak to the caller again.', seconds: 51 },
      { role: 'agent', text: 'I am still here. Did the technician sort it out?', seconds: 53 },
      { role: 'user', text: 'Hello? Hello?', seconds: 56 },
    ] }] },
  };
  const page = renderDetail(report);
  const el = panelOf(page, 'elevenlabs');
  assert.match(el, /<td>Cue to Iris only \(resident did not hear it\)<\/td><td class="text">The technician has left the call\. Please speak to the caller again\.<\/td>/);
  assert.match(el, /<td>Iris<\/td><td class="text">I am still here\./, 'heard: she was unmuted');
  // Speaker from the timeline: either person while the technician is in, the resident once they have gone.
  assert.match(el, /<td>Resident or technician<\/td><td class="text">Thanks, I can see the problem now\./);
  assert.match(el, /<td>Resident<\/td><td class="text">Hello\? Hello\?/);
  const merged = panelOf(page, 'merged');
  assert.match(merged, /<td>Resident<\/td><td class="text">Hello\? Hello\?/, 'merged view agrees');
  assert.doesNotMatch(merged, /The technician has left the call\. Please speak/, 'the cue is not a line someone said');
});

// ---------------------------------------------------------------- wrap-up (D31)

test('wrap-up: at press 1 Iris is told to wrap up; the room hears "joined" only after her wrap-up sentence', async (t) => {
  const s = await setup({ handoverGraceMs: 150, handoverMaxWaitMs: 5000, handoverWrapUpWaitMs: 2000 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  const iris = s.agentLegs[0].callSid;

  await s.tech(0).answered();
  await s.tech(0).press('1');
  await tick();
  // The cue goes to Iris's leg only, at once (nobody is talking).
  assert.deepEqual(s.roomActions, ['cue:wrapup']);
  assert.equal(s.agentCues.at(-1).callSid, iris);
  const played = await s.hook('/conference/announce?kind=wrapup', { CallSid: iris });
  assert.match(played.text, /<Say>A technician has accepted and is joining the call now\. Finish your point in a few words, tell the caller the technician is joining, and do not ask a new question\.<\/Say>/);

  // The technician arrives before Iris has replied: they wait on hold.
  await s.tech(0).joins();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(s.roomActions, ['cue:wrapup', 'tech:hold'], 'Iris has not wrapped up yet, longer than the grace period');
  assert.ok(s.logs.some((line) => line.includes('HANDOVER waiting for Iris to wrap up')));

  // Iris: "Good news, the technician is joining now." Not cut off while she says it.
  await s.room('participant-speech-start', { CallSid: iris });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.deepEqual(s.roomActions, ['cue:wrapup', 'tech:hold']);
  await s.room('participant-speech-stop', { CallSid: iris });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(s.roomActions, ['cue:wrapup', 'tech:hold', 'mute:true', 'tech:release', 'announce:joined']);
  assert.ok(s.logs.some((line) => line.includes('WRAPUP done (Iris finished)')));
  assert.ok(s.logs.some((line) => line.includes('HANDOVER Iris wrapped up: muting Iris')));
});

test('wrap-up: if Iris does not reply to the cue, the handover goes ahead after HANDOVER_WRAPUP_WAIT_MS', async (t) => {
  const s = await setup({ handoverGraceMs: 50, handoverMaxWaitMs: 5000, handoverWrapUpWaitMs: 200 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.techAcceptsAndJoins(0);
  assert.deepEqual(s.roomActions, ['cue:wrapup', 'tech:hold']);
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(s.roomActions, ['cue:wrapup', 'tech:hold', 'mute:true', 'tech:release', 'announce:joined']);
  assert.ok(s.logs.some((line) => line.includes('WRAPUP done (Iris did not start within 0.2s)')));
});

test('wrap-up: an update_transfer call before the cue is played carries the wrap-up instead, so no cue', async (t) => {
  const s = await setup({ cueQuietGapMs: 5000, cueMaxWaitMs: 5000, handoverWrapUpWaitMs: 100 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.room('participant-speech-start', { CallSid: RESIDENT }); // the cue waits for a pause
  await s.tech(0).answered();
  await s.tech(0).press('1');
  await tick();
  const reply = await s.json('/tool/update-transfer', { call_sid: RESIDENT, progress: 'Valve turned off.' });
  assert.match(reply.body.message, /A technician has accepted and is joining the call now/);
  assert.ok(s.logs.some((line) => line.includes('WRAPUP given in the update_transfer reply instead of the cue')));
  await s.room('participant-speech-stop', { CallSid: RESIDENT });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(!s.roomActions.includes('cue:wrapup'), 'not told twice');
});

test('wrap-up: not sent while Iris is muted for hold music (the resident could not hear her)', async (t) => {
  const s = await setup({ holdDelayMs: 10 });
  t.after(s.close);
  await s.residentAsksForTransfer();
  await new Promise((resolve) => setTimeout(resolve, 40)); // music on, Iris muted
  await s.techAcceptsAndJoins(0);
  await tick();
  assert.ok(!s.roomActions.includes('cue:wrapup'));
  assert.equal(s.report().result, 'connected');
});

test('wrap-up: default wait for Iris to start replying is 6 s', () => {
  const env = { TWILIO_ACCOUNT_SID: `AC${'1'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'x', TWILIO_PHONE_NUMBER: TWILIO_NUMBER, ELEVENLABS_API_KEY: 'x', ELEVENLABS_AGENT_ID: 'agent_x', TECH_NUMBERS: '+15550000001', PUBLIC_BASE_URL: PUBLIC, TOOL_SECRET: 'x', TWILIO_AGENT_APP_SID: APP_SID };
  assert.equal(loadConfig(env).handoverWrapUpWaitMs, 6000);
  assert.equal(loadConfig({ ...env, HANDOVER_WRAPUP_WAIT_MS: '4000' }).handoverWrapUpWaitMs, 4000);
});
