// SECTION MISSED_CALL_CAPTURE ("MCC –" nodes) of the master workflow: nodes, wiring and canvas, built from n8n/mcc/code/*.js with the
// shared helpers pasted in VERBATIM from n8n/snippets/ (normalize-phone, send-guard, call-events), so the tested code is the code that runs.
// Used by n8n/integrated/apply-missed-call-capture.js. Every value that already exists in the workflow (Grist base URL, registry doc id,
// Grist credential, leads table name) is passed in from the workflow itself, never typed here.
//
//   MCC – Webhook   POST /webhook/missed-call  header X-Call-Secret -> validate -> 200/4xx at once -> then process
//   registry        the CALLED number (Clinics.Call_Number) decides the clinic; nothing from the request body
//   idempotency     one Messages row per provider call id ("call-<id>"): claim, re-read, lowest id wins; repeats stop early
//   CRM             lead (Source Call) + conversation found or created; the event row is linked; Unread +1; Last_Inbound_At untouched
//   acknowledgement + staff alert  both through W12 (the only sender): guards, TEST_MODE, quiet hours; DEMO = simulated, nothing sent
//   retry           MCC – Every 5 minutes: ONE acknowledgement per run that failed or waited for the morning (see the retry block)
// No node here talks to Meta.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PHONE_GUARD } = require('../w7-w10/sections');

const CODE = path.join(__dirname, 'code');
const SNIPPETS = path.join(__dirname, '..', 'snippets');
const snip = (f) => fs.readFileSync(path.join(SNIPPETS, f), 'utf8');
const CE_SRC = snip('call-events.js');
const CE = `// Pasted from n8n/snippets/call-events.js - keep identical.\n${CE_SRC.slice(CE_SRC.indexOf('const CE_STATUS_MISSED'), CE_SRC.indexOf('if (typeof module'))}`;
const uuid = (seed) => {
  const hx = crypto.createHash('sha256').update(`mcc:${seed}`).digest('hex');
  return `${hx.slice(0, 8)}-${hx.slice(8, 12)}-4${hx.slice(13, 16)}-a${hx.slice(17, 20)}-${hx.slice(20, 32)}`;
};

// Canvas: below SECTION W13 (which ends at y 27080 in the master), one sticky behind the section.
const TOP = 27264;
const STICKY_HEIGHT = 1500;
const X0 = 288;
const COL = 224;
const pos = (col, row = 0) => [X0 + col * COL, TOP + 340 + row * 200];

function buildSection(v) {
  for (const k of ['gristBaseUrl', 'registryDocId', 'gristCredentials', 'leadsTable', 'unreadMode', 'defaultLeadName', 'types']) if (v[k] === undefined || v[k] === '') throw new Error(`mcc sections: ${k} missing`);
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
  const P = 'MCC – ';
  const guard = [PHONE_GUARD, CE];          // phone + send guard + call-events
  const ceOnly = [CE];
  const phoneCe = [PHONE_GUARD.split('\nfunction isTestMode')[0], CE];   // normalizeIndianPhone + call-events (no send guard)

  const codeNode = (name, p, jsCode, each) => add({ parameters: each ? { mode: 'runOnceForEachItem', jsCode } : { jsCode }, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: p });
  const ifNode = (name, p, expr) => add({
    parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 }, conditions: [{ id: uuid(`${name}:cond`), leftValue: expr, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }], combinator: 'and' }, options: {} },
    name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: p,
  });
  const grist = (name, p, { url, method, query, body }) => {
    const parameters = { url, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' };
    if (method) parameters.method = method;
    if (query) { parameters.sendQuery = true; parameters.queryParameters = { parameters: query.map(([k, val]) => ({ name: k, value: val })) }; }
    if (body) { parameters.sendBody = true; parameters.specifyBody = 'json'; parameters.jsonBody = body; }
    parameters.options = {};
    const ordered = method ? { method, ...parameters } : parameters;
    return add({ parameters: ordered, name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: p, credentials: cred() });
  };
  const callW12 = (name, p) => add({
    parameters: { workflowId: { __rl: true, value: '={{ $workflow.id }}', mode: 'id' }, workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true }, mode: 'each', options: {} },
    name, type: 'n8n-nodes-base.executeWorkflow', typeVersion: 1.4, position: p, onError: 'continueRegularOutput',
  });
  const config = (name, p, values) => add({
    parameters: { assignments: { assignments: values.map(([k, val]) => ({ id: uuid(`${name}:${k}`), name: k, value: val, type: typeof val === 'number' ? 'number' : typeof val === 'boolean' ? 'boolean' : 'string' })) }, includeOtherFields: true, options: {} },
    name, type: 'n8n-nodes-base.set', typeVersion: 3.4, position: p,
  });
  const doc = (from, table) => `={{ ${from}.grist_base_url }}/api/docs/{{ ${from}.doc_id }}/tables/${table}/records`;
  const J = '$json';
  const at = (nodeName) => `$('${nodeName}').first().json`;
  const writer = (name, p) => grist(name, p, { method: '={{ $json.method }}', url: '={{ $json.grist_base_url }}/api/docs/{{ $json.doc_id }}/tables/{{ $json.table }}/records', body: '={{ JSON.stringify($json.body) }}' });
  const runLog = (name, p) => grist(name, p, { method: 'POST', url: doc(J, 'Run_Log'), body: '={{ JSON.stringify({ records: [{ fields: $json.log }] }) }}' });

  // ---------------------------------------------------------------- entry: webhook, secret + body check, answer, registry
  const webhook = add({
    parameters: { httpMethod: 'POST', path: 'missed-call', responseMode: 'responseNode', options: {} },
    name: `${P}Webhook`, type: 'n8n-nodes-base.webhook', typeVersion: v.types.webhook, position: pos(0), webhookId: uuid('webhook-id'),
  });
  const cfg = config(`${P}Config`, pos(1), [
    ['grist_base_url', v.gristBaseUrl], ['registry_doc_id', v.registryDocId], ['leads_table', v.leadsTable], ['unread_mode', v.unreadMode],
    ['default_lead_name', v.defaultLeadName], ['mcc_webhook_secret', v.webhookSecret || 'REPLACE_WITH_A_LONG_RANDOM_SECRET'],
  ]);
  const validate = codeNode(`${P}Validate`, pos(2), code('validate.js', phoneCe));
  const respond = add({
    parameters: { respondWith: 'text', responseBody: '={{ $json.response_body }}', options: { responseCode: '={{ $json.http_status }}', responseHeaders: { entries: [{ name: 'Content-Type', value: 'application/json' }] } } },
    name: `${P}Respond`, type: 'n8n-nodes-base.respondToWebhook', typeVersion: v.types.respond, position: pos(3),
  });
  const process = ifNode(`${P}Process?`, pos(4), "={{ $json.action === 'process' }}");
  const clinics = grist(`${P}Clinics`, pos(5), { url: `={{ ${at(`${P}Config`)}.grist_base_url }}/api/docs/{{ ${at(`${P}Config`)}.registry_doc_id }}/tables/Clinics/records` });
  const resolve = codeNode(`${P}Resolve clinic`, pos(6), code('resolve-clinic.js', phoneCe));
  const found = ifNode(`${P}Clinic found?`, pos(7), '={{ $json.found === true }}');
  const unknown = add({
    parameters: { errorMessage: "={{ 'MCC: no active clinic owns the called number ending ' + $json.event.called_key.slice(-4) + ' (' + $json.reason + ')' }}" },
    name: `${P}Unknown clinic`, type: 'n8n-nodes-base.stopAndError', typeVersion: v.types.stopAndError, position: pos(7, 1),
  });
  chain(webhook, cfg, validate, respond, process, clinics, resolve, found);
  link(found, unknown, 1);

  // ---------------------------------------------------------------- the clinic's switches, then the idempotency record
  const settings = grist(`${P}Settings`, pos(8), { url: doc(J, 'Settings') });
  const addSettings = codeNode(`${P}Add settings`, pos(9), code('add-settings.js', ceOnly));
  const enabled = ifNode(`${P}Enabled?`, pos(10), '={{ $json.settings.enabled === true }}');
  const findEvent = grist(`${P}Find event`, pos(11), { url: doc(J, 'Messages'), query: [['filter', '={{ JSON.stringify({ WA_Message_ID: [$json.event.call_key] }) }}']] });
  const classify = codeNode(`${P}Classify`, pos(12), code('classify.js', ceOnly));
  const stop = ifNode(`${P}Stop?`, pos(13), "={{ ['duplicate', 'inflight'].includes($json.plan.kind) }}");
  const needsClaim = ifNode(`${P}Needs claim?`, pos(14), "={{ $json.plan.kind === 'new' }}");
  chain(found, settings, addSettings, enabled, findEvent, classify, stop);
  link(stop, needsClaim, 1);   // Stop? true (a repeat) -> Log skipped; false -> Needs claim?

  const claim = grist(`${P}Claim event`, pos(15, 1), { method: 'POST', url: doc(J, 'Messages'), body: '={{ JSON.stringify({ records: [{ fields: $json.claim_row }] }) }}' });
  const classifyAt = at(`${P}Classify`);
  const reread = grist(`${P}Re-read event`, pos(16, 1), { url: `={{ ${classifyAt}.grist_base_url }}/api/docs/{{ ${classifyAt}.doc_id }}/tables/Messages/records`, query: [['filter', `={{ JSON.stringify({ WA_Message_ID: [${classifyAt}.event.call_key] }) }}`]] });
  const canonical = codeNode(`${P}Canonical`, pos(17, 1), code('canonical.js', ceOnly));
  const canonicalQ = ifNode(`${P}Canonical?`, pos(18, 1), '={{ $json.plan.mine === true }}');
  const standDown = grist(`${P}Stand down`, pos(19, 2), { method: 'PATCH', url: doc(J, 'Messages'), body: '={{ JSON.stringify($json.stand_down) }}' });
  link(needsClaim, claim, 0);
  chain(claim, reread, canonical, canonicalQ);
  link(canonicalQ, standDown, 1);

  const context = codeNode(`${P}Context`, pos(19), code('context.js'));
  link(needsClaim, context, 1);
  link(canonicalQ, context, 0);

  // ---------------------------------------------------------------- lead and conversation (found or created), then link the event
  const contextAt = at(`${P}Context`);
  const findLead = grist(`${P}Find lead`, pos(20), { url: doc(J, '{{ $json.leads_table }}'), query: [['filter', '={{ JSON.stringify({ Phone: [$json.event.caller_phone] }) }}'], ['limit', '1']] });
  const leadExists = ifNode(`${P}Lead exists?`, pos(21), '={{ Array.isArray($json.records) && $json.records.length > 0 }}');
  const recentLeads = grist(`${P}Recent leads`, pos(22, 1), { url: `={{ ${contextAt}.grist_base_url }}/api/docs/{{ ${contextAt}.doc_id }}/tables/{{ ${contextAt}.leads_table }}/records`, query: [['sort', '-Created_At'], ['limit', '200']] });
  const buildLead = codeNode(`${P}Build new lead`, pos(23, 1), code('build-new-lead.js', phoneCe));
  const createLead = grist(`${P}Create lead`, pos(24, 1), { method: 'POST', url: doc(J, '{{ $json.leads_table }}'), body: '={{ JSON.stringify($json.create) }}' });
  const leadReady = codeNode(`${P}Lead ready`, pos(25), code('lead-ready.js'));
  chain(context, findLead, leadExists);
  link(leadExists, leadReady, 0);
  link(leadExists, recentLeads, 1);
  chain(recentLeads, buildLead, createLead, leadReady);

  const leadAt = at(`${P}Lead ready`);
  const findConv = grist(`${P}Find conversation`, pos(26), { url: doc(J, 'Conversations'), query: [['filter', '={{ JSON.stringify({ Phone: [$json.event.caller_phone] }) }}']] });
  const convExists = ifNode(`${P}Conversation exists?`, pos(27), '={{ Array.isArray($json.records) && $json.records.length > 0 }}');
  const createConv = grist(`${P}Create conversation`, pos(28, 1), { method: 'POST', url: `={{ ${leadAt}.grist_base_url }}/api/docs/{{ ${leadAt}.doc_id }}/tables/Conversations/records`, body: `={{ JSON.stringify({ records: [{ fields: { Phone: ${leadAt}.event.caller_phone, Lead: ${leadAt}.lead.row_id } }] }) }}` });
  const convReady = codeNode(`${P}Conversation ready`, pos(29), code('conversation-ready.js'));
  chain(leadReady, findConv, convExists);
  link(convExists, convReady, 0);
  link(convExists, createConv, 1);
  link(createConv, convReady);

  const planWrites = codeNode(`${P}Plan writes`, pos(30), code('plan-writes.js', ceOnly));
  const linkWrites = writer(`${P}Link writes`, pos(31));
  chain(convReady, planWrites, linkWrites);

  // ---------------------------------------------------------------- acknowledgement and staff alert, both through W12
  const decideAck = codeNode(`${P}Decide ack`, pos(32), code('decide-ack.js', guard));
  const ackQ = ifNode(`${P}Ack?`, pos(33), '={{ $json.send }}');
  const buildAck = codeNode(`${P}Build ack`, pos(34, 1), code('build-ack.js', ceOnly));
  const callAck = callW12(`${P}Call 'W12 - WhatsApp send' (ack)`, pos(35, 1));
  const ackResult = codeNode(`${P}Ack result`, pos(36), code('ack-result.js', ceOnly));
  const decideAlert = codeNode(`${P}Decide alert`, pos(37), code('decide-alert.js', guard));
  const alertQ = ifNode(`${P}Alert?`, pos(38), '={{ $json.send_alert }}');
  const buildAlert = codeNode(`${P}Build alert`, pos(39, 1), code('build-alert.js', ceOnly));
  const callAlert = callW12(`${P}Call 'W12 - WhatsApp send' (alert)`, pos(40, 1));
  const finalRecord = codeNode(`${P}Final record`, pos(41), code('final-record.js', ceOnly));
  const finalWrite = writer(`${P}Final write`, pos(42));
  const convAt = at(`${P}Conversation ready`);
  const recentAcks = grist(`${P}Recent acks`, pos(31, 1), { url: `={{ ${convAt}.grist_base_url }}/api/docs/{{ ${convAt}.doc_id }}/tables/Messages/records`, query: [['filter', `={{ JSON.stringify({ Conversation: [${convAt}.conversation.row_id], Template: ['missed_call_ack'] }) }}`]] });
  nodes.find((n) => n.name === recentAcks).executeOnce = true;   // Link writes passes 1-2 items: one read is enough
  chain(linkWrites, recentAcks, decideAck, ackQ);
  link(ackQ, buildAck, 0);
  link(ackQ, ackResult, 1);
  chain(buildAck, callAck, ackResult, decideAlert, alertQ);
  link(alertQ, buildAlert, 0);
  link(alertQ, finalRecord, 1);
  chain(buildAlert, callAlert, finalRecord, finalWrite);

  // ---------------------------------------------------------------- retry: failed or night-deferred acknowledgements, one event per run
  const rTrig = add({ parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 5 }] } }, name: `${P}Every 5 minutes`, type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: pos(0, 4) });
  const rCfg = config(`${P}Retry config`, pos(1, 4), [
    ['grist_base_url', v.gristBaseUrl], ['registry_doc_id', v.registryDocId], ['leads_table', v.leadsTable], ['unread_mode', v.unreadMode],
    ['default_lead_name', v.defaultLeadName], ['retry_max_age_hours', 20],
  ]);
  const rClinics = grist(`${P}Retry clinics`, pos(2, 4), { url: `={{ ${at(`${P}Retry config`)}.grist_base_url }}/api/docs/{{ ${at(`${P}Retry config`)}.registry_doc_id }}/tables/Clinics/records` });
  const rSplit = codeNode(`${P}Retry split`, pos(3, 4), code('retry-split.js', phoneCe));
  const rSettings = grist(`${P}Retry settings`, pos(4, 4), { url: doc(J, 'Settings') });
  const rAdd = codeNode(`${P}Retry add settings`, pos(5, 4), code('retry-add-settings.js', ceOnly));
  const rMsgs = grist(`${P}Retry messages`, pos(6, 4), { url: doc(J, 'Messages'), query: [['filter', '={{ JSON.stringify({ Template: ["missed_call"] }) }}']] });
  const rConvs = grist(`${P}Retry conversations`, pos(7, 4), { url: doc(`${at(`${P}Retry add settings`).replace('.first()', '.item')}`, 'Conversations') });
  const rPlan = codeNode(`${P}Plan retries`, pos(8, 4), code('plan-retries.js', phoneCe));
  chain(rTrig, rCfg, rClinics, rSplit, rSettings, rAdd, rMsgs, rConvs, rPlan);
  link(rPlan, context);

  // ---------------------------------------------------------------- events that end without doing anything
  const logSkipped = codeNode(`${P}Log skipped`, pos(14, -1), code('log-skipped.js', ceOnly));
  const skipWrite = runLog(`${P}Skip write`, pos(15, -1));
  link(enabled, logSkipped, 1);
  link(stop, logSkipped, 0);
  link(standDown, logSkipped);
  chain(logSkipped, skipWrite);

  return { nodes, connections, width: X0 + 43 * COL + 60 - 160 };
}

const STICKY = `## SECTION MISSED_CALL_CAPTURE ("MCC –" nodes; the W14 / W15 numbers stay unassigned)
**Starts from:** MCC – Webhook, POST /webhook/missed-call (a synthetic call event in the demo, a cloud-telephony provider later).
**Request:** header **X-Call-Secret** (MCC – Config > mcc_webhook_secret; unset or a REPLACE_ placeholder = 503, wrong = 401) and a JSON body: provider_call_id, called_number, caller_number, timestamp, status (missed / unanswered / no-answer / busy; answered and ringing are ignored), optional duration_seconds. A bad body = 400 with the field names. The answer goes back at once, then the work starts.
**Clinic:** ONLY the Agency Registry decides, by the CALLED number (Clinics.Call_Number, an Active clinic with a Grist doc). A clinic / tenant / doc id in the request is never read. Unknown or ambiguous number = the run stops with an error (W11 alerts, last 4 digits only).
**Per clinic:** Settings > missed_call_enabled = on (missing = off; the run is logged as skipped). demo_mode = on labels everything DEMO.
**No duplicates:** one Messages row per provider call id (Template missed_call, WA_Message_ID call-<id>) is the record. A repeat stops (no second lead, no second acknowledgement); a failed or night-deferred acknowledgement is retried (max 3 tries); two copies at once: the lowest row id wins, the other stands down.
**CRM:** lead found by phone or created (Source Call, Status New), conversation found or created, Unread +1. Conversations > Last_Inbound_At is NEVER written: a missed call is not a WhatsApp message and does not open the 24 h free-text window.
**Messages:** acknowledgement (template intent missed_call_ack) and staff alert (new_lead_staff_alert), both through MCC – Call 'W12 - WhatsApp send' = this workflow's W12 section, the only sender: Opted_Out, a person who owns the chat, quiet hours, TEST_MODE. In **simulate** mode (W12 – Config > w12_send_mode) NOTHING is sent: the thread shows the intended message as DEMO simulated, Run_Log says so. missed_call_ack is NOT a Meta-approved template: a live send of it is refused.
**Results:** the event row's AI_Action / AI_Reason hold mcc:ack_simulated / ack_sent / ack_deferred / ack_failed / ack_skipped; Run_Log (MCC-missed-call-capture) one row per event; a failure is logged as a failure.`;

module.exports = { buildSection, STICKY, STICKY_HEIGHT, TOP, uuid };
