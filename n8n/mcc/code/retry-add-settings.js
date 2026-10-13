// The clinic's Settings next to its registry row. A clinic with missed-call capture off is dropped here.
const clinics = $('MCC – Retry split').all();
return $input.all().map((item, i) => {
  const settings = ceSettings(item.json.records, clinics[i].json.clinic.name);
  return { json: { ...clinics[i].json, settings, clinic_name: settings.clinic_name, demo: settings.demo }, pairedItem: { item: i } };
}).filter((x) => x.json.settings.enabled);
