// Tiny n8n executor for the node types these workflows use, plus an in-memory fake Grist.
// Purpose: run the SHIPPED workflow JSON end to end (wiring, expressions, branches, data flow).
// Not n8n: no pairedItem resolution (".item" = same index), no retries, no credentials check beyond presence.
const COLUMNS = {
  Leads: ['Lead_ID', 'Created_At', 'Name', 'Phone', 'Source', 'Page_URL', 'UTM_Campaign', 'Enquiry', 'AI_Summary', 'Likely_Service', 'Status', 'Owner', 'Next_Action_At', 'First_Response_At', 'Lost_Reason', 'Opted_Out', 'Escalated', 'Followup_Sent', 'Notes'],
  Appointments: ['Booking_UID', 'Lead', 'Service', 'Physio', 'Start', 'End', 'Status', 'Fee_INR', 'R24_Sent', 'R2_Sent', 'Rebook_Sent', 'Review_Sent'],
  Run_Log: ['Workflow', 'Record', 'Outcome', 'Error', 'At'],
  Clinics: ['Clinic_Slug', 'Clinic_Name', 'Grist_Doc_ID', 'WA_Phone_Number_ID', 'Active'],
  Settings: ['Key', 'Value'],
};
const CHOICES = {
  'Leads.Source': ['Website', 'WhatsApp', 'Instagram', 'Call', 'Walk-in', 'Referral'],
  'Leads.Status': ['New', 'Contacted', 'Booked', 'Converted', 'Lost'],
  'Leads.Lost_Reason': ['No response', 'Price', 'Distance', 'Went elsewhere', 'Not a fit', 'Other'],
  'Appointments.Status': ['Booked', 'Rescheduled', 'Cancelled', 'Completed', 'No-show'],
  'Run_Log.Outcome': ['ok', 'skipped', 'failed'],
};
const DATETIME = new Set(['Leads.Created_At', 'Leads.Next_Action_At', 'Leads.First_Response_At', 'Appointments.Start', 'Appointments.End', 'Appointments.R24_Sent', 'Appointments.R2_Sent', 'Appointments.Rebook_Sent', 'Appointments.Review_Sent', 'Run_Log.At']);
const TOGGLE = new Set(['Leads.Opted_Out', 'Leads.Escalated', 'Leads.Followup_Sent', 'Clinics.Active']);

class FakeGrist {
  constructor(docs = {}) { this.docs = docs; this.nextId = {}; this.calls = []; }
  table(doc, t) {
    if (!this.docs[doc]) throw new Error(`Grist 404: no such doc ${doc}`);
    this.docs[doc][t] = this.docs[doc][t] || [];
    return this.docs[doc][t];
  }
  validate(t, fields) {
    for (const [k, v] of Object.entries(fields || {})) {
      if (!COLUMNS[t].includes(k)) throw new Error(`Grist 400: invalid column ${t}.${k}`);
      const key = `${t}.${k}`;
      if (CHOICES[key] && v !== '' && !CHOICES[key].includes(v)) throw new Error(`Grist 400: invalid choice "${v}" for ${key}`);
      if (DATETIME.has(key) && !(typeof v === 'number' || v === null)) throw new Error(`Grist 400: ${key} must be epoch seconds, got ${typeof v}`);
      if (TOGGLE.has(key) && typeof v !== 'boolean') throw new Error(`Grist 400: ${key} must be boolean`);
    }
  }
  handle(method, url, query, body) {
    const m = String(url).match(/\/api\/docs\/([^/]+)\/tables\/([^/]+)\/records$/);
    if (!m) throw new Error(`Grist 404: bad url ${url}`);
    const [, doc, t] = m;
    if (!COLUMNS[t]) throw new Error(`Grist 404: no such table ${t}`);
    const rows = this.table(doc, t);
    this.calls.push({ method, doc, table: t, query, body });
    if (method === 'GET') {
      let out = rows.slice();
      if (query.filter) {
        const f = JSON.parse(query.filter);
        for (const [col, vals] of Object.entries(f)) {
          if (!COLUMNS[t].includes(col) && col !== 'id') throw new Error(`Grist 400: filter on unknown column ${col}`);
          out = out.filter((r) => vals.includes(col === 'id' ? r.id : r.fields[col] === undefined ? null : r.fields[col]));
        }
      }
      if (query.sort) {
        const desc = query.sort.startsWith('-');
        const col = query.sort.replace(/^-/, '');
        out.sort((a, b) => ((a.fields[col] || 0) - (b.fields[col] || 0)) * (desc ? -1 : 1));
      }
      if (query.limit) out = out.slice(0, Number(query.limit));
      return { records: JSON.parse(JSON.stringify(out)) };
    }
    if (method === 'POST') {
      const ids = [];
      for (const rec of body.records) {
        this.validate(t, rec.fields);
        const key = `${doc}.${t}`;
        this.nextId[key] = (this.nextId[key] || Math.max(0, ...rows.map((r) => r.id))) + 1;
        rows.push({ id: this.nextId[key], fields: { ...rec.fields } });
        ids.push({ id: this.nextId[key] });
      }
      return { records: ids };
    }
    if (method === 'PATCH') {
      for (const rec of body.records) {
        this.validate(t, rec.fields);
        const row = rows.find((r) => r.id === rec.id);
        if (!row) throw new Error(`Grist 400: no row ${rec.id} in ${t}`);
        Object.assign(row.fields, rec.fields);
      }
      return null;
    }
    throw new Error(`Grist 405: ${method}`);
  }
}

// ---- expressions
const evalExpr = (src, ctx) => new Function('$json', '$', '$itemIndex', `return (${src});`)(ctx.$json, ctx.$, ctx.$itemIndex);
function resolve(val, ctx) {
  if (typeof val === 'string') {
    if (!val.startsWith('=')) return val;
    const s = val.slice(1);
    const whole = s.match(/^\{\{([\s\S]*)\}\}$/);
    if (whole && !/\}\}[\s\S]*\{\{/.test(s)) return evalExpr(whole[1], ctx);
    return s.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => { const v = evalExpr(e, ctx); return typeof v === 'object' ? JSON.stringify(v) : String(v); });
  }
  if (Array.isArray(val)) return val.map((v) => resolve(v, ctx));
  if (val && typeof val === 'object') return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, resolve(v, ctx)]));
  return val;
}

function simulate(wf, opts) {
  const { start, items, grist, now, staticData = {}, onlyUntil } = opts;
  const realNow = Date.now;
  if (now) Date.now = () => now;
  const byName = Object.fromEntries(wf.nodes.map((n) => [n.name, n]));
  const runData = {};
  const result = { runData, error: null, telegram: [], visited: [] };
  const queue = [{ name: start, inputs: items }];

  const accessor = (name, idx) => {
    if (!(name in runData)) throw new Error(`Node '${name}' hasn't been executed`);
    const arr = runData[name];
    return { first: () => arr[0], last: () => arr[arr.length - 1], all: () => arr, item: arr[idx] || arr[0], isExecuted: true };
  };

  try {
    while (queue.length) {
      const { name, inputs } = queue.shift();
      const node = byName[name];
      result.visited.push(name);
      const p = node.parameters || {};
      let outputs; // array of item arrays, one per output index

      const ctxFor = (item, i) => ({ $json: item ? item.json : undefined, $: (n) => accessor(n, i), $itemIndex: i });

      switch (node.type) {
        case 'n8n-nodes-base.webhook':
        case 'n8n-nodes-base.scheduleTrigger':
        case 'n8n-nodes-base.errorTrigger':
          outputs = [inputs]; break;
        case 'n8n-nodes-base.set': {
          outputs = [inputs.map((it, i) => {
            const base = p.includeOtherFields ? { ...it.json } : {};
            for (const a of p.assignments.assignments) base[a.name] = resolve(a.value, ctxFor(it, i));
            return { json: base };
          })];
          break;
        }
        case 'n8n-nodes-base.code': {
          const staticFn = () => staticData;
          if (p.mode === 'runOnceForAllItems') {
            const $input = { all: () => inputs, first: () => inputs[0] };
            const r = new Function('$', '$input', '$json', '$getWorkflowStaticData', p.jsCode)((n) => accessor(n, 0), $input, undefined, staticFn);
            outputs = [r];
          } else {
            outputs = [inputs.map((it, i) => {
              const r = new Function('$json', '$', '$getWorkflowStaticData', p.jsCode)(it.json, (n) => accessor(n, i), staticFn);
              if (!r || !r.json) throw new Error(`Code node ${name} did not return {json}`);
              return r;
            })];
          }
          break;
        }
        case 'n8n-nodes-base.if': {
          const t = [], f = [];
          inputs.forEach((it, i) => {
            const cond = p.conditions.conditions[0];
            const v = resolve(cond.leftValue, ctxFor(it, i));
            if (typeof v !== 'boolean') throw new Error(`IF ${name}: strict boolean expected, got ${typeof v} (${JSON.stringify(v)})`);
            (v ? t : f).push(it);
          });
          outputs = [t, f];
          break;
        }
        case 'n8n-nodes-base.httpRequest': {
          if (!node.credentials || !node.credentials.httpHeaderAuth) throw new Error(`HTTP ${name}: no credential`);
          outputs = [inputs.map((it, i) => {
            const ctx = ctxFor(it, i);
            const method = resolve(p.method, ctx);
            const url = resolve(p.url, ctx);
            const query = {};
            if (p.sendQuery) for (const q of p.queryParameters.parameters) query[q.name] = resolve(q.value, ctx);
            let body;
            if (p.sendBody) { body = resolve(p.jsonBody, ctx); if (typeof body === 'string') body = JSON.parse(body); }
            return { json: grist.handle(method, url, query, body) };
          })];
          break;
        }
        case 'n8n-nodes-base.stopAndError': {
          const ctx = ctxFor(inputs[0], 0);
          throw Object.assign(new Error(resolve(p.errorMessage, ctx)), { stopAndError: true });
        }
        case 'n8n-nodes-base.telegram': {
          outputs = [inputs.map((it, i) => {
            const ctx = ctxFor(it, i);
            result.telegram.push({ chatId: resolve(p.chatId, ctx), text: resolve(p.text, ctx), parse_mode: (p.additionalFields || {}).parse_mode });
            return { json: { ok: true } };
          })];
          break;
        }
        case 'n8n-nodes-base.stickyNote': outputs = [[]]; break;
        default: throw new Error(`sim: unsupported node type ${node.type} (${name})`);
      }

      runData[name] = outputs[0] || [];
      const conns = (wf.connections[name] || { main: [] }).main;
      outputs.forEach((out, oi) => {
        if (!out || !out.length) return;
        for (const target of conns[oi] || []) queue.push({ name: target.node, inputs: out });
      });
      if (onlyUntil && name === onlyUntil) break;
    }
  } catch (e) {
    const failedAt = result.visited[result.visited.length - 1];
    result.error = { node: failedAt, message: e.message, stopAndError: !!e.stopAndError };
  } finally {
    Date.now = realNow;
  }
  return result;
}

module.exports = { simulate, FakeGrist, COLUMNS, CHOICES };
