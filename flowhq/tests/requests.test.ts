// Appointment REQUESTS and the missed-call / demo events in FLOW HQ: a request is never a booking, never counted or reported as confirmed;
// confirm / decline use the workflow's own conflict rule; simulated messages are never shown as sent; no secrets reach the browser.
// All data below is synthetic (invented names, 90000000xx numbers).
import { describe, expect, it } from 'vitest';
import { memoryGrist, BackendError, type GristRecord } from '../src/server/grist';
import { createAutopilotAdapter } from '../src/server/adapters/autopilot';
import { COLUMNS, TABLES } from '../src/server/adapters/autopilot/schema';
import { requestConfirm } from '../src/server/adapters/autopilot/shared';
import type { Ctx } from '../src/server/adapters/types';

const NOW = Date.UTC(2026, 9, 7, 6, 30);            // Wed 7 Oct 2026, 12:00 IST
const NOW_SEC = Math.floor(NOW / 1000);
const T = (hours: number) => NOW_SEC + Math.round(hours * 3600);
const admin: Ctx = { viewer: { email: 'alex@test', name: 'Alex', role: 'admin' }, now: NOW };
const staff: Ctx = { viewer: { email: 'sam@test', name: 'Sam', role: 'staff' }, now: NOW };
const columns = { [TABLES.leads]: COLUMNS.leads, [TABLES.appointments]: COLUMNS.appointments, [TABLES.conversations]: COLUMNS.conversations, [TABLES.messages]: COLUMNS.messages, [TABLES.runLog]: COLUMNS.runLog, [TABLES.knowledge]: COLUMNS.knowledge, [TABLES.settings]: ['Key', 'Value'] };
const rec = (id: number, fields: Record<string, unknown>): GristRecord => ({ id, fields: fields as GristRecord['fields'] });

// Request rows (ids 2, 3, 4, 5, 7, 10, 11) and their control: the same clinic with every request / odd row removed.
const REQUEST_IDS = [2, 3, 4, 5, 7, 10, 11];
function appointments(): GristRecord[] {
  return [
    rec(1, { Booking_UID: 'cal-1', Lead: 1, Service: 'Assessment', Physio: 'Dr Rao', Start: T(26), End: T(26.75), Status: 'Booked' }),
    rec(2, { Booking_UID: 'req-A', Lead: 2, Service: 'Assessment', Start: T(30), End: T(30.5), Status: 'Requested', Requested_At: T(-1) }),
    rec(3, { Booking_UID: 'req-B', Lead: 3, Service: 'Assessment', Start: T(26.25), End: T(26.75), Status: 'Requested', Requested_At: T(-2) }),   // overlaps cal-1
    rec(4, { Booking_UID: 'req-C', Lead: 2, Service: 'Assessment', Start: T(50), End: T(50.5), Status: 'Declined', Requested_At: T(-5), Confirm_Sent: T(-3) }),
    rec(5, { Booking_UID: 'odd-5', Lead: 1, Service: 'Assessment', Start: T(40), End: T(40.5), Status: 'Weird' }),
    rec(6, { Booking_UID: 'cal-6', Lead: 2, Service: 'Assessment', Physio: 'Dr Rao', Start: T(-30), End: T(-29.5), Status: 'Completed' }),
    rec(7, { Booking_UID: 'req-D', Lead: 3, Service: 'Assessment', Start: T(-10), End: T(-9.5), Status: 'Requested', Requested_At: T(-40) }),   // the time has passed
    rec(8, { Booking_UID: 'req-E', Lead: 1, Service: 'Assessment', Start: T(60), End: T(60.5), Status: 'Booked', Requested_At: T(-9), Confirm_Sent: T(-1) }),   // confirmed, contact told
    rec(9, { Booking_UID: 'cal-9', Lead: 3, Service: 'Assessment', Physio: 'Dr Rao', Start: T(-3), End: T(-2.5), Status: 'Booked' }),   // past, outcome not marked
    rec(10, { Booking_UID: 'req-F', Lead: 1, Service: 'Assessment', Start: T(-20), End: T(-19.5), Status: 'Declined', Requested_At: T(-50), Confirm_Sent: T(-45) }),
    rec(11, { Booking_UID: 'req-G', Lead: 3, Service: 'Assessment', Start: T(30), End: T(30.5), Status: 'Requested', Requested_At: T(-0.5) }),   // same time as req-A
  ];
}
function docFor(opts: { settings?: Record<string, string>; control?: boolean } = {}) {
  const settings = { clinic_name: 'Demo Physio', booking_mode: 'request', demo_mode: 'on', missed_call_enabled: 'on', ai_mode: 'auto', TEST_MODE: 'true', ...opts.settings };
  const lead = (id: number, name: string, phone: string) => rec(id, { Lead_id: `L-${id}`, Created_At: T(-100 - id), Name: name, Phone: phone, Source: id === 1 ? 'Call' : 'WhatsApp', Status: 'New', Opted_Out: false });
  return {
    REGISTRY: { Clinics: [rec(1, { Clinic_Slug: 'demo-req', Clinic_Name: 'Demo Physio', Grist_Doc_ID: 'DEMO_REQ', WA_Phone_Number_ID: '', Active: true })] },
    DEMO_REQ: {
      Settings: Object.entries(settings).map(([Key, Value], i) => rec(i + 1, { Key, Value })),
      LEADS: [lead(1, 'Asha Demo', '+919000000101'), lead(2, 'Ravi Demo', '+919000000102'), lead(3, 'Meera Demo', '+919000000103')],
      Appointments: appointments().filter((a) => !opts.control || !(REQUEST_IDS.includes(a.id))),
      Conversations: [1, 2, 3].map((i) => rec(i, { Lead: i, Phone: `+91900000010${i}`, Last_Inbound_At: T(-2), Unread: 0, Automation_Paused: false, Needs_Human: false })),
      Messages: [
        rec(1, { Conversation: 1, Direction: 'In', Body: '[DEMO] Missed call (missed) to +919000000019', Template: 'missed_call', Sent_By: 'Phone', WA_Message_ID: 'call-demo-0001', Status: 'Received', AI_Action: 'mcc:ack_simulated', AI_Reason: 'attempt 1: DEMO simulated, nothing was sent; alert simulated', Created_At: T(-3) }),
        rec(2, { Conversation: 1, Direction: 'Out', Body: '[DEMO simulated, not sent] Namaste! Sorry, we missed your call to Demo Physio. Reply here and we will help.', Template: 'missed_call_ack', Sent_By: 'W12-missed-call-ack [DEMO simulated: nothing was sent; would go to +919000000999]', WA_Message_ID: 'sim-1', Status: 'queued', Send: false, Created_At: T(-3) + 5 }),
        rec(3, { Conversation: 2, Direction: 'In', Body: 'Can I come on Thursday at 4?', Sent_By: 'Patient', WA_Message_ID: 'wamid.demo.1', Status: 'Received', Intent: 'booking', AI_Action: 'book_slot', AI_Confidence: 0.9, AI_Status: 'replied', Created_At: T(-1) }),
        rec(4, { Conversation: 2, Direction: 'Out', Body: 'We have noted your request. It is NOT confirmed yet.', Sent_By: 'W13-ai-receptionist', WA_Message_ID: 'wamid.demo.out.1', Status: 'sent', Created_At: T(-1) + 10 }),
        rec(5, { Conversation: 2, Direction: 'Out', Body: 'Hello, this is the front desk.', Sent_By: 'Reception', WA_Message_ID: '', Status: 'queued', Send: false, AI_Reason: 'DEMO simulated, nothing was sent', Created_At: T(-0.5) }),
      ],
      Run_Log: [rec(1, { Workflow: 'MCC-missed-call-capture', Record: '[DEMO] call-demo-0001 L-1: ack simulated; staff alert simulated', Outcome: 'ok', At: T(-3) })],
      Knowledge: [rec(1, { Title: 'Hours', Category: 'hours', Content: 'Open 9 to 7.', Active: true })],
    },
  };
}
function setup(opts: Parameters<typeof docFor>[0] = {}) {
  const docs = docFor(opts);
  const mem = memoryGrist(docs, { columns });
  const adapter = createAutopilotAdapter({ gristBaseUrl: 'http://memory', gristApiKey: 'test-grist-key-0123456789abcdef', registryDocId: 'REGISTRY', timezone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR', fetchImpl: mem, cacheMs: 0 });
  return { docs, rows: docs.DEMO_REQ, mem, ws: () => adapter.workspace('demo-req').then((w) => w!) };
}
const rejects = async (p: Promise<unknown>, status: number, code?: string) => {
  const e = await p.then(() => null, (x) => x);
  expect(e).toBeInstanceOf(BackendError);
  expect((e as BackendError).status).toBe(status);
  if (code) expect((e as BackendError).code).toBe(code);
};
const statusOf = (rows: ReturnType<typeof docFor>['DEMO_REQ'], id: number) => rows.Appointments.find((a) => a.id === id)!.fields.Status;

describe('capabilities and labels', () => {
  it('requests are supported; the demo label follows the demo_mode setting only', async () => {
    const on = await (await setup().ws()).capabilities(admin.viewer);
    expect(on.bookingRequests).toBe(true);
    expect(on.demoMode).toBe(true);
    expect(on.bookingStatusUpdate).toEqual(['completed', 'no_show']);
    expect((await (await setup({ settings: { demo_mode: 'off' } }).ws()).capabilities(admin.viewer)).demoMode).toBe(false);
    expect((await (await setup({ settings: { demo_mode: '' } }).ws()).capabilities(admin.viewer)).demoMode).toBe(false);
  });
});

describe('a request is not a booking', () => {
  it('every row maps to its real status; an unknown status is never read as scheduled', async () => {
    const w = await setup().ws();
    const b = [...(await w.bookings({ view: 'all' }, admin)), ...(await w.bookings({ view: 'requests' }, admin))];
    const by = (ref: string) => b.find((x) => x.ref === ref)!;
    expect(by('cal-1').status).toBe('scheduled');
    expect(by('req-A').status).toBe('requested');
    expect(by('req-C').status).toBe('declined');
    expect(by('odd-5').status).toBe('unknown');
    expect(by('req-E').status).toBe('scheduled');
  });
  it('requests never appear in upcoming, past, needs-outcome or all; they have their own view, waiting ones first', async () => {
    const w = await setup().ws();
    for (const view of ['upcoming', 'past', 'needs_outcome', 'all'] as const) {
      const refs = (await w.bookings({ view }, admin)).map((x) => x.ref);
      for (const r of ['req-A', 'req-B', 'req-C', 'req-D', 'req-F', 'req-G']) expect(refs, `${view} ${r}`).not.toContain(r);
    }
    expect((await w.bookings({ view: 'upcoming' }, admin)).map((x) => x.ref)).toEqual(['cal-9', 'cal-1', 'req-E']);   // (today and later) the unknown row is not upcoming either
    expect((await w.bookings({ view: 'all' }, admin)).map((x) => x.ref)).toContain('odd-5');                 // ... but nothing is silently hidden
    expect((await w.bookings({ view: 'needs_outcome' }, admin)).map((x) => x.ref)).toEqual(['cal-9']);       // a past request needs no outcome
    const reqs = await w.bookings({ view: 'requests' }, admin);
    expect(reqs.slice(0, 4).map((x) => x.status)).toEqual(['requested', 'requested', 'requested', 'requested']);
    expect(reqs.map((x) => x.ref).sort()).toEqual(['req-A', 'req-B', 'req-C', 'req-D', 'req-E', 'req-F', 'req-G']);
    expect(reqs.find((x) => x.ref === 'req-A')!.requestedAt).not.toBeNull();
    expect(reqs.find((x) => x.ref === 'req-E')).toMatchObject({ status: 'scheduled', announced: true });
  });
  it('request rows show no reminder / review chips and no fee', async () => {
    const rows = docFor();
    rows.DEMO_REQ.Appointments.find((a) => a.id === 2)!.fields.R24_Sent = T(-1);
    rows.DEMO_REQ.Appointments.find((a) => a.id === 2)!.fields.Fee_INR = 900;
    const mem = memoryGrist(rows, { columns });
    const w = (await createAutopilotAdapter({ gristBaseUrl: 'http://memory', gristApiKey: 'k', registryDocId: 'REGISTRY', timezone: 'Asia/Kolkata', locale: 'en-IN', currency: 'INR', fetchImpl: mem, cacheMs: 0 }).workspace('demo-req'))!;
    const a = (await w.bookings({ view: 'requests' }, admin)).find((x) => x.ref === 'req-A')!;
    expect(a.automationsDone).toEqual([]);
    expect(a.value).toBeNull();
  });
  it('dashboard and series count real appointments only: the numbers equal a clinic without any request', async () => {
    const withReq = await (await setup().ws()).dashboard(7, admin);
    const control = await (await setup({ control: true }).ws()).dashboard(7, admin);
    const bookings = (d: typeof withReq) => d.metrics.find((m) => m.key === 'bookings')!;
    expect(bookings(withReq).value).toBe(2);                                // cal-6 and cal-9; req-D (past, requested), req-F (past, declined) are not counted
    expect(bookings(withReq)).toEqual(bookings(control));
    expect(withReq.series.find((s) => s.key === 'bookings')!.points.reduce((t, p) => t + p.value, 0)).toBe(2);
    expect(withReq.upcoming.map((x) => x.ref)).toEqual(['cal-9', 'cal-1', 'req-E']);
  });
  it('the weekly numbers do not count a request or a declined request (equal to the clinic without them)', async () => {
    const a = await (await setup().ws()).analytics('this', admin);
    const c = await (await setup({ control: true }).ws()).analytics('this', admin);
    const v = (x: typeof a, k: string) => x.metrics.find((m) => m.key === k)!.value;
    expect(v(a, 'bookings_week')).toBe(4);                                   // cal-1, cal-6, req-E (confirmed), cal-9
    for (const k of ['bookings_week', 'completed', 'no_show', 'cancelled', 'rescheduled', 'still_booked', 'booked_ahead']) expect(v(a, k), k).toBe(v(c, k));
  });
  it('a request waiting for a person is a task (confirm or decline); a past, declined or confirmed one is not; outcome tasks are unchanged', async () => {
    const t = await (await setup().ws()).tasks(admin);
    const req = t.filter((x) => x.kind === 'booking_request');
    expect(req.map((x) => x.id).sort()).toEqual(['request-11', 'request-2', 'request-3']);
    expect(req.every((x) => x.priority === 'high' && x.bookingId)).toBe(true);
    expect(t.filter((x) => x.kind === 'booking_outcome').map((x) => x.id)).toEqual(['outcome-9']);
  });
});

describe('confirm and decline (the workflow rule, staff or admin)', () => {
  it('confirming a free time sets Booked and writes nothing else: the automation tells the contact', async () => {
    const s = setup();
    const w = await s.ws();
    const before = JSON.stringify({ ...s.rows, Appointments: undefined });
    const r = await w.updateBooking('2', 'scheduled', staff);
    expect(r).toMatchObject({ status: 'scheduled', announced: false });
    expect(statusOf(s.rows, 2)).toBe('Booked');
    expect(JSON.stringify({ ...s.rows, Appointments: undefined })).toBe(before);            // no message, no log, no setting
    expect(s.mem.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.table}`)).toEqual(['PATCH Appointments']);
    expect(s.rows.Appointments.find((a) => a.id === 2)!.fields.Confirm_Sent).toBeUndefined();   // only REQ sets it, after the patient is told
  });
  it('a time another appointment holds cannot be confirmed (409 slot_taken) and the row stays Requested', async () => {
    const s = setup();
    await rejects((await s.ws()).updateBooking('3', 'scheduled', admin), 409, 'slot_taken');
    expect(statusOf(s.rows, 3)).toBe('Requested');
  });
  it('capacity 2 allows the second patient at the same time; capacity 1 does not', async () => {
    const two = setup({ settings: { booking_capacity: '2' } });
    expect((await (await two.ws()).updateBooking('3', 'scheduled', admin)).status).toBe('scheduled');
    const junk = setup({ settings: { booking_capacity: '99' } });                            // out of range -> 1, like the workflow
    await rejects((await junk.ws()).updateBooking('3', 'scheduled', admin), 409, 'slot_taken');
  });
  it('two requests for one time: the second confirmation is refused, in either order the lowest row id keeps the slot (as REQ decides)', async () => {
    const a = setup();
    const wa = await a.ws();
    await wa.updateBooking('2', 'scheduled', admin);
    await rejects(wa.updateBooking('11', 'scheduled', admin), 409, 'slot_taken');
    // other order: 11 first is allowed (2 is still only a request) ...
    const b = setup();
    const wb = await b.ws();
    await wb.updateBooking('11', 'scheduled', admin);
    await wb.updateBooking('2', 'scheduled', admin);                                         // ... and 2 is allowed because the LOWER id wins
    const plan = requestConfirm.reqcPlan(b.rows.Appointments as never, b.rows.LEADS as never, b.rows.Conversations as never, { booking_capacity: '1' }, NOW, {});
    expect(plan.items.filter((i) => [2, 11].includes(i.appt_row_id)).map((i) => [i.appt_row_id, i.kind])).toEqual([[2, 'confirmed'], [11, 'conflict']]);
  });
  it('FLOW HQ and the workflow agree on every request in the data set', async () => {
    for (const id of [2, 3, 11]) {
      const s = setup();
      const w = await s.ws();
      const verdict = await w.updateBooking(String(id), 'scheduled', admin).then(() => 'confirmed', (e: BackendError) => (e.code === 'slot_taken' ? 'conflict' : e.code));
      const again = setup();
      again.rows.Appointments.find((a) => a.id === id)!.fields.Status = 'Booked';           // what staff would have set in Grist
      const plan = requestConfirm.reqcPlan(again.rows.Appointments as never, again.rows.LEADS as never, again.rows.Conversations as never, { booking_capacity: '1' }, NOW, {});
      expect(plan.items.find((i) => i.appt_row_id === id)!.kind, `request ${id}`).toBe(verdict);
    }
  });
  it('only a waiting request can be decided: not a booking, not a decided or an old request; the past is refused', async () => {
    const w = await setup().ws();
    await rejects(w.updateBooking('1', 'scheduled', admin), 409, 'not_a_request');         // a calendar booking
    await rejects(w.updateBooking('1', 'declined', admin), 409, 'not_a_request');
    await rejects(w.updateBooking('4', 'scheduled', admin), 409, 'not_a_request');         // already declined
    await rejects(w.updateBooking('8', 'declined', admin), 409, 'not_a_request');          // already confirmed
    await rejects(w.updateBooking('5', 'scheduled', admin), 409, 'not_a_request');         // unknown status, not a request
    await rejects(w.updateBooking('7', 'scheduled', admin), 409, 'passed');
    await rejects(w.updateBooking('999', 'scheduled', admin), 404);
    expect((await w.updateBooking('7', 'declined', admin)).status).toBe('declined');        // a past request can still be declined
  });
  it('declining sets Declined once; deciding twice is refused', async () => {
    const s = setup();
    const w = await s.ws();
    expect((await w.updateBooking('2', 'declined', staff)).status).toBe('declined');
    expect(statusOf(s.rows, 2)).toBe('Declined');
    await rejects(w.updateBooking('2', 'declined', staff), 409, 'not_a_request');
    await rejects(w.updateBooking('2', 'scheduled', staff), 409, 'not_a_request');
  });
  it('completed / no-show still work only on a past scheduled booking', async () => {
    const w = await setup().ws();
    expect((await w.updateBooking('9', 'no_show', admin)).status).toBe('no_show');
    await rejects(w.updateBooking('2', 'completed', admin), 409, 'not_scheduled');          // a request cannot be "completed"
    await rejects(w.updateBooking('1', 'cancelled', admin), 400);
  });
});

describe('missed calls and simulated messages', () => {
  it('a missed call is an event, not a message; its note says what became of the call-back; a simulated message is never "sent"', async () => {
    const r = (await (await setup().ws()).conversation('1', admin))!;
    const [call, ack] = r.messages;
    expect(call).toMatchObject({ direction: 'in', event: 'missed_call', status: 'received', template: null, ai: null, statusNote: 'Call-back message: demo, nothing was sent' });
    expect(call.author).toMatchObject({ kind: 'system', automationKey: 'missed_call_capture' });
    expect(ack).toMatchObject({ direction: 'out', status: 'simulated', statusNote: 'Demo: nothing was sent' });
    expect(ack.author).toMatchObject({ kind: 'automation', automationKey: 'missed_call_capture' });
    expect(ack.body.startsWith('[DEMO simulated')).toBe(false);                              // the badge says it; the text stays clean
    expect(JSON.stringify(r)).not.toMatch(/would go to|\+919000000999/);                     // the number a demo message "would" go to stays server-side
  });
  it('a team reply that went through the simulated gateway is "simulated" too (W10 marks the row), not queued or sent', async () => {
    const r = (await (await setup().ws()).conversation('2', admin))!;
    const staffRow = r.messages.find((m) => m.body === 'Hello, this is the front desk.')!;
    expect(staffRow).toMatchObject({ status: 'simulated', statusNote: 'Demo: nothing was sent' });
    expect(staffRow.author).toMatchObject({ kind: 'staff', name: 'Reception' });
    expect(r.messages.find((m) => m.body.startsWith('We have noted'))!.status).toBe('sent');   // a real, accepted message stays "sent"
  });
  it('activity: the call, the intended acknowledgement (as such), the request and its outcomes; nothing simulated is listed as sent or as an AI reply', async () => {
    const a = await (await setup().ws()).activity({ limit: 100 }, admin);
    const kinds = (id: string) => a.filter((x) => x.id === id).map((x) => x.kind);
    expect(kinds('call-1')).toEqual(['missed_call']);
    expect(kinds('msg-2')).toEqual(['message_simulated']);
    expect(kinds('msg-1')).toEqual([]);                                                       // the call is not a "message received"
    expect(kinds('req-2')).toEqual(['booking_requested']);
    expect(kinds('req-ok-8')).toEqual(['request_confirmed']);
    expect(kinds('req-no-4')).toEqual(['request_declined']);
    expect(kinds('req-3')).toEqual(['booking_requested']);
    expect(a.some((x) => x.id === 'req-ok-2' || x.id === 'req-no-2')).toBe(false);          // nobody has been told about a request that is still waiting
    expect(a.filter((x) => x.kind === 'booking_created').length).toBe(0);                    // a request is not a created booking
    expect(a.find((x) => x.id === 'call-1')!.detail).toMatch(/demo, nothing was sent/);
  });
  it('a contact page lists its requests with their true status and activity', async () => {
    const c = (await (await setup().ws()).contact('3', admin))!;
    expect(c.bookings.filter((b) => b.status === 'requested').map((b) => b.ref).sort()).toEqual(['req-B', 'req-D', 'req-G']);
    expect(c.activity.some((x) => x.kind === 'booking_requested')).toBe(true);
  });
});

describe('automations and settings', () => {
  it('Request Confirmation is off unless the assistant runs in request mode; Missed Calls follows its switch', async () => {
    const find = async (settings: Record<string, string>, key: string) => (await (await setup({ settings }).ws()).automations(admin)).find((a) => a.key === key)!;
    expect((await find({ booking_mode: 'request' }, 'request_confirmation')).status).toBe('always_on');
    const off = await find({ booking_mode: 'link' }, 'request_confirmation');
    expect(off.status).toBe('off');
    expect(off.requirements).toEqual([{ label: 'Booking by the assistant is set to Request', ok: false }]);
    expect((await find({ missed_call_enabled: 'on' }, 'missed_call_capture'))).toMatchObject({ status: 'active', control: { kind: 'toggle', value: 'on' } });
    expect((await find({ missed_call_enabled: 'off' }, 'missed_call_capture')).status).toBe('off');
  });
  it('an admin can choose request mode and set the demo label; a bad value is refused', async () => {
    const w = await setup({ settings: { booking_mode: 'link', demo_mode: 'off' } }).ws();
    const v = await w.updateSettings({ booking_mode: 'request', demo_mode: 'on', request_hold_hours: '12', max_pending_requests: '3' }, admin);
    expect(v.fields.find((f) => f.key === 'booking_mode')!.value).toBe('request');
    expect(v.fields.find((f) => f.key === 'demo_mode')!.value).toBe('on');
    expect((await w.capabilities(admin.viewer)).demoMode).toBe(true);
    await rejects(w.updateSettings({ booking_mode: 'autopilot' }, admin), 400);
    await rejects(w.updateSettings({ booking_mode: 'request' }, staff), 403);
  });
});
