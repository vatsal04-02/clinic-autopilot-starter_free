// Join point: the event row exists and this delivery owns it (new, resumed or a retry). Nothing changes here; later nodes read this item by name.
return { json: { ...$json } };
