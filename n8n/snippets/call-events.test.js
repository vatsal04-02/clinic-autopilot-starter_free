// Run: node n8n/snippets/call-events.test.js
// MISSED_CALL_CAPTURE pure functions: webhook validation, tenant resolution, dedupe classification, ack outcome, W12 payloads.
// Synthetic data only (+91 90000 test numbers).
const assert = require('assert');
const ce = require('./call-events');
const { normalizeIndianPhone } = require('./normalize-phone');
const { decideSend } = require('./send-guard');

let n = 0;
const ok = (m) => { n++; console.log(`  ok  ${m}`); };
const h = { normalizeIndianPhone, decideSend };
const NOW = new Date('2026-10-06T11:00:00+05:30').getTime();
const NIGHT = new Date('2026-10-06T23:00:00+05:30').getTime();
const SEC = Math.floor(NOW / 1000);
const SECRET = 'demo-missed-call-secret';
const good = (over = {}) => ({ provider_call_id: 'demo-0001', called_number: '+919000000100', caller_number: '+919000000011', timestamp: SEC - 20, status: 'missed', duration_seconds: 14, provider: 'demo', ...over });
const req = (body, headers = { 'x-call-secret': SECRET }) => ({ headers, body });
const v = (body, headers, secret = SECRET, now = NOW) => ce.ceValidate(req(body, headers), { secret }, now, h);

// ---------------------------------------------------------------- 1. authentication
{
  assert.strictEqual(v(good()).action, 'process');
  const none = v(good(), {});
  assert.deepStrictEqual([none.action, none.http_status, none.response.error], ['reject', 401, 'unauthorized']);
  const wrong = v(good(), { 'x-call-secret': 'not-the-secret' });
  assert.deepStrictEqual([wrong.http_status, wrong.response.error], [401, 'unauthorized']);
  assert.strictEqual(v(good(), { 'X-Call-Secret': SECRET }).action, 'process', 'header names are case-insensitive');
  assert.strictEqual(v(good(), { 'x-call-secret': SECRET + ' ' }).http_status, 401, 'no trimming: exact match only');
  for (const s of ['', undefined, null, 'short', 'REPLACE_WITH_A_SECRET', 'PASTE_YOUR_SECRET_HERE']) {
    const r = ce.ceValidate(req(good(), { 'x-call-secret': s || 'x' }), { secret: s }, NOW, h);
    assert.deepStrictEqual([r.http_status, r.response.error], [503, 'not_configured'], `secret ${JSON.stringify(s)}`);
  }
  assert.strictEqual(ce.ceSafeEqual('abc', 'abc'), true);
  assert.strictEqual(ce.ceSafeEqual('abc', 'abd'), false);
  assert.strictEqual(ce.ceSafeEqual('abc', 'abcd'), false);
  assert.strictEqual(ce.ceSafeEqual('', ''), true);
  // authentication is checked BEFORE the body: a bad secret with a bad body is 401, not a hint about the body
  assert.strictEqual(v({ nonsense: true }, {}).http_status, 401);
}
ok('shared secret: missing / wrong = 401, unset or placeholder secret = 503 (fails closed), exact constant-time match, header case ignored, auth before body');

// ---------------------------------------------------------------- 2. valid events and statuses
{
  const r = v(good());
  assert.strictEqual(r.http_status, 200);
  assert.deepStrictEqual(r.response, { ok: true, status: 'accepted', call_key: 'call-demo-0001' });
  assert.deepStrictEqual(r.event, { call_id: 'demo-0001', call_key: 'call-demo-0001', called_key: '9000000100', caller_phone: '+919000000011', at: SEC - 20, kind: 'missed', duration_seconds: 14, provider: 'demo' });
  for (const s of ['missed', 'MISSED', ' unanswered ', 'no-answer', 'no_answer', 'noanswer']) assert.strictEqual(v(good({ status: s })).event.kind, 'missed', s);
  assert.strictEqual(v(good({ status: 'busy' })).event.kind, 'busy');
  for (const s of ['answered', 'completed', 'ringing', 'in-progress']) {
    const r2 = v(good({ status: s }));
    assert.deepStrictEqual([r2.action, r2.http_status, r2.response.reason], ['ignore', 200, 'call_not_missed'], s);
    assert(!r2.event);
  }
  // optional fields
  const bare = v({ provider_call_id: 'x1', called_number: '9000000100', caller_number: '9000000011', timestamp: SEC, status: 'missed' });
  assert.strictEqual(bare.action, 'process');
  assert.strictEqual(bare.event.duration_seconds, null);
  assert.strictEqual(bare.event.provider, 'unknown');
}
ok('a valid event is accepted; missed / unanswered / no-answer = missed, busy = busy; answered and ringing are ignored (200), never processed');

// ---------------------------------------------------------------- 3. malformed events are rejected with the exact bad fields
{
  const bad = (over, fields, status = 400) => {
    const r = v(good(over));
    assert.deepStrictEqual([r.action, r.http_status, r.response.error], ['reject', status, 'invalid_event'], JSON.stringify(over));
    assert.deepStrictEqual(r.response.fields, fields, JSON.stringify(over));
    assert(!r.event);
  };
  bad({ provider_call_id: undefined }, ['provider_call_id']);
  bad({ provider_call_id: '' }, ['provider_call_id']);
  bad({ provider_call_id: 'has space' }, ['provider_call_id']);
  bad({ provider_call_id: 'a/b' }, ['provider_call_id']);
  bad({ provider_call_id: 'x'.repeat(101) }, ['provider_call_id']);
  bad({ provider_call_id: { $ne: 1 } }, ['provider_call_id']);
  bad({ provider_call_id: ['a'] }, ['provider_call_id']);
  bad({ called_number: undefined }, ['called_number']);
  bad({ called_number: '12345' }, ['called_number']);
  bad({ caller_number: undefined }, ['caller_number']);
  bad({ caller_number: '12345' }, ['caller_number']);
  bad({ caller_number: 'anonymous' }, ['caller_number']);
  bad({ caller_number: '+14155550100' }, ['caller_number']);
  bad({ caller_number: { phone: '+919000000011' } }, ['caller_number']);
  bad({ timestamp: undefined }, ['timestamp']);
  bad({ timestamp: 'yesterday' }, ['timestamp']);
  bad({ timestamp: -5 }, ['timestamp']);
  bad({ timestamp: SEC + 3600 }, ['timestamp']);
  bad({ timestamp: SEC - 3 * 86400 }, ['timestamp_too_old']);
  bad({ status: undefined }, ['status']);
  bad({ status: 'exploded' }, ['status']);
  bad({ status: 7 }, ['status']);
  bad({ duration_seconds: -1 }, ['duration_seconds']);
  bad({ duration_seconds: 'long' }, ['duration_seconds']);
  bad({ duration_seconds: 999999 }, ['duration_seconds']);
  bad({ provider_call_id: '', caller_number: 'x', status: 'nope' }, ['provider_call_id', 'caller_number', 'status']);
  for (const body of [null, undefined, 'a string', 42, [], [good()]]) {
    const r = v(body);
    assert.deepStrictEqual([r.http_status, r.response.fields], [400, ['body']], JSON.stringify(body));
  }
  // the error response never echoes values from the request
  const r = v(good({ caller_number: 'secret-looking-value-123' }));
  assert(!JSON.stringify(r.response).includes('secret-looking-value-123'));
}
ok('malformed events (ids, numbers, time, status, duration, non-object bodies) are rejected 400 with the bad field NAMES only; no request value is echoed');

// ---------------------------------------------------------------- 4. phone and time normalisation
{
  const callers = ['+919000000011', '919000000011', '09000000011', '9000000011', '+91 90000 00011', '0091 9000000011', '+91-90000-00011'];
  for (const c of callers) assert.strictEqual(v(good({ caller_number: c })).event.caller_phone, '+919000000011', c);
  assert.strictEqual(v(good({ caller_number: 9000000011 })).event.caller_phone, '+919000000011', 'a number typed as a JSON number');
  // called number: the same key from any common spelling, mobile or landline / toll-free
  for (const c of ['+919000000100', '9000000100', '09000000100', '+91 90000 00100']) assert.strictEqual(ce.ceCalledKey(c, h), '9000000100', c);
  for (const c of ['0522 4000123', '+91 522 4000123', '05224000123', '915224000123', '5224000123']) assert.strictEqual(ce.ceCalledKey(c, h), '5224000123', c);
  assert.strictEqual(ce.ceCalledKey('1800 123 4567', h), '', 'known limit: an 11-digit 1800 toll-free number is not a 10-digit key (mobile and STD landline numbers only)');
  for (const c of ['', null, undefined, '12345', '+14155550100', {}, [], '0000000000']) assert.strictEqual(ce.ceCalledKey(c, h), '', String(c));
  // time: seconds, milliseconds, ISO, numeric string
  const base = SEC - 30;
  for (const t of [base, base * 1000, String(base), new Date(base * 1000).toISOString(), `${base}.0`]) assert.strictEqual(v(good({ timestamp: t })).event.at, base, String(t));
  assert.strictEqual(v(good({ timestamp: SEC + 300 })).action, 'process', '5 minutes of clock drift is fine');
}
ok('caller numbers normalise through the repository helper to +91XXXXXXXXXX; called numbers match across spellings (mobile, STD landline); time accepts seconds / ms / ISO');

// ---------------------------------------------------------------- 5. tenant: the registry decides, never the request
{
  const rows = [
    { id: 1, fields: { Clinic_Slug: 'demo-physio', Clinic_Name: 'Demo Physio', Grist_Doc_ID: 'DOCA', WA_Phone_Number_ID: '123456789012345', Active: true, Call_Number: '+919000000100' } },
    { id: 2, fields: { Clinic_Slug: 'second-clinic', Clinic_Name: 'Second Physio', Grist_Doc_ID: 'DOCB', WA_Phone_Number_ID: '223456789012345', Active: true, Call_Number: '0522 4000123' } },
    { id: 3, fields: { Clinic_Slug: 'closed', Clinic_Name: 'Closed', Grist_Doc_ID: 'DOCX', Active: false, Call_Number: '+919000000300' } },
    { id: 4, fields: { Clinic_Slug: 'no-number', Clinic_Name: 'No Number', Grist_Doc_ID: 'DOCN', Active: true } },
    { id: 5, fields: { Clinic_Slug: 'no-doc', Clinic_Name: 'No Doc', Grist_Doc_ID: '', Active: true, Call_Number: '+919000000400' } },
  ];
  const find = (calledRaw) => ce.ceResolveClinic(rows, ce.ceCalledKey(calledRaw, h), h);
  assert.deepStrictEqual(find('+919000000100'), { found: true, clinic: { slug: 'demo-physio', name: 'Demo Physio', doc_id: 'DOCA', wa_phone_number_id: '123456789012345' } });
  assert.strictEqual(find('09000000100').clinic.doc_id, 'DOCA');
  assert.strictEqual(find('+91 522 4000123').clinic.doc_id, 'DOCB', 'a landline written another way');
  for (const c of ['+919000000999', '+919000000300', '+919000000400']) assert.deepStrictEqual(find(c), { found: false, reason: 'unknown_number' }, `${c}: unknown, inactive or without a doc`);
  assert.deepStrictEqual(ce.ceResolveClinic(rows, '', h), { found: false, reason: 'unknown_number' }, 'an empty key never matches the clinic without a number');
  const twice = rows.concat([{ id: 6, fields: { Clinic_Slug: 'other', Clinic_Name: 'Other', Grist_Doc_ID: 'DOCZ', Active: true, Call_Number: '+919000000100' } }]);
  assert.deepStrictEqual(ce.ceResolveClinic(twice, '9000000100', h), { found: false, reason: 'ambiguous_number' }, 'two clinics claim one number: never guess');
  const sameDoc = rows.concat([{ id: 7, fields: { Clinic_Slug: 'demo-physio-2', Clinic_Name: 'Demo Physio', Grist_Doc_ID: 'DOCA', Active: true, Call_Number: '9000000100' } }]);
  assert.strictEqual(ce.ceResolveClinic(sameDoc, '9000000100', h).found, true, 'two rows for the same doc are not ambiguous');
  // a body that names another clinic does not change the event or the lookup key
  const forged = v(good({ clinic: 'second-clinic', clinic_slug: 'second-clinic', tenant: 'DOCB', doc_id: 'DOCB', Grist_Doc_ID: 'DOCB' }));
  assert.strictEqual(forged.action, 'process');
  assert.strictEqual(JSON.stringify(forged).includes('DOCB'), false);
  assert.strictEqual(JSON.stringify(forged).includes('second-clinic'), false);
  assert.strictEqual(ce.ceResolveClinic(rows, forged.event.called_key, h).clinic.doc_id, 'DOCA');
}
ok('tenant = the registry row whose Call_Number matches the CALLED number; unknown / inactive / no-doc / ambiguous never match; a clinic or doc id in the body is ignored');

// ---------------------------------------------------------------- 6. settings and the claim row
{
  const s = ce.ceSettings([{ id: 1, fields: { Key: 'missed_call_enabled', Value: 'on' } }, { id: 2, fields: { Key: 'demo_mode', Value: 'TRUE' } }, { id: 3, fields: { Key: 'clinic_name', Value: 'Demo Physio' } },
    { id: 4, fields: { Key: 'TEST_MODE', Value: 'true' } }, { id: 5, fields: { Key: 'TEST_PHONE', Value: '99999 99999' } }, { id: 6, fields: { Key: 'owner_phone', Value: '+919000000018' } }], 'Registry Name');
  assert.deepStrictEqual([s.enabled, s.demo, s.clinic_name, s.test_mode, s.owner_phone], [true, true, 'Demo Physio', 'true', '+919000000018']);
  const off = ce.ceSettings([], 'Registry Name');
  assert.deepStrictEqual([off.enabled, off.demo, off.clinic_name], [false, false, 'Registry Name'], 'missing = off (safe default)');
  for (const val of ['off', 'false', '', 'maybe', 'enabled']) assert.strictEqual(ce.ceSettings([{ fields: { Key: 'missed_call_enabled', Value: val } }]).enabled, false, val);
  const ev = v(good()).event;
  const row = ce.ceClaimRow(ev, SEC, true);
  assert.deepStrictEqual([row.Direction, row.Template, row.Intent, row.WA_Message_ID, row.Status, row.Send, row.AI_Action, row.Sent_By], ['In', 'missed_call', 'missed_call', 'call-demo-0001', 'Received', false, 'mcc:claimed', 'MCC-missed-call']);
  assert(row.Body.startsWith('[DEMO] Missed call (missed) at 2026-10-06 10:59 IST'), row.Body);
  assert(!row.Body.includes('9000000011') && !JSON.stringify(row).includes('+91'), 'no phone number in the row');
  assert.strictEqual(row.Created_At, SEC, 'Created_At = when we recorded it');
  assert(!ce.ceClaimRow(ev, SEC, false).Body.includes('[DEMO]'));
  assert(!('Last_Inbound_At' in row), 'a missed call never opens the 24 h WhatsApp window');
}
ok('Settings parse (missing = off); the claim row is a DEMO-labelled Messages row without any phone number and never touches Last_Inbound_At');

// ---------------------------------------------------------------- 7. retries and concurrent copies
{
  const KEY = 'call-demo-0001';
  const row = (id, f) => ({ id, fields: { WA_Message_ID: KEY, Template: 'missed_call', Created_At: SEC - 10, ...f } });
  assert.deepStrictEqual(ce.ceClassifyExisting([], SEC), { kind: 'new' });
  assert.strictEqual(ce.ceClassifyExisting([row(5, { AI_Action: 'mcc:claimed' })], SEC).kind, 'inflight', 'claimed 10 s ago, not linked: still being processed');
  assert.strictEqual(ce.ceClassifyExisting([row(5, { AI_Action: 'mcc:claimed', Created_At: SEC - 600 })], SEC).kind, 'resume', 'claimed long ago, never linked: finish it');
  const linked = (state, extra = {}) => ce.ceClassifyExisting([row(5, { Conversation: 3, AI_Action: state, ...extra })], SEC).kind;
  assert.strictEqual(linked('mcc:ack_simulated'), 'duplicate');
  assert.strictEqual(linked('mcc:ack_sent'), 'duplicate');
  assert.strictEqual(linked('mcc:ack_skipped'), 'duplicate');
  assert.strictEqual(linked('mcc:ack_failed', { AI_Reason: 'attempt 1: not sent: Meta down' }), 'retry_ack');
  assert.strictEqual(linked('mcc:ack_deferred', { AI_Reason: 'attempt 1: quiet hours, will retry' }), 'retry_ack');
  assert.strictEqual(linked('mcc:ack_pending'), 'retry_ack', 'linked but the ack was never attempted (a crash)');
  assert.strictEqual(linked('mcc:ack_failed', { AI_Reason: 'attempt 3: not sent: Meta down' }), 'duplicate', 'tries used up');
  assert.strictEqual(ce.ceAttempts(row(1, { AI_Reason: 'attempt 2: x' })), 2);
  assert.strictEqual(ce.ceAttempts(row(1, {})), 0);
  // several rows with the key (a concurrent copy): the lowest id decides
  assert.strictEqual(ce.ceClassifyExisting([row(9, { Conversation: 3, AI_Action: 'mcc:ack_simulated' }), row(5, { AI_Action: 'mcc:claimed' })], SEC).row.id, 5);
  // canonical
  assert.deepStrictEqual(ce.ceCanonical([row(5, {}), row(6, {})], 5), { canonical_id: 5, mine: true, others: [6] });
  assert.deepStrictEqual(ce.ceCanonical([row(5, {}), row(6, {})], 6), { canonical_id: 5, mine: false, others: [6] });
  assert.deepStrictEqual(ce.ceCanonical([row(6, {})], 6), { canonical_id: 6, mine: true, others: [] });
  assert.deepStrictEqual(ce.ceCanonical([], 7), { canonical_id: 7, mine: true, others: [] }, 'an empty re-read must not strand the event');
  assert.strictEqual(ce.ceDupKey(KEY, 6), 'call-demo-0001-dup-6');
}
ok('repeats classify as new / inflight / resume / retry_ack / duplicate; the lowest row id wins a concurrent copy and the others stand down');

// ---------------------------------------------------------------- 8. what W12's answer means
{
  const o = (w12) => ce.ceAckOutcome(w12, 2);
  assert.deepStrictEqual(o({ simulated: true, send_status: 'simulated', sent: false }), { state: 'mcc:ack_simulated', outcome: 'ok', detail: 'attempt 2: DEMO simulated, nothing was sent' });
  assert.strictEqual(o({ sent: true, send_status: 'accepted' }).state, 'mcc:ack_sent');
  assert(/not yet delivered/.test(o({ sent: true, send_status: 'accepted' }).detail), 'accepted is not delivered');
  assert.strictEqual(o({ sent: false, send_status: 'blocked', send_error: 'quiet hours (21:00-08:00 IST)' }).state, 'mcc:ack_deferred');
  const f = o({ sent: false, send_status: 'rejected', send_error: '131030: recipient is not in the allowed list' });
  assert.deepStrictEqual([f.state, f.outcome], ['mcc:ack_failed', 'failed']);
  assert.strictEqual(o({ sent: false, send_status: 'blocked', send_error: '+919000000011 is not in the W12 allowlist' }).state, 'mcc:ack_failed');
  assert.strictEqual(o(null).state, 'mcc:ack_failed');
  assert.strictEqual(o({ sent: false, simulated: false, send_status: 'invalid', send_error: 'x' }).state, 'mcc:ack_failed');
  // a simulated send is never "sent"
  assert.notStrictEqual(o({ simulated: true, sent: true }).state, 'mcc:ack_sent', 'the simulated flag wins even if sent were wrongly true');
}
ok('W12 answers map to simulated / sent ("accepted", not delivered) / deferred / failed; simulated can never become sent');

// ---------------------------------------------------------------- 9. the send decisions and W12 payloads
{
  const ctx = { lead_phone: '+919000000011', test_mode: 'false', test_phone: '+919000000019', owner_phone: '+919000000018', opted_out: false, automation_paused: false, assigned_to: '' };
  const d = ce.ceAckDecision(ctx, NOW, h);
  assert.deepStrictEqual([d.send, d.to, d.state], [true, '+919000000011', 'mcc:ack_pending']);
  const t = ce.ceAckDecision({ ...ctx, test_mode: 'true' }, NOW, h);
  assert.deepStrictEqual([t.send, t.to, t.test_mode], [true, '+919000000019', true], 'TEST_MODE sends to TEST_PHONE');
  assert.strictEqual(ce.ceAckDecision({ ...ctx, test_mode: undefined }, NOW, h).to, '+919000000019', 'a missing TEST_MODE counts as ON');
  const out = ce.ceAckDecision({ ...ctx, opted_out: true }, NOW, h);
  assert.deepStrictEqual([out.send, out.reason, out.state], [false, 'opted out', 'mcc:ack_skipped']);
  const paused = ce.ceAckDecision({ ...ctx, automation_paused: true }, NOW, h);
  assert.deepStrictEqual([paused.send, paused.state], [false, 'mcc:ack_skipped']);
  const mine = ce.ceAckDecision({ ...ctx, assigned_to: 'Dr. Mehta' }, NOW, h);
  assert.deepStrictEqual([mine.send, mine.state], [false, 'mcc:ack_skipped'], 'a person who owns the chat: no automated ack');
  const recent = ce.ceAckDecision({ ...ctx, recent_ack_at: SEC - 600 }, NOW, h);
  assert.deepStrictEqual([recent.send, recent.state], [false, 'mcc:ack_skipped'], 'one acknowledgement per caller per hour');
  assert.match(recent.reason, /less than an hour/);
  assert.strictEqual(ce.ceAckDecision({ ...ctx, recent_ack_at: SEC - 7200 }, NOW, h).send, true, 'an hour later a new missed call is acknowledged again');
  assert.strictEqual(ce.ceAckDecision({ ...ctx, recent_ack_at: 0 }, NOW, h).send, true);
  const ackRow = (id, f) => ({ id, fields: { Direction: 'Out', Template: 'missed_call_ack', Status: 'queued', Created_At: SEC - 100, ...f } });
  assert.strictEqual(ce.ceRecentAck([ackRow(1, {}), ackRow(2, { Created_At: SEC - 5 })]), SEC - 5);
  assert.strictEqual(ce.ceRecentAck([ackRow(1, { Status: 'failed' })]), 0, 'a failed attempt must stay retryable: it is not an acknowledgement');
  assert.strictEqual(ce.ceRecentAck([ackRow(1, { Direction: 'In' }), ackRow(2, { Template: 'reminder_24h' })]), 0);
  assert.strictEqual(ce.ceRecentAck([]), 0);
  assert.strictEqual(ce.ceRecentAck(null), 0);
  const night = ce.ceAckDecision(ctx, NIGHT, h);
  assert.deepStrictEqual([night.send, night.reason, night.state], [false, 'quiet hours', 'mcc:ack_deferred']);
  assert.strictEqual(ce.ceAckDecision({ ...ctx, lead_phone: 'bad' }, NOW, h).state, 'mcc:ack_skipped');
  assert.strictEqual(ce.ceAlertDecision(ctx, NOW, h).to, '+919000000018');
  assert.strictEqual(ce.ceAlertDecision({ ...ctx, test_mode: 'true' }, NOW, h).to, '+919000000019');
  assert.strictEqual(ce.ceAlertDecision({ ...ctx, owner_phone: '' }, NOW, h).send, false, 'no owner phone: no alert');
  const full = { ...ctx, wa_phone_number_id: '123456789012345', grist_base_url: 'http://grist:8484', doc_id: 'DOCA', clinic_name: 'Demo Physio', lead_row_id: 4, lead_name: 'Caller 0011', kind: 'missed' };
  const item = ce.ceAckItem(full, d);
  assert.deepStrictEqual([item.source_workflow, item.audience, item.message_type, item.template, item.template_params], ['W12-missed-call-ack', 'patient', 'template', 'missed_call_ack', { clinic_name: 'Demo Physio' }]);
  assert(/^W\d+(?!\w)/.test(item.source_workflow), 'matches the existing "automation, not a person" Sent_By convention');
  assert.strictEqual(item.message_text, 'Namaste! Sorry, we missed your call to Demo Physio. How can we help you today?');
  assert(!Object.keys(item).some((k) => k.startsWith('w12_')), 'W12 strips w12_ keys');
  const al = ce.ceAlertItem(full, ce.ceAlertDecision(ctx, NOW, h));
  assert.deepStrictEqual([al.audience, al.template, al.template_params.enquiry, al.source_workflow], ['staff', 'new_lead_staff_alert', 'Missed call (missed)', 'W12-missed-call-alert']);
  assert(/^W\d+(?!\w)/.test(al.source_workflow));
}
ok('ack: TEST_MODE, opt-out, pause / owner, quiet hours, bad phone all decided by send-guard; W12 items follow the existing automation naming and carry no w12_ keys');

// ---------------------------------------------------------------- 10. logs carry no personal data
{
  const l = ce.ceLogRow('call-demo-0001 L-20261006-0001: ack simulated', 'ok', '', SEC, true);
  assert.deepStrictEqual(l, { Workflow: 'MCC-missed-call-capture', Record: '[DEMO] call-demo-0001 L-20261006-0001: ack simulated', Outcome: 'ok', Error: '', At: SEC });
  assert(!ce.ceLogRow('x', 'ok', '', SEC, false).Record.startsWith('[DEMO]'));
  assert.strictEqual(ce.ceMaskPhone('+919000000011'), '…0011');
  assert.strictEqual(ce.ceMaskPhone(''), '…');
  assert.strictEqual(ce.ceText('a\n\tb\u0000c', 10), 'a b c');
}
ok('Run_Log rows are DEMO-labelled when the clinic is a demo, and numbers are masked to the last 4 digits');

console.log(`\nAll ${n} call-events cases pass`);
