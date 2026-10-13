// URGENT ALERTS AT NIGHT on your workflow: the owner is alerted at once about a possible emergency, even in quiet hours; the patient is not messaged at
// night; an alert that was due and did not go out is a FAILURE in Run_Log.
//   node n8n/integrated/apply-urgent-alerts.js --in <workflow.json> [--out <file>] [--keep-private]
//
// Why: W13 hands a possible emergency to a person as priority URGENT, but the alert to the owner went through the patients' quiet-hours rule (21:00-08:00
// IST): an emergency at 23:00 was deferred to the 08:05 run. Details and tests: n8n/snippets/urgent-alerts.js, n8n/integrated/URGENT-ALERTS.md.
// Changes in existing nodes (code only, each anchor checked first; no wiring, no credential, no new node):
//   W13 – Plan Ready   urgent.js block + the send items of an URGENT hand-off: the owner alert is decided as daytime (urgent: true), the night patient reply is dropped
//   W13 – Record Sends the same block + a due staff alert that did not go out turns the Run_Log row into Outcome failed ("URGENT ALERT NOT SENT: <why>")
//   W12 – Prepare request   quiet hours are skipped ONLY for an item with urgent = true, audience staff and template human_handoff_alert (also in simulate mode)
// Anything unexpected (a node edited in n8n, the patch already applied) = nothing is written. Output: active = false.
const fs = require('fs');
const path = require('path');
const { redact } = require('./redact');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IN = arg('--in');
const OUT = arg('--out', path.join(__dirname, 'clinic-autopilot-master-ai.urgent-alerts.json'));
const KEEP_PRIVATE = args.includes('--keep-private');
if (!IN) { console.error('usage: node apply-urgent-alerts.js --in <workflow.json> [--out file] [--keep-private]'); process.exit(1); }
const fail = (m) => { console.error(`apply-urgent-alerts: ${m}\nNothing was written.`); process.exit(1); };
const SRC = fs.readFileSync(path.join(__dirname, '..', 'snippets', 'urgent-alerts.js'), 'utf8');
const BLOCK = SRC.slice(SRC.indexOf('const AI_URGENT_NOON'), SRC.indexOf('if (typeof module'));

const wf = JSON.parse(fs.readFileSync(IN, 'utf8'));
const node = (name) => wf.nodes.find((n) => n.name === name) || fail(`node "${name}" is missing (is this the master?)`);
const count = (text, from) => text.split(from).length - 1;
const once = (text, from, what) => { const n = count(text, from); if (n !== 1) fail(`${what}: the expected text was found ${n} times (expected once): it was edited in n8n, or this is not the master with W13 prompt v2.2`); };
const marker = '// ---- this node ----\n';
for (const n of ['W13 – Plan Ready', 'W13 – Record Sends']) if (node(n).parameters.jsCode.includes('aiUrgentAlerts') || node(n).parameters.jsCode.includes('aiUrgentAlertLost')) fail(`"${n}" already has the urgent-alert patch`);

// 1. W13 – Plan Ready
{
  const n = node('W13 – Plan Ready');
  const OLD = "const send_items = aiSendItems(plan, b.x, h);\nreturn [{ json: { plan, send_items } }];\n";
  const NEW = "// URGENT hand-off: the owner alert is decided as daytime (quiet hours are for patients), the patient is not messaged at night (urgent-alerts.js)\nconst send_items = aiUrgentAlerts(plan, b.x, aiSendItems(plan, b.x, h), h);\nreturn [{ json: { plan, send_items } }];\n";
  once(n.parameters.jsCode, marker, `${n.name} marker`); once(n.parameters.jsCode, OLD, `${n.name} tail`);
  n.parameters.jsCode = n.parameters.jsCode.replace(marker, () => `// ---- pasted from n8n/snippets/urgent-alerts.js - keep identical ----\n${BLOCK}\n${marker}`).replace(OLD, () => NEW);
}
// 2. W13 – Record Sends
{
  const n = node('W13 – Record Sends');
  const OLD = "const fw = aiFinalWrites(ready.plan, b.x, sends, Math.floor(Date.now() / 1000), trace);\n";
  const NEW = `${OLD}// A staff alert that was due and did not go out is a FAILURE in Run_Log, never a quiet "ok" (urgent-alerts.js)
const lost = b.x.dry_run ? null : aiUrgentAlertLost(ready.send_items, sends);
if (lost) {
  for (const w of fw.writes) {
    if (w.table !== 'Run_Log') continue;
    const f = w.body.records[0].fields;
    f.Outcome = 'failed';
    f.Error = aiClean(\`\${lost.urgent ? 'URGENT ALERT NOT SENT' : 'STAFF ALERT NOT SENT'}: \${lost.reason}; \${f.Error}\`, 500);
  }
}
`;
  once(n.parameters.jsCode, marker, `${n.name} marker`); once(n.parameters.jsCode, OLD, `${n.name} aiFinalWrites line`);
  n.parameters.jsCode = n.parameters.jsCode.replace(marker, () => `// ---- pasted from n8n/snippets/urgent-alerts.js - keep identical ----\n${BLOCK}\n${marker}`).replace(OLD, () => NEW);
}
// 3. W12 – Prepare request: the quiet-hours check is skipped for the urgent owner alert only
{
  const n = node('W12 – Prepare request');
  const code = n.parameters.jsCode;
  const URGENT = "(ms) => (input.urgent === true && input.audience === 'staff' && input.template === 'human_handoff_alert' ? false : inQuietHours(ms))";
  const LIVE = '{ normalizeIndianPhone, inQuietHours }';
  once(code, LIVE, `${n.name} waPrepare helpers`);
  let out = code.replace(LIVE, () => `{ normalizeIndianPhone, inQuietHours: ${URGENT} }`);
  const SIM = '{ normalizeIndianPhone, inQuietHours, waPrepare, waInboxPlan, waInboxRow }';
  const sims = count(out, SIM);
  if (sims > 1) fail(`${n.name}: the simulate helpers were found ${sims} times`);
  if (sims === 1) out = out.replace(SIM, () => `{ normalizeIndianPhone, inQuietHours: ${URGENT}, waPrepare, waInboxPlan, waInboxRow }`);
  n.parameters.jsCode = out;
}

wf.active = false;
const report = [];
const out = KEEP_PRIVATE ? wf : redact(wf, report);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${OUT}: ${out.nodes.length} nodes (0 added), active = false`);
console.log('  - W13 – Plan Ready: an URGENT hand-off alerts the owner even in quiet hours; the patient is not messaged at night');
console.log('  - W13 – Record Sends: a staff alert that was due and did not go out = Run_Log failed');
console.log('  - W12 – Prepare request: quiet hours skipped only for urgent human_handoff_alert to staff');
console.log(`redactions: ${KEEP_PRIVATE ? 'none (--keep-private)' : report.join('; ') || 'none needed'}`);
