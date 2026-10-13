// The clinic's Settings (missed_call_enabled, demo_mode, clinic_name, owner_phone, TEST_MODE, TEST_PHONE) next to the clinic.
const ctx = $('MCC – Resolve clinic').first().json;
const settings = ceSettings($json.records, ctx.clinic.name);
return { json: { ...ctx, settings, clinic_name: settings.clinic_name, demo: settings.demo } };
