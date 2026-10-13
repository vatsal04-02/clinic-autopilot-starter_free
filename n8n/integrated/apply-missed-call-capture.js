// MISSED_CALL_CAPTURE on your workflow (the master "ai updated workflow clinic" with W13 prompt v2.2):
//   node n8n/integrated/apply-missed-call-capture.js --in <workflow.json> [--out <file>] [--demo] [--secret <value>] [--keep-private]
//
// Adds (nothing removed; every existing node keeps its id, position and credentials):
//   - SECTION MISSED_CALL_CAPTURE: the "MCC –" nodes (webhook POST /webhook/missed-call, validation, registry lookup by the CALLED
//     number, idempotent event record, lead + conversation, acknowledgement + staff alert through W12). n8n/mcc/sections.js.
//   - W12 simulate mode: two new nodes (W12 – Simulated?, W12 – Simulated send) and the connection "Call Meta? (false)" now goes
//     through them. W12 – Prepare request / Read reply / Return result get the n8n/snippets/wa-simulate.js block and a small tail change.
//     The pasted wa-send.js block (waPrepare, templates, 24 h window) is NOT touched: live and allowlist mode run exactly the old code.
// Changes in existing nodes (code / text only, each fingerprinted first): W12 – Prepare request, W12 – Read reply, W12 – Return result,
// Section FUTURE and Section 00 (sticky text). With --demo ALSO: W12 – Config > w12_send_mode = simulate (nothing is ever sent).
// Every value the section needs that already exists in your workflow is copied FROM it: Grist base URL and registry doc id (W6 – Config),
// the Grist credential (W6 – Clinics), leads_table / unread_mode / default_lead_name (W2 – Config).
// Anything unexpected (a node edited in n8n, the section already built) = nothing is written. Output: active = false.
// --secret <value> writes the webhook secret into MCC – Config; the file then holds a secret: it is NOT redacted, name it *.local.json
// (git-ignored) and never commit it. Without it the secret stays the placeholder and the webhook answers 503 until you set it.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redact } = require('./redact');
const { buildSection, STICKY, STICKY_HEIGHT, uuid } = require('../mcc/sections');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IN = arg('--in');
const OUT = arg('--out', path.join(__dirname, 'clinic-autopilot-master-ai.missed-call-demo.json'));
const DEMO = args.includes('--demo');
const SECRET = arg('--secret', '');
const KEEP_PRIVATE = args.includes('--keep-private') || !!SECRET;
if (!IN) { console.error('usage: node apply-missed-call-capture.js --in <workflow.json> [--out file] [--demo] [--secret value] [--keep-private]'); process.exit(1); }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const fail = (m) => { console.error(`apply-missed-call-capture: ${m}\nNothing was written.`); process.exit(1); };
const SNIPPETS = path.join(__dirname, '..', 'snippets');
const snip = (f) => fs.readFileSync(path.join(SNIPPETS, f), 'utf8');

const FINGERPRINTS = {   // the master (W13 prompt v2.2), code / sticky text
  'W12 – Prepare request': '5e554790a36ef0e3',
  'W12 – Read reply': '622767331bfe9bd1',
  'W12 – Return result': 'c205e43319919ac6',
  'Section FUTURE': '628ea44e9c24fa9a',
  'Section 00': 'aca66770a913be8d',
};
const WA_SRC = snip('wa-send.js');
const WA_BLOCK = sha(WA_SRC.slice(WA_SRC.indexOf('const WA_TEMPLATES'), WA_SRC.indexOf('\n}\n', WA_SRC.indexOf('function waInboxRow')) + 3));   // the block pasted in W12 must be the current one

const wf = JSON.parse(fs.readFileSync(IN, 'utf8'));
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
const node = (name) => byName[name] || fail(`node "${name}" is missing`);
const bodyOf = (n) => (n.type === 'n8n-nodes-base.stickyNote' ? n.parameters.content : n.parameters.jsCode);
for (const [name, want] of Object.entries(FINGERPRINTS)) {
  const got = sha(bodyOf(node(name)));
  if (got !== want) fail(`"${name}" is not the expected version (fingerprint ${got}, expected ${want}): it was edited in n8n, or this is not the master with W13 prompt v2.2. Re-export and re-check.`);
}
const taken = wf.nodes.filter((n) => /^MCC – /.test(n.name) || n.name === 'W12 – Simulated?' || n.name === 'W12 – Simulated send').map((n) => n.name);
if (taken.length) fail(`the workflow already has missed-call-capture nodes (${taken.slice(0, 3).join(', ')}...)`);
const assignment = (nodeName, key) => {
  const a = (node(nodeName).parameters.assignments.assignments || []).find((x) => x.name === key);
  if (!a || a.value === undefined || a.value === '') fail(`${nodeName} > ${key} is missing`);
  return a;
};
const replaceOnce = (code, from, to, what) => {
  const count = code.split(from).length - 1;
  if (count !== 1) fail(`${what}: the text to change was found ${count} times (expected once)`);
  return code.replace(from, () => to);
};

// ---------------------------------------------------------------- 1. W12: simulate mode (wa-send.js is untouched)
const waEnd = (code, s) => code.indexOf('\n}\n', code.indexOf('function waInboxRow', s)) + 3;
const SIM_SRC = snip('wa-simulate.js');
const SIM = `// Pasted from n8n/snippets/wa-simulate.js - keep identical. W12 simulate mode (DEMO ONLY): nothing leaves the machine.\n${SIM_SRC.slice(SIM_SRC.indexOf('const WA_SIM_ONLY'), SIM_SRC.indexOf('if (typeof module'))}`;
const withSim = (name) => {
  const n = node(name);
  const code = n.parameters.jsCode;
  const s = code.indexOf('const WA_TEMPLATES');
  const e = waEnd(code, s);
  if (s < 0 || sha(code.slice(s, e)) !== WA_BLOCK) fail(`${name}: the pasted wa-send.js block is not the expected version`);
  return { n, code, e };
};
{
  const { n, code, e } = withSim('W12 – Prepare request');
  let out = code.slice(0, e) + SIM + code.slice(e);
  out = replaceOnce(out, `  const prep = waPrepare(
  input,
  cfg,
  Date.now(),
  { normalizeIndianPhone, inQuietHours }
  );
`, `  // simulate mode is chosen ONLY by W12 – Config > w12_send_mode = "simulate"; live and allowlist run waPrepare exactly as before
  const prep = waIsSimulate(cfg)
    ? waSimulate(input, cfg, Date.now(), { normalizeIndianPhone, inQuietHours, waPrepare, waInboxPlan, waInboxRow })
    : waPrepare(
      input,
      cfg,
      Date.now(),
      { normalizeIndianPhone, inQuietHours }
    );
`, 'W12 – Prepare request');
  n.parameters.jsCode = out;
}
{
  const { n, code, e } = withSim('W12 – Read reply');
  let out = code.slice(0, e) + SIM + code.slice(e);
  out = replaceOnce(out, `  const res = waClassify($json, p.cfg);
  const inbox = waInboxPlan(p.input, p.cfg, res, { normalizeIndianPhone, inQuietHours });
  const inbox_row = inbox.log ? waInboxRow(p.input, res, Math.floor(Date.now() / 1000)) : null;   // built here: this node has the helpers
`, `  const simulated = p.prep.simulated === true;   // only waSimulate sets this; a Meta answer never does
  const wh = { normalizeIndianPhone, inQuietHours, waPrepare, waInboxPlan, waInboxRow };
  const res = simulated ? waSimulatedResult(p.prep, Date.now()) : waClassify($json, p.cfg);
  const inbox = simulated ? waSimInboxPlan(p.input, p.cfg, res, wh) : waInboxPlan(p.input, p.cfg, res, { normalizeIndianPhone, inQuietHours });
  const nowSec = Math.floor(Date.now() / 1000);
  const inbox_row = inbox.log ? (simulated ? waSimInboxRow(p.input, res, nowSec, wh) : waInboxRow(p.input, res, nowSec)) : null;   // built here: this node has the helpers
`, 'W12 – Read reply');
  n.parameters.jsCode = out;
}
{
  const n = node('W12 – Return result');
  n.parameters.jsCode = replaceOnce(n.parameters.jsCode, '      sent: res.sent === true,\n', '      sent: res.sent === true,\n      simulated: res.simulated === true,   // DEMO: nothing was sent (sent is false)\n', 'W12 – Return result');
}
{
  const callMeta = node('W12 – Call Meta?');
  const cm = wf.connections['W12 – Call Meta?'];
  const falseOut = cm && cm.main && cm.main[1] && cm.main[1][0];
  if (!falseOut || falseOut.node !== 'W12 – Return result' || cm.main[1].length !== 1) fail('W12 – Call Meta? (false) is not wired to W12 – Return result as expected');
  const [x, y] = callMeta.position;
  const simQ = {
    parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: uuid('w12-simulated-cond'), leftValue: '={{ $json.prep.simulated === true }}', rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} },
    name: 'W12 – Simulated?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [x + 224, y + 128], id: uuid('W12 – Simulated?'),
  };
  const simSend = {
    parameters: { jsCode: '// DEMO ONLY (W12 – Config > w12_send_mode = simulate): there is no Meta request. This item only tells W12 – Read reply to write the simulated result.\nreturn { json: { simulated: true } };\n' },
    name: 'W12 – Simulated send', type: 'n8n-nodes-base.code', typeVersion: 2, position: [x + 448, y + 128], id: uuid('W12 – Simulated send'),
  };
  wf.nodes.push(simQ, simSend);
  cm.main[1] = [{ node: 'W12 – Simulated?', type: 'main', index: 0 }];
  wf.connections['W12 – Simulated?'] = { main: [[{ node: 'W12 – Simulated send', type: 'main', index: 0 }], [{ node: 'W12 – Return result', type: 'main', index: 0 }]] };
  wf.connections['W12 – Simulated send'] = { main: [[{ node: 'W12 – Read reply', type: 'main', index: 0 }]] };
}
if (DEMO) assignment('W12 – Config', 'w12_send_mode').value = 'simulate';

// ---------------------------------------------------------------- 2. the section, from YOUR values
const credentialOf = (nodeName) => {
  const c = node(nodeName).credentials;
  if (!c || !c.httpHeaderAuth || !c.httpHeaderAuth.id) fail(`${nodeName} has no credential`);
  return c;
};
const built = buildSection({
  gristBaseUrl: assignment('W6 – Config', 'grist_base_url').value,
  registryDocId: assignment('W6 – Config', 'registry_doc_id').value,
  gristCredentials: credentialOf('W6 – Clinics'),
  leadsTable: assignment('W2 – Config', 'leads_table').value,
  unreadMode: assignment('W2 – Config', 'unread_mode').value,
  defaultLeadName: assignment('W2 – Config', 'default_lead_name').value,
  webhookSecret: SECRET,
  types: { webhook: node('W2 – Webhook Inbound').typeVersion, respond: node('W2 – Respond').typeVersion, stopAndError: node('W1 – Unknown clinic').typeVersion },
});
for (const nn of built.nodes) if (byName[nn.name]) fail(`name clash: ${nn.name}`);
wf.nodes.push(...built.nodes);
for (const [from, c] of Object.entries(built.connections)) {
  if (wf.connections[from]) fail(`connections already exist for ${from}`);
  wf.connections[from] = c;
}
wf.nodes.push({
  parameters: { content: STICKY, height: STICKY_HEIGHT, width: built.width },
  name: 'Section MISSED_CALL_CAPTURE', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [160, 27264], id: uuid('Section MISSED_CALL_CAPTURE'),
});

// ---------------------------------------------------------------- 3. sticky notes
{
  const fut = node('Section FUTURE');
  fut.parameters.content = replaceOnce(fut.parameters.content, 'W13, W14, W15, AI receptionist,', 'W14, W15 (unassigned; MISSED_CALL_CAPTURE, node prefix "MCC –", is built and does not use them), AI receptionist,', 'Section FUTURE');
  const s00 = node('Section 00');
  s00.parameters.content = replaceOnce(s00.parameters.content, '- **W6 – Daily 10:00** — cron 0 10 * * * -> SECTION W6\n', `- **W6 – Daily 10:00** — cron 0 10 * * * -> SECTION W6
- **MCC – Webhook** — POST /webhook/missed-call (header X-Call-Secret) -> SECTION MISSED_CALL_CAPTURE
`, 'Section 00');
}

wf.active = false;
const report = [];
const out = KEEP_PRIVATE ? wf : redact(wf, report);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${OUT}: ${out.nodes.length} nodes (${built.nodes.length + 3} added), active = false${DEMO ? ', DEMO: W12 send mode = simulate' : ''}`);
console.log('  - SECTION MISSED_CALL_CAPTURE: POST /webhook/missed-call (MCC – Webhook)');
console.log('  - W12 – Prepare request, Read reply, Return result: wa-simulate.js block + tail; W12 – Simulated?, W12 – Simulated send added');
console.log(`  - w12_send_mode: ${DEMO ? 'simulate (nothing is sent)' : 'unchanged (the acknowledgement template is not registered with Meta: a live send of it is refused)'}`);
console.log(SECRET ? '  - webhook secret written into MCC – Config: this file holds a secret, do not commit it' : '  - MCC – Config > mcc_webhook_secret is a placeholder: the webhook answers 503 until you set it');
console.log(`redactions: ${KEEP_PRIVATE ? 'none (--keep-private / --secret)' : report.join('; ') || 'none needed'}`);
