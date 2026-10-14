// The PATIENT / PHONE side of the demo: builds the exact requests the outside world sends to the workflow, so the scripted demo (in the simulator)
// and the console (against a local n8n) use the same bytes.
//   - a missed call:   POST /webhook/missed-call           header X-Call-Secret
//   - a WhatsApp text: POST /webhook/whatsapp-inbound      header X-Hub-Signature-256 = sha256=HMAC-SHA256(App Secret, raw body)   (Meta's format)
// Nothing here talks to the network except post(), which refuses every host that is not this machine.
const crypto = require('crypto');
const http = require('http');
const https = require('https');

// Meta sends ASCII JSON with \uXXXX escapes; the signature is over exactly those bytes.
const metaRaw = (body) => JSON.stringify(body).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const signMeta = (raw, appSecret) => `sha256=${crypto.createHmac('sha256', appSecret).update(raw).digest('hex')}`;

function whatsappBody({ text, from, id, phoneNumberId, name = 'Demo Patient', timestampSec }) {
  const wa = String(from).replace(/^\+/, '');
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'DEMO_WABA_ID', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId }, contacts: [{ profile: { name }, wa_id: wa }], messages: [{ from: wa, id, timestamp: String(timestampSec), type: 'text', text: { body: text } }] } }] }],
  };
}
// -> { raw, headers, body }: what Meta would POST
function whatsappRequest(opts, appSecret) {
  const body = whatsappBody(opts);
  const raw = metaRaw(body);
  return { raw, body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': signMeta(raw, appSecret) } };
}
function missedCallBody({ providerCallId, calledNumber, callerNumber, timestampSec, status = 'missed', durationSeconds = 0, provider = 'demo' }) {
  return { provider_call_id: providerCallId, called_number: calledNumber, caller_number: callerNumber, timestamp: timestampSec, status, duration_seconds: durationSeconds, provider };
}
const missedCallRequest = (opts, callSecret) => ({ body: missedCallBody(opts), headers: { 'content-type': 'application/json', 'x-call-secret': callSecret } });

const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', 'n8n']);
function assertLocal(baseUrl) {
  let u;
  try { u = new URL(baseUrl); } catch (e) { throw new Error(`not a URL: ${baseUrl}`); }
  if (!LOCAL.has(u.hostname)) throw new Error(`refusing to post to ${u.hostname}: the demo console only talks to this machine (localhost / 127.0.0.1 / the compose service "n8n")`);
  return u;
}
// POST raw text. Resolves { status, text }. Never logs headers (they hold the secrets).
function post(baseUrl, pathname, raw, headers) {
  const u = assertLocal(baseUrl);
  const lib = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({ hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: pathname, method: 'POST', headers: { ...headers, 'content-length': Buffer.byteLength(raw) }, timeout: 20000 }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(raw);
  });
}

module.exports = { metaRaw, signMeta, whatsappBody, whatsappRequest, missedCallBody, missedCallRequest, assertLocal, post };
