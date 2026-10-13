// MISSED_CALL_CAPTURE end to end on the patched workflow: the SHIPPED JSON runs in the simulator (fake Grist, fake Meta, fake OpenRouter,
// fake Ollama), through W12 for every message. One line per check: PASS / FAIL and why. Synthetic numbers only (+91 90000 ...).
// Run: node n8n/integrated/missed-call-capture.test.js      (MCC_FILE = another file)
// Nothing here can reach the network: the fakes are the only "services", and the checks assert the fakes were (not) called.
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { simulate, FakeGrist, COLUMNS, CHOICES, DATETIME, TOGGLE } = require('../tests/n8n-sim');
const F = require('../tests/ai-fixtures');

const FILE = process.env.MCC_FILE || path.join(__dirname, 'clinic-autopilot-master-ai.missed-call-demo.json');
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---------------------------------------------------------------- live CRM naming (LEADS / Lead_id) and the columns this section writes
COLUMNS.LEADS = COLUMNS.Leads.map((c) => (c === 'Lead_ID' ? 'Lead_id' : c));
for (const k of Object.keys(CHOICES)) if (k.startsWith('Leads.')) CHOICES[k.replace('Leads.', 'LEADS.')] = CHOICES[k];
for (const set of [DATETIME, TOGGLE]) for (const k of [...set]) if (k.startsWith('Leads.')) set.add(k.replace('Leads.', 'LEADS.'));
if (!CHOICES['Messages.Status'].includes('Received')) CHOICES['Messages.Status'] = [...CHOICES['Messages.Status'], 'Received'];
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
    const out = super.handle(method, url, query, body);
    for (const hk of this.hooks.filter((x) => x.when === 'after' && x.key === key && x.nth === this.count[key])) hk.fn(this);
    return out;
  }
}

// ---------------------------------------------------------------- the workflow as after import + the values a user fills in (test values, in memory)
const SECRET = 'test-call-secret-0123456789';
const REG = 'fAft6pAYwFUU';
const CALLED_A = '+919000000100';      // clinic A's number
const CALLED_B = '+919000000200';      // clinic B's number
const NEW_CALLER = '+919000000021';
const OWNER = '+919000000018', TESTP = '+919000000019';
const T = F.sec(F.NOW);                 // Tue 06 Oct 2026, 11:00 IST
const NIGHT = Date.parse('2026-10-06T23:00:00+05:30');
const base = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const prep = (mode, secret = SECRET) => {
  const w = clone(base);
  const setv = (node, key, v) => { w.nodes.find((n) => n.name === node).parameters.assignments.assignments.find((a) => a.name === key).value = v; };
  setv('W12 – Config', 'w12_allowlist', `${OWNER},${TESTP}`);
  setv('W12 – Config', 'w12_send_mode', mode);
  setv('MCC – Config', 'mcc_webhook_secret', secret);
  return w;
};
const W_SIM = prep('simulate');

const settings = (over = {}) => F.settingsRows({ ai_mode: 'off', missed_call_enabled: 'on', demo_mode: 'true', TEST_MODE: 'true', ...over });
const docA = (o = {}) => ({
  Settings: o.settings || settings(), Knowledge: clone(F.KNOWLEDGE), LEADS: clone(o.leads || F.leadRows()), Conversations: clone(o.convs || F.conversationRows()),
  Messages: clone(o.msgs || F.messageRows()), Appointments: [], Run_Log: [],
});
const crm = (o = {}) => new TestGrist({
  [REG]: { Clinics: [
    { id: 1, fields: { Clinic_Slug: 'demo-clinic', Clinic_Name: 'Demo Physio', Grist_Doc_ID: 'DOCA', WA_Phone_Number_ID: '123456789012345', Active: true, Call_Number: CALLED_A } },
    ...(o.docB ? [{ id: 2, fields: { Clinic_Slug: 'second-clinic', Clinic_Name: 'Second Physio', Grist_Doc_ID: 'DOCB', WA_Phone_Number_ID: '223456789012345', Active: true, Call_Number: CALLED_B } }] : []),
    { id: 3, fields: { Clinic_Slug: 'old-clinic', Clinic_Name: 'Closed Clinic', Grist_Doc_ID: 'DOCX', WA_Phone_Number_ID: '323456789012345', Active: false, Call_Number: '+919000000300' } },
    { id: 4, fields: { Clinic_Slug: 'whatsapp-only', Clinic_Name: 'No Call Number', Grist_Doc_ID: 'DOCW', WA_Phone_Number_ID: '423456789012345', Active: true } },
  ] },
  DOCA: docA(o),
  ...(o.docB ? { DOCB: o.docB } : {}),
});
const fakeMeta = (answer) => {
  const calls = [];
  const fn = (method, url, body) => { calls.push({ url, body }); const a = answer ? answer(body, calls.length) : null; return a || { status: 200, body: { messages: [{ id: `wamid.SENT.${calls.length}` }] } }; };
  fn.calls = calls;
  return fn;
};
const counter = () => { const fn = () => { fn.calls++; throw new Error('this fake must not be called'); }; fn.calls = 0; return fn; };
const allRuns = (r) => [r, ...r.subRuns.flatMap(allRuns)];
const call = (over = {}) => ({ provider_call_id: 'demo-0001', called_number: CALLED_A, caller_number: NEW_CALLER, timestamp: T - 20, status: 'missed', duration_seconds: 12, provider: 'demo', ...over });
const run = (body, o = {}) => {
  const g = o.g || crm(o.crm);
  const meta = o.meta || fakeMeta(o.metaAnswer);
  const openrouter = counter();
  const r = simulate(o.w || W_SIM, {
    start: 'MCC – Webhook', items: [{ json: { headers: o.headers === undefined ? { 'x-call-secret': SECRET } : o.headers, body, query: {}, params: {} } }],
    grist: g, now: o.now || F.NOW, workflowId: 'MASTER', workflows: {}, meta, openrouter,
  });
  const runs = allRuns(r);
  return { r, g, meta, openrouter, runs, errors: runs.filter((x) => x.error).map((x) => x.error), visited: runs.flatMap((x) => x.visited), res: r.responses.map((x) => ({ code: x.code, body: x.body ? JSON.parse(x.body) : null })) };
};
const rows = (g, t, doc = 'DOCA') => g.docs[doc][t].map((x) => ({ id: x.id, ...x.fields }));
const writes = (g) => g.calls.filter((c) => c.method !== 'GET');
const mccLogs = (g, doc = 'DOCA') => rows(g, 'Run_Log', doc).filter((l) => l.Workflow === 'MCC-missed-call-capture');
const callRows = (g, doc = 'DOCA') => rows(g, 'Messages', doc).filter((m) => m.Template === 'missed_call');
const ackRows = (g, doc = 'DOCA') => rows(g, 'Messages', doc).filter((m) => m.Template === 'missed_call_ack');
const leadRows = (g, doc = 'DOCA') => rows(g, 'LEADS', doc);
const noPii = (text) => assert(!/(\+?91)?[6-9]\d{9}/.test(String(text)), `a phone number leaked into: ${text}`);

const results = [];
const check = (id, title, fn) => {
  try { const why = fn(); results.push({ id, title, ok: true, why: why || '' }); } catch (e) { results.push({ id, title, ok: false, why: e.message.split('\n').slice(0, process.env.MCC_VERBOSE ? 40 : 4).join(' ') }); }
};

// ================================================================ 1. a missed call from a new caller, end to end (DEMO: simulated)
check('M1', 'valid missed call -> 200 at once, lead + conversation + event row + simulated ack + simulated alert; nothing sent', () => {
  const x = run(call());
  assert.deepStrictEqual(x.errors, []);
  assert.deepStrictEqual(x.res.map((r) => [r.code, r.body.status, r.body.call_key]), [[200, 'accepted', 'call-demo-0001']]);
  const leads = leadRows(x.g).filter((l) => l.Phone === NEW_CALLER);
  assert.strictEqual(leads.length, 1);
  assert.deepStrictEqual([leads[0].Source, leads[0].Status, leads[0].Name, leads[0].Lead_id], ['Call', 'New', 'Caller 0021', 'L-20261006-0001']);
  assert(leads[0].Notes.startsWith('[DEMO]'));
  const conv = rows(x.g, 'Conversations').find((c) => c.Phone === NEW_CALLER);
  assert.deepStrictEqual([conv.Lead, conv.Unread], [leads[0].id, 1]);
  assert(!('Last_Inbound_At' in conv), 'a missed call is not a WhatsApp message: the 24 h window must not open');
  const ev = callRows(x.g);
  assert.strictEqual(ev.length, 1);
  assert.deepStrictEqual([ev[0].WA_Message_ID, ev[0].Conversation, ev[0].AI_Action, ev[0].Direction, ev[0].Status], ['call-demo-0001', conv.id, 'mcc:ack_simulated', 'In', 'Received']);
  assert(/^attempt 1: DEMO simulated, nothing was sent; alert simulated$/.test(ev[0].AI_Reason), ev[0].AI_Reason);
  assert(ev[0].Body.startsWith('[DEMO] Missed call (missed)'));
  const ack = ackRows(x.g);
  assert.strictEqual(ack.length, 1, 'the intended acknowledgement is shown in the thread');
  assert.deepStrictEqual([ack[0].Direction, ack[0].Conversation, ack[0].Status, ack[0].Send], ['Out', conv.id, 'queued', false]);
  assert(ack[0].Body.startsWith('[DEMO simulated, not sent] Namaste! Sorry, we missed your call to Demo Physio'), ack[0].Body);
  assert(/^W12-missed-call-ack \[DEMO simulated: nothing was sent; would go to \+919000000019\]$/.test(ack[0].Sent_By), ack[0].Sent_By);
  assert(/^sim-/.test(ack[0].WA_Message_ID));
  const log = mccLogs(x.g);
  assert.deepStrictEqual(log.map((l) => [l.Outcome, l.Record]), [['ok', '[DEMO] call-demo-0001 L-20261006-0001: ack simulated; staff alert simulated']]);
  assert.strictEqual(x.meta.calls.length, 0, 'no Meta call');
  assert(!x.visited.includes('W12 – Meta send'), 'the Meta node never ran');
  assert.strictEqual(x.visited.filter((n) => n === 'W12 – Simulated send').length, 2, 'ack + alert, both simulated');
  assert(!x.visited.some((n) => /^W13 –/.test(n)), 'the AI is not involved in the capture');
  noPii(log[0].Record + log[0].Error);
  return 'lead Call/New, conversation Unread 1 without Last_Inbound_At, event row mcc:ack_simulated, DEMO ack in the thread, 0 Meta calls';
});

// ================================================================ 2. request handling: auth, malformed, ignored
check('M2', 'no / wrong secret = 401, unset or placeholder secret = 503; nothing is read or written', () => {
  for (const headers of [{}, { 'x-call-secret': 'wrong-secret-value' }, { 'x-call-secret': '' }, { 'X-Call-Secret': SECRET.toUpperCase() }]) {
    const x = run(call(), { headers });
    assert.deepStrictEqual(x.res.map((r) => [r.code, r.body.error]), [[401, 'unauthorized']], JSON.stringify(headers));
    assert.strictEqual(x.g.calls.length, 0, 'not a single Grist call');
    assert.deepStrictEqual(x.visited.filter((n) => /^MCC –/.test(n)), ['MCC – Webhook', 'MCC – Config', 'MCC – Validate', 'MCC – Respond', 'MCC – Process?']);
  }
  for (const secret of ['REPLACE_WITH_A_LONG_RANDOM_SECRET', 'short', '']) {
    const x = run(call(), { w: prep('simulate', secret), headers: { 'x-call-secret': secret || 'x' } });
    assert.deepStrictEqual(x.res.map((r) => [r.code, r.body.error]), [[503, 'not_configured']], secret);
    assert.strictEqual(x.g.calls.length, 0);
  }
  assert.strictEqual(run(call(), { headers: { 'X-Call-Secret': SECRET } }).res[0].code, 200, 'header name case does not matter');
  assert.strictEqual(base.nodes.find((n) => n.name === 'MCC – Config').parameters.assignments.assignments.find((a) => a.name === 'mcc_webhook_secret').value, 'REPLACE_WITH_A_LONG_RANDOM_SECRET', 'the shipped file holds no secret');
  return 'wrong / missing = 401, placeholder / short / empty = 503, zero Grist calls, the shipped file holds a placeholder';
});
check('M3', 'malformed / invalid events = 400 with the field names; answered calls = 200 ignored; nothing is written', () => {
  const cases = [
    [call({ provider_call_id: '' }), ['provider_call_id']], [call({ caller_number: '12345' }), ['caller_number']], [call({ called_number: 'x' }), ['called_number']],
    [call({ timestamp: 'yesterday' }), ['timestamp']], [call({ timestamp: T - 3 * 86400 }), ['timestamp_too_old']], [call({ status: 'exploded' }), ['status']],
    [call({ duration_seconds: -3 }), ['duration_seconds']], [call({ caller_number: '+14155550100' }), ['caller_number']],
  ];
  for (const [body, fields] of cases) {
    const x = run(body);
    assert.deepStrictEqual(x.res.map((r) => [r.code, r.body.error, r.body.fields]), [[400, 'invalid_event', fields]], JSON.stringify(body));
    assert.strictEqual(x.g.calls.length, 0);
    assert.deepStrictEqual(x.errors, []);
  }
  for (const body of [null, 'text', [], 42]) {
    const x = run(body);
    assert.deepStrictEqual(x.res.map((r) => [r.code, r.body.fields]), [[400, ['body']]], String(body));
  }
  const answered = run(call({ status: 'answered' }));
  assert.deepStrictEqual(answered.res.map((r) => [r.code, r.body.status, r.body.reason]), [[200, 'ignored', 'call_not_missed']]);
  assert.strictEqual(answered.g.calls.length, 0);
  for (const status of ['unanswered', 'no-answer', 'busy', 'MISSED']) {
    const x = run(call({ provider_call_id: `s-${status}`, status }));
    assert.strictEqual(x.res[0].code, 200, status);
    assert.strictEqual(callRows(x.g).length, 1, status);
  }
  return '8 invalid shapes, 4 non-objects, answered ignored, missed / unanswered / no-answer / busy all captured';
});

// ================================================================ 3. tenant resolution
check('M4', 'unknown / inactive / WhatsApp-only called number: nothing is written, the run stops with an error carrying no full number', () => {
  for (const called of ['+919000000999', '+919000000300', '+919000000555']) {
    const x = run(call({ called_number: called }));
    assert.strictEqual(x.res[0].code, 200, 'answered first');
    assert.strictEqual(x.r.error.node, 'MCC – Unknown clinic');
    assert(/no active clinic owns the called number ending \d{4} \(unknown_number\)/.test(x.r.error.message), x.r.error.message);
    assert(!x.r.error.message.includes(called.replace('+91', '')), 'the full number is not in the error');
    assert.strictEqual(writes(x.g).length, 0);
  }
  return '3 unknown numbers: error at MCC – Unknown clinic, zero writes';
});
check('M5', 'two clinics: each call lands only in its own Grist doc; a clinic / doc id in the body is ignored', () => {
  const docB = { Settings: settings({ clinic_name: 'Second Physio' }), Knowledge: [], LEADS: [], Conversations: [], Messages: [], Appointments: [], Run_Log: [] };
  const a = run(call({ clinic: 'second-clinic', clinic_slug: 'second-clinic', tenant: 'DOCB', doc_id: 'DOCB', Grist_Doc_ID: 'DOCB' }), { crm: { docB } });
  assert.deepStrictEqual(a.errors, []);
  assert.strictEqual(callRows(a.g).length, 1);
  assert.strictEqual(rows(a.g, 'Messages', 'DOCB').length, 0);
  assert.strictEqual(leadRows(a.g, 'DOCB').length, 0);
  assert.strictEqual(rows(a.g, 'Run_Log', 'DOCB').length, 0);
  assert(a.g.calls.every((c) => c.doc !== 'DOCB'), 'clinic B\'s doc was not even read');
  const b = run(call({ called_number: CALLED_B, clinic: 'demo-clinic', doc_id: 'DOCA' }), { crm: { docB: clone(docB) } });
  assert.deepStrictEqual(b.errors, []);
  assert.strictEqual(callRows(b.g, 'DOCB').length, 1);
  assert.strictEqual(callRows(b.g, 'DOCA').length, 0);
  assert.strictEqual(leadRows(b.g, 'DOCB').length, 1);
  assert.strictEqual(leadRows(b.g, 'DOCB')[0].Lead_id, 'L-20261006-0001');
  assert(b.g.calls.every((c) => c.doc !== 'DOCA'), 'clinic A\'s doc was not even read');
  assert.strictEqual(ackRows(b.g, 'DOCB')[0].Body.includes('Second Physio'), true);
  return 'A call to A touches only DOCA, a call to B only DOCB, whatever the body says';
});
check('M6', 'a clinic that switched capture off (or never on) records nothing but a skipped Run_Log row', () => {
  for (const s of [settings({ missed_call_enabled: 'off' }), F.settingsRows({ ai_mode: 'off' })]) {
    const x = run(call(), { crm: { settings: s } });
    assert.deepStrictEqual(x.errors, []);
    assert.strictEqual(x.res[0].code, 200);
    assert.strictEqual(callRows(x.g).length, 0);
    assert.strictEqual(leadRows(x.g).length, F.leadRows().length, 'no lead');
    assert.deepStrictEqual(mccLogs(x.g).map((l) => [l.Outcome, /off for this clinic/.test(l.Error)]), [['skipped', true]]);
    assert.strictEqual(x.visited.includes('W12 – Simulated send'), false);
  }
  return 'missing / off = no lead, no message, one skipped Run_Log row';
});

// ================================================================ 4. no duplicates
check('M7', 'a retried event: no second lead, event row, acknowledgement or alert', () => {
  const g = crm();
  const first = run(call(), { g });
  const second = run(call(), { g });
  const third = run(call(), { g });
  assert.deepStrictEqual([first.errors, second.errors, third.errors], [[], [], []]);
  assert.deepStrictEqual([first.res[0].code, second.res[0].code, third.res[0].code], [200, 200, 200]);
  assert.strictEqual(leadRows(g).filter((l) => l.Phone === NEW_CALLER).length, 1);
  assert.strictEqual(callRows(g).length, 1);
  assert.strictEqual(ackRows(g).length, 1);
  assert.strictEqual(rows(g, 'Conversations').filter((c) => c.Phone === NEW_CALLER).length, 1);
  assert.strictEqual(rows(g, 'Conversations').find((c) => c.Phone === NEW_CALLER).Unread, 1, 'Unread is counted once');
  for (const dup of [second, third]) {
    assert(!dup.visited.includes('W12 – Simulated send'), 'no W12 call on a repeat');
    assert(!dup.visited.includes('MCC – Claim event'));
  }
  assert.deepStrictEqual(mccLogs(g).map((l) => l.Outcome), ['ok', 'skipped', 'skipped']);
  assert(/duplicate call event/.test(mccLogs(g)[1].Error));
  return '3 deliveries of one event = 1 lead, 1 event row, 1 acknowledgement, Unread 1, two skipped Run_Log rows';
});
check('M8', 'different phone spellings of the same caller reach one lead; a second call within the hour is not acknowledged again', () => {
  const g = crm();
  run(call({ caller_number: '09000000021' }), { g });
  const x = run(call({ provider_call_id: 'demo-0002', caller_number: '91 90000 00021', timestamp: T + 590 }), { g, now: F.NOW + 600 * 1000 });
  assert.deepStrictEqual(x.errors, []);
  assert.strictEqual(leadRows(g).filter((l) => l.Phone === NEW_CALLER).length, 1, 'one lead for one caller');
  assert.strictEqual(callRows(g).length, 2);
  assert.strictEqual(ackRows(g).length, 1, 'no second acknowledgement inside the hour');
  assert.strictEqual(callRows(g)[1].AI_Action, 'mcc:ack_skipped');
  assert(/less than an hour ago/.test(callRows(g)[1].AI_Reason), callRows(g)[1].AI_Reason);
  assert.strictEqual(rows(g, 'Conversations').find((c) => c.Phone === NEW_CALLER).Unread, 2, 'but the staff see two missed calls');
  const later = run(call({ provider_call_id: 'demo-0003', timestamp: T + 7200 - 5 }), { g, now: F.NOW + 7200 * 1000 });
  assert.deepStrictEqual(later.errors, []);
  assert.strictEqual(ackRows(g).length, 2, 'two hours later a new missed call is acknowledged');
  return 'one lead; the 2nd call 10 min later: row yes, ack no, Unread 2; 2 h later: acknowledged again';
});
check('M9', 'a concurrent copy: the lowest row id owns the event, the other stands down and creates nothing', () => {
  // (a) a rival delivery claimed the key in the gap between our "Find event" and our "Claim event": its row has the LOWER id
  const rival = (g) => { g.docs.DOCA.Messages.push({ id: 90, fields: { WA_Message_ID: 'call-demo-0001', Template: 'missed_call', Direction: 'In', Status: 'Received', Created_At: T, AI_Action: 'mcc:claimed' } }); };
  const g = crm().hook('before', 'POST', 'Messages', 1, rival);
  const x = run(call(), { g });
  assert.deepStrictEqual(x.errors, []);
  assert.strictEqual(leadRows(g).filter((l) => l.Phone === NEW_CALLER).length, 0, 'the loser creates no lead');
  assert(!x.visited.includes('W12 – Simulated send'), 'and sends nothing');
  const mine = rows(g, 'Messages').find((m) => m.id !== 90 && m.Template === 'missed_call');
  assert.strictEqual(mine.WA_Message_ID, 'call-demo-0001-dup-' + mine.id, 'our row gave up the key');
  assert.strictEqual(rows(g, 'Messages').find((m) => m.id === 90).WA_Message_ID, 'call-demo-0001', 'the owner keeps the key');
  assert(/concurrent duplicate: row 90 owns this event/.test(mccLogs(g)[0].Error), mccLogs(g)[0].Error);
  // (b) the rival claims AFTER us (higher id): we own it and carry on
  const rival2 = (g2) => { g2.docs.DOCA.Messages.push({ id: 200, fields: { WA_Message_ID: 'call-demo-0001', Template: 'missed_call', Direction: 'In', Status: 'Received', Created_At: T, AI_Action: 'mcc:claimed' } }); g2.nextId['DOCA.Messages'] = 200; };
  const g2 = crm().hook('after', 'POST', 'Messages', 1, rival2);
  const y = run(call(), { g: g2 });
  assert.deepStrictEqual(y.errors, []);
  assert.strictEqual(leadRows(g2).filter((l) => l.Phone === NEW_CALLER).length, 1);
  assert(y.visited.includes('W12 – Simulated send'));
  return 'rival with the lower id: we stand down (no lead, no send, key renamed); rival with the higher id: we carry on';
});
check('M10', 'a crash after the claim: a young claim is left alone, an old one is finished (no second claim row)', () => {
  const claimed = (age) => ({ id: 70, fields: { WA_Message_ID: 'call-demo-0001', Template: 'missed_call', Direction: 'In', Status: 'Received', Created_At: T - age, AI_Action: 'mcc:claimed', Intent: 'missed_call', Sent_By: 'MCC-missed-call', Body: '[DEMO] Missed call (missed)' } });
  const young = run(call(), { crm: { msgs: [...F.messageRows(), claimed(30)] } });
  assert.deepStrictEqual(young.errors, []);
  assert.strictEqual(leadRows(young.g).filter((l) => l.Phone === NEW_CALLER).length, 0);
  assert(/still being processed/.test(mccLogs(young.g)[0].Error));
  const old = run(call(), { crm: { msgs: [...F.messageRows(), claimed(900)] } });
  assert.deepStrictEqual(old.errors, []);
  assert.strictEqual(callRows(old.g).length, 1, 'the existing row is reused');
  assert.strictEqual(callRows(old.g)[0].id, 70);
  assert.strictEqual(callRows(old.g)[0].AI_Action, 'mcc:ack_simulated');
  assert.strictEqual(leadRows(old.g).filter((l) => l.Phone === NEW_CALLER).length, 1);
  assert(!old.visited.includes('MCC – Claim event'));
  return 'claimed 30 s ago: skipped; claimed 15 min ago: finished on the same row';
});

// ================================================================ 5. guards on the acknowledgement
check('M11', 'opted-out caller: no acknowledgement; a person owns the chat: none either; the staff alert still goes', () => {
  const ASHA = F.ASHA;
  const optedOut = run(call({ caller_number: ASHA }), { crm: { leads: F.leadRows().map((l) => (l.id === 1 ? { ...l, fields: { ...l.fields, Opted_Out: true } } : l)) } });
  assert.deepStrictEqual(optedOut.errors, []);
  assert.strictEqual(ackRows(optedOut.g).length, 0);
  assert.strictEqual(callRows(optedOut.g)[0].AI_Action, 'mcc:ack_skipped');
  assert(/opted out/.test(callRows(optedOut.g)[0].AI_Reason), callRows(optedOut.g)[0].AI_Reason);
  assert(/alert simulated/.test(callRows(optedOut.g)[0].AI_Reason), 'staff are still told');
  assert.strictEqual(optedOut.visited.filter((n) => n === 'W12 – Simulated send').length, 1, 'only the staff alert');
  assert.strictEqual(leadRows(optedOut.g).length, F.leadRows().length, 'existing lead reused');
  const owned = run(call({ caller_number: ASHA }), { crm: { convs: [{ id: 1, fields: { Lead: 1, Phone: ASHA, Last_Inbound_At: T - 3600, Unread: 0, Assigned_To: 'Dr. Mehta', Automation_Paused: false } }] } });
  assert.strictEqual(ackRows(owned.g).length, 0);
  assert(/a person owns this conversation/.test(callRows(owned.g)[0].AI_Reason));
  const paused = run(call({ caller_number: ASHA }), { crm: { convs: [{ id: 1, fields: { Lead: 1, Phone: ASHA, Last_Inbound_At: T - 3600, Unread: 0, Automation_Paused: true } }] } });
  assert.strictEqual(ackRows(paused.g).length, 0);
  const conv = rows(owned.g, 'Conversations')[0];
  assert.strictEqual(conv.Last_Inbound_At, T - 3600, 'the patient\'s last WhatsApp message time is untouched');
  assert.strictEqual(conv.Unread, 1);
  return 'opted out / Assigned_To / Automation_Paused = no ack, alert still simulated, Last_Inbound_At untouched';
});
check('M12', 'night: the acknowledgement and the alert wait (deferred), the call is still captured and flagged; nothing is sent', () => {
  const nowSec = Math.floor(NIGHT / 1000);
  const x = run(call({ timestamp: nowSec - 30 }), { now: NIGHT });
  assert.deepStrictEqual(x.errors, []);
  assert.strictEqual(leadRows(x.g).filter((l) => l.Phone === NEW_CALLER).length, 1);
  assert.strictEqual(rows(x.g, 'Conversations').find((c) => c.Phone === NEW_CALLER).Unread, 1, 'staff see it first thing');
  const ev = callRows(x.g)[0];
  assert.strictEqual(ev.AI_Action, 'mcc:ack_deferred');
  assert(/quiet hours/.test(ev.AI_Reason) && /alert deferred/.test(ev.AI_Reason), ev.AI_Reason);
  assert.strictEqual(ackRows(x.g).length, 0);
  assert.strictEqual(x.visited.includes('W12 – Simulated send'), false);
  assert.strictEqual(x.meta.calls.length, 0);
  assert.deepStrictEqual(mccLogs(x.g).map((l) => l.Outcome), ['skipped']);
  return 'quiet hours: captured + Unread, ack_deferred, alert deferred, 0 W12 calls';
});
check('M13', 'TEST_MODE off: the simulated ack would go to the patient; TEST_MODE on: to TEST_PHONE; never reported as sent', () => {
  const off = run(call(), { crm: { settings: settings({ TEST_MODE: 'false' }) } });
  assert(/would go to \+919000000021\]$/.test(ackRows(off.g)[0].Sent_By), ackRows(off.g)[0].Sent_By);
  const on = run(call(), {});
  assert(/would go to \+919000000019\]$/.test(ackRows(on.g)[0].Sent_By));
  for (const x of [off, on]) {
    const retStates = x.runs.filter((s) => s.visited.includes('W12 – Return result')).map((s) => s.runData['W12 – Return result'][0].json);
    assert.strictEqual(retStates.length, 2);
    for (const j of retStates) assert.deepStrictEqual([j.sent, j.simulated, j.send_status], [false, true, 'simulated']);
  }
  return 'recipient follows TEST_MODE; W12 returns sent=false / simulated=true / send_status=simulated';
});

// ================================================================ 6. failures are failures; retries are safe
check('M14', 'live and allowlist mode refuse the simulate-only template: ack_failed, logged as a failure, Meta never sees missed_call_ack', () => {
  for (const mode of ['live', 'allowlist']) {
    const meta = fakeMeta();
    const x = run(call(), { w: prep(mode), meta });
    assert.deepStrictEqual(x.errors, [], mode);
    const ev = callRows(x.g)[0];
    assert.strictEqual(ev.AI_Action, 'mcc:ack_failed', mode);
    assert(/unknown template "missed_call_ack"/.test(ev.AI_Reason), ev.AI_Reason);
    assert.deepStrictEqual(mccLogs(x.g).map((l) => l.Outcome), ['failed'], mode);
    assert(/not sent: unknown template/.test(mccLogs(x.g)[0].Error));
    assert.strictEqual(ackRows(x.g).length, 0, 'nothing was attempted, so no thread row');
    assert(meta.calls.every((c) => c.body.template.name !== 'missed_call_ack'), 'the demo-only template never reaches Meta');
    assert(!x.visited.includes('W12 – Simulated send'), `${mode} mode never simulates`);
  }
  return 'live and allowlist: ack_failed + Outcome failed; the only Meta call (fake) is the staff alert template';
});
check('M15', 'a failed acknowledgement is retried on a repeat of the event, once it works; then the event is closed', () => {
  const g = crm();
  const failed = run(call(), { w: prep('live'), g });
  assert.strictEqual(callRows(g)[0].AI_Action, 'mcc:ack_failed');
  assert(/attempt 1/.test(callRows(g)[0].AI_Reason) && /alert sent/.test(callRows(g)[0].AI_Reason), callRows(g)[0].AI_Reason);
  assert.strictEqual(failed.meta.calls.length, 1, 'the staff alert went (fake) Meta once');
  const retry = run(call(), { w: W_SIM, g });
  assert.deepStrictEqual(retry.errors, []);
  assert.strictEqual(callRows(g).length, 1, 'same event row');
  assert.strictEqual(callRows(g)[0].AI_Action, 'mcc:ack_simulated');
  assert(/^attempt 2: DEMO simulated, nothing was sent; alert sent$/.test(callRows(g)[0].AI_Reason), callRows(g)[0].AI_Reason);
  assert.strictEqual(leadRows(g).filter((l) => l.Phone === NEW_CALLER).length, 1);
  assert.strictEqual(rows(g, 'Conversations').find((c) => c.Phone === NEW_CALLER).Unread, 1, 'a retry does not count the call again');
  assert.strictEqual(retry.visited.filter((n) => n === 'W12 – Simulated send').length, 1, 'only the acknowledgement: the staff alert already went');
  assert.deepStrictEqual(mccLogs(g).map((l) => l.Outcome), ['failed', 'ok']);
  assert(/\(retry\)$/.test(mccLogs(g)[1].Record));
  const again = run(call(), { w: W_SIM, g });
  assert.strictEqual(again.visited.includes('W12 – Simulated send'), false, 'closed');
  return 'attempt 1 failed (alert sent) -> repeat: attempt 2 simulated, alert not repeated, Unread still 1 -> next repeat: duplicate';
});
check('M16', 'after 3 failed tries the event stops retrying', () => {
  const g = crm();
  for (let i = 0; i < 4; i++) run(call(), { w: prep('live'), g });
  assert(/attempt 3/.test(callRows(g)[0].AI_Reason), callRows(g)[0].AI_Reason);
  const logsBefore = mccLogs(g).length;
  const x = run(call(), { w: prep('live'), g });
  assert.strictEqual(x.visited.some((n) => /Call 'W12/.test(n)), false);
  assert.strictEqual(mccLogs(g).length, logsBefore + 1);
  assert.strictEqual(mccLogs(g).slice(0, 3).every((l) => l.Outcome === 'failed'), true);
  return '3 attempts, then only a skipped duplicate row';
});
check('M17', 'a Grist failure mid-way leaves a recoverable claim, never a half-finished duplicate', () => {
  const g = crm().failAt('POST', 'LEADS', 1);
  const broken = run(call(), { g });
  assert(broken.r.error, 'the run fails loudly (W11 alerts)');
  assert.strictEqual(broken.r.error.node, 'MCC – Create lead');
  assert.strictEqual(callRows(g)[0].AI_Action, 'mcc:claimed');
  assert.strictEqual(leadRows(g).filter((l) => l.Phone === NEW_CALLER).length, 0);
  assert.strictEqual(ackRows(g).length, 0);
  const soon = run(call(), { g });
  assert(/still being processed/.test(mccLogs(g)[0].Error), 'a quick provider retry does not start a second run');
  assert.deepStrictEqual(soon.errors, []);
  const later = run(call({ timestamp: T + 590 }), { g, now: F.NOW + 600 * 1000 });
  assert.deepStrictEqual(later.errors, []);
  assert.strictEqual(callRows(g).length, 1);
  assert.strictEqual(callRows(g)[0].AI_Action, 'mcc:ack_simulated');
  assert.strictEqual(leadRows(g).filter((l) => l.Phone === NEW_CALLER).length, 1);
  return 'lead write fails: claim stays; retry in 10 min finishes the same row with one lead';
});

// ================================================================ 7. simulate mode cannot leak
check('M18', 'simulate mode sends nothing anywhere; live mode is unchanged for every other message', () => {
  const meta = fakeMeta();
  const x = run(call(), { meta });
  assert.strictEqual(meta.calls.length, 0);
  assert.strictEqual(x.openrouter.calls, 0);
  assert(!x.visited.includes('W12 – Meta send'));
  // the same W12, called by another section with an ordinary template, in live and allowlist mode: Meta IS called (fake), nothing is simulated
  for (const mode of ['live', 'allowlist']) {
    const w = prep(mode);
    const m = fakeMeta();
    const item = { json: { source_workflow: 'W5-reminders', audience: 'patient', message_type: 'template', template: 'reminder_24h', template_params: { name: 'Asha', service: 'Knee', clinic_name: 'Demo Physio', date: '07 Oct', time: '10:00' }, wa_phone_number_id: '123456789012345', decision: { send: true, to: TESTP, reason: 'ok', test_mode: true }, lead_phone: F.ASHA, grist_base_url: 'http://grist:8484', doc_id: 'DOCA', lead_row_id: 1 } };
    const r = simulate(w, { start: 'W12 – When called by another workflow', items: [item], grist: crm(), now: F.NOW, workflowId: 'MASTER', workflows: {}, meta: m, openrouter: counter() });
    assert.strictEqual(r.error, null, `${mode}: ${r.error && r.error.message}`);
    assert.strictEqual(m.calls.length, 1, `${mode}: the real path still calls Meta`);
    assert.strictEqual(m.calls[0].body.template.name, 'reminder_24h');
    assert(r.visited.includes('W12 – Meta send'));
    assert(!r.visited.includes('W12 – Simulated send'), `${mode}: the simulate branch must not run`);
    const out = r.runData['W12 – Return result'][0].json;
    assert.deepStrictEqual([out.sent, out.simulated, out.send_status], [true, false, 'accepted']);
  }
  // a mode word that merely looks like it is not simulate (typos fall back to "blocked", never to a send or a simulation)
  for (const mode of ['simulated', 'sim', 'demo', '', 'Simulate-live']) {
    const m = fakeMeta();
    const w = prep(mode);
    const r = simulate(w, { start: 'W12 – When called by another workflow', items: [{ json: { source_workflow: 'X', audience: 'patient', message_type: 'template', template: 'hello_world', wa_phone_number_id: '123456789012345', decision: { send: true, to: TESTP, reason: 'ok', test_mode: true }, lead_phone: F.ASHA } }], grist: crm(), now: F.NOW, workflowId: 'MASTER', workflows: {}, meta: m, openrouter: counter() });
    const out = r.runData['W12 – Return result'][0].json;
    assert.deepStrictEqual([out.sent, out.simulated, out.send_status, m.calls.length], [false, false, 'blocked', 0], JSON.stringify(mode));
  }
  // an item that tries to switch the mode itself is ignored (W12 strips w12_ keys from the caller's item and Config owns the mode)
  {
    const m = fakeMeta();
    const item = { json: { source_workflow: 'X', audience: 'patient', message_type: 'template', template: 'hello_world', w12_send_mode: 'simulate', simulate: true, wa_phone_number_id: '123456789012345', decision: { send: true, to: TESTP, reason: 'ok', test_mode: true, simulate: true }, lead_phone: F.ASHA, grist_base_url: 'http://grist:8484', doc_id: 'DOCA' } };
    const r = simulate(prep('live'), { start: 'W12 – When called by another workflow', items: [item], grist: crm(), now: F.NOW, workflowId: 'MASTER', workflows: {}, meta: m, openrouter: counter() });
    assert.strictEqual(m.calls.length, 1, 'live stays live');
    assert.strictEqual(r.runData['W12 – Return result'][0].json.simulated, false);
  }
  return 'simulate: 0 Meta / OpenRouter calls; live + allowlist still call Meta for ordinary templates; look-alike mode words block; item cannot switch modes';
});

// ================================================================ 7b. the scheduled retry (night, failures)
const MORNING = Date.parse('2026-10-07T08:10:00+05:30');
const tick = (o = {}) => {
  const g = o.g || crm(o.crm);
  const meta = o.meta || fakeMeta();
  const r = simulate(o.w || W_SIM, { start: 'MCC – Every 5 minutes', items: [{ json: {} }], grist: g, now: o.now || MORNING, workflowId: 'MASTER', workflows: {}, meta, openrouter: counter() });
  const runs = allRuns(r);
  return { r, g, meta, runs, errors: runs.filter((x) => x.error).map((x) => x.error), visited: runs.flatMap((x) => x.visited) };
};
const nightCall = (id = 'demo-0001', over = {}) => call({ provider_call_id: id, timestamp: Math.floor(NIGHT / 1000) - 30, ...over });
check('M20', 'a night call is captured at once and acknowledged in the morning by the scheduled retry (once, same row)', () => {
  const g = crm();
  const night = run(nightCall(), { now: NIGHT, g });
  assert.strictEqual(callRows(g)[0].AI_Action, 'mcc:ack_deferred');
  const early = tick({ g, now: Date.parse('2026-10-07T07:50:00+05:30') });
  assert.deepStrictEqual(early.errors, []);
  assert.strictEqual(early.visited.includes('W12 – Simulated send'), false, 'still quiet hours at 07:50: still deferred');
  assert.strictEqual(callRows(g)[0].AI_Action, 'mcc:ack_deferred');
  assert(/attempt 2: quiet hours/.test(callRows(g)[0].AI_Reason), callRows(g)[0].AI_Reason);
  const morning = tick({ g });
  assert.deepStrictEqual(morning.errors, []);
  assert.strictEqual(callRows(g).length, 1, 'the same event row');
  assert.strictEqual(callRows(g)[0].AI_Action, 'mcc:ack_simulated');
  assert(/^attempt 3: DEMO simulated, nothing was sent; alert simulated$/.test(callRows(g)[0].AI_Reason), callRows(g)[0].AI_Reason);
  assert.strictEqual(ackRows(g).length, 1);
  assert.strictEqual(leadRows(g).filter((l) => l.Phone === NEW_CALLER).length, 1);
  assert.strictEqual(rows(g, 'Conversations').find((c) => c.Phone === NEW_CALLER).Unread, 1, 'the retry does not count the call again');
  assert.strictEqual(morning.visited.filter((n) => n === 'W12 – Simulated send').length, 2, 'acknowledgement + the alert that was deferred');
  assert.strictEqual(morning.meta.calls.length, 0);
  const after = tick({ g, now: MORNING + 600 * 1000 });
  assert.strictEqual(after.visited.includes('MCC – Decide ack'), false, 'nothing left to retry');
  assert(!morning.visited.some((n) => /^W13 –/.test(n)));
  return 'night: captured + deferred; 07:50 still quiet; 08:10 acknowledged + alerted on the same row; next run does nothing';
});
check('M21', 'the retry leaves alone what must not be retried', () => {
  const claimed = (extra) => ({ id: 80, fields: { WA_Message_ID: 'call-old-1', Template: 'missed_call', Direction: 'In', Status: 'Received', Conversation: 1, Created_At: T - 600, AI_Action: 'mcc:ack_failed', AI_Reason: 'attempt 1: not sent: x; alert sent', ...extra } });
  const due = (extra, o = {}) => tick({ crm: { msgs: [...F.messageRows(), claimed(extra)], ...o }, now: F.NOW });
  assert(due({}).visited.includes('MCC – Decide ack'), 'sanity: a failed ack from 10 minutes ago IS retried');
  assert.strictEqual(due({ AI_Reason: 'attempt 3: not sent: x; alert sent' }).visited.includes('MCC – Decide ack'), false, '3 tries used up');
  assert.strictEqual(due({ Created_At: T - 21 * 3600 }).visited.includes('MCC – Decide ack'), false, 'older than 20 hours');
  assert.strictEqual(due({ AI_Action: 'mcc:ack_simulated' }).visited.includes('MCC – Decide ack'), false, 'done');
  assert.strictEqual(due({ AI_Action: 'mcc:ack_skipped' }).visited.includes('MCC – Decide ack'), false, 'opted out / owned: never retried');
  assert.strictEqual(due({ AI_Action: 'mcc:claimed', Conversation: undefined }).visited.includes('MCC – Decide ack'), false, 'an unlinked claim belongs to the webhook (resume), not the scheduler');
  assert.strictEqual(due({ Created_At: T - 20 }).visited.includes('MCC – Decide ack'), false, 'too fresh: the webhook run may still be working on it');
  assert.strictEqual(due({ AI_Action: 'mcc:ack_pending', Created_At: T - 60 }).visited.includes('MCC – Decide ack'), false, 'pending for 1 minute: maybe still in flight');
  assert(due({ AI_Action: 'mcc:ack_pending', Created_At: T - 300 }).visited.includes('MCC – Decide ack'), 'pending for 5 minutes: a crash, retry');
  assert.strictEqual(due({}, { settings: settings({ missed_call_enabled: 'off' }) }).visited.includes('MCC – Decide ack'), false, 'capture switched off for the clinic');
  const noNumber = new TestGrist({ [REG]: { Clinics: [{ id: 1, fields: { Clinic_Slug: 'w', Clinic_Name: 'W', Grist_Doc_ID: 'DOCA', Active: true } }] }, DOCA: docA({ msgs: [...F.messageRows(), claimed({})] }) });
  assert.strictEqual(tick({ g: noNumber, now: F.NOW }).visited.includes('MCC – Settings') || tick({ g: noNumber, now: F.NOW }).visited.includes('MCC – Retry settings'), false, 'a clinic without a Call_Number is not part of this section');
  const optedOut = tick({ crm: { msgs: [...F.messageRows(), claimed({})], leads: F.leadRows().map((l) => (l.id === 1 ? { ...l, fields: { ...l.fields, Opted_Out: true } } : l)) }, now: F.NOW });
  assert.strictEqual(ackRows(optedOut.g).length, 0, 'an opted-out lead found by the retry is still not messaged');
  assert.strictEqual(rows(optedOut.g, 'Messages').find((m) => m.id === 80).AI_Action, 'mcc:ack_skipped');
  return '3 tries / 21 h old / done / skipped / unlinked / too fresh / switched off / no Call_Number: not retried; 10 min old failed + 5 min old pending: retried; opted-out stays silent';
});
check('M22', 'one event per run, oldest first; a retry that fails again counts its tries and stops at 3', () => {
  const g = crm();
  run(nightCall('demo-0001', { caller_number: '+919000000021' }), { now: NIGHT, g });
  run(nightCall('demo-0002', { caller_number: '+919000000022' }), { now: NIGHT + 60000, g });
  assert.deepStrictEqual(callRows(g).map((m) => m.AI_Action), ['mcc:ack_deferred', 'mcc:ack_deferred']);
  const a = tick({ g });
  assert.deepStrictEqual(callRows(g).map((m) => m.AI_Action), ['mcc:ack_simulated', 'mcc:ack_deferred'], 'the older one first');
  const b = tick({ g, now: MORNING + 300000 });
  assert.deepStrictEqual(callRows(g).map((m) => m.AI_Action), ['mcc:ack_simulated', 'mcc:ack_simulated']);
  const c = tick({ g, now: MORNING + 600000 });
  assert.strictEqual(c.visited.includes('MCC – Decide ack'), false);
  assert.strictEqual(ackRows(g).length, 2);
  // failing again (live mode refuses the simulate-only template): tries are counted and stop at 3
  const g2 = crm();
  run(call(), { w: prep('live'), g: g2 });
  tick({ g: g2, w: prep('live'), now: F.NOW + 120000 });
  tick({ g: g2, w: prep('live'), now: F.NOW + 240000 });
  assert(/attempt 3/.test(callRows(g2)[0].AI_Reason), callRows(g2)[0].AI_Reason);
  const stopped = tick({ g: g2, w: prep('live'), now: F.NOW + 360000 });
  assert.strictEqual(stopped.visited.includes('MCC – Decide ack'), false, '3 tries then no more');
  assert.deepStrictEqual(mccLogs(g2).map((l) => l.Outcome), ['failed', 'failed', 'failed']);
  assert.strictEqual(callRows(g2)[0].AI_Action, 'mcc:ack_failed');
  return 'two deferred events cleared oldest-first over two runs; a persistently failing ack: 3 failed Run_Log rows, then silence';
});

// ================================================================ 8. wiring and shape
check('M19', 'wiring: one new webhook, no Meta node outside W12, section nodes prefixed MCC, connections point at real nodes', () => {
  const names = new Set(base.nodes.map((n) => n.name));
  assert.strictEqual(names.size, base.nodes.length, 'unique node names');
  const mcc = base.nodes.filter((n) => /^MCC – /.test(n.name));
  assert(mcc.length >= 45, `${mcc.length} MCC nodes`);
  for (const [from, c] of Object.entries(base.connections)) for (const out of c.main) for (const t of out) assert(names.has(t.node), `${from} -> ${t.node}`);
  const meta = base.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest' && /graph\.facebook\.com|meta_url/.test(JSON.stringify(n.parameters)));
  assert.deepStrictEqual(meta.map((n) => n.name), ['W12 – Meta send'], 'W12 is still the only sender');
  assert.deepStrictEqual(mcc.filter((n) => n.type === 'n8n-nodes-base.webhook').map((n) => `${n.parameters.httpMethod} /${n.parameters.path}`), ['POST /missed-call']);
  for (const n of mcc.filter((x) => x.type === 'n8n-nodes-base.httpRequest')) assert(!/openrouter|ollama|graph\.facebook/.test(JSON.stringify(n.parameters)), `${n.name} calls a model / Meta`);
  for (const n of mcc.filter((x) => x.type === 'n8n-nodes-base.code')) new Function('$', '$input', '$json', '$getWorkflowStaticData', n.parameters.jsCode);   // compiles
  const calls = mcc.filter((n) => n.type === 'n8n-nodes-base.executeWorkflow');
  assert.strictEqual(calls.length, 2);
  for (const n of calls) assert.strictEqual(n.parameters.workflowId.value, '={{ $workflow.id }}');
  const ids = base.nodes.map((n) => n.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'unique node ids');
  return `${mcc.length} MCC nodes, 1 webhook, 2 W12 calls via $workflow.id, W12 – Meta send is the only Meta node`;
});

// ---------------------------------------------------------------- report
const width = Math.max(...results.map((r) => `${r.id} ${r.title}`.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${`${r.id} ${r.title}`.padEnd(width)}  ${r.why}`);
const bad = results.filter((r) => !r.ok);
console.log(`\nMISSED_CALL_CAPTURE: ${results.length - bad.length} of ${results.length} checks pass on ${path.basename(FILE)}`);
process.exit(bad.length ? 1 : 0);
