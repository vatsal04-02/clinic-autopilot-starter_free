// Link the event row to the conversation, and count it as unread. Last_Inbound_At is NEVER written: a missed call is not a WhatsApp
// message and must not open the 24 h free-text window. A retry only re-links the row (no second Unread).
const c = $('MCC – Conversation ready').first().json;
const base = { grist_base_url: c.grist_base_url, doc_id: c.doc_id };
const writes = [{
  ...base, method: 'PATCH', table: 'Messages',
  body: { records: [{ id: c.plan.row_id, fields: { Conversation: c.conversation.row_id, AI_Action: CE_STATE.pending, AI_Reason: c.plan.prev_reason || '' } }] },
}];
if (c.plan.kind !== 'retry_ack') {
  const unread = c.unread_mode === 'flag' ? true : (Number(c.conversation.unread) || 0) + 1;
  writes.push({ ...base, method: 'PATCH', table: 'Conversations', body: { records: [{ id: c.conversation.row_id, fields: { Lead: c.lead.row_id, Unread: unread } }] } });
}
return writes.map((json) => ({ json }));
