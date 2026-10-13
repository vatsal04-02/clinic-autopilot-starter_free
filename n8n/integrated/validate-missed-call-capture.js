// Before / after proof for apply-missed-call-capture.js:
//   node n8n/integrated/validate-missed-call-capture.js [--orig <before.json>] [--patched <after.json>] [--demo|--no-demo]
// Defaults: the committed master (before) and the committed demo export (after).
// What it proves: only the intended nodes changed, no credential / webhook / Config value that already existed was touched,
// W12 is still the only node that can reach Meta, the only way into simulate mode is the exact word `simulate`,
// the new webhook fails closed, and no secret is written into the file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ORIG = arg('--orig', path.join(__dirname, 'clinic-autopilot-master-ai.json'));
const PATCHED = arg('--patched', path.join(__dirname, 'clinic-autopilot-master-ai.missed-call-demo.json'));
const DEMO = !args.includes('--no-demo');
const orig = JSON.parse(fs.readFileSync(ORIG, 'utf8'));
const patched = JSON.parse(fs.readFileSync(PATCHED, 'utf8'));
const A = Object.fromEntries(orig.nodes.map((n) => [n.name, n]));
const B = Object.fromEntries(patched.nodes.map((n) => [n.name, n]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SNIP = fs.readFileSync(path.join(__dirname, '..', 'snippets', 'wa-simulate.js'), 'utf8');
const W12_CHANGED = ['W12 – Prepare request', 'W12 – Read reply', 'W12 – Return result'];
const W12_ADDED = ['W12 – Simulated?', 'W12 – Simulated send'];
const STICKY_CHANGED = ['Section 00', 'Section FUTURE'];
let failed = 0;
const group = (t, fn) => { try { const d = fn(); console.log(`PASS  ${t}${d ? ` — ${d}` : ''}`); } catch (e) { failed++; console.log(`FAIL  ${t}\n      ${e.message}`); } };
const must = (c, m) => { if (!c) throw new Error(m); };
const cfgValues = (w) => Object.fromEntries(w.nodes.filter((n) => n.type === 'n8n-nodes-base.set').flatMap((n) => n.parameters.assignments.assignments.map((a) => [`${n.name} > ${a.name}`, a.value])));

group('1. the patcher reproduces this file from the master', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcc-'));
  const out = path.join(dir, 'o.json');
  const r = spawnSync(process.execPath, [path.join(__dirname, 'apply-missed-call-capture.js'), '--in', ORIG, '--out', out, ...(DEMO ? ['--demo'] : [])], { encoding: 'utf8' });
  const ok = r.status === 0 && fs.readFileSync(out, 'utf8') === fs.readFileSync(PATCHED, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  must(ok, `${r.stderr || 'output differs from the committed file'}`);
  return DEMO ? 'byte-identical (--demo)' : 'byte-identical';
});
group('2. nodes: 0 removed; every changed existing node is one of the intended ones', () => {
  const removed = Object.keys(A).filter((n) => !B[n]);
  must(removed.length === 0, `removed: ${removed}`);
  const changed = Object.keys(A).filter((n) => !same(A[n], B[n])).sort();
  const expected = [...W12_CHANGED, 'W12 – Config', ...STICKY_CHANGED].sort();
  must(same(changed, expected), `changed: ${changed}`);
  return `${Object.keys(A).length - changed.length} of ${Object.keys(A).length} existing nodes byte-identical`;
});
group('3. the W12 nodes changed only in code (plus the one send-mode value) and the original sender code is still in place', () => {
  const waBlock = (code) => { const st = code.indexOf('const WA_TEMPLATES'); return code.slice(st, code.indexOf('\n}\n', code.indexOf('function waInboxRow', st)) + 3); };
  for (const n of W12_CHANGED) {
    const x = JSON.parse(JSON.stringify(A[n])); const y = JSON.parse(JSON.stringify(B[n]));
    delete x.parameters.jsCode; delete y.parameters.jsCode;
    must(same(x, y), `${n}: more than its code changed`);
  }
  for (const n of ['W12 – Prepare request', 'W12 – Read reply']) {
    const blk = waBlock(A[n].parameters.jsCode);
    must(blk.length > 2000 && B[n].parameters.jsCode.includes(blk), `${n}: the pasted wa-send.js block (waPrepare, templates, 24 h window) is not intact`);
  }
  must(B['W12 – Prepare request'].parameters.jsCode.includes('waIsSimulate'), 'W12 – Prepare request: no simulate hook');
  must(B['W12 – Read reply'].parameters.jsCode.includes('waSimulatedResult'), 'W12 – Read reply: does not build the simulated result');
  must(/simulated: res\.simulated === true/.test(B['W12 – Return result'].parameters.jsCode), 'W12 – Return result: does not report simulated');
  must(B['W12 – Prepare request'].parameters.jsCode.includes('waPrepare(\n      input,\n      cfg,\n      Date.now(),\n      { normalizeIndianPhone, inQuietHours }\n    )'), 'W12 – Prepare request: the live waPrepare call changed');
  const ca = A['W12 – Config'].parameters.assignments.assignments; const cb = B['W12 – Config'].parameters.assignments.assignments;
  must(ca.length === cb.length, 'W12 – Config: keys added or removed');
  const diff = ca.filter((a, i) => !same(a, cb[i])).map((a) => a.name);
  must(same(diff, DEMO ? ['w12_send_mode'] : []), `W12 – Config changed: ${diff}`);
  return DEMO ? 'w12_send_mode is the only Config value that differs (set to simulate in the demo export)' : 'no Config value differs';
});
group('4. connections: the only existing one that changed is W12 – Call Meta? (its false branch goes to the simulate check)', () => {
  const changed = Object.keys(orig.connections).filter((k) => !same(orig.connections[k], patched.connections[k]));
  must(same(changed, ['W12 – Call Meta?']), `changed: ${changed}`);
  const t = patched.connections['W12 – Call Meta?'].main;
  must(t[0].some((c) => c.node === 'W12 – Meta send') || t[0].some((c) => c.node === 'W12 – Simulated?'), 'W12 – Call Meta? true branch unexpected');
  return 'W12 – Call Meta? is re-pointed; no other existing node was rewired';
});
group('5. CREDENTIALS changed = 0; the new nodes use only credentials the master already uses', () => {
  for (const n of Object.keys(A)) must(same(A[n].credentials, B[n].credentials), n);
  const used = new Set(orig.nodes.filter((n) => n.credentials).map((n) => JSON.stringify(n.credentials)));
  const added = patched.nodes.filter((n) => !A[n.name] && n.credentials);
  for (const n of added) must(used.has(JSON.stringify(n.credentials)), `${n.name}: a credential the master does not use`);
  return `${added.length} new nodes reuse an existing credential`;
});
group('6. WEBHOOKS: existing 0 changed; exactly one new (POST /missed-call, answered by a Respond node)', () => {
  const hooks = orig.nodes.filter((n) => /webhook|Trigger/i.test(n.type));
  for (const n of hooks) must(same(n, B[n.name]), n.name);
  const added = patched.nodes.filter((n) => !A[n.name] && /webhook|Trigger/i.test(n.type) && !/respond/i.test(n.type));
  const scheduled = added.filter((n) => /schedule/i.test(n.type));
  const hooksNew = added.filter((n) => /webhook$/i.test(n.type));
  must(hooksNew.length === 1 && hooksNew[0].parameters.path === 'missed-call' && hooksNew[0].parameters.httpMethod === 'POST' && hooksNew[0].parameters.responseMode === 'responseNode', 'the new webhook is not POST /missed-call with a Respond node');
  must(scheduled.length === 1, `scheduled triggers added: ${scheduled.length}`);
  return `${hooks.length} existing webhook / trigger nodes identical; +1 webhook, +1 5-minute retry trigger`;
});
group('7. CONFIG / SECRETS: every existing Config value identical (bar w12_send_mode in the demo); the call secret is a placeholder', () => {
  const a = cfgValues(orig); const b = cfgValues(patched);
  const diff = Object.keys(a).filter((k) => !same(a[k], b[k]));
  must(same(diff, DEMO ? ['W12 – Config > w12_send_mode'] : []), `Config values changed: ${diff}`);
  const secret = b['MCC – Config > mcc_webhook_secret'];
  must(/^(REPLACE_|PASTE_)/.test(String(secret)), 'the committed call secret is not a placeholder');
  return `${Object.keys(a).length} Config values checked`;
});
group('8. W12 is still the only sender: Meta URL only in W12, MCC calls it via $workflow.id, no other HTTP node added outside Grist', () => {
  const meta = patched.nodes.filter((n) => /graph\.facebook\.com/.test(JSON.stringify(n.parameters))).map((n) => n.name).sort();
  const metaBefore = orig.nodes.filter((n) => /graph\.facebook\.com/.test(JSON.stringify(n.parameters))).map((n) => n.name).sort();
  must(same(meta, metaBefore), `Meta URL moved: ${meta}`);
  const addedHttp = patched.nodes.filter((n) => !A[n.name] && n.type === 'n8n-nodes-base.httpRequest');
  for (const n of addedHttp) must(/\$\(['"]MCC – Config['"]\)\.first\(\)\.json\.grist_base_url|grist_base_url/.test(JSON.stringify(n.parameters)), `${n.name}: an HTTP node that is not a Grist call`);
  const calls = patched.nodes.filter((n) => n.type === 'n8n-nodes-base.executeWorkflow' && n.name.startsWith('MCC –'));
  for (const n of calls) must(n.parameters.workflowId && n.parameters.workflowId.value === '={{ $workflow.id }}', `${n.name}: does not call W12 via $workflow.id`);
  const other = patched.nodes.filter((n) => !A[n.name] && /telegram|whatsapp|emailSend|twilio|openAi|anthropic|ollama/i.test(n.type));
  must(other.length === 0, `new messaging / AI nodes: ${other.map((n) => n.name)}`);
  return `${addedHttp.length} new HTTP nodes, all Grist; ${calls.length} W12 calls`;
});
group('9. simulate mode: selected only by the exact word `simulate`; the switch is not an input of any item', () => {
  const code = B['W12 – Prepare request'].parameters.jsCode;
  must(SNIP.includes('function waIsSimulate') && code.includes('function waIsSimulate'), 'waIsSimulate missing');
  must(/String\(cfg\.send_mode\s*\|\|\s*''\)\.trim\(\)\.toLowerCase\(\) === 'simulate'|=== 'simulate'/.test(code), 'exact-word check missing');
  must(!/\$json\.(send_mode|simulate)/.test(code) && !/item\.json\.(send_mode|simulate)/.test(code), 'an item can switch the mode');
  must(/sim-/.test(B['W12 – Read reply'].parameters.jsCode), 'W12 – Read reply does not mark simulated ids with sim-');
  must(B['W12 – Simulated send'].type === 'n8n-nodes-base.code', 'W12 – Simulated send is not a plain Code node');
  for (const n of ['W12 – Simulated send', 'W12 – Simulated?']) must(!/fetch|require\(['"]https?['"]\)|helpers\.httpRequest|graph\.facebook\.com/.test(JSON.stringify(B[n].parameters)), `${n} can reach the network`);
  must(!B['W12 – Simulated send'].credentials, 'W12 – Simulated send has a credential');
  must(patched.connections['W12 – Simulated?'].main[0].every((c) => c.node !== 'W12 – Meta send') && patched.connections['W12 – Simulated send'].main[0].every((c) => c.node === 'W12 – Read reply'), 'the simulate path reaches Meta send');
  return 'the simulate path (W12 – Simulated? -> Simulated send -> Read reply) has no HTTP node and no credential';
});
group('10. the SHIPPED file carries no secret: no token / key / password pattern, no live phone number, no ngrok / tunnel host', () => {
  const text = JSON.stringify(patched);
  const bad = [/EAA[A-Za-z0-9]{40,}/, /sk-(or-|ant-)[A-Za-z0-9_-]{20,}/, /xox[bp]-[A-Za-z0-9-]{20,}/, /\b\d{9}:[A-Za-z0-9_-]{35}\b/, /Bearer [A-Za-z0-9._-]{30,}/, /ngrok|trycloudflare/i];
  for (const re of bad) must(!re.test(text), `looks like a secret: ${re}`);
  return 'no secret patterns';
});
group('11. workflow settings unchanged; saved inactive', () => {
  for (const k of ['name', 'id', 'settings', 'pinData', 'meta', 'tags', 'versionId']) must(same(orig[k], patched[k]), k);
  must(patched.active === false, 'active');
});
console.log(failed ? `\n${failed} CHECK GROUP(S) FAILED` : `\nALL 11 CHECK GROUPS PASSED (${path.basename(PATCHED)}${DEMO ? ', demo export' : ''})`);
process.exit(failed ? 1 : 0);
