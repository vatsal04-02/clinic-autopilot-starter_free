// The ONE oldest acknowledgement that is due again (failed, waiting for the morning, or never attempted), across all clinics. One per
// run on purpose: the rest of the pipeline reasons about a single event, and the schedule comes back in a few minutes.
// Due = linked to a conversation, state pending / deferred / failed, fewer than 3 tries, younger than retry_max_age_hours, and old
// enough not to collide with the webhook run that just wrote it (pending: 2 minutes, others: 1 minute).
const cfg = $('MCC – Retry config').first().json;
const ctxs = $('MCC – Retry add settings').all();
const msgs = $('MCC – Retry messages').all();
const convs = $input.all();
const nowSec = Math.floor(Date.now() / 1000);
let best = null;
ctxs.forEach((c, i) => {
  const byId = {};
  for (const r of (convs[i] && convs[i].json.records) || []) byId[r.id] = r.fields || {};
  for (const r of (msgs[i] && msgs[i].json.records) || []) {
    const f = r.fields || {};
    if (f.Template !== 'missed_call' || !(Number(f.Conversation) > 0) || !CE_RETRYABLE.includes(ceStateOf(r))) continue;
    if (ceAttempts(r) >= CE_MAX_ACK_ATTEMPTS) continue;
    const age = nowSec - (Number(f.Created_At) || 0);
    if (age > Number(cfg.retry_max_age_hours) * 3600) continue;
    if (age < (ceStateOf(r) === CE_STATE.pending ? CE_INFLIGHT_SEC : 60)) continue;
    const conv = byId[Number(f.Conversation)];
    const phone = normalizeIndianPhone(conv && conv.Phone).phone;
    if (!phone) continue;
    if (!best || (Number(f.Created_At) || 0) < (Number(best.f.Created_At) || 0)) best = { c, r, f, phone };
  }
});
if (!best) return [];
const kind = (String(best.f.Body || '').match(/Missed call \((\w+)\)/) || [])[1] === 'busy' ? 'busy' : 'missed';
return [{
  json: {
    ...best.c.json,
    event: { call_id: String(best.f.WA_Message_ID).replace(/^call-/, ''), call_key: String(best.f.WA_Message_ID), called_key: '', caller_phone: best.phone, at: Number(best.f.Created_At) || nowSec, kind, duration_seconds: null, provider: 'retry' },
    plan: { kind: 'retry_ack', row_id: best.r.id, conversation_id: Number(best.f.Conversation), attempts: ceAttempts(best.r), prev_state: ceStateOf(best.r), prev_reason: String(best.f.AI_Reason || '') },
  },
}];
