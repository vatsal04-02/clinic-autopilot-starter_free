// Mutation tests for validate-demo-workflow.js: each unsafe change is made once in a copy of the demo workflow, and the validator must FAIL on the
// check group that covers it. Run: node n8n/demo/demo-workflow-mutations.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const BASE = JSON.parse(fs.readFileSync(path.join(__dirname, 'clinic-autopilot-demo.json'), 'utf8'));
const node = (w, n) => { const x = w.nodes.find((y) => y.name === n); assert(x, `no node ${n}`); return x; };
const cfg = (w, n, key, v) => { const a = node(w, n).parameters.assignments.assignments.find((x) => x.name === key); assert(a, `${n} > ${key}`); a.value = v; };
const M = [
  ['W12 is switched to a real send mode', (w) => cfg(w, 'W12 – Config', 'w12_send_mode', 'live'), [6]],
  ['the production registry id is back in a Config value', (w) => cfg(w, 'W1 – Config', 'registry_doc_id', 'fAft6pAYwFUU'), [6, 7]],
  ['a credential of an existing node is changed', (w) => { const n = w.nodes.find((x) => x.credentials); n.credentials = { httpHeaderAuth: { id: 'EVIL', name: 'Another credential' } }; }, [4]],
  ['a second node talks to Meta', (w) => { node(w, 'W3 – Config').parameters.notes = 'https://graph.facebook.com/v21.0/123/messages'; }, [8, 2]],
  ['an existing node is removed', (w) => { w.nodes = w.nodes.filter((n) => n.name !== 'W9 – Metrics'); }, [2]],
  ['a switched-off schedule is switched on again', (w) => { delete node(w, 'W5 – Every 15 minutes').disabled; }, [2, 5]],
  ['Ollama points at a remote host', (w) => cfg(w, 'W13 – Config', 'ollama_base_url', 'https://models.example.org'), [6, 9]],
  ['an API key is pasted into a node', (w) => { node(w, 'W13 – Config').parameters.notes = 'sk-or-v1-abcdefghijklmnopqrstuvwxyz0123456789'; }, [10]],
  ['the workflow is saved active', (w) => { w.active = true; }, [11]],
  ['a second webhook is added', (w) => { const n = JSON.parse(JSON.stringify(node(w, 'MCC – Webhook'))); n.name = 'EVIL – Webhook'; n.parameters.path = 'anything'; n.id = 'evil-1'; w.nodes.push(n); }, [5]],
  ['the missed-call secret is a real-looking value instead of a placeholder', (w) => cfg(w, 'MCC – Config', 'mcc_webhook_secret', 'a-real-looking-secret-value-123456'), [6]],
  ['the signature mode is log (a forged request is let through)', (w) => cfg(w, 'W2 – Signature Config', 'w2_signature_mode', 'log'), [6]],
];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-val-mut-'));
let missed = 0;
for (const [name, mutate, expect] of M) {
  const w = JSON.parse(JSON.stringify(BASE));
  mutate(w);
  const f = path.join(dir, 'mutant.json');
  fs.writeFileSync(f, JSON.stringify(w, null, 2));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'validate-demo-workflow.js'), '--demo', f], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const failing = (r.stdout.match(/^FAIL  (\d+)\./gm) || []).map((l) => Number(l.replace(/\D/g, '')));
  const caught = r.status !== 0 && expect.every((e) => failing.includes(e));
  if (!caught) missed++;
  console.log(`  ${caught ? 'caught ' : 'MISSED '} ${name.padEnd(76)} failing groups: ${failing.join(',') || '(none)'}`);
}
fs.rmSync(dir, { recursive: true, force: true });
if (missed) { console.log(`\n${missed} mutation(s) were not caught`); process.exit(1); }
console.log(`\nDEMO WORKFLOW VALIDATOR: all ${M.length} mutations caught`);
