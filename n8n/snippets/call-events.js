// MISSED_CALL_CAPTURE: the pure functions behind the "MCC –" Code nodes (n8n/mcc/code/*.js). No network, no Grist, no clock but `nowMs`.
// Shared helpers come in as `h` (normalizeIndianPhone, decideSend), so the same code runs pasted into n8n and in Node tests.
// Paste from CE_STATUS_MISSED down to (not including) the module.exports line.
//
// What this module decides
//   ceValidate     the webhook request: shared secret, body shape, status, phones, time -> reject (4xx/503) / ignore / process
//   ceResolveClinic  WHICH clinic owns the called number: only from the Agency Registry (Clinics.Call_Number). A clinic / tenant /
//                    doc id in the request body is never read.
//   ceClassifyExisting / ceCanonical  retries and concurrent copies of one event (key "call-<provider_call_id>" in Messages.WA_Message_ID)
//   ceAckOutcome   what the W12 answer means for the acknowledgement (sent / simulated / deferred / failed / skipped)
// The call event is stored as ONE Messages row (Direction In, Template "missed_call", WA_Message_ID "call-<id>"). Its state lives in
// the existing text columns AI_Action ("mcc:..." values) and AI_Reason, so no schema change is needed in the clinic's Grist doc.
// A missed call is NOT a WhatsApp message: Conversations.Last_Inbound_At is never touched (it opens the 24 h free-text window).

const CE_STATUS_MISSED = ['missed', 'unanswered', 'no-answer', 'no_answer', 'noanswer', 'not-answered', 'not_answered'];
const CE_STATUS_BUSY = ['busy'];
const CE_STATUS_IGNORED = ['answered', 'completed', 'connected', 'in-progress', 'in_progress', 'ongoing', 'ringing', 'initiated', 'queued'];
const CE_MAX_AGE_SEC = 48 * 3600;        // older events are rejected (a provider retry after two days is not a live missed call)
const CE_MAX_FUTURE_SEC = 10 * 60;       // clock drift allowed
const CE_INFLIGHT_SEC = 120;             // a claimed event without a conversation younger than this is still being processed
const CE_MAX_ACK_ATTEMPTS = 3;           // acknowledgement tries for one event (first send + retries after a failure / the night)
const CE_ACK_COOLDOWN_SEC = 3600;        // one acknowledgement per caller per hour: five missed calls in a row are not five messages
const CE_STATE = {
  claimed: 'mcc:claimed',                // row created, lead / conversation not linked yet
  pending: 'mcc:ack_pending',            // linked; acknowledgement not attempted yet
  simulated: 'mcc:ack_simulated',        // DEMO: the acknowledgement was simulated, nothing was sent
  sent: 'mcc:ack_sent',                  // W12 reports Meta accepted it (this is NOT "delivered")
  deferred: 'mcc:ack_deferred',          // blocked by quiet hours: a retry may still send it
  failed: 'mcc:ack_failed',              // W12 could not send it: a retry may succeed
  skipped: 'mcc:ack_skipped',            // opted out / no valid phone / person owns the chat: never sent
  off: 'mcc:ack_off',                    // missed-call capture is off for this clinic (no row is created in that case)
};
const CE_RETRYABLE = [CE_STATE.pending, CE_STATE.deferred, CE_STATE.failed];

const ceText = (v, max) => String(v === null || v === undefined ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// Constant-time string compare (no early exit on the first different character).
function ceSafeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

// The webhook secret must be set to a real value. A placeholder or a short value counts as "not configured" (fail closed).
function ceSecretUsable(secret) {
  const s = String(secret === null || secret === undefined ? '' : secret);
  return s.length >= 8 && !/^(REPLACE_|PASTE_)/i.test(s);
}

const ceLowerKeys = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).map(([k, v]) => [String(k).toLowerCase(), v]));

function ceCallId(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  const s = String(v).trim();
  return /^[A-Za-z0-9._:-]{1,100}$/.test(s) ? s : '';
}
const ceCallKey = (callId) => `call-${callId}`;

// The clinic's called number as a 10-digit key: a mobile through the repository's normalizer, otherwise a landline / toll-free
// number written with an STD or country prefix. Both sides of the registry match use this one function.
function ceCalledKey(raw, h) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return '';
  const n = h.normalizeIndianPhone(raw);
  if (n.valid) return n.phone.slice(3);
  let d = String(raw).replace(/\D/g, '');
  if (d.startsWith('0091')) d = d.slice(4);
  else if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[1-9]\d{9}$/.test(d) ? d : '';
}

// epoch seconds from seconds, milliseconds or an ISO string; null when unreadable
function ceParseTime(v) {
  let n = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string' && v.trim() !== '') n = /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : Date.parse(v) / 1000;
  if (n === null || !Number.isFinite(n) || n <= 0) return null;
  if (n > 1e11) n /= 1000;               // milliseconds
  return Math.floor(n);
}

function ceStatus(v) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (CE_STATUS_MISSED.includes(s)) return { action: 'process', kind: 'missed' };
  if (CE_STATUS_BUSY.includes(s)) return { action: 'process', kind: 'busy' };
  if (CE_STATUS_IGNORED.includes(s)) return { action: 'ignore', kind: s };
  return null;
}

// req: { headers, body }; opts: { secret }. Returns { action: 'reject' | 'ignore' | 'process', http_status, response, event? }.
// The request body may carry anything (a clinic, a tenant, a doc id): none of it is read.
function ceValidate(req, opts, nowMs, h) {
  const reject = (http_status, error, fields) => ({ action: 'reject', http_status, response: Object.assign({ ok: false, error }, fields ? { fields } : {}) });
  if (!ceSecretUsable(opts && opts.secret)) return reject(503, 'not_configured');
  const headers = ceLowerKeys(req && req.headers);
  if (!ceSafeEqual(String(headers['x-call-secret'] === undefined ? '' : headers['x-call-secret']), String(opts.secret))) return reject(401, 'unauthorized');

  const b = req && req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) return reject(400, 'invalid_event', ['body']);
  const nowSec = Math.floor(nowMs / 1000);
  const bad = [];
  const callId = ceCallId(b.provider_call_id);
  if (!callId) bad.push('provider_call_id');
  const called = ceCalledKey(b.called_number, h);
  if (!called) bad.push('called_number');
  const caller = typeof b.caller_number === 'string' || typeof b.caller_number === 'number' ? h.normalizeIndianPhone(b.caller_number) : { valid: false };
  if (!caller.valid) bad.push('caller_number');
  const at = ceParseTime(b.timestamp);
  if (at === null || at > nowSec + CE_MAX_FUTURE_SEC) bad.push('timestamp');
  else if (at < nowSec - CE_MAX_AGE_SEC) bad.push('timestamp_too_old');
  const st = ceStatus(b.status);
  if (!st) bad.push('status');
  let duration = null;
  if (b.duration_seconds !== undefined && b.duration_seconds !== null && b.duration_seconds !== '') {
    const d = typeof b.duration_seconds === 'number' || typeof b.duration_seconds === 'string' ? Number(b.duration_seconds) : NaN;
    if (!Number.isFinite(d) || d < 0 || d > 86400) bad.push('duration_seconds');
    else duration = Math.round(d);
  }
  if (bad.length) return reject(400, 'invalid_event', bad);
  if (st.action === 'ignore') return { action: 'ignore', http_status: 200, response: { ok: true, status: 'ignored', reason: 'call_not_missed' } };
  const event = {
    call_id: callId,
    call_key: ceCallKey(callId),
    called_key: called,
    caller_phone: caller.phone,
    at,
    kind: st.kind,                       // missed | busy (unanswered, no-answer ... all count as missed)
    duration_seconds: duration,
    provider: ceText(b.provider, 40) || 'unknown',
  };
  return { action: 'process', http_status: 200, response: { ok: true, status: 'accepted', call_key: event.call_key }, event };
}

// Which clinic owns this called number? ONLY the registry decides. records = Clinics rows.
function ceResolveClinic(records, calledKey, h) {
  const hits = (records || []).filter((r) => r && r.fields && String(r.fields.Active).toUpperCase() === 'TRUE'
    && String(r.fields.Grist_Doc_ID || '').trim() && calledKey && ceCalledKey(r.fields.Call_Number, h) === calledKey);
  const docs = new Set(hits.map((r) => String(r.fields.Grist_Doc_ID).trim()));
  if (!hits.length) return { found: false, reason: 'unknown_number' };
  if (docs.size > 1) return { found: false, reason: 'ambiguous_number' };       // two clinics claim one number: never guess
  const f = hits[0].fields;
  return { found: true, clinic: { slug: ceText(f.Clinic_Slug, 40), name: ceText(f.Clinic_Name, 100), doc_id: String(f.Grist_Doc_ID).trim(), wa_phone_number_id: String(f.WA_Phone_Number_ID || '').trim() } };
}

// The clinic's Settings rows -> the few switches this section reads. Missing = off (demo_mode / missed_call_enabled).
function ceSettings(records, registryName) {
  const s = {};
  for (const r of records || []) { const f = (r && r.fields) || {}; if (f.Key) s[String(f.Key).trim()] = f.Value; }
  const on = (v) => ['on', 'true', 'yes', '1'].includes(String(v === null || v === undefined ? '' : v).trim().toLowerCase());
  return {
    enabled: on(s.missed_call_enabled),
    demo: on(s.demo_mode),
    clinic_name: ceText(s.clinic_name || registryName, 100) || 'the clinic',
    owner_phone: s.owner_phone,
    test_mode: s.TEST_MODE,
    test_phone: s.TEST_PHONE,
  };
}

const ceIst = (sec) => new Date(sec * 1000 + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);

// The Messages row that records the call (and is the idempotency key). Created_At = when WE recorded it.
function ceClaimRow(event, nowSec, demo) {
  return {
    Direction: 'In',
    Body: `${demo ? '[DEMO] ' : ''}Missed call (${event.kind}) at ${ceIst(event.at)} IST${event.duration_seconds ? `, rang ${event.duration_seconds}s` : ''}`,
    Template: 'missed_call',
    Intent: 'missed_call',
    Sent_By: 'MCC-missed-call',
    WA_Message_ID: event.call_key,
    Status: 'Received',
    Send: false,
    Created_At: nowSec,
    AI_Action: CE_STATE.claimed,
    AI_Reason: '',
    Needs_Human: false,
  };
}

const ceAttempts = (row) => { const m = String(((row || {}).fields || {}).AI_Reason || '').match(/attempt (\d+)/); return m ? Number(m[1]) : 0; };
const ceStateOf = (row) => String(((row || {}).fields || {}).AI_Action || '');

// rows = Messages rows whose WA_Message_ID is this event's key. What does a (repeated) delivery of the event mean?
//   new        nothing recorded yet                      -> claim it
//   inflight   claimed < CE_INFLIGHT_SEC ago, not linked  -> another delivery is working on it: do nothing
//   resume     claimed earlier, never linked (a crash)    -> finish it (no new claim)
//   retry_ack  linked, acknowledgement failed / deferred / never attempted, tries left -> try the acknowledgement again only
//   duplicate  anything else (acknowledged, simulated, skipped, tries used up) -> nothing
function ceClassifyExisting(rows, nowSec) {
  const own = (rows || []).filter((r) => r && r.fields).sort((a, b) => a.id - b.id);
  if (!own.length) return { kind: 'new' };
  const row = own[0];
  const linked = Number(row.fields.Conversation) > 0;
  if (!linked) return nowSec - (Number(row.fields.Created_At) || 0) < CE_INFLIGHT_SEC ? { kind: 'inflight', row } : { kind: 'resume', row };
  if (CE_RETRYABLE.includes(ceStateOf(row)) && ceAttempts(row) < CE_MAX_ACK_ATTEMPTS) return { kind: 'retry_ack', row };
  return { kind: 'duplicate', row };
}

// After creating our claim row: the lowest row id for the key is the real one. Everyone else stands down.
function ceCanonical(rows, myId) {
  const ids = (rows || []).filter((r) => r && r.fields).map((r) => r.id).sort((a, b) => a - b);
  const canonical_id = ids.length ? ids[0] : myId;
  return { canonical_id, mine: canonical_id === myId, others: ids.filter((i) => i !== canonical_id) };
}
const ceDupKey = (key, rowId) => `${key}-dup-${rowId}`;

// W12's answer -> the acknowledgement state. `w12` = the item "W12 – Return result" gives back.
function ceAckOutcome(w12, attempt) {
  const r = w12 || {};
  const err = ceText(r.send_error, 200);
  const tag = `attempt ${attempt}`;
  if (r.simulated === true || r.send_status === 'simulated') return { state: CE_STATE.simulated, outcome: 'ok', detail: `${tag}: DEMO simulated, nothing was sent` };
  if (r.sent === true) return { state: CE_STATE.sent, outcome: 'ok', detail: `${tag}: accepted by WhatsApp (not yet delivered)` };
  if (/quiet hours/i.test(err)) return { state: CE_STATE.deferred, outcome: 'skipped', detail: `${tag}: quiet hours, will retry` };
  return { state: CE_STATE.failed, outcome: 'failed', detail: `${tag}: not sent: ${err || r.send_status || 'no answer from W12'}` };
}

// The send decision for the acknowledgement (patient) and the staff alert (owner), both through send-guard.js's decideSend.
// A missed call is a reply to the patient's own contact: kind "transactional" for the opt-out / quiet-hours / TEST_MODE rules, but a
// person who owns the chat (paused automation) is respected too, because the clinic is already dealing with this patient.
function ceAckDecision(ctx, nowMs, h) {
  const patient_phone = h.normalizeIndianPhone(ctx.lead_phone).phone;
  const test_phone = h.normalizeIndianPhone(ctx.test_phone).phone;
  if (!patient_phone) return { send: false, to: null, reason: 'no valid patient phone', test_mode: true, state: CE_STATE.skipped };
  if (ctx.automation_paused || ctx.assigned_to) return { send: false, to: null, reason: 'a person owns this conversation', test_mode: true, state: CE_STATE.skipped };
  if (ctx.recent_ack_at && Math.floor(nowMs / 1000) - ctx.recent_ack_at < CE_ACK_COOLDOWN_SEC) return { send: false, to: null, reason: 'this caller was acknowledged less than an hour ago', test_mode: true, state: CE_STATE.skipped };
  const d = h.decideSend({ kind: 'transactional', flag_value: null, opted_out: ctx.opted_out === true, automation_paused: false, patient_phone, test_mode: ctx.test_mode, test_phone, now_ms: nowMs });
  const state = d.send ? CE_STATE.pending : d.reason === 'quiet hours' ? CE_STATE.deferred : CE_STATE.skipped;
  return Object.assign({}, d, { state });
}
function ceAlertDecision(ctx, nowMs, h) {
  const owner = h.normalizeIndianPhone(ctx.owner_phone).phone;
  const test_phone = h.normalizeIndianPhone(ctx.test_phone).phone;
  return h.decideSend({ kind: 'transactional', flag_value: null, opted_out: false, automation_paused: false, patient_phone: owner, test_mode: ctx.test_mode, test_phone, now_ms: nowMs });
}

// The newest acknowledgement already written to this conversation (Messages: Direction Out, Template missed_call_ack) that did not
// fail, as epoch seconds; 0 = none. A failed attempt does not count: it must stay retryable.
function ceRecentAck(records) {
  let newest = 0;
  for (const r of records || []) {
    const f = (r && r.fields) || {};
    if (f.Direction === 'Out' && f.Template === 'missed_call_ack' && f.Status !== 'failed') newest = Math.max(newest, Number(f.Created_At) || 0);
  }
  return newest;
}

const ceAckText = (clinicName) => `Namaste! Sorry, we missed your call to ${clinicName}. How can we help you today?`;

// The item W12 expects (see W13's aiSendItems for the real-send twin). No key starts with "w12_" (W12 strips those).
function ceAckItem(ctx, decision) {
  return {
    source_workflow: 'W12-missed-call-ack',   // "W12-" so every existing check treats it as an automation, not a person (Sent_By convention)
    wa_phone_number_id: ctx.wa_phone_number_id,
    grist_base_url: ctx.grist_base_url,
    doc_id: ctx.doc_id,
    audience: 'patient',
    decision,
    message_type: 'template',
    template: 'missed_call_ack',
    template_params: { clinic_name: ctx.clinic_name },
    message_text: ceAckText(ctx.clinic_name),
    lead_row_id: ctx.lead_row_id,
    lead_phone: ctx.lead_phone,
  };
}
function ceAlertItem(ctx, decision) {
  return {
    source_workflow: 'W12-missed-call-alert',
    wa_phone_number_id: ctx.wa_phone_number_id,
    grist_base_url: ctx.grist_base_url,
    doc_id: ctx.doc_id,
    audience: 'staff',
    decision,
    message_type: 'template',
    template: 'new_lead_staff_alert',
    template_params: { clinic_name: ctx.clinic_name, lead_name: ctx.lead_name || 'Caller', lead_phone: ctx.lead_phone, enquiry: `Missed call (${ctx.kind})` },
    message_text: `Missed call (${ctx.kind}) from ${ctx.lead_name || 'a caller'}, ${ctx.lead_phone}`,
    lead_row_id: ctx.lead_row_id,
    lead_phone: ctx.lead_phone,
  };
}

// One Run_Log row. No phone number, no message text.
function ceLogRow(record, outcome, error, nowSec, demo) {
  return { Workflow: 'MCC-missed-call-capture', Record: `${demo ? '[DEMO] ' : ''}${ceText(record, 400)}`, Outcome: outcome, Error: ceText(error, 400), At: nowSec };
}
const ceMaskPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 4 ? `…${d.slice(-4)}` : '…'; };

if (typeof module !== 'undefined') {
  module.exports = {
    CE_STATUS_MISSED, CE_STATUS_BUSY, CE_STATUS_IGNORED, CE_MAX_AGE_SEC, CE_MAX_FUTURE_SEC, CE_INFLIGHT_SEC, CE_MAX_ACK_ATTEMPTS, CE_ACK_COOLDOWN_SEC, CE_STATE, CE_RETRYABLE,
    ceText, ceSafeEqual, ceSecretUsable, ceCallId, ceCallKey, ceCalledKey, ceParseTime, ceStatus, ceValidate, ceResolveClinic, ceSettings, ceIst, ceClaimRow,
    ceAttempts, ceStateOf, ceClassifyExisting, ceCanonical, ceDupKey, ceAckOutcome, ceAckDecision, ceAlertDecision, ceRecentAck, ceAckText, ceAckItem, ceAlertItem, ceLogRow, ceMaskPhone,
  };
}
