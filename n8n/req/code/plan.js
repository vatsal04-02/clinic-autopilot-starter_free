// Which requests staff have decided on, and the patient has not been told about yet (reqcPlan): Booked -> confirmed (or refused when the slot
// is taken), Declined -> declined. Only for clinics with Settings > booking_mode = request. Cal.com / WhatsApp bookings are never looked at.
const cfg = $('REQ – Config').first().json;
const clinics = $('REQ – Add settings').all();
const appts = $('REQ – Appointments').all();
const leads = $('REQ – Leads').all();
const now = Date.now();
const out = [];
$input.all().forEach((conv, i) => {
  const c = clinics[i].json;
  if (String(c.settings.booking_mode || '').trim().toLowerCase() !== 'request') return;
  const plan = reqcPlan(appts[i].json.records || [], leads[i].json.records || [], conv.json.records || [], c.settings, now, cfg);
  for (const it of plan.items) {
    out.push({
      json: { grist_base_url: c.grist_base_url, doc_id: c.doc_id, clinic_name: c.clinic_name, wa_phone_number_id: c.wa_phone_number_id, test_mode: c.settings.TEST_MODE, test_phone: c.settings.TEST_PHONE, ...it },
      pairedItem: { item: i },
    });
  }
});
return out;
