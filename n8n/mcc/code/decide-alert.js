// The staff alert (owner): sent for a new event; on a retry only if the first alert did not go out. Same guards, TEST_MODE -> TEST_PHONE.
const c = $('MCC – Ack result').first().json;
const prev = (String(c.plan.prev_reason).match(/alert (\w+)/) || [])[1] || '';
const needed = c.plan.kind !== 'retry_ack' || ['deferred', 'failed', 'pending', ''].includes(prev);
const decision = ceAlertDecision({ owner_phone: c.settings.owner_phone, test_mode: c.settings.test_mode, test_phone: c.settings.test_phone }, Date.now(), { normalizeIndianPhone, decideSend });
return { json: { ...c, alert_decision: decision, alert_needed: needed, prev_alert: prev, send_alert: needed && decision.send === true } };
