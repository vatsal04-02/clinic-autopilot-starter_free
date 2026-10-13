// Meta webhook signature (X-Hub-Signature-256) for W2. Meta signs the EXACT bytes of every POST with HMAC-SHA256 and the app's App Secret:
//   X-Hub-Signature-256: sha256=<64 hex>
// The bytes matter: re-serialising the parsed JSON gives different bytes (Meta escapes non-ASCII as \uXXXX, spacing differs), so the check needs
// the RAW body (Webhook node option "Raw Body"). Pure functions, no network, no clock. Pasted into the "W2 – Verify Signature" Code node AFTER
// utf8Bytes / sha256Bytes / safeEqual from n8n/snippets/hmac-sha256.js. Paste from META_SIG_MODES down to (not including) the module.exports line.
//
// Modes (W2 – Signature Config > w2_signature_mode):
//   enforce  (default; any unknown word counts as enforce) a missing / wrong signature, a missing raw body or an unset App Secret = 401, nothing is read or written
//   log      verify and note the result, let the request through (for the first hour of a roll-out; NOT a protection)
//   off      no check at all (today's behaviour)
const { utf8Bytes, sha256Bytes, safeEqual } = typeof module !== 'undefined' ? require('./hmac-sha256') : {};   // Node tests only: in the n8n node the pasted hmac-sha256.js block provides these

const META_SIG_MODES = ['enforce', 'log', 'off'];

// HMAC-SHA256 of raw bytes (an array of 0-255) with a text key -> hex. (hmacSha256Hex in hmac-sha256.js takes a text message.)
function hmacSha256HexBytes(key, bytes) {
  let k = utf8Bytes(key);
  if (k.length > 64) k = sha256Bytes(k);
  while (k.length < 64) k.push(0);
  const inner = sha256Bytes(k.map((b) => b ^ 0x36).concat(Array.from(bytes)));
  const mac = sha256Bytes(k.map((b) => b ^ 0x5c).concat(inner));
  return mac.map((b) => b.toString(16).padStart(2, '0')).join('');
}

const metaSigSecretUsable = (secret) => { const s = String(secret === null || secret === undefined ? '' : secret); return s.length >= 8 && !/^(REPLACE_|PASTE_)/i.test(s); };
const metaSigMode = (m) => { const s = String(m === null || m === undefined ? '' : m).trim().toLowerCase(); return META_SIG_MODES.includes(s) ? s : 'enforce'; };

// The raw body out of the Webhook node's binary property (default in-memory storage: .data is base64). Returns bytes or null.
function metaSigRawBytes(binary) {
  const d = binary && binary.data;
  if (!d || typeof d.data !== 'string' || d.id || d.data === 'filesystem-v2' || d.data === 'filesystem') return null;   // not inline: another storage mode
  if (typeof Buffer === 'undefined') return null;
  return Array.from(Buffer.from(d.data, 'base64'));
}

// in: { headers, binary, secret, mode }. Returns { state, ok, reason }.
//   state 'ok' = signature verified | 'skipped' = mode off | 'warn' = mode log and NOT verified | 'bad' = reject (mode enforce)
// ok = true when the request may continue. reason is for the operator (execution data), never sent to the caller.
function metaSigVerify(input) {
  const mode = metaSigMode(input && input.mode);
  if (mode === 'off') return { state: 'skipped', ok: true, reason: 'w2_signature_mode is off' };
  const fail = (reason) => (mode === 'log' ? { state: 'warn', ok: true, reason } : { state: 'bad', ok: false, reason });
  if (!metaSigSecretUsable(input && input.secret)) return fail('meta_app_secret is not set (W2 – Signature Config)');
  const headers = {};
  for (const [k, v] of Object.entries((input && input.headers) || {})) headers[String(k).toLowerCase()] = Array.isArray(v) ? v[0] : v;
  const given = String(headers['x-hub-signature-256'] === undefined ? '' : headers['x-hub-signature-256']).trim();
  const m = /^sha256=([0-9a-fA-F]{64})$/.exec(given);
  if (!m) return fail(given ? 'X-Hub-Signature-256 is not in the form sha256=<64 hex>' : 'no X-Hub-Signature-256 header');
  const bytes = metaSigRawBytes(input && input.binary);
  if (!bytes) return fail('the raw body is not available (Webhook node option "Raw Body" off, or binary data is not stored in memory)');
  const expected = hmacSha256HexBytes(String(input.secret), bytes);
  return safeEqual(expected, m[1].toLowerCase()) ? { state: 'ok', ok: true, reason: '' } : fail('the signature does not match the body');
}

if (typeof module !== 'undefined') module.exports = { META_SIG_MODES, hmacSha256HexBytes, metaSigSecretUsable, metaSigMode, metaSigRawBytes, metaSigVerify };
