// The OFFLINE demo world: the combined demo workflow (clinic-autopilot-demo.json) running in the in-repo n8n simulator, with
//   - a fake Grist holding ONLY synthetic data (demo-data.js),
//   - a SCRIPTED model behind the Ollama node (no model runs; it can be switched to "down"),
//   - a Meta that must never be called (W12 is in simulate mode) and an OpenRouter that must never be called (no paid AI),
//   - the patient / phone side built by console-lib.js (signed WhatsApp requests, missed-call requests): the same bytes the console sends.
// It is the engine of run-demo.js (the readable transcript) and demo.test.js (the assertions). Nothing here reaches the network.
const fs = require('fs');
const path = require('path');
const { simulate, FakeGrist, COLUMNS, CHOICES, DATETIME, TOGGLE } = require('../tests/n8n-sim');
const F = require('../tests/ai-fixtures');
const lib = require('./console-lib');
const { DEMO, clinicDoc, registry } = require('./demo-data');

const FILE = process.env.DEMO_WORKFLOW_FILE || path.join(__dirname, 'clinic-autopilot-demo.json');
const clone = (o) => JSON.parse(JSON.stringify(o));

// the live CRM's table / column names (LEADS, Lead_id) and the values this demo writes
COLUMNS.LEADS = COLUMNS.Leads.map((c) => (c === 'Lead_ID' ? 'Lead_id' : c));
for (const k of Object.keys(CHOICES)) if (k.startsWith('Leads.')) CHOICES[k.replace('Leads.', 'LEADS.')] = CHOICES[k];
for (const set of [DATETIME, TOGGLE]) for (const k of [...set]) if (k.startsWith('Leads.')) set.add(k.replace('Leads.', 'LEADS.'));
if (!CHOICES['Messages.Status'].includes('Received')) CHOICES['Messages.Status'] = [...CHOICES['Messages.Status'], 'Received'];

// Values a user pastes after importing (made up, in memory only). The committed file holds placeholders.
const SECRETS = { callSecret: 'demo-call-secret-0123456789', appSecret: 'demo-app-secret-0123456789abcdef', verifyToken: 'demo-verify-token' };

class DemoGrist extends FakeGrist {
  handle(method, url, query, body) {
    const m = String(url).match(/\/tables\/([^/]+)\/records/);
    this.count = this.count || {};
    this.fail = this.fail || [];
    const key = `${method} ${m ? m[1] : ''}`;
    this.count[key] = (this.count[key] || 0) + 1;
    if (this.fail.some((x) => x.key === key && x.nth === this.count[key])) throw new Error('Grist 500: injected failure');
    return super.handle(method, url, query, body);
  }
  failAt(method, table, nth = 1) { (this.fail = this.fail || []).push({ key: `${method} ${table}`, nth: (this.count && this.count[`${method} ${table}`] || 0) + nth }); return this; }
}

// the scripted model: fakeDecide (the repo's deterministic stand-in for Claude) plus the few demo lines it does not know
function demoDecide(req) {
  const text = req.messages[0].content.replace(/<\/?patient_message>/g, '').trim();
  const facts = req.system.map((b) => b.text).join('\n');
  const d = F.fakeDecide(req);
  const kb = (ref) => (facts.match(new RegExp(`^\\[${ref}\\][^\\n]*`, 'm')) || [''])[0];
  if (/\b(kab tak khule|timing|opening hours|open hours)\b/i.test(text)) {
    return { ...d, intent: 'location_hours', action: 'reply', needs_human: false, confidence: 0.93, kb_refs: ['K4'], reply: 'We are open Monday to Saturday, 9 AM to 7 PM, and closed on Sunday.', handoff_reason: '' };
  }
  if (/^namaste[.!]*$/i.test(text)) return { ...d, intent: 'greeting', action: 'reply', needs_human: false, confidence: 0.95, reply: 'Namaste! This is Demo Physio. How can we help you today?', kb_refs: [] };
  if (/(\w+day)\s+(\d+)\s*baje/i.test(text)) {   // "Thursday 5 baje appointment chahiye" -> the same booking decision as "Book me for Thursday at 5."
    const [, day, hour] = text.match(/(\w+day)\s+(\d+)\s*baje/i);
    return F.fakeDecide({ ...req, messages: [{ ...req.messages[0], content: `<patient_message>Book me for ${day} at ${hour}.</patient_message>` }] });
  }
  if (/first visit ki fees|fees kitne/i.test(text)) return F.fakeDecide({ ...req, messages: [{ ...req.messages[0], content: '<patient_message>how much is the first visit</patient_message>' }] });
  return d;
}

class World {
  constructor(o = {}) {
    this.opts = o;
    this.wf = clone(JSON.parse(fs.readFileSync(o.file || FILE, 'utf8')));
    const set = (node, key, v) => { this.wf.nodes.find((n) => n.name === node).parameters.assignments.assignments.find((a) => a.name === key).value = v; };
    for (const n of this.wf.nodes) if (n.type === 'n8n-nodes-base.set') for (const a of n.parameters.assignments.assignments) if (a.name === 'registry_doc_id') a.value = DEMO.registryDocKey;
    set('W12 – Config', 'w12_allowlist', `${DEMO.owner},${DEMO.testPhone}`);
    set('W2 – Verify Config', 'meta_verify_token', SECRETS.verifyToken);
    set('MCC – Config', 'mcc_webhook_secret', SECRETS.callSecret);
    set('W2 – Signature Config', 'meta_app_secret', SECRETS.appSecret);
    if (o.config) for (const [node, key, v] of o.config) set(node, key, v);
    if (o.nightWorks === false) for (const n of this.wf.nodes) if (n.parameters && typeof n.parameters.jsCode === 'string') n.parameters.jsCode = n.parameters.jsCode.replace(/DISABLE_QUIET_HOURS_FOR_TEST\s*=\s*true/g, 'DISABLE_QUIET_HOURS_FOR_TEST = false');
    this.g = new DemoGrist({ [DEMO.registryDocKey]: registry(), [DEMO.clinic.docKey]: clinicDoc(o.settings) });
    this.now = o.now || F.NOW;
    this.ollamaDown = false;
    this.metaCalls = [];
    this.openrouterCalls = [];
    this.claude = F.fakeClaude((req) => (this.ollamaDown ? { throw: 'connect ECONNREFUSED 127.0.0.1:11434' } : demoDecide(req)));
    this.ollama = F.fakeOllama(this.claude);
    this.seq = 0;
    this.errors = [];
  }
  get doc() { return this.g.docs[DEMO.clinic.docKey]; }
  rows(t) { return this.doc[t].map((x) => ({ id: x.id, ...x.fields })); }
  advance(minutes) { this.now += minutes * 60000; return this; }
  nowSec() { return Math.floor(this.now / 1000); }
  mark() { return { msg: this.doc.Messages.length ? Math.max(...this.doc.Messages.map((m) => m.id)) : 0, log: this.doc.Run_Log.length ? Math.max(...this.doc.Run_Log.map((m) => m.id)) : 0, calls: this.g.calls.length, claude: this.claude.calls.length, ollama: this.ollama.calls.length }; }
  since(mk) { return { messages: this.rows('Messages').filter((m) => m.id > mk.msg), log: this.rows('Run_Log').filter((m) => m.id > mk.log), writes: this.g.calls.slice(mk.calls).filter((c) => c.method !== 'GET'), claude: this.claude.calls.length - mk.claude, ollama: this.ollama.calls.length - mk.ollama }; }

  run(start, item, o = {}) {
    const meta = (method, url) => { this.metaCalls.push({ method, url }); throw new Error('Meta must not be called in the demo (W12 is in simulate mode)'); };
    const openrouter = (method, url) => { this.openrouterCalls.push({ method, url }); throw new Error('OpenRouter must not be called in the demo (local AI only)'); };
    const r = simulate(this.wf, { start, items: [item], grist: this.g, now: this.now, workflowId: 'MASTER', workflows: {}, meta, openrouter, ollama: this.ollama });
    const all = (x) => [x, ...x.subRuns.flatMap(all)];
    const runs = all(r);
    const errors = runs.filter((x) => x.error).map((x) => x.error);
    this.errors.push(...errors);
    return { r, runs, errors, visited: runs.flatMap((x) => x.visited), responses: r.responses.map((x) => ({ code: x.code, body: x.body ? safeJson(x.body) : null })) };
  }
  // ---- the outside world
  missedCall({ caller, id, called = DEMO.clinic.callNumber, secret = SECRETS.callSecret, status = 'missed', at } = {}) {
    const req = lib.missedCallRequest({ providerCallId: id || `demo-call-${++this.seq}`, calledNumber: called, callerNumber: caller, timestampSec: at || this.nowSec() - 5, status }, secret);
    return this.run('MCC – Webhook', { json: { headers: req.headers, body: req.body, query: {}, params: {} } });
  }
  // tamper: the body changes after it was signed (the signature no longer matches the bytes that arrive)
  say({ from, text, id, secret = SECRETS.appSecret, tamper = false } = {}) {
    const req = lib.whatsappRequest({ text, from, id: id || `wamid.DEMO.${++this.seq}`, phoneNumberId: DEMO.clinic.waPhoneNumberId, timestampSec: this.nowSec() - 3 }, secret);
    const raw = tamper ? req.raw.replace(/"body":"[^"]*"/, '"body":"TAMPERED"') : req.raw;
    return this.run('W2 – Webhook Inbound', { json: { headers: req.headers, params: {}, query: {}, body: JSON.parse(raw) }, binary: { data: { data: Buffer.from(raw).toString('base64'), mimeType: 'application/json' } } });
  }
  forged(text, from) {   // a request that is not signed with the App Secret
    return this.say({ from, text, secret: 'not-the-app-secret' });
  }
  tick(name) { return this.run(name, { json: {} }); }
  // ---- the team's side (what FLOW HQ / Grist do): only Grist rows through the same API the workflows use (ids, column and choice checks included), never a message
  grist(method, table, body) { return this.g.handle(method, `/api/docs/${DEMO.clinic.docKey}/tables/${table}/records`, {}, body); }
  staffSetStatus(apptId, status) { this.grist('PATCH', 'Appointments', { records: [{ id: apptId, fields: { Status: status } }] }); }
  staffReply(conversationId, body, name = 'Reception') {
    this.grist('POST', 'Messages', { records: [{ fields: { Conversation: conversationId, Direction: 'Out', Body: body, Sent_By: name, Send: true, Created_At: this.nowSec() } }] });
    return Math.max(...this.doc.Messages.map((m) => m.id));
  }
}
function safeJson(s) { try { return JSON.parse(s); } catch (e) { return s; } }

module.exports = { World, SECRETS, demoDecide, DemoGrist };
