'use strict';

// Simulates Twilio's webhooks against the real Express app with a fake Twilio
// REST client, so the transfer logic can be checked without placing calls.
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
const RESIDENT = `CA${'a'.repeat(32)}`;
const RESIDENT_NUMBER = '+15551110000';
const AGENT_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://agent.example.test"/></Connect></Response>';

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

async function setup({ dialMode = 'sequential', techNumbers = ['+15550000001', '+15550000002'] } = {}) {
  const created = [];
  const updates = [];
  const registered = [];
  const logs = [];
  const failUpdatesFor = new Set(); //   call SIDs whose REST updates throw
  const answeredMeanwhile = new Set(); // call SIDs that report in-progress when we try to cancel them
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

  const config = {
    publicBaseUrl: PUBLIC,
    twilioAuthToken: AUTH_TOKEN,
    twilioPhoneNumber: '+15559990000',
    toolSecret: TOOL_SECRET,
    techNumbers,
    dialMode,
    ringTimeoutSec: 20,
    holdMusicUrl: 'http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical',
    reportsDir: path.join(tmp, 'reports'),
    publicDir: path.join(tmp, 'public'),
  };
  const registerCall = async (args) => {
    registered.push(args);
    return AGENT_TWIML;
  };

  const { app, state } = createApp({ config, client: { calls }, registerCall, logger: (line) => logs.push(line) });
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

  // Resident call comes in, Ava asks for a transfer.
  async function residentAsksForTransfer() {
    await hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: config.twilioPhoneNumber, Direction: 'inbound' });
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
    };
  };

  const residentJoins = () =>
    hook(`/conference/status?resident=${RESIDENT}`, { StatusCallbackEvent: 'participant-join', CallSid: RESIDENT, ConferenceSid: 'CF1', FriendlyName: `room-${RESIDENT}` });

  const techCalls = () => created.filter((c) => c.url && c.url.includes('/tech/answered'));
  // Status values sent to Twilio for one call, in order, e.g. ['canceled', 'completed'].
  const endedWith = (sid) => updates.filter((u) => u.sid === sid && u.status).map((u) => u.status);
  const transfer = () => state.transfers.get(RESIDENT);
  const outcomes = () => transfer().techs.map((x) => x.outcome);
  const report = () => JSON.parse(fs.readFileSync(path.join(config.reportsDir, `${RESIDENT}.json`), 'utf8'));
  const close = async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  };

  return {
    config, state, created, updates, registered, logs, failUpdatesFor, answeredMeanwhile,
    hook, json, get, residentAsksForTransfer, residentJoins, tech, techCalls, endedWith, transfer, outcomes, report, close,
  };
}

test('accept: technician presses 1, joins the room first, then the resident is announced and moved in', async (t) => {
  const s = await setup();
  t.after(s.close);

  const reply = await s.residentAsksForTransfer();
  assert.equal(reply.status, 200);
  assert.equal(reply.body.status, 'searching');
  assert.deepEqual(s.registered[0], { fromNumber: RESIDENT_NUMBER, toNumber: '+15559990000', direction: 'inbound', callSid: RESIDENT, firstMessage: undefined });

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
  // The brief starts on pickup, before any machine-detection result.
  const prompt = await s.tech(0).answered();
  assert.match(prompt.text, /<Gather[^>]*numDigits="1"/);
  assert.match(prompt.text, /Leak under the kitchen sink in unit 4B\. Press 1 to connect to the resident\./);
  await s.tech(0).amd('human');
  assert.equal(s.transfer().status, 'searching');

  const accept = await s.tech(0).press('1');
  assert.match(accept.text, new RegExp(`<Say>Connecting you to the resident\\.</Say><Dial><Conference[^>]*>room-${RESIDENT}</Conference>`));
  assert.match(accept.text, /startConferenceOnEnter="true"/);
  assert.match(accept.text, /endConferenceOnExit="true"/);
  assert.match(accept.text, /record="record-from-start"/);
  assert.match(accept.text, /waitUrl="http:\/\/twimlets\.com\/holdmusic/);
  assert.match(accept.text, /statusCallbackEvent="start end join leave"/);
  await tick();

  // Resident's live call is updated: announcement first, then the same room.
  const residentUpdate = s.updates.find((u) => u.sid === RESIDENT && u.twiml);
  assert.ok(residentUpdate, 'resident call was updated');
  assert.match(residentUpdate.twiml, new RegExp(`<Say>A technician has answered\\. Connecting you now\\.</Say><Dial><Conference[^>]*>room-${RESIDENT}</Conference>`));
  assert.match(residentUpdate.twiml, /endConferenceOnExit="true"/);
  assert.equal(s.techCalls().length, 1, 'second technician is never dialled');

  await s.residentJoins();
  assert.equal(s.transfer().status, 'connected');

  const logText = s.logs.join('\n');
  for (const event of ['tool_call', 'first_tech_ringing', 'tech_answered', 'tech_pressed_1', 'resident_joined', 'TIMING SUMMARY']) {
    assert.ok(logText.includes(event), `timing log has ${event}`);
  }
  assert.equal(s.logs.filter((line) => line.includes('TRANSFER CONNECTED')).length, 1, 'one-line summary printed once');

  // Saved report.
  const report = s.report();
  assert.equal(report.resident_call_sid, RESIDENT);
  assert.equal(report.resident_number, RESIDENT_NUMBER);
  assert.equal(report.summary, 'Leak under the kitchen sink in unit 4B.');
  assert.equal(report.dial_mode, 'sequential');
  assert.equal(report.result, 'connected');
  assert.equal(report.connected_technician, '+15550000001');
  assert.equal(typeof report.resident_wait_seconds, 'number');
  assert.ok(report.started_at && report.finished_at);
  const [first, second] = report.technicians;
  assert.equal(first.outcome, 'accepted');
  assert.ok(first.dialled_at && first.ringing_at && first.answered_at);
  assert.equal(first.answered_by, 'human');
  for (const key of ['dialled', 'ringing', 'answered', 'outcome']) {
    assert.equal(typeof first.seconds_from_tool_call[key], 'number', `seconds_from_tool_call.${key}`);
  }
  assert.equal(second.outcome, 'not-called');
});

test('reports: HTML list and detail, local browser only', async (t) => {
  const s = await setup();
  t.after(s.close);

  assert.match((await s.get('/reports')).text, /No transfers yet/);

  await s.residentAsksForTransfer();
  await s.tech(0).answered();
  await s.tech(0).press('1');
  await tick();
  await s.residentJoins();

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
  await s.hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: '+15559990000', Direction: 'inbound' });
  await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: '<script>alert(1)</script> & more' });
  await tick();

  const detail = await s.get(`/reports/${RESIDENT}`);
  assert.ok(!detail.text.includes('<script>alert(1)</script>'));
  assert.ok(detail.text.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; more'));
});

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

  await s.tech(1).answered();
  await s.tech(1).press('1');
  await tick();
  assert.equal(s.transfer().winner, 1);
  assert.deepEqual(s.outcomes(), ['declined', 'accepted']);
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

test('all fail: resident is redirected to /twilio/fallback, which re-registers with the first-message override', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).status('busy');
  await tick();
  await s.tech(1).status('no-answer');
  await tick();

  assert.equal(s.transfer().status, 'failed');
  const redirect = s.updates.find((u) => u.sid === RESIDENT && u.url);
  assert.equal(redirect.url, `${PUBLIC}/twilio/fallback`);

  const fallback = await s.hook('/twilio/fallback', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: '+15559990000', Direction: 'inbound' });
  assert.match(fallback.text, /<Connect>/);
  const again = s.registered.at(-1);
  assert.equal(again.firstMessage, FALLBACK_FIRST_MESSAGE);
  assert.equal(again.callSid, RESIDENT);

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

test('resident hangs up while waiting: ringing technician is cancelled and the search stops', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.tech(0).status('ringing');

  await s.hook('/twilio/resident-status', { CallSid: RESIDENT, CallStatus: 'completed' });
  await tick();
  assert.equal(s.transfer().status, 'cancelled');
  assert.deepEqual(s.endedWith(s.tech(0).sid()), ['canceled'], 'ringing call is ended with canceled');
  assert.ok(s.logs.some((line) => line.includes('CANCEL tech#0') && line.includes('resident hung up')));

  // The cancelled technician call ending must not dial the next technician.
  await s.tech(0).status('canceled');
  await tick();
  assert.equal(s.techCalls().length, 1);
  assert.equal(s.updates.some((u) => u.url && u.url.includes('/twilio/fallback')), false);

  const report = s.report();
  assert.equal(report.result, 'resident hung up');
  assert.deepEqual(report.technicians.map((x) => x.outcome), ['canceled', 'not-called']);

  // A technician who was already listening and presses 1 is told the resident left.
  const late = await s.tech(0).press('1');
  assert.match(late.text, /resident has hung up/);
  assert.doesNotMatch(late.text, /<Conference/);
});

test('resident hangs up while a technician is listening to the brief: that call is ended with completed', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  await s.tech(0).answered();

  await s.hook('/twilio/resident-status', { CallSid: RESIDENT, CallStatus: 'completed' });
  await tick();
  assert.deepEqual(s.endedWith(s.tech(0).sid()), ['completed']);
});

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
  assert.equal(s.updates.filter((u) => u.sid === RESIDENT && u.twiml).length, 1);

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

test('parallel: voicemail does not win, fallback only after every technician has failed', async (t) => {
  const s = await setup({ dialMode: 'parallel' });
  t.after(s.close);
  await s.residentAsksForTransfer();

  await s.tech(0).answered();
  await s.tech(0).amd('machine_start');
  await tick();
  assert.equal(s.transfer().status, 'searching', 'the other technician can still accept');
  assert.equal(s.updates.some((u) => u.sid === RESIDENT), false, 'resident is untouched');

  await s.tech(1).status('busy');
  await tick();
  assert.equal(s.transfer().status, 'failed');
  assert.deepEqual(s.outcomes(), ['voicemail', 'busy']);
});

test('winner accepted but resident already gone: technician is told and released', async (t) => {
  const s = await setup();
  t.after(s.close);
  await s.residentAsksForTransfer();
  s.failUpdatesFor.add(RESIDENT);

  await s.tech(0).answered();
  await s.tech(0).press('1');
  await tick();
  const told = s.updates.find((u) => u.sid === s.tech(0).sid() && u.twiml);
  assert.match(told.twiml, /resident is no longer on the line/);
  assert.equal(s.report().result, 'resident hung up');
});

test('announcement: public/connecting.mp3 is played to the resident instead of the spoken line when it exists', async (t) => {
  const s = await setup();
  t.after(s.close);
  fs.mkdirSync(s.config.publicDir, { recursive: true });
  fs.writeFileSync(path.join(s.config.publicDir, 'connecting.mp3'), 'not really audio');

  await s.residentAsksForTransfer();
  await s.tech(0).answered();
  const accept = await s.tech(0).press('1');
  await tick();

  const residentUpdate = s.updates.find((u) => u.sid === RESIDENT && u.twiml);
  assert.match(residentUpdate.twiml, new RegExp(`<Play>${PUBLIC}/public/connecting\\.mp3</Play><Dial><Conference`));
  assert.doesNotMatch(residentUpdate.twiml, /<Say>/);
  assert.match(accept.text, /<Say>Connecting you to the resident\.<\/Say>/, 'technician still hears the spoken line');

  const file = await s.get('/public/connecting.mp3');
  assert.equal(file.status, 200);
  assert.equal(file.text, 'not really audio');
});

test('outbound start: /start-call rings the resident and /twilio/outbound-answer registers direction=outbound', async (t) => {
  const s = await setup();
  t.after(s.close);

  assert.equal((await s.json('/start-call', { to: RESIDENT_NUMBER }, null)).status, 401);
  assert.equal((await s.json('/start-call', { to: 'not-a-number' })).status, 400);

  const started = await s.json('/start-call', { to: RESIDENT_NUMBER });
  assert.equal(started.status, 200);
  const call = s.created[0];
  assert.equal(call.url, `${PUBLIC}/twilio/outbound-answer`);
  assert.equal(call.statusCallback, `${PUBLIC}/twilio/resident-status`);

  const answer = await s.hook('/twilio/outbound-answer', { CallSid: started.body.call_sid, From: '+15559990000', To: RESIDENT_NUMBER, Direction: 'outbound-api' });
  assert.match(answer.text, /<Connect>/);
  assert.equal(s.registered[0].direction, 'outbound');
  assert.equal(s.registered[0].callSid, started.body.call_sid);
});

test('security: bad Twilio signature is 403, tool endpoint needs X-Tool-Secret and not a Twilio signature', async (t) => {
  const s = await setup();
  t.after(s.close);

  const forged = await s.hook('/twilio/inbound', { CallSid: RESIDENT, From: RESIDENT_NUMBER, To: '+15559990000' }, { signature: 'bm90LWEtcmVhbC1zaWduYXR1cmU=' });
  assert.equal(forged.status, 403);
  assert.equal(s.registered.length, 0);

  const forgedAmd = await s.hook(`/tech/amd?resident=${RESIDENT}&tech=0`, { CallSid: RESIDENT, AnsweredBy: 'machine_start' }, { signature: 'bm90LWEtcmVhbC1zaWduYXR1cmU=' });
  assert.equal(forgedAmd.status, 403);

  assert.equal((await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'x' }, null)).status, 401);
  assert.equal((await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'x' }, 'wrong-secret')).status, 401);
  assert.equal((await s.json('/tool/request-transfer', { call_sid: 'nope', summary: 'x' })).status, 400);
  assert.equal((await s.json('/tool/request-transfer', { call_sid: RESIDENT, summary: 'x' })).status, 404, 'unknown call');
});
