// REQUEST MODE for W13 (appointment REQUESTS that staff confirm, never AI bookings):
//   node n8n/integrated/apply-request-mode.js --in <workflow.json> [--out <file>] [--keep-private]
//
// Switched on PER CLINIC by Settings > booking_mode = request (any other value, or none: nothing changes for that clinic).
// Changes in existing nodes (each anchor is checked first; nothing is added or removed otherwise, connections are untouched):
//   W13 – Appointments  : the Grist filter reads Booked AND Requested rows (the existing readers ignore Requested, see ai-request-mode.test.js)
//   W13 – Build Context : n8n/snippets/ai-request-mode.js block + tail: free slots with other patients' requests held, this patient's pending
//                         requests, a request-mode addendum to the prompt
//   W13 – Plan          : the same block + a step before the result: a "Booked" write becomes a "Requested" write, the patient's reply is fixed
//                         in code ("NOT confirmed yet"), reschedules and made-up confirmations go to a person
//   W9 – Metrics        : the weekly "Total" appointments no longer counts Requested / Declined rows (one line)
// Grist: Appointments needs the Status choices Requested and Declined and a DateTime column Requested_At (see grist/schema.md). Without
// Requested_At the write fails and W13 hands the conversation to a person: nothing is half-done.
// Anything unexpected (a node edited in n8n, the patch already applied) = nothing is written. Output: active = false.
const fs = require('fs');
const path = require('path');
const { redact } = require('./redact');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const IN = arg('--in');
const OUT = arg('--out', path.join(__dirname, 'clinic-autopilot-master-ai.request-mode.json'));
const KEEP_PRIVATE = args.includes('--keep-private');
if (!IN) { console.error('usage: node apply-request-mode.js --in <workflow.json> [--out file] [--keep-private]'); process.exit(1); }
const fail = (m) => { console.error(`apply-request-mode: ${m}\nNothing was written.`); process.exit(1); };
const SRC = fs.readFileSync(path.join(__dirname, '..', 'snippets', 'ai-request-mode.js'), 'utf8');
const BLOCK = SRC.slice(SRC.indexOf('const AI_REQ_STATUS'), SRC.indexOf('if (typeof module'));

const FILTER_OLD = '={{ JSON.stringify({ Status: ["Booked"] }) }}';
const FILTER_NEW = '={{ JSON.stringify({ Status: ["Booked", "Requested"] }) }}';
const CTX_OLD = `const t0 = Date.now();
const { x, gate } = aiContext(raw, cfg, t0, h);
return [{ json: { x, gate, cfg, t0, request: gate.route === 'ai' ? aiBuildRequest(x, cfg) : null } }];
`;
const CTX_NEW = `const t0 = Date.now();
const { x, gate } = aiContext(raw, cfg, t0, h);
// REQUEST MODE (Settings > booking_mode = request): other patients' requests hold their slots, this patient's pending requests are listed, the prompt
// says "a request is not a booking". Any other clinic: these three calls change nothing.
aiReqPrepare(x, raw.appointments && Array.isArray(raw.appointments.records) ? raw.appointments.records : [], aiReqSettings(aiSettings(raw.settings && raw.settings.records)), t0, h);
const request = gate.route === 'ai' ? aiReqAddendum(aiBuildRequest(x, cfg), x) : null;
aiReqExpose(x);
return [{ json: { x, gate, cfg, t0, request } }];
`;
const PLAN_OLD = "return [{ json: { plan, decision, ai_error, usage, decided_at: Date.now(), dry_run: b.x.dry_run } }];\n";
const PLAN_NEW = `// REQUEST MODE: a booking the AI planned becomes a REQUEST (Status Requested) that staff confirm; the reply is fixed in code; a reschedule or a made-up
// confirmation goes to a person. Other clinics (booking_mode not "request"): b.x.request_mode is unset and this does nothing.
if (b.x.request_mode && b.gate.route === 'ai' && !$json.claim_error) {
  const apptRows = $('W13 – Appointments').first().json;
  aiReqFinalize(plan, decision, b.x, apptRows && Array.isArray(apptRows.records) ? apptRows.records : [], Math.floor(Date.now() / 1000), b.cfg);
}
${PLAN_OLD}`;

const wf = JSON.parse(fs.readFileSync(IN, 'utf8'));
const node = (name) => wf.nodes.find((n) => n.name === name) || fail(`node "${name}" is missing (is this the master with the W13 section?)`);
const once = (text, from, what) => { const n = text.split(from).length - 1; if (n !== 1) fail(`${what}: the expected text was found ${n} times (expected once): it was edited in n8n, or this is not the master with W13 prompt v2.2`); };
for (const n of ['W13 – Build Context', 'W13 – Plan']) if (node(n).parameters.jsCode.includes('aiReqPrepare') || node(n).parameters.jsCode.includes('aiReqFinalize')) fail(`"${n}" already has request mode`);

// 1. the appointments filter
{
  const a = node('W13 – Appointments');
  const q = a.parameters.queryParameters.parameters.find((p) => p.name === 'filter');
  if (!q || q.value !== FILTER_OLD) fail('"W13 – Appointments": the filter is not the expected { Status: ["Booked"] }');
  q.value = FILTER_NEW;
}
// 2. Build Context and Plan: the block + the tail
const marker = '// ---- this node ----\n';
const paste = (n, from, to, what) => {
  const code = n.parameters.jsCode;
  once(code, marker, `${n.name} marker`);
  once(code, from, `${n.name} ${what}`);
  n.parameters.jsCode = code.replace(marker, () => `// ---- pasted from n8n/snippets/ai-request-mode.js - keep identical ----\n${BLOCK}\n${marker}`).replace(from, () => to);
};
paste(node('W13 – Build Context'), CTX_OLD, CTX_NEW, 'tail');
paste(node('W13 – Plan'), PLAN_OLD, PLAN_NEW, 'return');

// 3. W9 – Metrics: the weekly "Total" counts the appointments that exist; a request, or a declined request, is not one. (Every other number is a
//    count of exact statuses and ignores requests already.) The pasted clinic-modules.js block in this ONE node differs by this line.
{
  const m = node('W9 – Metrics');
  once(m.parameters.jsCode, '      this_week: week.length,\n', 'W9 – Metrics this_week');
  m.parameters.jsCode = m.parameters.jsCode.replace('      this_week: week.length,\n', () => "      this_week: count(week, (a) => a.Status !== 'Requested' && a.Status !== 'Declined'),   // request mode: a request is not an appointment (patched, see apply-request-mode.js)\n");
}

// 4. a read-me next to Build Context
const [bx, by] = node('W13 – Build Context').position;
wf.nodes.push({
  parameters: {
    content: '## W13 — Request mode (Settings > booking_mode = request)\nThe AI never books. When a patient clearly asks for one exact free day and time, W13 writes an Appointments row with **Status = Requested** (Booking_UID `req-<wamid>`, Requested_At) and tells the patient it is **NOT confirmed**; staff confirm or decline it in Grist (Status = Booked / Declined).\n\n- A request holds its slot for `request_hold_hours` (default 24 h) so another patient is not offered it; max `max_pending_requests` (default 2) per patient.\n- Reminders (W5), follow-ups (W6), check-ins (W7), reviews (W8) and the weekly report (W9) only read Booked / Completed / No-show: a request triggers none of them and is never counted as confirmed.\n- A reschedule is a hand-off to a person; cancelling a request is allowed. A reply that calls a request "confirmed" is replaced by the truth.\n- Needs in Grist: Appointments.Status choices Requested + Declined, DateTime column Requested_At (grist/schema.md).',
    height: 300, width: 620,
  },
  name: 'W13 – Request Mode Read Me', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [bx - 40, by + 240], id: 'a3c41d27-6d0e-4a52-9b4e-0f1d2e7c5b61',
});

wf.active = false;
const report = [];
const out = KEEP_PRIVATE ? wf : redact(wf, report);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${OUT}: ${out.nodes.length} nodes (1 added: a sticky note), active = false`);
console.log('  - W13 – Appointments: filter reads Booked + Requested');
console.log('  - W9 – Metrics: the weekly appointment total does not count Requested / Declined rows');
console.log('  - W13 – Build Context, W13 – Plan: ai-request-mode.js block + tail (only for clinics with Settings > booking_mode = request)');
console.log(`redactions: ${KEEP_PRIVATE ? 'none (--keep-private)' : report.join('; ') || 'none needed'}`);
