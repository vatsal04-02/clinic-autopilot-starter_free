// Same Lead_id rule as W1 / W2: L-YYYYMMDD-NNNN (IST date, next free number of the day, read from the 200 newest leads). Source = Call.
const ctx = $('MCC – Context').first().json;
const now = Date.now();
const ymd = new Date(now + 5.5 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');   // IST date
const prefix = `L-${ymd}-`;
let max = 0;
for (const r of $json.records || []) {
  const id = String((r.fields || {}).Lead_id || '');
  if (id.startsWith(prefix)) max = Math.max(max, parseInt(id.slice(prefix.length), 10) || 0);
}
const lead_id = prefix + String(max + 1).padStart(4, '0');
const name = `Caller ${String(ctx.event.caller_phone).slice(-4)}`;
const fields = {
  Lead_id: lead_id,
  Created_At: Math.floor(now / 1000),
  Name: name,
  Phone: ctx.event.caller_phone,
  Source: 'Call',
  Status: 'New',
  Enquiry: ctx.demo ? '[DEMO] Missed call' : 'Missed call',
  Notes: ctx.demo ? '[DEMO] synthetic missed call, not a real patient' : '',
};
return { json: { ...ctx, lead_id, lead_name: name, create: { records: [{ fields }] } } };
