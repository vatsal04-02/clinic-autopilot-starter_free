// After our claim row exists: re-read every row with the key. The LOWEST row id owns the event; any other copy stands down.
const ctx = $('MCC – Classify').first().json;
const created = $('MCC – Claim event').first().json;
const mine = created && Array.isArray(created.records) && created.records[0] ? Number(created.records[0].id) : 0;
const c = ceCanonical(Array.isArray($json.records) ? $json.records : [], mine);
return {
  json: {
    ...ctx,
    plan: { ...ctx.plan, row_id: mine, canonical_id: c.canonical_id, mine: c.mine },
    stand_down: c.mine ? null : { records: [{ id: mine, fields: { WA_Message_ID: ceDupKey(ctx.event.call_key, mine), AI_Action: CE_STATE.skipped, AI_Reason: `duplicate of row ${c.canonical_id}: another delivery of this event owns it` } }] },
  },
};
