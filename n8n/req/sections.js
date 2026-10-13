// SECTION REQUEST_CONFIRM of the master workflow ("REQ –" nodes): the second half of request mode. Staff set a request (Appointments.Status
// = Requested, Booking_UID "req-...") to Booked or Declined in Grist; every 2 minutes this section
//   * REFUSES a confirmation whose slot is already taken (Cal.com booking, another confirmed row): the row goes back to Requested, a Run_Log row says why;
//   * tells the patient it is confirmed (booking_confirmation) or declined, through W12 only, after the guards (Opted_Out, quiet hours, TEST_MODE) and
//     after claiming Appointments.Confirm_Sent (never twice);
//   * marks the lead Booked once its appointment is confirmed.
// The pure rules are in n8n/snippets/request-confirm.js (tested); the nodes only wire them. Built like the W7 section (n8n/w7-w10/sections.js).
// Used by n8n/integrated/apply-request-confirm.js. Every value that already exists in the workflow is passed in, never typed here.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CODE = path.join(__dirname, 'code');
const SNIPPETS = path.join(__dirname, '..', 'snippets');
const snip = (f) => fs.readFileSync(path.join(SNIPPETS, f), 'utf8');
const fn = (src, name) => { const s = src.indexOf(`function ${name}`); return src.slice(s, src.indexOf('\n}\n', s) + 3); };
const PHONE_GUARD = [
  '// Pasted from n8n/snippets/normalize-phone.js and n8n/snippets/send-guard.js - keep identical.',
  fn(snip('normalize-phone.js'), 'normalizeIndianPhone'),
  ...['isTestMode', 'inQuietHours', 'decideSend'].map((n) => fn(snip('send-guard.js'), n)),
].join('\n');
const RC_SRC = snip('request-confirm.js');
const RC = `// Pasted from n8n/snippets/request-confirm.js - keep identical.\n${RC_SRC.slice(RC_SRC.indexOf('const REQC_UID'), RC_SRC.indexOf('if (typeof module'))}`;
const uuid = (seed) => {
  const hx = crypto.createHash('sha256').update(`request-confirm:${seed}`).digest('hex');
  return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-4${hx.slice(13, 16)}-a${hx.slice(17, 20)}-${hx.slice(20, 32)}`;
};

const TOP = 28864;
const STICKY_HEIGHT = 800;
const pos = (col, branch = 0) => [288 + col * 224, TOP + 340 + branch * 176];
const STICKY = `## SECTION REQUEST_CONFIRM — staff confirm or decline an appointment request, the patient is told (request mode)
Every 2 minutes. Only clinics with **Settings > booking_mode = request**. Looks at \`Appointments\` rows whose Booking_UID starts with \`req-\` (made by W13 in request mode), that staff set to **Booked** or **Declined**, and whose **Confirm_Sent** is empty.

- **Booked, slot still free** -> Confirm_Sent is written first, then the patient is told through **W12** (the only sender): free text inside the 24 h window, else the approved \`booking_confirmation\` template. The lead is marked Booked. W5 then reminds as for any Booked appointment.
- **Booked, slot already taken** (a Cal.com booking, another confirmed row; capacity from Settings > booking_capacity) -> **refused**: the row goes back to Requested and Run_Log (\`REQ-request-confirm\`, failed) says why. Two requests confirmed together: the lowest row id keeps the slot.
- **Declined** -> the patient is told (free text; outside the 24 h window W12 refuses and Run_Log says so: tell them by phone).
- Guards before every message: sent flag, Opted_Out, quiet hours 21:00–08:00 IST (the message waits), TEST_MODE. Cal.com and WhatsApp-booked appointments are never looked at.
- Needs the Grist column **Appointments.Confirm_Sent** (DateTime). Rules and tests: n8n/snippets/request-confirm.js, n8n/integrated/REQUEST-MODE.md.`;

function buildSection(v) {
  for (const k of ['gristBaseUrl', 'registryDocId', 'gristCredentials', 'leadsTable']) if (!v[k]) throw new Error(`REQ section: ${k} missing`);
  const nodes = [];
  const connections = {};
  const code = (f, helpers = []) => {
    const body = fs.readFileSync(path.join(CODE, f), 'utf8').replace(/\s+$/, '\n');
    return [...helpers, helpers.length ? '// ---- this node ----' : '', body].filter(Boolean).join('\n');
  };
  const add = (n) => { nodes.push({ ...n, id: uuid(n.name) }); return n.name; };
  const link = (from, to, out = 0) => {
    const c = connections[from] || (connections[from] = { main: [] });
    while (c.main.length <= out) c.main.push([]);
    c.main[out].push({ node: to, type: 'main', index: 0 });
  };
  const chain = (...names) => names.forEach((n, i) => { if (i) link(names[i - 1], n); });
  const cred = () => JSON.parse(JSON.stringify(v.gristCredentials));
  const config = (name, p, values) => add({
    parameters: { assignments: { assignments: values.map(([k, val]) => ({ id: uuid(`${name}:${k}`), name: k, value: val, type: typeof val === 'number' ? 'number' : typeof val === 'boolean' ? 'boolean' : 'string' })) }, options: {} },
    name, type: 'n8n-nodes-base.set', typeVersion: 3.4, position: p,
  });
  const grist = (name, p, { url, method, query, body, onError }) => {
    const parameters = { url, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' };
    if (method) parameters.method = method;
    if (query) { parameters.sendQuery = true; parameters.queryParameters = { parameters: query.map(([k, val]) => ({ name: k, value: val })) }; }
    if (body) { parameters.sendBody = true; parameters.specifyBody = 'json'; parameters.jsonBody = body; }
    parameters.options = {};
    const ordered = method ? { method, ...parameters } : parameters;
    const n = { parameters: ordered, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: p, credentials: cred() };
    if (onError) n.onError = onError;
    return add(n);
  };
  const codeNode = (name, p, jsCode, each) => add({ parameters: each ? { mode: 'runOnceForEachItem', jsCode } : { jsCode }, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: p });
  const ifNode = (name, p, expr) => add({
    parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: uuid(`${name}:cond`), leftValue: expr, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} },
    name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: p,
  });
  const docUrl = (from, table) => `={{ ${from}.grist_base_url }}/api/docs/{{ ${from}.doc_id }}/tables/${table}/records`;
  const P = 'REQ – ';
  const S = `$('${P}Add settings').item.json`;

  const trigger = add({ parameters: { rule: { interval: [{ field: 'cronExpression', expression: '*/2 * * * *' }] } }, name: `${P}Every 2 minutes`, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: pos(0) });
  const cfg = config(`${P}Config`, pos(1), [['grist_base_url', v.gristBaseUrl], ['registry_doc_id', v.registryDocId], ['max_per_run', 20]]);
  const clinics = grist(`${P}Clinics`, pos(2), { url: '={{ $json.grist_base_url }}/api/docs/{{ $json.registry_doc_id }}/tables/Clinics/records' });
  const split = codeNode(`${P}Split clinics`, pos(3), code('split-clinics.js'));
  const settings = grist(`${P}Settings`, pos(4), { url: docUrl('$json', 'Settings') });
  const addS = codeNode(`${P}Add settings`, pos(5), code('add-settings.js'));
  const appts = grist(`${P}Appointments`, pos(6), { url: docUrl('$json', 'Appointments'), query: [['filter', '={{ JSON.stringify({ Status: ["Booked", "Rescheduled", "Declined"] }) }}']] });
  const leads = grist(`${P}Leads`, pos(7), { url: docUrl(S, v.leadsTable) });
  const convs = grist(`${P}Conversations`, pos(8), { url: docUrl(S, 'Conversations') });
  const plan = codeNode(`${P}Plan`, pos(9), code('plan.js', [RC]));
  chain(trigger, cfg, clinics, split, settings, addS, appts, leads, convs, plan);

  // refused confirmations
  const conflictQ = ifNode(`${P}Conflict?`, pos(10), "={{ $json.kind === 'conflict' }}");
  const prepC = codeNode(`${P}Prepare conflict`, pos(11, 1), code('prepare-conflict.js'), true);
  const revert = grist(`${P}Revert to Requested`, pos(12, 1), { method: 'PATCH', url: docUrl('$json', 'Appointments'), body: '={{ JSON.stringify($json.revert) }}', onError: 'continueRegularOutput' });
  const cLog = codeNode(`${P}Conflict log`, pos(13, 1), code('conflict-log.js', [RC]), true);
  const cWrite = grist(`${P}Write conflict log`, pos(14, 1), { method: 'POST', url: docUrl('$json', 'Run_Log'), body: '={{ JSON.stringify({ records: [{ fields: $json.log }] }) }}' });
  link(plan, conflictQ);
  link(conflictQ, prepC, 0);
  chain(prepC, revert, cLog, cWrite);

  // confirmations and declines
  const decide = codeNode(`${P}Decide send`, pos(11), code('decide-send.js', [PHONE_GUARD]), true);
  const sendQ = ifNode(`${P}Send?`, pos(12), '={{ $json.send }}');
  const build = codeNode(`${P}Build Message`, pos(13), code('build-message.js', [RC]), true);
  const claim = grist(`${P}Claim Confirm_Sent`, pos(14), { method: 'PATCH', url: docUrl('$json', 'Appointments'), body: '={{ JSON.stringify($json.claim) }}' });
  const restore = codeNode(`${P}Restore`, pos(15), code('restore.js'), true);
  const call = add({
    parameters: { workflowId: { __rl: true, value: '={{ $workflow.id }}', mode: 'id' }, workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true }, mode: 'each', options: {} },
    name: `${P}Call 'W12 - WhatsApp send'`, type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.4, position: pos(16), onError: 'continueRegularOutput',
  });
  const prep = codeNode(`${P}Prepare log`, pos(17), code('prepare-log.js'), true);
  const write = grist(`${P}Write Run_Log`, pos(18), { method: 'POST', url: docUrl('$json', 'Run_Log'), body: '={{ JSON.stringify({ records: [{ fields: $json.log }] }) }}' });
  const P_ = `$('${P}Prepare log').item.json`;
  const bookedQ = ifNode(`${P}Mark lead Booked?`, pos(19), `={{ ${P_}.kind === 'confirmed' && !['Booked', 'Converted'].includes(${P_}.lead_status) }}`);
  const markLead = grist(`${P}Mark lead Booked`, pos(20), { method: 'PATCH', url: `={{ ${P_}.grist_base_url }}/api/docs/{{ ${P_}.doc_id }}/tables/${v.leadsTable}/records`, body: `={{ JSON.stringify({ records: [{ id: ${P_}.lead_row_id, fields: { Status: 'Booked' } }] }) }}` });
  link(conflictQ, decide, 1);
  chain(decide, sendQ, build, claim, restore, call, prep, write, bookedQ, markLead);
  return { nodes, connections, width: 20 * 224 + 480 };
}

module.exports = { buildSection, STICKY, STICKY_HEIGHT, TOP, uuid };
