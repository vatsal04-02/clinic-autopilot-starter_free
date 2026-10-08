# Grist template: "Clinic CRM Template"

Build this once by hand in Grist, then duplicate it per clinic. Column names are exact:
n8n and every workflow depend on them. Change a name here first, then in the template.

## Tables

### Leads
| Column | Type | Notes |
|---|---|---|
| Lead_ID | Text | `L-YYYYMMDD-####`, set by n8n |
| Created_At | DateTime (Asia/Kolkata) | set by n8n |
| Name | Text | |
| Phone | Text | always `+91XXXXXXXXXX` |
| Source | Choice | Website, WhatsApp, Instagram, Call, Walk-in, Referral |
| Page_URL | Text | |
| UTM_Campaign | Text | |
| Enquiry | Text | patient's own words |
| AI_Summary | Text | set by n8n (optional) |
| Likely_Service | Text | set by n8n (optional) |
| Status | Choice | New (red), Contacted (amber), Booked (blue), Converted (green), Lost (grey) |
| Owner | Text | staff name |
| Next_Action_At | DateTime | next planned contact: staff, W13 ("ask me later"), W4 (now, on a Cal.com cancellation). In the future = W3 / W6 hold their automated step |
| First_Response_At | DateTime | set when status leaves New |
| Lost_Reason | Choice | No response, Price, Distance, Went elsewhere, Not a fit, Other |
| Opted_Out | Toggle | |
| Escalated | Toggle | set by n8n |
| Followup_Sent | Toggle | set by n8n |
| Notes | Text | no medical history |
| Lead_Stage | Choice | cold, warm, hot — set by W13 (AI); W3 / W6 order by it (hot first), W6 sends no day-2 follow-up to cold |
| Week | Formula | `$Created_At.date() - datetime.timedelta(days=$Created_At.weekday())` |
| Was_Booked | Formula | `$Status in ("Booked", "Converted")` |
| Response_Minutes | Formula | `($First_Response_At - $Created_At).total_seconds() / 60 if $First_Response_At else None` |

### Appointments
| Column | Type | Notes |
|---|---|---|
| Booking_UID | Text | Cal.com booking id, unique |
| Lead | Reference → Leads | |
| Service | Text | |
| Physio | Text | |
| Start | DateTime | |
| End | DateTime | |
| Status | Choice | Booked, Rescheduled, Cancelled, Completed, No-show |
| Fee_INR | Numeric | hidden from front desk by access rule |
| R24_Sent, R2_Sent, Rebook_Sent, Review_Sent | DateTime | set by n8n |
| Week | Formula | `$Start.date() - datetime.timedelta(days=$Start.weekday())` |
| Showed | Formula | `$Status == "Completed"` |
| No_Show | Formula | `$Status == "No-show"` |

### Conversations
Lead (Reference → Leads), Phone, Last_Inbound_At (DateTime), Unread (Integer), Automation_Paused (Toggle), Assigned_To (Text),
Needs_Human (Toggle — W13 ticks it when a person must answer. The AI stays off the handed-off message and anything older; a NEW patient message after the hand-off is handled by the AI again (and handed off again if needed). W13 never unticks it: staff untick it when done. Ticked by hand, without a hand-off from W13 = the AI stays silent),
Handoff_Reason (Text — why, set by W13), Last_Intent (Text — the AI's reading of the last message, set by W13).
W3, W5 and W6 read these (n8n/snippets/lead-context.js): Assigned_To / Needs_Human = a person owns it; Last_Intent not_interested / opt_out = no automated push;
a pending cancel / reschedule request with Needs_Human holds W5's 24 h reminder.

### Messages
Conversation (Reference → Conversations), Direction (Choice: In, Out), Body (Text), Template (Text), Sent_By (Text),
WA_Message_ID (Text, unique), Status (Choice: Received, queued, needs_template, sent, delivered, read, failed — W2 stores patient messages as Received),
Send (Toggle — the webhook's "ready" column), Created_At (DateTime)

Set by W13 (AI receptionist) on the patient's message (Direction In) — the conversation memory and its audit trail:
| Column | Type | Notes |
|---|---|---|
| Intent | Text | greeting, services_info, pricing, location_hours, availability_check, book_appointment, reschedule_appointment, cancel_appointment, appointment_status, follow_up_later, not_interested, thanks_ack, complaint, human_request, payment_issue, medical_question, other (opt_out for STOP) |
| AI_Action | Text | what W13 did: reply, offer_slots, book_slot, cancel_link, reschedule_link, cancelled, rescheduled, follow_up, handoff, no_reply, skip, opt_out, defer, failed |
| AI_Confidence | Numeric | 0–1, from the AI |
| AI_Status | Choice | processing, replied, drafted, handed_off, no_reply, skipped, opted_out, deferred, failed. **Empty = not handled yet**; W13 sets `processing` before it asks the AI (no double replies) |
| Needs_Human | Toggle | this message needs a person |
| AI_Reply | Text | the reply as sent (or the draft, in `draft` mode) |
| AI_Reason | Text | why (hand-off reason, fact-check result, send error) |

### Knowledge
The AI's only source of facts (services, prices, hours, address, policies). One row per fact, written by the clinic. Anything not
here, the AI hands to a person. Prices and times in a reply must appear in this table (W13 checks every reply).
| Column | Type | Notes |
|---|---|---|
| Title | Text | e.g. "Knee pain physiotherapy". For services, the AI copies this title into Leads.Likely_Service |
| Category | Choice | services, pricing, hours, location, policy, faq, general |
| Content | Text | the fact, in plain words, e.g. "₹800 per session (45 minutes)" |
| Active | Toggle | untick to hide a row from the AI (missing = active) |
Example rows: `n8n/w13/knowledge-base.sample.csv` (fake demo data: replace with the clinic's real facts).

### Settings
Key (Text), Value (Text). Rows: clinic_name, open_time, close_time, working_days, owner_phone,
staff_alert_phones, booking_link, review_link, services, TEST_MODE, TEST_PHONE,
ai_mode, booking_mode, slot_minutes, booking_capacity, booking_notice_minutes, handoff_reply (W13, all optional)

How the workflows read the values:
- `open_time`, `close_time`: 24-hour `09:00`, `19:30` (`9:00 AM` also works). Missing or unreadable = 08:00-21:00.
- `working_days`: `Mon-Sat`, `Mon,Tue,Thu` or `daily`. Missing or unreadable = every day.
- `owner_phone`, `TEST_PHONE`: one Indian mobile number in any common format (`98765 43210`, `+91 98765 43210`); the workflows turn it into `+91XXXXXXXXXX`.
- `TEST_MODE`: `true` or `false`. A missing row, or anything else, counts as ON (patient messages go to `TEST_PHONE`).
- `booking_link`: the full link patients use to book (e.g. the clinic's Cal.com page); W6 adds it to follow-up messages, W13 to replies (https only).
- `ai_mode` (W13): `off` (default, also when missing), `draft` (the AI decides and writes the CRM; the reply waits in Messages > AI_Reply for staff), `auto` (the reply is sent through W12).
- `booking_mode` (W13): `link` (default: the patient confirms on the booking link, Cal.com → W4 writes Appointments) or `direct` (W13 writes the Booked row itself).
- `slot_minutes` (30), `booking_capacity` (1 patient per slot), `booking_notice_minutes` (120): how W13 works out free times from open_time / close_time / working_days and the Booked appointments. No hours = W13 never offers a time.
- `handoff_reply`: what the patient gets when a person takes over (default: "Thank you for your message. A member of our team will reply to you shortly.").

### Run_Log
Workflow, Record, Outcome (Choice: ok, skipped, failed), Error, At (DateTime). W13 writes one row per message it handles
(`W13-ai-receptionist`, "Lead_id wamid intent -> action (status)").

## Agency Registry (a separate Grist doc, owned by the agency)
One doc, one table. Every workflow reads it first to find the clinic (see CLAUDE.md "Clinic lookup"). Never hard-code a clinic.

### Clinics
| Column | Type | Notes |
|---|---|---|
| Clinic_Slug | Text | unique; lowercase letters, digits, hyphens (e.g. `demo-physio`); the clinic's website sends it |
| Clinic_Name | Text | |
| Grist_Doc_ID | Text | the clinic's Grist doc id (the long id in the doc's URL) |
| WA_Phone_Number_ID | Text | Meta WhatsApp phone_number_id; empty until WhatsApp is connected |
| Active | Toggle | workflows ignore clinics where this is off |

## Pages
1. **Today** — 4 card lists: Status = New; Next_Action_At ≤ today; tomorrow's Booked appointments; yesterday's No-show with Rebook_Sent empty
2. **Pipeline** — 5 card lists side by side (one per Status) + summary table by Status
3. **Inbox** — Conversations table → linked Messages table (Select By: Conversation)
4. **Appointments** — Calendar widget on Start + table filtered to today
5. **Reports** — summary tables by Week / Source / Status + charts (see the Option B doc, section 7)

## Access rules
- Owner group: everything
- Front desk (Editors): cannot see Appointments.Fee_INR; cannot delete Leads/Appointments
- Nobody edits Messages where Direction = In, or Run_Log
- Only the agency account edits Settings and table structure
