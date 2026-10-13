// REQUEST MODE end to end on the SHIPPED workflow JSON in the simulator: the AI creates appointment REQUESTS (Status Requested), never confirmed bookings.
//   Meta webhook -> W2 -> W13 (request-mode patch) -> W12 -> fake Meta; plus W5 (reminders) and the other readers of Appointments.
// Fake Grist (columns / choices validated like Grist does), fake Meta, fake OpenRouter / Ollama. Made-up numbers only. Nothing touches the network.
// Run: node n8n/integrated/request-mode.test.js        (REQUEST_FILE=<file>: test another build, e.g. the combined demo workflow)
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

// ---------------------------------------------------------------- the patched workflow (built here from the master, in a temp dir)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reqmode-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const patch = (input, name) => {
  const out = path.join(TMP, name);
  const r = spawnSync(process.execPath, [path.join(__dirname, 'apply-request-mode.js'), '--in', input, '--out', out], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, out, exists: fs.existsSync(out) };
};
const MASTER_WF = JSON.parse(fs.readFileSync(MASTER, 'utf8'));
let PATCHED_WF;
if (process.env.REQUEST_FILE) PATCHED_WF = JSON.parse(fs.readFileSync(process.env.REQUEST_FILE, 'utf8'));
else { const a = patch(MASTER, 'patched.json'); assert.strictEqual(a.status, 0, a.stderr); PATCHED_WF = JSON.parse(fs.readFileSync(process.env.REQUEST_MUTANT || a.out, 'utf8')); }

// ---------------------------------------------------------------- live naming and the new Grist pieces (Status choices, Requested_At)
COLUMNS.LEADS = COLUMNS.Leads.map((c) => (c === 'Lead_ID' ? 'Lead_id' : c));
for (const k of Object.keys(CHOICES)) if (k.startsWith('Leads.')) CHOICES[k.replace('Leads.', 'LEADS.')] = CHOICES[k];
for (const set of [DATETIME, TOGGLE]) for (const k of [...set]) if (k.startsWith('Leads.')) set.add(k.replace('Leads.', 'LEADS.'));
CHOICES['Messages.Status'] = [...CHOICES['Messages.Status'], 'Received'];
assert(CHOICES['Appointments.Status'].includes('Requested') && COLUMNS.Appointments.includes('Requested_At'), 'the simulator knows the request-mode Grist additions');

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
const WF = prepare(PATCHED_WF);
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
const crm = ({ settings = {}, msgs, convs, leads, appts, kb } = {}) => new TestGrist({
  [REG]: { Clinics: [{ id: 1, fields: { Clinic_Slug: 'demo-clinic', Clinic_Name: 'Demo Physio', Grist_Doc_ID: 'DOCA', WA_Phone_Number_ID: PNID, Active: true } }] },
  DOCA: {
    Settings: F.settingsRows({ TEST_MODE: 'false', ...settings }), Knowledge: clone(kb || F.KNOWLEDGE), LEADS: clone(leads || F.leadRows()),
    Conversations: clone(convs || F.conversationRows()), Messages: clone(msgs || F.messageRows()), Appointments: clone(appts || F.appointmentRows()), Run_Log: [],
  },
});
const fakeMeta = (answer) => {
  const calls = [];
  const fn = (method, url, body) => { calls.push({ url, body }); const a = answer ? answer(body, calls.length) : null; return a || { status: 200, body: { messages: [{ id: `wamid.SENT.${calls.length}` }] } }; };
  fn.calls = calls;
  return fn;
};
const metaBody = (from, id, text, { ts = F.sec(F.NOW) - 5 } = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'TEST_WABA_ID', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: PNID },
    contacts: [{ profile: { name: 'Asha Patel' }, wa_id: from }],
    messages: [{ from, id, timestamp: String(ts), type: 'text', text: { body: text } }],
  } }] }],
});
const allRuns = (r) => [r, ...r.subRuns.flatMap(allRuns)];
function post(text, o = {}) {
  const g = o.g || crm(o.crm);
  const meta = o.meta || fakeMeta(o.metaAnswer);
  const claude = o.claude || F.fakeClaude(o.ai);
  const body = metaBody(o.from || P_ASHA, o.id || `wamid.IN.${Math.random().toString(36).slice(2, 8)}`, text, o);
  const r = simulate(o.w || WF, { start: 'W2 – Webhook Inbound', items: [{ json: { headers: {}, params: {}, query: {}, body } }], grist: g, now: o.now || F.NOW, workflowId: 'MASTER', workflows: {}, meta, openrouter: F.fakeOpenRouter(claude), ollama: F.fakeOllama(claude) });
  const runs = allRuns(r);
  const aiJobs = runs.filter((x) => x.visited[0] === 'W12 – When called by another workflow' && x.visited.includes('W13 – Config'));
  return { g, meta, claude, r, runs, aiJobs };
}
const rows = (g, t) => g.docs.DOCA[t].map((x) => ({ id: x.id, ...x.fields }));
const lastIn = (g) => rows(g, 'Messages').filter((m) => m.Direction === 'In').pop();
const logs = (g, w) => rows(g, 'Run_Log').filter((l) => l.Workflow === w);
const texts = (meta) => meta.calls.map((c) => (c.body.type === 'text' ? `${c.body.to}: ${c.body.text.body}` : `${c.body.to}: [${c.body.template.name}] ${(c.body.template.components || [{ parameters: [] }])[0].parameters.map((p) => p.text).join(' | ')}`));
const clean = (x) => { for (const run of x.runs) assert.strictEqual(run.error, null, `${run.visited[0]}: ${JSON.stringify(run.error)}`); };
const requests = (g) => rows(g, 'Appointments').filter((a) => a.Status === 'Requested');
const SAT_5PM = F.at('2026-10-10', '17:00');
const dec = (over) => () => ({ ...F.BASE_DECISION, lead_summary: 'test', ...over });
const BOOK_SAT = 'Book me for Saturday at 5.';

console.log(`Request mode on: ${process.env.REQUEST_FILE ? path.basename(process.env.REQUEST_FILE) : 'master + apply-request-mode.js'}`);

// ================================================================ the patch itself
test('R1 the patch changes only W13 – Appointments (filter), W13 – Build Context, W13 – Plan and one line of W9 – Metrics; nothing else, no wiring, no credential', () => {
  if (process.env.REQUEST_FILE) return;
  const A = Object.fromEntries(MASTER_WF.nodes.map((n) => [n.name, n]));
  const B = Object.fromEntries(PATCHED_WF.nodes.map((n) => [n.name, n]));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  assert.deepStrictEqual(Object.keys(A).filter((n) => !B[n]), []);
  assert.deepStrictEqual(Object.keys(B).filter((n) => !A[n]), ['W13 – Request Mode Read Me']);
  assert.deepStrictEqual(Object.keys(A).filter((n) => !same(A[n], B[n])).sort(), ['W13 – Appointments', 'W13 – Build Context', 'W13 – Plan', 'W9 – Metrics']);
  const m9a = A['W9 – Metrics'].parameters.jsCode; const m9b = B['W9 – Metrics'].parameters.jsCode;
  assert.strictEqual(m9b.replace(/      this_week: count\(week, \(a\) => a\.Status !== 'Requested' && a\.Status !== 'Declined'\),[^\n]*\n/, '      this_week: week.length,\n'), m9a, 'W9 – Metrics differs only by the this_week line');
  assert(same(MASTER_WF.connections, PATCHED_WF.connections), 'connections are identical');
  for (const n of Object.keys(A)) assert.deepStrictEqual(B[n].credentials, A[n].credentials, n);
  const x = JSON.parse(JSON.stringify(A['W13 – Appointments'])); const y = JSON.parse(JSON.stringify(B['W13 – Appointments']));
  assert.strictEqual(x.parameters.queryParameters.parameters[0].value, '={{ JSON.stringify({ Status: ["Booked"] }) }}');
  assert.strictEqual(y.parameters.queryParameters.parameters[0].value, '={{ JSON.stringify({ Status: ["Booked", "Requested"] }) }}');
  x.parameters.queryParameters.parameters[0].value = y.parameters.queryParameters.parameters[0].value;
  assert(same(x, y), 'only the filter value changed in W13 – Appointments');
  for (const n of ['W13 – Build Context', 'W13 – Plan']) assert(B[n].parameters.jsCode.includes('// ---- pasted from n8n/snippets/ai-request-mode.js - keep identical ----'));
  // the W5 / W6 / W7 / W8 / W9 readers are byte-identical: they still read Booked / Completed / No-show only
  for (const n of Object.keys(A).filter((k) => /^W[3-9] – |^W10 – /.test(k) && k !== 'W9 – Metrics')) assert(same(A[n], B[n]), n);
  assert.strictEqual(PATCHED_WF.active, false);
});
test('R2 the patcher refuses an edited node or a second run, and writes nothing', () => {
  if (process.env.REQUEST_FILE) return;
  const twice = patch(path.join(TMP, 'patched.json'), 'twice.json');
  assert(twice.status === 1 && /already has request mode/.test(twice.stderr) && !twice.exists);
  for (const [name, edit] of [
    ['W13 – Plan', (n) => { n.parameters.jsCode = n.parameters.jsCode.replace('decided_at: Date.now(),', 'decided_at: Date.now() + 1,'); }],
    ['W13 – Build Context', (n) => { n.parameters.jsCode = n.parameters.jsCode.replace('const t0 = Date.now();', 'const t0 = Date.now() - 1;'); }],
    ['W13 – Appointments', (n) => { n.parameters.queryParameters.parameters[0].value = '={{ JSON.stringify({ Status: ["Booked", "Completed"] }) }}'; }],
  ]) {
    const w = clone(MASTER_WF); edit(w.nodes.find((n) => n.name === name));
    const f = path.join(TMP, `edited-${name.replace(/\W+/g, '')}.json`); fs.writeFileSync(f, JSON.stringify(w));
    const r = patch(f, `out-${name.replace(/\W+/g, '')}.json`);
    assert(r.status === 1 && !r.exists, `${name}: refused`);
  }
});

// ================================================================ a request, not a booking
test('R3 "Book me for Saturday at 5." (booking_mode = request): ONE Requested row, the lead is not Booked, the patient is told it is NOT confirmed; nothing Booked is written', () => {
  const x = post(BOOK_SAT, { crm: { settings: REQ }, id: 'wamid.REQ.1' });
  clean(x);
  assert.deepStrictEqual(rows(x.g, 'Appointments').length, 5);
  const r = requests(x.g);
  assert.deepStrictEqual(r, [{ id: 5, Booking_UID: 'req-wamid.REQ.1', Lead: 1, Service: 'Appointment', Start: SAT_5PM, End: SAT_5PM + 1800, Status: 'Requested', Requested_At: F.sec(F.NOW) }]);
  assert.deepStrictEqual(texts(x.meta), [`${P_ASHA}: Thank you! We have noted your request for Sat 10 Oct at 5:00 PM. It is NOT confirmed yet: our team will check and confirm with you shortly.`]);
  const lead = rows(x.g, 'LEADS')[0];
  assert.strictEqual(lead.Status, 'Contacted', 'answered, but not Booked');
  const m = lastIn(x.g);
  assert.deepStrictEqual([m.AI_Status, m.AI_Action, m.Intent], ['replied', 'book_slot', 'book_appointment']);
  assert(/appointment REQUEST created/.test(m.AI_Reason));
  const bookedWrites = x.g.calls.filter((c) => c.method !== 'GET' && /Appointments/.test(c.url) && JSON.stringify(c.body).includes('"Booked"'));
  assert.deepStrictEqual(bookedWrites, [], 'no write of Status Booked anywhere');
  // the prompt the model saw
  const sys = x.claude.calls[0].body.system.map((b) => b.text).join('\n');
  assert(sys.includes('REQUEST MODE (this clinic)') && sys.includes('PENDING REQUESTS (this patient; waiting for staff; NOT booked)'));
});
test('R4 the model cannot book even if it tries: "booked and confirmed!" replies, 0.99 confidence, a link reply: still one Requested row and the fixed reply', () => {
  for (const ai of [dec({ intent: 'book_appointment', action: 'book_slot', booking: { date: '2026-10-10', time: '17:00', time_window: null }, confidence: 0.99, reply: 'You are booked and confirmed for Saturday 5 PM.' }),
    dec({ intent: 'book_appointment', action: 'book_slot', booking: { date: '2026-10-10', time: '17:00', time_window: null }, reply: 'Please confirm here: {{BOOKING_LINK}}' })]) {
    const x = post(BOOK_SAT, { crm: { settings: REQ }, ai });
    clean(x);
    assert.deepStrictEqual(requests(x.g).map((r) => r.Start), [SAT_5PM]);
    assert.strictEqual(rows(x.g, 'Appointments').filter((a) => a.Status === 'Booked').length, 3, 'only the 3 fixture bookings are Booked');
    assert(/^919000000011: Thank you! We have noted your request for Sat 10 Oct at 5:00 PM\. It is NOT confirmed yet/.test(texts(x.meta)[0]) && !/https:/.test(texts(x.meta)[0]), texts(x.meta)[0]);
  }
});
test('R5 every other clinic is untouched: booking_mode link / direct / unset give EXACTLY the same replies and Grist as the unpatched master', () => {
  const MASTER_PREPARED = prepare(MASTER_WF);
  const cases = [
    [BOOK_SAT, {}], [BOOK_SAT, { settings: { booking_mode: 'link' } }], [BOOK_SAT, { settings: { booking_mode: 'direct' } }],
    ['Can I come tomorrow evening?', {}], ['How much does this cost?', {}], ['Cancel my appointment tomorrow.', {}], ['Do you accept the XYZ health insurance card?', {}],
    ['I have chest pain, book me an appointment', {}], ['Book me for Wednesday at 5.', { settings: { booking_mode: 'direct' } }],
  ];
  for (const [text, c] of cases) {
    const a = post(text, { crm: c, w: MASTER_PREPARED, id: 'wamid.EQ.1' });
    const b = post(text, { crm: c, id: 'wamid.EQ.1' });
    clean(b);
    assert.deepStrictEqual(texts(b.meta), texts(a.meta), `${text} ${JSON.stringify(c)}: messages`);
    assert.deepStrictEqual(b.g.docs.DOCA, a.g.docs.DOCA, `${text} ${JSON.stringify(c)}: Grist`);
  }
});

// ================================================================ races and duplicates
test('R6 the slot is held: a second patient asking for the same time is told it is not available and gets real alternatives; no second row', () => {
  const x = post(BOOK_SAT, { crm: { settings: REQ }, id: 'wamid.A.1' });
  clean(x);
  assert.strictEqual(requests(x.g).length, 1);
  // Ravi (lead 3) writes the same time
  const y = post(BOOK_SAT, { g: x.g, from: P_RAVI, id: 'wamid.B.1', ts: F.sec(F.NOW) + 30, now: F.NOW + 60000, ai: dec({ intent: 'book_appointment', action: 'book_slot', booking: { date: '2026-10-10', time: '17:00', time_window: null }, reply: 'Saturday at 5 PM is free.' }) });
  clean(y);
  assert.strictEqual(requests(y.g).length, 1, 'still one request');
  assert(/not available/.test(texts(y.meta).pop()) && !/5:00 PM\./.test(texts(y.meta).pop().split('Free times:')[0]), texts(y.meta).pop());
  const sys = y.claude.calls[0].body.system.map((b) => b.text).join('\n');
  const line = sys.split('\n').find((l) => l.startsWith('- 2026-10-10 ('));
  assert(line && !line.includes('17:00'), `17:00 is not offered to the model: ${line}`);
});
test('R7 asking twice does not create two rows: the same time again = the existing request is repeated back; max_pending_requests stops a flood (a person takes over)', () => {
  const x = post(BOOK_SAT, { crm: { settings: REQ }, id: 'wamid.A.1' });
  const y = post(BOOK_SAT, { g: x.g, id: 'wamid.A.2', ts: F.sec(F.NOW) + 30, now: F.NOW + 60000, ai: dec({ intent: 'book_appointment', action: 'book_slot', booking: { date: '2026-10-10', time: '17:00', time_window: null }, reply: 'ok' }) });
  clean(y);
  assert.strictEqual(requests(y.g).length, 1);
  assert(/We already have your request for Sat 10 Oct at 5:00 PM/.test(texts(y.meta).pop()));
  // two different pending requests, then a third
  const times = ['2026-10-09', '2026-10-10', '2026-10-08'];
  let g = crm({ settings: REQ });
  const outcomes = [];
  times.forEach((date, i) => {
    const z = post('book', { g, id: `wamid.M.${i}`, ts: F.sec(F.NOW + 60000 * (i + 1)) - 5, now: F.NOW + 60000 * (i + 1), ai: dec({ intent: 'book_appointment', action: 'book_slot', booking: { date, time: '11:00', time_window: null }, reply: 'ok' }) });
    clean(z);
    outcomes.push([requests(g).length, lastIn(g).AI_Status]);
  });
  assert.deepStrictEqual(outcomes, [[1, 'replied'], [2, 'replied'], [2, 'handed_off']]);
});
test('R8 a request holds its slot for request_hold_hours only: after 24 h another patient is offered it again', () => {
  const x = post(BOOK_SAT, { crm: { settings: REQ }, id: 'wamid.A.1' });
  const later = F.NOW + 25 * 3600 * 1000;
  const snapshot = clone(x.g.docs);
  const y = post('What about Saturday?', { g: x.g, from: P_RAVI, id: 'wamid.B.2', ts: F.sec(later) - 5, now: later });
  const line = y.claude.calls[0].body.system.map((b) => b.text).join('\n').split('\n').find((l) => l.startsWith('- 2026-10-10 ('));
  assert(line && line.includes('17:00'), `held request expired: ${line}`);
  const fresh = new TestGrist(clone(snapshot));   // the CRM as it was before the 25 h later message
  const held = post('What about Saturday?', { g: fresh, from: P_RAVI, id: 'wamid.B.3', ts: F.sec(F.NOW) + 100, now: F.NOW + 120000 });
  const l2 = held.claude.calls[0].body.system.map((b) => b.text).join('\n').split('\n').find((l) => l.startsWith('- 2026-10-10 ('));
  assert(l2 && !l2.includes('17:00'), 'control: two minutes later it is still held');
});
test('R9 two patients decide at the same moment (both read the slot as free before either writes): both rows are Requested, NEITHER is Booked (staff confirm one; see request-confirm.test.js)', () => {
  const g = crm({ settings: REQ });
  // patient B's write happens after A's row appeared between B's read and B's write
  g.hook('before', 'POST', 'Appointments', 1, (grist) => {
    grist.table('DOCA', 'Appointments').push({ id: 99, fields: { Booking_UID: 'req-wamid.A.1', Lead: 1, Service: 'Appointment', Start: SAT_5PM, End: SAT_5PM + 1800, Status: 'Requested', Requested_At: F.sec(F.NOW) } });
  });
  const y = post(BOOK_SAT, { g, from: P_RAVI, id: 'wamid.B.1', ai: dec({ intent: 'book_appointment', action: 'book_slot', booking: { date: '2026-10-10', time: '17:00', time_window: null }, reply: 'ok' }) });
  clean(y);
  const r = requests(g);
  assert.strictEqual(r.length, 2);
  assert(r.every((a) => a.Start === SAT_5PM && a.Status === 'Requested'));
  assert.strictEqual(rows(g, 'Appointments').filter((a) => a.Status === 'Booked').length, 3);
});

// ================================================================ what the patient may do with a request
test('R10 cancel a request (allowed, worded as a request); reschedule of a confirmed WhatsApp booking goes to a person; Cal.com bookings keep using the patient\'s own link', () => {
  const g = crm({ settings: REQ });
  const x1 = post(BOOK_SAT, { g, id: 'wamid.A.1' });
  assert.strictEqual(requests(g).length, 1);
  const x2 = post('Please cancel my request', { g, id: 'wamid.A.2', ts: F.sec(F.NOW) + 30, now: F.NOW + 60000, ai: dec({ intent: 'cancel_appointment', action: 'cancel_appointment', appointment_ref: 'A2', reply: 'Cancelled.' }) });
  clean(x2);
  assert.strictEqual(requests(g).length, 0);
  assert.strictEqual(rows(g, 'Appointments').find((a) => a.Booking_UID === 'req-wamid.A.1').Status, 'Cancelled');
  assert.strictEqual(texts(x2.meta).pop(), `${P_ASHA}: Your request for Sat 10 Oct 5:00 PM is cancelled.`);
  assert(x1 && x2);
  // a WhatsApp-booked appointment (direct mode earlier): reschedule = a person
  const wa = F.appointmentRows(); wa[0].fields.Booking_UID = 'wa-wamid.OLD.9';
  const y = post('Please move my appointment to Saturday at 5.', { crm: { settings: REQ, appts: wa }, ai: dec({ intent: 'reschedule_appointment', action: 'reschedule_appointment', appointment_ref: 'A1', booking: { date: '2026-10-10', time: '17:00', time_window: null }, reply: 'Moved!' }) });
  clean(y);
  assert.deepStrictEqual([lastIn(y.g).AI_Status, requests(y.g).length, rows(y.g, 'Appointments').filter((a) => a.Status === 'Booked').length, rows(y.g, 'Appointments').filter((a) => a.Status === 'Rescheduled').length], ['handed_off', 0, 3, 0]);
  assert.strictEqual(texts(y.meta).length, 2, 'holding reply + staff alert');
});
test('R11 "is my appointment confirmed?" with a pending request: the AI is told it is a request; a reply that calls it confirmed is replaced by the truth', () => {
  const g = crm({ settings: REQ });
  post(BOOK_SAT, { g, id: 'wamid.A.1' });
  const y = post('Is my Saturday appointment confirmed?', { g, id: 'wamid.A.2', ts: F.sec(F.NOW) + 30, now: F.NOW + 60000, ai: dec({ intent: 'appointment_status', action: 'reply', reply: 'Yes, your appointment on Saturday at 5:00 PM is confirmed.' }) });
  clean(y);
  assert.strictEqual(texts(y.meta).pop(), `${P_ASHA}: Your request for Sat 10 Oct 5:00 PM is waiting for our team to confirm. It is not confirmed yet.`);
  const sys = y.claude.calls[0].body.system.map((b) => b.text).join('\n');
  assert(sys.includes('- [A2] Sat 10 Oct 5:00 PM, Appointment (a request: the team has not confirmed it yet)'), 'the request is listed as pending');
  assert(!sys.split('APPOINTMENTS (this patient, upcoming)')[1].split('RECENT CONVERSATION')[0].includes('Sat 10 Oct'), 'and not under APPOINTMENTS');
  // a made-up confirmation of something that does not exist
  const z = post('Is my Friday appointment confirmed?', { crm: { settings: REQ }, ai: dec({ intent: 'appointment_status', action: 'reply', reply: 'Yes, your appointment on Friday at 3:00 PM is confirmed.' }) });
  assert.deepStrictEqual([lastIn(z.g).AI_Status, texts(z.meta).length], ['handed_off', 2]);
});

// ================================================================ safety nets that were already there
test('R12 emergency, medical, STOP and hand-off rules still come first in request mode: no request is written', () => {
  for (const text of ['I have chest pain, please book me for Saturday at 5', 'seene me dard hai, kal ka appointment chahiye']) {
    const x = post(text, { crm: { settings: REQ } });
    clean(x);
    assert.deepStrictEqual([requests(x.g).length, lastIn(x.g).AI_Status, x.claude.calls.length], [0, 'handed_off', 0], text);
    assert(/URGENT/.test(texts(x.meta)[1]), text);
  }
  const med = post('My knee is swollen, should I book Saturday at 5 or take ibuprofen?', { crm: { settings: REQ }, ai: dec({ intent: 'medical_question', action: 'handoff', needs_human: true, handoff_reason: 'medical', reply: '' }) });
  assert.deepStrictEqual([requests(med.g).length, lastIn(med.g).AI_Status], [0, 'handed_off']);
  const stop = post('STOP', { crm: { settings: REQ } });
  assert.deepStrictEqual([requests(stop.g).length, lastIn(stop.g).AI_Status], [0, 'opted_out']);
  const off = post(BOOK_SAT, { crm: { settings: { ...REQ, ai_mode: 'off' } } });
  assert.deepStrictEqual([requests(off.g).length, off.meta.calls.length], [0, 0]);
  const draft = post(BOOK_SAT, { crm: { settings: { ...REQ, ai_mode: 'draft' } } });
  clean(draft);
  assert.deepStrictEqual([lastIn(draft.g).AI_Status, draft.meta.calls.length, requests(draft.g).length], ['drafted', 0, 1], 'draft mode: the request row is still created for staff, the patient is not messaged');
  assert(/NOT confirmed yet/.test(lastIn(draft.g).AI_Reply));
});
test('R13 a failed Grist write (a missing column / a Grist error): nothing is promised: the patient gets the holding reply, a person is alerted, no row is left half-written', () => {
  const x = post(BOOK_SAT, { g: crm({ settings: REQ }).failAt('POST', 'Appointments', 1) });
  clean(x);
  assert.deepStrictEqual([requests(x.g).length, lastIn(x.g).AI_Status, texts(x.meta).length], [0, 'handed_off', 2]);
  assert(!/noted your request/.test(texts(x.meta).join('\n')));
  assert(/could not save the appointment change/.test(lastIn(x.g).AI_Reason));
});

// ================================================================ a request triggers nothing and is never counted as confirmed
const startW5 = (g, now, w = WF, meta = fakeMeta()) => {
  const r = simulate(w, { start: 'W5 – Every 15 minutes', items: [{ json: { timestamp: 'x' } }], grist: g, now, workflowId: 'MASTER', workflows: {}, meta });
  return { r, meta, runs: allRuns(r) };
};
test('R14 REMINDERS (W5): a Booked appointment tomorrow gets its 24 h reminder (control); the same row as Requested gets none, sets no flag, writes nothing', () => {
  const tomorrow10 = F.at('2026-10-07', '10:00');
  const row = (status) => ({ id: 20, fields: { Booking_UID: 'req-wamid.X', Lead: 1, Service: 'Knee pain physiotherapy', Physio: 'Dr. Mehta', Start: tomorrow10, End: tomorrow10 + 1800, Status: status, ...(status === 'Requested' ? { Requested_At: F.sec(F.NOW) - 3600 } : {}) } });
  const now = F.NOW;   // 23 h before the visit: inside the 24 h reminder window
  const run = (status) => {
    const g = crm({ appts: [row(status)], settings: { TEST_MODE: 'false' } });
    const s = startW5(g, now);
    for (const run of s.runs) assert.strictEqual(run.error, null, JSON.stringify(run.error));
    return { g, s };
  };
  const ctl = run('Booked');
  assert.strictEqual(ctl.s.meta.calls.length, 1, 'control: a Booked appointment does get its reminder');
  assert.strictEqual(ctl.s.meta.calls[0].body.to, P_ASHA, 'to the patient');
  assert(rows(ctl.g, 'Appointments')[0].R24_Sent > 0, 'control: the sent flag is set');
  const req = run('Requested');
  assert.strictEqual(req.s.meta.calls.length, 0, 'a Requested appointment gets NO reminder');
  assert.strictEqual(rows(req.g, 'Appointments')[0].R24_Sent, undefined);
  assert.deepStrictEqual(req.g.calls.filter((c) => c.method !== 'GET'), [], 'W5 wrote nothing');
  // and with the staff-confirmed row (Status Booked) the reminder starts: confirmation is what switches reminders on
  const confirmed = run('Booked');
  assert.strictEqual(confirmed.s.meta.calls.length, 1);
});
test('R15 FOLLOW-UPS, CHECK-INS, REVIEWS, REPORT: W6 / W7 / W8 / W9 read Booked, Completed and No-show only: a Requested row is not counted as booked and starts nothing', () => {
  const cm = require('../snippets/clinic-modules');
  const past = F.at('2026-10-05', '10:00');
  const fut = F.at('2026-10-08', '10:00');
  const appts = [
    { id: 1, fields: { Booking_UID: 'req-a', Lead: 1, Start: past, End: past + 1800, Status: 'Requested' } },
    { id: 2, fields: { Booking_UID: 'req-b', Lead: 1, Start: fut, End: fut + 1800, Status: 'Requested' } },
  ];
  const settings = { outcome_checkin: 'on', review_requests: 'on' };
  // the workflows ask Grist for Status filters that cannot return a Requested row
  for (const [node, statuses] of [['W5 – Appointments', ['Booked']], ['W6 – Appointments', ['No-show', 'Booked']], ['W7 – Appointments', ['Completed', 'Booked']], ['W8 – Appointments', ['Completed']], ['W13 – Appointments', ['Booked', 'Requested']]]) {
    const n = PATCHED_WF.nodes.find((x) => x.name === node);
    const filter = n.parameters.queryParameters.parameters.find((p) => p.name === 'filter').value;
    assert.deepStrictEqual(JSON.parse(filter.replace(/^=\{\{ JSON\.stringify\(|\) \}\}$/g, '').replace(/(\w+):/g, '"$1":')).Status, statuses, node);
  }
  const text = JSON.stringify(PATCHED_WF.nodes.find((n) => n.name === 'W9 – Appointments').parameters);
  assert(!/Requested/.test(text), 'W9 reads the whole table but counts by exact status');
  assert.strictEqual(typeof cm, 'object');
  // the counting code: Requested is in none of the buckets
  const code = PATCHED_WF.nodes.find((n) => n.name === 'W9 – Metrics').parameters.jsCode;
  for (const bucket of ['completed', 'no_show', 'cancelled', 'rescheduled', 'still_marked_booked', 'booked_next_7_days']) {
    const m = new RegExp(`${bucket}: count\\([^\\n]*`).exec(code);
    assert(m && !/Requested/.test(m[0]) && /Status === '(Completed|No-show|Cancelled|Rescheduled|Booked)'/.test(m[0]), `${bucket}: ${m && m[0]}`);
  }
  assert(appts.length === 2 && settings);
});

test('R16 WEEKLY REPORT (W9) and the daily jobs: adding Requested rows (past, next week, hand-made) changes NOTHING in the report numbers or in what W5 / W6 / W7 / W8 send', () => {
  const MON = Date.parse('2026-10-12T09:00:00+05:30');
  const W = F.sec(Date.parse('2026-10-05T00:00:00+05:30'));
  const DAY = 86400, HOUR = 3600;
  const base = [
    [201, W + 10 * HOUR, 'Completed'], [202, W + DAY + 10 * HOUR, 'Completed'], [204, W + 3 * DAY + 10 * HOUR, 'No-show'], [205, W + 4 * DAY + 10 * HOUR, 'Cancelled'],
    [207, W + 4 * DAY + 16 * HOUR, 'Rescheduled'], [210, W + 6 * DAY + 10 * HOUR, 'Booked'], [209, F.sec(MON) + 2 * DAY, 'Booked'],
  ].map(([id, start, st]) => ({ id, fields: { Booking_UID: `u${id}`, Lead: 1, Service: 'Physio', Start: start, End: start + 2700, Status: st } }));
  const reqs = [
    [301, W + 2 * DAY + 10 * HOUR, 'Requested'], [302, F.sec(MON) + 1 * DAY, 'Requested'], [303, F.sec(MON) + 3 * DAY, 'Requested'], [304, W + 5 * DAY + 10 * HOUR, 'Declined'],
    [305, F.sec(MON) - 31 * HOUR, 'Requested'], [306, F.sec(MON) + 5 * HOUR - 24 * HOUR, 'Requested'], [307, F.sec(MON) + 22 * HOUR, 'Requested'],   // look like a completed / no-show / reminder candidate in time
  ].map(([id, start, st]) => ({ id, fields: { Booking_UID: `req-${id}`, Lead: 3, Service: 'Physio', Start: start, End: start + 1800, Status: st, ...(st === 'Requested' && id !== 303 ? { Requested_At: F.sec(MON) - 3600 } : {}) } }));
  // for each job, one REAL appointment of lead 3 that makes the job act (the control: the job does something on the base data)
  const real = (start, now) => {
    const t = F.sec(now);
    if (/W5/.test(start)) return [{ id: 401, fields: { Booking_UID: 'u401', Lead: 3, Service: 'Physio', Start: t + 22 * HOUR, End: t + 22 * HOUR + 2700, Status: 'Booked' } }];
    if (/W6/.test(start)) return [{ id: 402, fields: { Booking_UID: 'u402', Lead: 3, Service: 'Physio', Start: t - 24 * HOUR, End: t - 24 * HOUR + 2700, Status: 'No-show' } }];
    if (/W7/.test(start)) return [{ id: 403, fields: { Booking_UID: 'u403', Lead: 3, Service: 'Physio', Start: t - 31 * HOUR, End: t - 31 * HOUR + 2700, Status: 'Completed' } }];
    if (/W8/.test(start)) return [{ id: 404, fields: { Booking_UID: 'u404', Lead: 3, Service: 'Physio', Start: t - 5 * HOUR, End: t - 5 * HOUR + 2700, Status: 'Completed' } }];
    return [];
  };
  const run = (start, now, appts) => {
    const g = crm({ appts: [...base, ...real(start, now), ...appts], settings: { owner_phone: OWNER, outcome_checkin: 'on', review_requests: 'on', weekly_report_whatsapp: 'on', review_link: 'https://g.page/r/demo/review' } });
    const meta = fakeMeta();
    const r = simulate(WF, { start, items: [{ json: {} }], grist: g, now, workflowId: 'MASTER', workflows: {}, meta, openrouter: () => { throw new Error('timeout of 45000ms exceeded'); }, ollama: () => { throw new Error('no AI in this test'); } });
    for (const x of allRuns(r)) assert.strictEqual(x.error, null, `${start}: ${JSON.stringify(x.error)}`);
    return { g, meta, r };
  };
  const apptRows = (g) => rows(g, 'Appointments');
  const isReq = (a) => /^req-/.test(a.Booking_UID);
  for (const [start, now] of [['W9 – Monday 09:00', MON], ['W6 – Daily 10:00', MON + HOUR * 1000], ['W7 – Every hour', MON + 5 * 3600 * 1000], ['W8 – Every hour', MON + 5 * 3600 * 1000], ['W5 – Every 15 minutes', MON]]) {
    const a = run(start, now, []);
    const b = run(start, now, reqs);
    assert(a.meta.calls.length >= 1 && rows(a.g, 'Run_Log').length >= 1, `${start}: control: the job does act on the base data (${a.meta.calls.length} messages)`);
    assert.deepStrictEqual(b.meta.calls.map((c) => c.body), a.meta.calls.map((c) => c.body), `${start}: messages`);
    assert.deepStrictEqual(rows(b.g, 'Run_Log').map(({ id, ...l }) => l), rows(a.g, 'Run_Log').map(({ id, ...l }) => l), `${start}: Run_Log`);
    assert.deepStrictEqual(apptRows(b.g).filter((x) => !isReq(x)), apptRows(a.g), `${start}: every real appointment row ends up identical (flags set the same)`);
    assert.deepStrictEqual(apptRows(b.g).filter(isReq), apptRows(b.g).filter(isReq).map((x) => reqs.find((q) => q.id === x.id) && { id: x.id, ...reqs.find((q) => q.id === x.id).fields }), `${start}: the requests are untouched (no sent flag, no status change)`);
    if (start === 'W9 – Monday 09:00') {
      const ma = a.r.runData['W9 – Report'][0].json.metrics.appointments;
      const mb = b.r.runData['W9 – Report'][0].json.metrics.appointments;
      assert.deepStrictEqual(mb, ma, 'W9 appointment numbers');
      assert(mb.booked_next_7_days >= 1 && mb.completed === 2 && mb.this_week === 6, 'control: the report counts the real appointments only');
    }
  }
});

// ================================================================ run
let failed = 0;
for (const t of suite) {
  try { t.fn(); console.log(`PASS  ${t.name}`); } catch (e) { failed++; console.log(`FAIL  ${t.name}\n      ${String(e.stack || e.message).split('\n').slice(0, 8).join('\n      ')}`); }
}
console.log(failed ? `\n${failed} of ${suite.length} REQUEST MODE CHECKS FAILED` : `\nREQUEST MODE: ${suite.length} of ${suite.length} checks pass`);
process.exit(failed ? 1 : 0);
