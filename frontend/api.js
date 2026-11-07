export const PROWEBLOOK_AIRTABLE_API_BASE = 'https://proweblook.com/api/v1/airtable';

export const AIRTABLE_OPERATIONS = Object.freeze([
  'get_balance',
  'verify_email',
  'validate_phone',
  'check_whatsapp',
  'caller_id',
]);

export class ProWebLookApiError extends Error {
  constructor(message, { code = 'unknown_error', status = 0, retryAfterSeconds = 0 } = {}) {
    super(message);
    this.name = 'ProWebLookApiError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function sanitizeApiKey(rawKey) {
  if (typeof rawKey !== 'string') {
    return '';
  }
  const trimmed = rawKey.trim();
  if (!trimmed || trimmed.length > 255 || /[\s\x00-\x1F\x7F]/.test(trimmed)) {
    return '';
  }
  return trimmed;
}

export function normalizeCountryHint(rawCountry) {
  if (typeof rawCountry !== 'string') {
    return '';
  }
  const normalized = rawCountry.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : '';
}

export async function callAirtableApi({
  apiKey,
  operation,
  payload = {},
  baseUrl = PROWEBLOOK_AIRTABLE_API_BASE,
  fetchImpl = globalThis.fetch,
  signal,
}) {
  if (!AIRTABLE_OPERATIONS.includes(operation)) {
    throw new ProWebLookApiError(`Unsupported ProWebLook operation: ${operation}`, {
      code: 'unknown_operation',
      status: 404,
    });
  }

  const key = sanitizeApiKey(apiKey);
  if (!key) {
    throw new ProWebLookApiError(
      'Enter a valid ProWebLook API key in Settings & Credits before running lookups.',
      { code: 'invalid_credentials', status: 401 }
    );
  }

  if (typeof fetchImpl !== 'function') {
    throw new ProWebLookApiError('Fetch implementation is unavailable in this environment.', {
      code: 'service_unavailable',
      status: 503,
    });
  }

  const cleanBase = String(baseUrl || PROWEBLOOK_AIRTABLE_API_BASE).replace(/\/+$/, '');
  const url = `${cleanBase}/${operation}`;

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload && typeof payload === 'object' ? payload : {}),
      signal,
    });
  } catch (networkErr) {
    if (networkErr && networkErr.name === 'AbortError') {
      throw networkErr;
    }
    throw new ProWebLookApiError(
      'Network error contacting ProWebLook API. Check your connection and usage before retrying.',
      { code: 'network_error', status: 0 }
    );
  }

  let parsed = null;
  try {
    parsed = await response.json();
  } catch (_err) {
    parsed = null;
  }

  const retryAfterHeader =
    response.headers && typeof response.headers.get === 'function'
      ? Number.parseInt(response.headers.get('Retry-After') || '0', 10)
      : 0;

  if (!response.ok || !parsed || parsed.ok !== true || typeof parsed.data !== 'object') {
    const errorObj = parsed && parsed.error && typeof parsed.error === 'object' ? parsed.error : {};
    const code = typeof errorObj.code === 'string' && errorObj.code ? errorObj.code : `http_${response.status || 500}`;
    let safeMessage =
      typeof errorObj.message === 'string' && errorObj.message
        ? errorObj.message
        : `ProWebLook request failed (HTTP ${response.status || 500}).`;
    if (key && safeMessage.includes(key)) {
      safeMessage = 'ProWebLook request failed.';
    }
    throw new ProWebLookApiError(safeMessage, {
      code,
      status: response.status || 500,
      retryAfterSeconds: Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader : 0,
    });
  }

  return parsed.data;
}

export async function fetchBalances(options) {
  return callAirtableApi({ ...options, operation: 'get_balance', payload: {} });
}

export async function verifyEmailAddress({ email, ...options }) {
  const cleanEmail = typeof email === 'string' ? email.trim() : '';
  return callAirtableApi({
    ...options,
    operation: 'verify_email',
    payload: { email: cleanEmail },
  });
}

export async function validatePhoneNumber({ phoneNumber, countryCode, ...options }) {
  const payload = { phone_number: typeof phoneNumber === 'string' ? phoneNumber.trim() : '' };
  const cc = normalizeCountryHint(countryCode);
  if (cc && !payload.phone_number.startsWith('+')) {
    payload.country_code = cc;
  }
  return callAirtableApi({
    ...options,
    operation: 'validate_phone',
    payload,
  });
}

export async function checkWhatsappStatus({ phoneNumber, countryCode, ...options }) {
  const payload = { phone_number: typeof phoneNumber === 'string' ? phoneNumber.trim() : '' };
  const cc = normalizeCountryHint(countryCode);
  if (cc && !payload.phone_number.startsWith('+')) {
    payload.country_code = cc;
  }
  return callAirtableApi({
    ...options,
    operation: 'check_whatsapp',
    payload,
  });
}

export async function lookupCallerId({ phoneNumber, countryCode, ...options }) {
  const payload = { phone_number: typeof phoneNumber === 'string' ? phoneNumber.trim() : '' };
  const cc = normalizeCountryHint(countryCode);
  if (cc && !payload.phone_number.startsWith('+')) {
    payload.country_code = cc;
  }
  return callAirtableApi({
    ...options,
    operation: 'caller_id',
    payload,
  });
}
