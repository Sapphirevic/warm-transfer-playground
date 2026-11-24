'use strict';

// Checks the register-call request we send, against a local stand-in for the ElevenLabs API.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRegisterCall } = require('../src/elevenlabs');

const TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://agent.example.test"/></Connect></Response>';

async function stubApi(respond) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(raw) });
      respond(res);
    });
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const config = {
    elevenLabsApiBase: `http://localhost:${server.address().port}`,
    elevenLabsApiKey: 'test-key',
    elevenLabsAgentId: 'agent_test',
  };
  return { seen, registerCall: createRegisterCall(config), close: () => new Promise((resolve) => server.close(resolve)) };
}

test('register-call request shape, and raw XML response', async (t) => {
  const api = await stubApi((res) => res.setHeader('Content-Type', 'application/xml').end(TWIML));
  t.after(api.close);

  const twiml = await api.registerCall({ fromNumber: '+15559990000', toNumber: '+15551110000', direction: 'outbound', callSid: 'CA123' });
  assert.equal(twiml, TWIML);
  assert.equal(api.seen[0].url, '/v1/convai/twilio/register-call');
  assert.equal(api.seen[0].headers['xi-api-key'], 'test-key');
  assert.deepEqual(api.seen[0].body, {
    agent_id: 'agent_test',
    from_number: '+15559990000',
    to_number: '+15551110000',
    direction: 'outbound',
    conversation_initiation_client_data: { dynamic_variables: { call_sid: 'CA123' } },
  });
});

test('first-message override and JSON-encoded string response', async (t) => {
  const api = await stubApi((res) => res.setHeader('Content-Type', 'application/json').end(JSON.stringify(TWIML)));
  t.after(api.close);

  const twiml = await api.registerCall({ fromNumber: '+1555', toNumber: '+1666', direction: 'inbound', callSid: 'CA123', firstMessage: 'Hello again' });
  assert.equal(twiml, TWIML);
  assert.deepEqual(api.seen[0].body.conversation_initiation_client_data, {
    dynamic_variables: { call_sid: 'CA123' },
    conversation_config_override: { agent: { first_message: 'Hello again' } },
  });
});

test('API error is thrown with status and body', async (t) => {
  const api = await stubApi((res) => {
    res.statusCode = 401;
    res.end('{"detail":"invalid api key"}');
  });
  t.after(api.close);

  await assert.rejects(
    api.registerCall({ fromNumber: '+1555', toNumber: '+1666', direction: 'inbound', callSid: 'CA123' }),
    /register-call HTTP 401.*invalid api key/
  );
});
