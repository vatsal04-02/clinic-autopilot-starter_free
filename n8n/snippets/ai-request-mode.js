// REQUEST MODE for W13 (DEMO / safe appointments): with Settings > booking_mode = request, the AI never books. When a patient clearly asks for one
// exact free day and time, W13 writes a REQUEST (Appointments.Status = "Requested") and tells the patient it is NOT confirmed; staff confirm or
// decline it in Grist (the REQ section then tells the patient). Every other clinic (booking_mode link / direct / empty) is unchanged: nothing in
// this file runs for them.
// Pure functions, no network, no clock but the arguments. Pasted into "W13 – Build Context" and "W13 – Plan" AFTER the ai-receptionist.js block
// (they use aiFreeSlots, aiIst, aiDayLabel, ai12h, aiToHandoff, aiLine, aiTimesIn). Paste from AI_REQ_STATUS down to (not including) the module.exports line.
//
// How it reuses the existing machinery instead of copying it:
//   * the plan is made by aiPlan / aiRoute exactly as for booking_mode = direct (same checks: the slot must be free, the day and time in the reply
//     must match, ...); aiReqFinalize then turns the resulting "Booked" write into a "Requested" write and replaces the reply by a fixed text;
//   * a Requested row HOLDS its slot for request_hold_hours (default 24) so a second patient is not offered the same time, but is invisible to
//     everything that reads Booked / Completed / ... (W5 reminders, W6, W7, W8, W9, aiLeadAppointments): it can trigger nothing and is never counted
//     as confirmed;
//   * a patient's own pending request does not hold the slot against that same patient, so asking twice does not create two rows.

const { aiFreeSlots, aiIst, aiDayLabel, ai12h, aiToHandoff, aiLine, aiTimesIn } = typeof module !== 'undefined' ? require('./ai-receptionist') : {};   // Node tests only: in the n8n node the ai-receptionist.js block provides these

const AI_REQ_STATUS = 'Requested';
const AI_REQ_CLAIMS_RE = /\b(booked|confirmed|fixed|reserved|(?:book|fix|confirm|reserve) (?:kar|ho) (?:di|diya|gayi|gaya|gai|chuki|chuka|chuke))\b|(?:बुक|कन्फर्म|पक्की|पक्का|फिक्स) (?:कर|हो) (?:दी|दिया|गई|गया|चुकी|चुका|चुके)/i;

// "booked / confirmed" said as a fact. A negated or future use ("not confirmed yet", "will be confirmed", "once it is confirmed") is not a claim.
const AI_REQ_NEGATED = /\b(?:not|isn'?t|is not|aren'?t|never|yet to be|waiting (?:to be|for us to)|pending|until|once (?:it is|it's)|will be|to be|when (?:it is|it's)|if|unless)\s+(?:yet\s+)?(?:be\s+)?(?:booked|confirmed|fixed|reserved)\b/gi;
const aiReqClaims = (text) => AI_REQ_CLAIMS_RE.test(String(text || '').replace(AI_REQ_NEGATED, ' '));

// s: Settings as { key: value }. Returns { on, hold_sec, max_pending }.
function aiReqSettings(s) {
  const num = (v, d, lo, hi) => { const n = Number(v); return v !== undefined && v !== null && String(v).trim() !== '' && Number.isFinite(n) && n >= lo && n <= hi ? Math.round(n) : d; };
  const o = s || {};
  return {
    on: String(o.booking_mode === undefined || o.booking_mode === null ? '' : o.booking_mode).trim().toLowerCase() === 'request',
    hold_sec: num(o.request_hold_hours, 24, 1, 168) * 3600,
    max_pending: num(o.max_pending_requests, 2, 1, 5),
  };
}

// A Requested row holds its slot while it is young. A row without Requested_At (made by hand) holds until its Start passes.
const aiReqHolds = (f, rm, nowSec) => f.Status === AI_REQ_STATUS && typeof f.Start === 'number' && f.Start > nowSec && (typeof f.Requested_At !== 'number' || f.Requested_At >= nowSec - rm.hold_sec);

// This patient's pending requests (future, newest data first by start), shaped like aiLeadAppointments entries.
function aiReqPending(records, leadRowId, nowMs, refStart) {
  if (!leadRowId) return [];
  return (records || [])
    .filter((r) => r && r.fields && r.fields.Status === AI_REQ_STATUS && Number(r.fields.Lead) === Number(leadRowId) && typeof r.fields.Start === 'number' && r.fields.Start * 1000 >= nowMs)
    .sort((a, b) => a.fields.Start - b.fields.Start)
    .slice(0, 5)
    .map((r, i) => {
      const f = r.fields;
      const t = aiIst(f.Start * 1000);
      return {
        ref: `A${refStart + i}`, row_id: r.id, uid: aiLine(f.Booking_UID || `row-${r.id}`, 120), origin: 'request', state: 'requested',
        start: f.Start, end: typeof f.End === 'number' ? f.End : f.Start + 1800, date: t.date, minutes: t.minutes,
        label: `${aiDayLabel(t.date)} ${ai12h(t.minutes)}`, service: aiLine(f.Service, 80), physio: aiLine(f.Physio, 80),
        requested_at: typeof f.Requested_At === 'number' ? f.Requested_At : null,
      };
    });
}

// x: the context from aiContext (Build Context runs this when rm.on). Recomputes the free slots with the other patients' requests held, lists
// this patient's pending requests, and makes the prompt and the plan use the "system books" path (aiFinalize turns it into a request).
function aiReqPrepare(x, records, rm, nowMs, h) {
  if (!rm.on) return x;
  const nowSec = Math.floor(nowMs / 1000);
  x.request_mode = true;
  x.profile.booking_mode = 'direct';
  const own = Number(x.lead.row_id) || 0;
  if (!x.appointments_unknown && Array.isArray(records)) {
    const mapped = records.map((r) => (r && r.fields && aiReqHolds(r.fields, rm, nowSec) && Number(r.fields.Lead) !== own ? { ...r, fields: { ...r.fields, Status: 'Booked' } } : r));
    x.slots = aiFreeSlots(x.profile, mapped, nowMs, x.calendar.length, h);
  }
  x.req = { hold_hours: rm.hold_sec / 3600, max_pending: rm.max_pending, pending: x.appointments_unknown ? [] : aiReqPending(records, own, nowMs, x.appointments.length + 1) };
  return x;
}

// The prompt addendum: one more system block (after the rules, the clinic facts and this message's facts).
function aiReqAddendum(request, x) {
  if (!request || !x.request_mode) return request;
  const lines = [
    'REQUEST MODE (this clinic): appointments asked for on WhatsApp are REQUESTS that the clinic staff must confirm. This overrides every "the system books directly" / "reply confirms" line above.',
    '- When the patient clearly asks for one exact free day and time (action "book_slot"), the system records a REQUEST, not a booking. Never say the appointment is booked, confirmed, fixed or reserved: say it is a request and that the team will confirm. The system writes the reply for a request itself; what you write for it is not used.',
    '- Changing the time of an appointment or of a request needs a person: action "handoff". Cancelling a request is fine: action "cancel_appointment" with its ref.',
    '- Times that are held by another patient\'s request are not in AVAILABILITY. Never offer a time that is not listed there.',
    '',
    'PENDING REQUESTS (this patient; waiting for staff; NOT booked)',
  ];
  if (!x.req.pending.length) lines.push('- none');
  for (const p of x.req.pending) lines.push(`- [${p.ref}] ${p.label}${p.service ? `, ${p.service}` : ''} (a request: the team has not confirmed it yet)`);
  return { ...request, system: [...request.system, { type: 'text', text: lines.join('\n') }] };
}

// After the prompt is built: let aiRoute see the pending requests as this patient's appointments (cancel a request, answer "what is my status?"
// with a time the fact check knows). They carry origin "request", so they are never treated as Cal.com bookings.
function aiReqExpose(x) {
  if (x.request_mode && x.req && Array.isArray(x.req.pending)) x.appointments = [...x.appointments, ...x.req.pending];
  return x;
}

const aiReqLabel = (startSec) => { const t = aiIst(startSec * 1000); return `${aiDayLabel(t.date)} at ${ai12h(t.minutes)}`; };

// plan: from aiPlan (made with booking_mode "direct"); d: the checked decision (or null); records: the Appointments rows read for this run.
// Returns the plan: a Requested write instead of a Booked one, or a hand-off, with the patient's reply fixed in code.
function aiReqFinalize(plan, d, x, records, nowSec, cfg) {
  if (!x.request_mode || !plan) return plan;
  const handoff = (why) => aiToHandoff(plan, x, cfg, why);
  const rows = Array.isArray(records) ? records : [];
  const real = x.appointments.filter((a) => a.origin !== 'request');
  const pending = (x.req && x.req.pending) || [];

  // 1. the AI must never create a confirmed appointment in request mode: a reschedule would (it writes a new Booked row)
  if (plan.route === 'rescheduled') return handoff('request mode: changing a time needs a person');
  // 2. a new booking becomes a REQUEST
  if (plan.route === 'book_slot' && plan.booked) {
    const b = plan.booked;
    const uid = `req-${String(b.Booking_UID || '').replace(/^wa-/, '')}`.slice(0, 120);
    const dup = pending.find((p) => p.start === b.Start);
    const sameMessage = rows.find((r) => r && r.fields && r.fields.Booking_UID === uid);
    plan.action_writes = [];
    plan.lead_patch = { ...plan.lead_patch };
    delete plan.lead_patch.Status;   // the direct path marks the lead Booked: a request does not
    plan.booked = null;
    if (dup || sameMessage) {
      plan.reply = `We already have your request for ${aiReqLabel(b.Start)}. It is not confirmed yet: our team will check and confirm with you shortly.`;
      plan.notes.push(dup ? 'the patient already has a pending request for this time: no second row' : 'this message already created its request: no second row');
      return plan;
    }
    if (pending.length >= ((x.req && x.req.max_pending) || 2)) return handoff(`the patient already has ${pending.length} requests waiting for confirmation`);
    const row = { Booking_UID: uid, Lead: b.Lead, Service: b.Service, Start: b.Start, End: b.End, Status: AI_REQ_STATUS, Requested_At: nowSec };
    plan.action_writes.push({ method: 'POST', table: 'Appointments', body: { records: [{ fields: row }] } });
    plan.requested = row;
    plan.reply = `Thank you! We have noted your request for ${aiReqLabel(b.Start)}. It is NOT confirmed yet: our team will check and confirm with you shortly.`;
    plan.notes.push('appointment REQUEST created (Status Requested): staff must confirm');
    return plan;
  }
  // 3. cancelling a request is fine; say "request"
  if (plan.route === 'cancelled' && plan.cancelled && plan.cancelled.origin === 'request') {
    plan.reply = `Your request for ${plan.cancelled.label} is cancelled.`;
    return plan;
  }
  // 4. a reply that says something is booked / confirmed must be about a REAL appointment. About a pending request: replaced by the truth.
  //    About nothing that exists: a person answers (in request mode the system itself never books).
  if (plan.reply && aiReqClaims(plan.reply) && plan.route !== 'handoff') {
    const times = aiTimesIn(plan.reply);
    const realAt = (m) => real.some((a) => a.minutes === m);
    const pendAt = (m) => pending.filter((p) => p.minutes === m);
    if (times.length) {
      const unreal = times.filter((readings) => !readings.some(realAt));
      if (unreal.length) {
        const hit = [...new Set(unreal.flatMap((readings) => readings.flatMap((m) => pendAt(m))))];
        if (!hit.length || unreal.some((readings) => !readings.some((m) => pendAt(m).length))) return handoff('the AI reply says an appointment is booked or confirmed, but there is no such appointment');
        plan.reply = `Your request for ${hit.map((p) => p.label).join(' and ')} is waiting for our team to confirm. It is not confirmed yet.`;
        plan.notes.push('the AI reply called a pending request confirmed; replaced by the truth');
      }
    } else if (!real.length) return handoff('the AI reply says an appointment is booked or confirmed, but the patient has none');
  }
  return plan;
}

if (typeof module !== 'undefined') module.exports = { AI_REQ_STATUS, AI_REQ_CLAIMS_RE, aiReqClaims, aiReqSettings, aiReqHolds, aiReqPending, aiReqPrepare, aiReqAddendum, aiReqExpose, aiReqLabel, aiReqFinalize };
