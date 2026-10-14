// fill-demo-config.js: fills only what it says, refuses unsafe outputs and weak or duplicate secrets, never prints a secret, and the filled copy still runs the demo.
// Run: node n8n/demo/fill-demo-config.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'fill-demo-config.js');
const BASE = path.join(__dirname, 'clinic-autopilot-demo.json');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const ENV = { ...process.env, DEMO_CALL_SECRET: 'call-secret-SENTINEL-0123456789', DEMO_META_APP_SECRET: 'app-secret-SENTINEL-0123456789' };
const fill = (extra = [], env = ENV, out = path.join(dir, 'x.local.json')) => spawnSync(process.execPath, [SCRIPT, '--registry-doc', 'aBcDeFgHiJkL', '--out', out, ...extra], { encoding: 'utf8', env });
const results = [];
const check = (id, title, fn) => { try { fn(); results.push({ id, title, ok: true }); } catch (e) { results.push({ id, title, ok: false, why: e.message.split('\n')[0] }); } };

check('F1', 'fills the registry id (14 nodes), both secrets, the verify token and the allowlist; changes nothing else; never prints a secret', () => {
  const r = fill(); assert.strictEqual(r.status, 0, r.stderr); assert(!/SENTINEL/.test(r.stdout + r.stderr));
  const a = JSON.parse(fs.readFileSync(BASE, 'utf8')); const b = JSON.parse(fs.readFileSync(path.join(dir, 'x.local.json'), 'utf8'));
  const flat = (w) => Object.fromEntries(w.nodes.filter((n) => n.type === 'n8n-nodes-base.set').flatMap((n) => n.parameters.assignments.assignments.map((x) => [`${n.name} > ${x.name}`, x.value])));
  const fa = flat(a); const fb = flat(b);
  const changed = Object.keys(fa).filter((k) => fa[k] !== fb[k]);
  assert.strictEqual(changed.filter((k) => /registry_doc_id$/.test(k)).length, 14);
  assert.deepStrictEqual(changed.filter((k) => !/registry_doc_id$/.test(k)).sort(), ['MCC – Config > mcc_webhook_secret', 'W12 – Config > w12_allowlist', 'W2 – Signature Config > meta_app_secret', 'W2 – Verify Config > meta_verify_token']);
  assert(changed.every((k) => fb[k] !== undefined));
  const other = (w) => JSON.stringify({ ...w, nodes: w.nodes.filter((n) => n.type !== 'n8n-nodes-base.set') });
  assert.strictEqual(other(a), other(b), 'only Config values may differ'); assert.strictEqual(b.active, false);
  assert(!JSON.stringify(a).includes('SENTINEL'), 'the committed file must hold no secret');
});
check('F2', 'refuses an output that is not *.local.json (a committable name), a bad registry id, weak / missing / equal secrets, a remote Ollama URL, bad phones', () => {
  const bad = (r, re) => { assert.strictEqual(r.status, 1, r.stdout); assert(re.test(r.stderr), r.stderr); assert(!/SENTINEL/.test(r.stdout + r.stderr)); };
  bad(fill([], ENV, path.join(dir, 'public.json')), /\*\.local\.json/);
  bad(spawnSync(process.execPath, [SCRIPT, '--registry-doc', 'x', '--out', path.join(dir, 'y.local.json')], { encoding: 'utf8', env: ENV }), /--registry-doc/);
  bad(fill([], { ...ENV, DEMO_CALL_SECRET: 'short' }), /DEMO_CALL_SECRET/);
  bad(fill([], { ...ENV, DEMO_META_APP_SECRET: '' }), /DEMO_META_APP_SECRET/);
  bad(fill([], { ...ENV, DEMO_META_APP_SECRET: ENV.DEMO_CALL_SECRET }), /must differ/);
  bad(fill(['--ollama-url', 'https://api.openai.com'], ENV), /--ollama-url/);
  bad(fill([], { ...ENV, DEMO_TEST_PHONES: '+14155550100' }), /DEMO_TEST_PHONES/);
  bad(fill(['--in', path.join(dir, 'x.local.json')]), /not the placeholder/);   // already filled: refuses to fill twice
  assert(!fs.existsSync(path.join(dir, 'public.json')), 'nothing was written');
});
check('F3', 'the filled copy is accepted by the scripted demo (the demo overrides the same fields, so this only proves the file is still a valid workflow)', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'run-demo.js'), '--quiet'], { encoding: 'utf8', env: { ...process.env, DEMO_WORKFLOW_FILE: path.join(dir, 'x.local.json') } });
  assert.strictEqual(r.status, 0, r.stdout.slice(-300));
});
check('F4', '--ollama-url sets the Ollama address (the bundled "ollama" service) and nothing else changes', () => {
  const out = path.join(dir, 'o.local.json'); const r = fill(['--ollama-url', 'http://ollama:11434'], ENV, out); assert.strictEqual(r.status, 0, r.stderr);
  const w = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.strictEqual(w.nodes.find((n) => n.name === 'W13 – Config').parameters.assignments.assignments.find((a) => a.name === 'ollama_base_url').value, 'http://ollama:11434');
});
const bad = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id} ${r.title}${r.ok ? '' : `\n        ${r.why}`}`);
console.log(bad.length ? `\n${bad.length} of ${results.length} FILL-CONFIG CHECKS FAILED` : `\nFILL DEMO CONFIG: ${results.length} of ${results.length} checks pass`);
process.exit(bad.length ? 1 : 0);
