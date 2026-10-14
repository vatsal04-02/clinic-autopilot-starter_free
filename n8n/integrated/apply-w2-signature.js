// W2 META SIGNATURE CHECK on your workflow: every POST to /webhook/whatsapp-inbound must carry a valid X-Hub-Signature-256 (HMAC-SHA256 of the raw
// body with your Meta App Secret), else it gets a 401 and nothing is read or written.
//   node n8n/integrated/apply-w2-signature.js --in <workflow.json> [--out <file>] [--mode enforce|log|off] [--app-secret <secret>] [--keep-private]
//
// Changes ONE existing node: W2 – Webhook Inbound gets the option "Raw Body" (the signature is over the exact bytes; re-serialised JSON does not work).
// Adds 4 nodes between it and W2 – Config:  W2 – Signature Config (the App Secret and the mode) -> W2 – Verify Signature (Code) -> W2 – Signature OK?
//   -> yes: W2 – Config (unchanged from here)   -> no: W2 – Respond Unauthorized (401, body {"status":"unauthorized"}; the reason stays in the execution)
// The manual test node (W2 – Test Cases) and the GET verification (W2 – Webhook Verify) do not go through it.
// Mode (default enforce): enforce = reject; log = verify and note the result but let it through (a roll-out aid, NOT a protection); off = today's behaviour.
// --app-secret writes the secret into the file: it then holds a secret, is NOT redacted, name it *.local.json (git-ignored) and never commit it.
// Without it the secret is a placeholder and, in enforce mode, EVERY inbound message is rejected until you set it (fail closed).
// Anything unexpected (a node edited in n8n, the check already applied) = nothing is written. Output: active = false.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redact, PH_APP_SECRET } = require('./redact');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IN = arg('--in');
const OUT = arg('--out', path.join(__dirname, 'clinic-autopilot-master-ai.w2-signature.json'));
const MODE = arg('--mode', 'enforce');
const SECRET = arg('--app-secret', '');
const KEEP_PRIVATE = args.includes('--keep-private') || !!SECRET;
if (!IN) { console.error('usage: node apply-w2-signature.js --in <workflow.json> [--out file] [--mode enforce|log|off] [--app-secret value] [--keep-private]'); process.exit(1); }
if (!['enforce', 'log', 'off'].includes(MODE)) { console.error('--mode must be enforce, log or off'); process.exit(1); }
const fail = (m) => { console.error(`apply-w2-signature: ${m}\nNothing was written.`); process.exit(1); };
const uuid = (s) => { const h = crypto.createHash('sha1').update(`w2-signature:${s}`).digest('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`; };
const SNIPPETS = path.join(__dirname, '..', 'snippets');
const snip = (f) => fs.readFileSync(path.join(SNIPPETS, f), 'utf8');
const HMAC_SRC = snip('hmac-sha256.js');
const HMAC_BLOCK = HMAC_SRC.slice(HMAC_SRC.indexOf('function utf8Bytes'), HMAC_SRC.indexOf('if (typeof module'));
const SIG_SRC = snip('meta-signature.js');
const SIG_BLOCK = SIG_SRC.slice(SIG_SRC.indexOf('const META_SIG_MODES'), SIG_SRC.indexOf('if (typeof module'));

const wf = JSON.parse(fs.readFileSync(IN, 'utf8'));
const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
const node = (name) => byName[name] || fail(`node "${name}" is missing (is this the master with W2?)`);
for (const n of ['W2 – Signature Config', 'W2 – Verify Signature', 'W2 – Signature OK?', 'W2 – Respond Unauthorized']) if (byName[n]) fail(`the workflow already has "${n}"`);
const inbound = node('W2 – Webhook Inbound');
if (JSON.stringify(inbound.parameters) !== JSON.stringify({ httpMethod: 'POST', path: 'whatsapp-inbound', responseMode: 'responseNode', options: {} })) fail('"W2 – Webhook Inbound" is not the expected POST /whatsapp-inbound (responseNode, no options): it was edited in n8n');
const out0 = wf.connections['W2 – Webhook Inbound'];
if (!out0 || !out0.main || out0.main.length !== 1 || out0.main[0].length !== 1 || out0.main[0][0].node !== 'W2 – Config') fail('"W2 – Webhook Inbound" is not wired to "W2 – Config" alone');
const respond = node('W2 – Respond Forbidden');
const ifRef = node('W2 – Verify OK?');
const setRef = node('W2 – Verify Config');
const codeRef = node('W2 – Check Verify Token');

inbound.parameters.options = { rawBody: true };

// place the new nodes in a free band next to the webhook
const [px, py] = inbound.position;
const free = (dy) => [0, 1, 2, 3].every((i) => !wf.nodes.some((n) => Math.abs(n.position[0] - (px + i * 224)) < 200 && Math.abs(n.position[1] - (py + dy)) < 150));
const dy = [-352, -176, 176, 352, -528, 528].find(free) || -352;
const at = (i) => [px + i * 224, py + dy];

const verifyCode = `// W2 META SIGNATURE CHECK. Meta signs the EXACT bytes of the POST (X-Hub-Signature-256 = sha256=HMAC-SHA256(App Secret, raw body)). The raw body comes from the
// Webhook node option "Raw Body" (binary property "data", default in-memory storage). Pasted from n8n/snippets/hmac-sha256.js and meta-signature.js - keep identical.
${HMAC_BLOCK}
${SIG_BLOCK}
// ---- this node ----
const web = $('W2 – Webhook Inbound').first();                 // the request as received, with its raw body
const cfg = $('W2 – Signature Config').first().json;           // the App Secret and the mode (they are NOT passed on)
const r = metaSigVerify({ headers: (web.json || {}).headers, binary: web.binary, secret: cfg.meta_app_secret, mode: cfg.w2_signature_mode });
// Only the request goes on (same fields as before), plus the result. __w2_* keys are dropped by W2 – Parse Meta Event. The reason stays in this execution.
return [{ json: { ...web.json, __w2_sig: r.state, __w2_sig_reason: r.reason } }];
`;
const assignments = [['meta_app_secret', SECRET || PH_APP_SECRET], ['w2_signature_mode', MODE]];
const cfgNode = {
  parameters: { assignments: { assignments: assignments.map(([name, value]) => ({ id: uuid(`cfg:${name}`), name, value, type: 'string' })) }, includeOtherFields: false, options: {} },
  name: 'W2 – Signature Config', type: setRef.type, typeVersion: setRef.typeVersion, position: at(0), id: uuid('W2 – Signature Config'),
};
const verifyNode = { parameters: { jsCode: verifyCode }, name: 'W2 – Verify Signature', type: codeRef.type, typeVersion: codeRef.typeVersion, position: at(1), id: uuid('W2 – Verify Signature') };
const okNode = {
  parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: uuid('ok-cond'), leftValue: "={{ $json.__w2_sig !== 'bad' }}", rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} },
  name: 'W2 – Signature OK?', type: ifRef.type, typeVersion: ifRef.typeVersion, position: at(2), id: uuid('W2 – Signature OK?'),
};
const unauthorized = {
  parameters: { respondWith: 'text', responseBody: '{"status":"unauthorized"}', options: { responseCode: 401, responseHeaders: { entries: [{ name: 'Content-Type', value: 'application/json' }] } } },
  name: 'W2 – Respond Unauthorized', type: respond.type, typeVersion: respond.typeVersion, position: at(3), id: uuid('W2 – Respond Unauthorized'),
};
wf.nodes.push(cfgNode, verifyNode, okNode, unauthorized);
const link = (from, outputs) => { wf.connections[from] = { main: outputs.map((l) => l.map((to) => ({ node: to, type: 'main', index: 0 }))) }; };
link('W2 – Webhook Inbound', [['W2 – Signature Config']]);
link('W2 – Signature Config', [['W2 – Verify Signature']]);
link('W2 – Verify Signature', [['W2 – Signature OK?']]);
link('W2 – Signature OK?', [['W2 – Config'], ['W2 – Respond Unauthorized']]);

wf.active = false;
const report = [];
const out = KEEP_PRIVATE ? wf : redact(wf, report);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${OUT}: ${out.nodes.length} nodes (4 added), active = false, mode = ${MODE}`);
console.log('  - W2 – Webhook Inbound: option Raw Body on');
console.log('  - W2 – Webhook Inbound -> Signature Config -> Verify Signature -> Signature OK? -> W2 – Config | W2 – Respond Unauthorized (401)');
console.log(SECRET ? '  - meta_app_secret written into W2 – Signature Config: this file holds a secret, do not commit it' : '  - W2 – Signature Config > meta_app_secret is a placeholder: in enforce mode every inbound message is rejected until you set it');
console.log(`redactions: ${KEEP_PRIVATE ? 'none (--keep-private / --app-secret)' : report.join('; ') || 'none needed'}`);
