// Mutation tests for the urgent-alert patch: each rule is broken once in a copy of the patched workflow, and the end-to-end test (urgent-alerts.test.js)
// must then FAIL on the checks that cover it. Run: node n8n/integrated/urgent-alerts-mutations.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const MASTER = path.join(__dirname, 'clinic-autopilot-master-ai.json');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'urgent-mut-'));
const built = path.join(dir, 'urgent.json');
const r0 = spawnSync(process.execPath, [path.join(__dirname, 'apply-urgent-alerts.js'), '--in', MASTER, '--out', built], { encoding: 'utf8' });
assert.strictEqual(r0.status, 0, r0.stderr);
const BASE = JSON.parse(fs.readFileSync(built, 'utf8'));
const node = (w, n) => { const x = w.nodes.find((y) => y.name === n); assert(x, `no node ${n}`); return x; };
const code = (w, names, from, to) => { for (const n of [].concat(names)) { const x = node(w, n); assert(x.parameters.jsCode.includes(from), `${n}: mutation target missing: ${from.slice(0, 70)}`); x.parameters.jsCode = x.parameters.jsCode.split(from).join(to); } };
const BOTH = ['W13 – Plan Ready', 'W13 – Record Sends'];
const M = [
  ['the urgent alert is not decided as daytime (still blocked by quiet hours)', (w) => code(w, BOTH, 'now_ms: AI_URGENT_NOON', 'now_ms: x.now_ms'), ['U2', 'U7']],
  ['the patient is still sent the holding reply at night', (w) => code(w, BOTH, "} else if (it.w13_kind === 'patient_reply' && night) {", "} else if (false) {"), ['U2']],
  ['the W12 bypass is not limited to the owner alert template', (w) => code(w, 'W12 – Prepare request', " && input.template === 'human_handoff_alert'", ''), ['U8']],
  ['the W12 bypass trusts a non-boolean "urgent" / any audience', (w) => code(w, 'W12 – Prepare request', "input.urgent === true && input.audience === 'staff'", "input.urgent && true"), ['U8']],
  ['a lost alert is logged as ok', (w) => code(w, 'W13 – Record Sends', "f.Outcome = 'failed';", "f.Outcome = f.Outcome;"), ['U6']],
  ['a lost alert is not detected', (w) => code(w, 'W13 – Record Sends', 'const lost = b.x.dry_run ? null : aiUrgentAlertLost(ready.send_items, sends);', 'const lost = null;'), ['U6']],
  ['an alert held back by the guard (invalid owner phone) is not counted as lost', (w) => code(w, BOTH, '(it.urgent === true || (it.decision && it.decision.send === true))', '(it.decision && it.decision.send === true)'), ['U6']],
  ['TEST_MODE is ignored for the urgent alert', (w) => code(w, BOTH, 'test_mode: x.profile.test_mode, test_phone: testPhone, now_ms: AI_URGENT_NOON', "test_mode: 'false', test_phone: testPhone, now_ms: AI_URGENT_NOON"), ['U7']],
  ['Plan Ready skips the urgent step', (w) => code(w, 'W13 – Plan Ready', 'aiUrgentAlerts(plan, b.x, aiSendItems(plan, b.x, h), h)', 'aiSendItems(plan, b.x, h)'), ['U2', 'U6']],
];
let missed = 0;
for (const [name, mutate, expect] of M) {
  const w = JSON.parse(JSON.stringify(BASE));
  mutate(w);
  const f = path.join(dir, 'mutant.json');
  fs.writeFileSync(f, JSON.stringify(w));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'urgent-alerts.test.js')], { encoding: 'utf8', env: { ...process.env, URGENT_MUTANT: f }, maxBuffer: 1 << 26 });
  const failing = (r.stdout.match(/^FAIL  (U\d+)/gm) || []).map((l) => l.replace('FAIL  ', ''));
  const caught = r.status !== 0 && expect.every((e) => failing.includes(e));
  if (!caught) missed++;
  console.log(`  ${caught ? 'caught ' : 'MISSED '} ${name.padEnd(86)} failing: ${failing.join(',') || '(none)'}`);
}
fs.rmSync(dir, { recursive: true, force: true });
if (missed) { console.log(`\n${missed} mutation(s) were not caught`); process.exit(1); }
console.log(`\nURGENT ALERTS: all ${M.length} mutations caught by the end-to-end test`);
