const c = $('MCC – Decide alert').first().json;
return {
  json: ceAlertItem({
    wa_phone_number_id: c.clinic.wa_phone_number_id, grist_base_url: c.grist_base_url, doc_id: c.doc_id, clinic_name: c.clinic_name,
    lead_row_id: c.lead.row_id, lead_phone: c.event.caller_phone, lead_name: c.lead.name, kind: c.event.kind,
  }, c.alert_decision),
};
