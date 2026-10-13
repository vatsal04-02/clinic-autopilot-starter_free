// The W12 item for the acknowledgement. W12 is the only sender; in simulate mode it sends nothing and says so.
const c = $('MCC – Decide ack').first().json;
return {
  json: ceAckItem({
    wa_phone_number_id: c.clinic.wa_phone_number_id, grist_base_url: c.grist_base_url, doc_id: c.doc_id, clinic_name: c.clinic_name,
    lead_row_id: c.lead.row_id, lead_phone: c.event.caller_phone,
  }, c.decision),
};
