// Builds the ONE workflow the local demo imports: the committed master + every demo layer, applied by the existing fingerprinted patchers in a fixed order.
//   node n8n/demo/build-demo-workflow.js [--in <master.json>] [--out <file>]
// Layers (each patcher refuses, and this script then writes nothing, if the file is not exactly what it expects):
//   1. apply-missed-call-capture.js --demo   MISSED_CALL_CAPTURE ("MCC –" nodes, POST /webhook/missed-call) + W12 simulate mode (w12_send_mode = simulate)
//   2. apply-ollama-provider.js --demo       local AI: W13 model_provider = ollama, deterministic FAQ fallback on (no paid provider)
//   3. apply-request-mode.js                 appointment REQUESTS (Settings > booking_mode = request, per clinic)
//   4. apply-request-confirm.js              "REQ –" section: staff confirm / decline, the patient is told through W12 only
//   5. apply-urgent-alerts.js                an emergency alerts the owner at night (the patient is not messaged at night)
//   6. apply-w2-signature.js                 W2 verifies Meta's X-Hub-Signature-256 (enforce; the App Secret is a placeholder, so it fails closed)
//   7. n8n/demo/apply-demo-profile.js        a simulated send is a labelled success for W13 / W10 (not a failure); the six scheduled jobs that do not
//                                            know "simulated" (W3, W5-W9) are switched off in this export
// Then ONE rewrite, so the demo file cannot touch the production CRM by accident: the master's Agency Registry doc id (the production one) is replaced
// everywhere by the placeholder REPLACE_WITH_DEMO_REGISTRY_DOC_ID. Until you paste the id of the DEMO registry, every Grist read fails.
// Output: saved inactive, credentials / secrets as placeholders (the patchers redact). Nothing is imported or activated anywhere.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const INTEGRATED = path.join(__dirname, '..', 'integrated');
const IN = arg('--in', path.join(INTEGRATED, 'clinic-autopilot-master-ai.json'));
const OUT = arg('--out', path.join(__dirname, 'clinic-autopilot-demo.json'));
const PRODUCTION_REGISTRY_ID = 'fAft6pAYwFUU';
const DEMO_REGISTRY_PLACEHOLDER = 'REPLACE_WITH_DEMO_REGISTRY_DOC_ID';
const STEPS = [
  [path.join(INTEGRATED, 'apply-missed-call-capture.js'), ['--demo']],
  [path.join(INTEGRATED, 'apply-ollama-provider.js'), ['--demo']],
  [path.join(INTEGRATED, 'apply-request-mode.js'), []],
  [path.join(INTEGRATED, 'apply-request-confirm.js'), []],
  [path.join(INTEGRATED, 'apply-urgent-alerts.js'), []],
  [path.join(INTEGRATED, 'apply-w2-signature.js'), []],
  [path.join(__dirname, 'apply-demo-profile.js'), []],
];
const fail = (m) => { console.error(`build-demo-workflow: ${m}\nNothing was written.`); process.exit(1); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-wf-'));
let current = IN;
STEPS.forEach(([script, extra], i) => {
  const out = path.join(tmp, `${i + 1}.json`);
  const r = spawnSync(process.execPath, [script, '--in', current, '--out', out, ...extra], { encoding: 'utf8' });
  if (r.status !== 0) fail(`step ${i + 1} (${path.basename(script)}) refused:\n${(r.stderr || r.stdout).trim()}`);
  const wf = JSON.parse(fs.readFileSync(out, 'utf8'));
  console.log(`  ${i + 1}. ${path.basename(script).padEnd(32)} ${String(wf.nodes.length).padStart(3)} nodes${extra.length ? `  (${extra.join(' ')})` : ''}`);
  current = out;
});

let text = fs.readFileSync(current, 'utf8');
const hits = text.split(PRODUCTION_REGISTRY_ID).length - 1;
if (!hits) fail('the production registry id was not found: is this the master?');
text = text.split(PRODUCTION_REGISTRY_ID).join(DEMO_REGISTRY_PLACEHOLDER);
const wf = JSON.parse(text);
if (wf.active !== false) fail('the result is not saved inactive');
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(wf, null, 2)}\n`);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${OUT}: ${wf.nodes.length} nodes, active = false; ${hits} occurrences of the production registry id replaced by ${DEMO_REGISTRY_PLACEHOLDER}`);
