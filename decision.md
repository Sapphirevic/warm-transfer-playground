# Decision log

What was decided, why, and what is still open. Newest entries at the top of each section.
Update it whenever a design choice is made or changed, and in the same commit as the code.

## Branches

| Branch | Built on | What it is |
| --- | --- | --- |
| `main` | - | Ava hands the resident over to the technician and leaves. `DIAL_MODE` sequential or parallel. |
| `agent-stays-on-call` | `main` | Resident, Ava and technician share one conference. Ava stays, muted while the technician is on. Hold music during the search. Transcripts in reports. |
| `inbound-calls` | - | On the remote; not reviewed in this log yet. |
| `sequential-with-updates` | `agent-stays-on-call` | Technicians called one at a time. Ava tells the resident each time one does not pick up. **Current working branch.** |

## Decisions

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

- [ ] **First real call on this branch.** Check:
  - The resident does **not** hear the cue (D3).
  - Ava breaks out of skip_turn to give the update.
  - `HOLD_MUSIC_RESUME_SEC=10` fits her sentence.

  README test-checklist cases 8 and 8b cover these.
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
| 2026-11-25 | `agent-stays-on-call` baseline | `npm test` before branching | 40/40 pass |
