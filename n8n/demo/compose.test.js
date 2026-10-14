// The demo stack file keeps its promises: nothing is published beyond this machine, the n8n editor / webhooks / Grist / Ollama / FLOW HQ are
// reachable from localhost only, versions and secrets are required (no default secret), nothing runs on the host network, and no secret is committed.
// When the docker CLI is present the file is also validated with `docker compose config` (syntax and interpolation only: no container is started).
// Run: node n8n/demo/compose.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.demo.yml'), 'utf8');
const envEx = fs.readFileSync(path.join(ROOT, '.env.demo.example'), 'utf8');
const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
const results = [];
const check = (id, title, fn) => { try { const why = fn(); results.push({ id, title, ok: true, why }); } catch (e) { results.push({ id, title, ok: false, why: e.message.split('\n')[0] }); } };
const code = compose.split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#.*$/, '')).join('\n');   // comments may explain; configuration may not do it

check('D1', 'every published port is bound to 127.0.0.1 (the n8n editor and webhooks, Grist, Ollama, FLOW HQ); no 0.0.0.0, no host network, no privileged container', () => {
  const ports = [...code.matchAll(/^\s*-\s*"([^"]*:\d+(?::\d+)?)"\s*$/gm)].map((m) => m[1]).filter((p) => /^\d|^\[?[0-9a-f.:]+\]?:\d+:\d+$/i.test(p));
  assert(ports.length >= 4, `ports found: ${ports}`);
  for (const p of ports) assert(p.startsWith('127.0.0.1:'), `published beyond localhost: ${p}`);
  assert(!/0\.0\.0\.0|network_mode|privileged|cap_add|pid:\s*host/.test(code), 'host network / privileged / 0.0.0.0');
  return `${ports.length} ports, all 127.0.0.1`;
});
check('D2', 'no reverse proxy, tunnel or public domain in the demo stack', () => { assert(!/caddy|cloudflared|ngrok|traefik|N8N_DOMAIN|GRIST_DOMAIN|https:\/\//i.test(code), 'a public-facing component or an https domain'); });
check('D3', 'versions and every secret are REQUIRED (:?), none has a default value; the sandbox default is only for demo data', () => {
  for (const v of ['N8N_VERSION', 'GRIST_VERSION', 'N8N_ENCRYPTION_KEY', 'GRIST_SESSION_SECRET', 'FLOWHQ_SESSION_SECRET', 'DEMO_GRIST_API_KEY', 'DEMO_REGISTRY_DOC_ID']) assert(new RegExp(`\\$\\{${v}:\\?`).test(code), `${v} is not required`);
  assert(!/(SECRET|KEY|PASSWORD|TOKEN)\w*(=|:)\s*[A-Za-z0-9+/_-]{16,}\s*$/m.test(code), 'a literal secret');
});
check('D4', 'Ollama and FLOW HQ are optional profiles; FLOW HQ runs with demo-safe cookie settings and the real backend (not the built-in sample data)', () => {
  assert(/ollama:\s*\n\s*profiles:\s*\["ollama"\]/.test(code) && /flowhq:\s*\n\s*profiles:\s*\["flowhq"\]/.test(code));
  assert(/FLOWHQ_DEMO=false/.test(code) && /GRIST_BASE_URL=http:\/\/grist:8484/.test(code));
});
check('D5', '.env.demo is git-ignored; the example holds no value for a secret, a key or a version', () => {
  assert(/^\.env\.demo$/m.test(gitignore), '.env.demo is not in .gitignore');
  for (const k of ['N8N_VERSION', 'GRIST_VERSION', 'N8N_ENCRYPTION_KEY', 'GRIST_SESSION_SECRET', 'FLOWHQ_SESSION_SECRET', 'DEMO_REGISTRY_DOC_ID', 'DEMO_GRIST_API_KEY', 'DEMO_CALL_SECRET', 'DEMO_META_APP_SECRET']) assert(new RegExp(`^${k}=$`, 'm').test(envEx), `${k} has a value in the example`);
  assert(!/WHATSAPP_TOKEN|ANTHROPIC|OPENROUTER|CLOUDFLARE|ACCESS_TOKEN/i.test(envEx), 'the demo example mentions a real provider credential');
});
check('D6', 'docker compose config accepts the file (syntax + interpolation; no container is started)', () => {
  const v = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (v.status !== 0) return 'skipped: docker compose is not installed here';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-compose-'));
  const env = path.join(dir, 'env');
  fs.writeFileSync(env, envEx.replace(/^(N8N_VERSION|GRIST_VERSION)=$/gm, '$1=1.0.0').replace(/^([A-Z0-9_]+)=$/gm, '$1=placeholder-value'));
  const r = spawnSync('docker', ['compose', '-f', path.join(ROOT, 'docker-compose.demo.yml'), '--env-file', env, '--profile', 'ollama', '--profile', 'flowhq', 'config', '-q'], { encoding: 'utf8' });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(r.status, 0, r.stderr);
  const bare = spawnSync('docker', ['compose', '-f', path.join(ROOT, 'docker-compose.demo.yml'), '--env-file', path.join(ROOT, '.env.demo.example'), 'config', '-q'], { encoding: 'utf8' });
  assert.notStrictEqual(bare.status, 0, 'the empty example must NOT start a stack (versions and secrets are required)');
  return 'valid with values; refuses the empty example';
});
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id} ${r.title}${r.ok ? (r.why ? ` — ${r.why}` : '') : `\n        ${r.why}`}`);
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} DEMO STACK CHECKS FAILED` : `\nDEMO STACK FILE: ${results.length} of ${results.length} checks pass`);
process.exit(bad.length ? 1 : 0);
