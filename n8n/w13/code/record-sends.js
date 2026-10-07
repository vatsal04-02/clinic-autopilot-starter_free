// What W12 answered -> the final CRM writes (aiFinalWrites): the message row (intent, action, status, reply), the conversation
// (Last_Intent, Needs_Human), the lead (stage, summary, Contacted, follow-up date), Run_Log. A missing W12 answer = not sent.
const b = $('W13 – Build Context').first().json;
const ready = $('W13 – Plan Ready').first().json;
const sends = { patient: null, staff: null };
let callError = '';
for (const it of $input.all()) {
  const r = it.json || {};
  if (r.w13_kind === 'patient_reply') sends.patient = r;
  else if (r.w13_kind === 'staff_alert') sends.staff = r;
  else if (r.error) callError = String(r.error.message || r.error).slice(0, 200);
}
const sentNothing = (kind) => ({ w13_kind: kind, sent: false, send_status: 'no_result', send_error: `W12 gave no result${callError ? `: ${callError}` : ''} (check W13 – Config > w12_workflow_id)` });
for (const it of b.x.dry_run ? [] : ready.send_items) {
  if (it.w13_kind === 'patient_reply' && !sends.patient) sends.patient = sentNothing('patient_reply');
  if (it.w13_kind === 'staff_alert' && !sends.staff) sends.staff = sentNothing('staff_alert');
}
const fw = aiFinalWrites(ready.plan, b.x, sends, Math.floor(Date.now() / 1000));
const c = $('W13 – Resolve Clinic').first().json;
const brief = (r) => (r ? { sent: r.sent === true, send_status: r.send_status || '', to: (r.decision && r.decision.to) || null, error: r.send_error || '' } : null);
const report = {
  status: fw.status, route: fw.route, needs_human: fw.needs_human, reason: fw.reason, reply: fw.reply, intent: ready.plan.intent || '',
  test_case: b.x.test_case, dry_run: b.x.dry_run, sends: { patient: brief(sends.patient), staff: brief(sends.staff) },
};
if (!fw.writes.length) return [{ json: { report } }];
return fw.writes.map((w) => ({ json: { ...w, grist_base_url: c.grist_base_url, doc_id: c.doc_id, report } }));
