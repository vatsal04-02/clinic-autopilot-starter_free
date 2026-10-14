// DEMO PROFILE: the last layer of the demo workflow (build-demo-workflow.js runs it after every other patcher).
//   node n8n/demo/apply-demo-profile.js --in <workflow.json> [--out <file>] [--keep-private]
//
// Why: in W12 "simulate" mode a message is worked out, passes every guard (opt-out, pause, quiet hours, TEST_MODE, 24 h window), is logged
// and is deliberately NOT sent: W12 answers sent:false, simulated:true. That is correct and fail-closed for every caller that does not know the
// word "simulated" (it can never mistake it for a sent message) - but two callers the demo uses would then report their own work as a FAILURE:
//   W13 – Record Sends : the AI's reply -> AI_Status "failed", Needs_Human ticked on every conversation, a failed Run_Log row
//   W10 – Record       : a staff reply  -> Messages.Status "failed", a failed Run_Log row
// MCC and REQ already know "simulated". This patch teaches those two, and labels what happened ("DEMO simulated, nothing was sent") so it is
// never mistaken for a delivered message.
// It also switches OFF (node.disabled) the six scheduled jobs that read the same answer with an "is it sent?" test and would log failures
// for every demo lead: W3, W5, W6, W7, W8, W9. The demo does not need them (right-click > Enable to use one: its sends will log as not sent).
// Everything is checked first: any node edited in n8n, or the patch already applied, = nothing is written. Output: active = false.
const fs = require('fs');
const path = require('path');
const { redact } = require('../integrated/redact');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IN = arg('--in');
const OUT = arg('--out', path.join(__dirname, 'clinic-autopilot-demo.profile.json'));
const KEEP_PRIVATE = args.includes('--keep-private');
if (!IN) { console.error('usage: node apply-demo-profile.js --in <workflow.json> [--out file] [--keep-private]'); process.exit(1); }
const fail = (m) => { console.error(`apply-demo-profile: ${m}\nNothing was written.`); process.exit(1); };

const wf = JSON.parse(fs.readFileSync(IN, 'utf8'));
const node = (name) => wf.nodes.find((n) => n.name === name) || fail(`node "${name}" is missing (is this the demo chain?)`);
const replaceOnce = (code, from, to, what) => {
  const n = code.split(from).length - 1;
  if (n !== 1) fail(`${what}: the expected text was found ${n} times (expected once): it was edited in n8n, or this is not the demo chain`);
  return code.replace(from, () => to);
};
if (node('W13 – Record Sends').parameters.jsCode.includes('DEMO PROFILE') || node('W10 – Record').parameters.jsCode.includes('DEMO PROFILE')) fail('the demo profile is already applied');
if (wf.nodes.some((n) => n.name === 'DEMO – Read Me')) fail('"DEMO – Read Me" already exists');

// ---- W13 – Record Sends
{
  const n = node('W13 – Record Sends');
  let c = n.parameters.jsCode;
  c = replaceOnce(c, '// Decision trace for Run_Log (A2):', `// DEMO PROFILE (W12 w12_send_mode = simulate): W12 ran every guard and logged the message but deliberately sent nothing (sent false, simulated true).
// For the CRM that is a simulated SUCCESS, not a failure: it must not set AI_Status failed, tick Needs_Human or write a failed Run_Log row. It is labelled below.
let simulatedAny = false;
for (const k of ['patient', 'staff']) if (sends[k] && sends[k].simulated === true) { sends[k] = { ...sends[k], sent: true, send_status: 'simulated' }; simulatedAny = true; }
// Decision trace for Run_Log (A2):`, 'W13 – Record Sends trace marker');
  c = replaceOnce(c, "const c = $('W13 – Resolve Clinic').first().json;", `if (simulatedAny) {   // DEMO PROFILE: say so in the message row and in Run_Log
  for (const w of fw.writes) {
    const f = w.body.records[0].fields;
    if (w.table === 'Messages' && 'AI_Reason' in f) f.AI_Reason = aiClean(\`DEMO simulated, nothing was sent; \${f.AI_Reason}\`, 500);
    if (w.table === 'Run_Log') f.Error = aiClean(\`DEMO simulated, nothing was sent; \${f.Error}\`, 500);
  }
}
const c = $('W13 – Resolve Clinic').first().json;`, 'W13 – Record Sends resolve clinic');
  c = replaceOnce(c, "const brief = (r) => (r ? { sent: r.sent === true, send_status:", "const brief = (r) => (r ? { sent: r.sent === true && r.send_status !== 'simulated', simulated: r.send_status === 'simulated', send_status:", 'W13 – Record Sends brief');
  n.parameters.jsCode = c;
}
// ---- W10 – Record
{
  const n = node('W10 – Record');
  n.parameters.jsCode = replaceOnce(n.parameters.jsCode, '  const r = cmStaffReplyResult(j.w10.row_id, j, now);\n', `  // DEMO PROFILE: a simulated send (nothing was sent) is recorded as such - not as a failure, and never as "sent"
  const r = j.simulated === true ? {
    message_patch: { Status: 'queued', WA_Message_ID: '', AI_Reason: 'DEMO simulated, nothing was sent' },
    conversation_patch: { Unread: 0 },
    log: { Workflow: 'W10-staff-reply', Record: \`message \${j.w10.row_id} (staff reply) [DEMO simulated, not sent]\`, Outcome: 'ok', Error: '', At: now },
  } : cmStaffReplyResult(j.w10.row_id, j, now);
`, 'W10 – Record');
}
// ---- the scheduled jobs that do not know "simulated"
const OFF = ['W3 – Every 10 minutes', 'W5 – Every 15 minutes', 'W6 – Daily 10:00', 'W7 – Every hour', 'W8 – Every hour', 'W9 – Monday 09:00'];
for (const name of OFF) {
  const t = node(name);
  if (t.type !== 'n8n-nodes-base.scheduleTrigger') fail(`"${name}" is not a schedule trigger`);
  if (t.disabled) fail(`"${name}" is already disabled`);
  t.disabled = true;
}
// ---- a read-me
const [x, y] = node('W12 – Config').position;
wf.nodes.push({
  parameters: {
    content: '## DEMO build (n8n/demo)\nW12 is in **simulate** mode (W12 – Config > w12_send_mode): every message is worked out and logged as "[DEMO simulated, not sent]" and **nothing is sent to anyone**. Keep it that way until you decide otherwise on purpose.\n\n- W13 and W10 record a simulated send as a labelled success ("DEMO simulated, nothing was sent").\n- The scheduled jobs **W3, W5, W6, W7, W8, W9 are switched off** in this build: they do not know "simulated" and would log a failure for every demo lead. Right-click > Enable to use one.\n- AI = local Ollama (W13 – Config), no paid provider. The registry id is a placeholder: paste the DEMO registry id first.\n- Do not put this workflow on a server that also holds real clinics.',
    height: 320, width: 560,
  },
  name: 'DEMO – Read Me', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [x - 40, y - 380], id: 'd3a10e57-5a2c-4a4e-8d9b-6f0c1e2b7a44',
});

wf.active = false;
const report = [];
const out = KEEP_PRIVATE ? wf : redact(wf, report);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${OUT}: ${out.nodes.length} nodes (1 added: a sticky note), active = false`);
console.log('  - W13 – Record Sends, W10 – Record: a simulated send is a labelled success, not a failure');
console.log(`  - disabled schedules: ${OFF.join(', ')}`);
console.log(`redactions: ${KEEP_PRIVATE ? 'none (--keep-private)' : report.join('; ') || 'none needed'}`);
