'use strict';

// Branch "agent-stays-on-call".
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
const { createApp, FALLBACK_FIRST_MESSAGE } = require('../src/app');

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

async function setup({ dialMode = 'sequential', techNumbers = ['+15550000001', '+15550000002'] } = {}) {
  const created = []; //        calls.create(...)            -> technician calls and /start-call
  const updates = []; //        calls(sid).update(...)
  const agentLegs = []; //      conferences(sid).participants.create(...) -> Ava joining
  const roomUpdates = []; //    conferences(sid).update(...) -> announcements, ending the room
  const registered = []; //     register-call requests to ElevenLabs
  const logs = [];
  const failUpdatesFor = new Set(); //   call SIDs whose REST updates throw
  const answeredMeanwhile = new Set(); // call SIDs that report in-progress when we try to cancel them
  const flags = { failAgentAdd: false, failRegister: false };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-transfer-test-'));

  const calls = (sid) => ({
    update: async (options) => {
      updates.push({ sid, ...options });
      if (failUpdatesFor.has(sid)) {
        throw Object.assign(new Error('Call is not in-progress'), { code: 21220 });
      }
      const ignored = options.status === 'canceled' && answeredMeanwhile.has(sid);
      return { sid, status: ignored ? 'in-progress' : options.status || 'in-progress' };
    },
  });
  calls.create = async (options) => {
    const sid = `CA${String(created.length + 1).padStart(32, '0')}`;
    created.push({ sid, ...options });
    return { sid, status: 'queued' };
  };

  const conferences = (sid) => ({
    update: async (options) => {
      roomUpdates.push({ sid, ...options });
      return { sid };
    },
    participants: {
      create: async (options) => {
        if (flags.failAgentAdd) throw Object.assign(new Error('Application not found'), { code: 21218 });
        const callSid = `CA${'e'.repeat(31)}${agentLegs.length + 1}`;
        agentLegs.push({ conferenceSid: sid, callSid, ...options });
        return { callSid, label: options.label };
      },
    },
  });

  const config = {
    publicBaseUrl: PUBLIC,
    twilioAuthToken: AUTH_TOKEN,
    twilioPhoneNumber: TWILIO_NUMBER,
    toolSecret: TOOL_SECRET,
    techNumbers,
    dialMode,
    ringTimeoutSec: 20,
    agentAppSid: APP_SID,
    reportsDir: path.join(tmp, 'reports'),
    publicDir: path.join(tmp, 'public'),
  };
  const registerCall = async (args) => {
    registered.push(args);
    if (flags.failRegister) throw new Error('register-call HTTP 401: invalid api key');
    return AGENT_TWIML;
  };

  const { app, state } = createApp({ config, client: { calls, conferences }, registerCall, logger: (line) => logs.push(line) });
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

  // Ava's leg: Twilio asks the TwiML App URL for TwiML, then reports her in the room.
  async function avaJoins(resident = RESIDENT) {
    const leg = agentLegs.at(-1);
    const answer = await hook('/twilio/agent-leg', { CallSid: `CA${'d'.repeat(32)}`, From: TWILIO_NUMBER, To: `app:${APP_SID}`, resident });
    await room('participant-join', { CallSid: leg.callSid, ParticipantLabel: leg.label }, resident);
    return answer;
  }
  const avaLeaves = () => room('participant-leave', { CallSid: agentLegs.at(-1).callSid, ParticipantLabel: agentLegs.at(-1).label });

  // Resident calls in, lands in the room, Ava is added and joins.
  async function residentIsWithAva() {
    const inbound = await hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: TWILIO_NUMBER, Direction: 'inbound' });
    await room('participant-join', { CallSid: RESIDENT });
    await avaJoins();
    return inbound;
  }

  // ...and then Ava asks for a transfer.
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
    config, state, created, updates, agentLegs, roomUpdates, registered, logs, failUpdatesFor, answeredMeanwhile, flags,
    hook, json, get, room, avaJoins, avaLeaves, residentIsWithAva, residentAsksForTransfer, tech, techAcceptsAndJoins,
    techCalls, endedWith, announcements, roomEnded, transfer, outcomes, report, close,
  };
}

// ---------------------------------------------------------------- call start

test('call start: resident goes into a room and Ava is added to it as her own leg', async (t) => {
  const s = await setup();
  t.after(s.close);

  const inbound = await s.hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: TWILIO_NUMBER, Direction: 'inbound' });
  assert.match(inbound.text, new RegExp(`<Dial><Conference[^>]*>${ROOM}</Conference></Dial>`));
  assert.match(inbound.text, /endConferenceOnExit="true"/, 'the resident leaving ends the call');
  assert.match(inbound.text, /waitUrl=""/, 'silence, not hold music, until Ava joins');
  assert.match(inbound.text, /record="record-from-start"/);
  assert.match(inbound.text, /statusCallbackEvent="start end join leave"/);
  assert.doesNotMatch(inbound.text, /<Connect>/, 'the ElevenLabs stream is not on the resident leg any more');
  assert.equal(s.registered.length, 0);
  assert.equal(s.agentLegs.length, 0, 'Ava is added once the resident is in the room');

  await s.room('participant-join', { CallSid: RESIDENT });
  assert.equal(s.agentLegs.length, 1);
  const leg = s.agentLegs[0];
  assert.equal(leg.conferenceSid, CONFERENCE);
  assert.equal(leg.to, `app:${APP_SID}?resident=${RESIDENT}`);
  assert.equal(leg.from, TWILIO_NUMBER);
  assert.equal(leg.label, 'ava-1');
  assert.equal(leg.endConferenceOnExit, false, 'Ava dropping does not end the call');

  // Twilio asks the TwiML App URL what to do with Ava's leg: the ElevenLabs stream.
  const answer = await s.avaJoins();
  assert.match(answer.text, /<Connect><Stream/);
  assert.deepEqual(s.registered[0], {
    fromNumber: RESIDENT_NUMBER, toNumber: TWILIO_NUMBER, direction: 'inbound', callSid: RESIDENT, firstMessage: null,
  });
  assert.equal(s.state.residentCalls.get(RESIDENT).agent.state, 'in');

  // A repeated join event does not add a second Ava.
  await s.room('participant-join', { CallSid: RESIDENT });
  assert.equal(s.agentLegs.length, 1);
});

test('agent leg: the resident call is found from Param_resident, or from the one call waiting for Ava', async (t) => {
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

test('Ava cannot be added (for example a wrong TwiML App SID): the resident is told and the call ends', async (t) => {
  const s = await setup();
  t.after(s.close);
  s.flags.failAgentAdd = true;
  await s.hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: TWILIO_NUMBER, Direction: 'inbound' });
  await s.room('participant-join', { CallSid: RESIDENT });

  const told = s.updates.find((u) => u.sid === RESIDENT && u.twiml);
  assert.match(told.twiml, /Sorry, we are having trouble connecting you right now/);
  assert.match(told.twiml, /<Hangup\/>/);
  assert.ok(s.logs.some((line) => line.includes('ERROR could not add Ava') && line.includes('Twilio error 21218')));
});

test('outbound start: /start-call rings the resident, who lands in the room; Ava registers as outbound', async (t) => {
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

test('accept: the technician joins the same room, nobody is moved, and Ava is still there', async (t) => {
  const s = await setup();
  t.after(s.close);

  const reply = await s.residentAsksForTransfer();
  assert.equal(reply.status, 200);
  assert.equal(reply.body.status, 'searching');
  assert.match(reply.body.message, /A technician has joined the call\./, 'the tool reply tells Ava what to listen for');

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

  // The point of this branch: the resident's call is never touched, so Ava's stream keeps running.
  assert.deepEqual(s.updates.filter((u) => u.sid === RESIDENT), [], 'resident call is not updated');
  assert.equal(s.agentLegs.length, 1, 'Ava was added once and never replaced');
  assert.equal(s.state.residentCalls.get(RESIDENT).agent.state, 'in');
  assert.equal(s.state.residentCalls.get(RESIDENT).present.size, 3, 'resident, Ava and the technician are in the room');
  assert.equal(s.roomEnded(), false);
  assert.equal(s.registered.length, 1, 'no second ElevenLabs conversation');

  // Everyone hears that the technician has arrived (this is Ava's cue).
  assert.deepEqual(s.announcements(), ['joined']);
  assert.equal(s.roomUpdates[0].sid, CONFERENCE);
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
  const [first, second] = report.technicians;
  assert.equal(first.outcome, 'accepted');
  assert.equal(first.answered_by, 'human');
  for (const key of ['dialled', 'ringing', 'answered', 'outcome']) {
    assert.equal(typeof first.seconds_from_tool_call[key], 'number', `seconds_from_tool_call.${key}`);
  }
  assert.equal(second.outcome, 'not-called');

  // If Ava checks again, she is told the technician is there.
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

test('after connecting: the call survives the technician or Ava leaving, and ends when the resident is left alone', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.techAcceptsAndJoins(0);

  // Technician hangs up: the resident is still with Ava.
  await s.tech(0).leaves();
  assert.equal(s.roomEnded(), false);
  assert.equal(s.state.residentCalls.get(RESIDENT).present.size, 2);

  // Then Ava's conversation ends too: nobody is left for the resident to talk to.
  await s.avaLeaves();
  assert.equal(s.roomEnded(), true);
  assert.equal(s.roomUpdates.at(-1).sid, CONFERENCE);
});

test('after connecting: Ava can drop out and the resident and technician carry on', async (t) => {
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

test('before any transfer: Ava ending the conversation ends the resident call', async (t) => {
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

test('accepted but dropped before reaching the room: counts as no technician and Ava is told', async (t) => {
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
  assert.deepEqual(s.announcements(), ['unavailable']);
});

// ---------------------------------------------------------------- nobody available

test('all fail: Ava is still in the room, so she is told by an announcement and nobody is moved', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).status('busy');
  await tick();
  await s.tech(1).status('no-answer');
  await tick();

  assert.equal(s.transfer().status, 'failed');
  assert.deepEqual(s.announcements(), ['unavailable']);
  assert.deepEqual(s.updates.filter((u) => u.sid === RESIDENT), [], 'resident call is not updated');
  assert.equal(s.agentLegs.length, 1, 'no second Ava');
  assert.equal(s.registered.length, 1, 'same ElevenLabs conversation');
  assert.equal(s.roomEnded(), false);

  const report = s.report();
  assert.equal(report.result, 'no technician');
  assert.equal(report.connected_technician, null);
  assert.equal(typeof report.resident_wait_seconds, 'number');
  assert.deepEqual(report.technicians.map((x) => x.outcome), ['busy', 'no-answer']);
  assert.equal(s.logs.filter((line) => line.includes('TRANSFER NO TECHNICIAN')).length, 1);

  // Ava asking again on the same call does not restart the search.
  const retry = await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'again' });
  assert.equal(retry.body.status, 'unavailable');
  assert.equal(s.techCalls().length, 2);
});

test('all fail after Ava dropped: she is brought back with the first-message override', async (t) => {
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
  assert.equal(s.agentLegs[1].label, 'ava-2');
  assert.deepEqual(s.announcements(), []);

  await s.avaJoins();
  assert.equal(s.registered.at(-1).firstMessage, FALLBACK_FIRST_MESSAGE);
  assert.equal(s.registered.at(-1).callSid, RESIDENT);
  assert.equal(s.roomEnded(), false);
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

// ---------------------------------------------------------------- parallel mode

test('parallel: winner cancels the others at once, canceled for ringing calls and completed for answered ones', async (t) => {
  const s = await setup({ dialMode: 'parallel', techNumbers: ['+15550000001', '+15550000002', '+15550000003'] });
  t.after(s.close);
  await s.residentAsksForTransfer();
  assert.equal(s.techCalls().length, 3, 'one separate call per technician');

  await s.tech(0).status('ringing'); //  still ringing when someone wins
  await s.tech(1).answered(); //         both of these are listening to the brief
  await s.tech(2).answered();
  const [a, b] = await Promise.all([s.tech(1).press('1'), s.tech(2).press('1')]);
  await tick();

  const winners = [a, b].filter((r) => /<Conference/.test(r.text));
  const losers = [a, b].filter((r) => /Another technician has already taken this call/.test(r.text));
  assert.equal(winners.length, 1, 'exactly one technician wins the lock');
  assert.equal(losers.length, 1);

  const winner = s.transfer().winner;
  const loser = winner === 1 ? 2 : 1;
  assert.deepEqual(s.endedWith(s.tech(0).sid()), ['canceled'], 'ringing technician: canceled');
  assert.deepEqual(s.endedWith(s.tech(loser).sid()), ['completed'], 'answered technician: completed');
  assert.deepEqual(s.endedWith(s.tech(winner).sid()), [], 'winner is not hung up');

  const expected = [];
  expected[0] = 'canceled';
  expected[winner] = 'accepted';
  expected[loser] = 'canceled';
  assert.deepEqual(s.outcomes(), expected);
  for (const i of [0, loser]) {
    assert.ok(s.logs.some((line) => line.includes(`CANCEL tech#${i}`) && line.includes('another technician accepted')), `cancellation of tech#${i} is logged`);
  }
});

test('cancel: a call picked up while we were cancelling is ended with completed, and Twilio errors are logged', async (t) => {
  const s = await setup({ dialMode: 'parallel', techNumbers: ['+15550000001', '+15550000002', '+15550000003'] });
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).status('ringing');
  await s.tech(1).status('ringing');
  s.answeredMeanwhile.add(s.tech(0).sid()); // Twilio ignores "canceled": the call is already in progress
  s.failUpdatesFor.add(s.tech(1).sid()); //    Twilio rejects every update for this call

  await s.tech(2).answered();
  await s.tech(2).press('1');
  await tick();

  assert.deepEqual(s.endedWith(s.tech(0).sid()), ['canceled', 'completed']);
  assert.deepEqual(s.endedWith(s.tech(1).sid()), ['canceled', 'completed'], 'falls back to completed after an error');
  const errors = s.logs.filter((line) => line.includes('ERROR cancel tech#1'));
  assert.equal(errors.length, 2);
  assert.ok(errors[0].includes('Twilio error 21220'));
});

test('parallel: voicemail does not win, and "no technician" only after every technician has failed', async (t) => {
  const s = await setup({ dialMode: 'parallel' });
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).answered();
  await s.tech(0).amd('machine_start');
  await tick();
  assert.equal(s.transfer().status, 'searching', 'the other technician can still accept');
  assert.deepEqual(s.announcements(), []);

  await s.tech(1).status('busy');
  await tick();
  assert.equal(s.transfer().status, 'failed');
  assert.deepEqual(s.outcomes(), ['voicemail', 'busy']);
  assert.deepEqual(s.announcements(), ['unavailable']);
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
  assert.equal((await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'x' })).status, 404, 'unknown call');
});
