/**
 * ProWebLook — Real-Time Airtable Automation ("When record created / matches conditions")
 *
 * Setup in Airtable Automations:
 * 1. Trigger: "When record is created" (or "When record matches conditions") on your Leads / Orders table.
 * 2. Action: "Run a script" -> paste this entire script.
 * 3. Left sidebar -> Input variables (`input.config()`):
 *    - `recordId`     : Record ID from step 1
 *    - `tableName`    : Exact table name (e.g., "Leads" or "Orders")
 *    - `email`        : Email cell value from step 1 (optional)
 *    - `phone`        : Phone cell value from step 1 (optional)
 *    - `countryCode`  : 2-letter ISO country code fallback, e.g., "US" or "IN" (optional)
 *    - `leadName`     : Customer / Lead Name cell value for Caller ID matching (optional)
 *    - `apiKey`       : Your ProWebLook API key (or store via Airtable Secret `input.secret('PROWEBLOOK_API_KEY')`)
 * 4. Customize FIELD_MAP below to match your destination column names (leave `null` for columns you don't use).
 */

const cfg = input.config();
const API_BASE = 'https://proweblook.com/api/v1/airtable';

// Map your destination Airtable field names here (set unused fields to null):
const FIELD_MAP = {
  emailVerdict: 'Email Verdict',         // Single line text or Single select: deliverable | undeliverable | unknown
  phoneVerdict: 'Phone Verdict',         // Single line text or Single select: valid | invalid | unknown
  phoneCarrier: 'Carrier',               // Single line text
  phoneLineType: 'Line Type',            // Single line text (Mobile, Fixed Line, VoIP)
  whatsappStatus: 'WhatsApp Status',     // Single line text or Single select: on_whatsapp | not_on_whatsapp
  callerIdName: 'Caller ID Name',        // Single line text (enable RUN_CALLER_ID = true below to populate)
  trustScore: 'Trust Score',             // Number (0 - 100)
  riskVerdict: 'Verification Status',    // Single line text or Single select: APPROVE | REVIEW | BLOCK
  summary: 'Verification Notes',         // Long text / Single line text
  verifiedAt: 'Verified At',             // Date/time (ISO UTC) or Single line text
};

const RUN_EMAIL = true;
const RUN_PHONE = true;
const RUN_WHATSAPP = true;
const RUN_CALLER_ID = false; // Set to true if your workflow also checks Caller ID (1 caller credit)

const apiKey = String(cfg.apiKey || '').trim();
if (!apiKey) {
  throw new Error('Missing ProWebLook API key. Configure input variable `apiKey` in your Airtable Automation.');
}

async function callProWebLook(operation, payload) {
  const res = await fetch(`${API_BASE}/${operation}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!res.ok || !json || json.ok !== true) {
    const msg = json && json.error && json.error.message ? json.error.message : `HTTP ${res.status}`;
    throw new Error(`ProWebLook ${operation} failed: ${msg}`);
  }
  return json.data;
}

const rawEmail = String(cfg.email || '').trim();
const rawPhone = String(cfg.phone || '').trim();
const countryCode = String(cfg.countryCode || '').trim().toUpperCase();
const leadName = String(cfg.leadName || '').trim();

let score = 50;
let hardBlock = false;
let needsReview = false;
const notes = [];

let emailData = null;
let phoneData = null;
let whatsappData = null;
let callerData = null;

if (RUN_EMAIL && rawEmail) {
  emailData = await callProWebLook('verify_email', { email: rawEmail });
  if (emailData.verdict === 'deliverable') {
    score += 20;
    notes.push('Email deliverable');
  } else if (emailData.verdict === 'undeliverable') {
    score -= 35;
    hardBlock = true;
    notes.push(`Email undeliverable (${emailData.reason || 'rejected'})`);
  } else {
    score -= 5;
    needsReview = true;
    notes.push(`Email ${emailData.verdict || 'unknown'}`);
  }
}

const phonePayload = rawPhone
  ? countryCode && !rawPhone.startsWith('+')
    ? { phone_number: rawPhone, country_code: countryCode }
    : { phone_number: rawPhone }
  : null;

if (RUN_PHONE && phonePayload) {
  phoneData = await callProWebLook('validate_phone', phonePayload);
  const lineType = String((phoneData.details && phoneData.details.line_type) || '');
  const carrier = String((phoneData.details && phoneData.details.carrier) || '');
  if (phoneData.verdict === 'valid') {
    if (lineType.toLowerCase().includes('voip')) {
      score -= 15;
      needsReview = true;
      notes.push(`VoIP line (${carrier || 'VoIP'})`);
    } else {
      score += 20;
      notes.push(`Phone valid ${lineType} (${carrier || 'carrier verified'})`.trim());
    }
  } else if (phoneData.verdict === 'invalid') {
    score -= 35;
    hardBlock = true;
    notes.push('Phone invalid');
  } else {
    score -= 5;
    needsReview = true;
    notes.push('Phone unconfirmed');
  }
}

const phoneKnownInvalid = phoneData && phoneData.verdict === 'invalid';
const normalizedPhonePayload =
  phoneData && phoneData.phone_number ? { phone_number: phoneData.phone_number } : phonePayload;

if (RUN_WHATSAPP && normalizedPhonePayload && !phoneKnownInvalid) {
  whatsappData = await callProWebLook('check_whatsapp', normalizedPhonePayload);
  if (whatsappData.verdict === 'on_whatsapp') {
    score += 18;
    notes.push('Active on WhatsApp');
  } else if (whatsappData.verdict === 'not_on_whatsapp') {
    score -= 12;
    needsReview = true;
    notes.push('Not on WhatsApp');
  }
}

if (RUN_CALLER_ID && normalizedPhonePayload && !phoneKnownInvalid) {
  callerData = await callProWebLook('caller_id', normalizedPhonePayload);
  if (callerData.verdict === 'found' && callerData.caller_name) {
    notes.push(`Caller ID: ${callerData.caller_name}`);
    if (leadName) {
      const leadFirst = leadName.toLowerCase().split(/\s+/)[0];
      if (leadFirst.length >= 3 && callerData.caller_name.toLowerCase().includes(leadFirst)) {
        score += 12;
      } else {
        score -= 10;
        needsReview = true;
      }
    } else {
      score += 8;
    }
  }
}

const trustScore = Math.max(0, Math.min(100, Math.round(score)));
const riskVerdict = hardBlock || trustScore < 35 ? 'BLOCK' : !needsReview && trustScore >= 70 ? 'APPROVE' : 'REVIEW';
const verifiedAt = new Date().toISOString();
const summary = notes.join(' · ') || 'No contact inputs supplied';

const table = base.getTable(cfg.tableName);
const existingFieldNames = new Set(table.fields.map((f) => f.name));
const fieldsToUpdate = {};

function assignIfColumnExists(fieldName, value) {
  if (!fieldName || !existingFieldNames.has(fieldName) || value === undefined || value === null || value === '') {
    return;
  }
  const field = table.getField(fieldName);
  if (field.isComputed) return;
  if (field.type === 'number' || field.type === 'percent' || field.type === 'rating') {
    fieldsToUpdate[fieldName] = Number(value);
  } else if (field.type === 'singleSelect') {
    fieldsToUpdate[fieldName] = { name: String(value) };
  } else if (field.type === 'date') {
    fieldsToUpdate[fieldName] = String(value).slice(0, 10);
  } else {
    fieldsToUpdate[fieldName] = String(value);
  }
}

assignIfColumnExists(FIELD_MAP.emailVerdict, emailData && emailData.verdict);
assignIfColumnExists(FIELD_MAP.phoneVerdict, phoneData && phoneData.verdict);
assignIfColumnExists(FIELD_MAP.phoneCarrier, phoneData && phoneData.details && phoneData.details.carrier);
assignIfColumnExists(FIELD_MAP.phoneLineType, phoneData && phoneData.details && phoneData.details.line_type);
assignIfColumnExists(FIELD_MAP.whatsappStatus, whatsappData && whatsappData.verdict);
assignIfColumnExists(FIELD_MAP.callerIdName, callerData && callerData.caller_name);
assignIfColumnExists(FIELD_MAP.trustScore, trustScore);
assignIfColumnExists(FIELD_MAP.riskVerdict, riskVerdict);
assignIfColumnExists(FIELD_MAP.summary, summary);
assignIfColumnExists(FIELD_MAP.verifiedAt, verifiedAt);

if (Object.keys(fieldsToUpdate).length > 0) {
  await table.updateRecordAsync(cfg.recordId, fieldsToUpdate);
}

output.set('trustScore', trustScore);
output.set('riskVerdict', riskVerdict);
output.set('summary', summary);
output.set('normalizedPhone', (phoneData && phoneData.phone_number) || (whatsappData && whatsappData.phone_number) || '');
