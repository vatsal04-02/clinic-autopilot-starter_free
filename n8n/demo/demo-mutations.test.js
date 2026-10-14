// Mutation tests for the demo: each rule the demo depends on is broken once in a copy of the combined workflow, and the scripted demo must then FAIL
// at the step that covers it. Run: node n8n/demo/demo-mutations.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { runScenario } = require('./scenario');

const FILE = process.env.DEMO_WORKFLOW_FILE || path.join(__dirname, 'clinic-autopilot-demo.json');
const BASE = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const node = (w, n) => { const x = w.nodes.find((y) => y.name === n); assert(x, `no node ${n}`); return x; };
const cfg = (w, n, key, v) => { const a = node(w, n).parameters.assignments.assignments.find((x) => x.name === key); assert(a, `${n} > ${key}`); a.value = v; };
// replace text in the named nodes (all nodes containing it when names is null)
const code = (w, names, from, to) => {
  const targets = names ? [].concat(names).map((n) => node(w, n)) : w.nodes.filter((x) => x.parameters && typeof x.parameters.jsCode === 'string' && x.parameters.jsCode.includes(from));
  assert(targets.length, `mutation target missing: ${from.slice(0, 70)}`);
  for (const x of targets) { assert(x.parameters.jsCode.includes(from), `${x.name}: mutation target missing: ${from.slice(0, 70)}`); x.parameters.jsCode = x.parameters.jsCode.split(from).join(to); }
};
const M = [
  ['W12 is not in simulate mode (a real send path)', (w) => cfg(w, 'W12 – Config', 'w12_send_mode', 'live'), ['A1']],
  ['a simulated send is still read as a failure by W13', (w) => code(w, 'W13 – Record Sends', "sends[k] = { ...sends[k], sent: true, send_status: 'simulated' }", 'sends[k] = sends[k]'), ['B1', 'B2']],
  ['a simulated staff reply is still read as a failure by W10', (w) => code(w, 'W10 – Record', 'j.simulated === true ?', 'false ?'), ['D1']],
  ['the W2 signature check is switched off', (w) => cfg(w, 'W2 – Signature Config', 'w2_signature_mode', 'off'), ['B3']],
  ['the AI provider is a paid one (OpenRouter) again', (w) => cfg(w, 'W13 – Config', 'model_provider', 'openrouter'), ['B1']],
  ['request mode is off in W13 (the assistant books directly)', (w) => code(w, 'W13 – Plan', "if (b.x.request_mode && b.gate.route === 'ai' && !$json.claim_error) {", 'if (false) {'), ['C1']],
  ['REQ confirms a time that is already taken', (w) => code(w, 'REQ – Plan', 'if (taken.length >= capacity) items.push(', 'if (false) items.push('), ['C3']],
  ['the no-model FAQ fallback is switched off', (w) => cfg(w, 'W13 – Config', 'faq_fallback', 'off'), ['F1']],
  ['the urgent owner alert at night is removed', (w) => code(w, 'W13 – Plan Ready', 'aiUrgentAlerts(plan, b.x, aiSendItems(plan, b.x, h), h)', 'aiSendItems(plan, b.x, h)'), ['H1']],
  ['an opted-out caller is called back', (w) => code(w, null, 'opted_out: ctx.opted_out === true,', 'opted_out: false,'), ['E1']],
  ['the call secret is not checked (any caller is accepted)', (w) => code(w, null, 'if (!ceSafeEqual(', 'if (false && !ceSafeEqual('), ['A3']],
];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-mut-'));
let missed = 0;
for (const [name, mutate, expect] of M) {
  const w = JSON.parse(JSON.stringify(BASE));
  mutate(w);
  const f = path.join(dir, 'mutant.json');
  fs.writeFileSync(f, JSON.stringify(w));
  let failing = [];
  try { failing = runScenario({}, { file: f }).results.filter((s) => s.error || s.checks.some((c) => !c.ok)).map((s) => s.id); } catch (e) { failing = ['(crash: ' + e.message.split('\n')[0] + ')']; }
  const caught = expect.every((e) => failing.includes(e));
  if (!caught) missed++;
  console.log(`  ${caught ? 'caught ' : 'MISSED '} ${name.padEnd(66)} failing steps: ${failing.join(',') || '(none)'}`);
}
fs.rmSync(dir, { recursive: true, force: true });
if (missed) { console.log(`\n${missed} mutation(s) were not caught`); process.exit(1); }
console.log(`\nDEMO: all ${M.length} mutations caught by the scripted demo`);
