// The scripted PATIENT CONSOLE: sends a missed call or a WhatsApp message to YOUR LOCAL n8n (never anywhere else) so you can watch the receptionist work.
//   node n8n/demo/patient-console.js missed-call [--caller +919000000021] [--id demo-call-001] [--repeat 2]
//   node n8n/demo/patient-console.js say "What services do you offer?" [--from +919000000021]
//   node n8n/demo/patient-console.js script en|hi|medical|emergency [--from +919000000021]
//   add --dry-run to print what would be sent (secrets hidden) without sending.
// Environment (put them in your shell or demo/.env.demo; never commit them):
//   DEMO_N8N_URL (default http://127.0.0.1:5678)  DEMO_CALL_SECRET  DEMO_META_APP_SECRET  DEMO_WA_PHONE_NUMBER_ID  DEMO_CALLED_NUMBER
// Only localhost / 127.0.0.1 / the compose service name "n8n" are accepted as the target. Nothing is sent to Meta, a phone or a patient.
const { DEMO, SCRIPT } = require('./demo-data');
const lib = require('./console-lib');

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);
const cmd = argv[0];
const BASE = process.env.DEMO_N8N_URL || 'http://127.0.0.1:5678';
const DRY = has('--dry-run');
const caller = flag('--caller', flag('--from', DEMO.callers.meera));
const need = (name) => { const v = process.env[name]; if (!v) { console.error(`set ${name} (see n8n/demo/DEMO.md, "Environment")`); process.exit(2); } return v; };
const nowSec = () => Math.floor(Date.now() / 1000);
let counter = Date.now();
const show = (title, r) => console.log(`${title}\n  -> HTTP ${r.status} ${String(r.text).slice(0, 200)}`);

async function missedCall() {
  const repeat = Number(flag('--repeat', 1));
  const id = flag('--id', `demo-call-${counter}`);
  const calledNumber = process.env.DEMO_CALLED_NUMBER || DEMO.clinic.callNumber;
  for (let i = 0; i < repeat; i++) {
    const req = lib.missedCallRequest({ providerCallId: id, calledNumber, callerNumber: caller, timestampSec: nowSec() - 5 }, DRY ? 'hidden' : need('DEMO_CALL_SECRET'));
    const raw = JSON.stringify(req.body);
    if (DRY) { console.log(`POST ${BASE}/webhook/missed-call\n  ${raw}\n  headers: content-type, x-call-secret (hidden)`); continue; }
    show(`missed call ${id} from ${caller} to ${calledNumber}${repeat > 1 ? ` (delivery ${i + 1} of ${repeat}: the same event must be processed once)` : ''}`, await lib.post(BASE, '/webhook/missed-call', raw, req.headers));
  }
}
async function say(text) {
  const phoneNumberId = process.env.DEMO_WA_PHONE_NUMBER_ID || DEMO.clinic.waPhoneNumberId;
  const req = lib.whatsappRequest({ text, from: caller, id: `wamid.DEMO.${counter++}`, phoneNumberId, timestampSec: nowSec() }, DRY ? 'hidden' : need('DEMO_META_APP_SECRET'));
  if (DRY) { console.log(`POST ${BASE}/webhook/whatsapp-inbound\n  ${req.raw}\n  headers: content-type, x-hub-signature-256 (hidden)`); return; }
  show(`${caller} says: ${text}`, await lib.post(BASE, '/webhook/whatsapp-inbound', req.raw, req.headers));
}
async function script(name) {
  const lines = name === 'en' ? Object.values(SCRIPT.en) : name === 'hi' ? Object.values(SCRIPT.hi) : name === 'medical' ? [SCRIPT.medical] : name === 'emergency' ? [SCRIPT.emergency] : null;
  if (!lines) { console.error('script: en | hi | medical | emergency'); process.exit(2); }
  for (const l of lines) { await say(l); if (!DRY) await new Promise((r) => setTimeout(r, 4000)); }   // the assistant answers before the next line (a local model needs seconds)
}

(async () => {
  try {
    lib.assertLocal(BASE);
    if (cmd === 'missed-call') await missedCall();
    else if (cmd === 'say' && argv[1]) await say(argv[1]);
    else if (cmd === 'script') await script(argv[1]);
    else { console.error('usage: patient-console.js missed-call | say "<text>" | script en|hi|medical|emergency   [--from +91...] [--dry-run]'); process.exit(2); }
  } catch (e) { console.error(`patient-console: ${e.message}`); process.exit(1); }
})();
