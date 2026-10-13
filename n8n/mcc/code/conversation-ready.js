// Join point: the conversation exists (found by phone, or just created). Assigned_To / Automation_Paused / Needs_Human = a person owns it.
const from = (name) => { try { return $(name).first().json; } catch (e) { return null; } };
const ctx = from('MCC – Lead ready');
const found = from('MCC – Find conversation');
const rec = found && Array.isArray(found.records) ? found.records[0] : null;
let conversation;
if (rec) {
  const f = rec.fields || {};
  conversation = { row_id: rec.id, unread: f.Unread, assigned_to: String(f.Assigned_To || '').trim(), automation_paused: f.Automation_Paused === true, needs_human: f.Needs_Human === true, created: false };
} else {
  const id = Array.isArray($json.records) && $json.records[0] ? Number($json.records[0].id) : 0;
  conversation = { row_id: id, unread: 0, assigned_to: '', automation_paused: false, needs_human: false, created: true };
}
return { json: { ...ctx, conversation } };
