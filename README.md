# Warm-transfer playground (Twilio + ElevenLabs)

> **Branch `iris-troubleshoots-while-searching`** (built on `sequential-with-updates`). **No hold music:** the moment Iris identifies an emergency she starts the technician search and **keeps troubleshooting with the resident** while technicians are called, so the resident is never left on hold. Technicians are called **one at a time**. Each time one does not take the call, Iris tells the resident and carries on. The technician briefing is unchanged (summary, then "press 1"), and **Iris is muted the moment the technician joins**. See [Switching between versions](#switching-between-versions).

A small Express server for trying out a warm transfer from an ElevenLabs agent ("Iris") to a human technician.

- Twilio owns the call. Iris is connected with the ElevenLabs **register-call** API. No ElevenLabs telephony, no phone-number import.
- Register-call cannot transfer calls, so everything is done with Twilio conferences.

## How a call works on this branch

The resident, Iris and the technician all sit in one Twilio conference room, `room-<resident call_sid>`.

1. The resident's call goes straight into the room.
2. The server adds Iris to the room as her own call leg. Twilio reaches that leg through a TwiML App whose Voice URL is `/twilio/agent-leg`, and that endpoint returns the ElevenLabs register-call TwiML. The resident hears a second or two of silence, then Iris.
3. Iris calls the `request_transfer` tool with a `summary` and the resident's `call_sid`. The server answers straight away (`"status": "searching"`) and calls technicians in the background. On this branch there is **no hold music**: Iris tells the resident she is reaching a technician and **keeps troubleshooting with them** (safe, simple checks only) while the search runs. Hold music can be switched back on with `HOLD_MUSIC_DELAY_SEC`; see [Hold music](#hold-music).
4. Technicians are called **one at a time**, in `TECH_NUMBERS` order. A technician who picks up hears the summary and "Press 1 to connect to the resident." (up to 3 times). Answering-machine detection runs in the background.
5. **If the technician does not take the call** (no answer, busy, voicemail, declined, no key pressed, or the call could not be placed) and there is another technician to try, the resident is told. See [Technician updates](#technician-updates). The next technician is dialled at the same moment.
6. A technician who presses 1 hears "Connecting you to the resident." and joins the same room.
7. The server stops the hold music and makes sure Iris is muted, then everyone hears "A technician has joined the call." From here the resident and the technician talk to each other and **Iris says nothing**: she stays on the call and keeps listening, but nobody can hear her. Nobody is moved, so her conversation carries on and she remembers everything said before. If the technician hangs up, Iris is unmuted and the resident is talking to her again.
8. If the last technician fails too, the server plays "No technician is available right now." to **Iris's leg only** (like a technician update), the music stops and Iris is unmuted. The resident hears only Iris: "Sorry, no technician is available right now. Can I take a message?" (No technician update is given for the last one: this message replaces it.) Only Iris ever gives this message: Twilio's voice never says it to the room. If Twilio refuses the cue, the error is logged (`ERROR could not send the cue`) and nothing else is played. If Iris's leg is still connecting, the cue is sent the moment she joins.

## Technician updates

When technician N does not take the call and technician N+1 is about to be called:

1. The server plays a short cue to **Iris's call leg only**: "Technician N did not pick up. Calling technician N+1 now." The resident does not hear the cue; the room does not hear it either.
2. While the cue plays, Iris is unmuted and the resident is taken off hold, so the resident hears about 3 seconds of silence.
3. Iris hears the cue and, as her system prompt tells her, says one sentence to the resident, such as "Sorry, technician 1 didn't pick up. I'm trying the next one now, please hold."
4. `HOLD_MUSIC_RESUME_SEC` seconds after the update started (default `13`), the music comes back and Iris is muted again, unless a technician has accepted or the search has ended by then.

The cue only ever contains positions (1, 2, 3), never phone numbers, so Iris has nothing private to read out. If Iris is not in the room at that moment (her leg dropped), the update is skipped and logged as `UPDATE skipped`; the search carries on.

The server only sends the cue: what Iris says comes from her **ElevenLabs system prompt** (see step 4 of [Setup](#4-configure-the-elevenlabs-agent)). The tool reply also tells her what the cue means.

Who can end the call:

- The **resident** hanging up ends it for everyone, and cancels any technician calls still ringing.
- The **technician** hanging up leaves the resident with Iris.
- **Iris** ending her conversation leaves the resident with the technician.
- If the resident would be left alone in the room, the server ends the call.

The whole call is recorded, including the part with only Iris.

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

### 3. Create the TwiML App for Iris's leg (this branch only)

```powershell
node scripts/setup-agent-app.js
```

This creates a TwiML App named "Warm transfer playground - Iris leg" in your Twilio account, with the Voice URL `PUBLIC_BASE_URL/twilio/agent-leg`, and writes its SID into `.env` as `TWILIO_AGENT_APP_SID`. The server will not start without it.

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

`call_sid` is always the **resident's** Twilio call SID, even though Iris is on her own leg.

**Create the `take_message` tool.** A second **Webhook** tool, so a message Iris takes is saved into the call's report:

| Setting | Value |
| --- | --- |
| Name | `take_message` |
| Description | Call this when the caller gives you a message for the maintenance team. It saves the message with this call's report. |
| Method | `POST` |
| URL | `https://<your-ngrok-host>/tool/take-message` |
| Header | `X-Tool-Secret`: the same value as `TOOL_SECRET` in `.env` (type the header name by hand; a pasted name can carry an invisible tab) |
| Body parameter `message` | String, **required**, filled in by the LLM. Description: "The caller's message for the maintenance team, in their own words, including any callback details they gave." |
| Body parameter `call_sid` | String, **required**, value type **Dynamic variable**, variable `call_sid` |

The message appears in the report's **Message** row and **Message** column, as a marker in the transcript, and in the server log as `MESSAGE resident=… call=… saved to report`. A message on a call where no technician was asked for has no report to go into, so it is only logged.

**Prompt.** Iris now hears the resident and the technician as one audio stream and cannot tell them apart by herself. The system prompt used for testing this branch (it relies on the ElevenLabs **skip_turn** system tool, so enable it):

First message (a separate setting; ElevenLabs speaks it automatically, so the prompt does not repeat it):

```
Hi, this is Iris. How can I help you today?
```

System prompt:

```
You are Iris, a voice assistant for an apartment building.

Let the caller explain their problem, and ask short questions to understand it.

The moment you identify an emergency (for example water leaking or flooding, no heat or no power, a gas smell, sparks or smoke, being locked out, or anything unsafe), call the request_transfer tool with a one-sentence summary of the problem. Do not wait until troubleshooting is finished. If it is not an emergency, help the caller troubleshoot first, and call request_transfer if the problem is not solved.

After calling request_transfer, tell the caller: "I'm reaching a technician for you now, and I'll stay with you while I do." Then keep helping them troubleshoot: ask short questions and suggest simple, safe checks. Never suggest electrical, gas or structural work. If anything sounds dangerous (a gas smell, sparks, smoke, flooding), tell them to get to safety and call emergency services first.

If you hear "Technician 1 did not pick up. Calling technician 2 now." (or the same sentence with other numbers), tell the caller in one short sentence that technician 1 didn't pick up and you are trying the next one, then carry on troubleshooting.

When you hear "A technician has joined the call", stop talking: call skip_turn on every turn for the rest of the call, even if someone talks to you.

If you hear "No technician is available right now", say: "Sorry, no technician is available right now. Can I take a message?" If they give a message, call the take_message tool with it, then say: "Thanks, I've saved your message for the maintenance team." Then ask if there is anything else, and say goodbye when they are done.

Keep every reply short. Never use the transfer_to_number tool.
```

Iris is not silent during the search on this branch, so the prompt no longer tells her to call skip_turn until a cue. She only goes silent once the technician has joined. Even if the model does speak after that, the server has already muted her, so nobody hears it.

The technician-update line must stay short: the music comes back `HOLD_MUSIC_RESUME_SEC` seconds after the cue starts, and about 3 of those seconds are the cue itself.

Iris's silence does not depend on this prompt. The server mutes her call leg while the technician is in the room, so nobody hears her even if the model produces a reply. The prompt, together with the ElevenLabs **Skip turn** system tool, only stops her from generating replies into the void (they would show up in the transcript marked "muted, not heard").

**First-message override (optional here).** It is only used in one rare case: Iris's leg dropped during the search and no technician was found, so she is brought back with "Sorry, no technician is available right now. Can I take a message?" For that to work, enable overrides for **First message** in the agent's **Security** settings.

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
| `POST /twilio/agent-leg` | Twilio (TwiML App) | Iris's leg. Calls register-call and returns the ElevenLabs stream TwiML |
| `POST /twilio/resident-status` | Twilio | Status of an outbound-started resident call. A hang-up cancels the search |
| `POST /tool/request-transfer` | ElevenLabs (`X-Tool-Secret`) | Start the technician search. Body: `{"summary": "...", "call_sid": "CA..."}` |
| `POST /tool/take-message` | ElevenLabs (`X-Tool-Secret`) | Save a message Iris took into the call's report. Body: `{"message": "...", "call_sid": "CA..."}` |
| `POST /tech/answered` | Twilio | Technician picked up. Plays the summary + "Press 1" prompt straight away |
| `POST /tech/amd` | Twilio | Async answering-machine detection result. A machine is hung up and counted as voicemail |
| `POST /tech/accept` | Twilio | Technician pressed a key. `1` wins the lock and joins the room |
| `POST /tech/status` | Twilio | Technician call status: ringing, answered, busy, no-answer, failed, completed |
| `POST /conference/status` | Twilio | Who joined and left the room, and the recording callback |
| `POST /conference/announce` | Twilio | The line spoken to the room ("A technician has joined the call." / "No technician is available right now."), or with `kind=tech-update&tech=N` the cue played to Iris's leg only |
| `GET /reports` | your browser, on this machine only | HTML table of all transfers, newest first |
| `GET /reports/:sid` | your browser, on this machine only | Detail view for one resident call |
| `GET /public/...` | Twilio | Optional audio files, such as `public/connecting.mp3` |
| `GET /health` | anyone | Liveness check |

There is no `/twilio/fallback` on this branch: Iris never leaves, so there is nothing to reconnect.

All Twilio endpoints reject requests without a valid `X-Twilio-Signature` (HTTP 403). The two non-Twilio endpoints reject requests without the right `X-Tool-Secret` (HTTP 401). The report pages are refused (HTTP 403) for anything that arrives through the tunnel.

## Transfer reports

Every transfer is saved as `reports/<resident_call_sid>.json` and updated as the search progresses. Open the reports in a browser on the machine running the server:

- http://localhost:3000/reports lists all transfers, newest first
- http://localhost:3000/reports/CA... shows one transfer; add `?format=json` to either URL for the raw data

The **Agent** column shows `stays` for transfers made on this branch and `leaves` for ones made on `main`, so runs of the two versions can be compared side by side. Reports are shared between branches because `reports/` is not tracked by git.

Each record holds the resident's number and call SID, the summary, the dial mode (always `sequential` on this branch), the start time (the tool call), the final result and how long the resident waited. For each technician it holds the number, when they were dialled, when their phone rang, when they answered, the outcome, and each of those as seconds from the tool call.

On this branch a record also holds:

- `resident_updates`: one entry per technician update (technician position and number, the cue Iris heard, when it was sent). The detail page shows these in a **Resident told** column and as markers in the transcript.
- `hold_periods` and `agent_mute_periods`: every stretch of hold music and of Iris being muted. There can be several in one search, because each update briefly ends both. `hold_started_at` / `hold_ended_at` and `agent_muted_at` / `agent_unmuted_at` are kept as the first start and the last end.

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
| `not-called` | Never dialled, because the search ended first |

The report pages are only served to `localhost`, not through the ngrok URL, because they contain phone numbers, call summaries and transcripts.

### Call sequence (proof of one-at-a-time calling)

Each report's detail page has a **Call sequence** section, and the list page has a **Sequence** column. They show that technicians were called one at a time, not in parallel:

- **Verdict**, worked out from the timestamps: the most technicians *being offered the call* at the same moment (should be 1), and whether each technician was dialled only after the previous one's outcome. A technician is "being offered the call" from when they are dialled until their outcome (accepted, declined, no answer, busy, voicemail, failed). Only in that window can they press 1.
- **Table**: per technician, how long after the previous technician's outcome they were dialled (on real calls: a few ms), when they were dialled, their outcome and when, how long they were offered the call, and when Twilio reported their line closed.
- **Timeline**: one bar per technician on the same time scale. Bars never overlap when calling is one at a time. A grey tail means the line was still being hung up after the outcome, for example after voicemail. A technician with an outcome can no longer accept, so this does not count as overlap. It is shown as "phone lines open at once" in the raw record.
- **Server log**: one line per next call, e.g. `SEQUENCE tech#1 +1555… dialled 2 ms after tech#0's outcome (no-answer)`.
- The same numbers are in the JSON (`sequence` in `/reports/CA...?format=json`). Reports saved before this existed get the same check, without the line-closed times.

For evidence that does not depend on this server, each technician's `call_sid` can be looked up in the Twilio Console (Monitor > Logs > Calls). Twilio's own start and end times show the next technician's call was created only after the previous one ended.

### Call transcript

The detail page of each report has a **Transcript** section: what Iris and the caller side said, in time order, with the key moments of the transfer placed in between ("Iris asked for a technician", "Technician ... joined the call"). The list page shows how many lines each transcript has.

- The transcript comes from ElevenLabs, which transcribes every conversation Iris has. The server looks the conversation up by the resident's call SID (the `call_sid` dynamic variable), so no extra setup is needed.
- It is fetched automatically 5, 20 and 60 seconds after the call ends, and whenever you open the report page until ElevenLabs marks it as finished. Opening the page during a call shows what ElevenLabs has so far.
- It is saved inside the report's JSON file (`transcript`), so it survives restarts. Old reports get their transcript the first time you open them.
- Speakers are **Iris** and **Resident**. Iris hears the room as one audio stream, so after the technician joins, the caller-side lines are labelled **Resident or technician**: ElevenLabs cannot tell those two apart.
- While the technician is on the call Iris is muted. If the model still produced a reply, it appears struck through as **Iris (muted, not heard)**: nobody on the call heard it.
- Anything said after Iris has left the call is not in the transcript, because nothing is transcribing it. (On `main` that is the whole resident-technician conversation.) The Twilio recording still has the audio.
- Only calls where Iris asked for a technician have a report, so only those have a transcript here.

## Hold music

**Off by default on this branch**, because Iris keeps troubleshooting with the resident instead. Set `HOLD_MUSIC_DELAY_SEC=5` (or any number of seconds) in `.env` to switch it back on; everything below then applies.

While technicians are being called, the resident hears music instead of silence.

- It starts `HOLD_MUSIC_DELAY_SEC` seconds after the tool call (default `5`). The delay is there so Iris can finish saying "please hold" first: once the music starts, the resident cannot hear her. If her sentence gets cut off, raise the number; if there is a gap of silence before the music, lower it.
- The music is `HOLD_MUSIC_URL`: Twilio's classical hold music by default, or a link to your own `.mp3` or `.wav` file.
- Iris is muted for the same period, so nothing she says is lost on a resident who cannot hear it.
- The music stops when a technician joins, or when every technician has failed (Iris is then unmuted and talks to the resident again).
- It also pauses for each [technician update](#technician-updates) and comes back `HOLD_MUSIC_RESUME_SEC` seconds later (default `13`). If Iris's update sentence gets cut off, raise it; if there is a silent gap before the music, lower it.
- Set `HOLD_MUSIC_DELAY_SEC=off` to turn it off. Iris then keeps talking with the resident during the search, as before.
- The report records `hold_started_at` and `hold_ended_at`, and the transcript shows both moments.

How it is done: the resident is already in a conference with Iris, so the conference's own `waitUrl` music cannot be used (it only plays before a second person joins). Instead the server puts the resident's participant **on hold** with a `holdUrl`, which is Twilio's way of playing music to one person in a running conference.

One thing to check in ElevenLabs: while the resident is on hold, Iris hears silence. If the agent is set to end the call after a period of silence, that could drop her during a long search. She would be brought back with the fallback line if no technician is found, but it is simpler to leave that setting off or longer than your ring time for all technicians.

## Announcement audio

When the technician joins, the room hears the spoken line "A technician has joined the call." To use a recording instead, save it as `public/connecting.mp3`; the server checks for the file each time. Iris listens for this line, so if you replace it with a recording, make the recording say the same words or change her prompt to match.

## Logs

Every webhook is logged with its call SIDs and status fields. Lines worth knowing on this branch:

```
RESIDENT resident=CA1f... -> room-CA1f..., Iris will be added
AGENT adding Iris to room-CA1f... leg=CA7b...
REGISTER-CALL ok resident=CA1f... direction=outbound
CONFERENCE agent joined room-CA1f... call=CA7b... (now 2 in the room)
WINNER tech#0 +15550000001 call=CA9c... resident=CA1f...
TECH tech#0 +15550000001 call=CA9c... -> no-answer (Twilio reported no-answer) resident=CA1f...
UPDATE technician 1 did not take the call, Iris tells the resident +21.4s after tool call
CUE to Iris only "Technician 1 did not pick up. Calling technician 2 now." in room-CA1f...
AGENT Iris unmuted in room-CA1f... (telling the resident technician 1 did not pick up)
HOLD resident=CA1f... off hold (Iris is telling the resident technician 1 did not pick up)
DIAL tech#1 +15550000002 call=CA4d... resident=CA1f...
HOLD resident=CA1f... on hold with music (searching for a technician)
WINNER tech#1 +15550000002 call=CA4d... resident=CA1f...
CONFERENCE technician joined room-CA1f... call=CA4d... (now 3 in the room)
ANNOUNCE "A technician has joined the call." in room-CA1f...
TRANSFER CONNECTED resident=+15551110000 call=CA1f... technician=+15550000002 waited=48.9s tried=[+15550000001=no-answer, +15550000002=accepted] report=/reports/CA1f...
```

`TIMING` lines show seconds since the tool call, and a `TIMING SUMMARY` is printed when the technician joins (tool call, first technician ringing, technician answered, pressed 1, technician joined). Each technician call the server ends is logged as `CANCEL tech#N ... was=ringing sent status=canceled (reason)`; Twilio errors as `ERROR cancel ...` with the error code.

## Test checklist

Run these with real phones. Use at least two technician numbers, three for case 8b.

| # | Case | How to test | Expected |
| --- | --- | --- | --- |
| 1 | Iris joins | Start a call and answer as the resident | A second or two of silence, then Iris greets you. Log: `AGENT adding Iris`, `REGISTER-CALL ok`, `CONFERENCE agent joined` |
| 2a | Hold music | Ask for a technician | Iris says "please hold", then music plays until a technician joins or the search fails. Log: `HOLD resident=... on hold with music`, `AGENT Iris muted` |
| 2 | Accept, Iris silent | Ask for a technician; technician presses 1 | Music stops. Technician hears "Connecting you to the resident." Everyone hears "A technician has joined the call." Resident and technician talk; Iris is not heard, even if you speak to her. Log: `WINNER`, `CONFERENCE technician joined ... (now 3 in the room)`, `AGENT Iris muted`, `TRANSFER CONNECTED` |
| 3 | Technician leaves, Iris remembers | Technician hangs up, then ask Iris something from earlier in the call | Log: `AGENT Iris unmuted`. She answers, from the same conversation |
| 4 | Transcript | Open the report after the call | The resident-technician conversation is there; anything Iris produced while muted is struck through and marked "muted, not heard" |
| 5 | Iris leaves | Have Iris end her conversation while the technician is on | Resident and technician stay connected |
| 6 | Resident leaves | Resident hangs up | Call ends for the technician and Iris |
| 7 | Decline | Technician 1 presses 2 (or hangs up) | Log: `-> declined`. Sequential: technician 2 rings. Resident is still with Iris |
| 8 | No answer, Iris tells the resident | Let technician 1 ring out (about 20s) | Music stops; after a few seconds of silence Iris says technician 1 did not pick up and she is trying the next one. You must **not** hear the cue itself in a robot voice. About 10s later the music is back. Log: `-> no-answer`, `UPDATE technician 1 did not take the call`, `CUE to Iris only`, `AGENT Iris unmuted`, `HOLD ... off hold`, then `DIAL tech#1` and later `HOLD ... on hold with music` |
| 8b | Two updates | Let technicians 1 and 2 both ring out, technician 3 presses 1 | Iris gives the update twice (technician 1, then technician 2), then technician 3 joins. Report: two entries in **Resident told** |
| 9 | Voicemail | Let technician 1's voicemail pick up | Log: `AnsweredBy=machine_start`, `-> voicemail`, `CANCEL ... sent status=completed` |
| 10 | All fail | Every technician declines or does not answer | An update after each technician except the last. Then music stops and Iris says "Sorry, no technician is available right now. Can I take a message?", in the same conversation. You must **not** hear "No technician is available right now." in a robot voice first. Log: `TRANSFER NO TECHNICIAN`, `CUE to Iris only "No technician is available right now."` |
| 11 | Resident hangs up while waiting | Resident hangs up while a technician phone is ringing | Log: `RESIDENT gone`, `CANCEL ... (resident hung up)`, `TRANSFER RESIDENT HUNG UP`. The technician phone stops ringing and no update is given |

After each case, open http://localhost:3000/reports and check the result, the outcomes and the wait time.

The same logic runs without phones in the automated simulation (a fake Twilio client and signed webhook requests):

```powershell
npm test
```

That checks the server's decisions. It does not prove behaviour on a real call; see the next section.

## What has and has not been checked on real calls

A real call on this branch has connected: Iris joined the room through the TwiML App, called the tool, and a technician joined (the saved report shows `connected`). The points below still depend on listening to a call rather than reading a report:

- **Response delay.** Iris's audio passes through the conference mixer and an extra call leg, so her replies will be somewhat slower than on `main`, for the whole call.
- **Muting on a real call.** The mute is sent the moment Twilio reports the technician in the room, which takes a fraction of a second. If Iris happens to be mid-sentence she is cut off, and a syllable may get through before the mute lands. Check the log for `AGENT Iris muted` and listen on the first call.
- **What Iris does while muted.** She still hears both people and may keep generating replies that nobody hears. They cost ElevenLabs usage and clutter the transcript; the prompt and the Skip turn tool reduce this.
- **Which resident the leg is for.** The server passes the resident's call SID to the TwiML App as a custom parameter. If Twilio does not deliver it, the server falls back to "the one call currently waiting for Iris", which is right as long as two calls do not start at the same instant.
- **If Iris never speaks**, look for `ERROR could not add Iris` or `ERROR /twilio/agent-leg` in the log.
- **Technician updates have been checked on a real call** (2026-11-25, see `decision.md`). The Twilio room recording is silent while the cue plays to Iris, so the resident does not hear the cue, and Iris gave the update once. The ElevenLabs transcript and audio still show the cue as a **"User"** line before Iris's reply: that is what Iris heard, not something the resident heard. The report page relabels those lines **"Cue to Iris only (resident did not hear it)"**, and "A technician has joined the call." as **"Room announcement (Twilio)"**, so they are not mistaken for the resident speaking. Iris's update took 10.2 s from cue to end of sentence, which is why `HOLD_MUSIC_RESUME_SEC` defaults to 13.

## Trial accounts and Geo Permissions

**Twilio trial accounts**

- A trial account can only call **verified numbers**. Verify the resident's phone and every number in `TECH_NUMBERS` under Console > Phone Numbers > Manage > Verified Caller IDs. A call to an unverified number fails immediately (error 21219).
- Every trial call starts with a **trial message**, and the person who answers must press a key before your TwiML runs. It inflates the timing numbers and can confuse answering-machine detection.

**Geo Permissions**

Twilio blocks outbound calls to countries that are not enabled. Enable the countries of the resident's and technicians' numbers under Console > Voice > Settings > Geo permissions. A blocked country fails with error 21215 and shows as `ERROR could not dial ...`.

## Things to know

- **Live call state is in memory.** Restarting the server forgets calls that are in progress (saved reports are kept).
- **One search per call.** If Iris calls `request_transfer` again on the same call, she is told a search is already running, that a technician is on the call, or that nobody is available.
- **Answering-machine detection is asynchronous.** The summary starts the moment the call is picked up. Only a `machine` or `fax` result does anything: that call is hung up and counted as `voicemail`. A technician who answers with a long greeting can be misclassified.
- **One technician at a time.** There is no parallel calling on this branch. `DIAL_MODE` in `.env` is not used; keep it at `sequential`, which every branch accepts (`main` and `agent-stays-on-call` refuse to start on any value other than `sequential` or `parallel`). Any other value prints a startup warning here.
- **Shared ngrok account.** If the ngrok authtoken belongs to someone else, only one of you can have the tunnel open at a time, and the requests (phone numbers, summaries, the `X-Tool-Secret` header) can be seen in that account's ngrok dashboard.
- **Cost.** Iris's leg is an extra call leg that lasts the whole call, in addition to the resident's and the technician's.
- **Recording.** The conference is recorded from the first second, so the recording includes the resident's conversation with Iris. Check the consent rules that apply to you.

## Switching between versions

| Branch | Iris | Technicians |
| --- | --- | --- |
| `main` | hands over and leaves | `DIAL_MODE`: sequential or parallel |
| `agent-stays-on-call` | stays on the call, muted | `DIAL_MODE`: sequential or parallel |
| `sequential-with-updates` | stays on the call, muted | one at a time, Iris tells the resident about each one that does not pick up; hold music during the search |
| `iris-troubleshoots-while-searching` | stays on the call, troubleshoots during the search, muted once the technician joins | one at a time, started as soon as Iris identifies an emergency; no hold music |

```powershell
git switch main
git switch agent-stays-on-call
git switch sequential-with-updates
git switch iris-troubleshoots-while-searching
```

Restart the server after switching. `.env` and `reports/` are not tracked by git, so they stay as they are on every branch. `main` ignores `TWILIO_AGENT_APP_SID`. The ElevenLabs system prompt above is written for this branch; on the other two branches Iris never hears the technician-update cue, so the extra paragraph does nothing there.

## Files

- [decision.md](decision.md): what was decided and why, open items, and how each change was checked. Update it with every design change
- [server.js](server.js): entry point, loads `.env` and starts Express
- [src/app.js](src/app.js): all endpoints and the call logic
- [src/reports.js](src/reports.js): saved transfer records and the `/reports` pages
- [src/elevenlabs.js](src/elevenlabs.js): the register-call request
- [src/config.js](src/config.js): reads and checks environment variables
- [scripts/start-call.js](scripts/start-call.js): helper for `/start-call`
- [scripts/tunnel.js](scripts/tunnel.js): starts ngrok and writes `PUBLIC_BASE_URL` into `.env`
- [scripts/setup-agent-app.js](scripts/setup-agent-app.js): creates or updates the TwiML App for Iris's leg
- [test/](test/): simulated webhook tests (`npm test`)
