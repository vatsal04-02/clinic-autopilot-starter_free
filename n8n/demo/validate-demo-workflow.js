// Before / after proof for the combined demo workflow (n8n/demo/build-demo-workflow.js):
//   node n8n/demo/validate-demo-workflow.js [--orig <master.json>] [--demo <demo.json>]
// What it proves: the file is exactly what the chain of fingerprinted patchers produces from the master; nothing was removed; only the intended
// existing nodes / wiring / Config values changed; no credential changed; Meta can only be reached by W12 – Meta send and the demo's W12 mode is
// "simulate"; AI is the local Ollama only; the new webhook fails closed; the production registry id is gone; no secret is in the file; saved inactive.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ORIG = arg('--orig', path.join(__dirname, '..', 'integrated', 'clinic-autopilot-master-ai.json'));
const DEMO = arg('--demo', path.join(__dirname, 'clinic-autopilot-demo.json'));
const orig = JSON.parse(fs.readFileSync(ORIG, 'utf8'));
const demo = JSON.parse(fs.readFileSync(DEMO, 'utf8'));
const A = Object.fromEntries(orig.nodes.map((n) => [n.name, n]));
const B = Object.fromEntries(demo.nodes.map((n) => [n.name, n]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const PRODUCTION_REGISTRY_ID = 'fAft6pAYwFUU';
const PLACEHOLDER = 'REPLACE_WITH_DEMO_REGISTRY_DOC_ID';
// every existing node a layer is allowed to change (code / text / one option), and why
const EXPECTED_NODES = {
  'W12 – Prepare request': 'MCC: simulate hook', 'W12 – Read reply': 'MCC: simulated result', 'W12 – Return result': 'MCC: simulated flag', 'W12 – Config': 'MCC: w12_send_mode = simulate',
  'Section 00': 'MCC: read-me', 'Section FUTURE': 'MCC: read-me',
  'W13 – Config': 'Ollama: provider + settings', 'W13 – Plan': 'Ollama FAQ fallback + request mode', 'W13 – Record Sends': 'Ollama trace + urgent alerts',
  'W13 – Appointments': 'request mode: reads Requested', 'W13 – Build Context': 'request mode: prompt addendum', 'W9 – Metrics': 'request mode: weekly total ignores requests',
  'W13 – Plan Ready': 'urgent alerts', 'W2 – Webhook Inbound': 'signature: Raw Body option',
  'W10 – Record': 'demo profile: a simulated staff reply is recorded as such',
  'W3 – Every 10 minutes': 'demo profile: switched off', 'W5 – Every 15 minutes': 'demo profile: switched off', 'W6 – Daily 10:00': 'demo profile: switched off',
  'W7 – Every hour': 'demo profile: switched off', 'W8 – Every hour': 'demo profile: switched off', 'W9 – Monday 09:00': 'demo profile: switched off',
};
const SWITCHED_OFF = ['W3 – Every 10 minutes', 'W5 – Every 15 minutes', 'W6 – Daily 10:00', 'W7 – Every hour', 'W8 – Every hour', 'W9 – Monday 09:00'];
const EXPECTED_CONNECTIONS = ['W12 – Call Meta?', 'W13 – Claim Message', 'W13 – Claim?', 'W2 – Webhook Inbound'];
let failed = 0;
const group = (t, fn) => { try { const d = fn(); console.log(`PASS  ${t}${d ? ` — ${d}` : ''}`); } catch (e) { failed++; console.log(`FAIL  ${t}\n      ${e.message}`); } };
const must = (c, m) => { if (!c) throw new Error(m); };
const cfgValues = (w) => Object.fromEntries(w.nodes.filter((n) => n.type === 'n8n-nodes-base.set').flatMap((n) => n.parameters.assignments.assignments.map((a) => [`${n.name} > ${a.name}`, a.value])));
const a = cfgValues(orig); const b = cfgValues(demo);

group('1. the build script reproduces this file from the master', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-val-'));
  const out = path.join(dir, 'o.json');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'build-demo-workflow.js'), '--in', ORIG, '--out', out], { encoding: 'utf8' });
  const ok = r.status === 0 && fs.readFileSync(out, 'utf8') === fs.readFileSync(DEMO, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  must(ok, r.stderr || 'output differs from the committed file');
  return 'byte-identical';
});
group('2. nodes: 0 removed; the changed existing nodes are exactly the intended ones', () => {
  const removed = Object.keys(A).filter((n) => !B[n]);
  must(removed.length === 0, `removed: ${removed}`);
  const changed = Object.keys(A).filter((n) => !same(A[n], B[n])).sort();
  // a node outside the list may differ ONLY by the production registry id -> placeholder
  const registryOnly = changed.filter((n) => !EXPECTED_NODES[n]);
  for (const n of registryOnly) must(JSON.stringify(B[n]).split(PLACEHOLDER).join(PRODUCTION_REGISTRY_ID) === JSON.stringify(A[n]), `${n}: changed in more than the registry id`);
  const intended = changed.filter((n) => EXPECTED_NODES[n]);
  must(same(intended, Object.keys(EXPECTED_NODES).sort()), `intended nodes that did not change / unexpected: ${intended}`);
  return `${Object.keys(A).length - changed.length} of ${Object.keys(A).length} existing nodes byte-identical; ${intended.length} intended nodes changed; ${registryOnly.length} more only by the registry id; ${demo.nodes.length - orig.nodes.length} nodes added`;
});
group('3. connections: only the intended existing ones were re-pointed', () => {
  const changed = Object.keys(orig.connections).filter((k) => !same(orig.connections[k], demo.connections[k])).sort();
  must(same(changed, EXPECTED_CONNECTIONS), `changed: ${changed}`);
  const names = new Set(demo.nodes.map((n) => n.name));
  for (const [from, c] of Object.entries(demo.connections)) { must(names.has(from), `connection from a missing node ${from}`); for (const outs of c.main || []) for (const t of outs || []) must(names.has(t.node), `${from} -> missing node ${t.node}`); }
  return `${changed.length} re-pointed; every connection ends at a real node`;
});
group('4. CREDENTIALS: none changed; new nodes reuse only credentials the master already uses; Ollama and the missed-call section use none of their own', () => {
  for (const n of Object.keys(A)) must(same(A[n].credentials, B[n].credentials), n);
  const used = new Set(orig.nodes.filter((n) => n.credentials).map((n) => JSON.stringify(n.credentials)));
  const added = demo.nodes.filter((n) => !A[n.name] && n.credentials);
  for (const n of added) must(used.has(JSON.stringify(n.credentials)), `${n.name}: a credential the master does not use`);
  must(!B['W13 – Ask Ollama'].credentials && B['W13 – Ask Ollama'].parameters.authentication === 'none', 'W13 – Ask Ollama has a credential');
  return `${added.length} new nodes with a credential (all already used by the master)`;
});
group('5. WEBHOOKS / TRIGGERS: existing 0 changed except W2 (Raw Body only) and the six schedules switched off (disabled only); new: POST /missed-call (Respond node), a 5-minute and a 2-minute schedule; nothing else', () => {
  for (const n of orig.nodes.filter((x) => /webhook|Trigger/i.test(x.type) && x.name !== 'W2 – Webhook Inbound' && !SWITCHED_OFF.includes(x.name))) must(same(n, B[n.name]), n.name);
  for (const name of SWITCHED_OFF) { const off = JSON.parse(JSON.stringify(B[name])); must(off.disabled === true && !A[name].disabled, `${name} is not switched off`); delete off.disabled; must(same(off, A[name]), `${name}: changed in more than disabled`); }
  must(demo.nodes.filter((n) => /scheduleTrigger|webhook$/i.test(n.type) && n.disabled).map((n) => n.name).sort().join() === [...SWITCHED_OFF].sort().join(), 'a trigger other than W3 / W5-W9 is switched off');
  const w2a = JSON.parse(JSON.stringify(A['W2 – Webhook Inbound'])); const w2b = JSON.parse(JSON.stringify(B['W2 – Webhook Inbound']));
  must(w2b.parameters.options && w2b.parameters.options.rawBody === true, 'W2 – Webhook Inbound: rawBody is not on');
  delete w2b.parameters.options.rawBody; if (!Object.keys(w2b.parameters.options).length && !w2a.parameters.options) delete w2b.parameters.options;
  must(same(w2a, w2b), 'W2 – Webhook Inbound changed in more than the Raw Body option');
  const added = demo.nodes.filter((n) => !A[n.name] && /^n8n-nodes-base\.(webhook|scheduleTrigger)$/.test(n.type));
  const hooks = added.filter((n) => n.type === 'n8n-nodes-base.webhook');
  must(hooks.length === 1 && hooks[0].parameters.path === 'missed-call' && hooks[0].parameters.httpMethod === 'POST' && hooks[0].parameters.responseMode === 'responseNode', 'the only new webhook must be POST /missed-call with a Respond node');
  must(added.filter((n) => /schedule/i.test(n.type)).map((n) => n.name).sort().join() === 'MCC – Every 5 minutes,REQ – Every 2 minutes', 'unexpected new schedules');
  return 'no other trigger was added; W3, W5, W6, W7, W8, W9 switched off, everything else (W10, W13 morning run, MCC, REQ, webhooks) on';
});
group('6. CONFIG: only these values differ from the master - w12_send_mode = simulate, model_provider = ollama, the production registry id -> placeholder; everything added is a local default or a placeholder', () => {
  const diff = Object.keys(a).filter((k) => !same(a[k], b[k])).sort();
  const registry = diff.filter((k) => /registry_doc_id$/.test(k));
  const rest = diff.filter((k) => !/registry_doc_id$/.test(k));
  must(same(rest, ['W12 – Config > w12_send_mode', 'W13 – Config > model_provider']), `Config values changed: ${rest}`);
  must(b['W12 – Config > w12_send_mode'] === 'simulate' && b['W13 – Config > model_provider'] === 'ollama', 'demo switches are not set');
  for (const k of registry) must(a[k] === PRODUCTION_REGISTRY_ID && b[k] === PLACEHOLDER, `${k}`);
  const all = Object.keys(b).filter((k) => /registry_doc_id$/.test(k));
  for (const k of all) must(b[k] === PLACEHOLDER, `${k} is not the placeholder`);
  must(b['W13 – Config > faq_fallback'] === 'on' && b['W13 – Config > ollama_allow_remote'] === false, 'faq_fallback / ollama_allow_remote');
  must(/^https?:\/\/(host\.docker\.internal|localhost|127\.0\.0\.1|ollama)(:\d+)?$/.test(b['W13 – Config > ollama_base_url']), `ollama_base_url is not local: ${b['W13 – Config > ollama_base_url']}`);
  must(b['W2 – Signature Config > w2_signature_mode'] === 'enforce', 'signature mode is not enforce');
  for (const k of ['MCC – Config > mcc_webhook_secret', 'W2 – Signature Config > meta_app_secret']) must(/^REPLACE_/.test(String(b[k])), `${k} is not a placeholder`);
  return `${diff.length} existing Config values changed (${registry.length} registry ids); secrets are placeholders, so the new webhooks fail closed`;
});
group('7. NO PRODUCTION CRM: the production registry id appears nowhere in the file', () => {
  must(!JSON.stringify(demo).includes(PRODUCTION_REGISTRY_ID), 'the production registry id is still in the file');
  return `${JSON.stringify(demo).split(PLACEHOLDER).length - 1} places hold the placeholder: Grist reads fail until the demo registry id is pasted`;
});
group('8. SENDING: Meta is reachable only from W12 – Meta send; the demo sets W12 to simulate; every message comes from a W12 run; no other messaging node', () => {
  const meta = demo.nodes.filter((n) => /graph\.facebook\.com/.test(JSON.stringify(n.parameters))).map((n) => n.name).sort();
  const before = orig.nodes.filter((n) => /graph\.facebook\.com/.test(JSON.stringify(n.parameters))).map((n) => n.name).sort();
  must(same(meta, before), `Meta URL moved: ${meta}`);
  const calls = demo.nodes.filter((n) => n.type === 'n8n-nodes-base.executeWorkflow' && /^(MCC|REQ) – /.test(n.name));
  must(calls.length >= 3, `expected the MCC and REQ calls to W12, found ${calls.length}`);
  for (const n of calls) must(n.parameters.workflowId && n.parameters.workflowId.value === '={{ $workflow.id }}', `${n.name}: does not call W12 via $workflow.id`);
  const other = demo.nodes.filter((n) => !A[n.name] && /telegram|whatsapp|emailSend|twilio|openAi|anthropic/i.test(n.type));
  must(other.length === 0, `new messaging / AI nodes: ${other.map((n) => n.name)}`);
  must(!B['W12 – Simulated send'].credentials && B['W12 – Simulated send'].type === 'n8n-nodes-base.code', 'the simulated send is not a plain Code node');
  must(b['W12 – Config > w12_send_mode'] === 'simulate', 'W12 is not in simulate mode');
  return `${calls.length} section calls to W12 via $workflow.id; W12 – Config > w12_send_mode = simulate`;
});
group('9. NETWORK: the only new HTTP nodes talk to Grist (config URL) or the local Ollama; no new host is written into any node', () => {
  const added = demo.nodes.filter((n) => !A[n.name] && n.type === 'n8n-nodes-base.httpRequest');
  const odd = added.filter((n) => !/grist_base_url|\$json\.url/.test(JSON.stringify(n.parameters)) && !/ollama_base_url/.test(JSON.stringify(n.parameters)));
  must(odd.length === 0, `HTTP nodes that are neither Grist nor Ollama: ${odd.map((n) => n.name)}`);
  // hosts written into Config values and HTTP node URLs (code comments / regexes are not endpoints)
  const endpoints = (w) => [...w.nodes.flatMap((n) => (n.type === 'n8n-nodes-base.set' ? n.parameters.assignments.assignments.map((x) => String(x.value)) : n.type === 'n8n-nodes-base.httpRequest' ? [String(n.parameters.url || '')] : []))];
  const hostsOf = (w) => new Set(endpoints(w).flatMap((v) => [...v.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1].toLowerCase())));
  const newHosts = [...hostsOf(demo)].filter((h) => !hostsOf(orig).has(h));
  must(newHosts.every((h) => /^(host\.docker\.internal|localhost|127\.0\.0\.1|grist|ollama|n8n)$/.test(h)), `new hosts: ${newHosts}`);
  return `${added.length} new HTTP nodes; new hosts: ${newHosts.join(', ') || 'none'}`;
});
group('10. the SHIPPED file carries no secret: no token / key / password pattern, no tunnel host', () => {
  const text = JSON.stringify(demo);
  const bad = [/EAA[A-Za-z0-9]{40,}/, /sk-(or-|ant-)[A-Za-z0-9_-]{20,}/, /xox[bp]-[A-Za-z0-9-]{20,}/, /\b\d{9}:[A-Za-z0-9_-]{35}\b/, /Bearer [A-Za-z0-9._-]{30,}/, /ngrok|trycloudflare/i];
  for (const re of bad) must(!re.test(text), `looks like a secret: ${re}`);
  return 'no secret patterns';
});
group('11. quiet-hours test switch and workflow settings: the switch is exactly as in the master; settings / name / id unchanged; saved inactive', () => {
  const count = (w) => w.nodes.filter((n) => /DISABLE_QUIET_HOURS_FOR_TEST\s*=\s*true/.test(JSON.stringify(n.parameters))).length;
  must(count(orig) === count(demo), `the quiet-hours switch changed: ${count(orig)} -> ${count(demo)} nodes`);
  for (const k of ['name', 'id', 'settings', 'pinData', 'meta', 'tags', 'versionId']) must(same(orig[k], demo[k]), k);
  must(demo.active === false, 'active');
  return `DISABLE_QUIET_HOURS_FOR_TEST = true in ${count(demo)} nodes, as shipped (so a demo works at any hour; set it to false to see the 21:00-08:00 rule)`;
});
console.log(failed ? `\n${failed} CHECK GROUP(S) FAILED` : `\nALL 11 CHECK GROUPS PASSED (${path.basename(DEMO)})`);
process.exit(failed ? 1 : 0);
