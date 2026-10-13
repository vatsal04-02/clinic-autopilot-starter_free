// WHICH clinic? Only the Agency Registry decides, by the CALLED number (Clinics.Call_Number). Nothing from the request body.
const cfg = $('MCC – Config').first().json;
const ev = $('MCC – Validate').first().json.event;
const r = ceResolveClinic($json.records, ev.called_key, { normalizeIndianPhone });
return {
  json: {
    found: r.found,
    reason: r.reason || '',
    event: ev,
    clinic: r.clinic || null,
    grist_base_url: String(cfg.grist_base_url || '').replace(/\/+$/, ''),
    doc_id: r.found ? r.clinic.doc_id : '',
    leads_table: cfg.leads_table,
    unread_mode: cfg.unread_mode,
    default_lead_name: cfg.default_lead_name,
  },
};
