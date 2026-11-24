# Warm-transfer playground (Twilio + ElevenLabs)

> **Branch `agent-stays-on-call`.** On this branch Ava stays on the call with the resident and the technician (a three-way call). On `main` she hands the resident over and leaves. See [Switching between the two versions](#switching-between-the-two-versions).

A small Express server for trying out a warm transfer from an ElevenLabs agent ("Ava") to a human technician.

- Twilio owns the call. Ava is connected with the ElevenLabs **register-call** API. No ElevenLabs telephony, no phone-number import.
- Register-call cannot transfer calls, so everything is done with Twilio conferences.

## How a call works on this branch

The resident, Ava and the technician all sit in one Twilio conference room, `room-<resident call_sid>`.

1. The resident's call goes straight into the room.
2. The server adds Ava to the room as her own call leg. Twilio reaches that leg through a TwiML App whose Voice URL is `/twilio/agent-leg`, and that endpoint returns the ElevenLabs register-call TwiML. The resident hears a second or two of silence, then Ava.
3. Ava calls the `request_transfer` tool with a `summary` and the resident's `call_sid`. The server answers straight away (`"status": "searching"`) and calls technicians in the background. Ava keeps talking with the resident.
4. A technician who picks up hears the summary and "Press 1 to connect to the resident." (up to 3 times). Answering-machine detection runs in the background.
5. The first technician to press 1 wins. Every other technician call is ended at once. The winner hears "Connecting you to the resident." and joins the same room.
6. Everyone hears "A technician has joined the call." That is Ava's cue to introduce the resident and the issue. **Nobody is moved, so Ava's conversation carries on** and she remembers everything said before.
7. If every technician fails, everyone hears "No technician is available right now." and Ava, still on the call, offers to take a message.

Who can end the call:

- The **resident** hanging up ends it for everyone, and cancels any technician calls still ringing.
- The **technician** hanging up leaves the resident with Ava.
- **Ava** ending her conversation leaves the resident with the technician.
- If the resident would be left alone in the room, the server ends the call.

The whole call is recorded, including the part with only Ava.

## Requirements

- Node.js 18 or newer
- A Twilio account with one voice-capable number
- An ElevenLabs agent
- An ngrok account (the ngrok package is included in the project)

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

Put your ngrok authtoken in `.env` as `NGROK_AUTHTOKEN` (from https://dashboard.ngrok.com/get-started/your-authtoken), then run this in its own terminal and leave it open:

```powershell
npm run tunnel
```

It opens the tunnel and writes the public URL into `PUBLIC_BASE_URL` in `.env`. The server validates Twilio signatures against `PUBLIC_BASE_URL` + the request path, so this value must be exactly the host Twilio calls.

### 3. Create the TwiML App for Ava's leg (this branch only)

```powershell
node scripts/setup-agent-app.js
```

This creates a TwiML App named "Warm transfer playground - Ava leg" in your Twilio account, with the Voice URL `PUBLIC_BASE_URL/twilio/agent-leg`, and writes its SID into `.env` as `TWILIO_AGENT_APP_SID`. The server will not start without it.

Run the same command again whenever `PUBLIC_BASE_URL` changes; it then updates the existing app's URL. You can also do this by hand in the Twilio Console under TwiML Apps.

### 4. Configure the ElevenLabs agent

**Audio format.** Twilio sends and expects μ-law 8000 Hz. Set both directions on the agent:

- Voice section: TTS output format = **μ-law 8000 Hz**
- Advanced section: user input audio format = **μ-law 8000 Hz**

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

`call_sid` is always the **resident's** Twilio call SID, even though Ava is on her own leg.

**Prompt.** Ava now hears the resident and the technician as one audio stream and cannot tell them apart by herself. Add something like this to her system prompt and adjust it to taste:

> When the resident needs a technician, call `request_transfer` with a short summary. When it returns "searching", tell the resident you are finding a technician and keep talking with them. You stay on the call.
>
> When you hear "A technician has joined the call", a technician is now on the line with you and the resident. Greet the technician, introduce the resident by name and summarise the issue in one or two sentences. After that, let the two of them talk: stay silent unless someone addresses you by name or asks you something.
>
> When you hear "No technician is available right now", apologise and offer to take a message.

Two ElevenLabs system tools make this work better: **Skip turn**, so Ava can stay silent while the two humans talk, and **End call**, if you want Ava to say goodbye and leave after the introduction (the resident and technician stay connected).

**First-message override (optional here).** It is only used in one rare case: Ava's leg dropped during the search and no technician was found, so she is brought back with "Sorry, no technician is available right now. Can I take a message?" For that to work, enable overrides for **First message** in the agent's **Security** settings.

### 5. Run the server

```powershell
npm start
```

The startup lines should include `transfer    : agent stays on the call`.

### 6. Start a test call (outbound, the default)

This rings the person playing the resident, so the shared Twilio number's webhook does not need to change:

```powershell
node scripts/start-call.js +15551234567
```

`/start-call` requires the `X-Tool-Secret` header (the script sends it) because the server is reachable from the internet through ngrok and this endpoint places phone calls.

### Alternative: inbound calls

If you can change the number's configuration: Twilio Console > Phone Numbers > your number > Voice configuration > **A call comes in** = Webhook, `POST`, `https://<your-ngrok-host>/twilio/inbound`. Then call the number. No "Call status changes" URL is needed: the conference ending tells the server the resident hung up.

## Endpoints

| Endpoint | Called by | Purpose |
| --- | --- | --- |
| `POST /start-call` | you (`X-Tool-Secret`) | Ring the resident. Body: `{"to": "+1..."}` |
| `POST /twilio/outbound-answer` | Twilio | Resident answered an outbound call. Puts them in their room |
| `POST /twilio/inbound` | Twilio | Resident called the number. Puts them in their room |
| `POST /twilio/agent-leg` | Twilio (TwiML App) | Ava's leg. Calls register-call and returns the ElevenLabs stream TwiML |
| `POST /twilio/resident-status` | Twilio | Status of an outbound-started resident call. A hang-up cancels the search |
| `POST /tool/request-transfer` | ElevenLabs (`X-Tool-Secret`) | Start the technician search. Body: `{"summary": "...", "call_sid": "CA..."}` |
| `POST /tech/answered` | Twilio | Technician picked up. Plays the summary + "Press 1" prompt straight away |
| `POST /tech/amd` | Twilio | Async answering-machine detection result. A machine is hung up and counted as voicemail |
| `POST /tech/accept` | Twilio | Technician pressed a key. `1` wins the lock and joins the room |
| `POST /tech/status` | Twilio | Technician call status: ringing, answered, busy, no-answer, failed, completed |
| `POST /conference/status` | Twilio | Who joined and left the room, and the recording callback |
| `POST /conference/announce` | Twilio | The line spoken to the room ("A technician has joined the call." / "No technician is available right now.") |
| `GET /reports` | your browser, on this machine only | HTML table of all transfers, newest first |
| `GET /reports/:sid` | your browser, on this machine only | Detail view for one resident call |
| `GET /public/...` | Twilio | Optional audio files, such as `public/connecting.mp3` |
| `GET /health` | anyone | Liveness check |

There is no `/twilio/fallback` on this branch: Ava never leaves, so there is nothing to reconnect.

All Twilio endpoints reject requests without a valid `X-Twilio-Signature` (HTTP 403). The two non-Twilio endpoints reject requests without the right `X-Tool-Secret` (HTTP 401). The report pages are refused (HTTP 403) for anything that arrives through the tunnel.

## Transfer reports

Every transfer is saved as `reports/<resident_call_sid>.json` and updated as the search progresses. Open the reports in a browser on the machine running the server:

- http://localhost:3000/reports lists all transfers, newest first
- http://localhost:3000/reports/CA... shows one transfer; add `?format=json` to either URL for the raw data

The **Agent** column shows `stays` for transfers made on this branch and `leaves` for ones made on `main`, so runs of the two versions can be compared side by side. Reports are shared between branches because `reports/` is not tracked by git.

Each record holds the resident's number and call SID, the summary, the dial mode, the start time (the tool call), the final result and how long the resident waited. For each technician it holds the number, when they were dialled, when their phone rang, when they answered, the outcome, and each of those as seconds from the tool call.

| Result | Meaning | Resident wait is measured to |
| --- | --- | --- |
| `connected` | A technician accepted and joined the room | the technician joining the room |
| `no technician` | Every technician failed | the moment the last technician failed |
| `resident hung up` | The resident left during the search | the hang-up |

| Technician outcome | Meaning |
| --- | --- |
| `accepted` | Pressed 1 and won |
| `declined` | Pressed another key, pressed nothing for 3 prompts, or hung up |
| `no-answer` | Rang out |
| `busy` | Line was busy |
| `voicemail` | Answering machine detected |
| `canceled` | We ended the call: another technician accepted, or the resident hung up |
| `failed` | Twilio could not place the call (the reason is in `detail`) |
| `not-called` | Never dialled, because the search ended first (sequential mode) |

The report pages are only served to `localhost`, not through the ngrok URL, because they contain phone numbers and call summaries.

## Announcement audio

When the technician joins, the room hears the spoken line "A technician has joined the call." To use a recording instead, save it as `public/connecting.mp3`; the server checks for the file each time. Ava listens for this line, so if you replace it with a recording, make the recording say the same words or change her prompt to match.

## Logs

Every webhook is logged with its call SIDs and status fields. Lines worth knowing on this branch:

```
RESIDENT resident=CA1f... -> room-CA1f..., Ava will be added
AGENT adding Ava to room-CA1f... leg=CA7b...
REGISTER-CALL ok resident=CA1f... direction=outbound
CONFERENCE agent joined room-CA1f... call=CA7b... (now 2 in the room)
WINNER tech#0 +15550000001 call=CA9c... resident=CA1f...
CONFERENCE technician joined room-CA1f... call=CA9c... (now 3 in the room)
ANNOUNCE "A technician has joined the call." in room-CA1f...
TRANSFER CONNECTED resident=+15551110000 call=CA1f... technician=+15550000001 waited=22.1s mode=parallel tried=[...] report=/reports/CA1f...
```

`TIMING` lines show seconds since the tool call, and a `TIMING SUMMARY` is printed when the technician joins (tool call, first technician ringing, technician answered, pressed 1, technician joined). Each technician call the server ends is logged as `CANCEL tech#N ... was=ringing sent status=canceled (reason)`; Twilio errors as `ERROR cancel ...` with the error code.

## Test checklist

Run these with real phones. Repeat the starred ones with `DIAL_MODE=parallel`.

| # | Case | How to test | Expected |
| --- | --- | --- | --- |
| 1 | Ava joins | Start a call and answer as the resident | A second or two of silence, then Ava greets you. Log: `AGENT adding Ava`, `REGISTER-CALL ok`, `CONFERENCE agent joined` |
| 2 | Accept, three-way * | Ask for a technician; technician presses 1 | Technician hears "Connecting you to the resident." Everyone hears "A technician has joined the call." Ava introduces the resident and the issue. All three can hear each other. Log: `WINNER`, `CONFERENCE technician joined ... (now 3 in the room)`, `TRANSFER CONNECTED` |
| 3 | Ava remembers | After the technician joins, ask Ava something from earlier in the call | She answers from the same conversation |
| 4 | Technician leaves | Technician hangs up | Resident is still talking to Ava |
| 5 | Ava leaves | Have Ava end her conversation while the technician is on | Resident and technician stay connected |
| 6 | Resident leaves | Resident hangs up | Call ends for the technician and Ava |
| 7 | Decline | Technician 1 presses 2 (or hangs up) | Log: `-> declined`. Sequential: technician 2 rings. Resident is still with Ava |
| 8 | No answer | Let technician 1 ring out (about 20s) | Log: `-> no-answer`, then technician 2 is dialled |
| 9 | Voicemail * | Let technician 1's voicemail pick up | Log: `AnsweredBy=machine_start`, `-> voicemail`, `CANCEL ... sent status=completed` |
| 10 | All fail | Every technician declines or does not answer | Everyone hears "No technician is available right now." Ava offers to take a message, in the same conversation. Log: `TRANSFER NO TECHNICIAN`, `ANNOUNCE` |
| 11 | Resident hangs up while waiting | Resident hangs up while a technician phone is ringing | Log: `RESIDENT gone`, `CANCEL ... (resident hung up)`, `TRANSFER RESIDENT HUNG UP`. The technician phone stops ringing |
| 12 | Race (parallel only) * | Two technicians answer, both press 1 | Exactly one `WINNER`. The other hears "Another technician has already taken this call." |

After each case, open http://localhost:3000/reports and check the result, the outcomes and the wait time.

The same logic runs without phones in the automated simulation (a fake Twilio client and signed webhook requests):

```powershell
npm test
```

That checks the server's decisions. It does not prove behaviour on a real call; see the next section.

## Not yet proven on a real call

This branch was built from Twilio's API documentation and checked only in simulation. These are the points to watch on the first real call:

- **Ava's leg.** Adding a TwiML App to a conference (`to: "app:<APP_SID>"`) is documented by Twilio, but it has not been run here with an ElevenLabs stream on the other end. If Ava never speaks, look for `ERROR could not add Ava` or `ERROR /twilio/agent-leg` in the log.
- **Which resident the leg is for.** The server passes the resident's call SID to the TwiML App as a custom parameter. If Twilio delivers it under a different name, the server falls back to "the one call currently waiting for Ava", which is right as long as calls do not start at the same instant.
- **Response delay.** Ava's audio now passes through the conference mixer and an extra call leg, so her replies will be somewhat slower than on `main`, for the whole call.
- **Ava's behaviour in a three-way call.** She reacts to whatever she hears from either person. How well she stays quiet, and whether she picks up the announcement cue, depends on the prompt.

## Trial accounts and Geo Permissions

**Twilio trial accounts**

- A trial account can only call **verified numbers**. Verify the resident's phone and every number in `TECH_NUMBERS` under Console > Phone Numbers > Manage > Verified Caller IDs. A call to an unverified number fails immediately (error 21219).
- Every trial call starts with a **trial message**, and the person who answers must press a key before your TwiML runs. It inflates the timing numbers and can confuse answering-machine detection.

**Geo Permissions**

Twilio blocks outbound calls to countries that are not enabled. Enable the countries of the resident's and technicians' numbers under Console > Voice > Settings > Geo permissions. A blocked country fails with error 21215 and shows as `ERROR could not dial ...`.

## Things to know

- **Live call state is in memory.** Restarting the server forgets calls that are in progress (saved reports are kept).
- **One search per call.** If Ava calls `request_transfer` again on the same call, she is told a search is already running, that a technician is on the call, or that nobody is available.
- **Answering-machine detection is asynchronous.** The summary starts the moment the call is picked up. Only a `machine` or `fax` result does anything: that call is hung up and counted as `voicemail`. A technician who answers with a long greeting can be misclassified.
- **Parallel mode** places one separate call per technician. The other phones stop when one technician presses 1, not when one picks up, so a voicemail cannot cancel the others.
- **Cost.** Ava's leg is an extra call leg that lasts the whole call, in addition to the resident's and the technician's.
- **Recording.** The conference is recorded from the first second, so the recording includes the resident's conversation with Ava. Check the consent rules that apply to you.

## Switching between the two versions

```powershell
git switch main
```

```powershell
git switch agent-stays-on-call
```

Restart the server after switching. `.env` and `reports/` are not tracked by git, so they stay as they are on both branches. `main` ignores `TWILIO_AGENT_APP_SID`.

## Files

- [server.js](server.js): entry point, loads `.env` and starts Express
- [src/app.js](src/app.js): all endpoints and the call logic
- [src/reports.js](src/reports.js): saved transfer records and the `/reports` pages
- [src/elevenlabs.js](src/elevenlabs.js): the register-call request
- [src/config.js](src/config.js): reads and checks environment variables
- [scripts/start-call.js](scripts/start-call.js): helper for `/start-call`
- [scripts/tunnel.js](scripts/tunnel.js): starts ngrok and writes `PUBLIC_BASE_URL` into `.env`
- [scripts/setup-agent-app.js](scripts/setup-agent-app.js): creates or updates the TwiML App for Ava's leg
- [test/](test/): simulated webhook tests (`npm test`)
