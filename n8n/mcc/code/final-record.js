// The last step: the event row says how the acknowledgement and the alert ended, and Run_Log gets one row. A failure is a failure.
const from = (name) => { try { return $(name).first().json; } catch (e) { return null; } };
const c = $('MCC – Decide alert').first().json;
const w12 = from("MCC – Call 'W12 - WhatsApp send' (alert)");
let alert;
if (!c.alert_needed) alert = { state: c.prev_alert || 'not_needed', outcome: 'ok' };   // a retry keeps what the first alert did
else if (!w12) alert = c.alert_decision.send ? { state: 'pending', outcome: 'ok' } : { state: /quiet hours/.test(c.alert_decision.reason) ? 'deferred' : 'skipped', outcome: 'skipped', note: c.alert_decision.reason };
else {
  const bad = w12.error || w12.send_status === undefined;
  const o = ceAckOutcome(bad ? { sent: false, send_status: 'error', send_error: ceText((w12.error && (w12.error.message || w12.error)) || 'no answer from W12', 200) } : w12, 1);
  alert = { state: o.state === CE_STATE.simulated ? 'simulated' : o.state === CE_STATE.sent ? 'sent' : o.state === CE_STATE.deferred ? 'deferred' : 'failed', outcome: o.outcome, note: o.detail };
}
const outcome = c.ack.outcome === 'failed' || alert.outcome === 'failed' ? 'failed' : (c.ack.outcome === 'skipped' && alert.state !== 'sent' && alert.state !== 'simulated' ? 'skipped' : 'ok');
const ackName = c.ack.state.replace('mcc:ack_', '');
const nowSec = Math.floor(Date.now() / 1000);
const error = [c.ack.outcome === 'failed' ? c.ack.detail : '', alert.outcome === 'failed' ? `staff alert: ${alert.note}` : ''].filter(Boolean).join('; ');
const base = { grist_base_url: c.grist_base_url, doc_id: c.doc_id };
return [
  { json: { ...base, method: 'PATCH', table: 'Messages', body: { records: [{ id: c.plan.row_id, fields: { AI_Action: c.ack.state, AI_Reason: `${c.ack.detail}; alert ${alert.state}`.slice(0, 500) } }] } } },
  { json: { ...base, method: 'POST', table: 'Run_Log', body: { records: [{ fields: ceLogRow(`${c.event.call_key} ${c.lead.lead_id}: ack ${ackName}; staff alert ${alert.state}${c.plan.kind === 'retry_ack' ? ' (retry)' : ''}`, outcome, error, nowSec, c.demo) }] } } },
];
