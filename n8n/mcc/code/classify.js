// Is this call event new, a repeat, or a retry? The Messages row keyed "call-<provider_call_id>" is the idempotency record.
const ctx = $('MCC – Add settings').first().json;
const nowSec = Math.floor(Date.now() / 1000);
const c = ceClassifyExisting(Array.isArray($json.records) ? $json.records : [], nowSec);
const row = c.row || null;
return {
  json: {
    ...ctx,
    plan: { kind: c.kind, row_id: row ? row.id : 0, conversation_id: row ? Number(row.fields.Conversation) || 0 : 0, attempts: row ? ceAttempts(row) : 0, prev_state: row ? ceStateOf(row) : '', prev_reason: row ? String(row.fields.AI_Reason || '') : '' },
    claim_row: c.kind === 'new' ? ceClaimRow(ctx.event, nowSec, ctx.demo) : null,
  },
};
