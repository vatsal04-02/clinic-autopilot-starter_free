// DEMO DATA (made up: names, numbers and messages are fictional; phone numbers are in the +91 90000 test range).
// Three businesses on the SAME backend schema as the real Clinic Autopilot CRM, so demo mode runs the real adapter end to end:
// the only difference between them is the FLOW HQ industry profile. The weekly report rows are produced by the workflow's own
// W9 code (cmWeeklyMetrics + cmRenderReport), not written by hand.
import type { GristRecord } from '../grist';
import type { WorkspaceProfile } from '../profiles';
import { clinicModules } from '../adapters/autopilot/shared';

interface Flavor {
  slug: string; name: string; doc: string; profile: WorkspaceProfile;
  services: string[]; staff: string[]; fee: [number, number];
  questions: Array<[string, string, string, number]>;   // [patient text, intent, AI reply, confidence]
  handoffs: Array<[string, string]>;                     // [text, reason]
  knowledge: Array<[string, string, string]>;            // [title, category, content]
  settings: Record<string, string>;
}
const FLAVORS: Flavor[] = [
  {
    slug: 'demo-physio', name: 'Northside Physio Care', doc: 'DEMO_PHYSIO', profile: { industry: 'physiotherapy' },
    services: ['Knee pain physiotherapy', 'Back pain physiotherapy', 'Sports injury rehab', 'First assessment', 'Post-surgery rehab'],
    staff: ['Dr. Mehta', 'Dr. Rao', 'Dr. Iyer'], fee: [600, 1200],
    questions: [
      ['How much is a first assessment?', 'pricing', 'A first assessment is ₹500 (45 minutes). Would you like to book one?', 0.93],
      ['Do you treat lower back pain?', 'services_info', 'Yes, we treat lower back pain with assessment, manual therapy and a home exercise plan.', 0.91],
      ['Are you open on Saturday?', 'location_hours', 'We are open Monday to Saturday, 9:00 to 19:00.', 0.95],
      ['Can I come tomorrow evening?', 'availability_check', 'Tomorrow we have 17:00 and 18:30 free. Which one suits you?', 0.88],
      ['Thank you!', 'thanks_ack', '', 0.97],
      ['Feeling much better after the session', 'outcome_better', 'So glad to hear you are feeling better! Thank you for letting us know.', 0.9],
    ],
    handoffs: [['My knee is swollen after the session, should I take ibuprofen?', 'HIGH · Medical question after a visit. Suggest: a clinician calls today.'], ['I want a refund for last week', 'HIGH · Payment issue: refund request'], ['Still the same, no change', 'no improvement after the visit']],
    knowledge: [['First assessment', 'pricing', '₹500 per assessment, 45 minutes'], ['Physiotherapy session', 'pricing', '₹800 per session (45 minutes)'], ['Opening hours', 'hours', 'Monday to Saturday, 09:00-19:00'], ['Address', 'location', '12 Lake Road, Indiranagar (2nd floor, lift available)'], ['Cancellation policy', 'policy', 'Free cancellation up to 4 hours before your appointment']],
    settings: { clinic_name: 'Northside Physio Care', open_time: '09:00', close_time: '19:00', working_days: 'Mon-Sat', booking_link: 'https://cal.com/northside-physio/assessment', review_link: 'https://g.page/r/northside-physio-demo/review', ai_mode: 'auto', outcome_checkin: 'on', review_requests: 'on', weekly_report_whatsapp: 'off', owner_phone: '+919000000901', TEST_MODE: 'false', TEST_PHONE: '+919000000999', booking_mode: 'link', slot_minutes: '30', services: 'Assessment, Physiotherapy, Sports rehab, Post-surgery rehab' },
  },
  {
    slug: 'demo-salon', name: 'Studio Lumière', doc: 'DEMO_SALON', profile: { industry: 'salon' },
    services: ['Haircut & styling', 'Hair colour', 'Manicure & pedicure', 'Bridal makeup', 'Hair spa'],
    staff: ['Priya', 'Arjun', 'Meera'], fee: [500, 4500],
    questions: [
      ['How much is a haircut?', 'pricing', 'A haircut and styling is ₹700 with a senior stylist.', 0.94],
      ['Do you do balayage?', 'services_info', 'Yes, our colour specialists do balayage; it takes about 3 hours.', 0.89],
      ['Are you open on Sunday?', 'location_hours', 'We are open every day, 10:00 to 20:00.', 0.95],
      ['Any slot on Friday after 5?', 'availability_check', 'On Friday we have 17:30 and 18:15 free. Shall I hold one?', 0.87],
      ['Loved my new hair, thanks!', 'outcome_better', 'That makes our day! Thank you for letting us know.', 0.92],
    ],
    handoffs: [['The colour came out too dark, not happy', 'HIGH · Complaint about a colour service'], ['Can I get a discount for a bridal package for 6 people?', 'pricing outside the knowledge base: group bridal package']],
    knowledge: [['Haircut & styling', 'pricing', '₹700 with a senior stylist, ₹500 junior'], ['Hair colour', 'pricing', 'From ₹2,500 depending on length'], ['Opening hours', 'hours', 'Every day, 10:00-20:00'], ['Address', 'location', '4 Palm Avenue, Koramangala']],
    settings: { clinic_name: 'Studio Lumière', open_time: '10:00', close_time: '20:00', working_days: 'daily', booking_link: 'https://cal.com/studio-lumiere/book', review_link: 'https://g.page/r/studio-lumiere-demo/review', ai_mode: 'auto', outcome_checkin: 'on', review_requests: 'on', weekly_report_whatsapp: 'on', owner_phone: '+919000000902', TEST_MODE: 'false', TEST_PHONE: '+919000000998', booking_mode: 'link', slot_minutes: '45', services: 'Haircut, Colour, Nails, Bridal, Spa' },
  },
  {
    slug: 'demo-realty', name: 'Harbor Realty', doc: 'DEMO_REALTY', profile: { industry: 'real_estate' },
    services: ['2BHK apartment - Whitefield', '3BHK villa - Sarjapur', 'Plot - Devanahalli', 'Office space - MG Road'],
    staff: ['Karan', 'Neha'], fee: [0, 0],
    questions: [
      ['What is the price of the 2BHK in Whitefield?', 'pricing', 'The 2BHK apartments in Whitefield start at ₹78 lakh (1,150 sq ft).', 0.9],
      ['Is the villa project RERA approved?', 'services_info', 'Yes, the Sarjapur villa project is RERA registered.', 0.88],
      ['Can I visit this Sunday?', 'availability_check', 'Sunday we have site visits at 11:00 and 15:00. Which one works?', 0.86],
      ['Thanks, will think about it', 'follow_up_later', 'Of course. I will check back with you next week.', 0.84],
    ],
    handoffs: [['Can you negotiate the price if I pay in full?', 'payment: price negotiation needs an agent'], ['I need help with a home loan', 'HIGH · Loan assistance request']],
    knowledge: [['2BHK Whitefield', 'pricing', 'From ₹78 lakh, 1,150 sq ft, ready by March'], ['Sarjapur villas', 'services', '3BHK villas, RERA registered, clubhouse'], ['Site visit hours', 'hours', 'Daily 10:00-18:00, by appointment']],
    settings: { clinic_name: 'Harbor Realty', open_time: '10:00', close_time: '18:00', working_days: 'daily', booking_link: 'https://cal.com/harbor-realty/site-visit', ai_mode: 'draft', outcome_checkin: 'off', review_requests: 'off', weekly_report_whatsapp: 'off', owner_phone: '+919000000903', TEST_MODE: 'true', TEST_PHONE: '+919000000997', booking_mode: 'link' },
  },
];
const FIRST = ['Asha', 'Ravi', 'Neha', 'Vikram', 'Divya', 'Arjun', 'Kavya', 'Rahul', 'Sneha', 'Aditya', 'Pooja', 'Karthik', 'Ananya', 'Rohan', 'Isha', 'Manish', 'Lakshmi', 'Siddharth', 'Meghna', 'Varun', 'Nisha', 'Pranav', 'Tara', 'Gaurav', 'Riya', 'Harsh', 'Shreya', 'Nikhil', 'Aarti', 'Dev', 'Kiran', 'Sana', 'Yash', 'Zoya', 'Om', 'Leela', 'Abhay', 'Pia'];
const LAST = ['Patel', 'Kumar', 'Sharma', 'Reddy', 'Nair', 'Iyer', 'Shah', 'Menon', 'Gupta', 'Rao', 'Joshi', 'Das', 'Pillai', 'Verma', 'Bose'];

function rng(seed: number) { let s = seed; return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; }; }

export function demoDocs(nowMs: number) {
  const now = Math.floor(nowMs / 60000) * 60;   // seconds, on the minute
  const H = 3600; const D = 86400;
  const docs: Record<string, Record<string, GristRecord[]>> = {
    REGISTRY: { Clinics: FLAVORS.map((f, i) => ({ id: i + 1, fields: { Clinic_Slug: f.slug, Clinic_Name: f.name, Grist_Doc_ID: f.doc, WA_Phone_Number_ID: `10000000000000${i + 1}`, Active: true } })) },
  };
  FLAVORS.forEach((fl, fi) => {
    const r = rng(42 + fi * 7);
    const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
    const leads: GristRecord[] = []; const convs: GristRecord[] = []; const msgs: GristRecord[] = []; const appts: GristRecord[] = []; const logs: GristRecord[] = [];
    let mid = 0; let aid = 0; let lid = 0;
    const msg = (conv: number, f: Record<string, unknown>) => { if (typeof f.Created_At === 'number' && f.Created_At > now) return; msgs.push({ id: ++mid, fields: { Conversation: conv, Send: false, ...f } as GristRecord['fields'] }); };
    const log = (wf: string, rec: string, at: number, outcome = 'ok', error = '') => at <= now && logs.push({ id: ++lid, fields: { Workflow: wf, Record: rec, Outcome: outcome, Error: error, At: at } });
    const N = 38;
    for (let i = 1; i <= N; i++) {
      const created = now - Math.floor((i / N) * 20 * D + r() * 8 * H);
      const name = `${FIRST[(i * 7 + fi * 3) % FIRST.length]} ${LAST[(i * 5 + fi) % LAST.length]}`;
      const phone = `+9190000${String(fi * 100 + i).padStart(5, '0')}`;
      const src = i % 4 === 0 ? 'Website' : i % 9 === 0 ? 'Instagram' : 'WhatsApp';
      const statusRoll = r();
      const status = i <= 3 ? 'New' : statusRoll < 0.3 ? 'Contacted' : statusRoll < 0.62 ? 'Booked' : statusRoll < 0.82 ? 'Converted' : 'Lost';
      const stage = status === 'Lost' ? 'cold' : status === 'Booked' || status === 'Converted' ? 'hot' : pick(['warm', 'warm', 'hot', 'cold']);
      const svc = pick(fl.services);
      const ref = `L-${new Date(created * 1000).toISOString().slice(0, 10).replace(/-/g, '')}-${String(i).padStart(4, '0')}`;
      leads.push({ id: i, fields: {
        Lead_id: ref, Created_At: created, Name: name, Phone: phone, Source: src, Status: status, Lead_Stage: stage, Likely_Service: svc,
        Enquiry: src === 'Website' ? `Interested in ${svc.toLowerCase()}` : null,
        AI_Summary: `Asked about ${svc.toLowerCase()}${status === 'Booked' ? '; booked' : status === 'Lost' ? '; went quiet' : ''}.`,
        First_Response_At: status === 'New' ? null : created + 60 * (2 + Math.floor(r() * 25)),
        Next_Action_At: status === 'Contacted' && i % 3 === 0 ? now - (i % 2 ? 3 * H : -20 * H) : null,
        Owner: i % 5 === 0 ? pick(fl.staff) : null, Opted_Out: i === 17, Escalated: i % 11 === 0, Followup_Sent: status === 'Contacted' && i % 2 === 0,
        Lost_Reason: status === 'Lost' ? pick(['No response', 'Price', 'Went elsewhere']) : null, Notes: null, UTM_Campaign: src === 'Website' ? 'autumn' : null, Page_URL: null,
      } });
      if (src === 'Website' && i % 8 === 0) continue;   // some website contacts never wrote on WhatsApp
      const cid = convs.length + 1;
      const handoff = i % 6 === 2 ? fl.handoffs[(i / 6 | 0) % fl.handoffs.length] : null;
      const lastIn = created + 30 + (i < 10 ? Math.floor((now - created) * 0.9) : 0);
      convs.push({ id: cid, fields: { Lead: i, Phone: phone, Last_Inbound_At: Math.min(lastIn, now - 120), Unread: i % 4 === 1 ? 1 + (i % 3) : 0, Automation_Paused: i === 14, Assigned_To: i % 7 === 0 ? pick(fl.staff) : null, Needs_Human: !!handoff, Handoff_Reason: handoff ? handoff[1] : null, Last_Intent: null } });
      // a short thread
      const q = fl.questions[i % fl.questions.length];
      const t0 = created + 20;
      msg(cid, { Direction: 'In', Body: q[0], Sent_By: 'Patient', WA_Message_ID: `wamid.demo.${fi}.${mid + 1}`, Status: 'Received', Created_At: t0, Intent: q[1], AI_Action: q[2] ? 'reply' : 'no_reply', AI_Confidence: q[3], AI_Status: fl.settings.ai_mode === 'draft' ? 'drafted' : q[2] ? 'replied' : 'no_reply', AI_Reply: q[2] || null, Needs_Human: false });
      if (q[2] && fl.settings.ai_mode !== 'draft') msg(cid, { Direction: 'Out', Body: q[2], Sent_By: 'W13-ai-receptionist', WA_Message_ID: `wamid.demo.out.${fi}.${mid + 1}`, Status: 'queued', Created_At: t0 + 15 });
      if (handoff) {
        const th = Math.min(lastIn, now - 120);
        msg(cid, { Direction: 'In', Body: handoff[0], Sent_By: 'Patient', WA_Message_ID: `wamid.demo.${fi}.${mid + 1}`, Status: 'Received', Created_At: th, Intent: /refund|negotiat|discount/i.test(handoff[0]) ? 'payment_issue' : /swollen|loan/i.test(handoff[0]) ? 'medical_question' : /same/i.test(handoff[0]) ? 'outcome_same' : 'complaint', AI_Action: 'handoff', AI_Confidence: 0.82, AI_Status: 'handed_off', Needs_Human: true, AI_Reason: handoff[1] });
        msg(cid, { Direction: 'Out', Body: 'Thank you for your message. A member of our team will reply to you shortly.', Sent_By: 'W13-ai-receptionist', WA_Message_ID: `wamid.demo.out.${fi}.${mid + 1}`, Status: 'queued', Created_At: th + 12 });
        convs[cid - 1].fields.Last_Intent = 'handoff';
      } else if (i < 10) {
        const tl = Math.min(lastIn, now - 120);
        msg(cid, { Direction: 'In', Body: i % 2 ? 'Okay, see you then.' : 'Can you share the address?', Sent_By: 'Patient', WA_Message_ID: `wamid.demo.${fi}.${mid + 1}`, Status: 'Received', Created_At: tl, Intent: i % 2 ? 'thanks_ack' : 'location_hours', AI_Action: i % 2 ? 'no_reply' : 'reply', AI_Confidence: 0.94, AI_Status: i % 2 ? 'no_reply' : 'replied', Needs_Human: false });
        if (!(i % 2)) msg(cid, { Direction: 'Out', Body: fl.knowledge.find((k) => k[1] === 'location')?.[2] || 'Our address is in your booking confirmation.', Sent_By: 'W13-ai-receptionist', WA_Message_ID: `wamid.demo.out.${fi}.${mid + 1}`, Status: 'queued', Created_At: tl + 14 });
      }
      if (i === 5) msg(cid, { Direction: 'Out', Body: 'Hi, this is the front desk: your report is ready, you can collect it any time today.', Sent_By: fl.staff[0], WA_Message_ID: `wamid.demo.staff.${fi}`, Status: 'sent', Created_At: Math.min(lastIn, now - 120) + 300 });
      if (i === 11) msg(cid, { Direction: 'Out', Body: 'Sharing the updated details as discussed.', Sent_By: fl.staff[1], Status: 'needs_template', AI_Reason: 'the patient\'s last message is older than 24 h: WhatsApp only allows an approved template now. Ask them to message you first, or call', Created_At: now - 5 * H });
      // bookings for booked / converted contacts (and a few more)
      if (status === 'Booked' || status === 'Converted' || i % 5 === 0) {
        const n = status === 'Converted' ? 2 : 1;
        for (let k = 0; k < n; k++) {
          const offsetDays = status === 'Booked' && k === 0 ? Math.floor(r() * 9) - 2 : -Math.floor(1 + r() * 14);
          const hour = 9 + Math.floor(r() * 9);
          const day0 = Math.floor((now + 5.5 * H) / D) * D - 5.5 * H;
          const start = day0 + offsetDays * D + hour * H + (r() < 0.5 ? 0 : 30 * 60);
          const past = start < now - H;
          const st = !past ? (r() < 0.12 ? 'Rescheduled' : 'Booked') : r() < 0.62 ? 'Completed' : r() < 0.5 ? 'No-show' : r() < 0.5 ? 'Cancelled' : 'Booked';
          const uid = i % 9 === 3 ? `wa-wamid.demo.${fi}.${i}` : `cal-${fl.slug}-${i}-${k}`;
          const sv = k === 0 ? svc : pick(fl.services);
          const ap: Record<string, unknown> = { Booking_UID: uid, Lead: i, Service: sv, Physio: pick(fl.staff), Start: start, End: start + 45 * 60, Status: st, Fee_INR: fl.fee[1] ? Math.round((fl.fee[0] + r() * (fl.fee[1] - fl.fee[0])) / 50) * 50 : null };
          if (st !== 'Cancelled' && start - now < 24 * H && start > now - 30 * D) { ap.R24_Sent = Math.min(now - 60, start - 22 * H); log('W5-reminders', `${uid} (r24)`, ap.R24_Sent as number); }
          if (st === 'Completed' && now - start > 22 * H && fl.settings.outcome_checkin === 'on') { ap.Outcome_Sent = start + 21 * H; log('W7-outcome-nudge', `${uid} ${ref}`, start + 21 * H); msg(cid, { Direction: 'Out', Body: `Hi ${name.split(' ')[0]}, thank you for visiting ${fl.name} for your ${sv}. How are you feeling now? Just reply here: better, the same or worse. If you would like another appointment, tell us and we will help.`, Template: 'outcome_check', Sent_By: 'W7-outcome-nudge', WA_Message_ID: `wamid.demo.w7.${fi}.${i}.${k}`, Status: 'queued', Created_At: start + 21 * H }); }
          if (st === 'Completed' && now - start > 4 * H && fl.settings.review_requests === 'on' && i % 2 === 0) { ap.Review_Sent = start + 4 * H; log('W8-review-request', `${uid} ${ref}`, start + 4 * H); msg(cid, { Direction: 'Out', Body: `Hi ${name.split(' ')[0]}, thank you for choosing ${fl.name}. If you have a minute, we would be grateful for your honest review here: ${fl.settings.review_link} Thank you!`, Template: 'review_request', Sent_By: 'W8-review-request', WA_Message_ID: `wamid.demo.w8.${fi}.${i}.${k}`, Status: 'queued', Created_At: start + 4 * H }); }
          if (st === 'No-show' && now - start > 25 * H) { ap.Rebook_Sent = start + 24 * H; log('W6-followups', `${uid} (rebook) ${ref}`, start + 24 * H); }
          appts.push({ id: ++aid, fields: ap as GristRecord['fields'] });
          log('W4-booking-sync', `${uid} (${st === 'Rescheduled' ? 'rescheduled' : 'created'}) ${ref}`, Math.min(now - 300, Math.max(created + 600, start - 3 * D)));
          if (st === 'Cancelled') log('W4-booking-sync', `${uid} (cancelled) ${ref}`, Math.min(now - 300, start - 6 * H));
        }
      }
      if (status === 'Contacted' && i % 2 === 0) log('W6-followups', `${ref} (followup)`, created + 2 * D + 3600);
      if (i % 11 === 0) log('W3-speed-to-lead', `${ref} (escalated)`, created + 40 * 60);
      log('W2-WhatsApp-Inbound', `${ref} stored`, t0);
      log('W13-ai-receptionist', `${ref} ${q[1]} -> ${q[2] ? 'reply' : 'no_reply'} (${fl.settings.ai_mode === 'draft' ? 'drafted' : 'replied'})`, t0 + 16);
    }
    log('W5-reminders', 'cal-demo-x (r2)', now - 26 * H, 'failed', '131026: message undeliverable (number not on WhatsApp?)');
    log('W2-WhatsApp-Inbound', 'status update', now - 50 * H, 'skipped', 'not a message');
    const settings = Object.entries(fl.settings).map(([Key, Value], i) => ({ id: i + 1, fields: { Key, Value } }));
    const knowledge = fl.knowledge.map(([Title, Category, Content], i) => ({ id: i + 1, fields: { Title, Category, Content, Active: true } }));
    // the weekly report, made by the workflow's own W9 functions from this data
    const win = clinicModules.cmWeekWindow(nowMs);
    const metrics = clinicModules.cmWeeklyMetrics({ leads, appointments: appts, conversations: convs, messages: msgs, runlog: logs }, nowMs, win, { messages: 5000, runlog: 5000 });
    const rep = clinicModules.cmRenderReport(metrics, { summary: '', observations: [], recommendations: [], dropped: 0, error: 'demo data: no AI call' }, fl.name, win, !!fl.settings.review_link);
    log('W9-weekly-report', rep.text, Math.min(now - 60, win.end + 9 * H), 'ok', 'AI text not used: demo data: no AI call');
    docs[fl.doc] = { Settings: settings, LEADS: leads, Appointments: appts, Conversations: convs, Messages: msgs, Run_Log: logs, Knowledge: knowledge };
  });
  const profiles: Record<string, WorkspaceProfile> = Object.fromEntries(FLAVORS.map((f) => [f.slug, f.profile]));
  return { docs, profiles };
}
