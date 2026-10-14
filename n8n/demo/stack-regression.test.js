// STACKING: every layer has its own end-to-end suite, written against that layer applied to the master alone. This test applies the layers TOGETHER
// (in the order the demo uses) and re-runs those suites on the stacked file, so one layer cannot silently break another.
// A suite assumes the configuration it was written for (unsigned requests, a live-style W12, OpenRouter or Ollama), so three stacks are built:
//   A  MCC + Ollama(off) + request mode + request confirm + urgent alerts + signature(off)  -> request-mode, request-confirm, urgent-alerts
//   B  the same with Ollama --demo                                                          -> ollama-provider
//   C  MCC + Ollama(off) + signature(enforce)                                               -> w2-signature
//   D  the demo chain as built for the demo, but WITHOUT the registry-id rewrite (the suites key their fake CRM by the master's id) -> missed-call-capture
// Run: node n8n/demo/stack-regression.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const I = path.join(__dirname, '..', 'integrated');
const MASTER = path.join(I, 'clinic-autopilot-master-ai.json');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-'));
process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ } });
const patch = (script, input, out, extra = []) => {
  const r = spawnSync(process.execPath, [path.isAbsolute(script) ? script : path.join(I, script), '--in', input, '--out', out, ...extra], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${script}: ${r.stderr || r.stdout}`);
  return out;
};
const chain = (name, steps) => steps.reduce((input, [script, extra], i) => patch(script, input, path.join(dir, `${name}-${i}.json`), extra), MASTER);
const suite = (file, envVar, wf, expect) => {
  const r = spawnSync(process.execPath, [path.join(I, file)], { encoding: 'utf8', env: { ...process.env, [envVar]: wf }, maxBuffer: 1 << 26 });
  const last = (r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
  const ok = r.status === 0 && expect.test(last);
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${file.padEnd(32)} ${last.slice(0, 90)}`);
  if (!ok) { console.log((r.stdout || '').split('\n').filter((l) => /^FAIL/.test(l)).slice(0, 8).join('\n')); }
  return ok;
};

const COMMON = [['apply-missed-call-capture.js', []], ['apply-ollama-provider.js', []], ['apply-request-mode.js', []], ['apply-request-confirm.js', []], ['apply-urgent-alerts.js', []]];
const A = chain('A', [...COMMON, ['apply-w2-signature.js', ['--mode', 'off']]]);
const B = chain('B', [COMMON[0], ['apply-ollama-provider.js', ['--demo']], ...COMMON.slice(2), ['apply-w2-signature.js', ['--mode', 'off']]]);
const C = chain('C', [COMMON[0], COMMON[1], ['apply-w2-signature.js', []]]);
const D = chain('D', [['apply-missed-call-capture.js', ['--demo']], ['apply-ollama-provider.js', ['--demo']], COMMON[2], COMMON[3], COMMON[4], ['apply-w2-signature.js', []], [path.join(__dirname, 'apply-demo-profile.js'), []]]);
console.log('layers applied together:');
const results = [
  suite('request-mode.test.js', 'REQUEST_FILE', A, /16 of 16 checks pass/),
  suite('request-confirm.test.js', 'CONFIRM_FILE', A, /13 of 13 checks pass/),
  suite('urgent-alerts.test.js', 'URGENT_FILE', A, /9 of 9 checks pass/),
  suite('ollama-provider.test.js', 'OLLAMA_FILE', B, /14 of 14 checks pass/),
  suite('w2-signature.test.js', 'SIG_FILE', C, /9 of 9 checks pass/),
  suite('missed-call-capture.test.js', 'MCC_FILE', D, /22 of 22 checks pass/),
];
if (results.includes(false)) { console.log('\nSTACKING: a layer broke another'); process.exit(1); }
console.log(`\nSTACKING: ${results.length} layer suites pass on the stacked workflows (A, B, C and the demo chain)`);
