// REQUEST_CONFIRM end to end on the SHIPPED workflow JSON in the simulator: staff confirm or decline an appointment request in Grist; the REQ section
// tells the patient (through W12 only), refuses a confirmation that would double-book, and never messages twice.
// Fake Grist (columns / choices validated), fake Meta. Made-up numbers only. Nothing touches the network.
// Run: node n8n/integrated/request-confirm.test.js        (CONFIRM_FILE=<file>: test another build, e.g. the combined demo workflow)
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

// ---------------------------------------------------------------- the workflow: master + request mode + this section (built here, in a temp dir)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reqconf-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const run = (script, input, name, extra = []) => {
  const out = path.join(TMP, name);
  const r = spawnSync(process.execPath, [path.join(__dirname, script), '--in', input, '--out', out, ...extra], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, out, exists: fs.existsSync(out) };
};
const MASTER_WF = JSON.parse(fs.readFileSync(MASTER, 'utf8'));
let REQ_WF;   // request mode (the AI makes requests) + the confirmation section
let SECTION_ONLY;   // master + the confirmation section alone
if (process.env.CONFIRM_FILE) { REQ_WF = JSON.parse(fs.readFileSync(process.env.CONFIRM_FILE, 'utf8')); } else {
  const a = run('apply-request-mode.js', MASTER, 'mode.json'); assert.strictEqual(a.status, 0, a.stderr);
  const b = run('apply-request-confirm.js', a.out, 'both.json'); assert.strictEqual(b.status, 0, b.stderr);
  REQ_WF = JSON.parse(fs.readFileSync(process.env.CONFIRM_MUTANT || b.out, 'utf8'));
  const c = run('apply-request-confirm.js', MASTER, 'section.json'); assert.strictEqual(c.status, 0, c.stderr);
  SECTION_ONLY = JSON.parse(fs.readFileSync(c.out, 'utf8'));
}

// ---------------------------------------------------------------- live naming and the new Grist pieces
COLUMNS.LEADS = COLUMNS.Leads.map((c) => (c === 'Lead_ID' ? 'Lead_id' : c));
for (const k of Object.keys(CHOICES)) if (k.startsWith('Leads.')) CHOICES[k.replace('Leads.', 'LEADS.')] = CHOICES[k];
for (const set of [DATETIME, TOGGLE]) for (const k of [...set]) if (k.startsWith('Leads.')) set.add(k.replace('Leads.', 'LEADS.'));
CHOICES['Messages.Status'] = [...CHOICES['Messages.Status'], 'Received'];

const PNID = '123456789012345';
const REG = 'fAft6pAYwFUU';
const P_ASHA = '919000000011', P_RAVI = '919000000015';
const OWNER = '+919000000018', TESTP = '+919000000019';
const VERIFY = 'test-verify-token-123';
const setCfg = (w, node, key, v) => { w.nodes.find((n) => n.name === node).parameters.assignments.assignments.find((a) => a.name === key).value = v; return w; };
const prepare = (base) => {
  const w = clone(base);
  setCfg(w, 'W12 – Config', 'w12_allowlist', `+${P_ASHA},+919000000012,+919000000013,+919000000014,+${P_RAVI},${OWNER},${TESTP}`);
  setCfg(w, 'W2 – Verify Config', 'meta_verify_token', VERIFY);
  return w;
};
const WF = prepare(REQ_WF);
const REQ = { booking_mode: 'request' };
class TestGrist extends FakeGrist {
  constructor(docs) { super(docs); this.count = {}; this.fail = []; this.hooks = []; }
  failAt(method, table, nth = 1) { this.fail.push({ key: `${method} ${table}`, nth }); return this; }
  hook(when, method, table, nth, fn) { this.hooks.push({ when, key: `${method} ${table}`, nth, fn }); return this; }
  handle(method, url, query, body) {
    const m = String(url).match(/\/tables\/([^/]+)\/records/);
    const key = `${method} ${m ? m[1] : ''}`;
    this.count[key] = (this.count[key] || 0) + 1;
    if (this.fail.some((x) => x.key === key && x.nth === this.count[key])) throw new Error('Grist 500: injected failure');
    for (const hk of this.hooks.filter((x) => x.when === 'before' && x.key === key && x.nth === this.count[key])) hk.fn(this);
    return super.handle(method, url, query, body);
  }
}
const SAT = F.at('2026-10-10', '17:00');
const reqRow = (id, over = {}) => ({ id, fields: { Booking_UID: `req-wamid.${id}`, Lead: 1, Service: 'Knee pain physiotherapy', Start: SAT, End: SAT + 1800, Status: 'Requested', Requested_At: F.sec(F.NOW) - 3600, ...over } });
const crm = ({ settings = {}, msgs, convs, leads, appts, kb } = {}) => new TestGrist({
  [REG]: { Clinics: [{ id: 1, fields: { Clinic_Slug: 'demo-clinic', Clinic_Name: 'Demo Physio', Grist_Doc_ID: 'DOCA', WA_Phone_Number_ID: PNID, Active: true } }] },
  DOCA: {
    Settings: F.settingsRows({ TEST_MODE: 'false', ...REQ, ...settings }), Knowledge: clone(kb || F.KNOWLEDGE), LEADS: clone(leads || F.leadRows()),
    Conversations: clone(convs || F.conversationRows()), Messages: clone(msgs || F.messageRows()), Appointments: clone(appts || F.appointmentRows()), Run_Log: [],
  },
});
const fakeMeta = (answer) => {
  const calls = [];
  const fn = (method, url, body) => { calls.push({ url, body }); const a = answer ? answer(body, calls.length) : null; return a || { status: 200, body: { messages: [{ id: `wamid.SENT.${calls.length}` }] } }; };
  fn.calls = calls;
  return fn;
};
const allRuns = (r) => [r, ...r.subRuns.flatMap(allRuns)];
const rows = (g, t) => g.docs.DOCA[t].map((x) => ({ id: x.id, ...x.fields }));
const logs = (g, w) => rows(g, 'Run_Log').filter((l) => l.Workflow === w);
const texts = (meta) => meta.calls.map((c) => (c.body.type === 'text' ? `${c.body.to}: ${c.body.text.body}` : `${c.body.to}: [${c.body.template.name}] ${(c.body.template.components || [{ parameters: [] }])[0].parameters.map((p) => p.text).join(' | ')}`));
const clean = (x) => { for (const r of x.runs) assert.strictEqual(r.error, null, `${r.visited[0]}: ${JSON.stringify(r.error)}`); };
const appt = (g, id) => rows(g, 'Appointments').find((a) => a.id === id);
const lead1 = (g) => rows(g, 'LEADS')[0];
const REQ_LOG = 'REQ-request-confirm';
function tick(g, now, o = {}) {
  const meta = o.meta || fakeMeta(o.metaAnswer);
  const r = simulate(o.w || WF, { start: 'REQ – Every 2 minutes', items: [{ json: {} }], grist: g, now, workflowId: 'MASTER', workflows: {}, meta });
  return { g, meta, r, runs: allRuns(r), visited: new Set(allRuns(r).flatMap((x) => x.visited)) };
}
const T0 = F.NOW;   // Tue 06 Oct 11:00 IST; Asha wrote 5 days ago in the fixtures
const recent = (sec) => [{ id: 1, fields: { Lead: 1, Phone: F.ASHA, Last_Inbound_At: sec, Unread: 0, Automation_Paused: false } }];   // a conversation whose last patient message was at `sec`
const IN_WINDOW = recent(F.sec(T0) - 600);

console.log(`Request confirmation on: ${process.env.CONFIRM_FILE ? path.basename(process.env.CONFIRM_FILE) : 'master + apply-request-mode.js + apply-request-confirm.js'}`);

// ================================================================ the patch
test('C1 the patch ADDS 26 nodes and changes nothing: every existing node, connection, credential and webhook identical; one new schedule trigger; W12 stays the only sender', () => {
  // (also on the file under test, which a mutation test may have broken)
  const callNode = REQ_WF.nodes.find((n) => n.name === "REQ – Call 'W12 - WhatsApp send'");
  assert.strictEqual(callNode.parameters.workflowId.value, '={{ $workflow.id }}', 'the patient is told through W12 (this workflow)');
  assert(REQ_WF.nodes.filter((n) => /^REQ – /.test(n.name) && /graph\.facebook\.com/.test(JSON.stringify(n.parameters))).length === 0, 'no REQ node talks to Meta');
  if (process.env.CONFIRM_FILE) return;
  const A = Object.fromEntries(MASTER_WF.nodes.map((n) => [n.name, n]));
  const B = Object.fromEntries(SECTION_ONLY.nodes.map((n) => [n.name, n]));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  assert.deepStrictEqual(Object.keys(A).filter((n) => !same(A[n], B[n])), [], 'no existing node changed');
  const added = Object.keys(B).filter((n) => !A[n]);
  assert.strictEqual(added.length, 26);
  assert(added.every((n) => /^REQ – |^Section REQUEST_CONFIRM$/.test(n)));
  for (const k of Object.keys(MASTER_WF.connections)) assert(same(MASTER_WF.connections[k], SECTION_ONLY.connections[k]), `connection ${k}`);
  assert(Object.keys(SECTION_ONLY.connections).filter((k) => !MASTER_WF.connections[k]).every((k) => /^REQ – /.test(k)));
  const newNodes = SECTION_ONLY.nodes.filter((n) => !A[n.name]);
  assert.deepStrictEqual(newNodes.filter((n) => /Trigger|webhook/i.test(n.type)).map((n) => `${n.name} ${n.parameters.rule.interval[0].expression}`), ['REQ – Every 2 minutes */2 * * * *']);
  const credsUsed = new Set(newNodes.filter((n) => n.credentials).map((n) => JSON.stringify(n.credentials)));
  assert.strictEqual(credsUsed.size, 1);
  assert(MASTER_WF.nodes.some((n) => JSON.stringify(n.credentials) === [...credsUsed][0]), 'the one credential is one the master already uses');
  assert.deepStrictEqual(newNodes.filter((n) => /graph\.facebook\.com/.test(JSON.stringify(n.parameters))).map((n) => n.name), [], 'no REQ node talks to Meta');
  const calls = newNodes.filter((n) => n.type === 'n8n-nodes-base.executeWorkflow');
  assert.deepStrictEqual(calls.map((n) => [n.name, n.parameters.workflowId.value]), [["REQ – Call 'W12 - WhatsApp send'", '={{ $workflow.id }}']]);
  assert.deepStrictEqual(newNodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest').filter((n) => !/\/api\/docs\//.test(n.parameters.url)).map((n) => n.name), [], 'the only HTTP nodes are Grist calls');
  assert.strictEqual(SECTION_ONLY.active, false);
  const twice = run('apply-request-confirm.js', path.join(TMP, 'section.json'), 'twice.json');
  assert(twice.status === 1 && /already has REQ nodes/.test(twice.stderr) && !twice.exists);
});

// ================================================================ confirmed
test('C2 staff set a request to Booked: the patient is told (free text, she wrote 10 minutes ago), Confirm_Sent is set FIRST, the lead becomes Booked, Run_Log ok; the next run does nothing', () => {
  const g = crm({ appts: [...F.appointmentRows(), reqRow(10, { Status: 'Booked' })], convs: IN_WINDOW });
  let writesBeforeSend = null;
  const x = tick(g, T0, { metaAnswer: () => { writesBeforeSend = g.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.table}`); return null; } });
  clean(x);
  assert.deepStrictEqual(texts(x.meta), [`${P_ASHA}: Hi Asha, good news: your Knee pain physiotherapy at Demo Physio is confirmed for 10 Oct at 5:00 PM. Reply here if you need to change it.`]);
  assert.strictEqual(appt(g, 10).Confirm_Sent, F.sec(T0));
  assert.strictEqual(appt(g, 10).Status, 'Booked');
  assert.strictEqual(lead1(g).Status, 'Booked');
  assert.deepStrictEqual(logs(g, REQ_LOG).map((l) => [l.Record, l.Outcome, l.Error]), [['req-wamid.10 confirmed L-20261001-0001', 'ok', '']]);
  assert.deepStrictEqual(writesBeforeSend, ['PATCH Appointments'], 'the claim (Confirm_Sent) is the ONLY write made before the message goes out');
  const y = tick(g, T0 + 120000);
  clean(y);
  assert.deepStrictEqual([y.meta.calls.length, logs(g, REQ_LOG).length], [0, 1], 'announced once');
  // the message is in the Inbox too (W12 logs what it sent)
  assert(rows(g, 'Messages').some((m) => m.Direction === 'Out' && /is confirmed for 10 Oct at 5:00 PM/.test(m.Body) && /^W12-request-confirm/.test(m.Sent_By)), 'the Inbox shows the confirmation, sent by W12-request-confirm');
});
test('C3 the patient wrote more than 24 h ago: the approved booking_confirmation template (name, service, clinic, date, time) is used', () => {
  const g = crm({ appts: [...F.appointmentRows(), reqRow(10, { Status: 'Booked' })] });   // fixture: Asha's last message was 5 days ago
  const x = tick(g, T0);
  clean(x);
  assert.deepStrictEqual(texts(x.meta), [`${P_ASHA}: [booking_confirmation] Asha | Knee pain physiotherapy | Demo Physio | 10 Oct | 5:00 PM`]);
  assert.strictEqual(logs(g, REQ_LOG)[0].Outcome, 'ok');
  assert.strictEqual(lead1(g).Status, 'Booked');
});
test('C4 a lead that is already Booked / Converted keeps its status (never downgraded); a Lost or New lead becomes Booked', () => {
  for (const [status, want] of [['Converted', 'Converted'], ['Booked', 'Booked'], ['Lost', 'Booked'], ['New', 'Booked'], ['Contacted', 'Booked']]) {
    const leads = F.leadRows(); leads[0].fields.Status = status;
    const g = crm({ leads, appts: [...F.appointmentRows(), reqRow(10, { Status: 'Booked' })], convs: IN_WINDOW });
    tick(g, T0);
    assert.strictEqual(lead1(g).Status, want, status);
  }
});

// ================================================================ declined
test('C5 Declined: the patient is told (text), Confirm_Sent is set, the lead is NOT marked Booked; once; outside the 24 h window W12 refuses and Run_Log says so (one attempt, no retry)', () => {
  let g = crm({ appts: [...F.appointmentRows(), reqRow(10, { Status: 'Declined' })], convs: IN_WINDOW });
  let x = tick(g, T0);
  clean(x);
  assert(/^919000000011: Hi Asha, sorry, we could not confirm your request for 10 Oct at 5:00 PM at Demo Physio\. Please reply with another time/.test(texts(x.meta)[0]));
  assert.deepStrictEqual([appt(g, 10).Status, appt(g, 10).Confirm_Sent > 0, lead1(g).Status], ['Declined', true, 'Contacted']);
  assert.deepStrictEqual(logs(g, REQ_LOG).map((l) => [l.Record, l.Outcome]), [['req-wamid.10 declined L-20261001-0001', 'ok']]);
  assert.strictEqual(tick(g, T0 + 120000).meta.calls.length, 0);
  g = crm({ appts: [...F.appointmentRows(), reqRow(10, { Status: 'Declined' })] });   // last message 5 days ago
  x = tick(g, T0);
  clean(x);
  assert.strictEqual(x.meta.calls.length, 0, 'no template exists for a decline: nothing is sent');
  assert.deepStrictEqual(logs(g, REQ_LOG).map((l) => [l.Outcome, /24-hour WhatsApp window/.test(l.Error)]), [['failed', true]]);
  assert(appt(g, 10).Confirm_Sent > 0);
  assert.strictEqual(tick(g, T0 + 120000).meta.calls.length, 0);
  assert.strictEqual(logs(g, REQ_LOG).length, 1, 'one attempt only');
});

// ================================================================ no double booking
test('C6 staff confirm a request over a slot that is already taken (a Cal.com booking): REFUSED - no message, the row goes back to Requested, Run_Log failed says why; the next run does nothing', () => {
  const taken = { id: 3, fields: { Booking_UID: 'cal-uid-other', Lead: 2, Start: SAT, End: SAT + 1800, Status: 'Booked' } };
  const g = crm({ appts: [...F.appointmentRows(), taken, reqRow(10, { Status: 'Booked' })], convs: IN_WINDOW });
  const x = tick(g, T0);
  clean(x);
  assert.strictEqual(x.meta.calls.length, 0, 'the patient is not told it is confirmed');
  assert.deepStrictEqual([appt(g, 10).Status, appt(g, 10).Confirm_Sent, lead1(g).Status], ['Requested', undefined, 'Contacted']);
  assert.deepStrictEqual(logs(g, REQ_LOG).map((l) => [l.Outcome, l.Error]), [['failed', 'double booking prevented: 10 Oct at 5:00 PM is already taken by cal-uid-other; the request is back to Requested']]);
  const y = tick(g, T0 + 120000);
  assert.deepStrictEqual([y.meta.calls.length, logs(g, REQ_LOG).length], [0, 1]);
});
test('C7 two requests for one slot both set to Booked: the LOWEST row id is confirmed and announced, the other is refused and goes back to Requested; capacity 2 confirms both', () => {
  const mk = (settings) => crm({ settings, leads: F.leadRows(), appts: [...F.appointmentRows(), reqRow(10, { Status: 'Booked' }), reqRow(11, { Lead: 3, Status: 'Booked' })], convs: [...IN_WINDOW, { id: 2, fields: { Lead: 3, Phone: '+919000000015', Last_Inbound_At: F.sec(T0) - 300, Unread: 0, Automation_Paused: false } }] });
  let g = mk({});
  let x = tick(g, T0);
  clean(x);
  assert.deepStrictEqual([appt(g, 10).Status, appt(g, 11).Status, appt(g, 10).Confirm_Sent > 0, appt(g, 11).Confirm_Sent], ['Booked', 'Requested', true, undefined]);
  assert.deepStrictEqual(texts(x.meta).map((t) => t.split(':')[0]), [P_ASHA]);
  assert(logs(g, REQ_LOG).some((l) => l.Outcome === 'failed' && /req-wamid\.11 conflict/.test(l.Record) && /already taken by req-wamid\.10/.test(l.Error)));
  g = mk({ booking_capacity: '2' });
  x = tick(g, T0);
  clean(x);
  assert.deepStrictEqual([appt(g, 10).Status, appt(g, 11).Status, x.meta.calls.length], ['Booked', 'Booked', 2]);
});
test('C8 a request confirmed for a slot that a Cal.com booking took AFTER the patient asked: refused the same way (the check is made at confirmation time)', () => {
  const g = crm({ appts: [...F.appointmentRows(), reqRow(10)], convs: IN_WINDOW });
  assert.strictEqual(tick(g, T0).meta.calls.length, 0, 'while Requested nothing happens');
  g.docs.DOCA.Appointments.push({ id: 50, fields: { Booking_UID: 'cal-uid-late', Lead: 2, Start: SAT, End: SAT + 1800, Status: 'Booked' } });   // W4 writes the Cal.com booking
  appt(g, 10); g.docs.DOCA.Appointments.find((a) => a.id === 10).fields.Status = 'Booked';       // staff click Booked
  const x = tick(g, T0 + 600000);
  assert.deepStrictEqual([x.meta.calls.length, appt(g, 10).Status], [0, 'Requested']);
});

// ================================================================ the guards
test('C9 guards: Opted_Out = never messaged; quiet hours = waits (nothing claimed) and goes at 08:00; TEST_MODE = to TEST_PHONE; a paused chat does not block; no valid phone = never', () => {
  const base = () => [...F.appointmentRows(), reqRow(10, { Status: 'Booked' })];
  // opted out
  const leads = F.leadRows(); leads[0].fields.Opted_Out = true;
  let g = crm({ leads, appts: base(), convs: IN_WINDOW });
  let x = tick(g, T0);
  assert.deepStrictEqual([x.meta.calls.length, appt(g, 10).Confirm_Sent, logs(g, REQ_LOG).length], [0, undefined, 0]);
  // night: the claim is NOT written, so the morning run still sends
  const night = Date.parse('2026-10-06T23:00:00+05:30');
  g = crm({ appts: base(), convs: recent(F.sec(night) - 600) });
  x = tick(g, night);
  assert.deepStrictEqual([x.meta.calls.length, appt(g, 10).Confirm_Sent], [0, undefined]);
  const morning = Date.parse('2026-10-07T08:10:00+05:30');
  g.docs.DOCA.Conversations[0].fields.Last_Inbound_At = F.sec(morning) - 600;
  x = tick(g, morning);
  clean(x);
  assert.deepStrictEqual([x.meta.calls.length, appt(g, 10).Confirm_Sent > 0], [1, true]);
  // TEST_MODE
  g = crm({ settings: { TEST_MODE: 'true' }, appts: base(), convs: IN_WINDOW });
  x = tick(g, T0);
  assert.deepStrictEqual(x.meta.calls.map((c) => c.body.to), [TESTP.slice(1)]);
  assert(/\(TEST_MODE\)/.test(logs(g, REQ_LOG)[0].Record));
  // paused conversation: a confirmation of the patient's own request still goes
  const paused = IN_WINDOW; paused[0].fields.Automation_Paused = true;
  g = crm({ appts: base(), convs: paused });
  assert.strictEqual(tick(g, T0).meta.calls.length, 1);
  // no valid phone
  const noPhone = F.leadRows(); noPhone[0].fields.Phone = '12345';
  g = crm({ leads: noPhone, appts: base(), convs: IN_WINDOW });
  x = tick(g, T0);
  assert.deepStrictEqual([x.meta.calls.length, appt(g, 10).Confirm_Sent], [0, undefined]);
});
test('C10 only request-mode clinics, only req- rows: Cal.com / WhatsApp bookings and a clinic without booking_mode = request are never touched', () => {
  const cal = { id: 3, fields: { Booking_UID: 'cal-uid-1', Lead: 1, Start: SAT + 86400, End: SAT + 86400 + 1800, Status: 'Booked' } };
  const wa = { id: 4, fields: { Booking_UID: 'wa-wamid.9', Lead: 1, Start: SAT + 2 * 86400, End: SAT + 2 * 86400 + 1800, Status: 'Booked' } };
  const declinedOther = { id: 5, fields: { Booking_UID: 'cal-uid-2', Lead: 1, Start: SAT + 3 * 86400, End: SAT + 3 * 86400 + 1800, Status: 'Declined' } };
  let g = crm({ appts: [...F.appointmentRows(), cal, wa, declinedOther], convs: IN_WINDOW });
  let x = tick(g, T0);
  clean(x);
  assert.deepStrictEqual([x.meta.calls.length, g.calls.filter((c) => c.method !== 'GET').length], [0, 0]);
  g = crm({ settings: { booking_mode: 'direct' }, appts: [...F.appointmentRows(), reqRow(10, { Status: 'Booked' })], convs: IN_WINDOW });
  x = tick(g, T0);
  assert.deepStrictEqual([x.meta.calls.length, g.calls.filter((c) => c.method !== 'GET').length], [0, 0], 'booking_mode direct: nothing');
  g = crm({ settings: { booking_mode: undefined }, appts: [...F.appointmentRows(), reqRow(10, { Status: 'Booked' })], convs: IN_WINDOW });
  assert.strictEqual(tick(g, T0).meta.calls.length, 0, 'no booking_mode: nothing');
});

// ================================================================ failures
test('C11 failures: the claim write fails = nothing is sent (never a message without its flag); Meta refuses = Run_Log failed, the flag stays set, no retry storm; Meta unreachable = same', () => {
  const base = () => [...F.appointmentRows(), reqRow(10, { Status: 'Booked' })];
  let g = crm({ appts: base(), convs: IN_WINDOW }).failAt('PATCH', 'Appointments', 1);
  let x = tick(g, T0);
  assert.deepStrictEqual([x.meta.calls.length, appt(g, 10).Confirm_Sent, x.r.error && x.r.error.node], [0, undefined, 'REQ – Claim Confirm_Sent']);
  g = crm({ appts: base(), convs: IN_WINDOW });
  x = tick(g, T0, { metaAnswer: () => ({ status: 400, body: { error: { code: 131047, message: 'Re-engagement message' } } }) });
  clean(x);
  assert.deepStrictEqual([x.meta.calls.length, appt(g, 10).Confirm_Sent > 0, logs(g, REQ_LOG).map((l) => l.Outcome)], [1, true, ['failed']]);
  assert(/131047/.test(logs(g, REQ_LOG)[0].Error));
  assert.strictEqual(tick(g, T0 + 120000).meta.calls.length, 0, 'not retried');
  g = crm({ appts: base(), convs: IN_WINDOW });
  x = tick(g, T0, { meta: Object.assign(() => { throw new Error('getaddrinfo ENOTFOUND graph.facebook.com'); }, { calls: [] }) });
  assert.deepStrictEqual([logs(g, REQ_LOG).map((l) => l.Outcome), appt(g, 10).Confirm_Sent > 0], [['failed'], true]);
  // a refusal that cannot be written back: the Run_Log says so and tells staff to fix the Status
  const taken = { id: 3, fields: { Booking_UID: 'cal-uid-other', Lead: 2, Start: SAT, End: SAT + 1800, Status: 'Booked' } };
  g = crm({ appts: [...F.appointmentRows(), taken, reqRow(10, { Status: 'Booked' })], convs: IN_WINDOW }).failAt('PATCH', 'Appointments', 1);
  x = tick(g, T0);
  assert.strictEqual(x.meta.calls.length, 0);
  assert(/putting it back FAILED/.test(logs(g, REQ_LOG)[0].Error), logs(g, REQ_LOG)[0].Error);
});
test('C12 only W12 sends: every Meta call comes from a W12 run started by a REQ node; 3 requests in one run = 3 messages, each once', () => {
  const appts = [...F.appointmentRows(), reqRow(10, { Status: 'Booked' }), reqRow(11, { Status: 'Declined', Start: SAT + 86400, End: SAT + 86400 + 1800 }), reqRow(12, { Status: 'Booked', Start: SAT + 2 * 86400, End: SAT + 2 * 86400 + 1800 })];
  const g = crm({ appts, convs: IN_WINDOW });
  const x = tick(g, T0);
  clean(x);
  assert.strictEqual(x.meta.calls.length, 3);
  const metaRuns = x.runs.filter((r) => r.visited.includes('W12 – Meta send'));
  assert.strictEqual(metaRuns.length, 3);
  for (const r of metaRuns) assert.strictEqual(r.visited[0], 'W12 – When called by another workflow');
  assert.deepStrictEqual(logs(g, REQ_LOG).map((l) => l.Outcome), ['ok', 'ok', 'ok']);
  assert.strictEqual(tick(g, T0 + 120000).meta.calls.length, 0);
});

// ================================================================ the whole life of a request
test('C13 LIFECYCLE: the patient asks (W2 -> W13) -> a Requested row, NOT confirmed, no reminder -> staff confirm -> REQ tells her once -> W5 reminds 24 h before (once)', () => {
  const g = crm();
  const metaBody = (text, id, ts) => ({ object: 'whatsapp_business_account', entry: [{ id: 'TEST_WABA_ID', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: PNID }, contacts: [{ profile: { name: 'Asha Patel' }, wa_id: P_ASHA }], messages: [{ from: P_ASHA, id, timestamp: String(ts), type: 'text', text: { body: text } }] } }] }] });
  const meta = fakeMeta();
  const claude = F.fakeClaude();
  const ask = simulate(WF, { start: 'W2 – Webhook Inbound', items: [{ json: { headers: {}, params: {}, query: {}, body: metaBody('Book me for Saturday at 5.', 'wamid.LIFE.1', F.sec(T0) - 5) } }], grist: g, now: T0, workflowId: 'MASTER', workflows: {}, meta, openrouter: F.fakeOpenRouter(claude), ollama: F.fakeOllama(claude) });
  for (const r of allRuns(ask)) assert.strictEqual(r.error, null, JSON.stringify(r.error));
  assert.deepStrictEqual(rows(g, 'Appointments').filter((a) => a.Status === 'Requested').map((a) => [a.Booking_UID, a.Start]), [['req-wamid.LIFE.1', SAT]]);
  assert(/NOT confirmed yet/.test(texts(meta)[0]));
  const id = rows(g, 'Appointments').find((a) => a.Booking_UID === 'req-wamid.LIFE.1').id;
  // before staff act: the REQ section and W5 do nothing
  const t1 = T0 + 3600000;
  assert.strictEqual(tick(g, t1, { meta }).meta.calls.length, 1, 'REQ: no new message');
  const w5 = (now) => simulate(WF, { start: 'W5 – Every 15 minutes', items: [{ json: { timestamp: 'x' } }], grist: g, now, workflowId: 'MASTER', workflows: {}, meta });
  // 23 h before Saturday 17:00 = Friday 18:00
  const fri = Date.parse('2026-10-09T18:00:00+05:30');
  const before = meta.calls.length;
  w5(fri);
  assert.strictEqual(meta.calls.length, before, 'W5: a Requested appointment gets no reminder');
  // staff confirm on Wednesday morning
  const wed = Date.parse('2026-10-07T10:00:00+05:30');
  g.docs.DOCA.Appointments.find((a) => a.id === id).fields.Status = 'Booked';
  g.docs.DOCA.Conversations[0].fields.Last_Inbound_At = F.sec(wed) - 600;
  const c = tick(g, wed, { meta });
  clean(c);
  assert.strictEqual(meta.calls.length, before + 1);
  assert(/is confirmed for 10 Oct at 5:00 PM/.test(texts(meta).pop()));
  assert.strictEqual(tick(g, wed + 120000, { meta }).meta.calls.length, before + 1, 'REQ: once');
  // now it is a real appointment: W5 reminds, once
  const r1 = w5(fri);
  for (const r of allRuns(r1)) assert.strictEqual(r.error, null, JSON.stringify(r.error));
  assert.strictEqual(meta.calls.length, before + 2, 'W5: the confirmed appointment gets its 24 h reminder');
  w5(fri + 900000);
  assert.strictEqual(meta.calls.length, before + 2, 'W5: once');
  assert(appt(g, id).R24_Sent > 0);
});

// ================================================================ run
let failed = 0;
for (const t of suite) {
  try { t.fn(); console.log(`PASS  ${t.name}`); } catch (e) { failed++; console.log(`FAIL  ${t.name}\n      ${String(e.stack || e.message).split('\n').slice(0, 9).join('\n      ')}`); }
}
console.log(failed ? `\n${failed} of ${suite.length} REQUEST CONFIRMATION CHECKS FAILED` : `\nREQUEST CONFIRMATION: ${suite.length} of ${suite.length} checks pass`);
process.exit(failed ? 1 : 0);
