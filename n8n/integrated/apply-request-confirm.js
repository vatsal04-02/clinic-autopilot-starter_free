// REQUEST_CONFIRM on your workflow: the second half of request mode (staff confirm / decline a request, the patient is told):
//   node n8n/integrated/apply-request-confirm.js --in <workflow.json> [--out <file>] [--keep-private]
//
// Adds ONLY new nodes (25 "REQ –" nodes + one sticky note); no existing node, connection, credential or webhook is changed:
//   REQ – Every 2 minutes -> Config -> Clinics -> Split clinics -> Settings -> Add settings -> Appointments -> Leads -> Conversations -> Plan
//   -> Conflict? -> [refused: Prepare conflict -> Revert to Requested -> Conflict log -> Write conflict log]
//               -> [told:    Decide send -> Send? -> Build Message -> Claim Confirm_Sent -> Restore -> Call 'W12 - WhatsApp send' -> Prepare log
//                            -> Write Run_Log -> Mark lead Booked? -> Mark lead Booked]
// The only sender is still W12 (called through $workflow.id). Needs request mode (apply-request-mode.js) to produce requests; it does nothing for a
// clinic without Settings > booking_mode = request. Grist: Appointments.Confirm_Sent (DateTime), Status choices Requested + Declined.
// Every value that exists in your workflow is copied FROM it: Grist base URL + registry doc id (W6 – Config), the Grist credential (W6 – Clinics),
// leads_table (W2 – Config). Anything unexpected = nothing is written. Output: active = false.
const fs = require('fs');
const path = require('path');
const { redact } = require('./redact');
const { buildSection, STICKY, STICKY_HEIGHT, TOP, uuid } = require('../req/sections');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IN = arg('--in');
const OUT = arg('--out', path.join(__dirname, 'clinic-autopilot-master-ai.request-confirm.json'));
const KEEP_PRIVATE = args.includes('--keep-private');
if (!IN) { console.error('usage: node apply-request-confirm.js --in <workflow.json> [--out file] [--keep-private]'); process.exit(1); }
const fail = (m) => { console.error(`apply-request-confirm: ${m}\nNothing was written.`); process.exit(1); };

const wf = JSON.parse(fs.readFileSync(IN, 'utf8'));
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
const node = (name) => byName[name] || fail(`node "${name}" is missing (is this the master?)`);
if (wf.nodes.some((n) => /^REQ – /.test(n.name))) fail('the workflow already has REQ nodes');
const assignment = (nodeName, key) => {
  const a = (node(nodeName).parameters.assignments.assignments || []).find((x) => x.name === key);
  if (!a || a.value === undefined || a.value === '') fail(`${nodeName} > ${key} is missing`);
  return a;
};
const cred = node('W6 – Clinics').credentials;
if (!cred || !cred.httpHeaderAuth || !cred.httpHeaderAuth.id) fail('W6 – Clinics has no credential');
node('W12 – Config');   // the section calls W12 through $workflow.id: this workflow must be the one holding it
const built = buildSection({
  gristBaseUrl: assignment('W6 – Config', 'grist_base_url').value,
  registryDocId: assignment('W6 – Config', 'registry_doc_id').value,
  gristCredentials: cred,
  leadsTable: assignment('W2 – Config', 'leads_table').value,
});
for (const nn of built.nodes) if (byName[nn.name]) fail(`name clash: ${nn.name}`);
wf.nodes.push(...built.nodes);
for (const [from, c] of Object.entries(built.connections)) {
  if (wf.connections[from]) fail(`connections already exist for ${from}`);
  wf.connections[from] = c;
}
wf.nodes.push({
  parameters: { content: STICKY, height: STICKY_HEIGHT, width: built.width },
  name: 'Section REQUEST_CONFIRM', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [160, TOP], id: uuid('Section REQUEST_CONFIRM'),
});

wf.active = false;
const report = [];
const out = KEEP_PRIVATE ? wf : redact(wf, report);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${OUT}: ${out.nodes.length} nodes (${built.nodes.length + 1} added), active = false`);
console.log('  - SECTION REQUEST_CONFIRM: every 2 minutes; staff-decided requests -> confirmed / refused (slot taken) / declined; the patient is told through W12 only');
console.log(`redactions: ${KEEP_PRIVATE ? 'none (--keep-private)' : report.join('; ') || 'none needed'}`);
