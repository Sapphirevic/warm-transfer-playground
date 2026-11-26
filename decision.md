# Decision log

What was decided, why, and what is still open. Newest entries at the top of each section.
Update it whenever a design choice is made or changed, and in the same commit as the code.

## Branches

| Branch | Built on | What it is |
| --- | --- | --- |
| `main` | - | Ava hands the resident over to the technician and leaves. `DIAL_MODE` sequential or parallel. |
| `agent-stays-on-call` | `main` | Resident, Ava and technician share one conference. Ava stays, muted while the technician is on. Hold music during the search. Transcripts in reports. |
| `inbound-calls` | - | On the remote; not reviewed in this log yet. |
| `sequential-with-updates` | `agent-stays-on-call` | Technicians called one at a time. Iris (formerly Ava) tells the resident each time one does not pick up. Hold music during the search. |
| `full-call-recording` | `sequential-with-updates` | Samuel's branch (on the fork): Twilio recordings of each person's own line, live transcripts, merged transcript on the report page. Merged into `iris-troubleshoots-while-searching` (D28). |
| `iris-troubleshoots-while-searching` | `sequential-with-updates` | No hold music: Iris starts the search as soon as she identifies an emergency and keeps troubleshooting with the resident; muted once the technician joins. Includes `full-call-recording` (D28). **Current working branch.** |

## Decisions

### 2026-11-26 - the technician waits on hold until Iris has finished (v0.10.0)

**D30. Iris is never cut off at the handover: the technician joins muted, waits on hold, and comes in only once Iris has been quiet for 1.5 s.**

Requested: "when Iris is talking, put the tech on hold and make Iris finish her statement. Do not cut her off."

Before this change:
- The technician entered an open room and could talk at once. On call `CAd7d4…7cde5` they started talking 0.3 s after joining.
- Iris was muted at her first speech-stop, so a pause inside her turn could end it.
- After `HANDOVER_MAX_WAIT_MS` (10 s) she was muted even mid-sentence.

What changed:
- **Joins muted.** The technician's conference TwiML has `muted="true"`, so they can't be heard before the hold lands.
- **On hold at once.** When the handover has to wait (Iris talking, or the 1.5 s grace), the technician is put on hold. They hear "One moment please", then silence (`/conference/tech-hold`), and the room doesn't hear them.
- **Quiet for 1.5 s.** The handover happens only once Iris has been quiet for `HANDOVER_GRACE_MS` (1.5 s). A pause followed by more speech restarts the wait, so a pause between sentences no longer ends her turn.
- **Then, in order:** Iris muted, technician off hold and unmuted (one Twilio update), hold music off if any, then "A technician has joined the call".
- **Safety net raised.** `HANDOVER_MAX_WAIT_MS` goes from 10 s to **30 s**, and reaching it logs a `WARN`. It is only for Twilio never reporting that Iris stopped: the technician can't be left on hold forever, and if the events go missing the server can't know she is still talking.
- **No Iris in the room:** no hold; the technician is unmuted at once.
- **Report:** a new `technician_hold_periods` field shows when the technician was held and released.

Checks:
- 90/90 tests, 3 runs. 15 existing tests now expect the technician's hold and release steps. 2 new tests: the full sequence through a pause in Iris's turn, and the no-Iris case.
- Broken on purpose 3 ways (no hold: 6 fail; hand over at the first pause: 2 fail; join unmuted: 1 fails). Code restored byte-identical.
- The Twilio library (`participant.js`) sends `Muted`, `Hold`, `HoldUrl` and `HoldMethod` in one update, and TwiML `<Conference muted="true">` renders as expected.
- Not yet heard on a real call.

### 2026-11-26 - Iris is told when the technician leaves (v0.9.1)

**D29. A cue to Iris only, "The technician has left the call. Please speak to the caller again.", when the technician hangs up and the resident is still there.**

Call `CAd7d4…7cde5` (16:31 UTC) was the first full run after the merge, and everything up to the handover worked:
- Technician 1 failed after 18.7 s, and technician 2 was dialled 5 ms later.
- Iris gave the update once, from the `update_transfer` reply.
- The brief carried the progress, and newer progress was given on pressing 1.
- Iris finished her sentence and was then muted.
- All three recordings were made, and the live transcripts came through on every line.

The problem came after the technician hung up, 11 s after joining:
- The server unmuted Iris, but nothing told her the technician had gone.
- She had been using `skip_turn` since "A technician has joined the call", as her prompt says, and kept doing so.
- The resident said "Hello? Hello?" twice and got no answer (ElevenLabs transcript, 87 s and 92 s).

What changed:
- **The cue:** when the technician leaves and the resident is still in the room, Iris is unmuted, then gets this cue on her leg only, after a pause like the other cues. It is worded as an instruction, so no prompt change is needed.
- **Handover cancelled:** if the technician leaves while the handover is still waiting for Iris's sentence to end, the handover is cancelled: no mute and no "A technician has joined" announcement.
- **Report labels:** in the ElevenLabs and merged tabs, caller lines after the technician's line closed are labelled "Resident", not "Resident or technician". The cue is labelled "Cue to Iris only".

Checks:
- 88/88 tests, 3 runs. 4 new tests: the cue and its order, the handover cancelled, no cue once the resident has gone, and the labels.
- The real report re-rendered: "Hello? Hello?" is now "Resident" in both tabs.
- Broken on purpose 3 ways (no cue: 3 tests fail; no handover cancel: 1 fails; old label rule: 1 fails). Code restored byte-identical each time.
- Not yet heard on a real call.

### 2026-11-26 - full-call-recording merged in (v0.9.0)

**D28. Merge `fork/full-call-recording` (commit `4ac1868`, Samuel) into this branch.**

What it adds, all on by default:
- **Recordings:** a dual-channel recording of the resident's own line and of each technician's line, next to the room recording, which is always made (`RECORD_LEGS`).
- **Live transcripts:** Twilio Real-Time Transcription of the resident's line, each technician's line (started before their brief), and Iris's leg (`LIVE_TRANSCRIPTION`, `LIVE_TRANSCRIPTION_IRIS_LEG`).
- **Report page:** now in tabs (Merged transcript, ElevenLabs transcript, Twilio transcripts, Recordings, Technicians, Raw record). The report JSON has a new `twilio` section. Recordings play from the page.
- **Post-call transcripts:** Twilio's transcripts of each recording are fetched when a report is opened, where the account has Conversational Intelligence set up.

How the conflicts were resolved: both sides kept.
- The call record keeps our speaker, cue-queue and handover fields, plus their `media`.
- The transfer keeps our `progress` / `progressUpdates`, plus their `media`.
- README banner rewritten for this branch.

Nothing in our flow changed: no hold music, the cue queue, updates through `update_transfer`, the brief with progress, the update on accept, the handover grace, the sequence proof, and messages.

Tests:
- 3 transcript tests failed on `full-call-recording` by itself as well (56/59 there). The page now shows the same lines in the merged tab and the ElevenLabs tab, and the tests searched the whole page. They now look inside the ElevenLabs panel; every original assertion is kept, and the hold-marker count is checked in both tabs.
- The recording flow had no tests, so 2 were added: the whole troubleshooting flow with recording on (no hold music, one at a time, brief with summary, Iris muted only after her sentence, every recording and live line in the report), and everything off.
- To tell Samuel: those 3 tests fail on his branch.

Checks:
- 84/84 tests, 3 runs.
- Config parsed with a dummy environment: defaults on/on/on, `false`/`off`/`0` turn each off, and a bad value is refused.
- Broken on purpose 2 ways (resident line never recorded; Iris's live transcription dropped): 1 test fails each time. Code restored and matched the backup exactly.
- Not yet checked on a real call.

### 2026-11-26 - Iris wraps up before the handover (v0.8.1)

**D27. Handover grace period, and a wrap-up instruction while the technician joins.**

On call `CAf0153c…8659` (15:36 UTC) the D26 changes worked:
- The technician update was given cleanly via the tool reply ("Technician one didn't pick up…").
- The technician heard progress in the brief, and newer progress on pressing 1.

But Iris was cut off at the handover. The resident remarked on the call: "get to the end of its sentence, then… technician has joined the call". The log showed a race:
- Iris stopped talking at 15:37:47.30.
- The technician joined at 15:37:47.78. With Iris "quiet", she was muted at once (15:37:48.9).
- But she was starting a new question ("Thanks for trying that… can you check whether the cable…"), prompted by an `update_transfer` reply at 1:02 that said "carry on with the caller" while the technician was already joining.

What changed:
- **While a technician is joining or connected,** the `update_transfer` reply tells Iris: "A technician has accepted and is joining the call now. Finish your current point in a few words and do not ask a new question or start a new topic."
- **Handover grace period (`HANDOVER_GRACE_MS`, 1.5 s).** If Iris is quiet when the technician joins, the server waits 1.5 s. If she starts talking in that time, it waits for her to finish (still capped by `HANDOVER_MAX_WAIT_MS`, 10 s); if not, the handover happens when the grace ends.

Checks:
- 82/82 tests, 3 runs. 4 new tests cover: the 15:37 race replayed, a quiet Iris, the wrap-up reply while joining (with the old message once the search is over), and the default.
- Broken on purpose: grace ignoring a starting sentence fails 1 test; no wrap-up message fails 1.

### 2026-11-26 - a cleaner flow: updates as text, update on accepting, longer handover (v0.8.0)

**D26. Technician updates go to Iris in her `update_transfer` reply, with the audio cue only as a fallback.**

The SPEECH log of call `CA386366…92b9f3` (15:14 UTC) showed the room was never silent between a technician failing (15:15:00) and the cue (15:15:08). Iris and the resident overlap constantly, and Iris talked almost without a break from 15:15:12 to 15:15:28. Any audio cue lands on someone: "Calling technician to now. Yeah." garbled the resident's turn, and Iris's reply was cut.

What changed:
- **Without hold music,** the news is held and delivered as text in Iris's next `update_transfer` reply: "Technician N did not pick up. Technician N+1 is being called now. Tell the caller this briefly…". Several failures are told together, and each only once. With no news, the reply says "No change… do not mention it."
- **Fallback:** the audio cue (with the D23 pause rule) is used only if she makes no such call within `UPDATE_FALLBACK_MS` (8 s), or immediately when hold music is on.
- **The `request_transfer` reply and the README prompt** ask her to call `update_transfer` after each caller answer.
- **The report** records `delivered_via` (tool reply or audio cue).

**On pressing 1, the technician hears newer progress before joining.** On the same call, technician 2 answered at +20.2 s and Iris's progress arrived at +23 s, so his brief lacked it. If progress newer than the technician's brief exists, they now hear "Update: <progress>. Connecting you to the resident." The report adds `update_on_accept`.

**Handover wait raised from 6 s to 10 s.** On that call Iris's last reply started at 15:15:23 and was cut at the 6 s limit.

Checks:
- 78/78 tests, 3 runs. 6 new tests cover: news in the reply (only once), two failures told together, fallback cue, an accept cancelling the fallback, the update on accepting (and none when already in the brief), and the defaults.
- Broken on purpose: no news in the reply fails 2 tests; always using the audio cue fails 4; no update on accepting fails 1.
- Older tests run with `updateFallbackMs: 0`, which reproduces the earlier always-cue behaviour, and all still pass.

### 2026-11-26 - progress in the technician brief, Iris finishes her sentence (v0.7.0)

**D24. The technician brief includes Iris's troubleshooting progress.**

On call `CA072e0b…f975` (14:49 UTC) the technician who answered heard only the summary fixed at the tool call ("Caller reports their air conditioning is not working…"), with none of the troubleshooting that followed. The team asked for the progress to be included.

What changed:
- New `update_transfer` tool (`POST /tool/update-transfer`, `progress` + `call_sid`, secret-protected like the others).
- The server keeps the latest sentence. The brief is built when a technician answers: "<summary>. Progress so far: <latest>. Press 1…". Repeated prompts and later technicians get the newest progress.
- Progress sent after the search ends is kept but marked "not briefed".
- The report adds `progress_updates` and each technician's exact `briefing`; the log adds `PROGRESS` and `BRIEF`.
- The `request_transfer` reply tells Iris to use the tool.
- Briefing stays in Twilio's voice (unchanged decision).

**D25. A technician joining mid-sentence waits for Iris to finish before she is muted.**

Previously Iris was muted the instant the technician entered the room, cutting her off. Now, if Twilio reports her talking, the server waits for her speech-stop (or `HANDOVER_MAX_WAIT_MS`, 6 s) before muting her, ending any hold and announcing "A technician has joined the call". The transfer is still marked connected at once; only the mute and the announcement wait. If she is quiet, it happens immediately, as before.

Checks:
- 72/72 tests, 3 runs. 5 new tests cover: brief with latest progress, progress reaching a later technician and repeated prompts, tool validation and the after-search case, handover waiting for speech-stop, handover max wait, and the quiet case.
- Broken on purpose: muting at once fails 2 tests; leaving progress out of the brief fails 2.

Real-call data behind D23 (`CA072e0b…`, SPEECH log): Twilio reports talking for both the resident and Iris. Turn gaps are short (Iris stopped, resident started 0.14 s later), so the 0.7 s quiet rule rarely triggers and cues hit the 8 s maximum. The rule needs tuning next.

### 2026-11-26 - cues to Iris wait for a pause (v0.6.0)

**D23. Technician-update and "no technician" cues are held until nobody is talking.**

Found on call `CAcafd40…ef29` (14:20 UTC, Victoria1, no hold music):
- **Cue 1 lost.** It played to Iris at ~33 s, while the resident was mid-sentence. It is missing from the transcript, Iris never gave the technician 1 update, and her reply came at 44 s, 17 s after the resident began.
- **Cue 2 interrupted Iris.** It arrived at 49 s, while she was speaking, and cut her off mid-way through safety advice ("…get everyone out of the apartment right…"; the transcript marks it interrupted).

Cause: cues went out the instant a technician failed, whoever was talking.

Fix:
- The conference now subscribes to Twilio's `speaker` events (`participant-speech-start` / `-stop`, per Twilio's TwiML Conference docs; only the first participant's setting counts, which is the resident's).
- Cues queue until nobody has talked for `CUE_QUIET_GAP_MS` (700 ms), or until `CUE_MAX_WAIT_MS` (8 s).
- What belongs with a cue happens when it is actually sent: unmute, end hold, and the music-back timer (relevant only if hold music is switched back on).
- A waiting update is dropped if a technician joins or the search ends. "No technician" then replaces any waiting update.
- Speech events are not written to the log.
- The report adds `cued_at` / `waited_for_pause_seconds`.
- The next technician is still dialled immediately.

Checks:
- 66/66 tests, 3 runs. 5 new tests cover: resident talking, Iris talking, talking that never stops (max wait), a technician joining while a cue waits (dropped), and "no technician" replacing a waiting update (no speech events in the log).
- Broken on purpose: ignoring who is talking fails 5 tests; not dropping on join fails 1.
- To confirm on a real call: Twilio sends speaker events for Iris's leg as well as the resident's, and 0.7 s feels natural.

Also noted 2026-11-26: the team no longer uses hold music. It stays off by default on this branch. Removing the hold code entirely can be a separate clean-up step.

### 2026-11-26 - requirements confirmed, prompt step 1 done

**Team requirements (restated 2026-11-26) against what is built:**
1. **The moment Iris identifies the problem, she starts reaching the technician and keeps troubleshooting, never on hold.**
   - Server: done (D18). No hold music, and Iris stays unmuted during the search.
   - Prompt: done in step 1 below.
2. **Twilio briefs the technician first, then they join** (as before). Done, unchanged.
3. **Iris mutes once the technician is connected.** Done (since `agent-stays-on-call`).

**D22. Prompt step 1, live on "Sequential Testing-Victoria1".**
- The pattern is "say the line, then immediately call `request_transfer`", followed by troubleshooting. Iris says the line once, never says "please hold", never goes silent before a technician joins, and never claims a technician is on the way.
- Checked in Preview (`conv_8501…tbg0g`): the line was said once at 0:11; `request_transfer` was called at 0:13 (Failed, 607 ms, which is the expected 404 for Preview's placeholder `call_sid`); she kept troubleshooting at 0:14.
- Wordings that failed on this LLM (`deepseek-v41-flash`): "call the tool before you say anything" and "say the line after the tool". Both made Iris speak the line without calling the tool.
- Next, step 2: if Iris's line drops while the resident is still on, rejoin her instead of ending the call. Waiting for a phone-call check of step 1.

### 2026-11-26 - own agent, own tools, own tunnel: first working call on this branch

**D21. Each tester has their own ElevenLabs agent, tools, TwiML App and ngrok tunnel.**

How it played out:
- Calls went to a colleague's server while both used his ngrok domain. Then an agent branch was ignored on phone calls (D20).
- Then a duplicated agent ("Sequential Testing -Victoria") was copied from Main. Its prompt never called `request_transfer`, even in Preview.

Working setup (`agent_1101…ns1b`, "Sequential Testing-Victoria1"):
- **Prompt:** the same as the original "Sequential Testing" prompt, which does call the tool.
- **Tools:** with the team's go-ahead, its own two webhook tools were created through the ElevenLabs API (`request_transfer` `tool_5601…8pxq`, `take_message` `tool_2401…bd7j`). They are attached in place of the tool it shared with the original agent. Prompt, LLM (`deepseek-v41-flash`), first message and system tools were left unchanged. 15 read-back checks passed (URL, method, exact header name, secret value, LLM-filled field, `call_sid` from the dynamic variable, required fields). A Preview placeholder for `call_sid` is set on the tools.
- **The colleague** uses his own agent ("Sequential Testing - Samuel") with tools pointing at his own ngrok address.

**Random ngrok addresses break everything on each restart.** At 14:07 the tunnel restarted with a new address. The tools, created minutes earlier, pointed at the old one (ngrok `ERR_NGROK_3200`, endpoint offline). The fix each time:
- Re-point the tools (done via the API).
- Run `node scripts/setup-agent-app.js` for the TwiML App.
- Restart the server.

Open: claim the free fixed ngrok domain and add an `NGROK_DOMAIN` setting to `scripts/tunnel.js` so the address never changes.

**First working call on this branch:** `CA1c19d3…` (14:12 UTC, outbound).
- The report was created and `request_transfer` reached the server.
- No hold music, and Iris was not muted during the search.
- Technician 1 was dialled at +0 s and the others were not called.
- The resident hung up at 15.2 s, and technician 1's call was cancelled.

Still to test on a real call with this setup: a technician update, a technician joining (Iris muted), and a saved message.

### 2026-11-26 - choose the ElevenLabs agent branch (v0.5.0)

**D20. `ELEVENLABS_BRANCH_ID` picks which agent branch a call runs on.**

What happened: on call `CA72271a…0845` (12:54 UTC) Twilio, the new TwiML App and Iris's leg all reached this server. But Iris never called `request_transfer`. She said "I'm reaching out to a technician right now, and while we wait…" on every turn, so there was no search and no report. The call ran on the agent's **main** branch, while the team's edits (tools, prompt) were on another branch.

The ElevenLabs docs (personalization, Twilio personalization, versioning and register-call, read 2026-11-26) say `branch_id` belongs inside `conversation_initiation_client_data` and "defaults to the agent's main branch". It is not a top-level field of register-call.

What changed:
- The server now sends `branch_id` there when `ELEVENLABS_BRANCH_ID` is set, and nothing otherwise.
- The startup line `agent branch :` shows which branch is in use.
- The README prompt line "I'm reaching out…" now ends "Say this only once", so a slow or failed tool call cannot make Iris loop on it.

Checks:
- 61/61 tests pass, including a new one: `branch_id` is sent inside `conversation_initiation_client_data`, not at the top level, and is left out when empty.

**Result on real calls (2026-11-26): branches are not used for phone calls; a separate agent is.**
- With `ELEVENLABS_BRANCH_ID` set to the "Sequential Testing - Victoria" branch, phone call `CA9ee730…d622` (13:24 UTC) still never called `request_transfer`.
- In the dashboard Preview on that same branch (v4), Iris called `request_transfer` on her first turn. The request reached this server with the correct URL and secret. The 404 was expected: Preview sends a placeholder `call_sid`.
- So the branch was fine, and phone calls started through register-call did not run it, despite `branch_id`.
- Fix used: **duplicate the agent** into a separate agent, put its ID in `ELEVENLABS_AGENT_ID`, and leave `ELEVENLABS_BRANCH_ID` empty. The setting stays in the code (harmless when empty) in case ElevenLabs supports it later.
- Also learned: Preview needs a placeholder for `call_sid` under **Vars**, or the conversation fails with "Missing required dynamic variables in tools: {'call_sid'}". Real calls always send it.

### 2026-11-26 - every call is an emergency (prompt only)

**D19. For this task, every call is treated as an emergency.** Iris calls `request_transfer` as soon as the caller has explained the problem, then troubleshoots while the search runs. This replaces the D18 default of troubleshooting first for non-emergencies. It is a prompt change only; the server is unchanged.

The team's prompt was adjusted in four places before use:
- **No greeting line in the prompt.** The agent's First message already greets, so it would greet twice.
- **No "I'll hand you over" line.** Iris is muted before the room hears "A technician has joined the call", so her line would not be heard, or would repeat the announcement if she weren't muted.
- **`take_message` is called,** so messages reach the report.
- **The breaker step is limited** to "only if it is safe to reach and they are not standing in water".

Still open: the server's `request_transfer` reply says "never suggest electrical, gas or structural work", which contradicts the breaker step. A proposed replacement is waiting for a decision.

### 2026-11-26 - Iris troubleshoots while searching (v0.4.0, branch iris-troubleshoots-while-searching)

**D18. No hold music: Iris troubleshoots with the resident during the search.**
Requested by the team: "The moment Iris identifies an emergency, she should start reaching out to the technician while continuing to troubleshoot with the resident, so the resident is never left on hold."

What changed:
- `HOLD_MUSIC_DELAY_SEC` now defaults to `off`, so the resident is never put on hold and Iris is not muted during the search. A number of seconds brings the music back, with all the D6/D13 behaviour.
- The `request_transfer` reply now tells Iris to stay with the resident and troubleshoot, with safety limits: never electrical, gas or structural work. If anything sounds dangerous (a gas smell, sparks, smoke, flooding), she tells them to get to safety and call emergency services. After a technician-update cue she gives the update and carries on troubleshooting.
- A new ElevenLabs prompt is in the README:
  - On an emergency, call `request_transfer` at once and keep troubleshooting.
  - Otherwise troubleshoot first, and transfer if the problem isn't solved. That second rule was our default, not part of the request.
  - Go silent (skip_turn) only after "A technician has joined the call".

Kept as before, by decision:
- **Technician briefing:** the summary is read to the technician, then "press 1". Two other options were offered and declined: a live Iris conversation with the technician, or a recording in Iris's voice.
- **Iris is muted the moment the technician joins** (already the case since `agent-stays-on-call`).
- **Technician updates (D3)** are a cue to Iris only. With no hold, nothing is unmuted or taken off hold around them.

To check on a real call:
- Iris weaves the update cue into a live conversation without talking over the resident awkwardly. The cue is heard by her as speech, so it may interrupt her mid-sentence.
- Troubleshooting stays within the safety limits.
- The mute lands cleanly when the technician joins mid-conversation.

### 2026-11-26 - server start-up error (v0.3.1)

**D17. The server reports when it cannot start.**
On 2026-11-26 another program already held port 3000. The server printed "listening on http://localhost:3000" and then exited without an error, because Express 5 passes start-up errors to the `listen` callback and `server.js` ignored them.

It now prints `Could not start the server: Port 3000 is already in use…` and exits with code 1. This was checked by starting `server.js` on a deliberately occupied port: it gave that message and exit code 1. The tests pass (59/59).

### 2026-11-25 - take_message tool (v0.3.0)

**D16. Iris saves messages with a `take_message` tool.**
Requested by the team after Iris offered to take a message and nothing recorded it. Messages previously existed only in the transcript.

How it works:
- New endpoint `POST /tool/take-message`, protected like `request_transfer`: it needs `X-Tool-Secret` and `call_sid`, and also accepts `parent_call_sid`.
- The message is trimmed, its whitespace collapsed, and it is capped at 1000 characters.
- It is appended to the transfer's `messages`. Several messages on one call are all kept, in order.
- It is logged as `MESSAGE resident=… call=… saved to report (#n)`.
- It is shown in the detail page's **Message** row, in the list page's **Message** column, and as a transcript marker.
- A message on a call with no transfer has no report to go into, so it is only logged. The tool still answers 200, so Iris is not confused.
- Rejected requests: bad secret (401), malformed `call_sid` (400), empty message (400), unknown call (404).

The prompt fix from the open item is folded in:
- Iris stays silent *until* a cue, not "with only two exceptions".
- After "No technician is available" she replies normally, calls `take_message`, and says "Thanks, I've saved your message for the maintenance team."
- The `request_transfer` tool reply now says the same.

Still needed in ElevenLabs: add the `take_message` tool to the "Sequential Testing" agent (settings in the README) and paste the new prompt.

### 2026-11-25 - call sequence proof in reports (v0.2.6)

**D15. Reports prove technicians are called one at a time.**
Asked for, so supervisors can see the calling is sequential, not parallel.

What was added:
- Each technician now records `line_closed_at`, when Twilio's status callback says their call ended.
- Each report has a `sequence` block, computed from the technicians' timestamps:
  - `one_at_a_time`
  - `max_offered_the_call_at_once`
  - `each_dialled_after_previous_outcome`
  - per technician, `dialled_ms_after_previous_outcome` and `previous_line_still_closing_ms`
  - `max_phone_lines_open_at_once`
- The detail page has a "Call sequence" section with a verdict, a table and a timeline. The list page has a "Sequence" column. The server logs a `SEQUENCE` line for each next call.

Definition chosen: a technician is "offered the call" from when they are dialled to their outcome, because only then can they press 1. A line still being hung up after its outcome, as after voicemail, is reported separately and honestly as `max_phone_lines_open_at_once`. It does not count as overlap.

Checked three ways:
1. Simulated tests, including a parallel pattern that must be flagged "NO".
2. Today's two real calls, recomputed from their saved reports: both one at a time, with the next technician dialled 2 ms after the previous outcome.
3. Twilio's own call records, which don't depend on this server:
   - In `CA0c45…`, technician 1's call ended at 11:15:23 and technician 2's call was created at 11:15:23.
   - In `CA67c5…`, they were 10:56:59 and 10:57:00.

**Also in this version: flaky tests fixed.** On one run before v0.2.5 was pushed, 1 of 54 tests failed. The commit command only checked that test output appeared, not `fail 0`, so the push went ahead. 21 later runs were clean, so the failing test could not be identified. The three tests with margins of 20-65 ms (the hold-music-not-started tests and "update replaces first hold") were widened to hundreds of ms. Ten runs after that were clean. Commits are now gated on `fail 0`, and nothing is pushed without an explicit request.

### 2026-11-25 - report labels for the server's own lines (v0.2.5)

**D14. Transcript rows for cues and announcements are not labelled "Resident".**
On call `CA0c45…4d71`, the report page showed "Resident: Technician one did not pick up. Calling technician two now." right before Iris said the same thing, which read as the message being given twice.

The cause was the report's labelling, not the call. ElevenLabs lists everything Iris hears that isn't her own voice as "user", and the report turned every "user" line into "Resident". The room recording shows the resident never heard that line (D3, confirmed above).

Now:
- Lines matching a cue (technician update or "No technician is available right now") are labelled **"Cue to Iris only (resident did not hear it)"**.
- "A technician has joined the call." is labelled **"Room announcement (Twilio)"**.
- The match is loose because speech recognition writes "one" for "1". If the caller's own words were merged into the same line, as with "Hello? A technician has joined the call.", the label adds **"plus the caller"**.

Code: `serverLine` in `src/reports.js`. The test uses the real call's lines.

### 2026-11-25 - cue confirmed private, resume time raised (v0.2.4)

**D3 confirmed on a real call** (call `CA0c45…4d71`, conversation `conv_4601…5sk5`). Technician 1 rang out, Iris gave the update, and technician 2 pressed 1 and joined.

The ElevenLabs transcript shows the cue as a "User" line followed by Iris's reply, and that looked like a repeat. It isn't one: ElevenLabs records what is played into Iris's leg, and the cue is played there on purpose.

What the resident heard was checked in Twilio's recording of the conference room: the mix of what the room hears, 8 kHz mono. It was measured as loudness in 250 ms windows, aligned to the server's timestamps:

| Window | Loudness | Meaning |
| --- | --- | --- |
| 11:15:23.5 to 29.25 (cue playing to Iris; sent 23.489, ElevenLabs heard it at 46 s ≈ 11:15:24) | −96 dBFS, digital silence | The cue is not in the room. |
| 11:15:29.5 to 33.65 | Speech, −15 to −28 dBFS | Iris's update; her transcript says 51 s ≈ 11:15:29. |
| 11:15:46.5 to 48.25 (positive control) | Speech | "A technician has joined the call", which is announced to the room. It does appear, so a leaked cue would have shown too. |

Three sources agree: the server report timestamps, the Twilio room recording, and the ElevenLabs transcript timing.

**D13. `HOLD_MUSIC_RESUME_SEC` default raised from 10 to 13.**
On the same call, Iris finished her update **10.16 s** after the cue was sent:
- The cue took about 3.5 s to play, and she started speaking at +6.0 s.
- The 10 s timer fired at +10.0 s, while she was still talking.
- The music landed at +10.33 s only because Twilio took 0.33 s to apply it.

Measured at 50 ms resolution, her audio stopped at 11:15:33.65, before the hold (33.82) and the mute (34.14) took effect, so nothing was cut. But that margin came from Twilio's response time, not from the design. 13 s gives about 3 s of margin over the measured 10.2 s. Raise it again if Iris's wording gets longer.

### 2026-11-25 - first successful real call, duplicate message fixed (v0.2.2)

**First real call on this branch** (call `CA67c5…dc83`, agent "Sequential Testing"). The search went as designed:
- Tool call succeeded; hold music started 5.3 s later.
- Technician 1 answered at 13.5 s and hung up without pressing 1 at 30.0 s (declined).
- The update was cued at +30 s, and Iris said "Sorry, technician one didn't pick up. I'm trying the next one now, please hold."
- The music came back 10.3 s later, and Iris was muted again.
- Technician 2 rang out at 50.8 s, so the result was "no technician".

The server report and the ElevenLabs transcript agree on this order.

Still to confirm: whether the resident heard the technician cue itself. The open item about real-call checks stays open for that.

Before that call, register-call had failed with HTTP 401 `missing the permission convai_write`. The ElevenLabs API key had **ElevenAgents: Read** only. It was changed to **Write**, with the same key and no `.env` change. This permission is needed to start every conversation. The read-only agent check cannot detect it, because reading works with Read.

**D12. "No technician is available right now" goes to Iris's leg only.**
On that call the resident heard the line twice: Twilio's voice to the whole room, then Iris. Now the line is a private cue to Iris, like D3, so the resident hears only Iris's apology.
- Order: cue first, then Iris unmuted and the music off.
- **Only Iris gives this message, never Twilio's voice** (team rule, v0.2.3). A first version of D12 (v0.2.2) fell back to the room announcement in two edge cases; both were removed:
  - If Twilio refuses the cue, the error is logged and nothing else is played. The trade-off is a moment of silence in that rare case, which the team chose over a robot voice.
  - If Iris's leg is still connecting, the cue is held and sent the moment she joins.
- If her leg has dropped, she is brought back with the fallback first message, so it is still Iris speaking.

Code: `cueAgent` and `noTechnician` in `src/app.js`. The held cue is `agent.pendingCue`, sent on her `participant-join`. The technician update (D3) uses the same `cueAgent` helper.

### 2026-11-25 - agent renamed to Iris (v0.2.1)

**D10. The agent is called Iris, not Ava.**
Requested by the team. The README, logs, report and transcript labels, comments and tests on this branch now say "Iris". The Twilio participant label changed from `ava-N` to `iris-N`. Entries below this one keep "Ava" because they record what happened at the time.

**D11. A new ElevenLabs agent replaces "Ava Transfer Lab".**
This fixes the open item about the misconfigured agent. Settings:
- First message "Hi, this is Iris. How can I help you today?", with no greeting line in the prompt, so she doesn't greet twice.
- The D9 prompt, renamed to Iris.
- μ-law 8000 Hz in both directions.
- Exactly one webhook tool, `request_transfer`, with `summary` filled by the LLM and `call_sid` as a dynamic variable, both required.
- skip_turn on; transfer_to_number and end_call off.
- First-message override allowed.
- "End conversation after silence" −1 (off). "Take turn after silence" −1, so Iris is not prodded every 7 seconds while on hold or after an update.
- Max duration 600 seconds, kept as a cost cap.

Verified 2026-11-25: agent "Sequential Testing" is in `.env`, and a read-only API check of all 25 settings above passed.

The check caught three problems along the way, all fixed:
- Both audio formats were left at PCM 16000.
- The `X-Tool-Secret` header was missing at first.
- Later the header's name had a hidden leading tab from copy-paste. Its value matched `TOOL_SECRET`, but the name would have caused a 401.

### 2026-11-25 - `sequential-with-updates` (v0.2.0)

**D1. No parallel calling on this branch.**
Technicians are called strictly one at a time, in `TECH_NUMBERS` order.
Why: requested. A one-at-a-time search lets the resident be told about each technician who does not pick up, which parallel ringing cannot do.
Code: `startSearch`, `resolveTech` in `src/app.js`; parallel branches removed.

**D2. Ava herself gives the update, driven by her ElevenLabs system prompt.**
The server plays a cue that only Ava hears. Her prompt tells her what to say.
Options considered:
- A text-to-speech clip in Ava's voice played by the server. Exact wording, but the AI conversation isn't the one speaking.
- A second "wait for update" tool that blocks until the next search event. Most natural, but depends on ElevenLabs tool timeouts.
- Twilio's built-in voice. Simplest, but robotic and not Ava.

Chosen: the prompt-driven cue. Why: it is the same pattern the branch already uses for "A technician has joined the call", and the wording stays under the team's control in the prompt.

**D3. The cue goes to Ava's call leg only, not the whole room.**
`conferences(sid).participants(avaCallSid).update({ announceUrl })`. Why: so the resident hears one message, Ava's, and not a robot line followed by Ava repeating it.
Not yet confirmed on a real call (see Open).

**D4. Cue wording uses positions, never phone numbers.**
"Technician N did not pick up. Calling technician N+1 now." Why: Ava has nothing private to read out.

**D5. Every way of not taking the call gets the update, with the same wording.**
That covers no answer, busy, voicemail, declined (pressed another key), no key after 3 prompts, and a call that could not be placed.
Why: the resident does not need to know which one it was, and "declined" is not something to tell a resident.
The **last** technician failing gets no update; the existing "No technician is available right now" flow replaces it.

**D6. Hold music and mute around an update.**
- Order: cue to Ava, then unmute Ava, then take the resident off hold, all while the cue plays. The resident hears about 3 seconds of silence before Ava speaks.
- The music comes back, and Ava is muted again, `HOLD_MUSIC_RESUME_SEC` after the update (new setting, default 10 seconds). This only happens while the search is still running.
- At most one pending "music on" per transfer. A new update replaces it, so the first hold cannot cut Ava off mid-update.
- With `HOLD_MUSIC_DELAY_SEC=off`, only the cue is sent.

**D7. Reports record time periods instead of single timestamps.**
New fields: `hold_periods`, `agent_mute_periods` and `resident_updates`. The old `hold_started_at`, `hold_ended_at`, `agent_muted_at` and `agent_unmuted_at` are kept as the first start and the last end.
Why: with updates, Ava is muted and unmuted several times in one search. Single timestamps overwrote each other, which would have mislabelled transcript lines as "muted, not heard". Old reports without periods still render.

**D8. `DIAL_MODE` stays in `.env` with the value `sequential`.**
This branch ignores the setting and prints a startup warning for any value other than `sequential`.
`single` was considered and rejected: `.env` is shared by every branch (not tracked by git), and `main` and `agent-stays-on-call` refuse to start on any value other than `sequential` or `parallel`.

**D9. ElevenLabs system prompt.**
The tested prompt is in the README (Setup, step 4). It adds one exception to the "skip_turn after the tool call" rule: on hearing the cue, say "Sorry, technician N didn't pick up. I'm trying the next one now, please hold." once, then go back to skip_turn. It relies on the ElevenLabs skip_turn system tool being enabled.

## Open

- [x] **Iris goes silent after taking a message**: addressed by D16 (new prompt + take_message), still to be confirmed on a real call. (found 2026-11-25, call `CA3f30a2…`, 12:01).
  - What happened: after "No technician is available right now" she asked "Can I take a message?". The caller gave one at 46 s. She called `skip_turn` at 52 s, and again on each of three "Hi, Iris" turns.
  - Audio was fine: she was unmuted (12:01:30.9) and the resident was off hold (12:01:31.3).
  - Cause: the D9 prompt's "On every turn, call skip_turn … The only exceptions are the two messages below." The caller's message is not one of those exceptions. The model behaves inconsistently here: on the 10:56 call she did reply.
  - Proposed prompt fix (given to the team the same day): stay silent only *until* a cue. After "No technician is available", stop calling skip_turn, read the message back, say it is noted, and close the call.
  - Also open: messages are not stored anywhere except the transcript. Option: a `take_message` tool that saves the message into the report and logs a `MESSAGE` line.
  - Waiting for a decision.
- [x] **First real call on this branch.** All three checked on 2026-11-25 (call `CA0c45…4d71`), see D13:
  - The resident does **not** hear the cue (D3): confirmed.
  - Ava (now Iris) breaks out of skip_turn to give the update: confirmed.
  - `HOLD_MUSIC_RESUME_SEC=10` fits her sentence: **no**, it was too tight, so it is now 13.

  Original checklist: README test-checklist cases 8 and 8b.
- [x] **Duplicate "no technician" message.** Fixed by D12 (2026-11-25), after it was heard on the first real call. Original note: When the last technician fails, the room hears "No technician is available right now." in Twilio's voice, then Ava says nearly the same thing. This already happens on `agent-stays-on-call`.
  - Proposed fix: send that cue to Ava's leg only, like D3.
  - Trade-off: if Twilio refused the cue, the resident would hear nothing at that moment.
  - Waiting for a decision.
- [ ] **ngrok account.** Testing currently uses a colleague's ngrok authtoken and dev domain. Risks:
  - Only one tunnel at a time on that account.
  - Requests, including phone numbers, summaries and the `X-Tool-Secret` header, can be seen in their dashboard.
  - The URL is theirs to change.

  Recommendation: use our own free ngrok account. Waiting for a decision.
- [ ] **Rotate `TOOL_SECRET`.** Most of its value appeared in a shared screenshot on 2026-11-25. That's fine for testing, but rotate it before anything real: generate a new one, put it in `.env` and the ElevenLabs header, and restart the server.
- [x] **ElevenLabs agent misconfigured (found 2026-11-25, call `CAd3a6…1339`).** Resolved by D11: a new agent, verified. The server log had no tool request. The ElevenLabs conversation record showed Ava called `transfer_to_technician` twice (HTTP 404 both times), then skip_turn. The agent's settings ("Ava Transfer Lab"), read through the API, showed:
  - `transfer_to_technician` points at a dead trycloudflare.com tunnel, with no path.
  - The correct tool (our server's `/tool/request-transfer`, right secret, `call_sid` as a dynamic variable) is named `check_transfer_status`. The prompt asks for `request_transfer`, so it was never used.
  - The system prompt is an older "You are Iris…" version, not the D9 prompt. The first message says "Ava", so the agent called itself both names.
  - The `transfer_to_number` system tool is enabled.

  Fix:
  1. Delete `transfer_to_technician`.
  2. Rename `check_transfer_status` to `request_transfer`.
  3. Paste the D9 prompt.
  4. Turn off `transfer_to_number`.

  The agent may be shared with a colleague, so check with them first, or use our own copy of the agent.
- [ ] **Prompt order: tool first, then "please hold".** On the first real call (2026-11-25), Ava said "I'm connecting you to a technician now. Please hold." before the tool call, and the tool call failed (see the item above). She then went silent (skip_turn), with no music and no search: an awkward silence for the resident.
  - Proposed: the prompt has her call the tool first and say "please hold" only when it returns `searching`. On an error, she apologises and offers to take a message.
  - Prompt change only, no code change. Waiting for a decision.
- [x] Local `.env`: change `DIAL_MODE=parallel` to `DIAL_MODE=sequential` (D8). Done 2026-11-25. Server restarted, and it now lists 2 technicians.
- [ ] ElevenLabs: point the `request_transfer` tool URL at the current tunnel, paste the D9 prompt, enable skip_turn.

## Verification log

| Date | Change | How it was checked | Result |
| --- | --- | --- | --- |
| 2026-11-25 | D1-D8 | `npm test` (simulated Twilio and ElevenLabs, no network, no credit used) | 51/51 pass, 5 runs in a row |
| 2026-11-25 | D1-D8 | Broke the feature on purpose 3 ways, re-ran tests, restored | No update call: 9 tests fail. Update does not cancel pending hold: 1 fails. Cue to whole room: 9 fail. Code restored and matched the backup exactly |
| 2026-11-25 | New agent (D11) | Read-only ElevenLabs API check of 25 settings | All pass after 3 fixes (audio formats, missing header, header name with a hidden tab) |
| 2026-11-25 | D1-D9 on a real call | Server log, saved report and ElevenLabs transcript of call `CA67c5…dc83`, compared with each other | Order and timings agree. Update spoken by Iris, music resumed after 10.3 s. Duplicate "no technician" message heard (fixed by D12) |
| 2026-11-25 | D10 rename, D12 | `npm test` | 52/52 pass, 5 runs in a row |
| 2026-11-25 | D12 | Broke it on purpose 2 ways, re-ran tests, restored | Back to the room-wide announcement: 7 tests fail. No fallback when Twilio refuses the cue: 1 fails. Code restored and matched the backup exactly |
| 2026-11-25 | D12 Iris-only (v0.2.3) | `npm test`, then broke it on purpose 2 ways and restored | 53/53 pass, 5 runs in a row. Twilio fallback put back: 1 fails. Held cue never sent: 1 fails. Code restored and matched the backup exactly |
| 2026-11-25 | D3 on a real call | (1) server report timestamps, (2) Twilio room recording loudness at 250 ms and 50 ms, with a positive control, (3) ElevenLabs transcript timing | All three agree: the cue is silent in the room, and Iris's update is heard once |
| 2026-11-25 | D13 | `npm test` | 53/53 pass |
| 2026-11-25 | D14 | (1) `npm test` (test built from the real call's lines), (2) label fix removed on purpose and restored, (3) real report CA0c45…4d71 rendered with the new code | 54/54 pass, 5 runs in a row. 1 test fails without the fix. The real report shows the cue as "Cue to Iris only", the announcement as "Room announcement (Twilio), plus the caller", and Iris's update as "Iris" at 11:15:30, matching the room recording |
| 2026-11-25 | D15 | (1) `npm test` incl. a parallel pattern that must fail, (2) sequence recomputed on the 2 real call reports, (3) Twilio call records (created/end times) for every technician call | 56/56 pass. Both real calls one at a time, next technician dialled 2 ms after the previous outcome. Twilio: next call created 0 s and 1 s after the previous call ended |
| 2026-11-25 | Flaky-test fix | 10 consecutive full runs after widening the 3 tight timing tests | 10/10 clean |
| 2026-11-25 | D16 | `npm test` (3 new take_message tests), then message-saving removed on purpose and restored | 59/59 pass. 2 tests fail without saving. Code restored and matched the backup exactly |
| 2026-11-25 | `agent-stays-on-call` baseline | `npm test` before branching | 40/40 pass |
| 2026-11-26 | D28 merge of full-call-recording | (1) `npm test` 3 runs, (2) config flags parsed with a dummy env, (3) 2 deliberate breaks of the recording code, then restored | 84/84 pass each run. Flags default on, turn off, bad value refused. Each break fails 1 test; code restored byte-identical |
| 2026-11-26 | D29 technician-left cue | (1) `npm test` 3 runs, (2) real report CAd7d4…7cde5 re-rendered, (3) 3 deliberate breaks, then restored | 88/88 pass each run. "Hello? Hello?" relabelled "Resident" in both tabs. Each break fails 1-3 tests; code restored byte-identical |
| 2026-11-26 | D30 technician on hold until Iris finishes | (1) `npm test` 3 runs, (2) 3 deliberate breaks, then restored, (3) Twilio library participant update params and Conference TwiML checked | 90/90 pass each run. Breaks fail 6, 2 and 1 tests; code restored byte-identical. Library sends Muted/Hold/HoldUrl/HoldMethod together; muted="true" renders |
