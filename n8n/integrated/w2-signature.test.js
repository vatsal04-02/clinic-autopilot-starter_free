// W2 META SIGNATURE end to end on the SHIPPED workflow JSON in the simulator: the POST /webhook/whatsapp-inbound is only processed when
// X-Hub-Signature-256 = sha256=HMAC-SHA256(App Secret, raw body). Forged / unsigned / tampered / re-serialised requests get a 401 and nothing is read or written.
// Fake Grist, fake Meta, fake AI. Made-up numbers and a made-up App Secret. Nothing touches the network.
// WHAT THIS DOES NOT PROVE: that your n8n Webhook node delivers the raw body as binary property "data" when "Raw Body" is on. The simulator is given
// that shape; a real n8n has to be checked once by hand (see W2-SIGNATURE.md, step "check it live").
// Run: node n8n/integrated/w2-signature.test.js        (SIG_FILE=<file>: test another build, e.g. the combined demo workflow)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const http = require('http');
const https = require('https');
const net = require('net');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const trap = () => { throw new Error('this test must not touch the network'); };
global.fetch = trap; http.request = trap; http.get = trap; https.request = trap; https.get = trap; net.connect = trap; net.createConnection = trap;

const { simulate, FakeGrist, COLUMNS, CHOICES, DATETIME, TOGGLE } = require('../tests/n8n-sim');
const F = require('../tests/ai-fixtures');

const MASTER = path.join(__dirname, 'clinic-autopilot-master-ai.json');
const clone = (o) => JSON.parse(JSON.stringify(o));
const suite = [];
const test = (name, fn) => suite.push({ name, fn });

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w2sig-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const patch = (input, name, extra = []) => {
  const out = path.join(TMP, name);
  try { fs.unlinkSync(out); } catch (e) { /* none */ }
  const r = spawnSync(process.execPath, [path.join(__dirname, 'apply-w2-signature.js'), '--in', input, '--out', out, ...extra], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout, out, exists: fs.existsSync(out) };
};
const MASTER_WF = JSON.parse(fs.readFileSync(MASTER, 'utf8'));
let SIG_WF;
if (process.env.SIG_FILE) SIG_WF = JSON.parse(fs.readFileSync(process.env.SIG_FILE, 'utf8'));
else { const a = patch(MASTER, 'sig.json'); assert.strictEqual(a.status, 0, a.stderr); SIG_WF = JSON.parse(fs.readFileSync(process.env.SIG_MUTANT || a.out, 'utf8')); }

COLUMNS.LEADS = COLUMNS.Leads.map((c) => (c === 'Lead_ID' ? 'Lead_id' : c));
for (const k of Object.keys(CHOICES)) if (k.startsWith('Leads.')) CHOICES[k.replace('Leads.', 'LEADS.')] = CHOICES[k];
for (const set of [DATETIME, TOGGLE]) for (const k of [...set]) if (k.startsWith('Leads.')) set.add(k.replace('Leads.', 'LEADS.'));
CHOICES['Messages.Status'] = [...CHOICES['Messages.Status'], 'Received'];

const PNID = '123456789012345';
const REG = 'fAft6pAYwFUU';
const P_ASHA = '919000000011';
const OWNER = '+919000000018', TESTP = '+919000000019';
const VERIFY = 'test-verify-token-123';
const APP_SECRET = 'test-app-secret-0123456789abcdef';   // made up
const setCfg = (w, node, key, v) => { w.nodes.find((n) => n.name === node).parameters.assignments.assignments.find((a) => a.name === key).value = v; return w; };
const prepare = (base, { secret = APP_SECRET, mode } = {}) => {
  const w = clone(base);
  setCfg(w, 'W12 – Config', 'w12_allowlist', `+${P_ASHA},+919000000012,+919000000013,+919000000014,${OWNER},${TESTP}`);
  setCfg(w, 'W2 – Verify Config', 'meta_verify_token', VERIFY);
  if (w.nodes.some((n) => n.name === 'W2 – Signature Config')) {
    if (secret !== undefined) setCfg(w, 'W2 – Signature Config', 'meta_app_secret', secret);
    if (mode !== undefined) setCfg(w, 'W2 – Signature Config', 'w2_signature_mode', mode);
  }
  return w;
};
const WF = prepare(SIG_WF);
const crm = () => new FakeGrist({
  [REG]: { Clinics: [{ id: 1, fields: { Clinic_Slug: 'demo-clinic', Clinic_Name: 'Demo Physio', Grist_Doc_ID: 'DOCA', WA_Phone_Number_ID: PNID, Active: true } }] },
  DOCA: { Settings: F.settingsRows({ TEST_MODE: 'false' }), Knowledge: clone(F.KNOWLEDGE), LEADS: F.leadRows(), Conversations: F.conversationRows(), Messages: F.messageRows(), Appointments: F.appointmentRows(), Run_Log: [] },
});
const fakeMeta = () => { const calls = []; const fn = (method, url, body) => { calls.push({ url, body }); return { status: 200, body: { messages: [{ id: `wamid.SENT.${calls.length}` }] } }; }; fn.calls = calls; return fn; };
const metaBody = (text, id = `wamid.IN.${Math.random().toString(36).slice(2, 8)}`, from = P_ASHA) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'TEST_WABA_ID', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: PNID }, contacts: [{ profile: { name: 'Asha Patel' }, wa_id: from }], messages: [{ from, id, timestamp: String(F.sec(F.NOW) - 5), type: 'text', text: { body: text } }] } }] }],
});
// Meta sends ASCII JSON with \uXXXX escapes; sign exactly those bytes
const metaRaw = (body) => JSON.stringify(body).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const sign = (raw, secret = APP_SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
const allRuns = (r) => [r, ...r.subRuns.flatMap(allRuns)];
// A request: the Webhook node's output (json: headers / params / query / parsed body; binary.data = the raw body, base64) as n8n gives it with "Raw Body" on.
function request(text, o = {}) {
  const body = o.body || metaBody(text, o.id);
  const raw = o.raw !== undefined ? o.raw : metaRaw(body);
  const headers = o.headers !== undefined ? o.headers : { 'content-type': 'application/json', 'x-hub-signature-256': o.signature || sign(raw, o.secret) };
  const item = { json: { headers, params: {}, query: {}, body: o.parsed !== undefined ? o.parsed : JSON.parse(raw) } };
  if (o.binary !== false) item.binary = { data: { data: Buffer.from(o.binaryRaw !== undefined ? o.binaryRaw : raw).toString('base64'), mimeType: 'application/json' } };
  return item;
}
function post(item, o = {}) {
  const g = o.g || crm();
  const meta = fakeMeta();
  const claude = F.fakeClaude();
  const r = simulate(o.w || WF, { start: 'W2 – Webhook Inbound', items: [item], grist: g, now: F.NOW, workflowId: 'MASTER', workflows: {}, meta, openrouter: F.fakeOpenRouter(claude), ollama: F.fakeOllama(claude) });
  const runs = allRuns(r);
  return { g, meta, claude, r, runs, visited: new Set(runs.flatMap((x) => x.visited)), codes: r.responses.map((x) => x.code), writes: g.calls.filter((c) => c.method !== 'GET') };
}
const rows = (g, t) => g.docs.DOCA[t].map((x) => ({ id: x.id, ...x.fields }));
const untouched = (x) => assert.deepStrictEqual([x.writes.length, x.meta.calls.length, x.claude.calls.length, x.visited.has('W2 – Parse Meta Event'), x.visited.has('W2 – Clinics')], [0, 0, 0, false, false], 'nothing was read, written or sent');

console.log(`W2 signature on: ${process.env.SIG_FILE ? path.basename(process.env.SIG_FILE) : 'master + apply-w2-signature.js'}`);

test('S1 the patch changes ONE existing node (the webhook gets "Raw Body") and ADDS four; the rest of W2, credentials and every other webhook are identical', () => {
  if (process.env.SIG_FILE) return;
  const A = Object.fromEntries(MASTER_WF.nodes.map((n) => [n.name, n]));
  const B = Object.fromEntries(SIG_WF.nodes.map((n) => [n.name, n]));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  assert.deepStrictEqual(Object.keys(A).filter((n) => !B[n]), []);
  assert.deepStrictEqual(Object.keys(B).filter((n) => !A[n]).sort(), ['W2 – Respond Unauthorized', 'W2 – Signature Config', 'W2 – Signature OK?', 'W2 – Verify Signature']);
  assert.deepStrictEqual(Object.keys(A).filter((n) => !same(A[n], B[n])), ['W2 – Webhook Inbound']);
  assert.deepStrictEqual(B['W2 – Webhook Inbound'].parameters, { httpMethod: 'POST', path: 'whatsapp-inbound', responseMode: 'responseNode', options: { rawBody: true } });
  const changedConn = Object.keys(MASTER_WF.connections).filter((k) => !same(MASTER_WF.connections[k], SIG_WF.connections[k]));
  assert.deepStrictEqual(changedConn, ['W2 – Webhook Inbound']);
  assert.deepStrictEqual(SIG_WF.connections['W2 – Signature OK?'].main.map((l) => l.map((c) => c.node)), [['W2 – Config'], ['W2 – Respond Unauthorized']]);
  assert.deepStrictEqual(SIG_WF.connections['W2 – Webhook Inbound'].main[0].map((c) => c.node), ['W2 – Signature Config']);
  for (const n of Object.keys(A)) assert.deepStrictEqual(B[n].credentials, A[n].credentials, n);
  assert(SIG_WF.nodes.filter((n) => /webhook/i.test(n.type) && n.name !== 'W2 – Webhook Inbound' && A[n.name]).every((n) => same(n, A[n.name])), 'every other existing webhook / respond node is identical');
  assert.strictEqual(SIG_WF.nodes.filter((n) => /\.webhook$/i.test(n.type)).length, MASTER_WF.nodes.filter((n) => /\.webhook$/i.test(n.type)).length, 'no new webhook');
  const cfg = B['W2 – Signature Config'].parameters.assignments.assignments.map((a) => [a.name, a.value]);
  assert.deepStrictEqual(cfg, [['meta_app_secret', 'REPLACE_WITH_META_APP_SECRET'], ['w2_signature_mode', 'enforce']], 'shipped with a placeholder secret and the strict mode');
  assert.strictEqual(B['W2 – Respond Unauthorized'].parameters.options.responseCode, 401);
  assert(!/graph\.facebook|fetch|http/i.test(B['W2 – Verify Signature'].parameters.jsCode.replace(/https?:\/\/\S+/g, '').replace(/\/\/.*$/gm, '')), 'the check does no network call');
  assert.strictEqual(SIG_WF.active, false);
  const twice = patch(path.join(TMP, 'sig.json'), 'twice.json');
  assert(twice.status === 1 && /already has "W2 – Signature Config"/.test(twice.stderr) && !twice.exists);
  const edited = clone(MASTER_WF); edited.nodes.find((n) => n.name === 'W2 – Webhook Inbound').parameters.options = { ignoreBots: true };
  const f = path.join(TMP, 'edited.json'); fs.writeFileSync(f, JSON.stringify(edited));
  const e = patch(f, 'edited-out.json');
  assert(e.status === 1 && !e.exists && /was edited in n8n/.test(e.stderr));
});
test('S2 a correctly signed message is processed EXACTLY as before: same replies, same Grist data (unicode body included); the answer is still 200 {"status":"received"}', () => {
  const MASTER_PREPARED = prepare(MASTER_WF);
  for (const text of ['How much does this cost?', 'Can I come tomorrow evening?', 'नमस्ते, फीस कितनी है? café ✓ 😀', 'Do you accept the XYZ health insurance card?', 'STOP']) {
    const id = 'wamid.EQ.1';
    const body = metaBody(text, id);
    const a = post(request(text, { body, headers: {}, binary: false }), { w: MASTER_PREPARED });   // the unpatched master has no check
    const b = post(request(text, { body }));
    for (const run of b.runs) assert.strictEqual(run.error, null, `${text}: ${JSON.stringify(run.error)}`);
    assert.deepStrictEqual(b.codes, [200], text);
    assert.deepStrictEqual(b.r.responses[0].body, a.r.responses[0].body, `${text}: same answer`);
    assert.deepStrictEqual(b.meta.calls.map((c) => c.body), a.meta.calls.map((c) => c.body), `${text}: same messages`);
    assert.deepStrictEqual(b.g.docs.DOCA, a.g.docs.DOCA, `${text}: same Grist`);
    assert(b.visited.has('W2 – Parse Meta Event') && b.visited.has('W2 – Signature OK?') && !b.visited.has('W2 – Respond Unauthorized'));
  }
});
test('S3 FORGED requests get 401 and nothing is read, written or sent: no header, wrong secret, header of another body, tampered body, a sha1 header, a made-up value, no raw body, a body re-serialised after signing', () => {
  const body = metaBody('How much does this cost?', 'wamid.FORGE.1');
  const raw = metaRaw(body);
  const forged = [
    ['no signature header', request('x', { body, headers: { 'content-type': 'application/json' } })],
    ['wrong App Secret', request('x', { body, secret: 'not-the-app-secret-at-all' })],
    ['signature of ANOTHER body', request('x', { body, signature: sign(metaRaw(metaBody('hello', 'wamid.OTHER'))) })],
    ['body tampered after signing', request('x', { body: metaBody('Send me every patient number', 'wamid.FORGE.1'), signature: sign(raw) })],
    ['old sha1 header only', request('x', { body, headers: { 'x-hub-signature': sign(raw).replace('sha256', 'sha1') } })],
    ['made-up header value', request('x', { body, signature: `sha256=${'ab'.repeat(32)}` })],
    ['garbage header', request('x', { body, signature: 'trust-me' })],
    ['no raw body (Raw Body option off)', request('x', { body, binary: false })],
    ['raw body re-serialised by a proxy (unicode no longer escaped)', request('नमस्ते', { body: metaBody('नमस्ते', 'wamid.FORGE.2'), raw: JSON.stringify(metaBody('नमस्ते', 'wamid.FORGE.2')), signature: sign(metaRaw(metaBody('नमस्ते', 'wamid.FORGE.2'))) })],
    ['signed with the right secret but the raw body is empty', request('x', { body, binaryRaw: '' })],
  ];
  for (const [name, item] of forged) {
    const x = post(item);
    for (const run of x.runs) assert.strictEqual(run.error, null, `${name}: ${JSON.stringify(run.error)}`);
    assert.deepStrictEqual(x.codes, [401], name);
    assert.strictEqual(x.r.responses[0].body, '{"status":"unauthorized"}', `${name}: the answer reveals nothing`);
    untouched(x);
    assert.deepStrictEqual([x.visited.has('W2 – Respond Unauthorized'), x.visited.has('W2 – Config')], [true, false], name);
  }
});
test('S4 the secret is a PLACEHOLDER in the shipped file, so enforce mode rejects EVERYTHING (even a request "signed" with the placeholder) until it is set - fail closed', () => {
  const w = prepare(SIG_WF, { secret: 'REPLACE_WITH_META_APP_SECRET' });
  for (const secret of [undefined, 'REPLACE_WITH_META_APP_SECRET', 'short']) {
    const body = metaBody('How much does this cost?', 'wamid.PH.1');
    const x = post(request('x', { body, secret: secret || 'x' }), { w });
    assert.deepStrictEqual(x.codes, [401], `secret ${secret}`);
    untouched(x);
  }
  const unset = prepare(SIG_WF, { secret: '' });
  assert.deepStrictEqual(post(request('x'), { w: unset }).codes, [401]);
});
test('S5 modes: any word but "log" / "off" is enforce; "log" lets a forged request through (a roll-out aid, not a protection); "off" is today\'s behaviour', () => {
  const body = metaBody('How much does this cost?', 'wamid.MODE.1');
  const forged = request('x', { body, secret: 'not-the-app-secret-at-all' });
  for (const mode of ['enforce', 'ENFORCE', 'on', 'yes', 'true', 'strict', ' ', 'lgo']) {
    assert.deepStrictEqual(post(forged, { w: prepare(SIG_WF, { mode }) }).codes, [401], `mode "${mode}"`);
  }
  const log = post(forged, { w: prepare(SIG_WF, { mode: 'log' }) });
  assert.deepStrictEqual(log.codes, [200], 'log: processed');
  assert(log.meta.calls.length > 0);
  const sigNode = log.runs[0].runData['W2 – Verify Signature'][0].json;
  assert.deepStrictEqual([sigNode.__w2_sig, /does not match/.test(sigNode.__w2_sig_reason)], ['warn', true], 'log mode records that it did not verify');
  const off = post(request('x', { body, headers: {}, binary: false }), { w: prepare(SIG_WF, { mode: 'off', secret: '' }) });
  assert.deepStrictEqual(off.codes, [200]);
  assert.strictEqual(off.runs[0].runData['W2 – Verify Signature'][0].json.__w2_sig, 'skipped');
});
test('S6 the App Secret never leaves the two nodes that need it: not in the data that flows on, not in any other node\'s output, not in an answer', () => {
  const body = metaBody('How much does this cost?', 'wamid.LEAK.1');
  const x = post(request('x', { body }));
  const dump = (r) => Object.entries(r.runData).filter(([n]) => n !== 'W2 – Signature Config').map(([n, items]) => [n, JSON.stringify(items.map((i) => i.json))]);
  for (const run of x.runs) for (const [n, s] of dump(run)) assert(!s.includes(APP_SECRET), `the App Secret appears in the output of ${n}`);
  assert(!JSON.stringify(x.r.responses).includes(APP_SECRET));
  assert(!JSON.stringify(x.g.docs).includes(APP_SECRET), 'and not in Grist');
  // nor does the raw body travel on (it would double every item)
  for (const [n, items] of Object.entries(x.r.runData)) if (n !== 'W2 – Webhook Inbound') assert(items.every((i) => !i.binary), `${n} carries the raw body`);
  const verify = x.r.runData['W2 – Verify Signature'][0].json;
  assert.deepStrictEqual(Object.keys(verify).sort(), ['__w2_sig', '__w2_sig_reason', 'body', 'headers', 'params', 'query']);
});
test('S7 the other doors of W2 are unchanged: the Meta GET verification (token) answers as before, and the manual test node skips the check', () => {
  const run = (token) => simulate(WF, { start: 'W2 – Webhook Verify', items: [{ json: { headers: {}, params: {}, body: {}, query: { 'hub.mode': 'subscribe', 'hub.verify_token': token, 'hub.challenge': '12345' } } }], grist: crm(), now: F.NOW, workflowId: 'MASTER' });
  let r = run(VERIFY);
  assert.deepStrictEqual([r.responses.map((x) => x.code), r.responses[0].body], [[200], '12345']);
  r = run('wrong-token');
  assert.deepStrictEqual(r.responses.map((x) => x.code), [403]);
  const t = simulate(WF, { start: 'W2 – Test Cases', items: [{ json: {} }], grist: crm(), now: F.NOW, workflowId: 'MASTER', workflows: {}, meta: fakeMeta() });
  assert(!t.visited.includes('W2 – Verify Signature') && t.visited.includes('W2 – Config'), 'the manual test cases do not go through the signature check');
});
test('S8 a duplicate delivery (Meta retries with the same signed body) is processed once; a replay of an old signed body is deduplicated by message id, as before', () => {
  const body = metaBody('How much does this cost?', 'wamid.DUP.1');
  const g = crm();
  const a = post(request('x', { body }), { g });
  const b = post(request('x', { body }), { g });
  assert.deepStrictEqual([a.codes, b.codes], [[200], [200]]);
  assert.strictEqual(rows(g, 'Messages').filter((m) => m.WA_Message_ID === 'wamid.DUP.1').length, 1);
});
test('S9 a large signed delivery (100 messages, ~60 KB) verifies', () => {
  const body = metaBody('x', 'wamid.BIG.0');
  const msgs = Array.from({ length: 100 }, (_, i) => ({ from: P_ASHA, id: `wamid.BIG.${i}`, timestamp: String(F.sec(F.NOW) - 5), type: 'text', text: { body: `message number ${i} ${'lorem ipsum '.repeat(40)} é` } }));
  body.entry[0].changes[0].value.messages = msgs;
  const raw = metaRaw(body);
  assert(raw.length > 50000, `body is ${raw.length} bytes`);
  const x = post(request('x', { body, raw }));
  assert.deepStrictEqual(x.codes, [200]);
  assert.strictEqual(x.runs[0].runData['W2 – Verify Signature'][0].json.__w2_sig, 'ok');
});

let failed = 0;
for (const t of suite) {
  try { t.fn(); console.log(`PASS  ${t.name}`); } catch (e) { failed++; console.log(`FAIL  ${t.name}\n      ${String(e.stack || e.message).split('\n').slice(0, 9).join('\n      ')}`); }
}
console.log(failed ? `\n${failed} of ${suite.length} W2 SIGNATURE CHECKS FAILED` : `\nW2 SIGNATURE: ${suite.length} of ${suite.length} checks pass`);
process.exit(failed ? 1 : 0);
