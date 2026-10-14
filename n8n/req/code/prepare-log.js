// One Run_Log row per attempt. Not sent = failed, with W12's reason; Confirm_Sent stays set (one attempt per decision: a broken template or number can
// never make this section message the patient again and again). A DEMO simulated send counts as done and says so.
const sim = $json.simulated === true;
const ok = $json.sent === true || sim;
const d = $json.decision || {};
return {
  json: {
    ...$json,
    log: {
      Workflow: 'REQ-request-confirm',
      Record: `${$json.booking_uid} ${$json.kind} ${$json.lead_id}${d.test_mode ? ' (TEST_MODE)' : ''}${sim ? ' [DEMO simulated, nothing sent]' : ''}`.slice(0, 200),
      Outcome: ok ? 'ok' : 'failed',
      Error: ok ? '' : String($json.send_error || $json.send_status || 'not sent').slice(0, 500),
      At: Math.floor(Date.now() / 1000),
    },
  },
};
