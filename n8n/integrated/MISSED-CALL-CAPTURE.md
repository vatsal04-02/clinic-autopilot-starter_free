# MISSED_CALL_CAPTURE: a missed call becomes a lead, a simulated acknowledgement and a staff alert

**Demo / local only.** Nothing here sends a WhatsApp message to anyone. The acknowledgement goes through W12 in `simulate` mode:
it runs the real send guards (opt-out, pause, quiet hours, TEST_MODE, allowlist, template parameters), then writes a labelled row in
the Inbox and stops. There is no network call on that path, no Meta credential and no "delivered" status.

## 0. Name and numbering

The planning documents called this workflow "W14". `W14` and `W15` are **not** used (the repo's `W<n>-<name>` convention keeps them free), so this section
has a descriptive id instead. The mapping, for the project record:

| Concept | Where it lives |
|---|---|
| Capability id | `MISSED_CALL_CAPTURE` |
| n8n section | sticky note `Section MISSED_CALL_CAPTURE` in the single integrated workflow; every node is named `MCC – …` (57 nodes) |
| Webhook | `POST /webhook/missed-call` (production URL; `/webhook-test/missed-call` while testing in the editor) |
| Source | `n8n/mcc/sections.js` (node builder), `n8n/mcc/code/*.js` (node code), `n8n/snippets/call-events.js` (pure functions) |
| Patcher | `n8n/integrated/apply-missed-call-capture.js` (fingerprinted: refuses and writes nothing if the master differs) |
| Output | `n8n/integrated/clinic-autopilot-master-ai.missed-call-demo.json` (the master + this section + W12 simulate mode, saved inactive) |
| `Sent_By` / Run_Log names | `W12-missed-call-ack`, `W12-missed-call-alert` (the repo's `^W\d+` convention for automation senders), Run_Log workflow `MCC-missed-call-capture` |
| W12 | unchanged architecture: still the only sender, still called with `executeWorkflow` `={{ $workflow.id }}` |

The master (`clinic-autopilot-master-ai.json`, 323 nodes) is **not modified**. The demo file is a separate export; import it as a new workflow, inactive.

## 1. The request

`POST /webhook/missed-call`, header `X-Call-Secret: <your secret>`, JSON body (synthetic example):

```json
{
  "provider_call_id": "demo-call-0001",
  "called_number": "+919000000100",
  "caller_number": "+919000000021",
  "timestamp": "2026-10-13T11:00:00+05:30",
  "status": "missed",
  "duration_seconds": 12,
  "provider": "demo"
}
```

| Field | Rule |
|---|---|
| `provider_call_id` | required; 1–100 chars `A-Za-z0-9._:-`. **The dedupe key.** |
| `called_number` | required; the clinic's number. Looked up in the Agency Registry (`Clinics.Call_Number`). **This is the only thing that selects the clinic.** |
| `caller_number` | required; any common Indian mobile spelling, normalised to `+91XXXXXXXXXX` with `n8n/snippets/normalize-phone.js` |
| `timestamp` | required; ISO 8601 or epoch seconds / ms; not older than 48 h, not more than 10 min in the future |
| `status` | required; `missed`, `unanswered`, `no-answer`, `busy` are captured; `answered`, `completed`, `ringing` … answer 200 `ignored`; anything else is 400 |
| `duration_seconds` | optional, 0–86400 |
| `provider` | optional label (40 chars) |

A `clinic`, `tenant` or doc id in the body is **ignored** (test M5 puts a rival clinic's slug in the body and checks nothing moves).

| Answer | When |
|---|---|
| `200 {"ok":true,"status":"accepted","call_key":"call-…"}` | valid; processing continues after the answer |
| `200 {"ok":true,"status":"ignored","reason":"call_not_missed"}` | answered / ringing / completed |
| `400 {"ok":false,"error":"invalid_event","fields":[…]}` | malformed; the answer names the **fields**, never the values |
| `401` | missing or wrong `X-Call-Secret` (constant-time compare) |
| `503 {"error":"not_configured"}` | `MCC – Config > mcc_webhook_secret` is still a placeholder (`REPLACE_…`) or shorter than 8 characters: **fails closed** |

Unknown, inactive or ambiguous called number: the answer is still 200 (the provider is not told which numbers exist), nothing is written, and the run stops at `MCC – Unknown clinic` with an error that holds no full number.

## 2. What happens (after the 200)

1. Resolve the clinic from the registry by called number (10-digit key). Read its Settings. `missed_call_enabled` not `on` → one `skipped` Run_Log row, nothing else.
2. **Claim the event**: one Messages row, `Direction In`, `Template missed_call`, `WA_Message_ID call-<provider_call_id>`, `Status Received`, state in `AI_Action` (`mcc:claimed` → `mcc:ack_pending` → `mcc:ack_simulated|ack_sent|ack_deferred|ack_failed|ack_skipped`). Re-read: if two copies raced, the lowest row id owns the event, the other renames its own key (`…-dup-<id>`) and stops.
3. Find or create the lead (`Source Call`, `Name Caller <last4>`, `Status New`; matched by phone in any spelling) and the conversation. `Unread` + 1 (not on a retry). **`Last_Inbound_At` is never written**: a call does not open WhatsApp's 24 h free-text window.
4. Acknowledgement `missed_call_ack` through W12: skipped for an opted-out caller, a paused conversation or one a person owns; not repeated within 1 h for the same caller; deferred 21:00–08:00 IST.
5. Staff alert `new_lead_staff_alert` through W12 to `owner_phone`, regardless of the caller's state.
6. Final record: the event row gets its outcome; a `Run_Log` row (`MCC-missed-call-capture`) says `ok` / `skipped` / `failed`. A failed ack or alert is **logged as failed**, never as ok.
7. `MCC – Every 5 minutes` retries **one** event per run (oldest first) that failed, waited for the morning, or crashed after the claim: ≤ 3 tries, ≤ 20 h old, never an opted-out caller.

Idempotency: a provider retry (same `provider_call_id`) finds the row and answers `duplicate`: no second lead, ack, alert or Unread. A crash between the claim and the lead is finished on the same row after 120 s.

## 3. The acknowledgement template

`missed_call_ack` exists **only in simulate mode** (`WA_SIM_ONLY` in `wa-simulate.js`). It is **not** a Meta-approved template and the code does not pretend it is: in `live` or `allowlist` mode W12 refuses it (`ack_failed`, logged as a failure) and Meta never sees it. To go live later, submit the text to Meta, add it to `WA_TEMPLATES` in `wa-send.js` and the W12 pasted copies, and change this section's tests. That is a deliberate manual step; it is not part of the demo.

## 4. Simulate mode (W12)

`W12 – Config > w12_send_mode = simulate` (set by `--demo`). Exact word only. It cannot come from an item, Settings or the request.

| | `live` / `allowlist` (unchanged) | `simulate` |
|---|---|---|
| Guards (opt-out, pause, quiet hours, TEST_MODE, template parameters, 24 h window) | run | **the same code runs** (`waPrepare` with the recipient allow-listed for the probe) |
| Network / Meta credential | yes | **none** |
| Result | `sent`, Meta id | `sent:false`, `simulated:true`, `send_status:"simulated"`, id `sim-…` |
| Inbox row | `Status sent` | `[DEMO simulated, not sent] …`, `Status queued`, `Sent_By …[DEMO simulated: nothing was sent; would go to <to>]` |

## 5. Import and use (local, inactive)

1. Grist registry doc: add a Text column **`Call_Number`** to `Clinics` and fill it with the clinic's number (the demo clinic: a synthetic `+91 90000 00100`). A number in more than one active clinic is treated as ambiguous and rejected.
2. Each clinic doc, `Settings`: `missed_call_enabled` = `on`; `demo_mode` = `true` (adds `[DEMO]` labels); keep `TEST_MODE` = `true`.
3. Import `clinic-autopilot-master-ai.missed-call-demo.json` into **a separate, local n8n**. Keep it inactive until you have set `MCC – Config > mcc_webhook_secret` (a long random value) and re-checked the Grist credential on the `MCC – …` Grist nodes. Do not import it over the live workflow.
4. Test from the editor ("Listen for test event"), then activate the *local* copy. Do not expose the n8n editor; expose only `/webhook/missed-call` through your reverse proxy (see `docker-compose.yml` / Caddy), if at all.
5. Submit a call: see `n8n/demo/` (Stage G) or the `curl` in section 1.

## 6. Tests

```
node n8n/snippets/call-events.test.js                       # pure functions (10 groups)
node n8n/snippets/wa-simulate.test.js                       # simulate mode, with fetch / http / net trapped (7 groups)
node n8n/integrated/missed-call-capture.test.js             # the shipped JSON, end to end in the simulator (M1–M22)
node n8n/integrated/missed-call-capture-mutations.test.js   # 20 deliberate breaks, each must be caught
node n8n/integrated/validate-missed-call-capture.js         # before / after proof against the master (11 groups)
node n8n/tests/run-all.js                                   # everything, stops on the first failure
```

## 7. Known limits (not hidden)

- **Not verified against a real telephony provider.** No public, verified missed-call webhook contract was found for Exotel / Knowlarity / MyOperator; the payload above is this project's own contract. A provider adapter (map their fields into this body) is a manual step.
- Two simultaneous calls with *different* ids from the same new caller can create two leads (the claim protects the event, not the person). Rare; documented, not fixed.
- Toll-free `1800…` (11-digit) called numbers cannot be keyed by the 10-digit lookup.
- The retry handles one event per 5-minute run.
- Concurrency is tested by simulating a rival's rows at defined points (M9, M10), not with real parallel n8n executions.
- Grist has no atomic insert-if-absent; the claim → re-read → lowest-id rule is the substitute.
