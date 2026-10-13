# W2: verify Meta's `X-Hub-Signature-256`

Until now W2 trusted every POST to `/webhook/whatsapp-inbound`: anyone who knew the URL and a clinic's `phone_number_id` could post a fake patient message (and make the AI reply to it, or open the free-text window). Meta signs every real POST with your **App Secret**; this check refuses everything else. It is **on by default** (`enforce`), also in the demo: the demo's scripted patient messages are signed with a local demo secret like Meta's are.

## 1. What it does

```
POST /webhook/whatsapp-inbound
  -> W2 – Signature Config   (the App Secret + the mode; neither is passed on)
  -> W2 – Verify Signature   (HMAC-SHA256 of the RAW body, compared in constant time with the header)
  -> W2 – Signature OK?  -- yes -> W2 – Config -> ... (unchanged W2)
                         -- no  -> W2 – Respond Unauthorized: HTTP 401 {"status":"unauthorized"}; nothing is read, written or sent
```
* The signature is `sha256=` + the HMAC-SHA256 (hex) of the exact bytes of the request body with the App Secret as key. Re-serialising the parsed JSON does not give the same bytes (Meta escapes non-ASCII as `\uXXXX`), so the webhook node gets the option **Raw Body** and the check reads the raw bytes (`w2-signature.test.js` S3 shows a proxy-re-serialised body is refused, `meta-signature.test.js` shows why).
* The 401 reveals nothing (`{"status":"unauthorized"}`); the reason (`no X-Hub-Signature-256 header`, `the signature does not match the body`, `meta_app_secret is not set`, `the raw body is not available`) stays in the execution data of `W2 – Verify Signature`.
* The Meta GET verification (`hub.verify_token`) and the manual test node (`W2 – Test Cases`) do not go through it.
* Replays: Meta does not sign a timestamp, so a captured signed body can be replayed. W2 already deduplicates on the WhatsApp message id, so a replay changes nothing.

## 2. Modes (`W2 – Signature Config > w2_signature_mode`)

| Mode | Behaviour |
|---|---|
| `enforce` (default; **any other word counts as enforce**, so a typo cannot open the door) | missing / wrong signature, missing raw body, or an unset App Secret = 401. |
| `log` | verify and record the result (`__w2_sig = ok / warn`) but let the request through. A roll-out aid for the first minutes, **not a protection**. |
| `off` | today's behaviour (no check). |

The shipped file has the secret `REPLACE_WITH_META_APP_SECRET`: in `enforce` mode **every inbound message is rejected until you set it** (fail closed; S4).

## 3. Apply and roll out

```
node n8n/integrated/apply-w2-signature.js --in <workflow.json> [--out <file>] [--mode enforce|log|off] [--app-secret <secret>] [--keep-private]
```
Changes ONE existing node (`W2 – Webhook Inbound` gets Raw Body) and adds four; the rest of W2, credentials and all other webhooks are identical (S1). Anything unexpected = nothing written. `--app-secret` writes the secret into the file: it is then not redacted, name the file `*.local.json` (git-ignored) and never commit it. Without it, type the App Secret into `W2 – Signature Config` after importing.

1. Meta App Dashboard → **App settings → Basic → App Secret** (Show). Paste into `W2 – Signature Config > meta_app_secret`.
2. Import with `--mode log` first, keep the workflow inactive until the next step.
3. **Check it live (the one thing no offline test can prove):** send a real WhatsApp message to the test number, open the execution, open `W2 – Verify Signature` and read the output: `__w2_sig` must be `ok`. If it says `warn`, read `__w2_sig_reason`:
   * *the raw body is not available*: the Webhook node's **Raw Body** option is off, or n8n stores binary data on disk (`N8N_DEFAULT_BINARY_DATA_MODE=filesystem` / S3); this check needs the default in-memory mode.
   * *the signature does not match the body*: wrong App Secret (a different Meta app?), or a proxy changes the body.
4. Only when it says `ok`: set `w2_signature_mode` to `enforce`. Send a message again; then test that a forged `curl` gets a 401.

## 4. Tests

```
node n8n/snippets/meta-signature.test.js            # HMAC over raw bytes vs Node crypto, all header / secret / mode cases
node n8n/integrated/w2-signature.test.js            # the patched workflow end to end, S1–S9
node n8n/integrated/w2-signature-mutations.test.js  # 12 deliberate breaks, each must be caught
```

## 5. Verified, and not

* **Verified (simulator + Node crypto):** the HMAC agrees with Node's `crypto` over raw bytes (60 random cases + RFC 4231); a correct signature gives exactly the same replies and Grist data as the unpatched master; ten kinds of forged request get 401 with nothing read / written / sent; placeholders and unknown modes fail closed; the App Secret and the raw body are not passed on; the GET verification and the manual test are unchanged.
* **NOT verified:** that your n8n version's Webhook node (a) accepts the option name `rawBody` in the JSON as written and (b) delivers the raw bytes as binary property `data` with inline base64 under default storage. The simulator was handed that shape. Step 3 above is how you verify it once, for real. The Code node could not use `this.helpers.getBinaryDataBuffer` (the offline simulator is synchronous), so filesystem / S3 binary storage is not supported and shows up as "raw body is not available".
