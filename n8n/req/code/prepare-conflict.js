// The slot is already taken: this confirmation is refused. The row goes back to Requested (the claim is NOT written: the patient is not told).
return { json: { ...$json, revert: { records: [{ id: $json.appt_row_id, fields: { Status: 'Requested' } }] } } };
