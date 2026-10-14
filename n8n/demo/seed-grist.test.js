// seed-grist.js against an in-memory Grist API (no network): check / seed / reset, idempotence, and the three safety rules
// (local host only, never into a document with real-looking data, reset only on a marked demo document; the API key is never printed).
// Run: node n8n/demo/seed-grist.test.js
const assert = require('assert');
const { run, REQUIRED } = require('./seed-grist');

// ---- a fake Grist REST API (only what the script uses)
function fakeGrist(docs, meta) {
  const calls = [];
  const nextId = {};
  const fn = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    let m;
    if ((m = path.match(/^\/api\/docs\/([^/]+)\/tables$/))) return { tables: Object.keys(docs[m[1]]).map((id) => ({ id })) };
    if ((m = path.match(/^\/api\/docs\/([^/]+)\/tables\/([^/]+)\/columns$/))) return { columns: (meta[m[1]] && meta[m[1]][m[2]]) || [] };
    if ((m = path.match(/^\/api\/docs\/([^/]+)\/tables\/([^/]+)\/records$/))) {
      const rows = docs[m[1]][m[2]];
      if (method === 'GET') return { records: JSON.parse(JSON.stringify(rows)) };
      if (method === 'POST') { const key = `${m[1]}.${m[2]}`; return { records: body.records.map((r) => { nextId[key] = Math.max(nextId[key] || 0, ...rows.map((x) => x.id)) + 1; rows.push({ id: nextId[key], fields: { ...r.fields } }); return { id: nextId[key] }; }) }; }
      if (method === 'PATCH') { for (const r of body.records) Object.assign(rows.find((x) => x.id === r.id).fields, r.fields); return {}; }
    }
    if ((m = path.match(/^\/api\/docs\/([^/]+)\/tables\/([^/]+)\/data\/delete$/))) { docs[m[1]][m[2]] = docs[m[1]][m[2]].filter((r) => !body.includes(r.id)); return {}; }
    throw new Error(`fake Grist: ${method} ${path}`);
  };
  fn.calls = calls;
  return fn;
}
const colsFor = (table, opts = {}) => REQUIRED[table].cols.filter((c) => !(opts.drop || []).includes(c)).map((id) => {
  const choices = (REQUIRED[table].choices || {})[id];
  const have = opts.choices && opts.choices[id] ? opts.choices[id] : choices;
  return { id, fields: { type: choices ? 'Choice' : 'Text', widgetOptions: choices ? JSON.stringify({ choices: have }) : '' } };
});
const fullMeta = (over = {}) => ({
  REG: { Clinics: colsFor('Clinics') },
  CLINIC: Object.fromEntries(['LEADS', 'Appointments', 'Conversations', 'Messages', 'Run_Log', 'Settings', 'Knowledge'].map((t) => [t, colsFor(t, over[t])])),
});
const emptyDocs = () => ({ REG: { Clinics: [] }, CLINIC: { LEADS: [], Appointments: [], Conversations: [], Messages: [], Run_Log: [], Settings: [], Knowledge: [] } });
const ENV = { GRIST_API_KEY: 'SENTINEL-GRIST-KEY' };
const args = (cmd, extra = []) => [cmd, '--registry-doc', 'REG', '--clinic-doc', 'CLINIC', ...extra];
const go = async (cmd, docs, meta, env = ENV, extra = []) => {
  const lines = [];
  const t = fakeGrist(docs, meta || fullMeta());
  let code; let err = null;
  try { code = await run(args(cmd, extra), env, (l) => lines.push(l), t); } catch (e) { err = e; }
  return { code, err, text: lines.join('\n'), calls: t.calls };
};

const results = [];
const check = async (id, title, fn) => { try { await fn(); results.push({ id, title, ok: true }); } catch (e) { results.push({ id, title, ok: false, why: e.message.split('\n')[0] }); } };
(async () => {
  await check('G1', 'check: a complete document passes; a missing table, column and choice are each named (Requested / Declined / Received / Call)', async () => {
    const ok = await go('check', emptyDocs());
    assert.deepStrictEqual([ok.code, /Grist is ready/.test(ok.text)], [0, true]);
    const meta = fullMeta({ Appointments: { drop: ['Requested_At'], choices: { Status: ['Booked'] } }, Messages: { choices: { Status: ['queued'] } }, LEADS: { choices: { Source: ['WhatsApp'] } } });
    delete meta.CLINIC.Knowledge;
    const docs = emptyDocs(); delete docs.CLINIC.Knowledge;
    const bad = await go('check', docs, meta);
    assert.strictEqual(bad.code, 1);
    for (const want of ['MISSING table Knowledge', 'MISSING column Appointments.Requested_At', 'MISSING choice(s) Appointments.Status: Requested, Declined', 'MISSING choice(s) Messages.Status: Received', 'MISSING choice(s) LEADS.Source: Call']) assert(bad.text.includes(want), `${want}\n${bad.text}`);
  });
  await check('G2', 'seed: the registry row (pointing at the clinic document), Settings (TEST_MODE true, request mode, demo labels) and Knowledge; running it again changes nothing twice', async () => {
    const docs = emptyDocs();
    const a = await go('seed', docs);
    assert.strictEqual(a.code, 0, a.err && a.err.message);
    assert.deepStrictEqual(docs.REG.Clinics.map((r) => [r.fields.Clinic_Slug, r.fields.Grist_Doc_ID, r.fields.Active, r.fields.Call_Number]), [['demo-physio', 'CLINIC', true, '+919000000100']]);
    const set = Object.fromEntries(docs.CLINIC.Settings.map((r) => [r.fields.Key, r.fields.Value]));
    assert.deepStrictEqual([set.TEST_MODE, set.booking_mode, set.demo_mode, set.missed_call_enabled, set.ai_mode], ['true', 'request', 'on', 'on', 'auto']);
    assert(docs.CLINIC.Knowledge.length >= 5 && docs.CLINIC.Knowledge.every((k) => k.fields.Active === true));
    const before = JSON.stringify(docs);
    docs.CLINIC.Settings.find((r) => r.fields.Key === 'ai_mode').fields.Value = 'off';   // someone changed it: seed puts the demo value back
    const b = await go('seed', docs);
    assert.strictEqual(b.code, 0);
    assert.strictEqual(JSON.stringify(docs), before, 'a second seed must leave exactly the same rows');
  });
  await check('G3', 'seed REFUSES a document that holds a lead outside the synthetic phone range, and writes nothing', async () => {
    const docs = emptyDocs(); docs.CLINIC.LEADS.push({ id: 1, fields: { Name: 'Somebody Real', Phone: '+919812345678' } });
    const before = JSON.stringify(docs);
    const r = await go('seed', docs);
    assert(r.err && /looks like real data/.test(r.err.message)); assert.strictEqual(JSON.stringify(docs), before); assert(!r.calls.some((c) => /^(POST|PATCH)/.test(c)));
  });
  await check('G4', 'reset: deletes leads, conversations, messages, requests and Run_Log - keeps Settings and Knowledge; refuses without demo_mode; refuses (deletes nothing) when a real lead is there', async () => {
    const docs = emptyDocs(); await go('seed', docs);
    docs.CLINIC.LEADS.push({ id: 1, fields: { Phone: '+919000000021' } }); docs.CLINIC.Conversations.push({ id: 1, fields: { Lead: 1 } });
    docs.CLINIC.Messages.push({ id: 1, fields: { Conversation: 1 } }, { id: 2, fields: { Conversation: 1 } }); docs.CLINIC.Appointments.push({ id: 1, fields: { Lead: 1 } }); docs.CLINIC.Run_Log.push({ id: 1, fields: { Workflow: 'x' } });
    const kept = [docs.CLINIC.Settings.length, docs.CLINIC.Knowledge.length];
    const noFlag = JSON.parse(JSON.stringify(docs)); noFlag.CLINIC.Settings.find((r) => r.fields.Key === 'demo_mode').fields.Value = 'off';
    const refused = await go('reset', noFlag); assert(refused.err && /demo_mode is not on/.test(refused.err.message)); assert.strictEqual(noFlag.CLINIC.LEADS.length, 1);
    const real = JSON.parse(JSON.stringify(docs)); real.CLINIC.LEADS.push({ id: 2, fields: { Phone: '+919812345678' } });
    const refused2 = await go('reset', real); assert(refused2.err && /looks like real data/.test(refused2.err.message)); assert.strictEqual(real.CLINIC.Messages.length, 2);
    const r = await go('reset', docs);
    assert.strictEqual(r.code, 0, r.err && r.err.message);
    assert.deepStrictEqual(['LEADS', 'Conversations', 'Messages', 'Appointments', 'Run_Log'].map((t) => docs.CLINIC[t].length), [0, 0, 0, 0, 0]);
    assert.deepStrictEqual([docs.CLINIC.Settings.length, docs.CLINIC.Knowledge.length], kept);
  });
  await check('G5', 'the API key is required, never printed, and only a local Grist is accepted', async () => {
    const noKey = await go('check', emptyDocs(), null, {}); assert(noKey.err && /set GRIST_API_KEY/.test(noKey.err.message));
    const remote = await go('check', emptyDocs(), null, { ...ENV, DEMO_GRIST_URL: 'https://docs.getgrist.com' }); assert(remote.err && /refusing docs\.getgrist\.com/.test(remote.err.message));
    const out = await go('seed', emptyDocs()); assert(!/SENTINEL/.test(out.text));
    for (const bad of [['seed'], ['seed', '--clinic-doc', 'CLINIC'], ['nope', '--clinic-doc', 'CLINIC']]) { const lines = []; await assert.rejects(run(bad, ENV, (l) => lines.push(l), fakeGrist(emptyDocs(), fullMeta()))); }
  });
  const bad = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id} ${r.title}${r.ok ? '' : `\n        ${r.why}`}`);
  console.log(bad.length ? `\n${bad.length} of ${results.length} SEED CHECKS FAILED` : `\nSEED GRIST: ${results.length} of ${results.length} checks pass`);
  process.exit(bad.length ? 1 : 0);
})();
