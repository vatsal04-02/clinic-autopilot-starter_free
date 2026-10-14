// REQUEST CONFIRMATION (demo / safe appointments): staff turn an appointment REQUEST (Appointments.Status = Requested, Booking_UID "req-...", made by
// W13 in request mode) into Booked or Declined in Grist. This module decides, for each such row that staff have decided and the patient has not been
// told yet (Confirm_Sent empty):
//   confirmed  Status Booked, the slot is still free      -> tell the patient it is confirmed (free text in the 24 h window, else the
//                                                             approved booking_confirmation template); W5 then reminds as for any Booked row
//   conflict   Status Booked, but the slot is already taken -> NOT confirmed: the row goes back to Requested and a Run_Log row says why
//                                                             (no double booking, whatever staff clicked)
//   declined   Status Declined                            -> tell the patient (free text only; outside the 24 h window W12 refuses and
//                                                             Run_Log says "tell the patient by phone")
// Pure functions, no network, no clock but `nowMs`. Pasted into the "REQ – Plan" and "REQ – Build Message" Code nodes.
// Paste from REQC_UID down to (not including) the module.exports line.

const REQC_UID = /^req-/;
const REQC_TEXT_WINDOW_SEC = 24 * 3600 - 5 * 60;     // same margin as W12: a free-text reply needs a patient message in the last 24 h
const REQC_IST = 5.5 * 3600;

const reqcSec = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
const reqcText = (v, max) => String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const reqcFirstName = (name) => reqcText(name, 60).split(' ')[0] || 'there';
const reqcDate = (sec) => { const d = new Date((sec + REQC_IST) * 1000); return `${String(d.getUTCDate()).padStart(2, '0')} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`; };
const reqcTime = (sec) => { const d = new Date((sec + REQC_IST) * 1000); const h = d.getUTCHours(); return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };

// A staff-decided request row that the patient has not been told about yet.
const reqcIsCandidate = (r) => REQC_UID.test(String((r.fields || {}).Booking_UID || '')) && ((r.fields || {}).Status === 'Booked' || (r.fields || {}).Status === 'Declined') && !reqcSec((r.fields || {}).Confirm_Sent) && reqcSec((r.fields || {}).Start);
const reqcEnd = (f) => (reqcSec(f.End) && f.End > f.Start ? f.End : f.Start + 1800);

// The rows that already hold r's slot: other confirmed rows (Booked / Rescheduled) that overlap it. A request staff set to Booked but the patient has not
// been told about yet counts only if its row id is LOWER (the lowest id keeps the slot). Shared by the REQ section (n8n) and FLOW HQ (confirm button),
// so the two can never disagree. rows: all Appointments records; r: the request being confirmed (its own Status does not matter).
function reqcTaken(rows, r) {
  const f = r.fields;
  const end = reqcEnd(f);
  return (rows || []).filter((o) => o && o.fields && Number.isInteger(o.id) && o.id !== r.id && (o.fields.Status === 'Booked' || o.fields.Status === 'Rescheduled') && reqcSec(o.fields.Start)
    && o.fields.Start < end && reqcEnd(o.fields) > f.Start && !(reqcIsCandidate(o) && o.id > r.id));
}
const reqcCapacity = (settings) => { const n = Number(settings && settings.booking_capacity); return Number.isFinite(n) && n >= 1 && n <= 20 ? Math.round(n) : 1; };

// appointments / leadRows / convRecords: Grist records; settings: { key: value }; cfg: { max_per_run }.
// Returns { items, held } - items: what to do now; held: rows looked at and left alone, with the reason (for tests and the Run_Log).
function reqcPlan(appointments, leadRows, convRecords, settings, nowMs, cfg) {
  const now = Math.floor(nowMs / 1000);
  const rows = (appointments || []).filter((r) => r && r.fields && Number.isInteger(r.id));
  const capacity = reqcCapacity(settings);
  const leads = {};
  for (const r of leadRows || []) leads[String(r.id)] = r.fields || {};
  const conv = {};
  for (const r of convRecords || []) { const f = (r && r.fields) || {}; if (f.Lead) { const k = String(f.Lead); if (!conv[k] || r.id < conv[k].id) conv[k] = { id: r.id, last_inbound_at: reqcSec(f.Last_Inbound_At), paused: f.Automation_Paused === true }; } }
  const items = [];
  const held = [];
  for (const r of rows.filter(reqcIsCandidate).sort((a, b) => a.id - b.id)) {
    const f = r.fields;
    const hold = (why) => held.push({ appt_row_id: r.id, booking_uid: f.Booking_UID, reason: why });
    if (f.Start < now - 3600) { hold('the appointment time has already passed'); continue; }
    const lead = String(f.Lead || '');
    const lf = leads[lead];
    if (!/^[1-9]\d*$/.test(lead) || !lf) { hold('lead not found'); continue; }
    const c = conv[lead];
    const base = {
      appt_row_id: r.id, booking_uid: f.Booking_UID, lead_row_id: Number(lead), lead_id: lf.Lead_id || lf.Lead_ID || `row ${lead}`, lead_name: reqcText(lf.Name, 60),
      lead_phone: reqcText(lf.Phone, 20), lead_status: reqcText(lf.Status, 20), start_label: `${reqcDate(f.Start)} at ${reqcTime(f.Start)}`, opted_out: lf.Opted_Out === true, service: reqcText(f.Service, 80) || 'appointment', start: f.Start, end: reqcEnd(f),
      last_inbound_at: c ? c.last_inbound_at : null, flag_value: null,
    };
    if (f.Status === 'Declined') { items.push({ ...base, kind: 'declined' }); continue; }
    const taken = reqcTaken(rows, r);
    if (taken.length >= capacity) items.push({ ...base, kind: 'conflict', conflict_with: taken.slice(0, 3).map((o) => o.fields.Booking_UID || `row ${o.id}`) });
    else items.push({ ...base, kind: 'confirmed' });
  }
  return { items: items.slice(0, Math.max(1, Number(cfg && cfg.max_per_run) || 20)), held };
}

// The W12 item for a confirmed / declined request. Free text inside the 24 h window; a confirmation outside it uses the approved
// booking_confirmation template; a decline has no template (W12 then refuses and the Run_Log row says so).
function reqcMessage(item, clinicName, nowSec) {
  const name = reqcFirstName(item.lead_name);
  const clinic = reqcText(clinicName, 80) || 'the clinic';
  const date = reqcDate(item.start);
  const time = reqcTime(item.start);
  const inWindow = reqcSec(item.last_inbound_at) !== null && nowSec - item.last_inbound_at < REQC_TEXT_WINDOW_SEC;
  if (item.kind === 'confirmed') {
    const text = `Hi ${name}, good news: your ${item.service} at ${clinic} is confirmed for ${date} at ${time}. Reply here if you need to change it.`;
    return inWindow
      ? { message_type: 'text', text_body: text, message_text: text, template: '', template_params: {} }
      : { message_type: 'template', text_body: '', message_text: text, template: 'booking_confirmation', template_params: { name, service: item.service, clinic_name: clinic, date, time } };
  }
  const text = `Hi ${name}, sorry, we could not confirm your request for ${date} at ${time} at ${clinic}. Please reply with another time that suits you and we will help.`;
  return { message_type: 'text', text_body: text, message_text: text, template: '', template_params: {} };
}

// The Run_Log row for an item (one per attempt).
function reqcLog(item, outcome, error, nowSec) {
  return { Workflow: 'REQ-request-confirm', Record: reqcText(`${item.booking_uid} ${item.kind} ${item.lead_id}${item.test_mode ? ' (TEST_MODE)' : ''}`, 200), Outcome: outcome, Error: reqcText(error, 500), At: nowSec };
}

if (typeof module !== 'undefined') module.exports = { REQC_UID, REQC_TEXT_WINDOW_SEC, reqcPlan, reqcTaken, reqcCapacity, reqcIsCandidate, reqcMessage, reqcLog, reqcDate, reqcTime };
