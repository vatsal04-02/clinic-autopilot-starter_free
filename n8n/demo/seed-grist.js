// Prepares a LOCAL Grist for the demo, and cleans it up again. Synthetic data only; talks only to this machine; the API key is never printed.
//   node n8n/demo/seed-grist.js check --registry-doc <id> --clinic-doc <id>     are the tables / columns / choices the workflows need there?
//   node n8n/demo/seed-grist.js seed  --registry-doc <id> --clinic-doc <id>     the demo clinic's registry row, Settings and Knowledge (idempotent)
//   node n8n/demo/seed-grist.js reset --clinic-doc <id>                         remove everything the demo created (leads, conversations, messages, requests, Run_Log)
// Environment: GRIST_API_KEY (Grist > Profile settings > API; never commit it)   DEMO_GRIST_URL (default http://127.0.0.1:8484)
// Safety: only localhost / 127.0.0.1 / the compose service "grist" are accepted. `seed` refuses a document that holds anything outside the synthetic
// phone range (+91 9000000xxx); `reset` refuses unless Settings.demo_mode is on AND every lead is synthetic, and then deletes nothing else.
// The Grist documents themselves (tables, columns) are created by hand from grist/schema.md: `check` tells you exactly what is missing.
const http = require('http');
const https = require('https');
const { DEMO, settings, knowledge } = require('./demo-data');

const SYNTHETIC_PHONE = /^\+919000000\d{3}$/;
const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', 'grist']);
// What the workflows read and write (live names: LEADS / Lead_id). `choices`: values the workflows write that the column must accept.
const REQUIRED = {
  Clinics: { cols: ['Clinic_Slug', 'Clinic_Name', 'Grist_Doc_ID', 'WA_Phone_Number_ID', 'Active', 'Call_Number'] },
  LEADS: { cols: ['Lead_id', 'Created_At', 'Name', 'Phone', 'Source', 'Page_URL', 'UTM_Campaign', 'Enquiry', 'AI_Summary', 'Likely_Service', 'Status', 'Owner', 'Next_Action_At', 'First_Response_At', 'Lost_Reason', 'Opted_Out', 'Escalated', 'Followup_Sent', 'Notes', 'Lead_Stage'], choices: { Source: ['Call', 'WhatsApp'], Status: ['New', 'Contacted', 'Booked'] } },
  Appointments: { cols: ['Booking_UID', 'Lead', 'Service', 'Physio', 'Start', 'End', 'Status', 'Fee_INR', 'R24_Sent', 'R2_Sent', 'Rebook_Sent', 'Review_Sent', 'Outcome_Sent', 'Requested_At', 'Confirm_Sent'], choices: { Status: ['Booked', 'Requested', 'Declined'] } },
  Conversations: { cols: ['Lead', 'Phone', 'Last_Inbound_At', 'Unread', 'Automation_Paused', 'Assigned_To', 'Needs_Human', 'Handoff_Reason', 'Last_Intent'] },
  Messages: { cols: ['Conversation', 'Direction', 'Body', 'Template', 'Sent_By', 'WA_Message_ID', 'Status', 'Send', 'Created_At', 'Intent', 'AI_Action', 'AI_Confidence', 'AI_Status', 'Needs_Human', 'AI_Reply', 'AI_Reason'], choices: { Status: ['queued', 'Received'], AI_Status: ['replied', 'handed_off', 'opted_out'] } },
  Run_Log: { cols: ['Workflow', 'Record', 'Outcome', 'Error', 'At'] },
  Settings: { cols: ['Key', 'Value'] },
  Knowledge: { cols: ['Title', 'Category', 'Content', 'Active'] },
};

function client(baseUrl, apiKey, transport) {
  const u = new URL(baseUrl);
  if (!LOCAL.has(u.hostname)) throw new Error(`refusing ${u.hostname}: the demo seed only talks to this machine (localhost / 127.0.0.1 / the compose service "grist")`);
  if (!apiKey) throw new Error('set GRIST_API_KEY (Grist > Profile settings > API)');
  const lib = u.protocol === 'https:' ? https : http;
  const call = transport || ((method, path, body) => new Promise((resolve, reject) => {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path, method, timeout: 20000, headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json', ...(raw ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) } : {}) } }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; });
      res.on('end', () => (res.statusCode >= 400 ? reject(new Error(`Grist ${method} ${path.split('?')[0]} -> HTTP ${res.statusCode}`)) : resolve(t ? JSON.parse(t) : {})));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(raw);
  }));
  const enc = encodeURIComponent;
  return {
    tables: async (doc) => (await call('GET', `/api/docs/${enc(doc)}/tables`)).tables.map((t) => t.id),
    columns: async (doc, t) => (await call('GET', `/api/docs/${enc(doc)}/tables/${enc(t)}/columns`)).columns,
    records: async (doc, t) => (await call('GET', `/api/docs/${enc(doc)}/tables/${enc(t)}/records`)).records,
    add: (doc, t, rows) => call('POST', `/api/docs/${enc(doc)}/tables/${enc(t)}/records`, { records: rows.map((fields) => ({ fields })) }),
    update: (doc, t, rows) => call('PATCH', `/api/docs/${enc(doc)}/tables/${enc(t)}/records`, { records: rows }),
    remove: (doc, t, ids) => (ids.length ? call('POST', `/api/docs/${enc(doc)}/tables/${enc(t)}/data/delete`, ids) : Promise.resolve({})),
  };
}

async function check(g, doc, tables, out) {
  const have = await g.tables(doc);
  let problems = 0;
  for (const t of tables) {
    if (!have.includes(t)) { problems++; out(`  MISSING table ${t}`); continue; }
    const cols = await g.columns(doc, t);
    const ids = new Set(cols.map((c) => c.id));
    const missing = REQUIRED[t].cols.filter((c) => !ids.has(c));
    for (const c of missing) { problems++; out(`  MISSING column ${t}.${c}`); }
    for (const [col, want] of Object.entries(REQUIRED[t].choices || {})) {
      const c = cols.find((x) => x.id === col); if (!c) continue;
      let choices = []; try { choices = JSON.parse((c.fields && c.fields.widgetOptions) || '{}').choices || []; } catch (e) { /* none */ }
      const lacking = want.filter((w) => !choices.includes(w));
      if (lacking.length) { problems++; out(`  MISSING choice(s) ${t}.${col}: ${lacking.join(', ')}`); }
    }
  }
  return problems;
}
const clinicTables = ['LEADS', 'Appointments', 'Conversations', 'Messages', 'Run_Log', 'Settings', 'Knowledge'];
const syntheticOnly = (leads) => leads.every((l) => SYNTHETIC_PHONE.test(String(l.fields.Phone || '')));
const settingsOf = (rows) => Object.fromEntries(rows.map((r) => [String(r.fields.Key || '').trim(), String(r.fields.Value === null || r.fields.Value === undefined ? '' : r.fields.Value)]));

async function run(argv, env, out = console.log, transport) {
  const cmd = argv[0];
  const flag = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const g = client(env.DEMO_GRIST_URL || 'http://127.0.0.1:8484', env.GRIST_API_KEY, transport);
  const clinicDoc = flag('--clinic-doc'); const registryDoc = flag('--registry-doc');
  if (!['check', 'seed', 'reset'].includes(cmd)) throw new Error('usage: seed-grist.js check|seed|reset --registry-doc <id> --clinic-doc <id>');
  if (!clinicDoc) throw new Error('--clinic-doc <id> is required');
  if (cmd !== 'reset' && !registryDoc) throw new Error('--registry-doc <id> is required');

  if (cmd === 'check') {
    out('Agency Registry:'); let p = await check(g, registryDoc, ['Clinics'], out);
    out('Clinic CRM:'); p += await check(g, clinicDoc, clinicTables, out);
    out(p ? `\n${p} problem(s): fix them in Grist (grist/schema.md), then run check again.` : '\nGrist is ready: every table, column and choice the workflows need is there.');
    return p ? 1 : 0;
  }
  const leads = await g.records(clinicDoc, 'LEADS');
  if (!syntheticOnly(leads)) throw new Error('refusing: this document holds a lead outside the synthetic phone range (+91 9000000xxx): it looks like real data. Use a separate demo document.');

  if (cmd === 'seed') {
    // registry row
    const c = DEMO.clinic;
    const row = { Clinic_Slug: c.slug, Clinic_Name: c.name, Grist_Doc_ID: clinicDoc, WA_Phone_Number_ID: env.DEMO_WA_PHONE_NUMBER_ID || c.waPhoneNumberId, Active: true, Call_Number: env.DEMO_CALLED_NUMBER || c.callNumber };
    const existing = (await g.records(registryDoc, 'Clinics')).find((r) => r.fields.Clinic_Slug === c.slug);
    if (existing) await g.update(registryDoc, 'Clinics', [{ id: existing.id, fields: row }]); else await g.add(registryDoc, 'Clinics', [row]);
    out(`registry   : clinic "${c.slug}" ${existing ? 'updated' : 'added'} -> ${clinicDoc} (called number ${row.Call_Number})`);
    // settings (Key / Value)
    const have = await g.records(clinicDoc, 'Settings'); const byKey = Object.fromEntries(have.map((r) => [String(r.fields.Key || '').trim(), r]));
    const upd = []; const add = [];
    for (const s of settings()) { const k = s.fields.Key; if (byKey[k]) upd.push({ id: byKey[k].id, fields: { Value: s.fields.Value } }); else add.push({ Key: k, Value: s.fields.Value }); }
    if (upd.length) await g.update(clinicDoc, 'Settings', upd);
    if (add.length) await g.add(clinicDoc, 'Settings', add);
    out(`settings   : ${upd.length} updated, ${add.length} added (TEST_MODE true, booking_mode request, missed_call_enabled on, demo_mode on)`);
    // knowledge
    const titles = new Set((await g.records(clinicDoc, 'Knowledge')).map((r) => r.fields.Title));
    const fresh = knowledge().map((k) => k.fields).filter((k) => !titles.has(k.Title));
    if (fresh.length) await g.add(clinicDoc, 'Knowledge', fresh);
    out(`knowledge  : ${fresh.length} added, ${knowledge().length - fresh.length} already there`);
    out('\nNext: import n8n/demo/clinic-autopilot-demo.json into your LOCAL n8n and paste this registry doc id (see DEMO.md).');
    return 0;
  }
  // reset
  const set = settingsOf(await g.records(clinicDoc, 'Settings'));
  if (!/^(on|true|yes|1)$/i.test(set.demo_mode || '')) throw new Error('refusing to reset: Settings.demo_mode is not on in this document (it is not marked as a demo clinic)');
  const del = {};
  const tables = ['Messages', 'Appointments', 'Conversations', 'LEADS', 'Run_Log'];
  for (const t of tables) { const rows = await g.records(clinicDoc, t); del[t] = rows.map((r) => r.id); }
  for (const t of tables) await g.remove(clinicDoc, t, del[t]);
  out(`reset      : ${tables.map((t) => `${t} ${del[t].length}`).join(', ')} rows deleted; Settings and Knowledge kept`);
  return 0;
}

module.exports = { run, check, REQUIRED, SYNTHETIC_PHONE, client };
if (require.main === module) {
  run(process.argv.slice(2), process.env).then((code) => process.exit(code), (e) => { console.error(`seed-grist: ${String(e.message).replace(/Bearer\s+\S+/g, 'Bearer [hidden]')}`); process.exit(1); });
}
