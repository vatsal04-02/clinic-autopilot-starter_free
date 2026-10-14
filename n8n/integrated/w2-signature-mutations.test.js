// Mutation tests for the W2 signature check: each protection is broken once in a copy of the patched workflow, and the end-to-end test
// (w2-signature.test.js) must then FAIL on the checks that cover it. A mutation it does not notice would mean the protection is not really tested.
// Run: node n8n/integrated/w2-signature-mutations.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const MASTER = path.join(__dirname, 'clinic-autopilot-master-ai.json');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2sig-mut-'));
const built = path.join(dir, 'sig.json');
const r0 = spawnSync(process.execPath, [path.join(__dirname, 'apply-w2-signature.js'), '--in', MASTER, '--out', built], { encoding: 'utf8' });
assert.strictEqual(r0.status, 0, r0.stderr);
const BASE = JSON.parse(fs.readFileSync(built, 'utf8'));
const node = (w, n) => { const x = w.nodes.find((y) => y.name === n); assert(x, `no node ${n}`); return x; };
const code = (w, from, to, name = 'W2 – Verify Signature') => { const x = node(w, name); assert(x.parameters.jsCode.includes(from), `${name}: mutation target missing: ${from.slice(0, 70)}`); x.parameters.jsCode = x.parameters.jsCode.split(from).join(to); };
const M = [
  ['the gate lets everything through (Signature OK? always true)', (w) => { node(w, 'W2 – Signature OK?').parameters.conditions.conditions[0].leftValue = '={{ true }}'; }, ['S3', 'S4', 'S5']],
  ['the signature is never compared (safeEqual always true)', (w) => code(w, 'return safeEqual(expected, m[1].toLowerCase())', 'return true || safeEqual(expected, m[1].toLowerCase())' + ' ? { state: "ok", ok: true, reason: "" } : fail("x")'), ['S3']],
  ['a request without the raw body is checked against re-serialised JSON instead', (w) => code(w, 'binary: web.binary,', "binary: web.binary || { data: { data: Buffer.from(JSON.stringify((web.json || {}).body)).toString('base64') } },"), ['S3']],
  ['the check runs on re-serialised JSON, not the raw bytes', (w) => code(w, 'binary: web.binary,', "binary: { data: { data: Buffer.from(JSON.stringify((web.json || {}).body)).toString('base64') } },"), ['S2', 'S9']],
  ['a placeholder / short App Secret is accepted', (w) => code(w, 'return s.length >= 8 && !/^(REPLACE_|PASTE_)/i.test(s);', 'return true;'), ['S4']],
  ['an unknown mode word means off (a typo opens the door)', (w) => code(w, "return META_SIG_MODES.includes(s) ? s : 'enforce';", "return META_SIG_MODES.includes(s) ? s : 'off';"), ['S5']],
  ['log mode is the default', (w) => { node(w, 'W2 – Signature Config').parameters.assignments.assignments.find((a) => a.name === 'w2_signature_mode').value = 'log'; }, ['S1', 'S3']],
  ['the App Secret travels on with the request', (w) => code(w, "return [{ json: { ...web.json, __w2_sig: r.state, __w2_sig_reason: r.reason } }];", "return [{ json: { ...web.json, meta_app_secret: cfg.meta_app_secret, __w2_sig: r.state, __w2_sig_reason: r.reason } }];"), ['S6']],
  ['the raw body travels on with every item', (w) => code(w, "return [{ json: { ...web.json, __w2_sig: r.state, __w2_sig_reason: r.reason } }];", "return [{ json: { ...web.json, __w2_sig: r.state, __w2_sig_reason: r.reason }, binary: web.binary }];"), ['S6']],
  ['the rejection answers 200', (w) => { node(w, 'W2 – Respond Unauthorized').parameters.options.responseCode = 200; }, ['S1', 'S3']],
  ['the rejection explains itself to the caller', (w) => { node(w, 'W2 – Respond Unauthorized').parameters.responseBody = '={{ $json.__w2_sig_reason }}'; }, ['S3']],
  ['the gate sends rejected requests on to W2 – Config as well', (w) => { w.connections['W2 – Signature OK?'].main[1] = [{ node: 'W2 – Respond Unauthorized', type: 'main', index: 0 }, { node: 'W2 – Config', type: 'main', index: 0 }]; }, ['S3']],
];
let missed = 0;
for (const [name, mutate, expect] of M) {
  const w = JSON.parse(JSON.stringify(BASE));
  mutate(w);
  const f = path.join(dir, 'mutant.json');
  fs.writeFileSync(f, JSON.stringify(w));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'w2-signature.test.js')], { encoding: 'utf8', env: { ...process.env, SIG_MUTANT: f }, maxBuffer: 1 << 26 });
  const failing = (r.stdout.match(/^FAIL  (S\d+)/gm) || []).map((l) => l.replace('FAIL  ', ''));
  const caught = r.status !== 0 && expect.every((e) => failing.includes(e));
  if (!caught) missed++;
  console.log(`  ${caught ? 'caught ' : 'MISSED '} ${name.padEnd(86)} failing: ${failing.join(',') || '(none)'}`);
}
fs.rmSync(dir, { recursive: true, force: true });
const n = M.length;
if (missed) { console.log(`\n${missed} mutation(s) were not caught`); process.exit(1); }
console.log(`\nW2 SIGNATURE: all ${n} mutations caught by the end-to-end test`);
