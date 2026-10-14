# FlowHQ Clinic Autopilot — local demo (₹0, simulated messaging)

**What you can show:** a patient phones the clinic and nobody answers → the call becomes a lead and a conversation, the team is alerted, a call-back message is *worked out* (not sent) → the patient writes in English or Hindi/Hinglish → the AI receptionist answers routine questions from the clinic's knowledge base → a request for a time becomes a **request, never a booking** → the team confirms or declines it in FLOW HQ → the patient is told once → medical questions, emergencies, STOP, duplicates, forged requests and a dead AI are all handled safely.

**What it never does:** send a real WhatsApp message, make or receive a real call, use a paid AI, touch a production n8n / Grist / clinic, or use a real patient record.

| Safety fact | How it is enforced (and tested) |
|---|---|
| No message leaves the machine | W12 – Config > `w12_send_mode = simulate`: every message is run through the real guards (opt-out, pause, quiet hours, TEST_MODE, 24 h window), logged as `[DEMO simulated, not sent]` with a `sim-…` id, and **not sent**. Meta is never called. `validate-demo-workflow.js` group 8; demo steps 1–16 assert it. |
| `TEST_MODE` stays on | The seed sets `TEST_MODE = true`: a message would go to the **test phone**, never to the patient's number. |
| No paid AI | W13 – Config > `model_provider = ollama` (a model on your own machine); OpenRouter is never called (the demo fails if it is). |
| Nothing is exposed | `docker-compose.demo.yml` publishes every port on `127.0.0.1` only: no proxy, no tunnel, no domain. The n8n editor and webhooks are reachable from this machine only. The patient console refuses any other host. |
| Production data cannot be reached by accident | The demo workflow has the **production registry id removed** (placeholder until you paste the demo one); the seed and the reset refuse a Grist document that holds a phone number outside the synthetic range `+91 9000000xxx`. |
| Secrets stay out of git | The workflow file holds placeholders; `fill-demo-config.js` writes a private `*.local.json` copy (git-ignored); `.env.demo` is git-ignored. |

---

## A. The scripted demo — nothing to install (verified)

```bash
node n8n/demo/run-demo.js            # the whole story as a transcript, 16 steps, 56 checks
node n8n/demo/run-demo.js --quiet    # just the verdict; exit code 0 only if every check passed
```

It runs the **combined demo workflow** (`clinic-autopilot-demo.json`, 421 nodes) in the in-repo n8n simulator, with a fake Grist holding only synthetic data, a **scripted model** standing in for Ollama, and a Meta / OpenRouter that must never be called. The phone and WhatsApp requests are built by the same code the console uses (signed exactly like Meta signs). Each step prints what happened and the checks it made.

What it proves: the wiring, the guards, the data written to Grist, the labels, the idempotency, the refusals.
What it does **not** prove: how well a real local model understands Hindi/Hinglish or phrases its answers (the model is scripted — see section F), a real n8n's behaviour (webhook raw body, scheduling), a real Grist, or any telephony provider.

## B. The live local stack — n8n + Grist (+ Ollama, + FLOW HQ) on your machine (**not verified here**)

> The build environment had no Docker daemon, Ollama, n8n or Grist, so these steps were **not executed end to end**. What *was* verified: the compose file's syntax and safety (`compose.test.js`), the Grist seed / check / reset against a fake Grist API (`seed-grist.test.js`), the console's requests against a local HTTP server, and the workflow in the simulator. Expect to fix small things on the first run and tell me.

**Needs:** Docker with Compose, ~16 GB free disk, 8+ GB RAM for a 7B model (or use a smaller model), Node 20+.

### Step 1 — configuration and containers
```bash
cp .env.demo.example .env.demo
./scripts/gen-demo-secrets.sh .env.demo            # fills the secrets; prints no value
# edit .env.demo: pin N8N_VERSION and GRIST_VERSION to exact versions
docker compose -f docker-compose.demo.yml --env-file .env.demo up -d
#   n8n  http://127.0.0.1:5678   (create the owner account on first visit)
#   Grist http://127.0.0.1:8484
```

### Step 2 — two Grist documents (by hand, once)
In Grist (http://127.0.0.1:8484):
1. **Agency Registry (demo)**: a document with a table `Clinics` (`Clinic_Slug, Clinic_Name, Grist_Doc_ID, WA_Phone_Number_ID, Active, Call_Number`).
2. **Demo Physio CRM**: a document with the tables of `grist/schema.md` (live names: `LEADS`, `Appointments`, `Conversations`, `Messages`, `Run_Log`, `Settings`, `Knowledge`), including the request-mode columns `Appointments.Requested_At`, `Appointments.Confirm_Sent` and the choices `Requested` / `Declined`.

Copy the two document ids (the part of the URL after `/doc/`), create an API key (Profile settings → API), then:
```bash
export GRIST_API_KEY=...                           # shell only, never in a file
node n8n/demo/seed-grist.js check --registry-doc <REGISTRY_ID> --clinic-doc <CLINIC_ID>   # names every missing table / column / choice
node n8n/demo/seed-grist.js seed  --registry-doc <REGISTRY_ID> --clinic-doc <CLINIC_ID>   # registry row, Settings, Knowledge (idempotent)
```
Put `DEMO_REGISTRY_ID` and the API key into `.env.demo` as `DEMO_REGISTRY_DOC_ID` / `DEMO_GRIST_API_KEY` if you will start FLOW HQ.

### Step 3 — local AI
```bash
# Ollama on the host:   ollama pull qwen2.5:7b-instruct          (the workflow default URL is http://host.docker.internal:11434)
# or the bundled one:   docker compose -f docker-compose.demo.yml --env-file .env.demo --profile ollama up -d
#                       docker compose -f docker-compose.demo.yml --env-file .env.demo exec ollama ollama pull qwen2.5:7b-instruct   (then use --ollama-url http://ollama:11434 below)
node n8n/tests/ollama-smoke.js                     # optional: does the model answer in the shape W13 needs? (exit 0 and "skipped" if Ollama is not running)
```

### Step 4 — the workflow
```bash
export DEMO_CALL_SECRET=$(grep ^DEMO_CALL_SECRET= .env.demo | cut -d= -f2) DEMO_META_APP_SECRET=$(grep ^DEMO_META_APP_SECRET= .env.demo | cut -d= -f2)
node n8n/demo/fill-demo-config.js --registry-doc <REGISTRY_ID> [--ollama-url http://ollama:11434]
#   -> n8n/demo/clinic-autopilot-demo.local.json   (private, git-ignored)
```
In n8n: **Workflows → Import from file** → that `.local.json`. Then:
- **Credentials:** create one *Header Auth* credential `Authorization: Bearer <your GRIST_API_KEY>` and select it where n8n asks for "Header Auth account 2" (and "Header Auth account" in W1). The WhatsApp Cloud API, OpenRouter and Telegram credentials are **not needed** and can stay empty (they are never used in simulate mode).
- Open **W12 – Config** and confirm `w12_send_mode` is `simulate` (it ships that way; leave it).
- Open **DEMO – Read Me** (the sticky note) for the reminders about what is switched off.
- **Activate** the workflow **only on this local n8n.** (Six scheduled jobs — W3, W5, W6, W7, W8, W9 — are switched off in this export on purpose; right-click → *Enable* turns one on, and its sends will log as "not sent" because they do not know "simulated".)

> `DISABLE_QUIET_HOURS_FOR_TEST = true` ships in 7 nodes (the master's temporary test switch), so the demo answers at any hour. To see the 21:00–08:00 rule live, set it to `false` in those nodes (step 16 of the scripted demo shows the behaviour).

### Step 5 — FLOW HQ (optional but it is the staff screen)
```bash
cp flowhq/config/users.example.json flowhq/config/users.json    # add a user with a password hash: see flowhq/README.md (H)
docker compose -f docker-compose.demo.yml --env-file .env.demo --profile flowhq up -d --build      # http://127.0.0.1:8787
```
The workspace shows the **DEMO · nothing is sent** badge (Settings `demo_mode`).

### Step 6 — run the demo
In a shell with `DEMO_CALL_SECRET`, `DEMO_META_APP_SECRET` exported (Step 4):

| # | You do | You should see |
|---|---|---|
| 1 | `node n8n/demo/patient-console.js missed-call` | Console: `HTTP 200 … "accepted"`. n8n: an execution of *MCC – Webhook*. FLOW HQ → Inbox: a new contact "Caller 00xx", a **Missed call** event, and a dashed *DEMO: not sent* call-back message. Grist: `LEADS` (Source Call), `Messages` (the `missed_call` event and the `[DEMO simulated, not sent]` ack), `Run_Log` ok. |
| 2 | `node n8n/demo/patient-console.js missed-call --id demo-call-001 --repeat 3` | Three `200`s, **one** lead, **one** ack: the other two are `skipped … duplicate` in Run_Log. |
| 3 | `node n8n/demo/patient-console.js script en` | "What services do you offer?", "How much is the first visit?", "Book me for Thursday at 5." — answers from the knowledge base (labelled DEMO), and the booking line becomes an `Appointments` row **Requested**, patient told "NOT confirmed yet". |
| 4 | `node n8n/demo/patient-console.js script hi` | Hindi/Hinglish lines. **Read the replies yourself:** this is where the real model's quality shows (section F). |
| 5 | FLOW HQ → Bookings → **Requests** → **Confirm** | Status becomes Booked; within ~2 minutes the *REQ – Every 2 minutes* run tells the patient (a simulated message, once). Confirming a time that is already taken is refused (`slot_taken`). **Decline** tells the patient we could not confirm. |
| 6 | `node n8n/demo/patient-console.js script medical` | Hand-off: the conversation shows *A person should reply*; the patient gets only "a member of our team will reply". Reply from the FLOW HQ composer: W10 sends it through W12 → shown as *DEMO: not sent*. |
| 7 | `node n8n/demo/patient-console.js script emergency --from +919000000024` | URGENT hand-off; the model is not asked; the owner alert is simulated. |
| 8 | `node n8n/demo/patient-console.js say STOP --from +919000000025`, then a missed call from that number | Opted out; no reply; the later call is recorded with **no call-back**. |
| 9 | Stop Ollama (`docker compose … stop ollama`, or quit the app), then `script hi` | One failed model call, then the **FAQ fallback** answers a clear price/hours question from the knowledge base (Run_Log says `fallback`); a booking line goes to a person. Start Ollama again. |
| 10 | Replay the same signed message / send with a wrong secret | Replay: processed once. Wrong secret or tampered body: HTTP 401, nothing written (`DEMO_META_APP_SECRET=wrong node … say hi`). |

The scripted version of exactly this story, with the assertions, is section A.

### Step 7 — reset and clean up
```bash
node n8n/demo/seed-grist.js reset --clinic-doc <CLINIC_ID>         # deletes the demo's leads / conversations / messages / requests / Run_Log; keeps Settings and Knowledge
                                                                   # refuses unless Settings.demo_mode is on AND every lead is synthetic
docker compose -f docker-compose.demo.yml --env-file .env.demo down -v      # throws away n8n, Grist, Ollama and FLOW HQ volumes: everything
rm -f n8n/demo/clinic-autopilot-demo.local.json .env.demo                   # the private copies
```

---

## C. Environment variables and safe defaults

| Variable | Where | Default / safe value |
|---|---|---|
| `N8N_VERSION`, `GRIST_VERSION` | `.env.demo` | **required** — pin exact versions |
| `N8N_ENCRYPTION_KEY`, `GRIST_SESSION_SECRET`, `FLOWHQ_SESSION_SECRET` | `.env.demo` | generated by `scripts/gen-demo-secrets.sh`; compose refuses to start without them |
| `GRIST_SANDBOX_FLAVOR` | `.env.demo` | `unsandboxed` (demo data only; never on a server) |
| `DEMO_REGISTRY_DOC_ID`, `DEMO_GRIST_API_KEY` | `.env.demo` | needed only for FLOW HQ |
| `GRIST_API_KEY`, `DEMO_GRIST_URL` | shell (seed script) | URL default `http://127.0.0.1:8484`; non-local hosts refused |
| `DEMO_N8N_URL` | shell (console) | `http://127.0.0.1:5678`; non-local hosts refused |
| `DEMO_CALL_SECRET`, `DEMO_META_APP_SECRET` | shell + `.env.demo` | made-up demo values (≥16 chars, different from each other) — **not** your real Meta App Secret |
| `DEMO_WA_PHONE_NUMBER_ID`, `DEMO_CALLED_NUMBER` | shell | `100000000000001`, `+919000000100` (synthetic) |
| `DEMO_VERIFY_TOKEN`, `DEMO_TEST_PHONES` | shell (fill script) | `demo-verify-token`; the two synthetic numbers |
| `DEMO_WORKFLOW_FILE` | tests / `run-demo.js` | the committed `clinic-autopilot-demo.json` |
| Workflow: `w12_send_mode` | W12 – Config | **`simulate`** |
| Workflow: `model_provider`, `ollama_base_url`, `ollama_model`, `ollama_allow_remote`, `faq_fallback` | W13 – Config | `ollama`, `http://host.docker.internal:11434`, `qwen2.5:7b-instruct`, `false`, `on` |
| Workflow: `w2_signature_mode` | W2 – Signature Config | `enforce` (unknown words also enforce) |
| Settings (per clinic, seeded) | Grist `Settings` | `TEST_MODE true`, `ai_mode auto`, `booking_mode request`, `missed_call_enabled on`, `demo_mode on`, `request_hold_hours 24`, `max_pending_requests 2`, `booking_capacity 1` |

## D. Where each piece lives (implementation record)

| Piece | Where | Notes |
|---|---|---|
| **MISSED_CALL_CAPTURE** (the missed-call section) | `n8n/mcc/sections.js`, `apply-missed-call-capture.js`, node prefix `MCC –`, `POST /webhook/missed-call`, Run_Log `MCC-missed-call-capture`, doc `n8n/integrated/MISSED-CALL-CAPTURE.md` | Deliberately **not** called "W14": the descriptive id and the `MCC –` prefix are used; **W14 / W15 stay unassigned**. W12 / W13 keep their shared-workflow architecture; every message is sent by a W12 run started with `$workflow.id`. |
| W12 simulate mode | `n8n/snippets/wa-simulate.js` | `sent:false, simulated:true, send_status:'simulated'`; callers that do not know the word fail closed. |
| Local AI + no-model fallback | `ai-ollama.js`, `ai-faq-fallback.js`, `apply-ollama-provider.js`, `OLLAMA-PROVIDER.md` | |
| Request mode / confirmation (`REQ –`) | `ai-request-mode.js`, `request-confirm.js`, `apply-request-mode.js`, `apply-request-confirm.js`, `REQUEST-MODE.md` | FLOW HQ's Confirm button uses the same `reqcTaken` / `reqcCapacity`. |
| Security / safety layers | `apply-w2-signature.js` (`W2-SIGNATURE.md`), `apply-urgent-alerts.js` (`URGENT-ALERTS.md`) | |
| **This demo** | `n8n/demo/` | `build-demo-workflow.js` chains the seven layers; `apply-demo-profile.js` is the last one. |
| FLOW HQ visibility | `flowhq/` (Requests view, Missed call events, DEMO labels, `README.md` F.1) | |

## E. Tests and what they prove

```bash
node n8n/tests/run-all.js                         # everything (stops at the first failure)
node n8n/demo/run-demo.js                         # the scripted demo, readable
node n8n/demo/demo.test.js                        # the same, as a test: 56 checks / 16 steps
node n8n/demo/demo-mutations.test.js              # 11 deliberate breakages: the demo must fail at the right step
node n8n/demo/validate-demo-workflow.js           # before/after proof against the master (11 groups)
node n8n/demo/demo-workflow-mutations.test.js     # 12 unsafe edits: the validator must fail
node n8n/demo/stack-regression.test.js            # the layers' own suites re-run on the stacked workflows
node n8n/demo/console.test.js                     # signed requests, local-only target, no secret printed
node n8n/demo/seed-grist.test.js                  # check / seed / reset against a fake Grist API
node n8n/demo/fill-demo-config.test.js            # the private config copy
node n8n/demo/compose.test.js                     # the compose file keeps its promises (+ `docker compose config`)
( cd flowhq && npm run typecheck && npm test )    # FLOW HQ
```

## F. Verified vs not verified — read this before you present it

**Verified (by tests that ran):** everything in section A; the patcher chain is reproducible and refuses on any mismatch; the master workflow file is byte-identical to the audited commit; the compose file is valid and local-only; the seed / reset / console / fill scripts behave as described against fakes.

**Not verified — needs you on a real machine:**
1. The live stack end to end (Docker, a real n8n importing this file, a real Grist, FLOW HQ against that Grist).
2. A real n8n delivering the **raw request body** to W2 (the Webhook node's *Raw Body* option) — the signature check assumes it; `W2-SIGNATURE.md` has the one-time live check.
3. A **real Ollama model**: JSON-schema compliance, speed on your hardware, and above all **Hindi / Hinglish understanding and wording**. The scripted demo cannot tell you; read the replies in step 4 and decide.
4. Any **telephony provider**: no public, verified missed-call webhook contract was found; the payload is this project's own (`MISSED-CALL-CAPTURE.md`). A provider needs a small adapter that maps its fields into that body.
5. Real WhatsApp delivery: deliberately out of scope (and disabled).

**Known limits (not hidden):**
- A lead made from a missed call keeps the placeholder name `Caller 00xx` until staff rename it (confirmation messages say "Hi Caller").
- A missed call counts as one inbound item in the weekly report's "Patient messages" and FLOW HQ's "Incoming messages" (both count it the same way).
- When the model is down, the Run_Log text still says "Claude request failed: Ollama: not reachable" (shared wording).
- Grist has no atomic insert: two patients can both hold a `Requested` for one slot; confirmation refuses the second (lowest row id wins). Two different-id calls at the same instant from one new caller can create two leads.
- W3 / W5–W9 do not know "simulated" and are switched off in this export.
- A quiet-hours emergency does not message the patient at night (the owner is alerted); that is a clinic policy decision.
