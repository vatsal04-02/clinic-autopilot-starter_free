// Authenticates the request (shared secret header), checks the body, normalises it. NEVER reads a clinic / tenant / doc id from the body.
// Output feeds MCC – Respond (http_status + response_body) and MCC – Process? (action).
const cfg = $('MCC – Config').first().json;
const r = ceValidate({ headers: $json.headers, body: $json.body }, { secret: cfg.mcc_webhook_secret }, Date.now(), { normalizeIndianPhone });
return { json: { action: r.action, http_status: r.http_status, response_body: JSON.stringify(r.response), event: r.event || null } };
