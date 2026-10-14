// THE SCRIPTED DEMO: one clinic ("Demo Physio", synthetic), eight short stories, every step checked. It runs the combined demo workflow in the
// in-repo simulator (demo-world.js): the phone and WhatsApp requests are built by console-lib.js (the same bytes the console sends to a local n8n),
// the team's actions are Grist writes (what FLOW HQ / Grist do), and the model behind Ollama is SCRIPTED (see DEMO.md for what that does and does not prove).
//   run-demo.js prints it as a transcript; demo.test.js asserts it (a failed check fails the test).
const assert = require('assert');
const { World } = require('./demo-world');
const { DEMO, SCRIPT } = require('./demo-data');

const C = DEMO.callers;
const strip = (b) => String(b).replace(/^\[DEMO simulated, not sent\]\s*/, '');
const SIM_ID = /^sim-/;

// ---- what happened since a mark, in words
function describe(w, since) {
  const lines = [];
  for (const m of since.messages) {
    if (m.Direction === 'In' && m.Template === 'missed_call') lines.push(`record   : missed-call event stored (${m.AI_Action}); ${String(m.Body).replace('[DEMO] ', '')}`);
    else if (m.Direction === 'In') lines.push(`record   : patient message stored; AI ${m.AI_Status || '-'}${m.Intent ? `, intent ${m.Intent}` : ''}${m.AI_Action ? `, action ${m.AI_Action}` : ''}`);
    else if (/^\[DEMO simulated/.test(m.Body)) lines.push(`SIMULATED -> patient (NOT sent, ${/would go to (\+\d+)/.exec(m.Sent_By)?.[1] || 'no number'}): "${strip(m.Body).replace(/\n/g, ' / ').slice(0, 170)}"`);
    else lines.push(`record   : staff reply row "${String(m.Body).slice(0, 80)}" -> ${m.Status}${m.AI_Reason ? ` (${m.AI_Reason})` : ''}`);
  }
  for (const l of since.log) lines.push(`run log  : ${l.Workflow} ${l.Outcome}${l.Record ? ` - ${String(l.Record).slice(0, 110)}` : ''}${l.Error ? ` | ${String(l.Error).slice(0, 130)}` : ''}`);
  if (since.ollama) lines.push(`model    : the local model was asked ${since.ollama} time(s)`);
  return lines;
}

function buildSteps() {
  const steps = [];
  const step = (id, title, fn) => steps.push({ id, title, fn });
  const leadOf = (w, phone) => w.rows('LEADS').find((l) => l.Phone === phone);
  const convOf = (w, phone) => w.rows('Conversations').find((c) => c.Phone === phone);
  const outTo = (w, since, tpl) => since.messages.filter((m) => m.Direction === 'Out' && (!tpl || m.Template === tpl));
  const apptBy = (w, uid) => w.rows('Appointments').find((a) => a.Booking_UID === uid);
  const reqOf = (w, phone) => w.rows('Appointments').filter((a) => a.Lead === leadOf(w, phone).id && /^req-/.test(a.Booking_UID)).slice(-1)[0];

  step('A1', '1. A caller misses the clinic phone', (w, r) => {
    r.say('phone', `${C.meera} calls ${DEMO.clinic.callNumber} and nobody answers (provider webhook: missed call)`);
    const mk = w.mark(); const x = w.missedCall({ caller: C.meera, id: 'demo-call-0001' });
    r.rows(w, mk, x);
    r.check('answered 200 at once with status "accepted"', () => assert.deepStrictEqual(x.responses.map((q) => [q.code, q.body.status]), [[200, 'accepted']]));
    r.check('a lead was created from the CALLED number\'s clinic: Source Call, Status New, a demo caller name', () => {
      const l = leadOf(w, C.meera); assert(l); assert.deepStrictEqual([l.Source, l.Status], ['Call', 'New']); assert(/^\[DEMO\]/.test(l.Notes)); assert(/^L-\d{8}-\d{4}$/.test(l.Lead_id));
    });
    r.check('a conversation exists with 1 unread and NO 24-hour WhatsApp window (a call is not a message)', () => { const c = convOf(w, C.meera); assert.strictEqual(c.Unread, 1); assert(!('Last_Inbound_At' in c)); });
    r.check('the call is stored as an EVENT row (Template missed_call), ack state mcc:ack_simulated', () => { const e = w.rows('Messages').filter((m) => m.Template === 'missed_call'); assert.strictEqual(e.length, 1); assert.strictEqual(e[0].AI_Action, 'mcc:ack_simulated'); });
    r.check('the call-back message is SIMULATED: shown in the thread as "[DEMO simulated, not sent]", id sim-..., never sent', () => {
      const a = outTo(w, w.since(mk), 'missed_call_ack'); assert.strictEqual(a.length, 1);
      assert(/^\[DEMO simulated, not sent\] Namaste!/.test(a[0].Body)); assert(SIM_ID.test(a[0].WA_Message_ID)); assert.strictEqual(a[0].Send, false);
      assert(/DEMO simulated: nothing was sent; would go to \+919000000019/.test(a[0].Sent_By), 'TEST_MODE: it would have gone to the TEST phone, not the caller');
    });
    r.check('Run_Log: one ok row that says "ack simulated; staff alert simulated"', () => { const l = w.since(mk).log; assert.strictEqual(l.length, 1); assert.deepStrictEqual([l[0].Outcome, /ack simulated; staff alert simulated/.test(l[0].Record)], ['ok', true]); });
    r.check('nothing reached Meta, OpenRouter or the model', () => assert.deepStrictEqual([w.metaCalls.length, w.openrouterCalls.length, w.since(mk).ollama], [0, 0, 0]));
  });

  step('A2', '2. The phone provider delivers the same event again (a retry)', (w, r) => {
    r.say('phone', 'the same call id arrives twice more');
    const mk = w.mark(); const a = w.missedCall({ caller: C.meera, id: 'demo-call-0001' }); const b = w.missedCall({ caller: C.meera, id: 'demo-call-0001' });
    r.rows(w, mk, b);
    r.check('both deliveries are answered 200 (the provider stops retrying)', () => assert.deepStrictEqual([...a.responses, ...b.responses].map((q) => q.code), [200, 200]));
    r.check('still ONE lead, ONE call event, ONE acknowledgement: nothing was created twice', () => {
      assert.strictEqual(w.rows('LEADS').length, 1); assert.strictEqual(w.rows('Messages').filter((m) => m.Template === 'missed_call').length, 1); assert.strictEqual(w.rows('Messages').filter((m) => m.Template === 'missed_call_ack').length, 1);
    });
    r.check('each duplicate is logged as skipped, with the reason', () => assert(w.since(mk).log.length === 2 && w.since(mk).log.every((l) => l.Outcome === 'skipped' && /duplicate/.test(l.Error))));
  });

  step('A3', '3. Calls that must be refused', (w, r) => {
    const mk = w.mark();
    const bad = w.missedCall({ caller: C.meera, id: 'x1', secret: 'not-the-secret' });
    const answered = w.missedCall({ caller: C.meera, id: 'x2', status: 'answered' });
    const stranger = w.missedCall({ caller: C.meera, id: 'x3', called: '+919000000555' });
    r.say('phone', 'wrong X-Call-Secret / an answered call / a called number that belongs to no clinic');
    r.check('wrong secret: 401 and nothing written', () => assert.strictEqual(bad.responses[0].code, 401));
    r.check('an answered call is ignored (200, "call_not_missed"), nothing written', () => assert.deepStrictEqual([answered.responses[0].code, answered.responses[0].body.reason], [200, 'call_not_missed']));
    r.check('an unknown called number finds no clinic: nothing is written (tenant comes ONLY from the called number, never from the request body)', () => { assert(stranger.errors.some((e) => /no active clinic owns the called number/.test(e.message))); });
    r.check('none of the three wrote to Grist', () => assert.strictEqual(w.since(mk).writes.length, 0));
    w.errors.length = 0;   // the unknown-number stop is the expected error of this step
  });

  step('B1', '4. English conversation: the assistant answers from the knowledge base', (w, r) => {
    w.advance(3);
    for (const text of [SCRIPT.en.services, SCRIPT.en.pricing]) {
      r.say('patient', `${C.meera}: ${text}`);
      const mk = w.mark(); const x = w.say({ from: C.meera, text }); r.rows(w, mk, x);
      const d = w.since(mk);
      r.check('stored, the model was asked once, the reply passed the fact check and is SIMULATED', () => {
        assert.strictEqual(d.ollama, 1); const out = outTo(w, d); assert.strictEqual(out.length, 1); assert(/^\[DEMO simulated, not sent\]/.test(out[0].Body));
        assert.strictEqual(d.messages.find((m) => m.Direction === 'In').AI_Status, 'replied');
      });
      r.check('Run_Log is ok (a simulated send is not a failure) and says "DEMO simulated, nothing was sent"', () => { const l = d.log.find((q) => q.Workflow === 'W13-ai-receptionist'); assert.deepStrictEqual([l.Outcome, /^DEMO simulated, nothing was sent/.test(l.Error)], ['ok', true]); });
      w.advance(3);
    }
    r.check('prices in the reply are the knowledge base\'s: ₹500 and ₹800', () => { const last = w.rows('Messages').filter((m) => m.Direction === 'Out').slice(-1)[0]; assert(/₹500/.test(last.Body) && /₹800/.test(last.Body)); });
    r.check('the conversation is NOT flagged for a person (the assistant handled it)', () => assert.notStrictEqual(convOf(w, C.meera).Needs_Human, true));
  });

  step('B2', '5. Hindi / Hinglish conversation (new patient)', (w, r) => {
    for (const text of [SCRIPT.hi.greeting, SCRIPT.hi.pricing, SCRIPT.hi.hours]) {
      r.say('patient', `${C.kavya}: ${text}`);
      const mk = w.mark(); const x = w.say({ from: C.kavya, text }); r.rows(w, mk, x);
      r.check('answered from the knowledge base, SIMULATED, AI_Status replied', () => { const d = w.since(mk); assert.strictEqual(outTo(w, d).length, 1); assert.strictEqual(d.messages.find((m) => m.Direction === 'In').AI_Status, 'replied'); });
      w.advance(3);
    }
    r.check('the hours answer is the knowledge base\'s ("9 AM to 7 PM")', () => assert(/9 AM to 7 PM/.test(w.rows('Messages').filter((m) => m.Direction === 'Out').slice(-1)[0].Body)));
    r.note('The model here is SCRIPTED: this proves the Hinglish message travels through signature check -> W2 -> W13 -> fact check -> W12 (simulate) -> CRM. How well a real local model understands Hinglish is NOT proven by this demo.');
  });

  step('B3', '6. Replays, forgeries and tampering', (w, r) => {
    const text = 'What services do you offer?';
    r.say('patient', `${C.arjun} writes once; Meta delivers the same signed message again`);
    const first = w.say({ from: C.arjun, text, id: 'wamid.DEMO.replay' });
    const mk = w.mark(); const again = w.say({ from: C.arjun, text, id: 'wamid.DEMO.replay' });
    r.rows(w, mk, again);
    r.check('the replay is answered 200 but processed ONCE: no new message, no model call, logged as skipped', () => { const d = w.since(mk); assert.deepStrictEqual([again.responses[0].code, d.messages.length, d.ollama], [200, 0, 0]); assert(d.log.some((l) => l.Outcome === 'skipped')); });
    const mk2 = w.mark(); const forged = w.forged('hello', C.arjun); const tampered = w.say({ from: C.arjun, text: 'hello', tamper: true });
    r.say('attacker', 'a request signed with the wrong secret; a signed request whose body was changed after signing');
    r.check('both get 401 {"status":"unauthorized"}; nothing is read, written or asked of the model', () => { assert.deepStrictEqual([forged.responses[0].code, tampered.responses[0].code], [401, 401]); const d = w.since(mk2); assert.deepStrictEqual([d.writes.length, d.ollama], [0, 0]); });
    assert(first.errors.length === 0);
    w.advance(3);
  });

  step('C1', '7. A patient asks for an appointment: it becomes a REQUEST, never a booking', (w, r) => {
    r.say('patient', `${C.meera}: ${SCRIPT.en.book}`);
    const mk = w.mark(); const x = w.say({ from: C.meera, text: SCRIPT.en.book }); r.rows(w, mk, x);
    r.check('one Appointments row, Status "Requested", Booking_UID req-..., Requested_At set', () => { const a = reqOf(w, C.meera); assert.deepStrictEqual([a.Status, /^req-/.test(a.Booking_UID), typeof a.Requested_At], ['Requested', true, 'number']); });
    r.check('the patient is told it is NOT confirmed (fixed text, written in code, not by the model)', () => assert(/NOT confirmed yet/.test(outTo(w, w.since(mk))[0].Body)));
    r.check('nothing is Booked: no Booked appointment, the lead is not marked Booked, no Confirm_Sent', () => { assert(!w.rows('Appointments').some((a) => a.Status === 'Booked')); assert.notStrictEqual(leadOf(w, C.meera).Status, 'Booked'); assert(!('Confirm_Sent' in reqOf(w, C.meera))); });
    w.advance(5);
  });

  step('C2', '8. The team confirms the request: the patient is told once', (w, r) => {
    const a = reqOf(w, C.meera);
    r.say('staff', `confirms ${a.Booking_UID} in FLOW HQ (Requests > Confirm) = Appointments.Status -> Booked`);
    w.staffSetStatus(a.id, 'Booked'); w.advance(2);
    const mk = w.mark(); const x = w.tick('REQ – Every 2 minutes'); r.rows(w, mk, x);
    r.check('the patient is told it IS confirmed (SIMULATED), with the date and time', () => { const o = outTo(w, w.since(mk)); assert.strictEqual(o.length, 1); assert(/is confirmed for 08 Oct at 5:00 PM/.test(o[0].Body)); });
    r.check('Confirm_Sent is set, the lead becomes Booked, Run_Log ok "[DEMO simulated, nothing sent]"', () => { const q = apptBy(w, a.Booking_UID); assert.deepStrictEqual([q.Status, typeof q.Confirm_Sent, leadOf(w, C.meera).Status], ['Booked', 'number', 'Booked']); assert(w.since(mk).log.some((l) => l.Workflow === 'REQ-request-confirm' && l.Outcome === 'ok' && /DEMO simulated/.test(l.Record))); });
    const mk2 = w.mark(); w.tick('REQ – Every 2 minutes');
    r.check('the next run does nothing: the patient is never told twice', () => assert.strictEqual(w.since(mk2).writes.length, 0));
    w.advance(3);
  });

  step('C3', '9. Two people want one time: no double booking', (w, r) => {
    r.say('patient', `${C.arjun}: Book me for Friday at 4.`);
    const mk0 = w.mark(); const x0 = w.say({ from: C.arjun, text: 'Book me for Friday at 4.' }); r.rows(w, mk0, x0);
    const req = reqOf(w, C.arjun);
    r.check('Arjun\'s request is Requested', () => assert.strictEqual(req.Status, 'Requested'));
    r.say('booking system', 'meanwhile a booking for the same time is made in the booking system (Cal.com): a Booked row appears');
    w.grist('POST', 'Appointments', { records: [{ fields: { Booking_UID: 'cal-demo-0001', Lead: leadOf(w, C.meera).id, Service: 'Assessment', Start: req.Start, End: req.End, Status: 'Booked' } }] });
    r.say('staff', 'confirms Arjun\'s request in Grist anyway');
    w.staffSetStatus(req.id, 'Booked'); w.advance(2);
    const mk = w.mark(); const x = w.tick('REQ – Every 2 minutes'); r.rows(w, mk, x);
    r.check('REFUSED: the row goes back to Requested, nothing is promised to the patient', () => { assert.strictEqual(apptBy(w, req.Booking_UID).Status, 'Requested'); assert.strictEqual(outTo(w, w.since(mk)).length, 0); });
    r.check('Run_Log says why, as a FAILURE staff must see: "double booking prevented ... already taken by cal-demo-0001"', () => { const l = w.since(mk).log.find((q) => q.Workflow === 'REQ-request-confirm'); assert.deepStrictEqual([l.Outcome, /double booking prevented.*cal-demo-0001/.test(l.Error)], ['failed', true]); });
    w.advance(3);
  });

  step('C4', '10. The team declines a request: the patient is told, once', (w, r) => {
    r.say('patient', `${C.isha}: Book me for Saturday at 3.`);
    const mk0 = w.mark(); const x0 = w.say({ from: C.isha, text: 'Book me for Saturday at 3.' }); r.rows(w, mk0, x0);
    const req = reqOf(w, C.isha);
    r.say('staff', 'declines it (Requests > Decline) = Status -> Declined');
    w.staffSetStatus(req.id, 'Declined'); w.advance(2);
    const mk = w.mark(); const x = w.tick('REQ – Every 2 minutes'); r.rows(w, mk, x);
    r.check('the patient is told we could not confirm (SIMULATED) and to suggest another time; the lead is not marked Booked', () => { const o = outTo(w, w.since(mk)); assert.strictEqual(o.length, 1); assert(/could not confirm your request/.test(o[0].Body)); assert.notStrictEqual(leadOf(w, C.isha).Status, 'Booked'); });
    r.check('the row is Declined with Confirm_Sent set (the patient is told once); it is not a booking', () => { const q = apptBy(w, req.Booking_UID); assert.deepStrictEqual([q.Status, typeof q.Confirm_Sent], ['Declined', 'number']); });
    w.advance(3);
  });

  step('D1', '11. Hand-off: a medical question goes to a person, and the person replies', (w, r) => {
    r.say('patient', `${C.meera}: ${SCRIPT.medical}`);
    const mk = w.mark(); const x = w.say({ from: C.meera, text: SCRIPT.medical }); r.rows(w, mk, x);
    r.check('handed to a person: AI_Status handed_off, the conversation is flagged Needs_Human with a reason', () => { const c = convOf(w, C.meera); assert.strictEqual(c.Needs_Human, true); assert(c.Handoff_Reason); assert.strictEqual(w.since(mk).messages.find((m) => m.Direction === 'In').AI_Status, 'handed_off'); });
    r.check('the patient gets only the holding reply (SIMULATED) - no medical advice is given', () => { const o = outTo(w, w.since(mk)); assert.strictEqual(o.length, 1); assert(/team will reply to you shortly/.test(o[0].Body)); });
    w.advance(4);
    r.say('staff', 'writes a reply in the FLOW HQ inbox = a Messages row with Send ticked; W10 picks it up and sends it through W12');
    w.staffReply(convOf(w, C.meera).id, 'Hello, this is the front desk. Please do not exercise on it yet; we will see you for an assessment.');
    const mk2 = w.mark(); const y = w.tick('W10 – Every minute'); r.rows(w, mk2, y);
    r.check('W10 handled it through W12 in simulate mode: the staff row is marked "DEMO simulated, nothing was sent" (not "sent"), Run_Log ok', () => {
      const row = w.rows('Messages').find((m) => m.Sent_By === 'Reception'); assert.deepStrictEqual([row.Status, row.AI_Reason, row.Send], ['queued', 'DEMO simulated, nothing was sent', false]);
      assert(w.since(mk2).log.some((l) => l.Workflow === 'W10-staff-reply' && l.Outcome === 'ok'));
    });
    const mk3 = w.mark(); w.advance(1); const again = w.tick('W10 – Every minute');
    r.check('the staff reply is not repeated by the next minute\'s run (nothing is written)', () => assert.deepStrictEqual([w.since(mk3).writes.length, again.errors.length], [0, 0]));
    w.advance(3);
  });

  step('D2', '12. Emergency words: the owner is alerted, the model is not asked', (w, r) => {
    r.say('patient', `${C.dev}: ${SCRIPT.emergency}`);
    const mk = w.mark(); const x = w.say({ from: C.dev, text: SCRIPT.emergency }); r.rows(w, mk, x);
    r.check('flagged URGENT for a person; the model was NOT asked; no advice is given', () => {
      const c = convOf(w, C.dev); assert.strictEqual(c.Needs_Human, true); assert(/emergency/i.test(c.Handoff_Reason)); assert.strictEqual(w.since(mk).ollama, 0);
    });
    r.check('two simulated sends: the holding reply to the patient and the alert to the OWNER (both nothing-sent)', () => assert.strictEqual(x.visited.filter((n) => n === 'W12 – Simulated send').length, 2));
    w.advance(3);
  });

  step('E1', '13. Opt-out: STOP means no more messages, from anything', (w, r) => {
    r.say('patient', `${C.isha}: ${SCRIPT.stop}`);
    const mk = w.mark(); const x = w.say({ from: C.isha, text: SCRIPT.stop }); r.rows(w, mk, x);
    r.check('the lead is Opted_Out; AI_Status opted_out; no reply of any kind', () => { assert.strictEqual(leadOf(w, C.isha).Opted_Out, true); assert.strictEqual(outTo(w, w.since(mk)).length, 0); assert.strictEqual(w.since(mk).messages.find((m) => m.Direction === 'In').AI_Status, 'opted_out'); });
    w.advance(120);
    r.say('phone', `two hours later ${C.isha} calls and nobody answers`);
    const mk2 = w.mark(); const y = w.missedCall({ caller: C.isha, id: 'demo-call-0002' }); r.rows(w, mk2, y);
    r.check('the call is recorded and the team alerted (simulated), but NO call-back message is made for an opted-out caller', () => {
      const e = w.since(mk2).messages.find((m) => m.Template === 'missed_call'); assert.strictEqual(e.AI_Action, 'mcc:ack_skipped'); assert.strictEqual(outTo(w, w.since(mk2), 'missed_call_ack').length, 0);
    });
    w.advance(3);
  });

  step('F1', '14. The local model is down: routine questions still get answered, everything else goes to a person', (w, r) => {
    w.ollamaDown = true;
    r.say('system', 'Ollama stops answering (connection refused)');
    r.say('patient', `${C.kavya}: ${SCRIPT.hi.pricing}`);
    const mk = w.mark(); const x = w.say({ from: C.kavya, text: SCRIPT.hi.pricing }); r.rows(w, mk, x);
    r.check('ONE failed model call (no retry storm), then the deterministic FAQ fallback answers from the knowledge base (₹500), flagged as fallback', () => {
      const d = w.since(mk); assert.strictEqual(d.ollama, 1); const o = outTo(w, d); assert.strictEqual(o.length, 1); assert(/₹500/.test(o[0].Body));
      assert(/fallback/.test(d.log.find((l) => l.Workflow === 'W13-ai-receptionist').Error));
    });
    w.advance(3);
    r.say('patient', `${C.kavya}: ${SCRIPT.hi.book}`);
    const mk2 = w.mark(); const y = w.say({ from: C.kavya, text: SCRIPT.hi.book }); r.rows(w, mk2, y);
    r.check('a booking request is NOT answered by the fallback: it goes to a person, and no appointment row is made', () => { assert.strictEqual(convOf(w, C.kavya).Needs_Human, true); assert(!w.rows('Appointments').some((a) => a.Lead === leadOf(w, C.kavya).id)); });
    w.advance(3);
    r.say('patient', `${C.kavya}: ${SCRIPT.emergency}`);
    const mk3 = w.mark(); const z = w.say({ from: C.kavya, text: SCRIPT.emergency }); r.rows(w, mk3, z);
    r.check('an emergency is still handled without the model', () => { assert.strictEqual(w.since(mk3).ollama, 0); assert(/emergency/i.test(convOf(w, C.kavya).Handoff_Reason)); });
    w.ollamaDown = false;
  });

  step('G1', '15. Nothing was ever sent, and nothing the AI did is a booking', (w, r) => {
    r.check('Meta was never called; OpenRouter (a paid AI) was never called', () => assert.deepStrictEqual([w.metaCalls.length, w.openrouterCalls.length], [0, 0]));
    r.check('every message the system made is labelled "[DEMO simulated, not sent]" and carries a sim- id; the staff reply says DEMO simulated', () => {
      const outs = w.rows('Messages').filter((m) => m.Direction === 'Out' && m.Sent_By !== 'Reception');
      assert(outs.length >= 10); for (const m of outs) { assert(/^\[DEMO simulated, not sent\]/.test(m.Body), m.Body); assert(SIM_ID.test(m.WA_Message_ID)); assert(!['sent', 'delivered', 'read'].includes(m.Status)); }
    });
    r.check('the AI created only requests (req-...); no appointment was booked without a person', () => { const ai = w.rows('Appointments').filter((a) => /^req-/.test(a.Booking_UID)); assert(ai.length >= 3); assert(ai.every((a) => ['Requested', 'Booked', 'Declined'].includes(a.Status))); assert(!w.rows('Appointments').some((a) => /^wa-/.test(a.Booking_UID))); });
    r.check('the only FAILED rows in Run_Log are the refused double booking', () => { const f = w.rows('Run_Log').filter((l) => l.Outcome === 'failed'); assert.strictEqual(f.length, 1); assert(/double booking prevented/.test(f[0].Error)); });
    r.check('no workflow execution errored (bar the refused unknown number in step 3)', () => assert.deepStrictEqual(w.errors, []));
  });

  step('H1', '16. Night: quiet hours (21:00-08:00 IST) are respected - a separate clinic run with the quiet-hours test switch OFF', (w0, r) => {
    const night = Date.parse('2026-10-06T23:00:00+05:30');
    const w = new World({ file: w0.opts.file, nightWorks: false, now: night });
    r.say('phone', `at 23:00 ${C.meera} misses a call`);
    const mk = w.mark(); const x = w.missedCall({ caller: C.meera, id: 'night-call-1' }); r.rows(w, mk, x);
    r.check('the call is recorded; the call-back AND the team alert are DEFERRED to the morning (nothing is made at night, nothing is lost)', () => {
      const e = w.since(mk).messages.find((m) => m.Template === 'missed_call'); assert.strictEqual(e.AI_Action, 'mcc:ack_deferred'); assert(/quiet hours; alert deferred/.test(e.AI_Reason)); assert.strictEqual(outTo(w, w.since(mk), 'missed_call_ack').length, 0);
    });
    w.now = Date.parse('2026-10-07T08:10:00+05:30');
    r.say('system', 'next morning 08:10 - the 5-minute retry run');
    const mk2 = w.mark(); const y = w.tick('MCC – Every 5 minutes'); r.rows(w, mk2, y);
    r.check('the deferred acknowledgement and alert go out (SIMULATED) once, and the event is closed', () => { assert.strictEqual(outTo(w, w.since(mk2), 'missed_call_ack').length, 1); assert(/^attempt 2: DEMO simulated, nothing was sent; alert simulated$/.test(w.rows('Messages').find((m) => m.Template === 'missed_call').AI_Reason)); });
    w.now = Date.parse('2026-10-07T23:30:00+05:30');
    r.say('patient', `at 23:30 ${C.dev}: ${SCRIPT.emergency}`);
    const mk3 = w.mark(); const z = w.say({ from: C.dev, text: SCRIPT.emergency }); r.rows(w, mk3, z);
    r.check('an emergency at night alerts the OWNER at once; the patient is not messaged at night', () => { assert.strictEqual(z.visited.filter((n) => n === 'W12 – Simulated send').length, 1); assert.strictEqual(outTo(w, w.since(mk3)).filter((m) => /not sent/.test(m.Body) && m.Template !== 'human_handoff_alert').length, 0); assert.strictEqual(convOf(w, C.dev).Needs_Human, true); });
  });
  return steps;
}

// Runs every step against a fresh world. recorder: { title(step), say(who, text), rows(lines), note(text), check(desc, ok, why) } - all optional.
function runScenario(rec = {}, o = {}) {
  const results = [];
  const w = new World(o);
  for (const s of buildSteps()) {
    const out = { id: s.id, title: s.title, checks: [], error: null };
    if (rec.title) rec.title(s);
    const r = {
      say: (who, text) => rec.say && rec.say(who, text),
      note: (t) => rec.note && rec.note(t),
      rows: (world, mk, x) => { if (rec.rows) rec.rows(describe(world, world.since(mk)), x); },
      check: (desc, fn) => {
        try { fn(); out.checks.push({ desc, ok: true }); if (rec.check) rec.check(desc, true); } catch (e) { out.checks.push({ desc, ok: false, why: e.message.split('\n')[0] }); if (rec.check) rec.check(desc, false, e.message.split('\n')[0]); }
      },
    };
    try { s.fn(w, r); } catch (e) { out.error = e.message.split('\n')[0]; if (rec.check) rec.check(`step crashed: ${out.error}`, false, out.error); }
    results.push(out);
  }
  return { results, world: w };
}

module.exports = { buildSteps, runScenario, describe };
