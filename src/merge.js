'use strict';

// The merged transcript: one table for the whole call, with a definite speaker on
// every line where the sources allow it.
//
//   Who said it  - from Twilio, which keeps each person's phone line separate:
//                  channel 1 of the resident's recording is the resident, channel 1 of a
//                  technician's recording is that technician (confirmed on a real call,
//                  2026-11-26). Without a post-call transcript, the live transcript's
//                  inbound track of the same line is used instead.
//   What was said - from ElevenLabs where it heard the same words, because its text is
//                  more accurate; otherwise Twilio's text is kept.
//   Iris          - her own lines from ElevenLabs: the text she generated, so it is exact.
//   Twilio's own lines and the call's events (brief, announcement, hold, technicians
//                  rung) - from the server's record, so they are exact too.

const OWN_CHANNEL = 1;

// ElevenLabs' own tools. They are not the transfer request, so they cannot be used to line up the clocks.
const SYSTEM_TOOLS = /called (skip_turn|end_call|language_detection|transfer_to_number|transfer_to_agent|play_keypad_touch_tone|voicemail_detection)\b/;
// Lines Iris hears that are the server's, not a person's.
const CUE_TO_IRIS = /technician \w+ did not pick up\.?(\s*calling technician \w+ now\.?)?|no technician is available right now\.?|the technician has left the call\.?(\s*please speak to the caller again\.?)?|technician here\.?(\s*hand over in one sentence\.?)?/i;
const ROOM_ANNOUNCEMENT = /a technician has joined the call\.?/i;

const MATCH_WINDOW_MS = 15_000; // how far apart in time an ElevenLabs line and a Twilio line may be
const LINE_MATCH = 0.5; //         share of a Twilio line's words that must appear in the ElevenLabs line
const TURN_COVERED = 0.7; //       share of the ElevenLabs line's words the matched Twilio lines must explain (lower lets
//                                 another speaker's words, merged in by ElevenLabs, slip into the line)
const RELATED = 0.25; //           below this an ElevenLabs line is treated as something Twilio did not hear
const JOIN_GAP_MS = 4_000; //      consecutive Twilio lines of one speaker closer than this are one turn

const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const iso = (value) => (Number.isFinite(value) ? new Date(value).toISOString() : null);
const FILLER = new Set(['um', 'uh', 'erm', 'hmm', 'mm', 'ah', 'oh']);
const words = (text) => (String(text || '').toLowerCase().match(/[a-z0-9']+/g) || []).filter((w) => !FILLER.has(w));

// Share of the words in `part` that also appear in `whole`.
function containment(part, whole) {
  const p = words(part);
  if (!p.length) return 0;
  const w = new Set(words(whole));
  return p.filter((x) => w.has(x)).length / p.length;
}

// ElevenLabs' lines placed on the server's clock. Its clock and ours can be a minute or
// more apart, so its timestamps cannot be compared with ours as they are. One moment is
// known on both clocks: when Iris called the transfer tool. ElevenLabs says how many
// seconds into the conversation that was, and the report's started_at is when the server
// received it. Every line is placed relative to that.
function elevenLabsLines(r) {
  const conversations = (r.transcript && r.transcript.conversations) || [];
  const first = conversations[0];
  const toolCall = first && first.entries.find((e) => e.role === 'tool' && !SYSTEM_TOOLS.test(e.text));
  const offsetMs = toolCall && r.started_at && first.started_at
    ? ms(r.started_at) - toolCall.seconds * 1000 - ms(first.started_at)
    : 0;
  const lines = [];
  conversations.forEach((conversation, index) => {
    const startMs = ms(conversation.started_at);
    const place = (entry) => (Number.isFinite(startMs) ? iso(startMs + offsetMs + entry.seconds * 1000) : entry.at);
    if (index > 0) lines.push({ role: 'marker', text: 'Iris rejoined the call (new ElevenLabs conversation)', at: place({ seconds: 0 }) });
    for (const entry of conversation.entries) lines.push({ ...entry, at: place(entry) });
  });
  return lines;
}

const within = (periods, at) => (periods || []).some((p) => at >= p.from && (!p.to || at < p.to));

// The people's own lines from Twilio, one source per phone line.
function twilioHumanLines(r) {
  const tw = r.twilio;
  if (!tw) return { lines: [], sources: [] };
  const recordings = (tw.recordings || []).filter((rec) => rec.status === 'completed');
  const live = tw.live_transcript || [];
  const lines = [];
  const sources = [];

  const fromLine = (kind, technician, speaker) => {
    const rec = recordings.find((x) => x.kind === kind && (kind !== 'technician' || x.technician === technician));
    const it = rec && (tw.intelligence || {})[rec.recording_sid];
    const startMs = rec ? ms(rec.started_at) : NaN;
    if (it && it.status === 'completed' && Number.isFinite(startMs)) {
      const own = (it.sentences || []).filter((s) => s.channel === OWN_CHANNEL);
      own.forEach((s) => lines.push({ speaker, at: iso(startMs + s.start * 1000), text: s.text, from: 'recording' }));
      sources.push({ speaker, source: `Twilio's transcript of the ${kind === 'technician' ? `technician ${technician}` : 'resident'} recording, channel ${OWN_CHANNEL}` });
      return;
    }
    const leg = kind === 'technician' ? 'technician' : 'resident';
    const mine = live.filter((l) => l.leg === leg && l.track === 'inbound_track' && (leg !== 'technician' || l.technician === technician));
    mine.forEach((l) => lines.push({ speaker, at: l.at, text: l.text, from: 'live' }));
    if (mine.length) sources.push({ speaker, source: `Twilio's live transcript of the ${leg === 'technician' ? `technician ${technician}` : 'resident'}'s line (inbound track)` });
  };

  fromLine('resident', null, 'Resident');
  const technicians = new Set([
    ...recordings.filter((x) => x.kind === 'technician').map((x) => x.technician),
    ...live.filter((l) => l.leg === 'technician').map((l) => l.technician),
  ]);
  [...technicians].sort((a, b) => a - b).forEach((n) => fromLine('technician', n, `Technician ${n}`));

  // Twilio splits sentences finely ("Oh, please. My," / "sink is leaking."); join
  // consecutive lines of the same speaker into one turn.
  lines.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const turns = [];
  for (const line of lines) {
    const prev = turns.at(-1);
    if (prev && prev.speaker === line.speaker && ms(line.at) - ms(prev.lastAt) < JOIN_GAP_MS) {
      prev.text = `${prev.text} ${line.text}`;
      prev.lastAt = line.at;
    } else {
      turns.push({ ...line, lastAt: line.at });
    }
  }
  return { lines: turns, sources };
}

// The call's events and Twilio's own spoken lines, from the server's record.
function serverRows(r) {
  const rows = [];
  const add = (at, row) => { if (at) rows.push({ at, ...row }); };
  const event = (at, text) => add(at, { kind: 'event', text });

  event(r.started_at, 'Iris asked for a technician (request_transfer)');
  (r.technicians || []).forEach((tech, i) => {
    const n = i + 1;
    if (!tech.dialled_at) return;
    event(tech.dialled_at, `Calling technician ${n}`);
    const human = tech.answered_at && !/^(machine|fax)/.test(tech.answered_by || '');
    if (human) {
      add(tech.answered_at, { kind: 'line', speaker: `Twilio → technician ${n} (only they hear it)`, text: `${r.summary} Press 1 to connect to the resident.`, textFrom: 'server (exact)' });
    }
    if (tech.outcome === 'accepted') {
      event(tech.pressed_1_at, `Technician ${n} pressed 1`);
      add(tech.pressed_1_at, { kind: 'line', speaker: `Twilio → technician ${n} (only they hear it)`, text: 'Connecting you to the resident.', textFrom: 'server (exact)' });
    } else if (tech.outcome && tech.outcome !== 'calling') {
      const label = { 'no-answer': 'did not answer', busy: 'was busy', voicemail: 'went to voicemail', declined: 'declined', canceled: 'was cancelled', failed: 'could not be called' }[tech.outcome] || tech.outcome;
      event(tech.outcome_at, `Technician ${n} ${label}${tech.detail ? ` (${tech.detail})` : ''}`);
    }
  });
  const winnerIndex = (r.technicians || []).findIndex((tech) => tech.outcome === 'accepted');
  if (r.result === 'connected' && r.finished_at) {
    event(r.finished_at, `Technician ${winnerIndex + 1} joined the call`);
    if (r.handoff_by === 'iris') event(r.finished_at, 'Technician on hold until Iris finished; then Iris handed over (D32)');
    else add(r.finished_at, { kind: 'line', speaker: 'Twilio (room announcement, everyone hears it)', text: 'A technician has joined the call.', textFrom: 'server (exact)' });
    const left = winnerIndex >= 0 && r.technicians[winnerIndex].line_closed_at;
    if (left) event(left, `Technician ${winnerIndex + 1} left the call`);
  }
  if (r.result === 'no technician') event(r.finished_at, 'No technician was available: Iris was told so (the resident did not hear the cue)');
  if (r.result === 'resident hung up') event(r.finished_at, 'Resident hung up: technician calls cancelled');
  for (const u of r.resident_updates || []) event(u.at, `Technician ${u.technician} did not pick up: Iris was cued to tell the resident`);
  for (const p of r.hold_periods || []) {
    event(p.from, 'Resident put on hold with music');
    if (p.to) event(p.to, 'Resident taken off hold');
  }
  for (const m of r.messages || []) event(m.at, `Iris saved a message: "${m.text}"`);
  return rows;
}

/**
 * @returns {{ rows: object[], sources: object[], stats: object }}
 *   rows: { at, kind: 'line'|'event', speaker, text, textFrom, twilioText?, unheard?, interrupted? }
 */
function buildMergedTranscript(r) {
  const el = elevenLabsLines(r);
  const { lines: human, sources } = twilioHumanLines(r);
  const joinedAt = r.result === 'connected' ? r.finished_at : null;
  const rows = [];

  // Iris: her own words from ElevenLabs.
  for (const e of el) {
    if (e.role === 'agent') {
      const unheard = within(r.agent_mute_periods, e.at);
      rows.push({ kind: 'line', at: e.at, speaker: unheard ? 'Iris (muted, not heard)' : 'Iris', text: e.text, textFrom: 'ElevenLabs (exact)', unheard, interrupted: e.interrupted });
    } else if (e.role === 'marker') {
      rows.push({ kind: 'event', at: e.at, text: e.text });
    }
  }

  // What Iris heard from the people: ElevenLabs' "user" lines, minus the server's own lines.
  const heard = el.filter((e) => e.role === 'user' && !CUE_TO_IRIS.test(e.text) && !ROOM_ANNOUNCEMENT.test(e.text))
    .map((e, index) => ({ ...e, index, matched: [] }));

  // Each Twilio line goes to the ElevenLabs line that contains most of its words, nearby in time.
  for (const line of human) {
    let best = null;
    for (const u of heard) {
      const gap = Math.abs(ms(u.at) - ms(line.at));
      if (!(gap <= MATCH_WINDOW_MS)) continue;
      const score = containment(line.text, u.text);
      if (!best || score > best.score || (score === best.score && gap < best.gap)) best = { u, score, gap };
    }
    line.bestScore = best ? best.score : 0;
    if (best && best.score >= LINE_MATCH) best.u.matched.push(line);
  }

  let fromElevenLabs = 0;
  const used = new Set();
  for (const u of heard) {
    if (!u.matched.length) continue;
    const speakers = new Set(u.matched.map((line) => line.speaker));
    const explained = containment(u.text, u.matched.map((line) => line.text).join(' '));
    if (speakers.size === 1 && explained >= TURN_COVERED) {
      // Same words, one speaker: keep Twilio's speaker and ElevenLabs' text.
      const first = u.matched.reduce((a, b) => (ms(a.at) <= ms(b.at) ? a : b));
      rows.push({ kind: 'line', at: first.at, speaker: first.speaker, text: u.text, textFrom: 'ElevenLabs', twilioText: u.matched.map((line) => line.text).join(' ') });
      u.matched.forEach((line) => used.add(line));
      fromElevenLabs += 1;
    }
  }
  // Twilio lines ElevenLabs did not hear the same way (or mixed with someone else): Twilio's text.
  for (const line of human) {
    if (!used.has(line)) rows.push({ kind: 'line', at: line.at, speaker: line.speaker, text: line.text, textFrom: line.from === 'recording' ? 'Twilio recording' : 'Twilio live' });
  }

  // ElevenLabs lines that no Twilio line resembles: Twilio missed them, or there is no
  // Twilio data (older reports). The speaker can only be told from the timeline.
  for (const u of heard) {
    if (u.matched.length) continue;
    const related = human.some((line) => Math.abs(ms(u.at) - ms(line.at)) <= MATCH_WINDOW_MS && containment(line.text, u.text) >= RELATED);
    if (related) continue;
    const techLeftAt = ((r.technicians || []).find((tech) => tech.outcome === 'accepted') || {}).line_closed_at;
    const speaker = joinedAt && u.at >= joinedAt && (!techLeftAt || u.at < techLeftAt) ? 'Resident or technician' : 'Resident';
    rows.push({ kind: 'line', at: u.at, speaker, text: u.text, textFrom: human.length ? 'ElevenLabs only (speaker from timing)' : 'ElevenLabs (speaker from timing)', uncertain: true });
  }

  rows.push(...serverRows(r));
  // Events first when two rows share a timestamp, so "joined" comes before the announcement.
  rows.sort((a, b) => String(a.at || '9').localeCompare(String(b.at || '9')) || (a.kind === 'event' ? -1 : 0) - (b.kind === 'event' ? -1 : 0));

  return {
    rows,
    sources,
    stats: {
      people_lines: rows.filter((row) => row.kind === 'line' && /^(Resident|Technician \d+)$/.test(row.speaker)).length,
      text_from_elevenlabs: fromElevenLabs,
      twilio_lines: human.length,
    },
  };
}

module.exports = { buildMergedTranscript, elevenLabsLines, containment, OWN_CHANNEL };
