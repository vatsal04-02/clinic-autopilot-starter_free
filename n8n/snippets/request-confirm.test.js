// Run: node n8n/snippets/request-confirm.test.js
// Request confirmation: which staff-decided requests the patient must be told about, and which confirmations are refused (no double booking).
const assert = require('assert');
const rc = require('./request-confirm');
const { waPrepare } = require('./wa-send');
const { normalizeIndianPhone } = require('./normalize-phone');
const { inQuietHours } = require('./send-guard');
const F = require('../tests/ai-fixtures');

const ok = (m) => console.log(`  ok  ${m}`);
const NOW = F.NOW;
const SAT = F.at('2026-10-10', '17:00');
const row = (id, over = {}) => ({ id, fields: { Booking_UID: `req-wamid.${id}`, Lead: 1, Service: 'Knee pain physiotherapy', Start: SAT, End: SAT + 1800, Status: 'Booked', Requested_At: F.sec(NOW) - 3600, ...over } });
const leads = F.leadRows();
const convs = [{ id: 1, fields: { Lead: 1, Phone: F.ASHA, Last_Inbound_At: F.sec(NOW) - 600, Automation_Paused: false } }];
const plan = (appts, o = {}) => rc.reqcPlan(appts, o.leads || leads, o.convs || convs, o.settings || {}, o.now || NOW, o.cfg || {});
const kinds = (p) => p.items.map((i) => `${i.appt_row_id}:${i.kind}`);

// ---------------------------------------------------------------- confirmed / declined
{
  let p = plan([row(10)]);
  assert.deepStrictEqual(kinds(p), ['10:confirmed']);
  assert.deepStrictEqual([p.items[0].lead_row_id, p.items[0].lead_id, p.items[0].lead_name, p.items[0].lead_phone, p.items[0].service, p.items[0].opted_out, p.items[0].start, p.items[0].end, p.items[0].flag_value], [1, 'L-20261001-0001', 'Asha Patel', F.ASHA, 'Knee pain physiotherapy', false, SAT, SAT + 1800, null]);
  assert.strictEqual(p.items[0].last_inbound_at, F.sec(NOW) - 600);
  p = plan([row(10, { Status: 'Declined' })]);
  assert.deepStrictEqual(kinds(p), ['10:declined']);
  ok('a request staff set to Booked -> "confirmed"; set to Declined -> "declined"; the item carries what W12 needs');
}

// ---------------------------------------------------------------- what is NOT touched
{
  const calcom = { id: 3, fields: { Booking_UID: 'cal-uid-1', Lead: 1, Start: SAT, End: SAT + 1800, Status: 'Booked' } };
  const wa = { id: 4, fields: { Booking_UID: 'wa-wamid.1', Lead: 1, Start: SAT + 7200, End: SAT + 9000, Status: 'Booked' } };
  const p = plan([calcom, wa, row(10, { Status: 'Requested' }), row(11, { Status: 'Cancelled' }), row(12, { Status: 'Completed' }), row(13, { Confirm_Sent: F.sec(NOW) - 60 }), row(14, { Status: 'Declined', Confirm_Sent: F.sec(NOW) - 60 })]);
  assert.deepStrictEqual(kinds(p), [], 'Cal.com / WhatsApp bookings, still-open requests, cancelled / completed rows and rows already handled are left alone');
  assert.deepStrictEqual(plan([row(10, { Start: F.sec(NOW) - 2 * 3600 })]).held.map((h) => h.reason), ['the appointment time has already passed']);
  assert.deepStrictEqual(plan([row(10, { Lead: 99 })]).held.map((h) => h.reason), ['lead not found']);
  assert.deepStrictEqual(plan([row(10, { Lead: 0 })]).held.map((h) => h.reason), ['lead not found']);
  assert.deepStrictEqual(plan([row(10, { Start: undefined })]).items, []);
  ok('only req- rows staff decided on AND not yet announced (Confirm_Sent empty) are planned; Cal.com / WhatsApp bookings are never touched; past, lead-less and malformed rows are held');
}

// ---------------------------------------------------------------- no double booking
{
  const calcom = { id: 3, fields: { Booking_UID: 'cal-uid-1', Lead: 2, Start: SAT, End: SAT + 1800, Status: 'Booked' } };
  let p = plan([calcom, row(10)]);
  assert.deepStrictEqual(kinds(p), ['10:conflict']);
  assert.deepStrictEqual(p.items[0].conflict_with, ['cal-uid-1']);
  // overlapping but not identical times conflict too; adjacent ones do not
  assert.deepStrictEqual(kinds(plan([{ ...calcom, fields: { ...calcom.fields, Start: SAT - 900, End: SAT + 900 } }, row(10)])), ['10:conflict']);
  assert.deepStrictEqual(kinds(plan([{ ...calcom, fields: { ...calcom.fields, Start: SAT - 1800, End: SAT } }, row(10)])), ['10:confirmed']);
  assert.deepStrictEqual(kinds(plan([{ ...calcom, fields: { ...calcom.fields, Status: 'Cancelled' } }, row(10)])), ['10:confirmed'], 'a cancelled booking frees the slot');
  assert.deepStrictEqual(kinds(plan([{ ...calcom, fields: { ...calcom.fields, Status: 'Rescheduled' } }, row(10)])), ['10:conflict'], 'a rescheduled-status row still counts as in the calendar');
  assert.deepStrictEqual(kinds(plan([{ ...calcom, fields: { ...calcom.fields, Status: 'Requested' } }, row(10)])), ['10:confirmed'], 'another open request does not block a confirmation');
  // capacity 2
  assert.deepStrictEqual(kinds(plan([calcom, row(10)], { settings: { booking_capacity: '2' } })), ['10:confirmed']);
  assert.deepStrictEqual(kinds(plan([calcom, { ...calcom, id: 5, fields: { ...calcom.fields, Booking_UID: 'cal-uid-2' } }, row(10)], { settings: { booking_capacity: '2' } })), ['10:conflict']);
  // staff confirm BOTH of two competing requests at once: the lowest row id keeps the slot, the other is refused
  p = plan([row(10), row(11, { Lead: 3 })], { leads: [...leads] });
  assert.deepStrictEqual(kinds(p), ['10:confirmed', '11:conflict']);
  assert.deepStrictEqual(p.items[1].conflict_with, ['req-wamid.10']);
  // once the first was announced (Confirm_Sent set) the second still conflicts with it
  p = plan([row(10, { Confirm_Sent: F.sec(NOW) - 30 }), row(11, { Lead: 3 })]);
  assert.deepStrictEqual(kinds(p), ['11:conflict']);
  // never refuses the older one because of a newer one
  assert.deepStrictEqual(kinds(plan([row(11), row(10)])), ['10:confirmed', '11:conflict'], 'order of the rows in the read does not matter');
  ok('no double booking: a confirmation over a taken slot is refused (overlap, capacity, cancelled frees it); two requests confirmed together -> the lowest id wins');
}

// ---------------------------------------------------------------- limits and the opted-out
{
  const many = Array.from({ length: 30 }, (_, i) => row(100 + i, { Start: SAT + i * 3600 * 24, End: SAT + i * 3600 * 24 + 1800 }));
  assert.strictEqual(plan(many, { cfg: { max_per_run: 5 } }).items.length, 5);
  assert.strictEqual(plan(many).items.length, 20, 'default 20 per run');
  const opted = leads.map((l) => (l.id === 1 ? { ...l, fields: { ...l.fields, Opted_Out: true } } : l));
  assert.strictEqual(plan([row(10)], { leads: opted }).items[0].opted_out, true, 'the plan carries Opted_Out; the send guard (REQ – Decide send) refuses it');
  ok('at most max_per_run items per run; Opted_Out travels with the item (the guard refuses it)');
}

// ---------------------------------------------------------------- the messages
{
  const item = plan([row(10)]).items[0];
  const nowSec = F.sec(NOW);
  let m = rc.reqcMessage(item, 'Demo Physio', nowSec);
  assert.deepStrictEqual(m, { message_type: 'text', text_body: 'Hi Asha, good news: your Knee pain physiotherapy at Demo Physio is confirmed for 10 Oct at 5:00 PM. Reply here if you need to change it.', message_text: 'Hi Asha, good news: your Knee pain physiotherapy at Demo Physio is confirmed for 10 Oct at 5:00 PM. Reply here if you need to change it.', template: '', template_params: {} });
  m = rc.reqcMessage({ ...item, last_inbound_at: nowSec - 25 * 3600 }, 'Demo Physio', nowSec);
  assert.deepStrictEqual([m.message_type, m.template, m.template_params, m.text_body], ['template', 'booking_confirmation', { name: 'Asha', service: 'Knee pain physiotherapy', clinic_name: 'Demo Physio', date: '10 Oct', time: '5:00 PM' }, '']);
  assert(m.message_text.includes('confirmed for 10 Oct at 5:00 PM'), 'the inbox text shows what the patient got');
  m = rc.reqcMessage({ ...item, last_inbound_at: null }, 'Demo Physio', nowSec);
  assert.strictEqual(m.message_type, 'template', 'no patient message on record = template');
  const d = rc.reqcMessage({ ...item, kind: 'declined' }, 'Demo Physio', nowSec);
  assert.deepStrictEqual([d.message_type, d.template], ['text', '']);
  assert(/^Hi Asha, sorry, we could not confirm your request for 10 Oct at 5:00 PM at Demo Physio\. Please reply with another time/.test(d.text_body));
  assert.strictEqual(rc.reqcMessage({ ...item, lead_name: '' }, '', nowSec).text_body.startsWith('Hi there, good news: your Knee pain physiotherapy at the clinic'), true);
  assert.strictEqual(rc.reqcDate(F.at('2026-10-09', '23:30')), '09 Oct', 'IST dates, not UTC');
  assert.strictEqual(rc.reqcTime(F.at('2026-10-09', '00:05')), '12:05 AM');
  assert.strictEqual(rc.reqcTime(F.at('2026-10-09', '12:00')), '12:00 PM');
  ok('messages: free text in the 24 h window, the approved booking_confirmation template outside it, a decline is text only; dates and times in IST');

  // the template item is one W12 accepts (variables in order, none empty)
  const tpl = rc.reqcMessage({ ...item, last_inbound_at: null }, 'Demo Physio', nowSec);
  const cfg = { send_mode: 'live', allowlist: '', graph_api_version: 'v23.0', default_language: 'en' };
  const prep = waPrepare({ ...tpl, audience: 'patient', lead_phone: item.lead_phone, decision: { send: true, to: normalizeIndianPhone(item.lead_phone).phone, reason: '', test_mode: false }, wa_phone_number_id: '123456789012345', source_workflow: 'W12-request-confirm' }, cfg, NOW, { normalizeIndianPhone, inQuietHours });
  assert.strictEqual(prep.call_meta, true, `W12 accepts the template parameters: ${prep.send_error}`);
  assert.deepStrictEqual(prep.meta_request.template.components[0].parameters.map((q) => q.text), ['Asha', 'Knee pain physiotherapy', 'Demo Physio', '10 Oct', '5:00 PM']);
  ok('W12 accepts the booking_confirmation parameters this module builds');
}

// ---------------------------------------------------------------- the log
{
  const item = { ...plan([row(10)]).items[0], test_mode: 'true' };
  assert.deepStrictEqual(rc.reqcLog(item, 'ok', '', 1791264600), { Workflow: 'REQ-request-confirm', Record: 'req-wamid.10 confirmed L-20261001-0001 (TEST_MODE)', Outcome: 'ok', Error: '', At: 1791264600 });
  assert.strictEqual(rc.reqcLog(item, 'failed', 'x'.repeat(900), 1).Error.length, 500);
  ok('one Run_Log row per attempt (Workflow REQ-request-confirm)');
}

console.log('\nAll request-confirm cases pass');
