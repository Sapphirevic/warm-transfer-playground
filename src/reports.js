'use strict';

// One JSON file per resident call in reports/, plus the HTML views for GET /reports.

const fs = require('fs');
const path = require('path');

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
function buildReport(t, dialMode) {
  const start = t.startedAt;
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
  const after = (ms) => (ms ? Math.round((ms - start) / 100) / 10 : null);
  const winner = t.winner === null ? null : t.techs[t.winner];

  return {
    resident_call_sid: t.residentCallSid,
    resident_number: t.residentNumber,
    direction: t.direction,
    summary: t.summary,
    dial_mode: dialMode,
    started_at: iso(start),
    finished_at: iso(t.finishedAt),
    // null while the search is still running
    result: t.result,
    connected_technician: t.result === 'connected' && winner ? winner.number : null,
    resident_wait_seconds: after(t.finishedAt),
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
      seconds_from_tool_call: {
        dialled: after(tech.dialledAt),
        ringing: after(tech.ringingAt),
        answered: after(tech.answeredAt),
        pressed_1: after(tech.pressedAt),
        outcome: after(tech.outcomeAt),
      },
    })),
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
  .wrap { overflow-x: auto; }
  table { border-collapse: collapse; }
  th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; vertical-align: top; white-space: nowrap; }
  td.text { white-space: normal; min-width: 240px; }
  th { background: #f2f2f2; }
  pre { background: #f6f6f6; padding: 12px; overflow-x: auto; }
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
  <td class="${r.result === 'connected' ? 'connected' : 'other'}">${resultLabel(r)}</td>
  <td>${seconds(r.resident_wait_seconds)}</td>
  <td>${(r.technicians || []).filter((tech) => tech.outcome !== 'not-called').map((tech) => `${esc(tech.number)}: ${esc(tech.outcome)}`).join('<br>') || '-'}</td>
  <td class="text">${dash(r.summary)}</td>
  <td><a href="/reports/${esc(r.resident_call_sid)}">${esc(r.resident_call_sid)}</a></td>
</tr>`);

  return page('Transfer reports', `<h1>Transfer reports (${reports.length})</h1>
${reports.length === 0 ? '<p>No transfers yet. A report appears here as soon as Ava calls request_transfer.</p>' : `<div class="wrap"><table>
<tr><th>Started</th><th>Resident</th><th>Mode</th><th>Result</th><th>Resident waited</th><th>Technicians</th><th>Summary</th><th>Call SID</th></tr>
${rows.join('\n')}
</table></div>`}`);
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
<tr><th>Tool call (start)</th><td>${time(r.started_at)}</td></tr>
<tr><th>Finished</th><td>${time(r.finished_at)}</td></tr>
<tr><th>Summary</th><td class="text">${dash(r.summary)}</td></tr>
</table></div>

<h2>Technicians</h2>
<p>Each time is shown with the seconds since the tool call underneath.</p>
<div class="wrap"><table>
<tr><th>#</th><th>Number</th><th>Outcome</th><th>Dialled</th><th>Ringing</th><th>Answered</th><th>Outcome at</th><th>Machine detection</th><th>Detail</th><th>Call SID</th></tr>
${techRows.join('\n')}
</table></div>

<h2>Raw record</h2>
<pre>${esc(JSON.stringify(r, null, 2))}</pre>`);
}

module.exports = { createReportStore, buildReport, renderList, renderDetail };
