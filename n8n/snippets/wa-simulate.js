// W12 SIMULATE MODE (DEMO ONLY): the same checks as a real send, but NOTHING leaves the machine. Pure functions, no network.
// Pasted (with n8n/snippets/wa-send.js, which it wraps and does not change) into W12 – Prepare request and W12 – Read reply
// by n8n/integrated/apply-missed-call-capture.js. Paste from WA_SIM_ONLY down to (not including) the module.exports line.
//
// How it is selected: ONLY by W12 – Config > w12_send_mode = "simulate" (the exact word). "live" and "allowlist" never reach this
// code: the node tail runs waPrepare for them, byte-for-byte as before. A caller's item cannot choose the mode.
// What it does: waSimulate runs the REAL waPrepare (opt-out / pause decision, valid phone, phone number id, template variables,
// 24 h window for free text, quiet hours) with the allowlist step satisfied for this one recipient, then, instead of a Meta
// request, returns a result marked simulated. It never builds a Meta URL or request, so there is nothing to call.
// What it never claims: a simulated result has sent = false and send_status = "simulated". Every caller treats "not sent" as
// not sent (no sent flag is ticked), and the CRM rows say DEMO / simulated in plain words.
//
// Template intents that exist only for the demo (no Meta-approved template behind them): WA_SIM_ONLY. In live / allowlist mode
// waPrepare does not know them and refuses ("unknown template"), so a missing approval can never look like a sent message.
// helpers `h`: normalizeIndianPhone, waPrepare, waInboxPlan, waInboxRow (and inQuietHours inside waPrepare's own h).

const WA_SIM_ONLY = {
  missed_call_ack: { params: ['clinic_name'], text: (p) => `Namaste! Sorry, we missed your call to ${p.clinic_name}. How can we help you today?` },
};

// true only for the exact mode word (case and spaces ignored, like waPrepare's own mode check)
function waIsSimulate(cfg) {
  return String(cfg && cfg.send_mode !== undefined && cfg.send_mode !== null ? cfg.send_mode : '').trim().toLowerCase() === 'simulate';
}

// Same contract as waPrepare: { call_meta, send_status, send_error, ... }. call_meta is ALWAYS false.
function waSimulate(input, cfg, nowMs, h) {
  const simOnly = input && input.message_type !== 'text' && Object.prototype.hasOwnProperty.call(WA_SIM_ONLY, input.template) ? WA_SIM_ONLY[input.template] : null;
  const probe = simOnly ? { ...input, template: 'hello_world', template_params: {} } : input;   // a registered template: every real check still runs
  const d = input && input.decision;
  const to = d ? h.normalizeIndianPhone(d.to).phone : null;
  const live = h.waPrepare(probe, { ...cfg, send_mode: 'allowlist', allowlist: to || '' }, nowMs, h);
  if (!live.call_meta) return live;                                       // a normal refusal stays a refusal
  let intentParams = null;
  if (simOnly) {
    intentParams = {};
    for (const key of simOnly.params) {
      const v = waCleanParamSim((input.template_params || {})[key]);
      if (!v) return { call_meta: false, send_status: 'invalid', send_error: `template ${input.template}: variable "${key}" is empty` };
      intentParams[key] = v;
    }
  }
  const would_send = live.meta_request.type === 'text'
    ? { type: 'text', text: live.meta_request.text.body }
    : simOnly
      ? { type: 'template', template: input.template, params: simOnly.params.map((k) => intentParams[k]), preview: simOnly.text(intentParams), approved_template: false }
      : { type: 'template', template: live.meta_request.template.name, params: (((live.meta_request.template.components || [])[0] || {}).parameters || []).map((p) => p.text), approved_template: true };
  return { call_meta: false, simulated: true, send_status: 'simulated', send_error: '', to: live.to, would_send };
}

function waCleanParamSim(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 250);
}

// Small stable hash for the fake message id (never a Meta id: it starts with "sim-").
function waSimId(prep, nowMs) {
  const s = `${prep.to}|${JSON.stringify(prep.would_send)}|${nowMs}`;
  let x = 5381;
  for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) >>> 0;
  return `sim-${x.toString(36)}`;
}

// W12 – Read reply, simulated branch: the "response" is the simulate result, not a Meta answer.
function waSimulatedResult(prep, nowMs) {
  return {
    send_status: 'simulated',
    simulated: true,
    sent: false,                       // never "delivered": nothing was sent
    wa_message_id: waSimId(prep, nowMs),
    send_error: '',
    send_error_code: null,
    send_http_status: null,
    would_send: prep.would_send,
    to: prep.to,
  };
}

// Should the simulated send be written to the Grist inbox (so the demo thread shows it)? Same rules as a real attempt.
function waSimInboxPlan(input, cfg, res, h) {
  return h.waInboxPlan(input, cfg, { ...res, send_status: 'accepted' }, h);
}

// The Messages row for a simulated send: plainly labelled, Send stays false, never "sent" / "delivered".
function waSimInboxRow(input, res, nowSec, h) {
  const row = h.waInboxRow(input, { ...res, send_status: 'accepted' }, nowSec);
  const preview = res.would_send && res.would_send.preview ? res.would_send.preview : '';
  const body = String(row.Body || '').startsWith('[template ') && preview ? preview : row.Body;
  return {
    ...row,
    Body: `[DEMO simulated, not sent] ${body}`.slice(0, 2000),
    Sent_By: `${input.source_workflow || 'W12'} [DEMO simulated: nothing was sent; would go to ${res.to}]`.slice(0, 200),
    WA_Message_ID: res.wa_message_id,
    Status: 'queued',
    Send: false,
  };
}

if (typeof module !== 'undefined') module.exports = { WA_SIM_ONLY, waIsSimulate, waSimulate, waSimId, waSimulatedResult, waSimInboxPlan, waSimInboxRow };
