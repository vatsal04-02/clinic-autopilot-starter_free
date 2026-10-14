// The patient console: the bytes it sends are the bytes the workflow verifies, it refuses every host that is not this machine, and it never prints a secret.
// A throw-away HTTP server on 127.0.0.1 stands in for n8n. Run: node n8n/demo/console.test.js
const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');
const lib = require('./console-lib');
const { DEMO } = require('./demo-data');

const results = [];
const check = (id, title, fn) => Promise.resolve().then(fn).then(() => results.push({ id, title, ok: true }), (e) => results.push({ id, title, ok: false, why: e.message.split('\n')[0] }));
const APP_SECRET = 'console-test-app-secret-0123456789';

(async () => {
  await check('K1', 'a signed WhatsApp request: the header is HMAC-SHA256(App Secret, raw body) over exactly the raw bytes, unicode escaped like Meta does', () => {
    const req = lib.whatsappRequest({ text: 'नमस्ते, fees kitne ki hai? ₹', from: DEMO.callers.meera, id: 'wamid.X', phoneNumberId: DEMO.clinic.waPhoneNumberId, timestampSec: 1791264600 }, APP_SECRET);
    assert(/^[\x00-\x7f]*$/.test(req.raw), 'ASCII only (\\uXXXX escapes)');
    assert.strictEqual(req.headers['x-hub-signature-256'], `sha256=${crypto.createHmac('sha256', APP_SECRET).update(req.raw).digest('hex')}`);
    assert.strictEqual(JSON.parse(req.raw).entry[0].changes[0].value.messages[0].text.body, 'नमस्ते, fees kitne ki hai? ₹');
    assert.notStrictEqual(lib.signMeta(req.raw, 'another-secret'), req.headers['x-hub-signature-256']);
  });
  await check('K2', 'a missed-call request carries only the provider fields plus the secret header; the clinic is NOT in the body (the tenant comes from the called number)', () => {
    const req = lib.missedCallRequest({ providerCallId: 'c1', calledNumber: DEMO.clinic.callNumber, callerNumber: DEMO.callers.meera, timestampSec: 1 }, 'sekret');
    assert.deepStrictEqual(Object.keys(req.body).sort(), ['called_number', 'caller_number', 'duration_seconds', 'provider', 'provider_call_id', 'status', 'timestamp']);
    assert.strictEqual(req.headers['x-call-secret'], 'sekret');
  });
  await check('K3', 'only this machine is a valid target: localhost / 127.0.0.1 / ::1 / the compose service "n8n"; everything else (names that merely start with localhost, private ranges, real hosts) is refused', () => {
    for (const ok of ['http://127.0.0.1:5678', 'http://localhost:5678', 'http://[::1]:5678', 'http://n8n:5678']) lib.assertLocal(ok);
    for (const bad of ['https://example.org', 'http://localhost.evil.com', 'http://10.0.0.5:5678', 'http://192.168.1.10:5678', 'https://graph.facebook.com', 'http://127.0.0.1.nip.io', 'not a url']) assert.throws(() => lib.assertLocal(bad), bad);
  });
  await check('K4', 'post() delivers the exact signed bytes to a local server (the receiver can verify the signature on the raw body)', async () => {
    let got;
    const server = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { got = { headers: req.headers, raw: b, url: req.url }; res.end('{"status":"received"}'); }); });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const req = lib.whatsappRequest({ text: 'Namaste ₹', from: DEMO.callers.kavya, id: 'wamid.Y', phoneNumberId: DEMO.clinic.waPhoneNumberId, timestampSec: 5 }, APP_SECRET);
    const res = await lib.post(`http://127.0.0.1:${server.address().port}`, '/webhook/whatsapp-inbound', req.raw, req.headers);
    server.close();
    assert.deepStrictEqual([res.status, got.url, got.raw === req.raw], [200, '/webhook/whatsapp-inbound', true]);
    assert.strictEqual(got.headers['x-hub-signature-256'], `sha256=${crypto.createHmac('sha256', APP_SECRET).update(got.raw).digest('hex')}`);
  });
  await check('K5', 'the CLI: --dry-run prints the request but never a secret and never connects; a remote DEMO_N8N_URL is refused (exit 1) before anything is built', () => {
    const cli = path.join(__dirname, 'patient-console.js');
    const env = { ...process.env, DEMO_META_APP_SECRET: 'SENTINEL-APP-SECRET', DEMO_CALL_SECRET: 'SENTINEL-CALL-SECRET' };
    for (const args of [['say', 'Namaste', '--dry-run'], ['missed-call', '--dry-run'], ['script', 'hi', '--dry-run']]) {
      const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });
      assert.strictEqual(r.status, 0, r.stderr); assert(!/SENTINEL/.test(r.stdout + r.stderr), 'a secret was printed'); assert(/headers: content-type, x-(hub-signature-256|call-secret) \(hidden\)/.test(r.stdout));
    }
    const remote = spawnSync(process.execPath, [cli, 'say', 'hi', '--dry-run'], { encoding: 'utf8', env: { ...env, DEMO_N8N_URL: 'https://example.org' } });
    assert.strictEqual(remote.status, 1); assert(/refusing to post to example\.org/.test(remote.stderr)); assert(!/SENTINEL/.test(remote.stdout + remote.stderr));
    const noSecret = spawnSync(process.execPath, [cli, 'say', 'hi'], { encoding: 'utf8', env: { ...process.env, DEMO_META_APP_SECRET: '' } });
    assert.strictEqual(noSecret.status, 2); assert(/set DEMO_META_APP_SECRET/.test(noSecret.stderr));
  });
  const bad = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.id} ${r.title}${r.ok ? '' : `\n        ${r.why}`}`);
  console.log(bad.length ? `\n${bad.length} of ${results.length} PATIENT CONSOLE CHECKS FAILED` : `\nPATIENT CONSOLE: ${results.length} of ${results.length} checks pass`);
  process.exit(bad.length ? 1 : 0);
})();
