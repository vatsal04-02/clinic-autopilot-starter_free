// One Run_Log row for an event that ends without doing anything: off for this clinic, a repeat, or a concurrent copy that stood down.
const from = (name) => { try { return $(name).first().json; } catch (e) { return null; } };
const canon = from('MCC – Canonical');
const cls = from('MCC – Classify');
const ctx = canon || cls || from('MCC – Add settings');
let reason;
if (canon && canon.plan && canon.plan.mine === false) reason = `concurrent duplicate: row ${canon.plan.canonical_id} owns this event`;
else if (cls && cls.plan.kind === 'duplicate') reason = 'duplicate call event (already recorded): no new lead, no second acknowledgement';
else if (cls && cls.plan.kind === 'inflight') reason = 'duplicate delivery while the first is still being processed';
else reason = 'missed-call capture is off for this clinic (Settings missed_call_enabled)';
const nowSec = Math.floor(Date.now() / 1000);
return { json: { grist_base_url: ctx.grist_base_url, doc_id: ctx.doc_id, log: ceLogRow(`${ctx.event.call_key} skipped`, 'skipped', reason, nowSec, ctx.demo) } };
