// Fills the placeholders of the demo workflow for YOUR local machine and writes a private copy next to it (git-ignored: *.local.json):
//   node n8n/demo/fill-demo-config.js --registry-doc <demo registry doc id> [--in clinic-autopilot-demo.json] [--out clinic-autopilot-demo.local.json] [--ollama-url http://ollama:11434]
// Secrets come from the environment, never from the command line:  DEMO_CALL_SECRET  DEMO_META_APP_SECRET  (the same values the patient console uses; made-up demo values,
// NOT a real Meta App Secret).  Optional: DEMO_VERIFY_TOKEN (default "demo-verify-token"), DEMO_TEST_PHONES (default the two synthetic numbers).
// What it changes: the registry doc id in the 14 Config nodes, the two secrets, the verify token, the W12 allowlist, optionally the Ollama URL. Nothing else.
// It refuses to write anywhere but a *.local.json file, and never prints a secret.
const fs = require('fs');
const path = require('path');
const { DEMO } = require('./demo-data');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IN = arg('--in', path.join(__dirname, 'clinic-autopilot-demo.json'));
const OUT = arg('--out', path.join(__dirname, 'clinic-autopilot-demo.local.json'));
const REGISTRY = arg('--registry-doc');
const OLLAMA = arg('--ollama-url');
const fail = (m) => { console.error(`fill-demo-config: ${m}\nNothing was written.`); process.exit(1); };

if (!/\.local\.json$/.test(OUT)) fail('the output must be a *.local.json file (those are git-ignored; a file with secrets must never be committable)');
if (!REGISTRY || !/^[A-Za-z0-9]{10,40}$/.test(REGISTRY)) fail('--registry-doc <id> is required: the id of the DEMO Agency Registry document in your local Grist (the part of its URL after /doc/)');
const secret = (name) => { const v = process.env[name]; if (!v || v.length < 16 || /^(REPLACE|PASTE|CHANGE)/i.test(v)) fail(`set ${name} (at least 16 characters; ./scripts/gen-demo-secrets.sh makes one)`); return v; };
const CALL = secret('DEMO_CALL_SECRET'); const APP = secret('DEMO_META_APP_SECRET');
if (CALL === APP) fail('DEMO_CALL_SECRET and DEMO_META_APP_SECRET must differ');
if (OLLAMA && !/^https?:\/\/(host\.docker\.internal|localhost|127\.0\.0\.1|ollama)(:\d+)?$/.test(OLLAMA)) fail('--ollama-url must be http(s)://host.docker.internal | localhost | 127.0.0.1 | ollama [:port]');
const phones = process.env.DEMO_TEST_PHONES || `${DEMO.owner},${DEMO.testPhone}`;
if (!phones.split(',').every((p) => /^\+919\d{9}$/.test(p.trim()))) fail('DEMO_TEST_PHONES must be a comma list of +91XXXXXXXXXX numbers');

const wf = JSON.parse(fs.readFileSync(IN, 'utf8'));
const set = (node, key, value, mustBe) => {
  const n = wf.nodes.find((x) => x.name === node);
  const a = n && n.parameters.assignments && n.parameters.assignments.assignments.find((x) => x.name === key);
  if (!a) fail(`${node} > ${key} not found (is this the demo workflow?)`);
  if (mustBe !== undefined && !mustBe.test(String(a.value))) fail(`${node} > ${key} is not the expected placeholder (already filled?)`);
  a.value = value;
};
let n = 0;
for (const node of wf.nodes) {
  if (node.type !== 'n8n-nodes-base.set') continue;
  for (const a of node.parameters.assignments.assignments) if (a.name === 'registry_doc_id') { if (a.value !== 'REPLACE_WITH_DEMO_REGISTRY_DOC_ID') fail(`${node.name} > registry_doc_id is not the placeholder`); a.value = REGISTRY; n++; }
}
if (n < 10) fail(`only ${n} registry_doc_id placeholders found`);
set('MCC – Config', 'mcc_webhook_secret', CALL, /^REPLACE_/);
set('W2 – Signature Config', 'meta_app_secret', APP, /^REPLACE_/);
set('W2 – Verify Config', 'meta_verify_token', process.env.DEMO_VERIFY_TOKEN || 'demo-verify-token', /^PASTE_/);
set('W12 – Config', 'w12_allowlist', phones, /^PASTE_/);
if (OLLAMA) set('W13 – Config', 'ollama_base_url', OLLAMA);
wf.active = false;
fs.writeFileSync(OUT, `${JSON.stringify(wf, null, 2)}\n`);
console.log(`wrote ${OUT} (private: git-ignored): ${n} registry ids, call secret, App Secret, verify token, W12 allowlist${OLLAMA ? ', Ollama URL' : ''} filled; active = false`);
console.log('Import THIS file into your local n8n. Do not commit it, do not share it.');
