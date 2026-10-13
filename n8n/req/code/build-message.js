// The item for W12 (free text inside the 24 h window, else the approved template) + the claim: Confirm_Sent is written BEFORE the send (next node).
// If that write fails, nothing is sent and W11 alerts; the patient is never told twice.
const now = Math.floor(Date.now() / 1000);
const message = reqcMessage($json, $json.clinic_name, now);
return {
  json: {
    ...$json,
    ...message,
    audience: 'patient',
    source_workflow: 'W12-request-confirm',
    lead_phone: $json.patient_phone,
    claim: { records: [{ id: $json.appt_row_id, fields: { Confirm_Sent: now } }] },
  },
};
