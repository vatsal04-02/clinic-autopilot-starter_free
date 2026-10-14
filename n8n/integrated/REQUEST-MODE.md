# Request mode: the AI creates appointment REQUESTS, staff confirm them

**Per clinic, off by default.** `Settings > booking_mode = request` switches it on for that clinic. Any other value (`link`, `direct`, empty) behaves exactly as before: the end-to-end test runs 9 messages through the patched and the unpatched workflow and the replies and the Grist data are identical (R5).

## 1. What the patient and the staff see

1. The patient asks for one exact free day and time ("Book me for Saturday at 5").
2. W13 writes ONE Appointments row: `Status = Requested`, `Booking_UID = req-<WhatsApp message id>`, `Requested_At = now`, `Lead`, `Service`, `Start`, `End`. The lead is **not** marked Booked.
3. The patient gets a fixed text (written by code, not by the model): *"Thank you! We have noted your request for Sat 10 Oct at 5:00 PM. It is NOT confirmed yet: our team will check and confirm with you shortly."*
4. Staff open Appointments in Grist and set `Status` to **Booked** (confirm) or **Declined**. Until then nothing else happens: no reminder, no report line, no follow-up. The REQ section (§7) then tells the patient and refuses a confirmation that would double-book.

## 2. Safety rules (each is a test in `request-mode.test.js`, each is also broken on purpose in `request-mode-mutations.test.js`)

| Rule | How |
|---|---|
| The AI never writes a confirmed appointment | In request mode no plan may contain `Status Booked` or `Rescheduled`. A reschedule is a hand-off to a person (R10); the model saying "booked!" changes nothing (R4) |
| The reply never claims a booking | The reply to a request is fixed in code. A reply that calls a pending request "confirmed" is replaced by the truth; one that confirms an appointment that does not exist is handed to a person (R11) |
| A request triggers nothing and is never counted as confirmed | W5 reminders, W6 follow-ups, W7 check-ins, W8 review requests and W9's numbers read exact statuses (`Booked`, `Completed`, `No-show`, ...), so a `Requested` / `Declined` row is invisible to them. R14 sends a 24 h reminder for a Booked row and none for the same row as Requested; R16 adds requests to the data and shows W5, W6, W7, W8 send exactly the same messages and W9 reports exactly the same numbers. (The weekly "Total" counted every row: `apply-request-mode.js` changes that ONE line in `W9 – Metrics`.) |
| Two patients, one slot | A request **holds** its slot for `request_hold_hours` (default 24 h) so the next patient is not offered it and cannot request it (R6); it expires after that (R8). Capacity > 1 (`booking_capacity`) still leaves room |
| One patient, one request | Asking for the same time again repeats the existing request instead of writing a second row; the same WhatsApp message can never write two (R7). At most `max_pending_requests` (default 2) at a time, then a person takes over |
| A race nobody can prevent | Two patients can read the same free slot before either writes. Grist has no atomic insert. Both then hold a `Requested` row, **neither is Booked** (R9); the REQ section (§7) lets only one become Booked |
| Cancel | The patient can cancel a request ("cancel my request"): the row becomes `Cancelled` (R10) |
| Everything before the model | STOP, emergencies, hand-offs, `ai_mode` off / draft, the hourly limit and the staff-owns-the-chat rule are unchanged and still come first (R12). In `draft` mode the request row is still created for staff and the patient is not messaged |
| A failed write is not promised | If the Grist write fails (for example the column `Requested_At` does not exist yet) the patient gets the holding reply and a person is alerted (R13) |

## 3. Settings (per clinic, Grist `Settings`)

| Key | Default | |
|---|---|---|
| `booking_mode` | `link` | `request` = this page. `link` / `direct` as before |
| `request_hold_hours` | `24` (1–168) | how long a request holds its slot |
| `max_pending_requests` | `2` (1–5) | open requests per patient |

## 4. Grist migration (by hand, per clinic doc; nothing is lost if you skip it, request mode just fails safe)

1. `Appointments.Status` (Choice): add **`Requested`** and **`Declined`** to the existing choices. A value that is not in the list is stored but shown in red.
2. `Appointments`: add a **`Requested_At`** column (DateTime, timezone Asia/Kolkata, like `Start`). Without it the request write fails and W13 hands the conversation to a person.
3. For the confirmation step add **`Confirm_Sent`** (DateTime) as well.
4. Optional, for staff: a formula column `Slot_Conflict` = `len([a for a in Appointments.all if a.id != $id and a.Status in ("Booked", "Rescheduled") and a.Start < $End and a.End > $Start]) >= 1` shows which request overlaps a confirmed appointment (adapt the capacity).
5. `Settings`: add the row `booking_mode` = `request`.

Rollback: set `booking_mode` back. Existing `Requested` rows stay in the table; every workflow ignores them.

## 5. How to apply

```
node n8n/integrated/apply-request-mode.js --in <workflow.json> [--out <file>] [--keep-private]
```
Changes four existing nodes and adds one sticky note; connections and credentials are untouched. Each anchor is checked first; the script refuses (writes nothing) if a node was edited in n8n or request mode is already applied.

| Node | Change |
|---|---|
| `W13 – Appointments` | the Grist filter reads `Booked` **and** `Requested` rows (every existing reader ignores `Requested`, see `ai-request-mode.test.js`) |
| `W13 – Build Context` | `ai-request-mode.js` block; for request-mode clinics: slots with other patients' requests held, this patient's pending requests, a prompt addendum |
| `W13 – Plan` | the same block and one step before the result: Booked write → Requested write, fixed reply, reschedule / false confirmation → person |
| `W9 – Metrics` | one line: the weekly "Total" appointments ignores `Requested` / `Declined` |

## 6. Tests

```
node n8n/snippets/ai-request-mode.test.js                  # pure functions
node n8n/integrated/request-mode.test.js                   # the patched workflow end to end, R1–R16
node n8n/integrated/request-mode-mutations.test.js         # 15 deliberate breaks, each must be caught
```

## 7. The confirmation step (section `REQUEST_CONFIRM`, nodes `REQ –`, every 2 minutes)

```
node n8n/integrated/apply-request-confirm.js --in <workflow.json> [--out <file>] [--keep-private]
```
Adds 25 `REQ –` nodes and a sticky note; **nothing existing is changed** (C1). Only for clinics with `booking_mode = request`; only `Appointments` rows whose `Booking_UID` starts with `req-`; Cal.com and WhatsApp bookings are never looked at (C10).

| Staff set the row to | and | the section |
|---|---|---|
| **Booked** | the slot is free | writes `Confirm_Sent` FIRST (so the patient is never told twice), then tells the patient through **W12** (free text in the 24 h window, else the approved `booking_confirmation` template), marks the lead Booked (never downgrades Booked / Converted), writes a `REQ-request-confirm` Run_Log row. W5 then reminds like for any Booked appointment (C13) |
| **Booked** | the slot is **already taken** (a Cal.com booking, another confirmed row; capacity = `booking_capacity`) | **refuses**: nothing is sent, the row goes back to **Requested**, Run_Log (`failed`) says "double booking prevented: ... is already taken by ...". The check is made at confirmation time, so a booking that arrived after the patient asked is caught too (C8). Two requests confirmed together: the **lowest row id** keeps the slot (C7) |
| **Declined** | | tells the patient (free text). Outside the 24 h window no template exists, W12 refuses and Run_Log says so: tell the patient by phone (C5). One attempt, never repeated |

Guards before every message (C9): `Confirm_Sent` (once), `Opted_Out` (never), quiet hours 21:00–08:00 IST (the message waits, nothing is claimed, it goes at 08:00), `TEST_MODE` (to `TEST_PHONE`). A paused conversation does not stop a confirmation of the patient's own request.
Failures (C11): if the claim write fails nothing is sent; if Meta refuses or is unreachable the Run_Log row says `failed` and the flag stays set (no retry storm); if a refusal cannot be written back, Run_Log says so and asks staff to fix the Status by hand.

Tests: `node n8n/snippets/request-confirm.test.js` (rules), `node n8n/integrated/request-confirm.test.js` (C1–C13 end to end, incl. the whole life of a request: ask → request → confirm → one reminder), `node n8n/integrated/request-confirm-mutations.test.js` (15 breaks).

**Not covered / known limits.** Two runs of this section overlapping (the schedule is every 2 minutes; a run takes seconds) could in theory both read a row before the claim: the same limit as W7/W8. A patient who is also reachable only by phone is not told about a decline outside the 24 h window (the Run_Log row is the signal).
