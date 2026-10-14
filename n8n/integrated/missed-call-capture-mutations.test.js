// Mutation tests for MISSED_CALL_CAPTURE: each safety rule is broken once in a copy of the workflow, and the end-to-end test
// (missed-call-capture.test.js) must then FAIL on the checks that cover that rule. A mutation it does not notice would mean the
// rule is not really tested.
// Run: node n8n/integrated/missed-call-capture-mutations.test.js      (MCC_FILE = another file)
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const FILE = process.env.MCC_FILE || path.join(__dirname, 'clinic-autopilot-master-ai.missed-call-demo.json');
const BASE = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const node = (w, n) => { const x = w.nodes.find((y) => y.name === n); assert(x, `no node ${n}`); return x; };
const code = (w, n, from, to) => { const x = node(w, n); assert(x.parameters.jsCode.includes(from), `${n}: mutation target missing: ${from.slice(0, 60)}`); x.parameters.jsCode = x.parameters.jsCode.split(from).join(to); };
// [name, mutate, the e2e checks that must fail]
const M = [
  ['cooldown between acknowledgements removed', (w) => code(w, 'MCC – Decide ack', 'recent_ack_at: ceRecentAck(Array.isArray(recent.records) ? recent.records : []),', 'recent_ack_at: 0,'), ['M8']],
  ['every copy of an event thinks it is the canonical one', (w) => code(w, 'MCC – Canonical', 'mine: c.mine }', 'mine: true }'), ['M9']],
  ['duplicates are never recognised (every delivery is new)', (w) => code(w, 'MCC – Classify', 'const c = ceClassifyExisting(Array.isArray($json.records) ? $json.records : [], nowSec);', 'const c = ceClassifyExisting([], nowSec);'), ['M7', 'M10', 'M15', 'M16']],
  ['simulate branch removed (the false branch of Simulated? goes to the Meta path)', (w) => { w.connections['W12 – Call Meta?'].main[1] = [{ node: 'W12 – Return result', type: 'main', index: 0 }]; }, ['M1', 'M13']],
  ['a missed call stamps Last_Inbound_At (opens the 24 h window)', (w) => code(w, 'MCC – Plan writes', 'fields: { Lead: c.lead.row_id, Unread: unread }', 'fields: { Lead: c.lead.row_id, Unread: unread, Last_Inbound_At: Math.floor(Date.now() / 1000) }'), ['M1', 'M11']],
  ['Opted_Out ignored by the acknowledgement', (w) => code(w, 'MCC – Decide ack', 'opted_out: c.lead.opted_out,', 'opted_out: false,'), ['M11']],
  ['the clinic is taken from the request body', (w) => code(w, 'MCC – Resolve clinic', 'const r = ceResolveClinic($json.records, ev.called_key, { normalizeIndianPhone });', "const body = $('MCC – Webhook').first().json.body || {}; const r = ceResolveClinic($json.records.filter((x) => !body.clinic || x.fields.Clinic_Slug === body.clinic), ev.called_key, { normalizeIndianPhone });"), ['M5']],
  ['a failed acknowledgement is logged as ok', (w) => code(w, 'MCC – Final record', "c.ack.outcome === 'failed' || alert.outcome === 'failed' ? 'failed'", "false ? 'failed'"), ['M14', 'M15']],
  ['quiet hours ignored for the acknowledgement', (w) => code(w, 'MCC – Decide ack', 'Date.now(), { normalizeIndianPhone, decideSend });', '(Date.now() - 12 * 3600 * 1000), { normalizeIndianPhone, decideSend });'), ['M12']],
  ['a losing copy does not mark itself as a duplicate', (w) => code(w, 'MCC – Canonical', 'WA_Message_ID: ceDupKey(ctx.event.call_key, mine), ', ''), ['M9']],
  ['the call secret is not checked', (w) => code(w, 'MCC – Validate', '{ secret: cfg.mcc_webhook_secret }', "{ secret: 'x'.repeat(10) }"), ['M2']],
  ['Simulated? true branch goes to the Meta send node', (w) => { w.connections['W12 – Simulated?'].main[0] = [{ node: 'W12 – Meta send', type: 'main', index: 0 }]; }, ['M1', 'M18']],
  ['live mode is treated as simulate', (w) => code(w, 'W12 – Prepare request', 'const prep = waIsSimulate(cfg)', "const prep = (waIsSimulate(cfg) || String(cfg.send_mode).trim().toLowerCase() === 'live')"), ['M18', 'M14']],
  ['a retry counts Unread again', (w) => code(w, 'MCC – Plan writes', "if (c.plan.kind !== 'retry_ack') {", 'if (true) {'), ['M15']],
  ['the DEMO label is dropped from the event row', (w) => code(w, 'MCC – Add settings', 'demo: settings.demo', 'demo: false'), ['M1']],
  // scheduled retry
  ['retry: the 3-try cap is not applied', (w) => code(w, 'MCC – Plan retries', 'if (ceAttempts(r) >= CE_MAX_ACK_ATTEMPTS) continue;', ''), ['M21']],
  ['retry: the age limit is not applied', (w) => code(w, 'MCC – Plan retries', 'if (age > Number(cfg.retry_max_age_hours) * 3600) continue;', ''), ['M21']],
  ['retry: a young claim is picked up (collides with the webhook run)', (w) => code(w, 'MCC – Plan retries', 'if (age < (ceStateOf(r) === CE_STATE.pending ? CE_INFLIGHT_SEC : 60)) continue;', ''), ['M21']],
  ['retry: the newest event first instead of the oldest', (w) => code(w, 'MCC – Plan retries', '(Number(f.Created_At) || 0) < (Number(best.f.Created_At) || 0)', '(Number(f.Created_At) || 0) > (Number(best.f.Created_At) || 0)'), ['M22']],
  ['retry: an event already closed is retried', (w) => code(w, 'MCC – Plan retries', '!CE_RETRYABLE.includes(ceStateOf(r))', 'false'), ['M21']],
];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-mut-'));
let missed = 0;
for (const [name, mutate, expect] of M) {
  const w = JSON.parse(JSON.stringify(BASE));
  mutate(w);
  const f = path.join(dir, 'mutant.json');
  fs.writeFileSync(f, JSON.stringify(w));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'missed-call-capture.test.js')], { encoding: 'utf8', env: { ...process.env, MCC_FILE: f }, maxBuffer: 1 << 26 });
  const failing = (r.stdout.match(/^FAIL  (M\d+)/gm) || []).map((l) => l.replace('FAIL  ', ''));
  const caught = r.status !== 0 && expect.every((e) => failing.includes(e));
  if (!caught) missed++;
  console.log(`  ${caught ? 'caught ' : 'MISSED '} ${name.padEnd(76)} failing: ${failing.join(',') || '(none)'}`);
}
fs.rmSync(dir, { recursive: true, force: true });
if (missed) { console.log(`\n${missed} mutation(s) were not caught`); process.exit(1); }
console.log(`\nMISSED_CALL_CAPTURE: all ${M.length} mutations caught by the end-to-end test`);
