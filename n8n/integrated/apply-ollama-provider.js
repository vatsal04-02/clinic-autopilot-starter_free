// OLLAMA (local AI, no paid API) as a second model provider for W13, plus the deterministic FAQ fallback:
//   node n8n/integrated/apply-ollama-provider.js --in <workflow.json> [--out <file>] [--demo] [--keep-private]
//
// Adds to the W13 section (nothing removed; every existing node keeps its id, position and credentials):
//   W13 – Provider?  (IF: W13 – Config > model_provider = ollama)  true -> the Ollama nodes, false -> W13 – Provider Request (unchanged: OpenRouter)
//   W13 – Ollama Request -> W13 – Ollama Ready? -> W13 – Ask Ollama (POST <ollama_base_url>/api/chat, no credential) -> W13 – Ollama Answer -> W13 – Plan
//   W13 – Config: ollama_base_url, ollama_model, ollama_timeout_ms, ollama_num_ctx, ollama_keep_alive, ollama_allow_remote, faq_fallback.
// Changes in two existing nodes (code only, each checked first): W13 – Record Sends (the Run_Log trace names the Ollama model, not the OpenRouter one) and W13 – Plan, which gets the ai-faq-fallback.js block and, when the model gave no
// usable decision AND faq_fallback = on, plans the knowledge-base answer to a clear routine question instead of a plain hand-off. The
// decision goes through aiValidateDecision, aiPlan and the fact check exactly like a model decision. Wiring change: W13 – Claim? (false) and
// W13 – Claim Message (ok) now go to W13 – Provider? (which sends "openrouter" to the old node, so nothing changes for OpenRouter).
// Without --demo: model_provider stays as it is (openrouter) and faq_fallback = off: the patched workflow behaves as before.
// With --demo: model_provider = ollama and faq_fallback = on. Ollama needs no key; the base URL must be local / private (see ai-ollama.js).
// Anything unexpected (a node edited in n8n, the nodes already added) = nothing is written. Output: active = false.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redact } = require('./redact');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IN = arg('--in');
const OUT = arg('--out', path.join(__dirname, 'clinic-autopilot-master-ai.ollama-demo.json'));
const DEMO = args.includes('--demo');
const KEEP_PRIVATE = args.includes('--keep-private');
if (!IN) { console.error('usage: node apply-ollama-provider.js --in <workflow.json> [--out file] [--demo] [--keep-private]'); process.exit(1); }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const fail = (m) => { console.error(`apply-ollama-provider: ${m}\nNothing was written.`); process.exit(1); };
const SNIPPETS = path.join(__dirname, '..', 'snippets');
const snip = (f) => fs.readFileSync(path.join(SNIPPETS, f), 'utf8');
const uuid = (s) => { const h = crypto.createHash('sha1').update(`ollama-provider:${s}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };

// the master (W13 prompt v2.2): the tail of W13 – Plan that this patcher replaces
const PLAN_TAIL_FINGERPRINT = 'f64af4a4079ef6fe';
const PLAN_TAIL = `  plan = aiPlan(decision, b.x, b.cfg);
  if (ai_error) plan.reason = \`\${plan.reason}: \${ai_error}\`.slice(0, 300);
`;
const PLAN_TAIL_NEW = `  // DEMO (W13 – Config > faq_fallback = on): the model gave nothing usable -> a clear routine question (prices, services, hours, location,
  // hello, thanks) is answered from the knowledge base, with no model. The decision is checked and planned exactly like a model's.
  let faq = null;
  if (!decision && ai_error && String($('W13 – Config').first().json.faq_fallback || '').trim().toLowerCase() === 'on') {
    const fd = aiFaqDecision(b.x);
    if (fd && !aiValidateDecision(fd).length) faq = fd;
  }
  plan = aiPlan(decision || faq, b.x, b.cfg);
  if (faq && plan.route !== 'handoff') { plan.faq_fallback = true; plan.reason = \`FAQ fallback (the AI was unusable: \${ai_error})\`.slice(0, 300); }
  else if (ai_error) plan.reason = \`\${plan.reason}: \${ai_error}\`.slice(0, 300);
`;

// W13 – Record Sends names the model in the Run_Log trace; when the call failed there is no usage, and it would name the OpenRouter model
const TRACE_OLD = "model: u.model || st.openrouter_model || st.anthropic_model || ''";
const TRACE_NEW = "model: u.model || (String($('W13 – Config').first().json.model_provider || '').trim().toLowerCase() === 'ollama' ? String($('W13 – Config').first().json.ollama_model || '') : (st.openrouter_model || st.anthropic_model)) || ''";

const wf = JSON.parse(fs.readFileSync(IN, 'utf8'));
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
const node = (name) => byName[name] || fail(`node "${name}" is missing (is this the master with the W13 section?)`);
const NEW = ['W13 – Provider?', 'W13 – Ollama Request', 'W13 – Ollama Ready?', 'W13 – Ask Ollama', 'W13 – Ollama Answer', 'W13 – Ollama Read Me'];
const taken = NEW.filter((n) => byName[n]);
if (taken.length) fail(`the workflow already has Ollama nodes (${taken.join(', ')})`);

// ---------------------------------------------------------------- 1. preconditions
const plan = node('W13 – Plan');
if ((plan.parameters.jsCode.split(PLAN_TAIL).length - 1) !== 1) fail('"W13 – Plan" does not contain the expected decision tail exactly once: it was edited in n8n, or this is not the master with W13 prompt v2.2');
if (sha(PLAN_TAIL) !== PLAN_TAIL_FINGERPRINT) fail('internal: the tail fingerprint does not match this script');
if (plan.parameters.jsCode.includes('aiFaqDecision')) fail('"W13 – Plan" already has the FAQ fallback');
const cfgNode = node('W13 – Config');
const cfgList = cfgNode.parameters.assignments.assignments;
const cfgGet = (k) => cfgList.find((a) => a.name === k);
if (!cfgGet('model_provider') || cfgGet('model_provider').value !== 'openrouter') fail('W13 – Config > model_provider is not "openrouter": this patcher adds Ollama NEXT TO the OpenRouter provider of the master');
for (const k of cfgList.map((a) => a.name)) if (/^ollama_|^faq_fallback$/.test(k)) fail(`W13 – Config already has ${k}`);
const claimQ = wf.connections['W13 – Claim?'];
const claimMsg = wf.connections['W13 – Claim Message'];
const only = (c, i, to) => c && c.main && c.main[i] && c.main[i].length === 1 && c.main[i][0].node === to;
if (!only(claimQ, 1, 'W13 – Provider Request') || !only(claimMsg, 0, 'W13 – Provider Request')) fail('the wiring Claim? / Claim Message -> W13 – Provider Request is not as expected');
for (const n of ['W13 – Provider Request', 'W13 – Ask Model', 'W13 – Provider Answer']) node(n);
if (!only(wf.connections['W13 – Provider Answer'], 0, 'W13 – Plan')) fail('W13 – Provider Answer is not wired to W13 – Plan');

// ---------------------------------------------------------------- 2. Config
const OLLAMA_SRC = snip('ai-ollama.js');
const OLLAMA_BLOCK = OLLAMA_SRC.slice(OLLAMA_SRC.indexOf('const AI_OLLAMA_DEFAULTS'), OLLAMA_SRC.indexOf('if (typeof module'));
const FAQ_SRC = snip('ai-faq-fallback.js');
const FAQ_BLOCK = FAQ_SRC.slice(FAQ_SRC.indexOf('const AI_FAQ_MAX_TEXT'), FAQ_SRC.indexOf('if (typeof module'));
const D = { base_url: 'http://host.docker.internal:11434', model: 'qwen2.5:7b-instruct', timeout_ms: 60000, num_ctx: 8192, keep_alive: '10m' };
{
  const at = cfgList.findIndex((a) => a.name === 'openrouter_model') + 1;
  const add = [
    ['ollama_base_url', D.base_url, 'string'], ['ollama_model', D.model, 'string'], ['ollama_timeout_ms', D.timeout_ms, 'number'],
    ['ollama_num_ctx', D.num_ctx, 'number'], ['ollama_keep_alive', D.keep_alive, 'string'], ['ollama_allow_remote', false, 'boolean'],
    ['faq_fallback', DEMO ? 'on' : 'off', 'string'],
  ].map(([name, value, type]) => ({ id: uuid(`config:${name}`), name, value, type }));
  cfgList.splice(at, 0, ...add);
  if (DEMO) cfgGet('model_provider').value = 'ollama';
}

// ---------------------------------------------------------------- 3. W13 – Plan: the FAQ block + the tail
{
  const marker = '// ---- this node ----\n';
  if (plan.parameters.jsCode.split(marker).length !== 2) fail('"W13 – Plan": the "this node" marker was not found exactly once');
  let code = plan.parameters.jsCode.replace(marker, () => `// ---- pasted from n8n/snippets/ai-faq-fallback.js - keep identical ----\n${FAQ_BLOCK}\n${marker}`);
  code = code.replace(PLAN_TAIL, () => PLAN_TAIL_NEW);
  plan.parameters.jsCode = code;
}

// ---------------------------------------------------------------- 3b. W13 – Record Sends: the trace names the Ollama model when Ollama is the provider
{
  const rs = node('W13 – Record Sends');
  if (rs.parameters.jsCode.split(TRACE_OLD).length !== 2) fail('"W13 – Record Sends" does not contain the expected trace line exactly once');
  rs.parameters.jsCode = rs.parameters.jsCode.replace(TRACE_OLD, () => TRACE_NEW);
}

// ---------------------------------------------------------------- 4. the Ollama nodes
const ref = node('W13 – Provider Answer');
const [rx, ry] = node('W13 – Provider Request').position;
const colX = (i) => rx + i * 240;
const rowY = ry + 640;   // below the OpenRouter chain
const code = (name, jsCode, i, j = 0) => ({ parameters: { jsCode }, name, type: 'n8n-nodes-base.code', typeVersion: ref.typeVersion, position: [colX(i), rowY + j * 176], id: uuid(name) });
const ifNode = (name, expr, i, j = 0) => ({
  parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: uuid(`${name}-cond`), leftValue: expr, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} },
  name, type: 'n8n-nodes-base.if', typeVersion: node('W13 – Claim?').typeVersion, position: [colX(i), rowY + j * 176], id: uuid(name),
});
const providerQ = ifNode('W13 – Provider?', "={{ String($('W13 – Config').first().json.model_provider || '').trim().toLowerCase() === 'ollama' }}", 0, -1);
providerQ.position = [node('W13 – Claim?').position[0] + 240, node('W13 – Claim?').position[1]];
const ollamaRequest = code('W13 – Ollama Request', `// PROVIDER LAYER (Ollama, local AI). The request W13 – Build Context made (rules, clinic facts, this message's facts, the patient's message as data,
// the decision schema) -> the SAME request for Ollama's native chat API (aiToOllama). Settings come from W13 – Config (ollama_*). A bad setting, or a
// prompt that does not fit ollama_num_ctx, does NOT stop the run: the message is already marked "processing", so it must still get a hand-off or an
// FAQ answer. W13 – Ollama Answer turns config_error into the usual "AI unusable" path.
${OLLAMA_BLOCK}
// ---- this node ----
const o = aiOllamaSettings($('W13 – Config').first().json);
if (!o.ok) return [{ json: { config_error: o.error } }];
const req = $('W13 – Build Context').first().json.request;
try {
  return [{ json: { url: o.url, timeout_ms: o.timeout_ms, body: aiToOllama(req, o) } }];
} catch (e) {
  return [{ json: { config_error: String(e && e.message ? e.message : e).slice(0, 300) } }];
}
`, 0);
const ready = ifNode('W13 – Ollama Ready?', '={{ !$json.config_error }}', 1);
const ask = {
  parameters: {
    method: 'POST', url: '={{ $json.url }}', authentication: 'none', sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}',
    options: { timeout: '={{ $json.timeout_ms }}' },
  },
  name: 'W13 – Ask Ollama', type: 'n8n-nodes-base.httpRequest', typeVersion: node('W13 – Ask Model').typeVersion, position: [colX(2), rowY], id: uuid('W13 – Ask Ollama'),
  onError: 'continueRegularOutput',
};
const answer = code('W13 – Ollama Answer', `// PROVIDER LAYER (Ollama, local AI). Ollama's answer, or n8n's { error } item when the call failed, timed out or was never made (bad setting)
// -> the Anthropic-shaped answer W13 – Plan reads (aiFromOllama -> aiParseResponse). Nothing is decided here: W13 – Plan validates the JSON decision
// and runs every safety check exactly as with Claude; an unusable answer becomes the FAQ fallback (faq_fallback = on) or a hand-off to a person.
${OLLAMA_BLOCK}
// ---- this node ----
const rq = $('W13 – Ollama Request').first().json;
if (rq.config_error) return [{ json: { error: { message: \`Ollama: not configured (\${rq.config_error})\`.slice(0, 300) } } }];
return [{ json: aiFromOllama($json, aiOllamaSettings($('W13 – Config').first().json)) }];
`, 3);
const readMe = {
  parameters: {
    content: `## W13 — Ollama (local AI, no paid API)\nW13 – Config > model_provider = **ollama** sends the SAME request W13 builds (rules, clinic facts, the patient's message as data, the decision schema) to a local Ollama: POST <ollama_base_url>/api/chat, **no key, no credential**. Anything else = the OpenRouter nodes above, unchanged.\n\n- Settings (W13 – Config): ollama_base_url (local / private host only, unless ollama_allow_remote = true), ollama_model, ollama_timeout_ms, ollama_num_ctx (the prompt is checked against it first), ollama_keep_alive.\n- The answer is validated like any model answer: JSON schema, confidence tiers, fact check, emergency and hand-off rules. Not reachable / timeout / not JSON / bad setting = **no reply from the model**.\n- faq_fallback = on: then a clear routine question (prices, services, hours, location, hello, thanks) is answered from the Knowledge table with no model (ai-faq-fallback.js, checked like a model decision). Everything else = hand-off to a person, as before.\n- Sending is still decided by Settings > ai_mode (off / draft / auto) and W12 (w12_send_mode). Nothing here sends.`,
    height: 380, width: 720,
  },
  name: 'W13 – Ollama Read Me', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [colX(0), rowY + 224], id: uuid('W13 – Ollama Read Me'),
};
wf.nodes.push(providerQ, ollamaRequest, ready, ask, answer, readMe);
for (const nn of wf.nodes) byName[nn.name] = nn;

const link = (from, outputs) => { wf.connections[from] = { main: outputs.map((l) => l.map((to) => ({ node: to, type: 'main', index: 0 }))) }; };
link('W13 – Provider?', [['W13 – Ollama Request'], ['W13 – Provider Request']]);
link('W13 – Ollama Request', [['W13 – Ollama Ready?']]);
link('W13 – Ollama Ready?', [['W13 – Ask Ollama'], ['W13 – Ollama Answer']]);
link('W13 – Ask Ollama', [['W13 – Ollama Answer']]);
link('W13 – Ollama Answer', [['W13 – Plan']]);
claimQ.main[1] = [{ node: 'W13 – Provider?', type: 'main', index: 0 }];
claimMsg.main[0] = [{ node: 'W13 – Provider?', type: 'main', index: 0 }];

wf.active = false;
const report = [];
const out = KEEP_PRIVATE ? wf : redact(wf, report);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${OUT}: ${out.nodes.length} nodes (${NEW.length} added), active = false${DEMO ? ', DEMO: model_provider = ollama, faq_fallback = on' : ''}`);
console.log('  - W13 – Provider? -> W13 – Ollama Request -> W13 – Ollama Ready? -> W13 – Ask Ollama (no credential) -> W13 – Ollama Answer -> W13 – Plan');
console.log('  - W13 – Record Sends: the trace names the Ollama model when Ollama is the provider');
console.log('  - W13 – Plan: ai-faq-fallback.js block + tail (the model gave nothing usable and faq_fallback = on -> an FAQ answer from the knowledge base)');
console.log(`  - model_provider: ${DEMO ? 'ollama' : 'unchanged (openrouter)'}; faq_fallback: ${DEMO ? 'on' : 'off'}`);
console.log(`redactions: ${KEEP_PRIVATE ? 'none (--keep-private)' : report.join('; ') || 'none needed'}`);
