/**
 * ProWebLook — 30-Second Airtable Scripting Extension (Bulk Table & View Verifier)
 *
 * Works immediately on ANY Airtable base without CLI tools:
 * 1. In your Airtable base, click Extensions -> Add an extension -> Scripting.
 * 2. Paste this script into the code editor.
 * 3. Configure your Table, View, Source Fields, and Output Fields in the Scripting settings sidebar!
 * 4. Click Run and enter your ProWebLook API key from https://proweblook.com/user/api (50 free credits on signup).
 */

const settings = input.config({
  title: 'ProWebLook Bulk Lead & WhatsApp Verifier',
  description:
    'Bulk-verify Email deliverability, Phone Carrier/VoIP, Silent WhatsApp status, and Caller ID across any Airtable view. Already-verified records are skipped automatically.',
  items: [
    input.config.table('targetTable', {
      label: 'Target Table',
      description: 'Select the Airtable table containing leads, contacts, or COD orders.',
    }),
    input.config.view('targetView', {
      label: 'Target View',
      parentTable: 'targetTable',
      description: 'Select the filtered view to enrich.',
    }),
    input.config.field('emailField', {
      label: 'Source: Email Field (Optional)',
      parentTable: 'targetTable',
    }),
    input.config.field('phoneField', {
      label: 'Source: Phone Field (Optional)',
      parentTable: 'targetTable',
    }),
    input.config.text('defaultCountry', {
      label: 'Default 2-Letter ISO Country Code (e.g. US, IN, GB)',
      description: 'Used when phone numbers do not start with +.',
    }),
    input.config.select('runCallerId', {
      label: 'Include Caller ID (CNAM) Lookup?',
      options: [
        { label: 'No (Email + Phone + Silent WhatsApp)', value: 'no' },
        { label: 'Yes (Also query Caller ID Name — uses 1 caller credit)', value: 'yes' },
      ],
    }),
    input.config.field('verdictOutputField', {
      label: 'Output: Verification Status / Risk Verdict Field (APPROVE / REVIEW / BLOCK)',
      parentTable: 'targetTable',
    }),
    input.config.field('trustScoreOutputField', {
      label: 'Output: Trust Score (0-100) Field (Optional)',
      parentTable: 'targetTable',
    }),
    input.config.field('whatsappOutputField', {
      label: 'Output: WhatsApp Status Field (Optional)',
      parentTable: 'targetTable',
    }),
    input.config.field('summaryOutputField', {
      label: 'Output: Verification Summary Field',
      parentTable: 'targetTable',
    }),
  ],
});

const API_BASE = 'https://proweblook.com/api/v1/airtable';
const apiKey =
  typeof input.secret === 'function'
    ? String((await input.secret('Enter your ProWebLook API key (https://proweblook.com/user/api)')) || '').trim()
    : String((await input.textAsync('Enter your ProWebLook API key:')) || '').trim();

if (!apiKey) {
  output.markdown('### Missing API Key\nGenerate a free API key (50 credits included) at [proweblook.com/user/api](https://proweblook.com/user/api).');
  throw new Error('ProWebLook API key is required.');
}

async function callApi(operation, payload) {
  const res = await remoteFetchAsync(`${API_BASE}/${operation}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok || !body || body.ok !== true) {
    const msg = body && body.error && body.error.message ? body.error.message : `HTTP ${res.status}`;
    throw new Error(`${operation}: ${msg}`);
  }
  return body.data;
}

output.markdown('### Checking ProWebLook Account Balances...');
const balances = await callApi('get_balance', {});
output.table([
  {
    Account: balances.account_email,
    'Email Credits': balances.email.amount,
    'Phone Credits': balances.phone.amount,
    'WhatsApp Credits': balances.whatsapp.amount,
    'Caller ID Credits': balances.caller.amount,
  },
]);

const query = await settings.targetView.selectRecordsAsync();
const countryCode = String(settings.defaultCountry || '').trim().toUpperCase();
const sessionCache = new Map();
const pendingUpdates = [];
let skippedAlreadyVerified = 0;
let processedCount = 0;

for (const record of query.records) {
  const existingVerdict = settings.verdictOutputField
    ? record.getCellValueAsString(settings.verdictOutputField).trim()
    : '';
  if (existingVerdict && !['error', 'pending', 'retry'].includes(existingVerdict.toLowerCase())) {
    skippedAlreadyVerified += 1;
    continue;
  }

  const email = settings.emailField ? record.getCellValueAsString(settings.emailField).trim() : '';
  const phone = settings.phoneField ? record.getCellValueAsString(settings.phoneField).trim() : '';
  if (!email && !phone) {
    continue;
  }

  let score = 50;
  let hardBlock = false;
  let needsReview = false;
  const notes = [];
  let waVerdict = '';

  if (email) {
    const cacheKey = `email:${email.toLowerCase()}`;
    const emailData = sessionCache.get(cacheKey) || (await callApi('verify_email', { email }));
    sessionCache.set(cacheKey, emailData);
    if (emailData.verdict === 'deliverable') {
      score += 20;
      notes.push('Email deliverable');
    } else if (emailData.verdict === 'undeliverable') {
      score -= 35;
      hardBlock = true;
      notes.push('Email undeliverable');
    } else {
      score -= 5;
      needsReview = true;
      notes.push(`Email ${emailData.verdict}`);
    }
  }

  if (phone) {
    const payload = countryCode && !phone.startsWith('+') ? { phone_number: phone, country_code: countryCode } : { phone_number: phone };
    const phoneKey = `phone:${phone}|${countryCode}`;
    const phoneData = sessionCache.get(phoneKey) || (await callApi('validate_phone', payload));
    sessionCache.set(phoneKey, phoneData);

    const lineType = String((phoneData.details && phoneData.details.line_type) || '');
    const carrier = String((phoneData.details && phoneData.details.carrier) || '');
    if (phoneData.verdict === 'valid') {
      if (lineType.toLowerCase().includes('voip')) {
        score -= 15;
        needsReview = true;
        notes.push(`VoIP (${carrier || 'VoIP'})`);
      } else {
        score += 20;
        notes.push(`Valid ${lineType} (${carrier || 'Carrier OK'})`.trim());
      }
    } else if (phoneData.verdict === 'invalid') {
      score -= 35;
      hardBlock = true;
      notes.push('Phone invalid');
    }

    if (phoneData.verdict !== 'invalid') {
      const e164Payload = phoneData.phone_number ? { phone_number: phoneData.phone_number } : payload;
      const waKey = `wa:${e164Payload.phone_number}`;
      const waData = sessionCache.get(waKey) || (await callApi('check_whatsapp', e164Payload));
      sessionCache.set(waKey, waData);
      waVerdict = waData.verdict || '';
      if (waVerdict === 'on_whatsapp') {
        score += 18;
        notes.push('Active on WhatsApp');
      } else if (waVerdict === 'not_on_whatsapp') {
        score -= 12;
        needsReview = true;
        notes.push('Not on WhatsApp');
      }

      if (settings.runCallerId === 'yes') {
        const cidKey = `cid:${e164Payload.phone_number}`;
        const cidData = sessionCache.get(cidKey) || (await callApi('caller_id', e164Payload));
        sessionCache.set(cidKey, cidData);
        if (cidData.verdict === 'found' && cidData.caller_name) {
          score += 10;
          notes.push(`Caller ID: ${cidData.caller_name}`);
        }
      }
    }
  }

  const trustScore = Math.max(0, Math.min(100, Math.round(score)));
  const riskVerdict = hardBlock || trustScore < 35 ? 'BLOCK' : !needsReview && trustScore >= 70 ? 'APPROVE' : 'REVIEW';
  const summary = notes.join(' · ');

  const fields = {};
  const setFieldSafe = (fieldObj, val) => {
    if (!fieldObj || fieldObj.isComputed || val === '' || val === null || val === undefined) return;
    if (fieldObj.type === 'number' || fieldObj.type === 'percent' || fieldObj.type === 'rating') {
      fields[fieldObj.id] = Number(val);
    } else if (fieldObj.type === 'singleSelect') {
      fields[fieldObj.id] = { name: String(val) };
    } else {
      fields[fieldObj.id] = String(val);
    }
  };

  setFieldSafe(settings.verdictOutputField, riskVerdict);
  setFieldSafe(settings.trustScoreOutputField, trustScore);
  setFieldSafe(settings.whatsappOutputField, waVerdict);
  setFieldSafe(settings.summaryOutputField, summary);

  if (Object.keys(fields).length > 0) {
    pendingUpdates.push({ id: record.id, fields });
  }
  processedCount += 1;
}

// Write back in Airtable's 50-record batch limit
for (let i = 0; i < pendingUpdates.length; i += 50) {
  await settings.targetTable.updateRecordsAsync(pendingUpdates.slice(i, i + 50));
}

output.markdown(
  `### Enrichment Complete\n- **Verified & Updated:** ${pendingUpdates.length} records\n- **Skipped (Already Verified):** ${skippedAlreadyVerified} records\n- **Total Scanned in View:** ${query.records.length} records`
);
