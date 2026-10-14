// Mutation tests for REQUEST MODE: each safety rule is broken once in a copy of the patched workflow, and the end-to-end test (request-mode.test.js)
// must then FAIL on the checks that cover that rule. A mutation it does not notice would mean the rule is not really tested.
// Run: node n8n/integrated/request-mode-mutations.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const MASTER = path.join(__dirname, 'clinic-autopilot-master-ai.json');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reqmode-mut-'));
const built = path.join(dir, 'patched.json');
const r0 = spawnSync(process.execPath, [path.join(__dirname, 'apply-request-mode.js'), '--in', MASTER, '--out', built], { encoding: 'utf8' });
assert.strictEqual(r0.status, 0, r0.stderr);
const BASE = JSON.parse(fs.readFileSync(built, 'utf8'));
const node = (w, n) => { const x = w.nodes.find((y) => y.name === n); assert(x, `no node ${n}`); return x; };
const code = (w, names, from, to) => { for (const n of [].concat(names)) { const x = node(w, n); assert(x.parameters.jsCode.includes(from), `${n}: mutation target missing: ${from.slice(0, 70)}`); x.parameters.jsCode = x.parameters.jsCode.split(from).join(to); } };
const BOTH = ['W13 – Build Context', 'W13 – Plan'];
const M = [
  ['the finalize step is skipped (the direct path writes a Booked row)', (w) => code(w, 'W13 – Plan', 'aiReqFinalize(plan, decision, b.x,', 'void (plan, decision, b.x,'), ['R3', 'R4']],
  ['the Requested row is written with Status Booked', (w) => code(w, BOTH, 'Status: AI_REQ_STATUS, Requested_At: nowSec', "Status: 'Booked', Requested_At: nowSec"), ['R3', 'R4']],
  ['the lead is still marked Booked', (w) => code(w, BOTH, 'delete plan.lead_patch.Status;', ''), ['R3']],
  ['the patient gets the model\'s own reply instead of the fixed one', (w) => code(w, BOTH, "plan.reply = `Thank you! We have noted your request for ${aiReqLabel(b.Start)}. It is NOT confirmed yet: our team will check and confirm with you shortly.`;", 'plan.reply = plan.reply;'), ['R4']],
  ['the model is not told it is a request (no addendum)', (w) => code(w, 'W13 – Build Context', 'const request = gate.route === \'ai\' ? aiReqAddendum(aiBuildRequest(x, cfg), x) : null;', 'const request = gate.route === \'ai\' ? aiBuildRequest(x, cfg) : null;'), ['R3']],
  ['W13 – Appointments reads Booked only (requests are not seen, so nothing is held)', (w) => { node(w, 'W13 – Appointments').parameters.queryParameters.parameters[0].value = '={{ JSON.stringify({ Status: ["Booked"] }) }}'; }, ['R1', 'R6']],
  ['a request does not hold its slot', (w) => code(w, BOTH, 'aiReqHolds(r.fields, rm, nowSec) && Number(r.fields.Lead) !== own', 'false'), ['R6']],
  ['a request never expires', (w) => code(w, BOTH, "(typeof f.Requested_At !== 'number' || f.Requested_At >= nowSec - rm.hold_sec)", 'true'), ['R8']],
  ['the patient\'s own request holds the slot against the patient (and the duplicate check never sees the same time)', (w) => code(w, BOTH, '&& Number(r.fields.Lead) !== own', ''), ['R7']],
  ['no duplicate check: the same time twice = two rows', (w) => code(w, BOTH, 'const dup = pending.find((p) => p.start === b.Start);', 'const dup = null;'), ['R7']],
  ['no limit on pending requests', (w) => code(w, BOTH, 'if (pending.length >= ((x.req && x.req.max_pending) || 2))', 'if (false)'), ['R7']],
  ['a reschedule is allowed (writes a Booked row)', (w) => code(w, BOTH, "if (plan.route === 'rescheduled') return handoff('request mode: changing a time needs a person');", ''), ['R10']],
  ['a reply that calls a request "confirmed" is sent', (w) => code(w, BOTH, "if (plan.reply && aiReqClaims(plan.reply) && plan.route !== 'handoff') {", 'if (false) {'), ['R11']],
  ['request mode is ON for every clinic', (w) => code(w, BOTH, "on: String(o.booking_mode === undefined || o.booking_mode === null ? '' : o.booking_mode).trim().toLowerCase() === 'request',", 'on: true,'), ['R5']],
  ['the weekly report total counts requests', (w) => code(w, 'W9 – Metrics', "this_week: count(week, (a) => a.Status !== 'Requested' && a.Status !== 'Declined'),", 'this_week: week.length,'), ['R1', 'R16']],
];
let missed = 0;
for (const [name, mutate, expect] of M) {
  const w = JSON.parse(JSON.stringify(BASE));
  mutate(w);
  const f = path.join(dir, 'mutant.json');
  fs.writeFileSync(f, JSON.stringify(w));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'request-mode.test.js')], { encoding: 'utf8', env: { ...process.env, REQUEST_MUTANT: f }, maxBuffer: 1 << 26 });
  const failing = (r.stdout.match(/^FAIL  (R\d+)/gm) || []).map((l) => l.replace('FAIL  ', ''));
  const caught = r.status !== 0 && expect.every((e) => failing.includes(e));
  if (!caught) missed++;
  console.log(`  ${caught ? 'caught ' : 'MISSED '} ${name.padEnd(100)} failing: ${failing.join(',') || '(none)'}`);
}
fs.rmSync(dir, { recursive: true, force: true });
if (missed) { console.log(`\n${missed} mutation(s) were not caught`); process.exit(1); }
console.log(`\nREQUEST MODE: all ${M.length} mutations caught by the end-to-end test`);
