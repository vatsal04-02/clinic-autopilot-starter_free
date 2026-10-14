// Run: node n8n/snippets/wa-simulate.test.js
// W12 simulate mode (DEMO ONLY). Pure functions: no n8n, no network. Proves that a simulated send (1) builds no Meta URL or
// request, (2) touches no network primitive, (3) keeps every real refusal (opt-out, phone, window, quiet hours, template),
// (4) is selected only by the exact mode word and never in live / allowlist, (5) is never reported as sent or delivered,
// (6) supports the demo-only missed_call_ack intent without pretending a Meta-approved template exists.
const assert = require('assert');
const http = require('http');
const https = require('https');
const net = require('net');
const wa = require('./wa-send');
const sim = require('./wa-simulate');
const { normalizeIndianPhone } = require('./normalize-phone');
const { inQuietHours, decideSend } = require('./send-guard');

let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };
const h = { normalizeIndianPhone, inQuietHours, waPrepare: wa.waPrepare, waInboxPlan: wa.waInboxPlan, waInboxRow: wa.waInboxRow };
const DAY = new Date('2026-10-06T11:00:00+05:30').getTime();      // 11:00 IST
const NIGHT = new Date('2026-10-06T23:00:00+05:30').getTime();
const PATIENT = '+919000000011';
const OWNER = '+919000000018';
const CFG_SIM = { send_mode: 'simulate', allowlist: '', graph_api_version: 'v23.0', default_language: 'en', uncertain_counts_as_sent: true, log_to_inbox: true };
const dec = (over) => ({ send: true, to: PATIENT, reason: 'ok', test_mode: false, ...over });
const tplInput = (over) => ({
  decision: dec(), message_type: 'template', template: 'missed_call_ack', template_params: { clinic_name: 'Demo Physio' },
  wa_phone_number_id: '123456789012345', audience: 'patient', source_workflow: 'MCC-missed-call', lead_phone: PATIENT,
  grist_base_url: 'http://grist:8484', doc_id: 'DOCA', ...over,
});

// ---- 1. no network primitive is touched, whatever the input (checked for the whole file)
const trapped = [];
const real = { fetch: globalThis.fetch, httpReq: http.request, httpsReq: https.request, connect: net.connect };
globalThis.fetch = () => { trapped.push('fetch'); throw new Error('network!'); };
http.request = () => { trapped.push('http'); throw new Error('network!'); };
https.request = () => { trapped.push('https'); throw new Error('network!'); };
net.connect = () => { trapped.push('net'); throw new Error('network!'); };

// ---- 2. the mode word
for (const v of ['simulate', ' Simulate ', 'SIMULATE']) assert.strictEqual(sim.waIsSimulate({ send_mode: v }), true, v);
for (const v of ['live', 'allowlist', 'simulated', 'sim', 'simulate-live', '', null, undefined, 'blocked', 'simulate,live']) assert.strictEqual(sim.waIsSimulate({ send_mode: v }), false, String(v));
assert.strictEqual(sim.waIsSimulate({}), false);
assert.strictEqual(sim.waIsSimulate(null), false);
assert.strictEqual(sim.waIsSimulate({ send_mode: 'live', simulate: true, decision: { simulate: true } }), false, 'only the Config mode word selects it, never a flag on the item');
ok('simulate is selected only by the exact mode word; live, allowlist, typos and item flags never select it');

// ---- 3. a valid message is simulated: no Meta request exists
{
  const p = sim.waSimulate(tplInput(), CFG_SIM, DAY, h);
  assert.strictEqual(p.call_meta, false);
  assert.strictEqual(p.simulated, true);
  assert.strictEqual(p.send_status, 'simulated');
  assert.strictEqual(p.to, PATIENT);
  assert(!('meta_url' in p) && !('meta_request' in p), 'no Meta URL or request is ever built');
  assert.deepStrictEqual(p.would_send.params, ['Demo Physio']);
  assert.strictEqual(p.would_send.approved_template, false);
  assert(/we missed your call to Demo Physio/.test(p.would_send.preview));
  const t = sim.waSimulate(tplInput({ template: 'reminder_24h', template_params: { name: 'Asha', service: 'Knee', clinic_name: 'Demo Physio', date: '07 Oct', time: '10:00' } }), CFG_SIM, DAY, h);
  assert.strictEqual(t.simulated, true);
  assert.strictEqual(t.would_send.approved_template, true);
  assert.deepStrictEqual(t.would_send.params, ['Asha', 'Knee', 'Demo Physio', '07 Oct', '10:00']);
  const x = sim.waSimulate({ ...tplInput(), message_type: 'text', text_body: 'Hello Asha', last_inbound_at: Math.floor(DAY / 1000) - 3600 }, CFG_SIM, DAY, h);
  assert.strictEqual(x.simulated, true);
  assert.deepStrictEqual(x.would_send, { type: 'text', text: 'Hello Asha' });
}
ok('a valid template / free-text send is simulated with call_meta false and no Meta URL or request');

// ---- 4. every real refusal still refuses
{
  const refuse = (input, status, re, now = DAY) => {
    const p = sim.waSimulate(input, CFG_SIM, now, h);
    assert.strictEqual(p.call_meta, false);
    assert(!p.simulated, `${status}: must not simulate`);
    assert.strictEqual(p.send_status, status);
    assert(re.test(p.send_error), `${p.send_error}`);
  };
  refuse(tplInput({ decision: dec({ send: false, reason: 'opted out' }) }), 'not_requested', /opted out/);
  refuse(tplInput({ decision: undefined }), 'not_requested', /no send decision/);
  refuse(tplInput({ decision: dec({ to: 'not-a-number' }) }), 'invalid', /not a valid Indian mobile/);
  refuse(tplInput({ wa_phone_number_id: '' }), 'invalid', /wa_phone_number_id/);
  refuse(tplInput({ template: 'does_not_exist' }), 'invalid', /unknown template/);
  refuse(tplInput({ template_params: {} }), 'invalid', /clinic_name/);
  refuse(tplInput(), 'blocked', /quiet hours/, NIGHT);
  refuse({ ...tplInput(), message_type: 'text', text_body: 'Hi', last_inbound_at: Math.floor(DAY / 1000) - 30 * 3600 }, 'blocked', /24-hour/);
  refuse({ ...tplInput(), message_type: 'text', text_body: '   ', last_inbound_at: Math.floor(DAY / 1000) }, 'invalid', /text_body is empty/);
  refuse({ ...tplInput(), message_type: 'text', text_body: 'Hi' }, 'invalid', /last_inbound_at/);
  const noVersion = sim.waSimulate(tplInput(), { ...CFG_SIM, graph_api_version: '' }, DAY, h);
  assert.strictEqual(noVersion.send_status, 'invalid');
  const optedOut = decideSend({ kind: 'transactional', opted_out: true, patient_phone: PATIENT, test_mode: 'false', test_phone: null, now_ms: DAY });
  refuse(tplInput({ decision: optedOut }), 'not_requested', /opted out/);
}
ok('opt-out, missing decision, bad phone, missing phone id, unknown template, empty variable, quiet hours, 24 h window, empty text all still refuse');

// ---- 5. the demo-only intent does not exist for a real send
{
  const base = { send_mode: 'live', allowlist: '', graph_api_version: 'v23.0', default_language: 'en' };
  for (const mode of ['live', 'allowlist']) {
    const p = wa.waPrepare(tplInput(), { ...base, send_mode: mode, allowlist: PATIENT }, DAY, h);
    assert.strictEqual(p.call_meta, false, `${mode}: missed_call_ack must not reach Meta`);
    assert.strictEqual(p.send_status, 'invalid');
    assert(/unknown template "missed_call_ack"/.test(p.send_error));
  }
  assert(!('missed_call_ack' in wa.WA_TEMPLATES), 'missed_call_ack must not be registered as a Meta template');
}
ok('missed_call_ack is refused by the real send path ("unknown template") and is not in WA_TEMPLATES: no pretend approval');

// ---- 6. the result is never sent / delivered
{
  const prep = sim.waSimulate(tplInput(), CFG_SIM, DAY, h);
  const res = sim.waSimulatedResult(prep, DAY);
  assert.strictEqual(res.sent, false);
  assert.strictEqual(res.send_status, 'simulated');
  assert.strictEqual(res.simulated, true);
  assert(/^sim-[0-9a-z]+$/.test(res.wa_message_id), res.wa_message_id);
  assert.strictEqual(res.send_error, '');
  assert.strictEqual(sim.waSimulatedResult(prep, DAY).wa_message_id, res.wa_message_id, 'stable for the same input and time');
  assert.notStrictEqual(sim.waSimulatedResult(prep, DAY + 1).wa_message_id, res.wa_message_id);
  const classify = wa.waClassify({ statusCode: 200, body: { messages: [{ id: 'wamid.REAL' }] } }, CFG_SIM);
  assert.strictEqual(classify.sent, true, 'sanity: a real accepted send IS sent');
  assert.notStrictEqual(res.wa_message_id.slice(0, 5), 'wamid');
}
ok('a simulated result has sent = false, send_status "simulated" and a sim- id that cannot be mistaken for a Meta id');

// ---- 7. the inbox row is plainly labelled and never "sent"
{
  const input = tplInput({ message_text: 'Namaste! Sorry, we missed your call to Demo Physio. How can we help you today?' });
  const prep = sim.waSimulate(input, CFG_SIM, DAY, h);
  const res = sim.waSimulatedResult(prep, DAY);
  const plan = sim.waSimInboxPlan(input, CFG_SIM, res, h);
  assert.strictEqual(plan.log, true, 'the demo thread shows the intended acknowledgement');
  assert.strictEqual(plan.patient_phone, PATIENT);
  const row = sim.waSimInboxRow(input, res, Math.floor(DAY / 1000), h);
  assert.strictEqual(row.Direction, 'Out');
  assert(row.Body.startsWith('[DEMO simulated, not sent] Namaste!'), row.Body);
  assert(/\[DEMO simulated: nothing was sent; would go to \+919000000011\]/.test(row.Sent_By), row.Sent_By);
  assert.strictEqual(row.Status, 'queued');
  assert.strictEqual(row.Send, false, 'W10 must never pick this row up');
  assert.strictEqual(row.WA_Message_ID, res.wa_message_id);
  assert(row.Sent_By.length <= 200 && row.Body.length <= 2000);
  const staff = tplInput({ audience: 'staff' });
  assert.strictEqual(sim.waSimInboxPlan(staff, CFG_SIM, res, h).log, false, 'staff alerts are not written to the patient thread');
  assert.strictEqual(sim.waSimInboxPlan(input, { ...CFG_SIM, log_to_inbox: false }, res, h).log, false);
  const bare = tplInput();   // no message_text: the demo preview replaces the "[template ...]" placeholder
  assert(sim.waSimInboxRow(bare, res, 1, h).Body.includes('we missed your call to Demo Physio'));
}
ok('the simulated inbox row is labelled DEMO, queued with Send false, and shown only for patient messages');

// ---- 8. nothing used the network
globalThis.fetch = real.fetch; http.request = real.httpReq; https.request = real.httpsReq; net.connect = real.connect;
assert.deepStrictEqual(trapped, [], `network primitives touched: ${trapped}`);
ok('no network primitive (fetch, http, https, net) was touched by any simulated call');

console.log(`\nAll ${n} wa-simulate cases pass`);
