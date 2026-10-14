// SYNTHETIC data for the local demo. Nothing here is a real person, a real clinic or a real phone number: names are invented, numbers are the
// +91 90000 xxxxx test range, the booking link is example.com. Used by the scripted demo (run-demo.js), its test (demo.test.js) and the seed
// script for a local Grist (seed-grist.js), so what you seed is exactly what the tests ran against.
const DEMO = {
  registryDocKey: 'DEMO_REGISTRY',
  clinic: { slug: 'demo-physio', name: 'Demo Physio', docKey: 'DEMO_CLINIC', waPhoneNumberId: '100000000000001', callNumber: '+919000000100' },
  owner: '+919000000018',
  testPhone: '+919000000019',
  callers: { meera: '+919000000021', arjun: '+919000000022', kavya: '+919000000023', dev: '+919000000024', isha: '+919000000025' },
};

// Per-clinic Settings (Key / Value). Safe defaults: TEST_MODE on (every message would go to the TEST phone), assistant in auto mode, requests (not
// bookings), missed-call capture on, demo labels on. Grist stores strings.
function settings(over = {}) {
  const base = {
    clinic_name: DEMO.clinic.name, ai_mode: 'auto', open_time: '09:00', close_time: '19:00', working_days: 'Mon-Sat',
    booking_link: 'https://example.com/demo-physio/book', owner_phone: DEMO.owner, TEST_MODE: 'true', TEST_PHONE: DEMO.testPhone,
    slot_minutes: '30', booking_notice_minutes: '120', booking_capacity: '1',
    booking_mode: 'request', request_hold_hours: '24', max_pending_requests: '2',
    missed_call_enabled: 'on', demo_mode: 'on',
  };
  return Object.entries({ ...base, ...over }).filter(([, v]) => v !== undefined).map(([Key, Value], i) => ({ id: i + 1, fields: { Key, Value } }));
}

// The clinic's Knowledge base: the ONLY source of facts the assistant (and the no-model fallback) may state.
function knowledge() {
  const rows = [
    ['Knee pain physiotherapy', 'services', 'One-to-one knee rehab: assessment, manual therapy and exercises. ₹800 per session.'],
    ['Back pain physiotherapy', 'services', 'Treatment for lower back and neck pain. ₹800 per session.'],
    ['First assessment', 'pricing', 'The first assessment costs ₹500 and takes 45 minutes.'],
    ['Opening hours', 'hours', 'Monday to Saturday, 9 AM to 7 PM. Closed on Sunday.'],
    ['Address', 'location', 'Demo Physio, 12 MG Road, Pune. Parking available.'],
    ['Cancellation policy', 'policy', 'Cancel or reschedule up to 2 hours before your appointment, free of charge.'],
  ];
  return rows.map(([Title, Category, Content], i) => ({ id: i + 1, fields: { Title, Category, Content, Active: true } }));
}

// Agency Registry > Clinics: how a called number / a WhatsApp phone_number_id finds the clinic (tenant routing never reads the request body).
function registry() {
  const c = DEMO.clinic;
  return { Clinics: [{ id: 1, fields: { Clinic_Slug: c.slug, Clinic_Name: c.name, Grist_Doc_ID: c.docKey, WA_Phone_Number_ID: c.waPhoneNumberId, Active: true, Call_Number: c.callNumber } }] };
}

// An empty clinic CRM with the synthetic Settings and Knowledge. (Leads, conversations and messages are created by the demo itself.)
function clinicDoc(over = {}) {
  return { Settings: settings(over), Knowledge: knowledge(), LEADS: [], Conversations: [], Messages: [], Appointments: [], Run_Log: [] };
}

// The scripted patient lines (English and Hindi / Hinglish). The scripted demo runs them through the real workflow with a SCRIPTED model; with a
// real Ollama the wording of the replies is the model's own (see DEMO.md).
const SCRIPT = {
  en: { services: 'What services do you offer?', pricing: 'How much is the first visit?', book: 'Book me for Thursday at 5.' },
  hi: { greeting: 'Namaste', pricing: 'Namaste, first visit ki fees kitne ki hai?', hours: 'Aap kab tak khule rehte hain? timing kya hai?', book: 'Thursday 5 baje appointment chahiye' },
  medical: 'My knee is swollen and very painful at night. Is it safe to keep exercising?',
  emergency: 'I have severe chest pain and cannot breathe',
  stop: 'STOP',
};

module.exports = { DEMO, settings, knowledge, registry, clinicDoc, SCRIPT };
