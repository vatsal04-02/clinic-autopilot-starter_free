// Every ACTIVE clinic of the Agency Registry that has a Call_Number (never a hard-coded clinic), one item each.
const cfg = $('MCC – Retry config').first().json;
const base = String(cfg.grist_base_url || '').replace(/\/+$/, '');
const clinics = ($input.first().json.records || []).filter((r) => r.fields && String(r.fields.Active).toUpperCase() === 'TRUE' && String(r.fields.Grist_Doc_ID || '').trim() && ceCalledKey(r.fields.Call_Number, { normalizeIndianPhone }));
return clinics.map((r) => ({
  json: {
    grist_base_url: base,
    doc_id: String(r.fields.Grist_Doc_ID).trim(),
    leads_table: cfg.leads_table,
    unread_mode: cfg.unread_mode,
    default_lead_name: cfg.default_lead_name,
    clinic: { slug: ceText(r.fields.Clinic_Slug, 40), name: ceText(r.fields.Clinic_Name, 100), doc_id: String(r.fields.Grist_Doc_ID).trim(), wa_phone_number_id: String(r.fields.WA_Phone_Number_ID || '').trim() },
  },
  pairedItem: { item: 0 },
}));
