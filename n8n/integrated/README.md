# Clinic Autopilot master with the AI receptionist integrated

This is your live master, "1 clinic total workflow" (W1, W2, W3, W4, W5, W6, W11, W12), with the AI receptionist built in as
**SECTION W13**. It uses the OpenRouter implementation from "W13 DEMO". The Anthropic W13 is **not** used.

It is one workflow with one execution path, and **W12 is the only WhatsApp sender**.

> **Status:** built from your export and tested in the simulator, with a fake Grist, a fake Meta and a fake OpenRouter that reads the real prompt.
> - It has not run in your n8n yet.
> - It is saved **inactive**.
> - Nothing here turns a clinic's `ai_mode` to `auto`.

| File | What it is |
|---|---|
| `clinic-autopilot-master-ai.json` | The integrated master, **public copy**. The Meta verify token, the Cal.com secret and your allowlisted number are placeholders. |
| *your private import file* | The same workflow with your own values kept exactly as exported. It was sent to you directly and is never committed. |
| `source/master-export.redacted.json` | Your export of the master, redacted the same way. The build starts from it. |
| `build-integrated.js` | Builds the integrated master from an export: `node n8n/integrated/build-integrated.js --in <export> [--keep-private]` |
| `validate-integrated.js` | 11 check groups proving that only the intended changes were made. Add `--private` for your import file. |
| `integrated.test.js` | 18 end-to-end check groups and 10 mutation tests (each integration point broken once). |
| `existing-modules.test.js` | The 25 existing W1/W3/W4/W5/W6/W11/W12 scenarios, run unchanged on the integrated master. |

## 1. End-to-end path

```
Patient ─► Meta ─► W2 – Webhook Inbound (POST /webhook/whatsapp-inbound, unchanged)
   W2 – Respond (200 to Meta, first) ─► parse ─► loop, one message at a time:
   clinic ─► phone ─► duplicate? ─► lead ─► conversation ─► Add Message ─► Update Conversation ─► Prepare Staff Alert   (all unchanged)
   ─► W2 – AI Wanted?  (only when the message was STORED: run_outcome ok, message row id > 0, not test data)
        yes ─► W2 – AI Job (the identifiers below) ─► W2 – Start AI Receptionist (THIS workflow, w13_job = true, no waiting)
               ─► W2 – AI Handed ─► W2 – Build Run Log ─► Run Log  (unchanged)
        no  ─► W2 – Build Run Log ─► Run Log (unchanged)

New execution of this workflow (one per message):
   W12 – When called by another workflow ─► W12 – AI Job?  (w13_job or w13_retry = true)
   ─► SECTION W13:
      Config ─► Start ─► Agency Registry ─► Settings, Knowledge, the Messages row, Conversation, Lead, last 40 messages, Booked appointments
      ─► Build Context: safety gates (already handled · STOP · ai_mode off · opted out · paused · Needs_Human · staff answered ·
                        newer message · night (deferred) · media · rate limit)
      ─► Claim (Messages.AI_Status = processing) ─► OpenRouter: Provider Request ─► Ask Model ─► Provider Answer
      ─► Plan: the JSON decision is validated (schema, confidence ≥ 0.7, complaint/payment/medical/human → person, fact check of
               prices / times / links / phone numbers against Knowledge and the real free slots)
      ─► appointment writes first (direct booking / WhatsApp-booked cancel; if one fails → hand-off)
      ─► W13 – Call W12 ─► THIS workflow again (wait) ─► W12 – AI Job? (no) ─► W12 (allowlist, quiet hours, 24 h window, TEST_MODE) ─► Meta
      ─► Record Sends ─► Grist: Messages (Intent, AI_Action, AI_Status, AI_Reply, AI_Reason, Needs_Human) · Conversations (Last_Intent,
         Needs_Human, Handoff_Reason) · LEADS (Lead_Stage, AI_Summary, Likely_Service, Contacted, First_Response_At, Next_Action_At,
         Opted_Out) · Run_Log

W13 – Every Morning (08:05, instance time zone like W6's 10:00) ─► messages deferred overnight ─► the same path (w13_retry = true)
W3 / W5 / W6 ─► "Call 'W12 - WhatsApp send'" ─► W12 – When called ─► W12 – AI Job? (no) ─► W12   (unchanged)
```

Other modules connect through Grist, the source of truth:
- A WhatsApp booking (`direct` mode) is a Booked Appointments row, so **W5** sends its reminders.
- In `link` mode the patient books on Cal.com and **W4** writes the booking.
- A real AI answer sets the lead to Contacted, so **W3** stops escalating it. A hand-off leaves the lead as New, so W3 keeps chasing staff.
- "Ask me later" sets Next_Action_At, which keeps **W6** from marking the lead Lost.

## 2. What changed (validate-integrated.js proves there is nothing else)

**Modified nodes (2):** `W12 – Prepare request` and `W12 – Read reply`. Only their pasted `wa-send.js` block changed (A-01): free-text messages inside the 24 h window, and the `human_handoff_alert` template. Templates behave exactly as before.

**Added nodes (51):**
- `W12 – AI Job?`: the IF right after W12's trigger. A workflow can have only one Execute Workflow Trigger, so W12 and the AI share it.
- `W2 – AI Wanted?`, `W2 – AI Job`, `W2 – Start AI Receptionist` and `W2 – AI Handed`.
- 44 SECTION W13 nodes. They are the OpenRouter demo's nodes, identical apart from their position, and `W13 – Config` > `w12_workflow_id` = `{{ $workflow.id }}`.
- The demo's own trigger, Manual Test, Test Messages, Run Each Test and Test Report are **not** included (one Manual Trigger per workflow). Do dry runs with the standalone W13 DEMO, kept inactive.
- 2 notes: `Section W13` and `W2 – Section G AI`.

**Rewired outputs (2):**
- `W12 – When called by another workflow` used to go to `W12 – Config`. It now goes to `W12 – AI Job?`, whose true branch goes to `W13 – Config` and false branch to `W12 – Config`.
- `W2 – Prepare Staff Alert` used to go to `W2 – Build Run Log`. It now goes to `W2 – AI Wanted?`:
  - true: `W2 – AI Job` → `W2 – Start AI Receptionist` → `W2 – AI Handed` → `W2 – Build Run Log`
  - false: `W2 – Build Run Log`

The other 193 nodes and 152 connections are byte-identical to your export, including: the webhooks and their ids, the Meta verify step, parsing, duplicate handling, lead and conversation logic, message storage, Build Run Log, Run Log, all Grist credentials, W1, W3–W6, W11 and the rest of W12.

**The payload from W2 to the AI** (`W2 – AI Job`), checked against the code of `W13 – Start`:

```json
{ "w13_job": true, "dry_run": false, "w13_retry": false,
  "wa_phone_number_id": "<Meta phone_number_id>", "clinic_slug": "<from the Agency Registry>",
  "message_row_id": <Messages row id W2 just created>, "wa_message_id": "<wamid…>", "msg_type": "text",
  "patient_phone": "+91XXXXXXXXXX", "sender_name": "<WhatsApp profile name>", "text": "<the message>" }
```
- **Configuration** (registry doc, leads table, model, thresholds) comes from `W13 – Config`, the one place to change it. Any config value sent in the payload would be overwritten there.
- **The text** that W13 answers is read from the stored Messages row, not from `text`, so a caller cannot make the AI answer something other than what W2 stored.

## 3. Import (keep it inactive)

1. **Grist:** the AI columns and the Knowledge table from `grist/schema.md` must exist. They do if the W13 DEMO already worked for you.
2. **Import your private file as a NEW workflow** (Workflows > Import from File). It arrives **inactive**, and your current master keeps running untouched.
   - On `W13 – Ask Model`, pick your **OpenRouter API** credential.
   - Save.
3. **Check, then switch over yourself:**
   - Deactivate the old master, activate the new one. Same webhook paths, so Meta, Cal.com and the website form keep their URLs.
   - Nothing inside refers to a workflow id: every call is `{{ $workflow.id }}`.
4. Keep the standalone **W13 DEMO inactive**. It's only for dry runs (Manual Test), and the integrated master already does its job. Never have both running the 08:05 retry.
5. The AI only acts for a clinic whose Settings has `ai_mode`:
   - missing = off;
   - `draft` = decide and write the CRM, send nothing to the patient;
   - `auto` = send through W12.
   TEST_MODE and the W12 allowlist still apply. That choice is yours.

## 4. Test results

`node n8n/tests/run-all.js` (24 files, all pass). For the integrated master:

| # | Test | Result |
|---|---|---|
| 0 | the build reproduces the committed file; Meta GET verification (right token 200 + challenge, wrong 403, no AI) | pass |
| 1 | normal patient message: Meta 200 first, ONE AI job (not awaited), reply via W12, Messages / Conversation / Run_Log (W2 + W13) | pass |
| 2 | service question, new patient: lead created by W2, services only from Knowledge, Contacted | pass |
| 3 | availability: only real free evening slots; an invented time is replaced | pass |
| 4 | booking: link mode (Cal.com link for that day), direct mode (Appointments row, lead Booked), taken slot (real alternatives) | pass |
| 5 | cancellation: Cal.com cancel link of that booking | pass |
| 6 | unknown question → hand-off: holding reply + `human_handoff_alert`, both via W12; Needs_Human; AI silent afterwards | pass |
| 7 | duplicate inbound: stored once, one AI job, one reply; two messages in one webhook = one job each | pass |
| 8 | invalid payload (400), delivery receipt, unknown clinic, bad number: no AI job, nothing sent | pass |
| 9 | AI failure (timeout, 429, malformed, schema-breaking): hand-off, nothing invented sent | pass |
| 10 | W12 failure (Meta 131047, Meta unreachable): failed + Needs_Human + Run_Log failed; W2 unaffected | pass |
| 11 | Grist failure: save fails or no row id (no AI job), claim fails (no AI), Settings unreadable (no AI), final write fails (AI execution errors → W11; W2 Run_Log ok) | pass |
| 12 | STOP: Opted_Out, nothing sent, next message not answered | pass |
| 13 | low confidence (0.55), medical, payment: hand-off, the AI text never sent | pass |
| 14 | gates: ai_mode off, draft, TEST_MODE → TEST_PHONE, paused, media, rate limit, made-up price / link | pass |
| 15 | night: deferred at 22:00 (no AI call), answered by W13 – Every Morning at 08:05 | pass |
| 16 | W3 / W5 / W6 items still go straight to W12 (no AI) | pass |
| — | 10 mutations (router off / all-AI, unstored message, waiting, Run_Log item, row id, w13_job, retry routing, A-01 removed, sends bypassing W12) | all caught |
| — | existing W1/W3/W4/W5/W6/W11/W12 scenarios on the integrated master | 25 / 25 pass |

## 5. Known limits

- **Simulator only.** Real OpenRouter, Meta and Grist behaviour comes in your first runs: use `ai_mode = draft` and TEST_MODE on.
- **Instance time zone.** `W13 – Every Morning` uses the instance time zone, as W6's "10:00" already does (the master has no time-zone setting).
- **Pre-existing unconnected node.** `W2 – Test Cases` was already unconnected in your export and is left as is: W2's manual-test trigger was removed when W2 joined the master.
- **Not covered by the AI layer:** W2 still does not verify Meta's `X-Hub-Signature-256`, and W6's day-2 follow-up ignores Lead_Stage and Next_Action_At (see `n8n/w13/README.md` section 5).
