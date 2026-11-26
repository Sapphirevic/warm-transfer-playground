'use strict';

// One JSON file per resident call in reports/, plus the HTML views for GET /reports.

const fs = require('fs');
const path = require('path');
const { buildMergedTranscript, elevenLabsLines } = require('./merge');

const CALL_SID_RE = /^CA[0-9a-f]{32}$/i;

function createReportStore(dir) {
  fs.mkdirSync(dir, { recursive: true });

  function read(file) {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      return null;
    }
  }

  return {
    dir,
    save(report) {
      fs.writeFileSync(path.join(dir, `${report.resident_call_sid}.json`), `${JSON.stringify(report, null, 2)}\n`);
    },
    // The SID check also stops anything like "../.env" being read through /reports/:sid.
    get(sid) {
      return CALL_SID_RE.test(sid) ? read(`${sid}.json`) : null;
    },
    list() {
      return fs.readdirSync(dir)
        .filter((file) => CALL_SID_RE.test(file.replace(/\.json$/, '')) && file.endsWith('.json'))
        .map(read)
        .filter(Boolean)
        .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    },
  };
}

// Turns the in-memory transfer into the record that is saved and shown.
function buildReport(t) {
  const start = t.startedAt;
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const after = (ms) => (ms ? Math.round((ms - start) / 100) / 10 : null);
  const winner = t.winner === null ? null : t.techs[t.winner];
  const periods = (list = []) => list.map((p) => ({ from: iso(p.from), to: iso(p.to) }));
  // First start and last end, for a quick look (and for reports made before periods existed).
  const firstFrom = (list = []) => iso(list.length ? list[0].from : null);
  const lastTo = (list = []) => iso(list.length ? list.at(-1).to : null);

  const report = {
    resident_call_sid: t.residentCallSid,
    resident_number: t.residentNumber,
    direction: t.direction,
    summary: t.summary,
    // Technicians are always called one at a time on this branch (kept so reports from
    // other branches can be compared in the same list).
    dial_mode: 'sequential',
    // This branch keeps Iris in the room; on main she leaves when the technician joins.
    transfer_style: 'agent stays on the call',
    started_at: iso(start),
    finished_at: iso(t.finishedAt),
    // null while the search is still running
    result: t.result,
    connected_technician: t.result === 'connected' && winner ? winner.number : null,
    resident_wait_seconds: after(t.finishedAt),
    // The resident hears hold music while technicians are being called, with a break each
    // time Iris tells them a technician did not pick up.
    hold_started_at: firstFrom(t.holdPeriods),
    hold_ended_at: lastTo(t.holdPeriods),
    hold_periods: periods(t.holdPeriods),
    // Iris is muted (listening, not heard) during the hold and while the technician is in the room.
    agent_muted_at: firstFrom(t.mutePeriods),
    agent_unmuted_at: lastTo(t.mutePeriods),
    agent_mute_periods: periods(t.mutePeriods),
    // Each time a technician did not take the call and the next one was called, Iris was
    // cued to tell the resident. `cue` is what Iris heard; the resident heard Iris's reply.
    // Messages Iris took for the maintenance team with the take_message tool.
    messages: (t.messages || []).map((m) => ({ text: m.text, at: iso(m.at), seconds_from_tool_call: after(m.at) })),
    resident_updates: (t.residentUpdates || []).map((u) => ({
      technician: u.tech + 1,
      number: t.techs[u.tech].number,
      cue: `Technician ${u.tech + 1} did not pick up. Calling technician ${u.tech + 2} now.`,
      at: iso(u.at),
      seconds_from_tool_call: after(u.at),
    })),
    // Filled in from ElevenLabs after the call (see buildTranscript).
    transcript: t.transcript || null,
    // Twilio's side: recordings of the room and of each person's own line, live transcripts
    // of each line, and Twilio's post-call transcripts of the recordings (see app.js "Twilio media").
    twilio: t.media ? JSON.parse(JSON.stringify(t.media)) : null,
    technicians: t.techs.map((tech) => ({
      number: tech.number,
      call_sid: tech.callSid,
      outcome: tech.outcome || (tech.dialledAt ? 'calling' : 'not-called'),
      detail: tech.detail,
      answered_by: tech.answeredBy || null,
      dialled_at: iso(tech.dialledAt),
      ringing_at: iso(tech.ringingAt),
      answered_at: iso(tech.answeredAt),
      pressed_1_at: iso(tech.pressedAt),
      outcome_at: iso(tech.outcomeAt),
      line_closed_at: iso(tech.endedAt),
      seconds_from_tool_call: {
        dialled: after(tech.dialledAt),
        ringing: after(tech.ringingAt),
        answered: after(tech.answeredAt),
        pressed_1: after(tech.pressedAt),
        outcome: after(tech.outcomeAt),
        line_closed: after(tech.endedAt),
      },
    })),
  };
  // One-at-a-time proof for supervisors (see sequenceOf).
  report.sequence = sequenceOf(report.technicians);
  return report;
}

// Proof that technicians were called one at a time, worked out from the technicians'
// own timestamps (so it also works on reports saved before this existed).
//
// A technician is "being offered the call" from when they were dialled until their
// outcome (accepted, declined, no answer, ...): only in that window can they press 1.
// One-at-a-time means at most one technician is in that window at any moment, and
// each technician is dialled only after the previous one's outcome.
//
// The phone line can stay open a little longer while the server hangs it up (for
// example after voicemail is detected). That is reported separately, as the line
// overlap; a technician whose outcome is set can no longer accept.
function sequenceOf(technicians, now = Date.now()) {
  const ms = (iso) => (iso ? Date.parse(iso) : null);
  const dialled = (technicians || [])
    .map((tech, index) => ({ tech, index }))
    .filter(({ tech }) => tech.dialled_at)
    .sort((a, b) => ms(a.tech.dialled_at) - ms(b.tech.dialled_at));

  const maxAtOnce = (intervals) => {
    const events = [];
    for (const [from, to] of intervals) events.push([from, 1], [to, -1]);
    // At the same instant, an end counts before a start (back-to-back is not overlap).
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let open = 0, max = 0;
    for (const [, step] of events) max = Math.max(max, (open += step));
    return max;
  };

  const steps = dialled.map(({ tech, index }, k) => {
    const prev = k > 0 ? dialled[k - 1].tech : null;
    const gapMs = prev && prev.outcome_at ? ms(tech.dialled_at) - ms(prev.outcome_at) : null;
    const lineOverlapMs = prev && prev.line_closed_at ? Math.max(0, ms(prev.line_closed_at) - ms(tech.dialled_at)) : null;
    const end = ms(tech.outcome_at);
    return {
      technician: index + 1,
      number: tech.number,
      outcome: tech.outcome,
      dialled_at: tech.dialled_at,
      outcome_at: tech.outcome_at,
      line_closed_at: tech.line_closed_at || null,
      seconds_offered: end ? Math.round((end - ms(tech.dialled_at)) / 100) / 10 : null,
      // How long after the previous technician's outcome this one was dialled.
      dialled_ms_after_previous_outcome: gapMs,
      // How long the previous technician's line was still closing after this one was dialled.
      previous_line_still_closing_ms: lineOverlapMs,
    };
  });

  const offered = dialled.map(({ tech }) => [ms(tech.dialled_at), ms(tech.outcome_at) || now]);
  const lines = dialled.map(({ tech }) => [ms(tech.dialled_at), ms(tech.line_closed_at) || ms(tech.outcome_at) || now]);
  const maxOffered = maxAtOnce(offered);
  const dialledInOrder = steps.every((s) => s.dialled_ms_after_previous_outcome === null || s.dialled_ms_after_previous_outcome >= 0);
  return {
    one_at_a_time: dialled.length > 0 && maxOffered <= 1 && dialledInOrder,
    technicians_dialled: dialled.length,
    max_offered_the_call_at_once: maxOffered,
    max_phone_lines_open_at_once: maxAtOnce(lines),
    each_dialled_after_previous_outcome: dialledInOrder,
    steps,
  };
}

// Turns ElevenLabs conversation details into the transcript stored with a report.
function buildTranscript(details, fetchedAt = Date.now()) {
  const conversations = [...details]
    .sort((a, b) => (a.metadata?.start_time_unix_secs || 0) - (b.metadata?.start_time_unix_secs || 0))
    .map((detail) => {
      const startMs = (detail.metadata?.start_time_unix_secs || 0) * 1000;
      const at = (seconds) => (startMs ? new Date(startMs + seconds * 1000).toISOString() : null);
      const entries = [];
      for (const turn of detail.transcript || []) {
        const seconds = turn.time_in_call_secs || 0;
        if (turn.message) {
          entries.push({ role: turn.role === 'agent' ? 'agent' : 'user', text: turn.message, seconds, at: at(seconds), interrupted: Boolean(turn.interrupted) });
        }
        for (const call of turn.tool_calls || []) {
          entries.push({ role: 'tool', text: `called ${call.tool_name}`, seconds, at: at(seconds), interrupted: false });
        }
      }
      return {
        conversation_id: detail.conversation_id,
        status: detail.status,
        started_at: startMs ? new Date(startMs).toISOString() : null,
        duration_seconds: detail.metadata?.call_duration_secs ?? null,
        summary: detail.analysis?.transcript_summary || null,
        entries,
      };
    });

  // ElevenLabs finishes a transcript ("done") a little after the conversation ends.
  const settled = conversations.length > 0 && conversations.every((c) => c.status === 'done' || c.status === 'failed');
  return {
    status: settled ? 'final' : conversations.length ? 'partial' : 'pending',
    fetched_at: new Date(fetchedAt).toISOString(),
    error: null,
    conversations,
  };
}

// ---------------------------------------------------------------- HTML

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const dash = (value) => (value === null || value === undefined || value === '' ? '-' : esc(value));
const seconds = (value) => (value === null || value === undefined ? '-' : `${esc(value)}s`);
const time = (isoString) => (isoString ? esc(isoString.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')) : '-');

function resultLabel(report) {
  if (!report.result) return 'searching';
  if (report.result === 'connected') return `connected to ${esc(report.connected_technician)}`;
  return esc(report.result);
}

function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; margin: 24px; color: #1a1a1a; background: #fff; }
  h1 { font-size: 20px; }
  h2 { font-size: 16px; margin-top: 28px; }
  h3 { font-size: 15px; margin-top: 22px; }
  h4 { font-size: 14px; margin: 16px 0 6px; }
  audio { width: 260px; }
  .tabs { margin-top: 24px; }
  .tabs > input { position: absolute; opacity: 0; pointer-events: none; }
  .tabbar { border-bottom: 1px solid #ccc; }
  .tabbar label { display: inline-block; padding: 6px 14px; margin: 0 2px -1px 0; border: 1px solid #ccc; border-radius: 4px 4px 0 0; background: #f2f2f2; cursor: pointer; }
  .tabs > .panel { display: none; }
  .tabs > .panel > h2:first-child { margin-top: 16px; }
  details { margin: 8px 0; }
  summary { cursor: pointer; padding: 4px 0; }
  tr.uncertain td { color: #666; }
  .wrap { overflow-x: auto; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; vertical-align: top; white-space: nowrap; }
  td.text { white-space: normal; min-width: 240px; }
  th { background: #f2f2f2; }
  pre { background: #f6f6f6; padding: 12px; overflow-x: auto; }
  table.transcript td.text { min-width: 420px; max-width: 760px; }
  tr.agent td { background: #f3f8ff; }
  tr.tool td { color: #666; font-style: italic; }
  tr.unheard td { color: #999; background: #f7f7f7; text-decoration: line-through; }
  tr.marker td { background: #fff6d6; font-weight: 600; }
  .verdict { padding: 10px 14px; border-radius: 6px; font-weight: 600; display: inline-block; }
  .verdict.yes { background: #e6f4e6; color: #116611; }
  .verdict.no { background: #fbe9e9; color: #a33; }
  .timeline { max-width: 900px; margin: 8px 0 4px; }
  .lane { display: flex; align-items: center; height: 28px; border-bottom: 1px dashed #e4e4e4; }
  .lane .label { width: 190px; flex: none; font-size: 12px; color: #333; }
  .lane .track { position: relative; flex: 1; height: 100%; border-left: 1px solid #bbb; }
  .lane .offer { position: absolute; top: 6px; height: 16px; min-width: 2px; background: #4a7bd0; border-radius: 3px; }
  .lane .offer.accepted { background: #2e8b57; }
  .lane .closing { position: absolute; top: 10px; height: 8px; background: #bbb; border-radius: 2px; }
  .axis { display: flex; justify-content: space-between; font-size: 12px; color: #666; margin-left: 190px; }
  .legend span { display: inline-block; width: 14px; height: 10px; border-radius: 2px; margin: 0 4px 0 12px; vertical-align: middle; }
  tr.cue td { color: #666; font-style: italic; background: #f4f0ff; }
  tr.announcement td { color: #555; font-style: italic; }
  .note { color: #8a5a00; }
  .connected { color: #116611; font-weight: 600; }
  .other { color: #a33; font-weight: 600; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function renderList(reports) {
  const rows = reports.map((r) => `<tr>
  <td>${time(r.started_at)}</td>
  <td>${dash(r.resident_number)}</td>
  <td>${dash(r.dial_mode)}</td>
  <td>${sequenceCell(r)}</td>
  <td>${r.transfer_style ? 'stays' : 'leaves'}</td>
  <td class="${r.result === 'connected' ? 'connected' : 'other'}">${resultLabel(r)}</td>
  <td>${seconds(r.resident_wait_seconds)}</td>
  <td>${(r.technicians || []).filter((tech) => tech.outcome !== 'not-called').map((tech) => `${esc(tech.number)}: ${esc(tech.outcome)}`).join('<br>') || '-'}</td>
  <td class="text">${dash(r.summary)}</td>
  <td class="text">${(r.messages || []).length ? esc(r.messages.map((m) => m.text).join(' / ')) : '-'}</td>
  <td><a href="/reports/${esc(r.resident_call_sid)}">${transcriptLineCount(r) ? `${transcriptLineCount(r)} lines` : 'open'}</a></td>
  <td><a href="/reports/${esc(r.resident_call_sid)}">${esc(r.resident_call_sid)}</a></td>
</tr>`);

  return page('Transfer reports', `<h1>Transfer reports (${reports.length})</h1>
${reports.length === 0 ? '<p>No transfers yet. A report appears here as soon as Iris calls request_transfer.</p>' : `<div class="wrap"><table>
<tr><th>Started</th><th>Resident</th><th>Mode</th><th>Sequence</th><th>Agent</th><th>Result</th><th>Resident waited</th><th>Technicians</th><th>Summary</th><th>Message</th><th>Transcript</th><th>Call SID</th></tr>
${rows.join('\n')}
</table></div>`}`);
}

function transcriptLineCount(r) {
  return ((r.transcript && r.transcript.conversations) || []).reduce((n, c) => n + c.entries.filter((e) => e.role !== 'tool').length, 0);
}

// The conversation as ElevenLabs heard it, with the transfer's key moments placed in between.
function renderTranscript(r) {
  const transcript = r.transcript;
  if (!transcript) {
    return '<h2>ElevenLabs transcript</h2>\n<p>Not fetched yet. It is collected from ElevenLabs shortly after the call ends. Reload this page to try again.</p>';
  }

  const notes = [];
  if (transcript.status === 'partial') notes.push('The call is still in progress, or ElevenLabs is still processing it. Reload this page for the latest.');
  if (transcript.status === 'pending') notes.push('ElevenLabs has no conversation for this call yet. Reload this page in a few seconds.');
  if (transcript.status === 'unavailable') notes.push(`Could not fetch the transcript from ElevenLabs: ${esc(transcript.error)}`);

  // ElevenLabs' lines placed on the server's clock (see elevenLabsLines in merge.js).
  const rows = elevenLabsLines(r);
  rows.push({ at: r.started_at, role: 'marker', text: 'Iris asked for a technician (request_transfer)' });
  const joinedAt = r.result === 'connected' ? r.finished_at : null;
  if (r.result && r.finished_at) {
    const ending = {
      connected: `Technician ${r.connected_technician} joined the call`,
      'no technician': 'No technician was available',
      'resident hung up': 'Resident hung up',
    }[r.result];
    if (ending) rows.push({ at: r.finished_at, role: 'marker', text: ending });
  }
  // Reports from before periods existed only have one start and one end.
  const holdPeriods = r.hold_periods || (r.hold_started_at ? [{ from: r.hold_started_at, to: r.hold_ended_at }] : []);
  const mutePeriods = r.agent_mute_periods || (r.agent_muted_at ? [{ from: r.agent_muted_at, to: r.agent_unmuted_at }] : []);
  for (const p of holdPeriods) {
    rows.push({ at: p.from, role: 'marker', text: 'Resident put on hold with music' });
    if (p.to) rows.push({ at: p.to, role: 'marker', text: 'Resident taken off hold' });
  }
  for (const p of mutePeriods) {
    rows.push({ at: p.from, role: 'marker', text: 'Iris muted: she keeps listening but nobody hears her' });
    if (p.to) rows.push({ at: p.to, role: 'marker', text: 'Iris unmuted' });
  }
  for (const m of r.messages || []) {
    rows.push({ at: m.at, role: 'marker', text: `Iris saved a message: "${m.text}"` });
  }
  for (const u of r.resident_updates || []) {
    rows.push({ at: u.at, role: 'marker', text: `Technician ${u.technician} (${u.number}) did not take the call: Iris cued to tell the resident` });
  }
  rows.sort((a, b) => String(a.at || '9').localeCompare(String(b.at || '9')));

  // Anything the model "said" while its leg was muted was never heard on the call.
  const whileMuted = (row) => Boolean(row.at && mutePeriods.some((p) => row.at >= p.from && (!p.to || row.at < p.to)));

  // ElevenLabs labels everything Iris hears that is not her own voice as "user". Two
  // kinds of those lines are the server's, not the caller's:
  //  - cues played to Iris's leg only ("Technician 1 did not pick up...", "No technician
  //    is available right now."): nobody else on the call heard them (decision.md D3, D12)
  //  - the room announcement "A technician has joined the call." in Twilio's voice
  // Speech recognition may write numbers as words and may merge the caller's own words
  // into the same line, so the match is loose and any extra words are flagged.
  const CUE_TO_IRIS = /technician \w+ did not pick up\.?(\s*calling technician \w+ now\.?)?|no technician is available right now\.?/i;
  const ROOM_ANNOUNCEMENT = /a technician has joined the call\.?/i;
  const extraWords = (text, re) => /[a-z]/i.test(text.replace(re, ''));
  const serverLine = (row) => {
    if (row.role !== 'user') return null;
    if (CUE_TO_IRIS.test(row.text)) {
      return { cls: 'cue', label: extraWords(row.text, CUE_TO_IRIS) ? 'Cue to Iris only, plus the caller' : 'Cue to Iris only (resident did not hear it)' };
    }
    if (ROOM_ANNOUNCEMENT.test(row.text)) {
      return { cls: 'announcement', label: extraWords(row.text, ROOM_ANNOUNCEMENT) ? 'Room announcement (Twilio), plus the caller' : 'Room announcement (Twilio)' };
    }
    return null;
  };

  // ElevenLabs hears one audio stream, so once the technician is in the room it
  // cannot tell the resident and the technician apart.
  const speaker = (row) => {
    if (row.role === 'agent') return whileMuted(row) ? 'Iris (muted, not heard)' : 'Iris';
    if (row.role === 'tool') return 'Iris (tool)';
    const server = serverLine(row);
    if (server) return server.label;
    if (joinedAt && row.at && row.at >= joinedAt && r.transfer_style) return 'Resident or technician';
    return 'Resident';
  };
  const rowClass = (row) => {
    const server = serverLine(row);
    if (server) return server.cls;
    return `${row.role}${row.role === 'agent' && whileMuted(row) ? ' unheard' : ''}`;
  };

  const body = rows.map((row) => (row.role === 'marker'
    ? `<tr class="marker"><td>${row.at ? esc(row.at.slice(11, 19)) : '-'}</td><td colspan="2">${esc(row.text)}</td></tr>`
    : `<tr class="${esc(rowClass(row))}"><td>${row.at ? esc(row.at.slice(11, 19)) : '-'}</td><td>${esc(speaker(row))}</td><td class="text">${esc(row.text)}${row.interrupted ? ' <em>(interrupted)</em>' : ''}</td></tr>`));

  const summaries = transcript.conversations.filter((c) => c.summary).map((c) => `<p><strong>ElevenLabs summary:</strong> ${esc(c.summary)}</p>`);
  const lines = transcriptLineCount(r);

  return `<h2>ElevenLabs transcript</h2>
${notes.map((note) => `<p class="note">${note}</p>`).join('\n')}
${summaries.join('\n')}
${lines === 0 && notes.length === 0 ? '<p>ElevenLabs returned no spoken lines for this call.</p>' : ''}
${lines === 0 ? '' : `<p>Times are UTC. ${r.transfer_style ? 'After the technician joins, ElevenLabs hears the resident and the technician as one voice, so those lines are labelled "Resident or technician". Iris is muted while the resident is on hold and while the technician is on the call: lines marked "muted, not heard" are things the model produced that nobody on the call heard. ElevenLabs lists everything Iris hears as the caller, so the server\'s own lines are relabelled: "Cue to Iris only" lines were played to Iris alone (the resident did not hear them; Iris then says it in her own words), and "Room announcement (Twilio)" lines were spoken by Twilio to everyone.' : 'Iris leaves when the technician joins, so the conversation between the resident and the technician is not included.'}</p>
<div class="wrap"><table class="transcript">
<tr><th>Time</th><th>Speaker</th><th>Said</th></tr>
${body.join('\n')}
</table></div>`}`;
}

// ---------------------------------------------------------------- Twilio section

// Server lines that can show up in a live transcript. The room announcement is heard by
// everyone; the cues are played to Iris's leg only.
const ROOM_JOINED_LINE = /a technician has joined the call/i;
const CUE_TO_IRIS_LINE = /technician \w+ did not pick up|no technician is available right now/i;

const recordingRank = (rec) => ({ room: 0, resident: 1, technician: 2 })[rec.kind] ?? 3;

function recordingTitle(rec) {
  if (rec.kind === 'room') return 'Room (the whole conference)';
  if (rec.kind === 'resident') return "Resident's line";
  if (rec.kind === 'technician') return `Technician ${rec.technician}'s line`;
  return 'Recording';
}

function recordingContents(rec) {
  if (rec.kind === 'room') {
    return 'Everything said in the room, mixed into one channel. No hold music (only the resident hears it) and no technician brief (that is on the technician\'s own line).';
  }
  if (rec.kind === 'resident') {
    return 'The resident\'s voice on one channel, and everything the resident heard on the other: Iris, the hold music, the updates and the technician.';
  }
  if (rec.kind === 'technician') {
    return 'The technician\'s voice on one channel, and everything they heard on the other: the brief and "Press 1", then the resident once they joined.';
  }
  return '';
}

const clock = (isoString) => (isoString ? esc(isoString.slice(11, 19)) : '-');
const mmss = (secondsValue) => {
  if (!Number.isFinite(secondsValue)) return '-';
  const whole = Math.floor(secondsValue);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};
const percent = (value) => (value === null || value === undefined || !Number.isFinite(Number(value)) ? '-' : `${Math.round(Number(value) * 100)}%`);

// Who said a live-transcript line. The "inbound" track is the person on that line, so
// it is certain. The "outbound" track is everything that person hears, so it is named
// from the call's own timeline (on hold, technician in the room, Iris muted).
function liveSpeaker(r, row) {
  const winner = (r.technicians || []).find((tech) => tech.outcome === 'accepted');
  const joinedAt = r.result === 'connected' ? r.finished_at : null;
  const leftAt = winner ? winner.line_closed_at : null;
  const techInRoom = (at) => Boolean(joinedAt && at >= joinedAt && (!leftAt || at < leftAt));
  const within = (periods, at) => (periods || []).some((p) => at >= p.from && (!p.to || at < p.to));
  const inbound = row.track === 'inbound_track';
  const outbound = row.track === 'outbound_track';

  if (row.leg === 'resident') {
    if (inbound) return 'Resident';
    if (!outbound) return 'Unknown track';
    if (ROOM_JOINED_LINE.test(row.text)) return 'Room announcement (Twilio)';
    if (within(r.hold_periods, row.at)) return 'Hold music';
    return techInRoom(row.at) ? 'Technician' : 'Iris';
  }
  if (row.leg === 'technician') {
    if (inbound) return `Technician ${row.technician}`;
    if (!outbound) return 'Unknown track';
    if (ROOM_JOINED_LINE.test(row.text)) return 'Room announcement (Twilio)';
    const isWinner = winner && (r.technicians || []).indexOf(winner) + 1 === row.technician;
    return isWinner && joinedAt && row.at >= joinedAt ? 'Resident' : 'Twilio (brief to the technician)';
  }
  if (row.leg === 'iris') {
    if (outbound) return within(r.agent_mute_periods, row.at) ? 'Iris (muted, not heard)' : 'Iris';
    if (!inbound) return 'Unknown track';
    if (CUE_TO_IRIS_LINE.test(row.text)) return 'Cue to Iris only (resident did not hear it)';
    if (ROOM_JOINED_LINE.test(row.text)) return 'Room announcement (Twilio)';
    return techInRoom(row.at) ? 'Resident or technician' : 'Resident';
  }
  return 'Unknown line';
}

const TRACK_LABEL = {
  resident: { inbound_track: 'inbound (resident\'s voice)', outbound_track: 'outbound (what the resident hears)' },
  technician: { inbound_track: 'inbound (technician\'s voice)', outbound_track: 'outbound (what the technician hears)' },
  iris: { inbound_track: 'inbound (what Iris hears)', outbound_track: 'outbound (Iris\'s voice)' },
};

function renderRecordings(r, tw) {
  const recordings = [...(tw.recordings || [])].sort((a, b) => recordingRank(a) - recordingRank(b) || (a.technician || 0) - (b.technician || 0));
  const rows = recordings.map((rec) => {
    const audioUrl = `/reports/${esc(r.resident_call_sid)}/recordings/${esc(rec.recording_sid)}.mp3`;
    const listen = rec.status === 'completed'
      ? `<audio controls preload="none" src="${audioUrl}"></audio><br><a href="${audioUrl}" download>download .mp3</a>`
      : '-';
    return `<tr>
  <td><strong>${esc(recordingTitle(rec))}</strong></td>
  <td class="text">${esc(recordingContents(rec))}</td>
  <td>${dash(rec.channels)}</td>
  <td>${rec.duration_seconds === null || rec.duration_seconds === undefined ? '-' : `${esc(rec.duration_seconds)} s`}</td>
  <td>${dash(rec.status)}${rec.error ? `<br><span class="note">${esc(rec.error)}</span>` : ''}</td>
  <td>${listen}</td>
  <td>${dash(rec.recording_sid)}</td>
</tr>`;
  });

  // Recordings we expected but Twilio has not reported (yet).
  const missing = [];
  if (!recordings.some((rec) => rec.kind === 'room')) missing.push('Room recording: not reported by Twilio yet (it arrives a few seconds after the call ends).');
  if (tw.settings && tw.settings.record_legs) {
    if (!recordings.some((rec) => rec.kind === 'resident')) missing.push('Resident\'s line: not reported by Twilio yet.');
    (r.technicians || []).forEach((tech, i) => {
      if (tech.answered_at && !recordings.some((rec) => rec.kind === 'technician' && rec.technician === i + 1)) {
        missing.push(`Technician ${i + 1}'s line: they answered, but Twilio has not reported a recording yet.`);
      }
    });
  }

  return `<h3>Recordings</h3>
<p>Play them here; the server fetches the audio from Twilio. Two-channel recordings play in stereo: one person's voice in one ear, what they heard in the other.</p>
${rows.length ? `<div class="wrap"><table>
<tr><th>Recording</th><th>What is on it</th><th>Channels</th><th>Length</th><th>Status</th><th>Listen</th><th>Recording SID</th></tr>
${rows.join('\n')}
</table></div>` : '<p>No recordings reported by Twilio yet.</p>'}
${missing.map((m) => `<p class="note">${esc(m)}</p>`).join('\n')}`;
}

// A collapsible block, so the Twilio tab shows one line per source until it is opened.
const fold = (title, count, body, open = false) => `<details${open ? ' open' : ''}><summary><strong>${esc(title)}</strong>${count === null ? '' : ` <span class="note">(${esc(count)})</span>`}</summary>
${body}
</details>`;

function renderLiveTranscripts(r, tw) {
  const settings = tw.settings || {};
  if (!settings.live_transcription) return '<h3>Live transcripts (Twilio Real-Time Transcription)</h3>\n<p>Live transcription was off for this call (LIVE_TRANSCRIPTION=false).</p>';

  const lines = tw.live_transcript || [];
  const events = tw.live_events || [];
  const legs = [{ leg: 'resident', technician: null, title: 'Resident\'s line' }];
  const techNumbers = new Set([...lines, ...events].filter((x) => x.leg === 'technician').map((x) => x.technician));
  [...techNumbers].sort((a, b) => a - b).forEach((n) => legs.push({ leg: 'technician', technician: n, title: `Technician ${n}'s line` }));
  if (settings.live_transcription_iris_leg) legs.push({ leg: 'iris', technician: null, title: 'Iris\'s line (the whole room, as Iris hears it)' });

  const sections = legs.map(({ leg, technician, title }) => {
    const same = (x) => x.leg === leg && (leg !== 'technician' || x.technician === technician);
    const rows = [
      ...lines.filter(same).map((row) => ({ kind: 'line', ...row })),
      ...events.filter(same).map((event) => ({ kind: 'event', ...event })),
    ].sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const count = rows.filter((row) => row.kind === 'line').length;
    if (!rows.length) return fold(title, 'nothing received', '<p>Nothing received from Twilio for this line.</p>');
    const body = rows.map((row) => (row.kind === 'event'
      ? `<tr class="marker"><td>${clock(row.at)}</td><td colspan="4">${esc(row.event)}${row.detail ? `: ${esc(row.detail)}` : ''}</td></tr>`
      : `<tr class="${row.track === 'inbound_track' ? '' : 'agent'}"><td>${clock(row.at)}</td><td>${esc((TRACK_LABEL[leg] || {})[row.track] || row.track || '-')}</td><td>${esc(liveSpeaker(r, row))}</td><td class="text">${esc(row.text)}</td><td>${percent(row.confidence)}</td></tr>`));
    const errors = rows.filter((row) => row.kind === 'event' && /error/.test(row.event)).length;
    return fold(title, `${count} line${count === 1 ? '' : 's'}${errors ? `, ${errors} error${errors === 1 ? '' : 's'}` : ''}`, `<div class="wrap"><table class="transcript">
<tr><th>Time (UTC)</th><th>Track</th><th>Speaker</th><th>Said</th><th>Confidence</th></tr>
${body.join('\n')}
</table></div>`);
  });

  return `<h3>Live transcripts (Twilio Real-Time Transcription)</h3>
<p>Made while the call was happening, one per phone line, in two tracks: <em>inbound</em> is the voice of the person on that line, so that speaker is certain; <em>outbound</em> is everything they hear, so that speaker is named from the call's timeline. On Iris's leg it is the other way round: inbound is the room she hears, outbound is her own voice.</p>
${sections.join('\n')}`;
}

function renderOperatorResults(results) {
  if (!results || !results.length) return '';
  const items = results.map((op) => {
    const value = op.result;
    let shown;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const filled = Object.entries(value).filter(([, v]) => v !== '' && v !== null && v !== undefined);
      shown = filled.length
        ? `<ul>${filled.map(([k, v]) => `<li><strong>${esc(k)}:</strong> ${esc(typeof v === 'string' ? v : JSON.stringify(v))}</li>`).join('')}</ul>`
        : '<span class="note">(empty: Twilio found nothing to fill in)</span>';
    } else {
      shown = value === null || value === undefined || value === '' ? '<span class="note">(empty)</span>' : esc(typeof value === 'string' ? value : JSON.stringify(value));
    }
    return `<p><strong>${esc(op.name)}</strong>: ${shown}</p>`;
  });
  return `<p><strong>Twilio summary</strong> (operators that the account's Intelligence service runs on every transcript):</p>\n${items.join('\n')}`;
}

// Channel 1 of a line's recording is the person on that line, channel 2 is what they
// heard (confirmed on a real call, 2026-11-26).
function channelLabel(rec, channel) {
  if (rec.kind === 'room' || rec.channels === 1) return 'mixed (everyone)';
  const owner = rec.kind === 'technician' ? `Technician ${rec.technician}` : 'Resident';
  return Number(channel) === 1 ? owner : `heard by ${owner.toLowerCase()}`;
}

function renderIntelligence(r, tw) {
  const recordings = [...(tw.recordings || [])].sort((a, b) => recordingRank(a) - recordingRank(b) || (a.technician || 0) - (b.technician || 0));
  if (!recordings.length) return '<h3>Post-call transcripts (Twilio Conversational Intelligence)</h3>\n<p>No recordings yet, so nothing to transcribe.</p>';

  const sections = recordings.map((rec) => {
    const title = recordingTitle(rec);
    const it = (tw.intelligence || {})[rec.recording_sid];
    let status = null;
    if (rec.status !== 'completed') status = 'The recording is not finished yet.';
    else if (!it) status = 'Not fetched yet. Reload this page.';
    else if (it.status === 'none') status = 'Twilio has no transcript of this recording yet. It usually appears within a minute of the call ending. Reload this page to check again.';
    else if (it.status === 'unavailable') status = `Could not fetch Twilio's transcript: ${it.error}`;
    else if (it.status !== 'completed') status = `Twilio is still transcribing this recording (status: ${it.status}). Reload this page in a few seconds.`;
    if (status) return fold(title, 'not available yet', `<p class="note">${esc(status)}</p>`);

    const mono = rec.kind === 'room' || rec.channels === 1;
    const rows = (it.sentences || []).map((s) => `<tr><td>${mmss(s.start)}</td><td>${esc(channelLabel(rec, s.channel))}</td><td class="text">${esc(s.text)}</td><td>${percent(s.confidence)}</td></tr>`);
    return fold(title, `${rows.length} sentence${rows.length === 1 ? '' : 's'}`, `<p>Recording ${esc(rec.recording_sid)}, transcript ${esc(it.transcript_sid)}${it.transcripts_found > 1 ? ` (Twilio made ${esc(it.transcripts_found)} transcripts of this recording; this is one of them)` : ''}.${mono ? ' One channel, so Twilio cannot tell the speakers apart.' : ' Channel 1 is the person on this line, channel 2 is what they heard.'}</p>
${renderOperatorResults(it.operator_results)}
${rows.length ? `<div class="wrap"><table class="transcript">
<tr><th>Time in recording</th><th>Speaker (channel)</th><th>Said</th><th>Confidence</th></tr>
${rows.join('\n')}
</table></div>` : '<p>Twilio found no speech in this recording.</p>'}`);
  });

  return `<h3>Post-call transcripts (Twilio Conversational Intelligence)</h3>
<p>The Twilio account transcribes every recording automatically after the call. Fetched from Twilio when this page is opened.</p>
${sections.join('\n')}`;
}

const NO_TWILIO = '<p>This report was made before Twilio recordings were added to reports. The room recording is still in Twilio: look for the "RECORDING completed" line in the server log.</p>';

function renderTwilioTranscripts(r) {
  const tw = r.twilio;
  if (!tw) return `<h2>Twilio transcripts</h2>\n${NO_TWILIO}`;
  const s = tw.settings || {};
  const onOff = (v) => (v ? 'on' : 'off');
  return `<h2>Twilio transcripts</h2>
<p>Settings for this call: separate recording of each line <strong>${onOff(s.record_legs)}</strong> · live transcription <strong>${onOff(s.live_transcription)}</strong> · live transcription of Iris's leg <strong>${onOff(s.live_transcription && s.live_transcription_iris_leg)}</strong>. Click a line to open it.</p>
${renderLiveTranscripts(r, tw)}
${renderIntelligence(r, tw)}`;
}

function renderRecordingsTab(r) {
  if (!r.twilio) return `<h2>Recordings</h2>\n${NO_TWILIO}`;
  return `<h2>Recordings</h2>\n${renderRecordings(r, r.twilio)}`;
}

// The Twilio summary of the call: from the resident's recording if there is one (it
// covers the whole call), otherwise the room recording.
function twilioSummary(r) {
  const tw = r.twilio;
  if (!tw) return null;
  for (const kind of ['resident', 'room']) {
    const rec = (tw.recordings || []).find((x) => x.kind === kind && x.status === 'completed');
    const it = rec && (tw.intelligence || {})[rec.recording_sid];
    const op = it && (it.operator_results || []).find((o) => o.name === 'MaintenanceSummary');
    const text = op && op.result && typeof op.result === 'object' ? op.result.transcript_summary : op && op.result;
    if (text) return String(text);
  }
  return null;
}

function renderMerged(r) {
  const merged = buildMergedTranscript(r);
  const lines = merged.rows.filter((row) => row.kind === 'line');
  const elSummary = ((r.transcript && r.transcript.conversations) || []).map((c) => c.summary).find(Boolean);
  const twSummary = twilioSummary(r);
  const summaries = [
    elSummary ? `<p><strong>ElevenLabs summary:</strong> ${esc(elSummary)}</p>` : '',
    twSummary ? `<p><strong>Twilio summary:</strong> ${esc(twSummary)}</p>` : '',
  ].join('\n');

  if (!lines.length) {
    return `<h2>Merged transcript</h2>
${summaries}
<p>Nothing to merge yet: no ElevenLabs transcript and no Twilio transcript for this call. Reload this page a minute after the call has ended.</p>`;
  }

  const rowClass = (row) => {
    if (row.unheard) return 'unheard';
    if (row.speaker.startsWith('Iris')) return 'agent';
    if (row.speaker.startsWith('Twilio')) return 'announcement';
    return row.uncertain ? 'uncertain' : '';
  };
  const body = merged.rows.map((row) => (row.kind === 'event'
    ? `<tr class="marker"><td>${clock(row.at)}</td><td colspan="3">${esc(row.text)}</td></tr>`
    : `<tr class="${rowClass(row)}"><td>${clock(row.at)}</td><td>${esc(row.speaker)}</td><td class="text">${esc(row.text)}${row.interrupted ? ' <em>(interrupted)</em>' : ''}</td><td${row.twilioText ? ` title="${esc(`Twilio heard: ${row.twilioText}`)}"` : ''}>${esc(row.textFrom)}${row.twilioText ? ' *' : ''}</td></tr>`));

  const sources = merged.sources.length
    ? `<ul>${merged.sources.map((x) => `<li><strong>${esc(x.speaker)}</strong>: ${esc(x.source)}</li>`).join('')}</ul>`
    : '<p class="note">No Twilio line transcripts for this call, so the resident and technician cannot be told apart: those lines come from ElevenLabs and are named from the timeline only.</p>';

  return `<h2>Merged transcript</h2>
${summaries}
<p>One transcript for the whole call. <strong>Who</strong> spoke comes from Twilio, which keeps each person's phone line separate. <strong>What</strong> they said comes from ElevenLabs where it heard the same words (its text is more accurate), otherwise from Twilio. Iris's lines are her own words from ElevenLabs, and Twilio's announcements and the yellow events come from the server's record. Times are UTC.</p>
<div class="wrap"><table class="transcript">
<tr><th>Time</th><th>Speaker</th><th>Said</th><th>Text from</th></tr>
${body.join('\n')}
</table></div>
<p class="note">* Hover "Text from" to see what Twilio heard for that line. ${merged.stats.text_from_elevenlabs} of the people's lines use ElevenLabs' text.</p>
<h3>Where each speaker comes from</h3>
${sources}`;
}

// "Call sequence": the evidence that technicians were called one at a time.
function renderSequence(r) {
  const seq = sequenceOf(r.technicians);
  if (seq.technicians_dialled === 0) return '<h2>Call sequence</h2>\n<p>No technician was dialled.</p>';
  const msText = (v) => (v === null || v === undefined ? '-' : v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`);

  const verdict = seq.one_at_a_time
    ? `One at a time: yes. ${seq.technicians_dialled} technician${seq.technicians_dialled === 1 ? '' : 's'} dialled, never more than ${seq.max_offered_the_call_at_once} being offered the call at the same moment, and each one dialled only after the previous one's outcome.`
    : `One at a time: NO. Up to ${seq.max_offered_the_call_at_once} technicians were being offered the call at the same moment${seq.each_dialled_after_previous_outcome ? '' : ', and at least one was dialled before the previous one had an outcome'}. This report was probably made with parallel dialling (dial mode: ${r.dial_mode || 'unknown'}).`;

  const rows = seq.steps.map((s, k) => `<tr>
  <td>${s.technician}</td>
  <td>${dash(s.number)}</td>
  <td>${k === 0 ? 'first call' : msText(s.dialled_ms_after_previous_outcome)}</td>
  <td>${time(s.dialled_at)}</td>
  <td>${dash(s.outcome)}<br>${time(s.outcome_at)}</td>
  <td>${s.seconds_offered === null ? '-' : `${esc(s.seconds_offered)} s`}</td>
  <td>${time(s.line_closed_at)}</td>
</tr>`);

  // Timeline: one lane per technician, scaled to the whole search.
  const ms = (iso) => (iso ? Date.parse(iso) : null);
  const t0 = Math.min(...seq.steps.map((s) => ms(s.dialled_at)));
  const t1 = Math.max(...seq.steps.map((s) => ms(s.line_closed_at) || ms(s.outcome_at) || ms(s.dialled_at)), t0 + 1000);
  const pct = (v) => `${(((v - t0) / (t1 - t0)) * 100).toFixed(2)}%`;
  const lanes = seq.steps.map((s) => {
    const from = ms(s.dialled_at);
    const to = ms(s.outcome_at) || t1;
    const closed = ms(s.line_closed_at);
    const closing = closed && closed > to ? `<div class="closing" style="left:${pct(to)};width:calc(${pct(closed)} - ${pct(to)})"></div>` : '';
    return `<div class="lane"><div class="label">Technician ${s.technician} (${esc(s.outcome || 'calling')})</div><div class="track"><div class="offer${s.outcome === 'accepted' ? ' accepted' : ''}" style="left:${pct(from)};width:calc(${pct(to)} - ${pct(from)})"></div>${closing}</div></div>`;
  });

  const overlaps = seq.steps.filter((s) => s.previous_line_still_closing_ms > 0);
  const lineNote = overlaps.length
    ? `<p>Phone lines: ${overlaps.map((s) => `technician ${s.technician - 1}'s line was still closing for ${msText(s.previous_line_still_closing_ms)} after technician ${s.technician} was dialled`).join('; ')}. That is the server hanging up a call that had already been given its outcome; a technician with an outcome cannot accept the call.</p>`
    : (seq.steps.some((s) => s.line_closed_at) ? '<p>Phone lines: no technician\'s line was still open when the next technician was dialled.</p>' : '');

  return `<h2>Call sequence</h2>
<p class="verdict ${seq.one_at_a_time ? 'yes' : 'no'}">${esc(verdict)}</p>
<p>A technician is <em>being offered the call</em> from when they are dialled until their outcome (accepted, declined, no answer, busy, voicemail, failed). Only in that window can they press 1. "Line closed" is the moment Twilio reported their phone call ended.</p>
<div class="wrap"><table>
<tr><th>#</th><th>Number</th><th>Dialled after previous outcome</th><th>Dialled</th><th>Outcome</th><th>Offered for</th><th>Line closed (Twilio)</th></tr>
${rows.join('\n')}
</table></div>
<div class="timeline">${lanes.join('')}</div>
<div class="axis"><span>${time(new Date(t0).toISOString())}</span><span>${((t1 - t0) / 1000).toFixed(1)} s</span></div>
<p class="legend"><span style="background:#4a7bd0"></span>being offered the call<span style="background:#2e8b57"></span>accepted<span style="background:#bbb"></span>line closing after the outcome</p>
${lineNote}`;
}

function renderDetail(r) {
  const techRows = (r.technicians || []).map((tech, i) => {
    const s = tech.seconds_from_tool_call || {};
    return `<tr>
  <td>${i + 1}</td>
  <td>${dash(tech.number)}</td>
  <td>${dash(tech.outcome)}</td>
  <td>${time(tech.dialled_at)}<br>${seconds(s.dialled)}</td>
  <td>${time(tech.ringing_at)}<br>${seconds(s.ringing)}</td>
  <td>${time(tech.answered_at)}<br>${seconds(s.answered)}</td>
  <td>${time(tech.outcome_at)}<br>${seconds(s.outcome)}</td>
  <td>${(r.resident_updates || []).some((u) => u.technician === i + 1) ? 'yes' : '-'}</td>
  <td>${dash(tech.answered_by)}</td>
  <td class="text">${dash(tech.detail)}</td>
  <td>${dash(tech.call_sid)}</td>
</tr>`;
  });

  return page(`Transfer ${r.resident_call_sid}`, `<p><a href="/reports">&larr; All transfers</a></p>
<h1>Transfer for ${dash(r.resident_number)}</h1>
<div class="wrap"><table>
<tr><th>Result</th><td class="${r.result === 'connected' ? 'connected' : 'other'}">${resultLabel(r)}</td></tr>
<tr><th>Resident waited</th><td>${seconds(r.resident_wait_seconds)}</td></tr>
<tr><th>Resident number</th><td>${dash(r.resident_number)}</td></tr>
<tr><th>Resident call SID</th><td>${dash(r.resident_call_sid)}</td></tr>
<tr><th>Call direction</th><td>${dash(r.direction)}</td></tr>
<tr><th>Dial mode</th><td>${dash(r.dial_mode)}</td></tr>
<tr><th>Transfer style</th><td>${dash(r.transfer_style || 'agent leaves the call')}</td></tr>
<tr><th>Tool call (start)</th><td>${time(r.started_at)}</td></tr>
<tr><th>Finished</th><td>${time(r.finished_at)}</td></tr>
<tr><th>Summary</th><td class="text">${dash(r.summary)}</td></tr>
<tr><th>Message</th><td class="text">${(r.messages || []).length
    ? r.messages.map((m) => `<strong>${esc(m.text)}</strong><br><span class="note">saved by Iris at ${time(m.at)}</span>`).join('<br><br>')
    : '-'}</td></tr>
</table></div>

${tabs([
    { id: 'merged', label: 'Merged transcript', body: renderMerged(r) },
    { id: 'elevenlabs', label: 'ElevenLabs transcript', body: renderTranscript(r) },
    { id: 'twilio', label: 'Twilio transcripts', body: renderTwilioTranscripts(r) },
    { id: 'recordings', label: `Recordings${r.twilio ? ` (${(r.twilio.recordings || []).length})` : ''}`, body: renderRecordingsTab(r) },
    { id: 'technicians', label: 'Technicians', body: `<h2>Technicians</h2>
<p>Each time is shown with the seconds since the tool call underneath.</p>
<div class="wrap"><table>
<tr><th>#</th><th>Number</th><th>Outcome</th><th>Dialled</th><th>Ringing</th><th>Answered</th><th>Outcome at</th><th>Resident told</th><th>Machine detection</th><th>Detail</th><th>Call SID</th></tr>
${techRows.join('\n')}
</table></div>

${renderSequence(r)}` },
    { id: 'raw', label: 'Raw record', body: `<h2>Raw record</h2>\n<pre>${esc(JSON.stringify(r, null, 2))}</pre>` },
  ])}`);
}

// Tabs without scripts: one hidden radio button per tab, and CSS shows the panel whose
// button is checked. A few lines of script only keep the chosen tab in the address
// (#twilio etc.), so reloading the page stays on it.
function tabs(list) {
  const css = list.map(({ id }) => `#tab-${id}:checked ~ .tabbar label[for="tab-${id}"] { background: #fff; border-bottom-color: #fff; font-weight: 600; }
#tab-${id}:checked ~ #panel-${id} { display: block; }`).join('\n');
  return `<style>
${css}
</style>
<div class="tabs">
${list.map(({ id }, i) => `<input type="radio" name="tab" id="tab-${id}"${i === 0 ? ' checked' : ''}>`).join('\n')}
<div class="tabbar">${list.map(({ id, label }) => `<label for="tab-${id}">${esc(label)}</label>`).join('')}</div>
${list.map(({ id, body }) => `<div class="panel" id="panel-${id}">
${body}
</div>`).join('\n')}
</div>
<script>
(function () {
  var pick = document.getElementById('tab-' + location.hash.slice(1));
  if (pick) pick.checked = true;
  document.querySelectorAll('.tabs > input').forEach(function (input) {
    input.addEventListener('change', function () { history.replaceState(null, '', '#' + input.id.slice(4)); });
  });
})();
</script>`;
}

// List page: one word per transfer for the one-at-a-time check.
function sequenceCell(r) {
  const seq = sequenceOf(r.technicians);
  if (seq.technicians_dialled === 0) return '-';
  return seq.one_at_a_time ? `<span class="connected">one at a time</span> (${seq.technicians_dialled})` : '<span class="other">overlapping</span>';
}

module.exports = { createReportStore, buildReport, buildTranscript, sequenceOf, renderList, renderDetail };
