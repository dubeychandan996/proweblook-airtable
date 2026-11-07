import {
  verifyEmailAddress,
  validatePhoneNumber,
  checkWhatsappStatus,
  lookupCallerId,
  normalizeCountryHint,
} from './api.js';

export const AIRTABLE_MAX_BATCH_SIZE = 50;

const HONORIFIC_TOKENS = new Set([
  'mr',
  'mrs',
  'ms',
  'miss',
  'dr',
  'prof',
  'sir',
  'madam',
  'shri',
  'smt',
]);

/**
 * Safely extracts plain string text from any Airtable cell value shape
 * (singleLineText, email, phoneNumber, singleSelect, lookup/rollup arrays, collaborators).
 */
export function extractPlainCellText(cellValue) {
  if (cellValue === null || cellValue === undefined) {
    return '';
  }
  if (typeof cellValue === 'string') {
    return cellValue.trim();
  }
  if (typeof cellValue === 'number' || typeof cellValue === 'boolean') {
    return String(cellValue);
  }
  if (Array.isArray(cellValue)) {
    for (const item of cellValue) {
      const extracted = extractPlainCellText(item);
      if (extracted) {
        return extracted;
      }
    }
    return '';
  }
  if (typeof cellValue === 'object') {
    if (typeof cellValue.email === 'string' && cellValue.email.trim()) {
      return cellValue.email.trim();
    }
    if (typeof cellValue.text === 'string' && cellValue.text.trim()) {
      return cellValue.text.trim();
    }
    if (typeof cellValue.name === 'string' && cellValue.name.trim()) {
      return cellValue.name.trim();
    }
    if (cellValue.value !== undefined) {
      return extractPlainCellText(cellValue.value);
    }
  }
  return '';
}

export function getRecordFieldText(record, fieldIdOrName) {
  if (!record || !fieldIdOrName) {
    return '';
  }
  try {
    const raw = record.getCellValue(fieldIdOrName);
    const extracted = extractPlainCellText(raw);
    if (extracted) {
      return extracted;
    }
  } catch (_err) {
    // Fallback to getCellValueAsString if available
  }
  if (typeof record.getCellValueAsString === 'function') {
    try {
      return String(record.getCellValueAsString(fieldIdOrName) || '').trim();
    } catch (_err) {
      return '';
    }
  }
  return '';
}

/**
 * Determines whether an Airtable record already has completed verification data
 * so re-running bulk enrichment never double-charges credits.
 */
export function shouldSkipVerifiedRecord(record, mapping = {}, options = {}) {
  const { skipAlreadyVerified = true } = options;
  if (!skipAlreadyVerified || !record) {
    return false;
  }

  const sentinelFields = [
    mapping.riskVerdictOutputField,
    mapping.verifiedAtOutputField,
    mapping.emailVerdictOutputField,
    mapping.phoneVerdictOutputField,
    mapping.whatsappVerdictOutputField,
    mapping.callerNameOutputField,
  ].filter(Boolean);

  if (sentinelFields.length === 0) {
    return false;
  }

  // Primary check: if riskVerdictOutputField or verifiedAtOutputField is mapped and non-empty (and not an error/pending marker), skip.
  for (const primaryField of [mapping.riskVerdictOutputField, mapping.verifiedAtOutputField]) {
    if (primaryField) {
      const value = getRecordFieldText(record, primaryField).toLowerCase();
      if (value && !['error', 'pending', 'retry', 'failed'].includes(value)) {
        return true;
      }
    }
  }

  // Secondary check: if all enabled signal output fields already have completed values, skip.
  const activeSignalOutputFields = [];
  if (options.enableEmail && mapping.emailVerdictOutputField) {
    activeSignalOutputFields.push(mapping.emailVerdictOutputField);
  }
  if (options.enablePhone && mapping.phoneVerdictOutputField) {
    activeSignalOutputFields.push(mapping.phoneVerdictOutputField);
  }
  if (options.enableWhatsapp && mapping.whatsappVerdictOutputField) {
    activeSignalOutputFields.push(mapping.whatsappVerdictOutputField);
  }
  if (options.enableCallerId && mapping.callerNameOutputField) {
    activeSignalOutputFields.push(mapping.callerNameOutputField);
  }

  if (activeSignalOutputFields.length > 0) {
    return activeSignalOutputFields.every((fieldId) => {
      const val = getRecordFieldText(record, fieldId).toLowerCase();
      return Boolean(val) && !['error', 'pending', 'retry', 'failed'].includes(val);
    });
  }

  return false;
}

export function tokenizePersonName(name) {
  if (typeof name !== 'string') {
    return [];
  }
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2 && !HONORIFIC_TOKENS.has(token));
}

export function compareLeadAndCallerName(leadName, callerName) {
  const leadTokens = tokenizePersonName(leadName);
  const callerTokens = tokenizePersonName(callerName);

  if (leadTokens.length === 0 || callerTokens.length === 0) {
    return 'not_compared';
  }

  const leadJoined = leadTokens.slice().sort().join(' ');
  const callerJoined = callerTokens.slice().sort().join(' ');
  if (leadJoined === callerJoined) {
    return 'exact_match';
  }

  const callerSet = new Set(callerTokens);
  const overlap = leadTokens.filter((token) => callerSet.has(token));
  if (overlap.length > 0) {
    return 'partial_match';
  }

  // Prefix check for abbreviated first names or truncated CNAM strings (e.g. "CHANDAN D" vs "Chandan Dubey")
  for (const lt of leadTokens) {
    for (const ct of callerTokens) {
      if (lt.length >= 4 && ct.length >= 4 && (lt.startsWith(ct) || ct.startsWith(lt))) {
        return 'partial_match';
      }
    }
  }

  return 'mismatch';
}

/**
 * Computes a 0-100 Lead/COD Trust Score, Risk Verdict (APPROVE | REVIEW | BLOCK),
 * and human-readable summary from enabled ProWebLook verification signals.
 */
export function computeLeadTrustAssessment({
  emailResult = null,
  phoneResult = null,
  whatsappResult = null,
  callerResult = null,
  leadName = '',
} = {}) {
  let score = 50;
  let hardBlock = false;
  let needsReview = false;
  const notes = [];

  if (emailResult) {
    const verdict = String(emailResult.verdict || '').toLowerCase();
    const reason = String(emailResult.reason || '').toLowerCase();
    if (verdict === 'deliverable') {
      score += 20;
      notes.push('Email deliverable');
    } else if (verdict === 'undeliverable') {
      score -= 35;
      hardBlock = true;
      notes.push(`Email undeliverable${reason ? ` (${reason})` : ''}`);
    } else {
      score -= 5;
      needsReview = true;
      notes.push(`Email ${verdict || 'unknown'}${reason ? ` (${reason})` : ''}`);
    }
    if (reason.includes('disposable') || emailResult?.details?.disposable === true) {
      score -= 30;
      hardBlock = true;
      notes.push('Disposable email');
    }
  }

  let detectedLineType = '';
  let detectedCarrier = '';

  if (phoneResult) {
    const verdict = String(phoneResult.verdict || '').toLowerCase();
    const details = phoneResult.details && typeof phoneResult.details === 'object' ? phoneResult.details : {};
    detectedCarrier = String(details.carrier || details.operator || '').trim();
    detectedLineType = String(details.line_type || details.type || '').trim();
    const lowerType = detectedLineType.toLowerCase();

    if (verdict === 'valid') {
      if (lowerType.includes('voip') || lowerType.includes('virtual')) {
        score -= 15;
        needsReview = true;
        notes.push(`VoIP line${detectedCarrier ? ` (${detectedCarrier})` : ''}`);
      } else {
        score += 20;
        notes.push(
          `Phone valid${detectedLineType ? ` ${detectedLineType}` : ''}${
            detectedCarrier ? ` (${detectedCarrier})` : ''
          }`
        );
      }
    } else if (verdict === 'invalid') {
      score -= 35;
      hardBlock = true;
      notes.push('Phone invalid');
    } else {
      score -= 5;
      needsReview = true;
      notes.push('Phone unconfirmed');
    }
  }

  if (whatsappResult) {
    const verdict = String(whatsappResult.verdict || '').toLowerCase();
    if (verdict === 'on_whatsapp') {
      score += 18;
      notes.push('Active on WhatsApp');
    } else if (verdict === 'not_on_whatsapp') {
      score -= 12;
      needsReview = true;
      notes.push('Not on WhatsApp');
    } else if (verdict === 'invalid') {
      score -= 25;
      hardBlock = true;
      notes.push('WhatsApp number invalid');
    }
  }

  let callerName = '';
  let callerMatch = 'not_compared';

  if (callerResult) {
    const verdict = String(callerResult.verdict || '').toLowerCase();
    callerName = String(callerResult.caller_name || '').trim();
    if (!detectedCarrier && callerResult.details?.carrier) {
      detectedCarrier = String(callerResult.details.carrier).trim();
    }
    if (!detectedLineType && callerResult.details?.line_type) {
      detectedLineType = String(callerResult.details.line_type).trim();
    }

    if (verdict === 'found' && callerName) {
      callerMatch = compareLeadAndCallerName(leadName, callerName);
      if (callerMatch === 'exact_match' || callerMatch === 'partial_match') {
        score += 12;
        notes.push(`Caller ID matched (${callerName})`);
      } else if (callerMatch === 'mismatch') {
        score -= 10;
        needsReview = true;
        notes.push(`Caller ID mismatch (${callerName})`);
      } else {
        score += 8;
        notes.push(`Caller ID: ${callerName}`);
      }
    } else if (verdict === 'invalid') {
      score -= 25;
      hardBlock = true;
      notes.push('Caller ID number invalid');
    } else {
      notes.push('Caller ID unlisted');
    }
  }

  const clampedScore = Math.max(0, Math.min(100, Math.round(score)));

  let riskVerdict = 'REVIEW';
  if (hardBlock || clampedScore < 35) {
    riskVerdict = 'BLOCK';
  } else if (!needsReview && clampedScore >= 70) {
    riskVerdict = 'APPROVE';
  }

  const normalizedPhone =
    phoneResult?.phone_number || whatsappResult?.phone_number || callerResult?.phone_number || '';

  return {
    trustScore: clampedScore,
    riskVerdict,
    normalizedPhone,
    emailVerdict: emailResult ? String(emailResult.verdict || 'unknown') : '',
    phoneVerdict: phoneResult ? String(phoneResult.verdict || 'unknown') : '',
    phoneCarrier: detectedCarrier,
    phoneLineType: detectedLineType,
    whatsappVerdict: whatsappResult ? String(whatsappResult.verdict || 'unknown') : '',
    callerName,
    callerMatch,
    summary: notes.join(' · ') || 'No verifiable contact fields present',
    verifiedAt: new Date().toISOString(),
  };
}

export function createSessionCache() {
  const store = new Map();
  return {
    get(operation, key) {
      return store.get(`${operation}:${key}`);
    },
    set(operation, key, value) {
      store.set(`${operation}:${key}`, value);
      return value;
    },
    get size() {
      return store.size;
    },
    clear() {
      store.clear();
    },
  };
}

/**
 * Enriches a single record's extracted inputs using the enabled ProWebLook operations
 * and deduplicates repeated emails/phones within the session cache.
 */
export async function enrichContactInputs({
  apiKey,
  email = '',
  phoneNumber = '',
  countryCode = '',
  leadName = '',
  enableEmail = true,
  enablePhone = true,
  enableWhatsapp = true,
  enableCallerId = false,
  cache = null,
  fetchImpl,
  baseUrl,
  signal,
}) {
  const cleanEmail = String(email || '').trim();
  const cleanPhone = String(phoneNumber || '').trim();
  const cleanCountry = normalizeCountryHint(countryCode);
  const phoneCacheKey = `${cleanPhone.replace(/[\s().-]/g, '')}|${cleanCountry}`;

  let emailResult = null;
  let phoneResult = null;
  let whatsappResult = null;
  let callerResult = null;
  let apiCallsMade = 0;

  if (enableEmail && cleanEmail) {
    const emailKey = cleanEmail.toLowerCase();
    const cached = cache ? cache.get('verify_email', emailKey) : undefined;
    if (cached) {
      emailResult = cached;
    } else {
      emailResult = await verifyEmailAddress({
        apiKey,
        email: cleanEmail,
        fetchImpl,
        baseUrl,
        signal,
      });
      apiCallsMade += 1;
      if (cache) {
        cache.set('verify_email', emailKey, emailResult);
      }
    }
  }

  if (enablePhone && cleanPhone) {
    const cached = cache ? cache.get('validate_phone', phoneCacheKey) : undefined;
    if (cached) {
      phoneResult = cached;
    } else {
      phoneResult = await validatePhoneNumber({
        apiKey,
        phoneNumber: cleanPhone,
        countryCode: cleanCountry,
        fetchImpl,
        baseUrl,
        signal,
      });
      apiCallsMade += 1;
      if (cache) {
        cache.set('validate_phone', phoneCacheKey, phoneResult);
      }
    }
  }

  // If validate_phone already confirmed the phone is invalid, skip paid WhatsApp/CallerID calls!
  const phoneKnownInvalid =
    phoneResult && String(phoneResult.verdict || '').toLowerCase() === 'invalid';

  if (enableWhatsapp && cleanPhone && !phoneKnownInvalid) {
    const cached = cache ? cache.get('check_whatsapp', phoneCacheKey) : undefined;
    if (cached) {
      whatsappResult = cached;
    } else {
      whatsappResult = await checkWhatsappStatus({
        apiKey,
        phoneNumber: phoneResult?.phone_number || cleanPhone,
        countryCode: cleanCountry,
        fetchImpl,
        baseUrl,
        signal,
      });
      apiCallsMade += 1;
      if (cache) {
        cache.set('check_whatsapp', phoneCacheKey, whatsappResult);
      }
    }
  }

  if (enableCallerId && cleanPhone && !phoneKnownInvalid) {
    const cached = cache ? cache.get('caller_id', phoneCacheKey) : undefined;
    if (cached) {
      callerResult = cached;
    } else {
      callerResult = await lookupCallerId({
        apiKey,
        phoneNumber: phoneResult?.phone_number || whatsappResult?.phone_number || cleanPhone,
        countryCode: cleanCountry,
        fetchImpl,
        baseUrl,
        signal,
      });
      apiCallsMade += 1;
      if (cache) {
        cache.set('caller_id', phoneCacheKey, callerResult);
      }
    }
  }

  const assessment = computeLeadTrustAssessment({
    emailResult,
    phoneResult,
    whatsappResult,
    callerResult,
    leadName,
  });

  return {
    assessment,
    raw: { emailResult, phoneResult, whatsappResult, callerResult },
    apiCallsMade,
  };
}

/**
 * Coerces an output value to match the target Airtable field's type
 * (singleLineText, multilineText, number, checkbox, singleSelect, dateTime, date).
 */
export function coerceValueForAirtableField(fieldMeta, rawValue) {
  if (!fieldMeta || rawValue === undefined || rawValue === null || rawValue === '') {
    return undefined;
  }

  const fieldType = String(fieldMeta.type || 'singleLineText');

  if (fieldType === 'number' || fieldType === 'percent' || fieldType === 'rating') {
    const num = Number(rawValue);
    return Number.isFinite(num) ? num : undefined;
  }

  if (fieldType === 'checkbox') {
    if (typeof rawValue === 'boolean') {
      return rawValue;
    }
    const lower = String(rawValue).toLowerCase();
    return ['true', '1', 'yes', 'deliverable', 'valid', 'on_whatsapp', 'found', 'approve'].includes(
      lower
    );
  }

  if (fieldType === 'singleSelect') {
    const desired = String(rawValue).trim();
    const choices = fieldMeta.options && Array.isArray(fieldMeta.options.choices)
      ? fieldMeta.options.choices
      : [];
    if (choices.length > 0) {
      const matched = choices.find(
        (choice) => String(choice.name || '').toLowerCase() === desired.toLowerCase()
      );
      return matched ? { name: matched.name } : undefined;
    }
    return { name: desired };
  }

  if (fieldType === 'date') {
    return String(rawValue).slice(0, 10);
  }

  if (fieldType === 'dateTime') {
    return String(rawValue);
  }

  return String(rawValue);
}

/**
 * Builds the `fields` update object for a single Airtable record given field metadata and mapping.
 */
export function buildAirtableRecordFieldsUpdate(tableFields = [], mapping = {}, assessment = {}) {
  const byKey = new Map();
  for (const field of tableFields) {
    if (field && field.id) {
      byKey.set(field.id, field);
    }
    if (field && field.name) {
      byKey.set(field.name, field);
    }
  }

  const pairs = [
    [mapping.emailVerdictOutputField, assessment.emailVerdict],
    [mapping.phoneVerdictOutputField, assessment.phoneVerdict],
    [mapping.phoneCarrierOutputField, assessment.phoneCarrier],
    [mapping.phoneLineTypeOutputField, assessment.phoneLineType],
    [mapping.normalizedPhoneOutputField, assessment.normalizedPhone],
    [mapping.whatsappVerdictOutputField, assessment.whatsappVerdict],
    [mapping.callerNameOutputField, assessment.callerName],
    [mapping.trustScoreOutputField, assessment.trustScore],
    [mapping.riskVerdictOutputField, assessment.riskVerdict],
    [mapping.summaryOutputField, assessment.summary],
    [mapping.verifiedAtOutputField, assessment.verifiedAt],
  ];

  const fieldsUpdate = {};
  for (const [targetFieldKey, rawVal] of pairs) {
    if (!targetFieldKey) {
      continue;
    }
    const fieldMeta = byKey.get(targetFieldKey) || { id: targetFieldKey, type: 'singleLineText' };
    if (fieldMeta.isComputed) {
      continue;
    }
    const coerced = coerceValueForAirtableField(fieldMeta, rawVal);
    if (coerced !== undefined) {
      fieldsUpdate[fieldMeta.id || targetFieldKey] = coerced;
    }
  }

  return fieldsUpdate;
}

/**
 * Splits Airtable record update objects into chunks of at most 50 records
 * per Airtable's `table.updateRecordsAsync` contract.
 */
export function chunkRecordUpdates(updates, batchSize = AIRTABLE_MAX_BATCH_SIZE) {
  if (!Array.isArray(updates) || updates.length === 0) {
    return [];
  }
  const size = Math.max(1, Math.min(AIRTABLE_MAX_BATCH_SIZE, Math.trunc(batchSize) || AIRTABLE_MAX_BATCH_SIZE));
  const chunks = [];
  for (let i = 0; i < updates.length; i += size) {
    chunks.push(updates.slice(i, i + size));
  }
  return chunks;
}

export async function applyBatchedRecordUpdates(table, updates, { onBatchWritten } = {}) {
  const chunks = chunkRecordUpdates(updates, AIRTABLE_MAX_BATCH_SIZE);
  let written = 0;
  for (const batch of chunks) {
    if (typeof table.checkPermissionsForUpdateRecords === 'function') {
      const perm = table.checkPermissionsForUpdateRecords(batch);
      if (perm && perm.hasPermission === false) {
        throw new Error(perm.reasonDisplayString || 'You do not have permission to update records in this Airtable table.');
      }
    }
    await table.updateRecordsAsync(batch);
    written += batch.length;
    if (typeof onBatchWritten === 'function') {
      onBatchWritten({ batchCount: batch.length, totalWritten: written, totalPending: updates.length });
    }
  }
  return written;
}
