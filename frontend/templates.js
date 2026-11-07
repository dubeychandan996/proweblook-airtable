export const AUTOMATION_ON_RECORD_CREATED_SNIPPET = `// Airtable Automation -> Action: "Run a script"
// Input variables: recordId, tableName, email, phone, countryCode, apiKey
const cfg = input.config();
const API_BASE = 'https://proweblook.com/api/v1/airtable';

async function callPwl(op, body) {
  const r = await fetch(\`\${API_BASE}/\${op}\`, {
    method: 'POST',
    headers: {
      Authorization: \`Bearer \${String(cfg.apiKey || '').trim()}\`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j?.error?.message || \`HTTP \${r.status}\`);
  return j.data;
}

const phonePayload = cfg.phone
  ? (cfg.countryCode && !String(cfg.phone).startsWith('+')
      ? { phone_number: String(cfg.phone).trim(), country_code: String(cfg.countryCode).trim().toUpperCase() }
      : { phone_number: String(cfg.phone).trim() })
  : null;

const emailRes = cfg.email ? await callPwl('verify_email', { email: String(cfg.email).trim() }) : null;
const phoneRes = phonePayload ? await callPwl('validate_phone', phonePayload) : null;
const waRes = phoneRes && phoneRes.verdict !== 'invalid'
  ? await callPwl('check_whatsapp', { phone_number: phoneRes.phone_number || phonePayload.phone_number })
  : null;

const table = base.getTable(cfg.tableName);
await table.updateRecordAsync(cfg.recordId, {
  'Email Verdict': emailRes ? emailRes.verdict : '',
  'Phone Verdict': phoneRes ? phoneRes.verdict : '',
  'WhatsApp Status': waRes ? waRes.verdict : '',
  'Verified At': new Date().toISOString(),
});`;

export const SCRIPTING_QUICK_ENRICH_SNIPPET = `// Airtable Scripting Extension -> Paste & click Run
// Uses remoteFetchAsync (server-side proxy) + 50-record batch updates
const API_BASE = 'https://proweblook.com/api/v1/airtable';
const apiKey = (await input.secret('PROWEBLOOK_API_KEY')).trim();
const table = await input.tableAsync('Select table to verify');
const phoneField = await input.fieldAsync('Select Phone field', table);
const statusField = await input.fieldAsync('Select Output Status field', table);

const query = await table.selectRecordsAsync({ fields: [phoneField, statusField] });
const updates = [];

for (const record of query.records) {
  if (record.getCellValueAsString(statusField).trim()) continue; // Skip already verified!
  const phone = record.getCellValueAsString(phoneField).trim();
  if (!phone) continue;

  const res = await remoteFetchAsync(\`\${API_BASE}/check_whatsapp\`, {
    method: 'POST',
    headers: { Authorization: \`Bearer \${apiKey}\`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone_number: phone, country_code: 'US' }),
  });
  const json = await res.json();
  if (json && json.ok) {
    updates.push({ id: record.id, fields: { [statusField.id]: json.data.verdict } });
  }
}

for (let i = 0; i < updates.length; i += 50) {
  await table.updateRecordsAsync(updates.slice(i, i + 50));
}
output.markdown(\`**Done!** Verified \${updates.length} records.\`);`;
