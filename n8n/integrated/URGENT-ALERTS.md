# Urgent hand-offs at night, and alerts that fail

## The gap this closes (found by `urgent-alerts.test.js` U2, control run)

W13 hands a possible emergency ("chest pain", "can't breathe", "fainted", ...) to a person as priority **URGENT**, before the model is asked. But the alert to the owner went through the same quiet-hours rule as patient messages (no message 21:00–08:00 IST), so at 23:00 **nothing was sent**: the message was marked `deferred` and the 08:05 morning run was the first moment anyone was told. Nine hours of silence for an emergency, recorded only as "staff alert not sent: guard said no: quiet hours".

Quiet hours protect *patients* from night-time messages. The owner's phone is not a patient.

## What changes (`apply-urgent-alerts.js`; three existing nodes, code only, no new node, no wiring)

```
node n8n/integrated/apply-urgent-alerts.js --in <workflow.json> [--out <file>] [--keep-private]
```

| Node | Change |
|---|---|
| `W13 – Plan Ready` | For an **URGENT** hand-off the owner alert (`human_handoff_alert`) is decided as daytime (`urgent: true`); Opted_Out, TEST_MODE and a valid phone still apply. At night the patient's holding reply is dropped (rule 5: no patient message 21:00–08:00) and the plan says so |
| `W12 – Prepare request` | Quiet hours are skipped **only** for an item with `urgent === true` **and** `audience === 'staff'` **and** `template === 'human_handoff_alert'` (also in simulate mode). Everything else, including every patient message and every other sender (W3, W5, W7–W10, MCC, REQ), keeps the quiet-hours rule (U8, U9) |
| `W13 – Record Sends` | A staff alert that was due and did not go out turns the W13 Run_Log row into `Outcome failed` with `URGENT ALERT NOT SENT: <why>` (or `STAFF ALERT NOT SENT: ...` for a normal hand-off). Before, it was logged `ok` with the reason buried in the Error text |

Result at 23:00 for "I have chest pain, what are your fees?": one WhatsApp template to the owner (`human_handoff_alert`, "URGENT · Possible emergency ... Contact the patient now."), the model is not asked, the message is `handed_off`, the conversation has `Needs_Human` and the reason, the lead is `Escalated` (W3 does not alert again), and the 08:05 run does not alert a second time (U2, U3).

## What does not change

* By day: the patient gets the holding reply **and** the owner is alerted, byte for byte the same as before (U4: same Meta calls, same Grist data).
* At night everything that is not an emergency (questions, complaints) is still deferred to 08:05 with no message to anyone (U5): the AI is not asked at night.
* `TEST_MODE`: the urgent alert goes to `TEST_PHONE`, never to the owner (U7).

## Failure handling (U6)

If Meta refuses the alert, is unreachable, or the clinic has no valid `owner_phone`, the Run_Log row says `failed: URGENT ALERT NOT SENT: ...`, `Needs_Human` is set so the conversation shows in the Inbox, and nothing is retried automatically (a retry loop on an emergency path is its own risk). Watch Run_Log / FlowHQ for `failed` rows from `W13-ai-receptionist`. A DEMO simulated send (`w12_send_mode = simulate`) counts as done and says so.

## Decisions for the clinic (not made here)

* **The patient is not messaged at night even in an emergency**, because rule 5 forbids it and the AI gives no medical advice. A fixed "if this is a medical emergency, call 112" line would need a decision (and an approved template). The owner alert says "Contact the patient now."
* `staff_alert_phones` (several recipients) is in the schema but W13 has only ever alerted `owner_phone`. Unchanged.
* The weekly escalation and the new-lead alerts (W2 / W3 / MCC) are not emergencies and keep the quiet-hours rule.

## Tests

```
node n8n/snippets/urgent-alerts.test.js                  # the pure rules incl. a mutation check
node n8n/integrated/urgent-alerts.test.js                # U1–U9 end to end, quiet-hours switch OFF as in production
node n8n/integrated/urgent-alerts-mutations.test.js      # 9 deliberate breaks
```
The committed master ships with the temporary quiet-hours test switch ON (nothing is held at night while testing, see `QUIET-HOURS-SWITCH.md`); the tests switch it OFF in memory.
