// One Run_Log row: staff confirmed a request for a slot that is no longer free.
const it = $('REQ – Prepare conflict').item.json;
const failed = $json && $json.error;
return {
  json: {
    ...it,
    log: reqcLog(it, 'failed', `double booking prevented: ${it.start_label || ''} is already taken by ${(it.conflict_with || []).join(', ') || 'another appointment'}; the request is back to Requested${failed ? ` (but putting it back FAILED: ${String(failed.message || failed).slice(0, 120)}: fix its Status by hand)` : ''}`, Math.floor(Date.now() / 1000)),
  },
};
