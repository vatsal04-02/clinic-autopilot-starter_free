// Mutation tests for the Ollama provider + FAQ fallback: each safety rule is broken once in a copy of the patched workflow, and the end-to-end
// test (ollama-provider.test.js) must then FAIL on the checks that cover that rule. A mutation it does not notice would mean the rule is not
// really tested.   Run: node n8n/integrated/ollama-provider-mutations.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const MASTER = path.join(__dirname, 'clinic-autopilot-master-ai.json');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-mut-'));
const built = path.join(dir, 'demo.json');
const r0 = spawnSync(process.execPath, [path.join(__dirname, 'apply-ollama-provider.js'), '--in', MASTER, '--out', built, '--demo'], { encoding: 'utf8' });
assert.strictEqual(r0.status, 0, r0.stderr);
const BASE = JSON.parse(fs.readFileSync(built, 'utf8'));
const node = (w, n) => { const x = w.nodes.find((y) => y.name === n); assert(x, `no node ${n}`); return x; };
const code = (w, n, from, to) => { const x = node(w, n); assert(x.parameters.jsCode.includes(from), `${n}: mutation target missing: ${from.slice(0, 70)}`); x.parameters.jsCode = x.parameters.jsCode.split(from).join(to); };
const cfg = (w, k, v) => { node(w, 'W13 – Config').parameters.assignments.assignments.find((a) => a.name === k).value = v; };
const M = [
  ['the Ollama branch is never taken (Provider? always false)', (w) => { node(w, 'W13 – Provider?').parameters.conditions.conditions[0].leftValue = '={{ false }}'; }, ['O3']],
  ['every provider goes to Ollama (Provider? always true)', (w) => { node(w, 'W13 – Provider?').parameters.conditions.conditions[0].leftValue = '={{ true }}'; }, ['O5']],
  ['a public Ollama host is accepted without ollama_allow_remote', (w) => { for (const n of ['W13 – Ollama Request', 'W13 – Ollama Answer']) code(w, n, 'if (!aiOllamaHostIsLocal(m[2]) && !remoteOk)', 'if (false)'); }, ['O4']],
  ['the prompt is not checked against num_ctx', (w) => { code(w, 'W13 – Ollama Request', 'if (need > o.num_ctx)', 'if (false)'); }, ['O4']],
  ['the model name is not validated', (w) => { for (const n of ['W13 – Ollama Request', 'W13 – Ollama Answer']) code(w, n, "if (!/^[A-Za-z0-9][A-Za-z0-9._:\\/-]{0,99}$/.test(model))", 'if (false)'); }, ['O4']],
  ['the configured timeout is ignored', (w) => { delete node(w, 'W13 – Ask Ollama').parameters.options.timeout; }, ['O3', 'O4']],
  ['Ask Ollama retries on failure', (w) => { node(w, 'W13 – Ask Ollama').retryOnFail = true; node(w, 'W13 – Ask Ollama').maxTries = 3; }, ['O1']],
  ['Ask Ollama is given a credential', (w) => { node(w, 'W13 – Ask Ollama').credentials = { httpHeaderAuth: { id: 'x', name: 'OpenRouter API' } }; }, ['O1']],
  ['Ask Ollama stops the run on error instead of continuing', (w) => { node(w, 'W13 – Ask Ollama').onError = 'stopWorkflow'; }, ['O1', 'O8']],
  ['faq_fallback is ignored (the FAQ answers even when off)', (w) => { code(w, 'W13 – Plan', "String($('W13 – Config').first().json.faq_fallback || '').trim().toLowerCase() === 'on'", 'true'); }, ['O8']],
  ['the FAQ answer skips aiPlan (sent without the fact check / gates)', (w) => { code(w, 'W13 – Plan', 'plan = aiPlan(decision || faq, b.x, b.cfg);', 'plan = aiPlan(decision, b.x, b.cfg); if (faq) { plan.route = "reply"; plan.reply = faq.reply; plan.intent = faq.intent; plan.action = "reply"; plan.confidence = 0.9; plan.conversation_patch = {}; plan.lead_patch = {}; }'); }, ['O10b']],
  ['the FAQ answers booking / medical questions (the not-routine list is gone)', (w) => { code(w, 'W13 – Plan', "if (AI_FAQ_NOT_ROUTINE.test(t)) return null;", ''); }, ['O10']],
  ['the FAQ answer is not marked as a fallback', (w) => { code(w, 'W13 – Plan', "plan.reason = `FAQ fallback (the AI was unusable: ${ai_error})`.slice(0, 300);", "plan.reason = '';"); }, ['O9']],
  ['the Run_Log trace names the OpenRouter model again', (w) => { const rs = node(w, 'W13 – Record Sends'); const before = rs.parameters.jsCode; rs.parameters.jsCode = before.replace(/model: u\.model \|\| \(String[\s\S]*?\(st\.openrouter_model \|\| st\.anthropic_model\)\) \|\| ''/, "model: u.model || st.openrouter_model || st.anthropic_model || ''"); assert.notStrictEqual(rs.parameters.jsCode, before, 'trace mutation target missing'); }, ['O9']],
  ['the demo build still points at OpenRouter', (w) => { cfg(w, 'model_provider', 'openrouter'); }, ['O1', 'O3']],
  ['the model sees the patient message as an instruction (not wrapped)', (w) => { for (const n of ['W13 – Ollama Request']) code(w, n, 'if (!o.ok) return [{ json: { config_error: o.error } }];\nconst req = $(\'W13 – Build Context\').first().json.request;', 'if (!o.ok) return [{ json: { config_error: o.error } }];\nconst req = $(\'W13 – Build Context\').first().json.request; req.messages = req.messages.map((m) => ({ ...m, content: String(m.content).replace(/<\\/?patient_message>/g, "") }));'); }, ['O3', 'O7']],
];
let missed = 0;
for (const [name, mutate, expect] of M) {
  const w = JSON.parse(JSON.stringify(BASE));
  mutate(w);
  const f = path.join(dir, 'mutant.json');
  fs.writeFileSync(f, JSON.stringify(w));
  const r = spawnSync(process.execPath, [path.join(__dirname, 'ollama-provider.test.js')], { encoding: 'utf8', env: { ...process.env, OLLAMA_MUTANT: f }, maxBuffer: 1 << 26 });
  const failing = (r.stdout.match(/^FAIL  (O\d+b?)/gm) || []).map((l) => l.replace('FAIL  ', ''));
  const caught = r.status !== 0 && expect.every((e) => failing.includes(e));
  if (!caught) missed++;
  console.log(`  ${caught ? 'caught ' : 'MISSED '} ${name.padEnd(80)} failing: ${failing.join(',') || '(none)'}`);
}
fs.rmSync(dir, { recursive: true, force: true });
if (missed) { console.log(`\n${missed} mutation(s) were not caught`); process.exit(1); }
console.log(`\nOLLAMA PROVIDER: all ${M.length} mutations caught by the end-to-end test`);
