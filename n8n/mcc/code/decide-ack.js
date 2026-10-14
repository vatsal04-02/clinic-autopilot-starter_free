// CLAUDE.md rules 4 and 5 for the acknowledgement: Opted_Out, a person who owns the chat, one per caller per hour, quiet hours, TEST_MODE (-> TEST_PHONE).
const c = $('MCC – Conversation ready').first().json;
const recent = $('MCC – Recent acks').first().json;
const decision = ceAckDecision({
  lead_phone: c.event.caller_phone, test_mode: c.settings.test_mode, test_phone: c.settings.test_phone,
  opted_out: c.lead.opted_out, automation_paused: c.conversation.automation_paused, assigned_to: c.conversation.assigned_to,
  recent_ack_at: ceRecentAck(Array.isArray(recent.records) ? recent.records : []),
}, Date.now(), { normalizeIndianPhone, decideSend });
return { json: { ...c, attempt: c.plan.attempts + 1, decision, send: decision.send === true } };
