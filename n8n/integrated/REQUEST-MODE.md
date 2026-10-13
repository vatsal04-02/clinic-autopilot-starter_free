# Request mode: the AI creates appointment REQUESTS, staff confirm them

**Per clinic, off by default.** `Settings > booking_mode = request` switches it on for that clinic. Any other value (`link`, `direct`, empty) behaves exactly as before: the end-to-end test runs 9 messages through the patched and the unpatched workflow and the replies and the Grist data are identical (R5).

## 1. What the patient and the staff see

1. The patient asks for one exact free day and time ("Book me for Saturday at 5").
2. W13 writes ONE Appointments row: `Status = Requested`, `Booking_UID = req-<WhatsApp message id>`, `Requested_At = now`, `Lead`, `Service`, `Start`, `End`. The lead is **not** marked Booked.
3. The patient gets a fixed text (written by code, not by the model): *"Thank you! We have noted your request for Sat 10 Oct at 5:00 PM. It is NOT confirmed yet: our team will check and confirm with you shortly."*
4. Staff open Appointments in Grist and set `Status` to **Booked** (confirm) or **Declined**. Until then nothing else happens: no reminder, no report line, no follow-up. (Telling the patient is the job of the confirmation section described at the end of this page.)

## 2. Safety rules (each is a test in `request-mode.test.js`, each is also broken on purpose in `request-mode-mutations.test.js`)

| Rule | How |
|---|---|
| The AI never writes a confirmed appointment | In request mode no plan may contain `Status Booked` or `Rescheduled`. A reschedule is a hand-off to a person (R10); the model saying "booked!" changes nothing (R4) |
| The reply never claims a booking | The reply to a request is fixed in code. A reply that calls a pending request "confirmed" is replaced by the truth; one that confirms an appointment that does not exist is handed to a person (R11) |
| A request triggers nothing and is never counted as confirmed | W5 reminders, W6 follow-ups, W7 check-ins, W8 review requests and W9's numbers read exact statuses (`Booked`, `Completed`, `No-show`, ...), so a `Requested` / `Declined` row is invisible to them. R14 sends a 24 h reminder for a Booked row and none for the same row as Requested; R16 adds requests to the data and shows W5, W6, W7, W8 send exactly the same messages and W9 reports exactly the same numbers. (The weekly "Total" counted every row: `apply-request-mode.js` changes that ONE line in `W9 – Metrics`.) |
| Two patients, one slot | A request **holds** its slot for `request_hold_hours` (default 24 h) so the next patient is not offered it and cannot request it (R6); it expires after that (R8). Capacity > 1 (`booking_capacity`) still leaves room |
| One patient, one request | Asking for the same time again repeats the existing request instead of writing a second row; the same WhatsApp message can never write two (R7). At most `max_pending_requests` (default 2) at a time, then a person takes over |
| A race nobody can prevent | Two patients can read the same free slot before either writes. Grist has no atomic insert. Both then hold a `Requested` row, **neither is Booked** (R9); the confirmation section (end of this page) lets only one become Booked |
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
