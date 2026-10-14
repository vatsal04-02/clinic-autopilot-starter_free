// URGENT HAND-OFFS AT NIGHT (demo / safety): W13 hands a possible emergency ("chest pain", "can't breathe", ...) to a person as priority URGENT. Until now the
// alert to the owner went through the same quiet-hours rule as patient messages (21:00-08:00 IST): an emergency at 23:00 was "deferred" to the 08:05 run -
// nine hours of silence. Quiet hours exist so that PATIENTS are not messaged at night; the owner's phone is not a patient.
// This module changes exactly that, and nothing else:
//   * the staff alert (template human_handoff_alert) of an URGENT hand-off is decided as if it were daytime (Opted_Out, TEST_MODE, a valid phone still apply);
//   * at night the patient is NOT sent the holding reply (rule 5: no patient message 21:00-08:00); the hand-off is complete without it;
//   * the item carries urgent: true so W12 lets exactly this template to the owner through its own quiet-hours check;
//   * a staff alert that was due and did not go out is a FAILURE in Run_Log (urgentAlertLost), whether urgent or not.
// Pure functions, no network, no clock but the arguments. Pasted into "W13 – Plan Ready" and "W13 – Record Sends" after the ai-receptionist.js block.
// Paste from AI_URGENT_NOON down to (not including) the module.exports line.

const AI_URGENT_NOON = Date.parse('2026-01-05T12:00:00+05:30');   // any weekday noon IST: only the hour matters to decideSend

// plan: from W13 – Plan; x: the context; items: aiSendItems(...); h: { normalizeIndianPhone, decideSend, inQuietHours }.
// Mutates plan (reply / notes) and returns the new items.
function aiUrgentAlerts(plan, x, items, h) {
  const urgent = plan.route === 'handoff' && plan.triage && plan.triage.priority === 'urgent';
  if (!urgent) return items;
  const owner = h.normalizeIndianPhone(x.profile.owner_phone).phone;
  const testPhone = h.normalizeIndianPhone(x.profile.test_phone).phone;
  const night = h.inQuietHours(x.now_ms);
  const out = [];
  for (const it of items) {
    if (it.w13_kind === 'staff_alert') {
      const decision = h.decideSend({ kind: 'transactional', flag_value: null, opted_out: false, automation_paused: false, patient_phone: owner, test_mode: x.profile.test_mode, test_phone: testPhone, now_ms: AI_URGENT_NOON });
      out.push({ ...it, urgent: true, decision });
    } else if (it.w13_kind === 'patient_reply' && night) {
      // no patient message at night; the hand-off stands without it
    } else out.push(it);
  }
  if (night && items.some((it) => it.w13_kind === 'patient_reply')) {
    plan.reply = '';
    plan.notes.push('urgent hand-off at night: the owner is alerted now; the patient is not messaged before 08:00');
  }
  return out;
}

// Did a staff alert that was due fail to go out? sends.staff: W12's answer (or null); items: the send items of this run.
// "Due" = the guard said send, or it is urgent. A DEMO simulated send counts as done.
function aiUrgentAlertLost(items, sends) {
  const due = (items || []).find((it) => it.w13_kind === 'staff_alert' && (it.urgent === true || (it.decision && it.decision.send === true)));
  if (!due) return null;
  const s = sends && sends.staff;
  if (s && (s.sent === true || s.simulated === true)) return null;
  const why = (s && (s.send_error || (s.decision && s.decision.reason) || s.send_status)) || (due.decision && due.decision.reason) || 'no answer from W12';
  return { urgent: due.urgent === true, reason: String(why).replace(/\s+/g, ' ').slice(0, 300) };
}

if (typeof module !== 'undefined') module.exports = { AI_URGENT_NOON, aiUrgentAlerts, aiUrgentAlertLost };
