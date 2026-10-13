// Run: node n8n/snippets/meta-signature.test.js
// Meta's X-Hub-Signature-256 over the raw body: checked against Node's own crypto, with the cases that matter (unicode bodies, re-serialised JSON,
// every way a header or a secret can be wrong, all three modes).
const assert = require('assert');
const crypto = require('crypto');
const sig = require('./meta-signature');

const ok = (m) => console.log(`  ok  ${m}`);
const SECRET = 'app-secret-0123456789abcdef';
const sign = (body, secret = SECRET) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
const binary = (body) => ({ data: { data: Buffer.from(body).toString('base64'), mimeType: 'application/json' } });
const verify = (body, headers, over = {}) => sig.metaSigVerify({ headers, binary: binary(body), secret: SECRET, mode: 'enforce', ...over });

// ---------------------------------------------------------------- the HMAC itself, against Node's crypto
{
  let n = 0;
  for (const len of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 5000]) {
    for (const keyLen of [8, 20, 64, 65, 200]) {
      const body = crypto.randomBytes(len);   // arbitrary bytes, not valid UTF-8
      const key = crypto.randomBytes(keyLen).toString('hex').slice(0, keyLen);
      assert.strictEqual(sig.hmacSha256HexBytes(key, Array.from(body)), crypto.createHmac('sha256', key).update(body).digest('hex'), `len ${len} key ${keyLen}`);
      n++;
    }
  }
  assert.strictEqual(sig.hmacSha256HexBytes('Jefe', Array.from(Buffer.from('what do ya want for nothing?'))), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843', 'RFC 4231 case 2');
  ok(`HMAC over raw bytes equals Node crypto in ${n} cases (all padding boundaries, long keys, bytes that are not valid UTF-8) and the RFC 4231 vector`);
}

// ---------------------------------------------------------------- a real-looking Meta body
const BODY = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', contacts: [{ profile: { name: 'Asha' }, wa_id: '919000000011' }], messages: [{ from: '919000000011', id: 'wamid.X', timestamp: '1', type: 'text', text: { body: 'café नमस्ते 😀' } }] } }] }] });
{
  assert.deepStrictEqual(verify(BODY, { 'x-hub-signature-256': sign(BODY) }), { state: 'ok', ok: true, reason: '' });
  assert.strictEqual(verify(BODY, { 'X-Hub-Signature-256': sign(BODY) }).ok, true, 'header name in any case');
  assert.strictEqual(verify(BODY, { 'x-hub-signature-256': sign(BODY).toUpperCase().replace('SHA256=', 'sha256=') }).ok, true, 'hex in capitals');
  assert.strictEqual(verify(BODY, { 'x-hub-signature-256': [sign(BODY)] }).ok, true, 'a header given as a list');
  assert.strictEqual(verify(BODY, { 'x-hub-signature-256': `  ${sign(BODY)}  ` }).ok, true, 'surrounding spaces');
  ok('a correct signature is accepted (header name and hex case-insensitive, unicode body)');
}
{
  // the raw bytes matter: Meta escapes non-ASCII; a re-serialised copy is a different byte string
  const metaStyle = BODY.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);   // what Meta sends: ASCII with \uXXXX escapes
  assert.notStrictEqual(metaStyle, JSON.stringify(JSON.parse(metaStyle)));
  assert.strictEqual(verify(metaStyle, { 'x-hub-signature-256': sign(metaStyle) }).ok, true, 'signed raw bytes verify');
  const reserialised = JSON.stringify(JSON.parse(metaStyle));
  assert.strictEqual(verify(reserialised, { 'x-hub-signature-256': sign(metaStyle) }).ok, false, 'the signature of the raw bytes does not match the re-serialised JSON: re-serialising is not an option');
  assert.strictEqual(verify(`${metaStyle}\n`, { 'x-hub-signature-256': sign(metaStyle) }).ok, false, 'one extra byte');
  ok('the check is over the raw bytes: a re-serialised or padded body does not verify');
}
{
  const good = sign(BODY);
  const cases = [
    ['no header', {}, /no X-Hub-Signature-256 header/],
    ['empty header', { 'x-hub-signature-256': '' }, /no X-Hub-Signature-256 header/],
    ['sha1 header (old Meta format)', { 'x-hub-signature': good.replace('sha256', 'sha1') }, /no X-Hub-Signature-256 header/],
    ['wrong prefix', { 'x-hub-signature-256': good.replace('sha256=', 'sha1=') }, /not in the form/],
    ['no prefix', { 'x-hub-signature-256': good.slice(7) }, /not in the form/],
    ['short hex', { 'x-hub-signature-256': good.slice(0, -2) }, /not in the form/],
    ['non-hex', { 'x-hub-signature-256': `sha256=${'z'.repeat(64)}` }, /not in the form/],
    ['wrong secret', { 'x-hub-signature-256': sign(BODY, 'another-secret-value') }, /does not match/],
    ['tampered body', { 'x-hub-signature-256': sign(BODY.replace('Asha', 'Evil')) }, /does not match/],
    ['all zeros', { 'x-hub-signature-256': `sha256=${'0'.repeat(64)}` }, /does not match/],
  ];
  for (const [name, headers, re] of cases) {
    const r = verify(BODY, headers);
    assert.deepStrictEqual([r.ok, r.state], [false, 'bad'], name);
    assert(re.test(r.reason), `${name}: ${r.reason}`);
  }
  for (const secret of ['', undefined, null, 'short', 'REPLACE_WITH_META_APP_SECRET', 'PASTE_APP_SECRET_HERE']) {
    const r = verify(BODY, { 'x-hub-signature-256': sign(BODY, secret || 'x') }, { secret });
    assert.deepStrictEqual([r.ok, r.state], [false, 'bad'], `secret ${JSON.stringify(secret)}`);
    assert(/meta_app_secret is not set/.test(r.reason));
  }
  // a secret that is a placeholder never validates even when the attacker also "signs" with the placeholder
  assert.strictEqual(verify(BODY, { 'x-hub-signature-256': sign(BODY, 'REPLACE_WITH_META_APP_SECRET') }, { secret: 'REPLACE_WITH_META_APP_SECRET' }).ok, false);
  ok(`${cases.length} bad headers and 6 unusable secrets are all rejected, each with its own reason`);
}
{
  const good = { 'x-hub-signature-256': sign(BODY) };
  for (const b of [undefined, null, {}, { data: {} }, { data: { data: 123 } }, { data: { id: 'abc', data: 'filesystem-v2' } }, { data: { data: 'filesystem-v2' } }, { other: { data: 'e30=' } }]) {
    const r = sig.metaSigVerify({ headers: good, binary: b, secret: SECRET, mode: 'enforce' });
    assert.deepStrictEqual([r.ok, r.state], [false, 'bad'], JSON.stringify(b));
    assert(/raw body is not available/.test(r.reason));
  }
  assert.strictEqual(sig.metaSigVerify({ headers: good, binary: binary(''), secret: SECRET, mode: 'enforce' }).ok, false, 'an empty body with a signature of the real body');
  assert.strictEqual(sig.metaSigVerify({ headers: { 'x-hub-signature-256': sign('') }, binary: binary(''), secret: SECRET, mode: 'enforce' }).ok, true, 'and an empty body that is signed verifies');
  ok('a missing raw body (Raw Body option off, binary stored in a file) is a rejection, never a pass');
}
{
  const bad = { 'x-hub-signature-256': sign('other') };
  for (const mode of ['enforce', 'ENFORCE ', 'yes', 'on', 'true', '', undefined, null, 'strict']) assert.strictEqual(verify(BODY, bad, { mode }).ok, false, `mode ${JSON.stringify(mode)} = enforce`);
  assert.deepStrictEqual(sig.metaSigVerify({ headers: bad, binary: binary(BODY), secret: SECRET, mode: ' Log ' }), { state: 'warn', ok: true, reason: 'the signature does not match the body' });
  assert.deepStrictEqual(sig.metaSigVerify({ headers: {}, binary: undefined, secret: 'REPLACE_X', mode: 'log' }).state, 'warn');
  assert.deepStrictEqual(sig.metaSigVerify({ headers: {}, binary: undefined, secret: '', mode: 'off' }), { state: 'skipped', ok: true, reason: 'w2_signature_mode is off' });
  assert.strictEqual(verify(BODY, { 'x-hub-signature-256': sign(BODY) }, { mode: 'log' }).state, 'ok', 'log mode still says ok when it verifies');
  assert.deepStrictEqual(sig.META_SIG_MODES, ['enforce', 'log', 'off']);
  ok('modes: anything except the exact words "log" / "off" is enforce (a typo never opens the door); log lets a bad request through but says warn; off skips');
}
{
  // timing: the comparison is constant-time in the hex digits (no early exit on the first different character)
  const src = require('fs').readFileSync(require.resolve('./hmac-sha256'), 'utf8');
  assert(/diff \|= a\.charCodeAt\(i\) \^ b\.charCodeAt\(i\)/.test(src), 'safeEqual XORs every character');
  ok('the comparison is the constant-time safeEqual of hmac-sha256.js');
}
console.log('\nAll meta-signature cases pass');
