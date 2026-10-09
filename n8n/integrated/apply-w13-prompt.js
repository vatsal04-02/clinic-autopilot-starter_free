// W13 prompt v2.1: puts the current n8n/snippets/ai-receptionist.js (the new prompt + the Hindi / Hinglish fact-check guards)
// into YOUR workflow export. Nothing else changes: no node added or removed, no connection, credential, webhook, Config value,
// model setting or other section touched. Only the pasted ai-receptionist.js block inside the 4 W13 Code nodes that hold it.
//   node n8n/integrated/apply-w13-prompt.js --in <workflow.json> [--out <file>] [--keep-private]
// Default output: clinic-autopilot-master-ai.json (the full master). The release copy ai-updated-workflow-clinic.w13-v2.1.json
// is the same file: node n8n/integrated/apply-w13-prompt.js --in source/ai-updated-workflow-clinic.final-v1.redacted.json --out <it>
// Fingerprinted: each block must be exactly the version before v2.1 (the W7-W10 build); a quiet-hours test switch pasted
// after it is kept as it is. If a node was edited in n8n, it stops and writes nothing.
// Output: active = false, like every other patcher here (you activate it in n8n yourself).
// Without --keep-private the output is redacted (public copy); --keep-private keeps every value of your file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redact } = require('./redact');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IN = arg('--in');
const OUT = arg('--out', path.join(__dirname, 'clinic-autopilot-master-ai.json'));
const KEEP_PRIVATE = args.includes('--keep-private');
const fail = (m) => { console.error(`apply-w13-prompt: ${m}\nNothing was written.`); process.exit(1); };
if (!IN) fail('usage: node apply-w13-prompt.js --in <workflow.json> [--out file] [--keep-private]');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

const NODES = ['W13 – Build Context', 'W13 – Plan', 'W13 – Plan Ready', 'W13 – Record Sends'];
const OLD_BLOCK = '4665e8f18f6731a9';   // ai-receptionist.js block of the W7-W10 build (before v2.1)
const SWITCH = '// ---- TEMPORARY TEST SWITCH: quiet hours';
const SNIP = fs.readFileSync(path.join(__dirname, '..', 'snippets', 'ai-receptionist.js'), 'utf8');
const NEW = SNIP.slice(SNIP.indexOf('const AI_INTENTS'), SNIP.indexOf('if (typeof module'));

// The pasted block: from "const AI_INTENTS" to the quiet-hours switch (if pasted) or to "const h = {...}".
function block(code) {
  const s = code.indexOf('const AI_INTENTS');
  const e = code.indexOf('\nconst h = { normalizeIndianPhone', s);
  if (s < 0 || e < 0 || code.indexOf('const AI_INTENTS', s + 1) >= 0) return null;
  const region = code.slice(s, e);
  const sw = region.indexOf(SWITCH);   // apply-quiet-hours-switch.js pastes its block after one blank line: that line stays with it
  return { s, len: sw < 0 ? region.length : region.slice(0, sw).endsWith('\n\n') ? sw - 1 : sw };
}

const wf = JSON.parse(fs.readFileSync(IN, 'utf8'));
let already = 0;
for (const name of NODES) {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n || n.type !== 'n8n-nodes-base.code') fail(`node "${name}" is missing`);
  const code = n.parameters.jsCode;
  const b = block(code);
  if (!b) fail(`${name}: the pasted ai-receptionist.js block was not found exactly once`);
  const cur = code.slice(b.s, b.s + b.len);
  if (cur === NEW) { already++; continue; }
  if (sha(cur) !== OLD_BLOCK) fail(`"${name}" is not the expected version (block fingerprint ${sha(cur)}, expected ${OLD_BLOCK}): it was edited in n8n. Re-export and re-check.`);
  n.parameters.jsCode = code.slice(0, b.s) + NEW + code.slice(b.s + b.len);
}
if (already === NODES.length) console.log('  the workflow already has W13 prompt v2.1: written unchanged');
else if (already) fail(`only some of the 4 nodes have v2.1 (${already} of 4): re-export and re-check`);

wf.active = false;
const report = [];
const out = KEEP_PRIVATE ? wf : redact(wf, report);
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${OUT}: ${out.nodes.length} nodes, active = false`);
console.log(`  changed: ${NODES.join(', ')} (the pasted ai-receptionist.js block only)`);
console.log(KEEP_PRIVATE ? 'redactions: none (--keep-private: every value is kept exactly as in your file)' : `redactions: ${report.length ? report.join('; ') : 'none needed'}`);
