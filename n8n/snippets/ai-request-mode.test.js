// Run: node n8n/snippets/ai-request-mode.test.js
// REQUEST MODE: the AI creates appointment REQUESTS (Status "Requested"), never confirmed bookings. Pure-function tests on the real aiContext /
// aiBuildRequest / aiPlan; the workflow wiring is tested end to end in n8n/integrated/request-mode.test.js.
const assert = require('assert');
const ai = require('./ai-receptionist');
const rq = require('./ai-request-mode');
const { normalizeIndianPhone } = require('./normalize-phone');
const { decideSend, inQuietHours } = require('./send-guard');
const { parseClock, parseDays } = require('./clinic-hours');
const F = require('../tests/ai-fixtures');

const h = { normalizeIndianPhone, decideSend, inQuietHours, parseClock, parseDays };
const ok = (m) => console.log(`  ok  ${m}`);
const clone = (o) => JSON.parse(JSON.stringify(o));
const rec = (r) => ({ records: clone(r) });
const CFG = { model: undefined, leads_table: 'LEADS', min_confidence: 0.65, confidence_auto: 0.8, confidence_write: 0.85, max_ai_replies_per_hour: 6, history_limit: 12, slot_days: 7, pause_on_handoff: false, staff_alert_template: 'human_handoff_alert' };
const NOW_SEC = F.sec(F.NOW);
const SAT_5PM = F.at('2026-10-10', '17:00');
const WED_530 = F.at('2026-10-07', '17:30');   // tomorrow 17:30 is free in the fixtures (17:00 is taken by another patient)

// A request row of lead `lead`
const reqRow = (id, lead, start, over = {}) => ({ id, fields: { Booking_UID: `req-wamid.OLD.${id}`, Lead: lead, Service: 'Knee pain physiotherapy', Start: start, End: start + 1800, Status: 'Requested', Requested_At: NOW_SEC - 3600, ...over } });
function build(text, { mode = 'request', appts = F.appointmentRows(), settingsOver = {}, wa = 'wamid.NEW.4' } = {}) {
  const msg = { id: 4, fields: { Conversation: 1, Direction: 'In', Body: text, Sent_By: 'Patient', WA_Message_ID: wa, Status: 'Received', Created_At: NOW_SEC - 10 } };
  const raw = { start: { message_row_id: 4, wa_message_id: wa, msg_type: 'text' }, clinic: { clinic_name: 'Demo Physio', doc_id: 'DOCA', grist_base_url: 'http://grist:8484', wa_phone_number_id: '123' }, settings: rec(F.settingsRows({ booking_mode: mode, ...settingsOver })), knowledge: rec(F.KNOWLEDGE), message: rec([msg]), conversation: rec(F.conversationRows()), lead: rec([F.leadRows()[0]]), history: rec([...F.messageRows(), msg]), appointments: rec(appts) };
  const { x, gate } = ai.aiContext(raw, CFG, F.NOW, h);
  const settings = ai.aiSettings(raw.settings.records);
  const rm = rq.aiReqSettings(settings);
  rq.aiReqPrepare(x, raw.appointments.records, rm, F.NOW, h);
  const request = rq.aiReqAddendum(ai.aiBuildRequest(x, CFG), x);
  rq.aiReqExpose(x);
  return { x, gate, request, rm, records: raw.appointments.records };
}
const fake = (request) => F.fakeDecide(request);
function run(text, o = {}) {
  const b = build(text, o);
  assert.strictEqual(b.gate.route, 'ai', b.gate.reason);
  const d0 = fake(b.request);
  const d = o.edit ? o.edit(d0, b) : d0;
  assert.deepStrictEqual(ai.aiValidateDecision(d), [], 'decision');
  let plan = ai.aiPlan(d, b.x, CFG);
  plan = rq.aiReqFinalize(plan, d, b.x, b.records, NOW_SEC, CFG);
  return { ...b, d, plan };
}
// a clean, confident decision with the given fields (the fake model's default for unknown questions is a hand-off)
const dec = (over) => () => ({ ...F.BASE_DECISION, lead_summary: 'test', ...over });
const statuses = (plan) => plan.action_writes.flatMap((w) => (w.body.records || []).map((r) => (r.fields || {}).Status));

// ---------------------------------------------------------------- settings
{
  assert.deepStrictEqual(rq.aiReqSettings({}), { on: false, hold_sec: 86400, max_pending: 2 });
  assert.deepStrictEqual(rq.aiReqSettings({ booking_mode: ' Request ', request_hold_hours: '6', max_pending_requests: '3' }), { on: true, hold_sec: 21600, max_pending: 3 });
  assert.strictEqual(rq.aiReqSettings({ booking_mode: 'direct' }).on, false);
  assert.strictEqual(rq.aiReqSettings({ booking_mode: 'requests' }).on, false);
  assert.deepStrictEqual(rq.aiReqSettings({ booking_mode: 'request', request_hold_hours: '0', max_pending_requests: '99' }), { on: true, hold_sec: 86400, max_pending: 2 });
  assert.deepStrictEqual(rq.aiReqSettings(null), { on: false, hold_sec: 86400, max_pending: 2 });
  ok('settings: request mode only for the exact word "request"; hold (default 24 h, 1-168) and pending limit (default 2, 1-5) fall back when out of range');
}

// ---------------------------------------------------------------- other modes are untouched
{
  for (const mode of ['link', 'direct', '']) {
    const b = build('Book me for Saturday at 5.', { mode });
    assert.strictEqual(b.x.request_mode, undefined);
    assert.strictEqual(b.request.system.length, 3, 'no addendum');
    assert.strictEqual(b.x.profile.booking_mode, mode === 'direct' ? 'direct' : 'link');
    const d = fake(b.request);
    const plan = ai.aiPlan(d, b.x, CFG);
    const after = clone(plan);
    assert.deepStrictEqual(rq.aiReqFinalize(plan, d, b.x, b.records, NOW_SEC, CFG), after, `${mode}: finalize is a no-op`);
  }
  const link = run('Book me for Saturday at 5.', { mode: 'link' });
  assert.strictEqual(link.plan.route, 'book_slot');
  assert(link.plan.reply.includes('{{BOOKING_LINK}}'));
  const direct = run('Book me for Saturday at 5.', { mode: 'direct' });
  assert.deepStrictEqual(statuses(direct.plan), ['Booked']);
  ok('booking_mode link / direct / empty: no addendum, no change to the plan (link still sends the Cal.com link, direct still books)');
}

// ---------------------------------------------------------------- a request, not a booking
{
  const r = run('Book me for Saturday at 5.');
  assert.strictEqual(r.plan.route, 'book_slot');
  assert.deepStrictEqual(statuses(r.plan), ['Requested']);
  assert.strictEqual(r.plan.action_writes.length, 1);
  assert.deepStrictEqual(r.plan.action_writes[0], { method: 'POST', table: 'Appointments', body: { records: [{ fields: { Booking_UID: 'req-wamid.NEW.4', Lead: 1, Service: 'Appointment', Start: SAT_5PM, End: SAT_5PM + 1800, Status: 'Requested', Requested_At: NOW_SEC } }] } });
  assert.strictEqual(r.plan.booked, null, 'plan.booked (what a confirmed booking writes) is empty');
  assert.deepStrictEqual(r.plan.requested, r.plan.action_writes[0].body.records[0].fields);
  assert.strictEqual(r.plan.lead_patch.Status, undefined, 'the lead is NOT marked Booked');
  assert.strictEqual(r.plan.reply, 'Thank you! We have noted your request for Sat 10 Oct at 5:00 PM. It is NOT confirmed yet: our team will check and confirm with you shortly.');
  assert(!rq.aiReqClaims(r.plan.reply), 'the fixed reply does not claim a booking');
  assert.deepStrictEqual(ai.aiCheckReply(r.plan.reply, ai.aiAllowedFacts(r.x), {}), [], 'and passes the fact check');
  assert(r.plan.notes.some((n) => /REQUEST created/.test(n)));
  assert(!JSON.stringify(r.plan).includes('"Booked"'), 'no Booked write anywhere in the plan');
  // the model is told
  const add = r.request.system[3].text;
  assert(/^REQUEST MODE/.test(add) && add.includes('PENDING REQUESTS') && add.includes('- none') && /Never say the appointment is booked, confirmed/.test(add));
  ok('"Book me for Saturday at 5": ONE write, Status Requested, UID req-<wamid>, Requested_At set; lead not marked Booked; the reply is fixed in code ("NOT confirmed yet"), passes the fact check; the model is told it is a request');
}

// ---------------------------------------------------------------- the model lies: it still cannot book
{
  const lies = run('Book me for Saturday at 5.', { edit: (d) => ({ ...d, reply: 'Great, you are booked for Saturday at 5 PM! Confirmed.' }) });
  assert.deepStrictEqual(statuses(lies.plan), ['Requested']);
  assert(!/booked|Confirmed/i.test(lies.plan.reply.replace(/NOT confirmed/, '')), lies.plan.reply);
  const sat6 = run('Book me for Saturday at 5.', { edit: (d) => ({ ...d, booking: { ...d.booking, time: '17:00' }, reply: 'Done!' }) });
  assert.deepStrictEqual(statuses(sat6.plan), ['Requested']);
  ok('a reply that says "booked / confirmed" for a request is replaced: the write is still a Requested row');
}

// ---------------------------------------------------------------- holds, races, duplicates
{
  // another patient's request holds Wed 17:30 (the only free evening slot offered before)
  const other = reqRow(10, 2, WED_530);
  let b = build('Can I come tomorrow evening?', { appts: [...F.appointmentRows(), other] });
  const wed = b.x.slots.days.find((d) => d.date === '2026-10-07');
  assert(wed && !wed.times.includes(17 * 60 + 30), '17:30 is held by the other patient\'s request');
  const wedLine = (rq0) => rq0.system[2].text.split('\n').find((l) => l.startsWith('- 2026-10-07 ('));
  assert(wedLine(b.request) && !wedLine(b.request).includes('17:30'), 'and not offered to the model');
  // without it the same slot is offered
  b = build('Can I come tomorrow evening?');
  assert(b.x.slots.days.find((d) => d.date === '2026-10-07').times.includes(17 * 60 + 30));
  assert(wedLine(b.request).includes('17:30'), 'control: without the request the model is offered 17:30');
  // asking for the held slot: not free -> real alternatives, no write
  let r = run('Book me for Wednesday at 5.', { appts: [...F.appointmentRows(), other], edit: dec({ action: 'book_slot', intent: 'book_appointment', booking: { date: '2026-10-07', time: '17:30', time_window: null }, reply: 'Wednesday at 5:30 PM is free.' }) });
  assert.strictEqual(r.plan.route, 'offer_slots');
  assert.deepStrictEqual(r.plan.action_writes, []);
  assert(/not available/.test(r.plan.reply) && !r.plan.reply.includes('5:30 PM'), r.plan.reply);
  // hold expiry: a request older than request_hold_hours (24 h) no longer holds
  const old = reqRow(10, 2, WED_530, { Requested_At: NOW_SEC - 25 * 3600 });
  b = build('Can I come tomorrow evening?', { appts: [...F.appointmentRows(), old] });
  assert(b.x.slots.days.find((d) => d.date === '2026-10-07').times.includes(17 * 60 + 30), 'a 25 h old request no longer holds');
  b = build('Can I come tomorrow evening?', { appts: [...F.appointmentRows(), old], settingsOver: { request_hold_hours: '48' } });
  assert(!b.x.slots.days.find((d) => d.date === '2026-10-07').times.includes(17 * 60 + 30), 'request_hold_hours = 48 keeps it held');
  // a request typed in by hand (no Requested_At) holds until its start
  const manual = reqRow(10, 2, WED_530); delete manual.fields.Requested_At;
  b = build('Can I come tomorrow evening?', { appts: [...F.appointmentRows(), manual] });
  assert(!b.x.slots.days.find((d) => d.date === '2026-10-07').times.includes(17 * 60 + 30));
  // a declined / cancelled request holds nothing
  for (const status of ['Declined', 'Cancelled']) {
    b = build('Can I come tomorrow evening?', { appts: [...F.appointmentRows(), reqRow(10, 2, WED_530, { Status: status })] });
    assert(b.x.slots.days.find((d) => d.date === '2026-10-07').times.includes(17 * 60 + 30), status);
  }
  // capacity 2: one request does not fill the slot
  b = build('Can I come tomorrow evening?', { appts: [...F.appointmentRows(), other], settingsOver: { booking_capacity: '2' } });
  assert(b.x.slots.days.find((d) => d.date === '2026-10-07').times.includes(17 * 60 + 30));
  ok('holds: another patient\'s request removes its slot from AVAILABILITY and from a booking; it expires after request_hold_hours; declined / cancelled rows hold nothing; capacity 2 still has room; a hand-made request holds');
}
{
  // my own pending request: not held against me; shown in PENDING REQUESTS; asking again creates NO second row
  const mine = reqRow(10, 1, SAT_5PM);
  let b = build('What about Saturday?', { appts: [...F.appointmentRows(), mine] });
  assert.deepStrictEqual(b.x.req.pending.map((p) => [p.ref, p.origin, p.state, p.label]), [['A2', 'request', 'requested', 'Sat 10 Oct 5:00 PM']]);
  assert(b.request.system[3].text.includes('- [A2] Sat 10 Oct 5:00 PM, Knee pain physiotherapy (a request: the team has not confirmed it yet)'));
  assert(!b.request.system[2].text.includes('[A2]'), 'a request is not listed under APPOINTMENTS');
  assert.deepStrictEqual(b.x.appointments.map((a) => a.ref), ['A1', 'A2'], 'aiRoute can point at it (cancel)');
  assert(b.x.slots.days.find((d) => d.date === '2026-10-10').times.includes(17 * 60), 'my own request does not hold the slot against me');
  let r = run('Book me for Saturday at 5.', { appts: [...F.appointmentRows(), mine] });
  assert.deepStrictEqual(r.plan.action_writes, [], 'no second row for the same time');
  assert(/^We already have your request for Sat 10 Oct at 5:00 PM\. It is not confirmed yet/.test(r.plan.reply), r.plan.reply);
  assert.strictEqual(r.plan.requested, undefined);
  // the same WhatsApp message processed twice (a retry after a partial failure)
  const sameMsg = reqRow(11, 1, SAT_5PM + 3600, { Booking_UID: 'req-wamid.NEW.4' });
  r = run('Book me for Saturday at 5.', { appts: [...F.appointmentRows(), sameMsg] });
  assert.deepStrictEqual(r.plan.action_writes, []);
  assert(/already have your request/.test(r.plan.reply));
  // limit of pending requests per patient (default 2): the third goes to a person
  const two = [reqRow(10, 1, F.at('2026-10-08', '11:00')), reqRow(11, 1, F.at('2026-10-09', '11:00'))];
  r = run('Book me for Saturday at 5.', { appts: [...F.appointmentRows(), ...two] });
  assert.strictEqual(r.plan.route, 'handoff');
  assert(/already has 2 requests waiting/.test(r.plan.reason));
  assert.deepStrictEqual(r.plan.action_writes, []);
  r = run('Book me for Saturday at 5.', { appts: [...F.appointmentRows(), ...two], settingsOver: { max_pending_requests: '3' } });
  assert.deepStrictEqual(statuses(r.plan), ['Requested']);
  ok('duplicates: the same time twice = no second row; the same message twice = no second row; more than max_pending_requests (2) = a person; my own request is visible to me and listed as "not confirmed yet"');
}

// ---------------------------------------------------------------- what the AI can do with appointments in request mode
{
  // reschedule: always a person (it would write a confirmed row)
  let r = run('Please move my appointment to Saturday at 5.', { edit: dec({ intent: 'reschedule_appointment', action: 'reschedule_appointment', appointment_ref: 'A1', booking: { date: '2026-10-10', time: '17:00', time_window: null }, reply: 'Moved!' }) });
  // A1 is a Cal.com appointment: aiRoute answers with the reschedule link (the patient changes it themselves), no write
  assert.deepStrictEqual(statuses(r.plan), []);
  const wa = F.appointmentRows(); wa[0].fields.Booking_UID = 'wa-wamid.OLD.9';   // booked on WhatsApp: aiRoute would write a Booked row
  r = run('Please move my appointment to Saturday at 5.', { appts: wa, edit: dec({ intent: 'reschedule_appointment', action: 'reschedule_appointment', appointment_ref: 'A1', booking: { date: '2026-10-10', time: '17:00', time_window: null }, reply: 'Moved!' }) });
  assert.strictEqual(r.plan.route, 'handoff');
  assert(/request mode: changing a time needs a person/.test(r.plan.reason));
  assert.deepStrictEqual(r.plan.action_writes, []);
  // cancel a request: allowed, and called a request
  r = run('Please cancel my request', { appts: [...F.appointmentRows(), reqRow(10, 1, SAT_5PM)], edit: dec({ intent: 'cancel_appointment', action: 'cancel_appointment', appointment_ref: 'A2', reply: 'Cancelled.' }) });
  assert.strictEqual(r.plan.route, 'cancelled');
  assert.deepStrictEqual(r.plan.action_writes, [{ method: 'PATCH', table: 'Appointments', body: { records: [{ id: 10, fields: { Status: 'Cancelled' } }] } }]);
  assert.strictEqual(r.plan.reply, 'Your request for Sat 10 Oct 5:00 PM is cancelled.');
  // cancel of a WhatsApp-booked (confirmed) appointment keeps working as before
  r = run('Cancel my appointment', { appts: wa, edit: dec({ intent: 'cancel_appointment', action: 'cancel_appointment', appointment_ref: 'A1', reply: 'Cancelled.' }) });
  assert.strictEqual(r.plan.route, 'cancelled');
  assert.deepStrictEqual(statuses(r.plan), ['Cancelled']);
  ok('reschedule of a confirmed WhatsApp booking = a person; cancel of a request = allowed and worded as a request; Cal.com appointments still use the patient\'s own link');
}

// ---------------------------------------------------------------- claims about appointments
{
  const mineAt530 = reqRow(10, 1, WED_530);
  const say = (reply, o = {}) => run('What is the status of my appointment?', { appts: [...F.appointmentRows(), ...(o.pending === false ? [] : [mineAt530])], edit: dec({ intent: 'appointment_status', action: 'reply', reply }) });
  // a request called "confirmed" -> the truth
  let r = say('Your appointment tomorrow at 5:30 PM is confirmed.');
  assert.strictEqual(r.plan.reply, 'Your request for Wed 07 Oct 5:30 PM is waiting for our team to confirm. It is not confirmed yet.');
  // a REAL appointment (Asha has one tomorrow 10:00, booked on Cal.com) may be called confirmed
  r = say('Your appointment tomorrow at 10:00 AM is confirmed.');
  assert.strictEqual(r.plan.reply, 'Your appointment tomorrow at 10:00 AM is confirmed.');
  // both in one reply: the real one stays, the request is not called confirmed -> truth for the whole reply (never half true)
  r = say('Your 10:00 AM visit is confirmed and your 5:30 PM visit is confirmed too.');
  assert(/waiting for our team to confirm/.test(r.plan.reply) || r.plan.route === 'handoff', r.plan.reply);
  // a made-up confirmation: handed off
  r = say('Your appointment on Friday at 3:00 PM is confirmed.', { pending: false });
  assert.strictEqual(r.plan.route, 'handoff');
  assert(/there is no such appointment|fact check/.test(r.plan.reason), r.plan.reason);
  // honest wording about a request is left alone
  r = say('Your request for 5:30 PM is not confirmed yet. We will confirm it soon.');
  assert.strictEqual(r.plan.reply, 'Your request for 5:30 PM is not confirmed yet. We will confirm it soon.');
  // no time, nothing real to confirm
  const none = F.appointmentRows().map((a) => ({ ...a, fields: { ...a.fields, Lead: 3 } }));
  r = run('hello', { appts: none, edit: dec({ intent: 'greeting', action: 'reply', reply: 'Hello! Your appointment is confirmed.' }) });
  assert.strictEqual(r.plan.route, 'handoff');
  assert(/no such appointment|patient has none/.test(r.plan.reason), r.plan.reason);
  ok('claims: a pending request called "confirmed" is corrected; a real appointment may be called confirmed; a confirmation of nothing is handed off; honest "not confirmed yet" wording is left alone');
}

// ---------------------------------------------------------------- invariants
{
  // nothing in request mode may write a Booked appointment, across a spread of decisions
  const decisions = [
    ['Book me for Saturday at 5.', (d) => d],
    ['Book me for Saturday at 5.', (d) => ({ ...d, confidence: 0.99, reply: 'Booked!' })],
    ['Book me for Saturday at 5.', (d) => ({ ...d, action: 'offer_slots', reply: 'Free: 5:00 PM.' })],
    ['Book me for Saturday at 5.', dec({ intent: 'book_appointment', action: 'book_slot', booking: { date: '2026-10-10', time: '17:00', time_window: null }, reply: 'You are booked and confirmed for Saturday 5 PM.' })],
    ['tomorrow evening', dec({ action: 'book_slot', intent: 'book_appointment', booking: { date: '2026-10-07', time: '16:00', time_window: null }, reply: 'ok' })],
    ['Please move my appointment', dec({ action: 'reschedule_appointment', intent: 'reschedule_appointment', appointment_ref: 'A1', booking: { date: '2026-10-10', time: '17:00', time_window: null }, reply: 'Moved.' })],
  ];
  const wa = F.appointmentRows(); wa[0].fields.Booking_UID = 'wa-wamid.OLD.9';
  for (const appts of [F.appointmentRows(), wa]) {
    for (const [text, edit] of decisions) {
      const r = run(text, { appts, edit });
      assert(!statuses(r.plan).includes('Booked') && !statuses(r.plan).includes('Rescheduled'), `${text}: ${JSON.stringify(statuses(r.plan))}`);
      assert(r.plan.lead_patch.Status !== 'Booked', text);
    }
  }
  ok('invariant: across book / offer / reschedule decisions and both appointment origins, request mode never writes Status Booked or Rescheduled and never marks the lead Booked');
  assert.strictEqual(ai.aiLeadAppointments([reqRow(10, 1, SAT_5PM)], 1, F.NOW).length, 0, 'the existing reader ignores Requested rows');
  assert.strictEqual(ai.aiFreeSlots(ai.aiProfile(ai.aiSettings(F.settingsRows())), [reqRow(10, 2, WED_530)], F.NOW, 7, h).days.find((d) => d.date === '2026-10-07').times.includes(17 * 60 + 30), true, 'and so does the existing slot code (the hold is only added in request mode)');
  ok('the existing aiLeadAppointments / aiFreeSlots ignore Requested rows: a request is invisible to everything that reads Booked');
}

console.log('\nAll ai-request-mode cases pass');
