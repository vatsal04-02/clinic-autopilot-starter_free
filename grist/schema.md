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
| Next_Action_At | DateTime | |
| First_Response_At | DateTime | set when status leaves New |
| Lost_Reason | Choice | No response, Price, Distance, Went elsewhere, Not a fit, Other |
| Opted_Out | Toggle | |
| Escalated | Toggle | set by n8n |
| Followup_Sent | Toggle | set by n8n |
| Notes | Text | no medical history |
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
Lead (Reference → Leads), Phone, Last_Inbound_At (DateTime), Unread (Integer), Automation_Paused (Toggle), Assigned_To (Text)

### Messages
Conversation (Reference → Conversations), Direction (Choice: In, Out), Body (Text), Template (Text), Sent_By (Text),
WA_Message_ID (Text, unique), Status (Choice: queued, needs_template, sent, delivered, read, failed),
Send (Toggle — the webhook's "ready" column), Created_At (DateTime)

### Settings
Key (Text), Value (Text). Rows: clinic_name, open_time, close_time, working_days, owner_phone,
staff_alert_phones, booking_link, review_link, services, TEST_MODE, TEST_PHONE

How the workflows read the values:
- `open_time`, `close_time`: 24-hour `09:00`, `19:30` (`9:00 AM` also works). Missing or unreadable = 08:00-21:00.
- `working_days`: `Mon-Sat`, `Mon,Tue,Thu` or `daily`. Missing or unreadable = every day.
- `owner_phone`, `TEST_PHONE`: one Indian mobile number in any common format (`98765 43210`, `+91 98765 43210`); the workflows turn it into `+91XXXXXXXXXX`.
- `TEST_MODE`: `true` or `false`. A missing row, or anything else, counts as ON (patient messages go to `TEST_PHONE`).

### Run_Log
Workflow, Record, Outcome (Choice: ok, skipped, failed), Error, At (DateTime)

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
