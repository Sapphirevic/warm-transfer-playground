'use strict';

// Wraps the ElevenLabs register-call API. It hands back TwiML (<Connect><Stream>)
// that we pass straight to Twilio; Twilio stays in control of the call.
function createRegisterCall(config) {
  return async function registerCall({ fromNumber, toNumber, direction, callSid, firstMessage }) {
    const clientData = { dynamic_variables: { call_sid: callSid } };
    if (firstMessage) {
      // Only honoured if "first message" overrides are enabled in the agent's security settings.
      clientData.conversation_config_override = { agent: { first_message: firstMessage } };
    }

    const response = await fetch(`${config.elevenLabsApiBase}/v1/convai/twilio/register-call`, {
      method: 'POST',
      headers: { 'xi-api-key': config.elevenLabsApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: config.elevenLabsAgentId,
        from_number: fromNumber,
        to_number: toNumber,
        direction,
        conversation_initiation_client_data: clientData,
      }),
      // Twilio gives a webhook 15s; fail before that so we can still answer with a spoken error.
      signal: AbortSignal.timeout(10_000),
    });

    const text = (await response.text()).trim();
    if (!response.ok) {
      throw new Error(`register-call HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    // The API reference types the body as a string, so tolerate both raw XML and a JSON-encoded string.
    const twiml = text.startsWith('"') ? JSON.parse(text) : text;
    if (!twiml.includes('<Response')) {
      throw new Error(`register-call returned something that is not TwiML: ${text.slice(0, 200)}`);
    }
    return twiml;
  };
}

module.exports = { createRegisterCall };
