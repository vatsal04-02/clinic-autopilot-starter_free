// Run: node n8n/snippets/urgent-alerts.test.js
// Urgent hand-offs at night: the owner is alerted at once, the patient is not messaged; everything else is unchanged.
const assert = require('assert');
const ai = require('./ai-receptionist');
const ua = require('./urgent-alerts');
const { normalizeIndianPhone } = require('./normalize-phone');
const { decideSend, inQuietHours } = require('./send-guard');
const { parseClock, parseDays } = require('./clinic-hours');
const F = require('../tests/ai-fixtures');

const h = { normalizeIndianPhone, decideSend, inQuietHours, parseClock, parseDays };
const ok = (m) => console.log(`  ok  ${m}`);
const clone = (o) => JSON.parse(JSON.stringify(o));
const rec = (r) => ({ records: clone(r) });
const CFG = { model: undefined, leads_table: 'LEADS', min_confidence: 0.65, confidence_auto: 0.8, confidence_write: 0.85, max_ai_replies_per_hour: 6, history_limit: 12, slot_days: 7, pause_on_handoff: false, staff_alert_template: 'human_handoff_alert' };
function ctx(text, now, settings = {}) {
  const msg = { id: 4, fields: { Conversation: 1, Direction: 'In', Body: text, Sent_By: 'Patient', WA_Message_ID: 'wamid.U.1', Status: 'Received', Created_At: F.sec(now) - 5 } };
  const raw = { start: { message_row_id: 4, wa_message_id: 'wamid.U.1', msg_type: 'text' }, clinic: { clinic_name: 'Demo Physio', doc_id: 'DOCA', grist_base_url: 'http://grist:8484', wa_phone_number_id: '123456789012345' }, settings: rec(F.settingsRows({ TEST_MODE: 'false', ...settings })), knowledge: rec(F.KNOWLEDGE), message: rec([msg]), conversation: rec(F.conversationRows()), lead: rec([F.leadRows()[0]]), history: rec([...F.messageRows(), msg]), appointments: rec(F.appointmentRows()) };
  return ai.aiContext(raw, CFG, now, h);
}
const NIGHT = Date.parse('2026-10-06T23:00:00+05:30');
const DAY = F.NOW;
function handoff(text, now, settings) {
  const { x, gate } = ctx(text, now, settings);
  const plan = ai.aiGatePlan(gate, x, CFG);
  return { x, gate, plan, items: ai.aiSendItems(plan, x, h) };
}

// ---------------------------------------------------------------- the problem, and the fix
{
  const { gate, plan, items, x } = handoff('I have chest pain, what are your fees?', NIGHT);
  assert.strictEqual(gate.route, 'handoff');
  assert.strictEqual(plan.triage.priority, 'urgent');
  // before: both items are guarded out by quiet hours
  assert.deepStrictEqual(items.map((i) => [i.w13_kind, i.decision.send, i.decision.reason]), [['patient_reply', false, 'quiet hours'], ['staff_alert', false, 'quiet hours']]);
  const out = ua.aiUrgentAlerts(plan, x, items, h);
  assert.deepStrictEqual(out.map((i) => [i.w13_kind, i.decision.send, i.decision.to, i.urgent]), [['staff_alert', true, '+919000000018', true]]);
  assert.strictEqual(plan.reply, '', 'no patient reply at night');
  assert(plan.notes.some((n) => /owner is alerted now/.test(n)));
  assert.strictEqual(out[0].template, 'human_handoff_alert');
  assert(/chest pain/.test(out[0].template_params.reason));
  ok('an emergency at 23:00: the owner alert is now due (was blocked by quiet hours), the patient holding reply is dropped (no patient message at night)');
}
{
  const { plan, items, x } = handoff('I have chest pain, what are your fees?', DAY);
  const out = ua.aiUrgentAlerts(plan, x, items, h);
  assert.deepStrictEqual(out.map((i) => [i.w13_kind, i.decision.send]), [['patient_reply', true], ['staff_alert', true]]);
  assert(plan.reply.length > 0, 'by day the patient still gets the holding reply');
  assert.strictEqual(out[1].urgent, true);
  ok('by day nothing changes: patient holding reply + owner alert');
}

// ---------------------------------------------------------------- guards that still apply to the owner alert
{
  let r = handoff('I have chest pain', NIGHT, { TEST_MODE: 'true' });
  let out = ua.aiUrgentAlerts(r.plan, r.x, r.items, h);
  assert.strictEqual(out[0].decision.to, '+919000000019', 'TEST_MODE: to TEST_PHONE');
  r = handoff('I have chest pain', NIGHT, { owner_phone: '12345' });
  out = ua.aiUrgentAlerts(r.plan, r.x, r.items, h);
  assert.deepStrictEqual([out[0].decision.send, out[0].decision.reason, out[0].urgent], [false, 'no valid patient phone', true], 'no valid owner phone: not sent, and it is still flagged due (so it is logged as a failure)');
  r = handoff('I have chest pain', NIGHT, { owner_phone: undefined });
  out = ua.aiUrgentAlerts(r.plan, r.x, r.items, h);
  assert.strictEqual(out[0].decision.send, false);
  ok('TEST_MODE still redirects to TEST_PHONE; a missing / invalid owner number is not sent but stays "due"');
}

// ---------------------------------------------------------------- what is NOT urgent is untouched
{
  for (const [text, now] of [['I want to complain about the treatment', DAY], ['My knee is swollen, should I take ibuprofen?', DAY], ['hello', NIGHT]]) {
    const { x, plan: p0 } = handoff(text, now);
    const plan = ai.aiEmptyPlan('handoff', 'x'); plan.triage = { priority: 'high', flags: ['complaint'], note: '' };
    const items = ai.aiSendItems(ai.aiToHandoff(plan, x, CFG, 'complaint'), x, h);
    const before = clone(items);
    assert.deepStrictEqual(ua.aiUrgentAlerts(plan, x, items, h), before, `${text}: a HIGH hand-off keeps the quiet-hours rule`);
    assert(p0);
  }
  const { x } = ctx('hello', NIGHT);
  const plan = ai.aiEmptyPlan('reply', '');
  const items = [{ w13_kind: 'patient_reply', decision: { send: false } }];
  assert.deepStrictEqual(ua.aiUrgentAlerts(plan, x, items, h), items, 'a normal reply');
  ok('only an URGENT hand-off is changed: high-priority hand-offs and normal replies keep the quiet-hours rule');
}

// the same check, proven to bite: with the "urgent only" condition removed, the HIGH hand-off WOULD bypass quiet hours (a night hand-off that is not an
// emergency does not reach this code through the gates, so only this unit test can show it)
{
  const src = require('fs').readFileSync(require.resolve('./urgent-alerts'), 'utf8');
  const mutated = src.replace("const urgent = plan.route === 'handoff' && plan.triage && plan.triage.priority === 'urgent';", "const urgent = plan.route === 'handoff';").replace(/if \(typeof module[\s\S]*$/, 'return { aiUrgentAlerts };');
  assert(mutated !== src, 'the mutation target exists');
  const bad = new Function(mutated)().aiUrgentAlerts;
  const { x } = ctx('hello', NIGHT);
  const plan = ai.aiEmptyPlan('handoff', 'x'); plan.triage = { priority: 'high', flags: ['complaint'], note: '' };
  const items = ai.aiSendItems(ai.aiToHandoff(plan, x, CFG, 'complaint'), x, h);
  assert.strictEqual(bad(plan, x, items, h).find((i) => i.w13_kind === 'staff_alert').decision.send, true, 'the mutant would send a HIGH alert at night');
  assert.strictEqual(ua.aiUrgentAlerts(plan, x, items, h).find((i) => i.w13_kind === 'staff_alert').decision.send, false, 'the real code does not');
  ok('mutation check: removing the "urgent only" condition would let a HIGH hand-off bypass quiet hours; the real code does not');
}

// ---------------------------------------------------------------- the failure log
{
  const due = [{ w13_kind: 'staff_alert', urgent: true, decision: { send: true } }];
  assert.strictEqual(ua.aiUrgentAlertLost(due, { staff: { sent: true } }), null);
  assert.strictEqual(ua.aiUrgentAlertLost(due, { staff: { sent: false, simulated: true } }), null, 'a DEMO simulated send is done');
  assert.deepStrictEqual(ua.aiUrgentAlertLost(due, { staff: { sent: false, send_error: 'Meta 131047: Re-engagement   message', send_status: 'rejected' } }), { urgent: true, reason: 'Meta 131047: Re-engagement message' });
  assert.deepStrictEqual(ua.aiUrgentAlertLost(due, { staff: null }), { urgent: true, reason: 'no answer from W12' });
  assert.strictEqual(ua.aiUrgentAlertLost([{ w13_kind: 'staff_alert', decision: { send: true } }], { staff: { sent: false, send_status: 'blocked' } }).urgent, false, 'a normal alert that was due and failed is a failure too');
  assert.strictEqual(ua.aiUrgentAlertLost([{ w13_kind: 'staff_alert', decision: { send: false, reason: 'quiet hours' } }], { staff: null }), null, 'a normal alert held back by quiet hours is not a failure (the morning run sends it)');
  assert.strictEqual(ua.aiUrgentAlertLost([{ w13_kind: 'patient_reply', decision: { send: true } }], { staff: null }), null, 'no alert due');
  assert.strictEqual(ua.aiUrgentAlertLost([], {}), null);
  ok('a staff alert that was due and did not go out is reported (urgent or not); quiet-hours holds and DEMO simulated sends are not failures');
}
console.log('\nAll urgent-alerts cases pass');
