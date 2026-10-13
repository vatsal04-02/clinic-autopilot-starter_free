// Mutation tests for REQUEST_CONFIRM: each safety rule is broken once in a copy of the workflow, and the end-to-end test (request-confirm.test.js)
// must then FAIL on the checks that cover that rule. A mutation it does not notice would mean the rule is not really tested.
// Run: node n8n/integrated/request-confirm-mutations.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const MASTER = path.join(__dirname, 'clinic-autopilot-master-ai.json');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqconf-mut-'));
const step = (script, input, out) => { const r = spawnSync(process.execPath, [path.join(__dirname, script), '--in', input, '--out', out], { encoding: 'utf8' }); assert.strictEqual(r.status, 0, r.stderr); return out; };
const built = step('apply-request-confirm.js', step('apply-request-mode.js', MASTER, path.join(dir, 'a.json')), path.join(dir, 'b.json'));
const BASE = JSON.parse(fs.readFileSync(built, 'utf8'));
const node = (w, n) => { const x = w.nodes.find((y) => y.name === n); assert(x, `no node ${n}`); return x; };
const code = (w, names, from, to) => { for (const n of [].concat(names)) { const x = node(w, n); assert(x.parameters.jsCode.includes(from), `${n}: mutation target missing: ${from.slice(0, 70)}`); x.parameters.jsCode = x.parameters.jsCode.split(from).join(to); } };
const M = [
  ['no conflict check: a confirmation over a taken slot goes through', (w) => code(w, 'REQ – Plan', 'if (taken.length >= capacity) {', 'if (false) {'), ['C6', 'C7', 'C8']],
  ['two simultaneous confirmations both refused (no "lowest id wins")', (w) => code(w, 'REQ – Plan', ' && !(isCandidate(o) && o.id > r.id)', ''), ['C7']],
  ['capacity from Settings is ignored (always 1)', (w) => code(w, 'REQ – Plan', 'const capacity = Number.isFinite(capNum) && capNum >= 1 && capNum <= 20 ? Math.round(capNum) : 1;', 'const capacity = 1;'), ['C7']],
  ['the refusal does not put the row back to Requested', (w) => code(w, 'REQ – Prepare conflict', "fields: { Status: 'Requested' }", "fields: { Status: 'Booked' }"), ['C6', 'C8']],
  ['a refused confirmation still tells the patient', (w) => { w.connections['REQ – Conflict?'].main[0] = [{ node: 'REQ – Decide send', type: 'main', index: 0 }]; }, ['C6', 'C7', 'C8']],
  ['no claim before the send (Confirm_Sent never written first)', (w) => { w.connections['REQ – Build Message'].main[0] = [{ node: 'REQ – Restore', type: 'main', index: 0 }]; }, ['C2', 'C5', 'C12']],
  ['Opted_Out ignored', (w) => code(w, 'REQ – Decide send', 'opted_out: $json.opted_out,', 'opted_out: false,'), ['C9']],
  ['quiet hours ignored', (w) => code(w, 'REQ – Decide send', 'now_ms: Date.now(),', 'now_ms: Date.now() - 12 * 3600 * 1000,'), ['C9']],
  ['TEST_MODE ignored', (w) => code(w, 'REQ – Decide send', 'test_mode: $json.test_mode,', "test_mode: 'false',"), ['C9']],
  ['a clinic that is not in request mode is processed too', (w) => code(w, 'REQ – Plan', "if (String(c.settings.booking_mode || '').trim().toLowerCase() !== 'request') return;", ''), ['C10']],
  ['Cal.com / WhatsApp bookings are treated as requests', (w) => code(w, ['REQ – Plan', 'REQ – Conflict log'], 'const REQC_UID = /^req-/;', 'const REQC_UID = /./;'), ['C10']],
  ['a lead is downgraded to Booked', (w) => { node(w, 'REQ – Mark lead Booked?').parameters.conditions.conditions[0].leftValue = node(w, 'REQ – Mark lead Booked?').parameters.conditions.conditions[0].leftValue.replace(" && !['Booked', 'Converted'].includes($('REQ – Prepare log').item.json.lead_status)", ''); }, ['C4']],
  ['a decline marks the lead Booked', (w) => { node(w, 'REQ – Mark lead Booked?').parameters.conditions.conditions[0].leftValue = '={{ true }}'; }, ['C5']],
  ['a confirmation outside the 24 h window is sent as free text', (w) => code(w, 'REQ – Build Message', 'const message = reqcMessage($json, $json.clinic_name, now);', 'const message = reqcMessage({ ...$json, last_inbound_at: now }, $json.clinic_name, now);'), ['C3']],
  ['the patient is told from a node other than W12 (Call W12 points elsewhere)', (w) => { node(w, "REQ – Call 'W12 - WhatsApp send'").parameters.workflowId.value = 'SOMEOTHERID00001'; }, ['C1', 'C2']],
];
let missed = 0;
for (const [name, mutate, expect] of M) {
  const w = JSON.parse(JSON.stringify(BASE));
  mutate(w);
  const f = path.join(dir, 'mutant.json');
  fs.writeFileSync(f, JSON.stringify(w));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'request-confirm.test.js')], { encoding: 'utf8', env: { ...process.env, CONFIRM_MUTANT: f }, maxBuffer: 1 << 26 });
  const failing = (r.stdout.match(/^FAIL  (C\d+)/gm) || []).map((l) => l.replace('FAIL  ', ''));
  const caught = r.status !== 0 && expect.every((e) => failing.includes(e));
  if (!caught) missed++;
  console.log(`  ${caught ? 'caught ' : 'MISSED '} ${name.padEnd(80)} failing: ${failing.join(',') || '(none)'}`);
}
fs.rmSync(dir, { recursive: true, force: true });
if (missed) { console.log(`\n${missed} mutation(s) were not caught`); process.exit(1); }
console.log(`\nREQUEST CONFIRMATION: all ${M.length} mutations caught by the end-to-end test`);
