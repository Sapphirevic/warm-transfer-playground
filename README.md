# Warm-transfer playground (Twilio + ElevenLabs)

A small Express server for trying out a warm transfer from an ElevenLabs agent ("Ava") to a human technician.

- Twilio owns the call. The server connects it to Ava with the ElevenLabs **register-call** API and returns the TwiML that API gives back. No ElevenLabs telephony, no phone-number import.
- Register-call cannot transfer calls, so the transfer is done with Twilio: a conference room plus a REST update of the resident's live call.

## How a transfer works

1. The resident is talking to Ava. Ava calls the `request_transfer` tool with a `summary` and the resident's `call_sid`.
2. The server answers the tool straight away (`"status": "searching"`) and starts calling technicians in the background. Ava stays on the line with the resident.
3. A technician who picks up immediately hears the summary and "Press 1 to connect to the resident." (repeated up to 3 times). Answering-machine detection runs in the background at the same time.
4. The first technician to press 1 wins. Every other technician call is ended at once. The winner hears "Connecting you to the resident." and is put into conference `room-<resident call_sid>`. Then the resident's call is updated: the resident hears "A technician has answered. Connecting you now." and joins the same room. That update ends Ava's audio stream.
5. Decline, no answer, busy or voicemail: the next technician is tried (`sequential`), or the server waits for the others (`parallel`).
6. If every technician fails, the resident's call is sent to `/twilio/fallback`, which registers the call with Ava again and overrides her first message: "Sorry, no technician is available right now. Can I take a message?"
7. If the resident hangs up during the search, all technician calls are cancelled.

Either side hanging up ends the conference. The conference is recorded.

## Requirements

- Node.js 18 or newer
- A Twilio account with one voice-capable number
- An ElevenLabs agent
- [ngrok](https://ngrok.com/) (or any tunnel that gives you a public https URL)

## Setup

### 1. Install and configure

```powershell
npm install
```

```powershell
Copy-Item .env.example .env
```

Fill in `.env`. Every variable is explained in [.env.example](.env.example). Generate `TOOL_SECRET` with:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 2. Start ngrok

The project includes ngrok as an npm package, so nothing else needs installing. Put your ngrok authtoken in `.env` as `NGROK_AUTHTOKEN` (from https://dashboard.ngrok.com/get-started/your-authtoken), then run this in its own terminal and leave it open:

```powershell
npm run tunnel
```

It opens the tunnel, writes the public URL into `PUBLIC_BASE_URL` in `.env`, and prints the tool URL for ElevenLabs. Start the server after it.

If you prefer the ngrok CLI, run `ngrok http 3000` and copy the `https://...` forwarding URL into `PUBLIC_BASE_URL` yourself (no trailing slash). The server validates Twilio signatures against `PUBLIC_BASE_URL` + the request path, so this value must be exactly the host Twilio calls. If the ngrok URL changes, update `.env` and restart the server, and update the tool URL in ElevenLabs.

### 3. Configure the ElevenLabs agent

**Audio format.** Twilio sends and expects μ-law 8000 Hz. Set both directions on the agent:

- Voice section: TTS output format = **μ-law 8000 Hz**
- Advanced section: user input audio format = **μ-law 8000 Hz**

If either is left at the default you get silence or loud static.

**Allow the first-message override.** In the agent's **Security** settings, enable overrides for **First message**. The fallback ("Sorry, no technician is available right now...") depends on this. If it is off, the override is not applied, so Ava will not say the fallback line (depending on the agent's settings she either opens with her normal greeting or the conversation is refused).

**Create the `request_transfer` tool.** In the agent's tools, add a **Webhook** tool:

| Setting | Value |
| --- | --- |
| Name | `request_transfer` |
| Description | Call this when the resident needs a human technician. It starts a search for a technician and returns immediately. |
| Method | `POST` |
| URL | `https://<your-ngrok-host>/tool/request-transfer` |
| Header | `X-Tool-Secret`: the same value as `TOOL_SECRET` in `.env` |
| Body parameter `summary` | String, filled in by the LLM. Description: "One or two sentences on who is calling and what the problem is. This is read aloud to the technician." |
| Body parameter `call_sid` | String, value type **Dynamic variable**, variable `call_sid` (i.e. `{{call_sid}}`) |

The server passes `call_sid` as a dynamic variable when it registers each call, so the tool always gets the right Twilio call SID without the LLM having to copy it.

**Prompt.** Add something like this to Ava's system prompt:

> When the resident needs a technician, call `request_transfer` with a short summary. When it returns "searching", tell the resident you are finding a technician and stay on the line with them. Do not end the call; it is handed over automatically. If it returns "unavailable", offer to take a message.

### 4. Run the server

```powershell
npm start
```

### 5. Start a test call (outbound, the default)

This rings the person playing the resident, so the shared Twilio number's webhook does not need to change:

```powershell
node scripts/start-call.js +15551234567
```

That script posts to `POST /start-call` on localhost with the `X-Tool-Secret` header from `.env`. The equivalent request by hand:

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/start-call -ContentType 'application/json' -Headers @{ 'X-Tool-Secret' = '<TOOL_SECRET>' } -Body '{"to":"+15551234567"}'
```

When the resident answers, Twilio requests `/twilio/outbound-answer`, which calls register-call with `direction: "outbound"`. Ask Ava for a technician to trigger the transfer.

`/start-call` requires the secret header because the server is reachable from the internet through ngrok, and this endpoint makes it place phone calls.

### Alternative: inbound calls

If you can change the number's configuration: Twilio Console > Phone Numbers > your number > Voice configuration > **A call comes in** = Webhook, `POST`, `https://<your-ngrok-host>/twilio/inbound`. Then call the number.

For inbound calls the server attaches a status callback to each call through the REST API one second after it connects, so it can detect the resident hanging up. If you see `WARN could not attach status callback` in the log, set the number's **Call status changes** URL to `https://<your-ngrok-host>/twilio/resident-status` (`POST`) instead.

## Endpoints

| Endpoint | Called by | Purpose |
| --- | --- | --- |
| `POST /start-call` | you (`X-Tool-Secret`) | Ring the resident. Body: `{"to": "+1..."}` |
| `POST /twilio/outbound-answer` | Twilio | Resident answered an outbound call. register-call with `direction: "outbound"` |
| `POST /twilio/inbound` | Twilio | Resident called the number. register-call with `direction: "inbound"` |
| `POST /twilio/resident-status` | Twilio | Resident call status. A hang-up cancels the search |
| `POST /tool/request-transfer` | ElevenLabs (`X-Tool-Secret`) | Start the technician search. Body: `{"summary": "...", "call_sid": "CA..."}` |
| `POST /tech/answered` | Twilio | Technician picked up. Plays the summary + "Press 1" prompt straight away |
| `POST /tech/amd` | Twilio | Async answering-machine detection result. A machine is hung up and counted as voicemail |
| `POST /tech/accept` | Twilio | Technician pressed a key. `1` wins the lock and joins the conference |
| `POST /tech/status` | Twilio | Technician call status: ringing, answered, busy, no-answer, failed, completed |
| `POST /conference/status` | Twilio | Conference events (start, join, leave, end) and the recording callback |
| `POST /twilio/fallback` | Twilio | All technicians failed. register-call again with the first-message override |
| `GET /reports` | your browser, on this machine only | HTML table of all transfers, newest first |
| `GET /reports/:sid` | your browser, on this machine only | Detail view for one resident call |
| `GET /public/...` | Twilio | Optional audio files, such as `public/connecting.mp3` |
| `GET /health` | anyone | Liveness check |

All Twilio endpoints reject requests without a valid `X-Twilio-Signature` (HTTP 403). The two non-Twilio endpoints reject requests without the right `X-Tool-Secret` (HTTP 401). The report pages are refused (HTTP 403) for anything that arrives through the tunnel.

## Transfer reports

Every transfer is saved as `reports/<resident_call_sid>.json` and updated as the search progresses. Open the reports in a browser on the machine running the server:

- http://localhost:3000/reports lists all transfers, newest first
- http://localhost:3000/reports/CA... shows one transfer; add `?format=json` to either URL for the raw data

Each record holds the resident's number and call SID, the summary, the dial mode, the start time (the tool call), the final result and how long the resident waited. For each technician it holds the number, when they were dialled, when their phone rang, when they answered, the outcome, and each of those as seconds from the tool call.

| Result | Meaning | Resident wait is measured to |
| --- | --- | --- |
| `connected` | A technician accepted and the resident joined them | the resident joining the conference |
| `no technician` | Every technician failed; resident went back to Ava | the moment the last technician failed |
| `resident hung up` | The resident left during the search | the hang-up |

| Technician outcome | Meaning |
| --- | --- |
| `accepted` | Pressed 1 and won |
| `declined` | Pressed another key, pressed nothing for 3 prompts, or hung up |
| `no-answer` | Rang out |
| `busy` | Line was busy |
| `voicemail` | Answering machine detected |
| `canceled` | We ended the call: another technician accepted, or the resident hung up |
| `failed` | Twilio could not place the call (for example a geo-permission or unverified-number error; the reason is in `detail`) |
| `not-called` | Never dialled, because the search ended first (sequential mode) |

The report pages are only served to `localhost`. They are not reachable through the ngrok URL, because they contain phone numbers and call summaries. The JSON files stay on disk across restarts; delete the `reports/` folder to clear them. `reports/` is in `.gitignore`.

## Announcement audio

When a technician accepts, the resident hears the spoken line "A technician has answered. Connecting you now." To use a recording instead, save it as `public/connecting.mp3`. The server checks for the file on every transfer, so no restart is needed. The technician always hears the spoken line "Connecting you to the resident."

## Logs

Every webhook is logged with its call SIDs and status fields:

```
2026-11-24T10:15:02.118Z WEBHOOK POST /tech/status?resident=CA1f...&tech=0 CallSid=CA9c... CallStatus=ringing Direction=outbound-api From=+1555... To=+1555...
```

Timing lines show seconds since the tool call, and a summary is printed when the resident joins the technician:

```
TIMING resident=CA1f... tool_call +0.0s after tool call
TIMING resident=CA1f... first_tech_ringing +1.4s after tool call tech#0 +15551110001
TIMING resident=CA1f... tech_answered +7.9s after tool call tech#0 +15551110001
TIMING resident=CA1f... tech_pressed_1 +19.6s after tool call tech#0 +15551110001
TIMING resident=CA1f... resident_joined +20.3s after tool call conference=CF...
TIMING SUMMARY resident=CA1f... winner=tech#0 +15551110001
  tool_call           2026-11-24T10:15:00.702Z  +0.0s
  first_tech_ringing  2026-11-24T10:15:02.118Z  +1.4s
  tech_answered       2026-11-24T10:15:08.611Z  +7.9s
  tech_pressed_1      2026-11-24T10:15:20.340Z  +19.6s
  resident_joined     2026-11-24T10:15:21.015Z  +20.3s
  => resident waited 20.3s from tool call to joining the technician
```

In the summary, `tech_answered` and `tech_pressed_1` are the winning technician's times. `all_technicians_failed` and `resident_hung_up` are logged the same way.

When a transfer finishes, one line sums it up (the same data is in the saved report):

```
TRANSFER CONNECTED resident=+15551110000 call=CA1f... technician=+15550000002 waited=31.2s mode=sequential tried=[+15550000001=no-answer, +15550000002=accepted] report=/reports/CA1f...
```

The other endings are `TRANSFER NO TECHNICIAN` and `TRANSFER RESIDENT HUNG UP`.

Each technician call the server ends is logged with the call's last known state and the status sent to Twilio (`canceled` for a queued or ringing call, `completed` for an answered one). A Twilio error is logged as `ERROR cancel ...` with its error code:

```
CANCEL tech#0 +15550000001 call=CA9c... was=ringing sent status=canceled (another technician accepted)
``` The recording URL is logged as `RECORDING completed ...` after the conference ends.

## Test checklist

Use two technician phones in `TECH_NUMBERS` where you can. Run each case in `sequential` mode, then repeat the starred ones with `DIAL_MODE=parallel`.

| # | Case | How to test | Expected |
| --- | --- | --- | --- |
| 1 | Accept * | Technician answers and presses 1 | Technician hears "Connecting you to the resident." then hold music briefly. Resident hears "A technician has answered. Connecting you now." and joins; Ava is gone. Log: `WINNER`, `BRIDGE`, `TIMING SUMMARY`, `TRANSFER CONNECTED`. Hanging up on either side ends the other call. A `RECORDING completed` line follows |
| 2 | Decline | Technician 1 presses 2 (or hangs up) | Log: `-> declined`. Sequential: technician 2 rings. Resident is still with Ava |
| 3 | No answer | Let technician 1 ring out (about 20s) | Log: `CallStatus=no-answer`, `-> no-answer`, then technician 2 is dialled |
| 4 | Voicemail * | Let technician 1's voicemail pick up | Log: `WEBHOOK POST /tech/amd ... AnsweredBy=machine_start`, `-> voicemail`, `CANCEL ... sent status=completed`. Parallel: the other technician can still press 1 and win |
| 5 | No key pressed | Technician answers and stays silent | The prompt plays 3 times, then the call hangs up. Log: `-> declined (no key pressed after 3 prompts)` |
| 6 | All fail | Every technician declines or does not answer | Log: `all_technicians_failed`, `TRANSFER NO TECHNICIAN`, then `WEBHOOK POST /twilio/fallback` and `REGISTER-CALL ok ... with first-message override`. Ava says "Sorry, no technician is available right now. Can I take a message?" |
| 7 | Resident hangs up while waiting | Resident hangs up while a technician phone is ringing | Log: `resident_hung_up`, `CANCEL tech#0 ... sent status=canceled (resident hung up)`, `TRANSFER RESIDENT HUNG UP`. The technician phone stops ringing and nobody else is dialled |
| 8 | Race (parallel only) * | Two technicians answer, both press 1 | Exactly one `WINNER`. The other hears "Another technician has already taken this call." |
| 9 | Others cancelled (parallel only) * | One technician presses 1 while another phone is still ringing | The ringing phone stops at once. Log: `CANCEL ... was=ringing sent status=canceled (another technician accepted)` |
| 10 | Bad secret | Send `/tool/request-transfer` without `X-Tool-Secret` | HTTP 401, nothing is dialled |

After each case, open http://localhost:3000/reports and check that the result, the technician outcomes and the wait time match what happened.

The same cases run without phones in the automated simulation, which uses a fake Twilio client and signed webhook requests:

```powershell
npm test
```

That checks the server's logic. It does not prove behaviour on a real call (audio, AMD accuracy, ElevenLabs accepting the override), so the phone checklist above is still needed.

## Trial accounts and Geo Permissions

**Twilio trial accounts**

- A trial account can only call **verified numbers**. Verify the resident's phone and every number in `TECH_NUMBERS` under Console > Phone Numbers > Manage > Verified Caller IDs. A call to an unverified number fails immediately (error 21219). The log shows `ERROR could not dial tech#N` and the search moves on to the next technician.
- Every trial call starts with a **trial message**, and the person who answers must press a key before your TwiML runs. The resident hears it on outbound-started calls and each technician hears it before the summary. Tell your testers to expect it. It also inflates the timing numbers and can confuse answering-machine detection, so take wait-time measurements for a report on an upgraded account.

**Geo Permissions**

Twilio blocks outbound calls to countries that are not enabled. Enable the countries of the resident's and technicians' numbers under Console > Voice > Settings > Geo permissions. A blocked country fails with error 21215 and shows up in the log the same way (`ERROR could not dial ...`).

## Things to know

- **Live call state is in memory.** Restarting the server forgets calls that are in progress (saved reports are kept). A tool call for a call the server does not know returns HTTP 404.
- **One search per call.** If Ava calls `request_transfer` again on the same call, she is told a search is already running, or that no technician is available if it already failed. Start a new call to test again.
- **Answering-machine detection is asynchronous.** The summary starts the moment the call is picked up, and Twilio reports the detection result separately a few seconds later. Only a `machine` or `fax` result does anything: that call is hung up and counted as `voicemail`. `human` and `unknown` change nothing, which is safe because a voicemail cannot press 1. Two consequences: a voicemail hears the start of the summary before it is cut off (normally during its own greeting, so before it records), and a technician who answers with a long greeting can be misclassified as a machine and hung up. A machine result that arrives after the technician pressed 1 is ignored.
- **Parallel mode** places one separate call per technician. It does not use a single `<Dial>` with several `<Number>`s, because a voicemail would count as "answered" there and cancel the other technicians.
- **Recording.** The conference between resident and technician is recorded from the start. Recordings appear in the Twilio Console under Monitor > Logs > Call recordings. Check the consent rules that apply to you before using this with real callers.
- **Hold audio.** Whoever enters the room first hears `HOLD_MUSIC_URL` (Twilio's classical hold music by default).

## Files

- [server.js](server.js): entry point, loads `.env` and starts Express
- [src/app.js](src/app.js): all endpoints and the transfer logic
- [src/reports.js](src/reports.js): saved transfer records and the `/reports` pages
- [src/elevenlabs.js](src/elevenlabs.js): the register-call request
- [src/config.js](src/config.js): reads and checks environment variables
- [scripts/start-call.js](scripts/start-call.js): helper for `/start-call`
- [scripts/tunnel.js](scripts/tunnel.js): starts ngrok and writes `PUBLIC_BASE_URL` into `.env`
- [test/](test/): simulated webhook tests (`npm test`)
