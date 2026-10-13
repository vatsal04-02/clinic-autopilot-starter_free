// What happened to the acknowledgement: W12's answer (sent / simulated / blocked / failed), or the reason it was not attempted.
const from = (name) => { try { return $(name).first().json; } catch (e) { return null; } };
const c = $('MCC – Decide ack').first().json;
const w12 = from("MCC – Call 'W12 - WhatsApp send' (ack)");
let ack;
if (w12) {
  const failed = w12.error || w12.send_status === undefined;
  ack = ceAckOutcome(failed ? { sent: false, send_status: 'error', send_error: ceText((w12.error && (w12.error.message || w12.error)) || 'no answer from W12', 200) } : w12, c.attempt);
} else {
  ack = { state: c.decision.state, outcome: 'skipped', detail: `attempt ${c.attempt}: ${c.decision.reason}` };
}
return { json: { ...c, ack } };
