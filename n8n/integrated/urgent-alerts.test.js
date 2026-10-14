// URGENT ALERTS AT NIGHT end to end on the SHIPPED workflow JSON in the simulator: an emergency at 23:00 alerts the owner at once, never messages the
// patient at night, and a due alert that does not go out is a failure in Run_Log. Quiet-hours rules for everything else are unchanged.
// The master ships with the TEMPORARY quiet-hours test switch ON (DISABLE_QUIET_HOURS_FOR_TEST = true): these tests switch it OFF in memory, as production runs.
// Fake Grist, fake Meta, fake AI. Made-up numbers. Nothing touches the network.
// Run: node n8n/integrated/urgent-alerts.test.js        (URGENT_FILE=<file>: test another build, e.g. the combined demo workflow)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const http = require('http');
const https = require('https');
const net = require('net');
const { spawnSync } = require('child_process');
const trap = () => { throw new Error('this test must not touch the network'); };
global.fetch = trap; http.request = trap; http.get = trap; https.request = trap; https.get = trap; net.connect = trap; net.createConnection = trap;

const { simulate, FakeGrist, COLUMNS, CHOICES, DATETIME, TOGGLE } = require('../tests/n8n-sim');
const F = require('../tests/ai-fixtures');

const MASTER = path.join(__dirname, 'clinic-autopilot-master-ai.json');
const clone = (o) => JSON.parse(JSON.stringify(o));
const suite = [];
const test = (name, fn) => suite.push({ name, fn });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'urgent-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const patch = (input, name) => {
  const out = path.join(TMP, name);
  try { fs.unlinkSync(out); } catch (e) { /* none */ }
  const r = spawnSync(process.execPath, [path.join(__dirname, 'apply-urgent-alerts.js'), '--in', input, '--out', out], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, out, exists: fs.existsSync(out) };
};
const MASTER_WF = JSON.parse(fs.readFileSync(MASTER, 'utf8'));
let PATCHED;
if (process.env.URGENT_FILE) PATCHED = JSON.parse(fs.readFileSync(process.env.URGENT_FILE, 'utf8'));
else { const a = patch(MASTER, 'urgent.json'); assert.strictEqual(a.status, 0, a.stderr); PATCHED = JSON.parse(fs.readFileSync(process.env.URGENT_MUTANT || a.out, 'utf8')); }

COLUMNS.LEADS = COLUMNS.Leads.map((c) => (c === 'Lead_ID' ? 'Lead_id' : c));
for (const k of Object.keys(CHOICES)) if (k.startsWith('Leads.')) CHOICES[k.replace('Leads.', 'LEADS.')] = CHOICES[k];
for (const set of [DATETIME, TOGGLE]) for (const k of [...set]) if (k.startsWith('Leads.')) set.add(k.replace('Leads.', 'LEADS.'));
CHOICES['Messages.Status'] = [...CHOICES['Messages.Status'], 'Received'];

const PNID = '123456789012345';
const REG = 'fAft6pAYwFUU';
const P_ASHA = '919000000011';
const OWNER = '+919000000018', TESTP = '+919000000019';
const setCfg = (w, node, key, v) => { w.nodes.find((n) => n.name === node).parameters.assignments.assignments.find((a) => a.name === key).value = v; return w; };
// production behaviour: the temporary quiet-hours test switch OFF (in all 7 nodes that carry it)
const production = (base) => {
  const w = clone(base);
  let flipped = 0;
  for (const n of w.nodes) if (n.parameters && typeof n.parameters.jsCode === 'string' && n.parameters.jsCode.includes('const DISABLE_QUIET_HOURS_FOR_TEST = true;')) { n.parameters.jsCode = n.parameters.jsCode.replace('const DISABLE_QUIET_HOURS_FOR_TEST = true;', 'const DISABLE_QUIET_HOURS_FOR_TEST = false;'); flipped++; }
  assert.strictEqual(flipped, 7, 'the switch is pasted in 7 nodes');
  setCfg(w, 'W12 – Config', 'w12_allowlist', `+${P_ASHA},+919000000012,+919000000013,+919000000014,${OWNER},${TESTP}`);
  setCfg(w, 'W2 – Verify Config', 'meta_verify_token', 'test-verify-token-123');
  return w;
};
const WF = production(PATCHED);
const WF_MASTER = production(MASTER_WF);
const crm = ({ settings = {}, msgs } = {}) => new FakeGrist({
  [REG]: { Clinics: [{ id: 1, fields: { Clinic_Slug: 'demo-clinic', Clinic_Name: 'Demo Physio', Grist_Doc_ID: 'DOCA', WA_Phone_Number_ID: PNID, Active: true } }] },
  DOCA: { Settings: F.settingsRows({ TEST_MODE: 'false', ...settings }), Knowledge: clone(F.KNOWLEDGE), LEADS: F.leadRows(), Conversations: F.conversationRows(), Messages: clone(msgs || F.messageRows()), Appointments: F.appointmentRows(), Run_Log: [] },
});
const fakeMeta = (answer) => { const calls = []; const fn = (method, url, body) => { calls.push({ url, body }); return (answer && answer(body, calls.length)) || { status: 200, body: { messages: [{ id: `wamid.SENT.${calls.length}` }] } }; }; fn.calls = calls; return fn; };
const metaBody = (text, id, ts) => ({ object: 'whatsapp_business_account', entry: [{ id: 'TEST_WABA_ID', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: PNID }, contacts: [{ profile: { name: 'Asha Patel' }, wa_id: P_ASHA }], messages: [{ from: P_ASHA, id, timestamp: String(ts), type: 'text', text: { body: text } }] } }] }] });
const allRuns = (r) => [r, ...r.subRuns.flatMap(allRuns)];
const rows = (g, t) => g.docs.DOCA[t].map((x) => ({ id: x.id, ...x.fields }));
const lastIn = (g) => rows(g, 'Messages').filter((m) => m.Direction === 'In').pop();
const logs = (g, w) => rows(g, 'Run_Log').filter((l) => l.Workflow === w);
const texts = (meta) => meta.calls.map((c) => (c.body.type === 'text' ? `${c.body.to}: ${c.body.text.body}` : `${c.body.to}: [${c.body.template.name}] ${(c.body.template.components || [{ parameters: [] }])[0].parameters.map((p) => p.text).join(' | ')}`));
const NIGHT = Date.parse('2026-10-06T23:00:00+05:30');
const DAY = F.NOW;
function post(text, o = {}) {
  const g = o.g || crm(o.crm);
  const meta = o.meta || fakeMeta(o.metaAnswer);
  const now = o.now || DAY;
  const claude = F.fakeClaude(o.ai);
  const r = simulate(o.w || WF, { start: 'W2 – Webhook Inbound', items: [{ json: { headers: {}, params: {}, query: {}, body: metaBody(text, o.id || `wamid.U.${Math.random().toString(36).slice(2, 7)}`, F.sec(now) - 5) } }], grist: g, now, workflowId: 'MASTER', workflows: {}, meta, openrouter: F.fakeOpenRouter(claude), ollama: F.fakeOllama(claude) });
  return { g, meta, claude, r, runs: allRuns(r) };
}
const clean = (x) => { for (const run of x.runs) assert.strictEqual(run.error, null, `${run.visited[0]}: ${JSON.stringify(run.error)}`); };
const ALERT = `${OWNER.slice(1)}: [human_handoff_alert] Demo Physio | Asha Patel | ${F.ASHA} | URGENT · Possible emergency ("chest pain"). Patient wrote: "I have chest pain, what are your fees?". Contact the patient now.`;
const EMERGENCY = 'I have chest pain, what are your fees?';

console.log(`Urgent alerts on: ${process.env.URGENT_FILE ? path.basename(process.env.URGENT_FILE) : 'master + apply-urgent-alerts.js'}`);

test('U1 the patch changes THREE existing nodes (code only: W13 – Plan Ready, W13 – Record Sends, W12 – Prepare request) and adds nothing; no wiring, credential or webhook changes', () => {
  if (process.env.URGENT_FILE) return;
  const A = Object.fromEntries(MASTER_WF.nodes.map((n) => [n.name, n]));
  const B = Object.fromEntries(PATCHED.nodes.map((n) => [n.name, n]));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  assert.strictEqual(PATCHED.nodes.length, MASTER_WF.nodes.length);
  assert.deepStrictEqual(Object.keys(A).filter((n) => !same(A[n], B[n])).sort(), ['W12 – Prepare request', 'W13 – Plan Ready', 'W13 – Record Sends']);
  for (const n of ['W12 – Prepare request', 'W13 – Plan Ready', 'W13 – Record Sends']) { const x = clone(A[n]); const y = clone(B[n]); delete x.parameters.jsCode; delete y.parameters.jsCode; assert(same(x, y), `${n}: more than its code changed`); }
  assert(same(MASTER_WF.connections, PATCHED.connections));
  assert.strictEqual(PATCHED.active, false);
  const w12 = B['W12 – Prepare request'].parameters.jsCode;
  assert(w12.includes("input.urgent === true && input.audience === 'staff' && input.template === 'human_handoff_alert'"), 'the W12 bypass is limited to the urgent owner alert template');
  assert.strictEqual(w12.split('input.urgent === true').length - 1, 1, 'and it is in exactly one place');
  const twice = patch(path.join(TMP, 'urgent.json'), 'twice.json');
  assert(twice.status === 1 && /already has the urgent-alert patch/.test(twice.stderr) && !twice.exists);
  const edited = clone(MASTER_WF); const pr = edited.nodes.find((n) => n.name === 'W13 – Plan Ready'); pr.parameters.jsCode = pr.parameters.jsCode.replace('aiSendItems(plan, b.x, h)', 'aiSendItems(plan, b.x, { ...h })');
  const f = path.join(TMP, 'edited.json'); fs.writeFileSync(f, JSON.stringify(edited));
  const e = patch(f, 'edited-out.json');
  assert(e.status === 1 && !e.exists && /was found 0 times/.test(e.stderr));
});
test('U2 THE FIX: a possible emergency at 23:00 alerts the owner at once (template human_handoff_alert, URGENT), the patient is not messaged, the conversation is marked for a person; the unpatched master does NOTHING until 08:05', () => {
  const ctl = post(EMERGENCY, { w: WF_MASTER, now: NIGHT });
  clean(ctl);
  assert.deepStrictEqual([ctl.meta.calls.length, lastIn(ctl.g).AI_Status], [0, 'deferred'], 'control: the master defers an emergency to the morning run');
  assert(/staff alert not sent: guard said no: quiet hours/.test(lastIn(ctl.g).AI_Reason));
  const x = post(EMERGENCY, { now: NIGHT });
  clean(x);
  assert.deepStrictEqual(texts(x.meta), [ALERT]);
  assert.strictEqual(x.claude.calls.length, 0, 'the model is not asked');
  const m = lastIn(x.g);
  assert.deepStrictEqual([m.AI_Status, m.AI_Action, m.Needs_Human, m.Intent], ['handed_off', 'handoff', true, '']);
  assert(/\[urgent · emergency\] URGENT/.test(m.AI_Reason) && /owner is alerted now/.test(m.AI_Reason) && !/reply not sent/.test(m.AI_Reason), m.AI_Reason);
  assert.strictEqual(m.AI_Reply, '', 'no patient reply was prepared');
  const conv = rows(x.g, 'Conversations')[0];
  assert.deepStrictEqual([conv.Needs_Human, /URGENT/.test(conv.Handoff_Reason)], [true, true]);
  assert.strictEqual(rows(x.g, 'LEADS')[0].Escalated, true, 'the lead is marked escalated: W3 does not alert again');
  assert.deepStrictEqual(logs(x.g, 'W13-ai-receptionist').map((l) => l.Outcome), ['ok']);
  assert(!rows(x.g, 'Messages').some((mm) => mm.Direction === 'Out' && mm.Id !== undefined && mm.Sent_By === 'W13-ai-receptionist'), 'no patient message in the Inbox');
});
test('U3 the 08:05 morning run does not alert a second time (the message is already handed_off)', () => {
  const x = post(EMERGENCY, { now: NIGHT, id: 'wamid.U.NIGHT' });
  const before = x.meta.calls.length;
  assert.strictEqual(before, 1);
  const morning = Date.parse('2026-10-07T08:05:00+05:30');
  const r = simulate(WF, { start: 'W13 – Every Morning', items: [{ json: {} }], grist: x.g, now: morning, workflowId: 'MASTER', workflows: {}, meta: x.meta, openrouter: F.fakeOpenRouter(F.fakeClaude()), ollama: F.fakeOllama(F.fakeClaude()) });
  for (const run of allRuns(r)) assert.strictEqual(run.error, null, JSON.stringify(run.error));
  assert.strictEqual(x.meta.calls.length, before, 'no second alert, no morning message to the patient');
});
test('U4 by day nothing changes: the patient gets the holding reply AND the owner is alerted, exactly as in the unpatched master (same messages, same Grist)', () => {
  const a = post(EMERGENCY, { w: WF_MASTER, now: DAY, id: 'wamid.EQ.1' });
  const b = post(EMERGENCY, { now: DAY, id: 'wamid.EQ.1' });
  clean(b);
  assert.strictEqual(b.meta.calls.length, 2);
  assert.deepStrictEqual(b.meta.calls.map((c) => c.body), a.meta.calls.map((c) => c.body));
  assert.deepStrictEqual(b.g.docs.DOCA, a.g.docs.DOCA);
});
test('U5 only URGENT is changed: a non-emergency question and a complaint at night are still deferred to 08:05 (no patient message at night, no alert), identical to the master', () => {
  for (const text of ['How much does this cost?', 'Your service is the worst, I am very angry, I want a refund', 'hello']) {
    const a = post(text, { w: WF_MASTER, now: NIGHT, id: 'wamid.EQ.2' });
    const b = post(text, { now: NIGHT, id: 'wamid.EQ.2' });
    clean(b);
    assert.deepStrictEqual([b.meta.calls.length, lastIn(b.g).AI_Status], [0, 'deferred'], text);
    assert.deepStrictEqual(b.g.docs.DOCA, a.g.docs.DOCA, text);
  }
});
test('U6 FAILURES ARE LOGGED AS FAILURES: Meta refuses the urgent alert / Meta unreachable / no valid owner phone => Run_Log Outcome failed "URGENT ALERT NOT SENT: <why>", conversation still marked for a person', () => {
  const check = (x, re, name) => {
    clean(x);
    const l = logs(x.g, 'W13-ai-receptionist');
    assert.deepStrictEqual(l.map((q) => q.Outcome), ['failed'], name);
    assert(re.test(l[0].Error) && /^URGENT ALERT NOT SENT: /.test(l[0].Error), `${name}: ${l[0].Error}`);
    assert.deepStrictEqual([lastIn(x.g).AI_Status, rows(x.g, 'Conversations')[0].Needs_Human], ['handed_off', true], name);
  };
  check(post(EMERGENCY, { now: NIGHT, metaAnswer: () => ({ status: 400, body: { error: { code: 132001, message: 'Template name does not exist in the translation' } } }) }), /132001/, 'Meta refuses');
  check(post(EMERGENCY, { now: NIGHT, meta: Object.assign(() => { throw new Error('getaddrinfo ENOTFOUND graph.facebook.com'); }, { calls: [] }) }), /could not reach Meta/, 'Meta unreachable');
  const noOwner = post(EMERGENCY, { now: NIGHT, crm: { settings: { owner_phone: '12345' } } });
  check(noOwner, /no valid patient phone/, 'no valid owner phone');
  assert.strictEqual(noOwner.meta.calls.length, 0);
  // a normal (daytime) hand-off whose alert fails is a failure too
  const day = post('Do you accept the XYZ health insurance card?', { now: DAY, metaAnswer: (b) => (b.type === 'template' ? { status: 400, body: { error: { code: 132001, message: 'no template' } } } : null) });
  clean(day);
  assert.deepStrictEqual(logs(day.g, 'W13-ai-receptionist').map((l) => l.Outcome), ['failed']);
  assert(/^STAFF ALERT NOT SENT: /.test(logs(day.g, 'W13-ai-receptionist')[0].Error));
  // and a hand-off whose alert goes out is still ok
  const ok = post('Do you accept the XYZ health insurance card?', { now: DAY });
  assert.deepStrictEqual(logs(ok.g, 'W13-ai-receptionist').map((l) => l.Outcome), ['ok']);
});
test('U7 TEST_MODE still applies: the urgent alert goes to TEST_PHONE, never to the owner, even at night', () => {
  const x = post(EMERGENCY, { now: NIGHT, crm: { settings: { TEST_MODE: 'true' } } });
  clean(x);
  assert.deepStrictEqual(x.meta.calls.map((c) => c.body.to), [TESTP.slice(1)]);
});
test('U8 the W12 bypass is NARROW: quiet hours still block a patient message, a non-alert template, a non-urgent alert, and a forged "urgent" on anything else', () => {
  // the exact item W12 received for the urgent alert
  const base = post(EMERGENCY, { now: NIGHT });
  const w12In = base.runs.find((r) => r.visited[0] === 'W12 – When called by another workflow' && r.visited.includes('W12 – Meta send'));
  const item = clone(w12In.runData['W12 – When called by another workflow'][0].json);
  assert.deepStrictEqual([item.audience, item.template, item.urgent], ['staff', 'human_handoff_alert', true]);
  const run = (over) => {
    const meta = fakeMeta();
    const r = simulate(WF, { start: 'W12 – When called by another workflow', items: [{ json: { ...item, ...over } }], grist: crm(), now: NIGHT, workflowId: 'MASTER', workflows: {}, meta });
    assert.strictEqual(r.error, null, JSON.stringify(r.error));
    return { meta, out: r.runData['W12 – Return result'][0].json };
  };
  const sent = run({});
  assert.deepStrictEqual([sent.meta.calls.length, sent.out.sent], [1, true], 'the urgent owner alert goes');
  for (const [name, over] of [
    ['urgent flag missing', { urgent: undefined }], ['urgent but false', { urgent: false }], ['urgent as a string', { urgent: 'true' }],
    ['audience patient', { audience: 'patient' }], ['another template', { template: 'new_lead_staff_alert', template_params: { clinic_name: 'x', lead_name: 'y', lead_phone: '+919000000011', enquiry: 'z' } }],
    ['free text', { message_type: 'text', text_body: 'hello', last_inbound_at: F.sec(NIGHT) - 60, template: '' }],
  ]) {
    const x = run(over);
    assert.deepStrictEqual([x.meta.calls.length, x.out.sent, x.out.send_status, /quiet hours/.test(x.out.send_error)], [0, false, 'blocked', true], name);
  }
});
test('U9 the daytime W12 and the master\'s own guard are untouched for every other sender: W3 / W5 / W7-W10 messages at night are still held (spot check: W5 reminders)', () => {
  const tomorrow10 = F.at('2026-10-07', '10:00');
  const g = crm();
  g.docs.DOCA.Appointments.push({ id: 20, fields: { Booking_UID: 'u20', Lead: 1, Service: 'Physio', Start: tomorrow10, End: tomorrow10 + 1800, Status: 'Booked' } });
  const meta = fakeMeta();
  const r = simulate(WF, { start: 'W5 – Every 15 minutes', items: [{ json: { timestamp: 'x' } }], grist: g, now: Date.parse('2026-10-06T22:00:00+05:30'), workflowId: 'MASTER', workflows: {}, meta });
  for (const run of allRuns(r)) assert.strictEqual(run.error, null, JSON.stringify(run.error));
  assert.strictEqual(meta.calls.length, 0, 'no reminder at 22:00');
});

let failed = 0;
for (const t of suite) {
  try { t.fn(); console.log(`PASS  ${t.name}`); } catch (e) { failed++; console.log(`FAIL  ${t.name}\n      ${String(e.stack || e.message).split('\n').slice(0, 9).join('\n      ')}`); }
}
console.log(failed ? `\n${failed} of ${suite.length} URGENT ALERT CHECKS FAILED` : `\nURGENT ALERTS: ${suite.length} of ${suite.length} checks pass`);
process.exit(failed ? 1 : 0);
