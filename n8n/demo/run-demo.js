// The scripted demo as a readable transcript (no services needed):
//   node n8n/demo/run-demo.js [--quiet]     exit code 0 only if every check passed
// It runs the combined demo workflow (clinic-autopilot-demo.json) in the in-repo n8n simulator with synthetic data. NOTHING is sent anywhere;
// the AI is a scripted stand-in (see DEMO.md). The same script, as a test: demo.test.js.
const { runScenario } = require('./scenario');

const quiet = process.argv.includes('--quiet');
const log = (s = '') => { if (!quiet) console.log(s); };
let failed = 0; let passed = 0;
const rec = {
  title: (s) => log(`\n=== ${s.title}`),
  say: (who, text) => log(`  ${who.padEnd(14)}> ${text}`),
  note: (t) => log(`  note: ${t}`),
  rows: (lines) => lines.forEach((l) => log(`      ${l}`)),
  check: (desc, ok, why) => { if (ok) passed++; else failed++; log(`  ${ok ? 'ok  ' : 'FAIL'}  ${desc}${ok ? '' : `\n        -> ${why}`}`); },
};
const { results } = runScenario(rec);
const bad = results.filter((r) => r.error || r.checks.some((c) => !c.ok));
console.log(`\n${failed || bad.length ? 'DEMO FAILED' : 'DEMO PASSED'}: ${passed} checks passed, ${failed} failed, in ${results.length} steps. Nothing was sent: W12 ran in simulate mode and Meta / OpenRouter were never called.`);
process.exit(failed || bad.length ? 1 : 0);
