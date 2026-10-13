// Join point: the lead exists (found by phone, or just created). Read by name later.
const from = (name) => { try { return $(name).first().json; } catch (e) { return null; } };   // throws when that branch did not run
const ctx = from('MCC – Context');
const found = from('MCC – Find lead');
const rec = found && Array.isArray(found.records) ? found.records[0] : null;
let lead;
if (rec) {
  lead = { row_id: rec.id, lead_id: String((rec.fields || {}).Lead_id || (rec.fields || {}).Lead_ID || `row ${rec.id}`), name: String((rec.fields || {}).Name || ''), opted_out: (rec.fields || {}).Opted_Out === true, created: false };
} else {
  const made = from('MCC – Build new lead');
  const id = Array.isArray($json.records) && $json.records[0] ? Number($json.records[0].id) : 0;
  lead = { row_id: id, lead_id: made.lead_id, name: made.lead_name, opted_out: false, created: true };
}
return { json: { ...ctx, lead } };
