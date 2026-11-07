import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  PROWEBLOOK_AIRTABLE_API_BASE,
  ProWebLookApiError,
  sanitizeApiKey,
  normalizeCountryHint,
  callAirtableApi,
  fetchBalances,
  validatePhoneNumber,
} from '../frontend/api.js';

import {
  extractPlainCellText,
  shouldSkipVerifiedRecord,
  compareLeadAndCallerName,
  computeLeadTrustAssessment,
  createSessionCache,
  enrichContactInputs,
  buildAirtableRecordFieldsUpdate,
  chunkRecordUpdates,
  applyBatchedRecordUpdates,
} from '../frontend/enrichment.js';

import {
  AUTOMATION_ON_RECORD_CREATED_SNIPPET,
  SCRIPTING_QUICK_ENRICH_SNIPPET,
} from '../frontend/templates.js';

const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('API client sanitizes keys, enforces POST Bearer JSON, and redacts leaked keys on error', async () => {
  assert.equal(sanitizeApiKey('  pwl_live_abc123  '), 'pwl_live_abc123');
  assert.equal(sanitizeApiKey('bad key with spaces'), '');
  assert.equal(sanitizeApiKey('key\r\nInjected: 1'), '');
  assert.equal(normalizeCountryHint(' in '), 'IN');
  assert.equal(normalizeCountryHint('USA'), '');

  const requests = [];
  const mockFetch = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      async json() {
        return {
          ok: true,
          data: {
            account_email: 'ops@acme.com',
            email: { amount: 120, unlimited: false },
            phone: { amount: 95, unlimited: false },
            whatsapp: { amount: 80, unlimited: false },
            caller: { amount: 40, unlimited: false },
          },
        };
      },
    };
  };

  const balances = await fetchBalances({ apiKey: 'secret-token-99', fetchImpl: mockFetch });
  assert.equal(balances.account_email, 'ops@acme.com');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${PROWEBLOOK_AIRTABLE_API_BASE}/get_balance`);
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer secret-token-99');
  assert.equal(requests[0].init.body, '{}');

  // National phone includes country_code; E.164 omits redundant country_code
  await validatePhoneNumber({
    apiKey: 'secret-token-99',
    phoneNumber: '(415) 555-0100',
    countryCode: 'us',
    fetchImpl: mockFetch,
  });
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    phone_number: '(415) 555-0100',
    country_code: 'US',
  });

  await validatePhoneNumber({
    apiKey: 'secret-token-99',
    phoneNumber: '+14155550100',
    countryCode: 'US',
    fetchImpl: mockFetch,
  });
  assert.deepEqual(JSON.parse(requests[2].init.body), {
    phone_number: '+14155550100',
  });

  // Rate limit + key redaction test
  const errorFetch = async () => ({
    ok: false,
    status: 429,
    headers: { get: (h) => (h === 'Retry-After' ? '60' : null) },
    async json() {
      return {
        ok: false,
        error: {
          code: 'rate_limited',
          message: 'Echoed key secret-token-99 must never surface',
        },
      };
    },
  });

  await assert.rejects(
    () => callAirtableApi({ apiKey: 'secret-token-99', operation: 'get_balance', fetchImpl: errorFetch }),
    (err) => {
      assert.ok(err instanceof ProWebLookApiError);
      assert.equal(err.code, 'rate_limited');
      assert.equal(err.status, 429);
      assert.equal(err.retryAfterSeconds, 60);
      assert.equal(err.message.includes('secret-token-99'), false);
      return true;
    }
  );
});

test('extractPlainCellText handles Airtable text, lookup arrays, singleSelect, and collaborator objects', () => {
  assert.equal(extractPlainCellText('  jane@acme.com '), 'jane@acme.com');
  assert.equal(extractPlainCellText({ name: 'APPROVE' }), 'APPROVE');
  assert.equal(extractPlainCellText({ email: 'collab@acme.com', name: 'Collab' }), 'collab@acme.com');
  assert.equal(extractPlainCellText([null, '', { text: '+1 415 555 2671' }]), '+1 415 555 2671');
  assert.equal(extractPlainCellText(null), '');
});

test('shouldSkipVerifiedRecord prevents double credit charges while allowing retry on error rows', () => {
  const makeRecord = (cells) => ({
    getCellValue: (f) => cells[f] ?? null,
    getCellValueAsString: (f) => String(cells[f] ?? ''),
  });

  const mapping = { riskVerdictOutputField: 'fldRisk', emailVerdictOutputField: 'fldEmailOut' };

  assert.equal(
    shouldSkipVerifiedRecord(makeRecord({ fldRisk: { name: 'APPROVE' } }), mapping, {
      skipAlreadyVerified: true,
    }),
    true
  );

  assert.equal(
    shouldSkipVerifiedRecord(makeRecord({ fldRisk: 'error' }), mapping, {
      skipAlreadyVerified: true,
    }),
    false
  );

  assert.equal(
    shouldSkipVerifiedRecord(makeRecord({ fldRisk: 'APPROVE' }), mapping, {
      skipAlreadyVerified: false,
    }),
    false
  );
});

test('Caller ID name comparison and composite Trust Score / Risk Verdict logic', () => {
  assert.equal(compareLeadAndCallerName('Dr. Jane Doe', 'DOE, JANE'), 'exact_match');
  assert.equal(compareLeadAndCallerName('Chandan Dubey', 'CHANDAN D'), 'partial_match');
  assert.equal(compareLeadAndCallerName('Alice Johnson', 'Bob Williams'), 'mismatch');
  assert.equal(compareLeadAndCallerName('', 'Jane Doe'), 'not_compared');

  const highTrust = computeLeadTrustAssessment({
    emailResult: { verdict: 'deliverable', reason: 'accepted_email' },
    phoneResult: {
      phone_number: '+14155550100',
      verdict: 'valid',
      details: { carrier: 'Verizon Wireless', line_type: 'Mobile' },
    },
    whatsappResult: { phone_number: '+14155550100', verdict: 'on_whatsapp' },
    callerResult: { phone_number: '+14155550100', verdict: 'found', caller_name: 'JANE DOE' },
    leadName: 'Jane Doe',
  });
  assert.equal(highTrust.riskVerdict, 'APPROVE');
  assert.equal(highTrust.trustScore, 100);
  assert.equal(highTrust.callerMatch, 'exact_match');

  const voipLead = computeLeadTrustAssessment({
    emailResult: { verdict: 'deliverable' },
    phoneResult: {
      phone_number: '+14155550199',
      verdict: 'valid',
      details: { carrier: 'Twilio', line_type: 'VoIP' },
    },
    whatsappResult: { phone_number: '+14155550199', verdict: 'not_on_whatsapp' },
  });
  assert.equal(voipLead.riskVerdict, 'REVIEW');
  assert.ok(voipLead.trustScore < 70);

  const fraudLead = computeLeadTrustAssessment({
    emailResult: { verdict: 'undeliverable', reason: 'disposable_domain' },
    phoneResult: { phone_number: '+14155550000', verdict: 'invalid' },
  });
  assert.equal(fraudLead.riskVerdict, 'BLOCK');
  assert.equal(fraudLead.trustScore, 0);
});

test('enrichContactInputs deduplicates repeated contacts and short-circuits WhatsApp/CallerID on invalid phone', async () => {
  const opsCalled = [];
  const mockFetch = async (url, init) => {
    const op = url.split('/').pop();
    const body = JSON.parse(init.body);
    opsCalled.push({ op, body });

    if (op === 'verify_email') {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({ ok: true, data: { email: body.email, verdict: 'deliverable' } }),
      };
    }
    if (op === 'validate_phone' && body.phone_number === '+10000000000') {
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        json: async () => ({ ok: true, data: { phone_number: '+10000000000', verdict: 'invalid' } }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => ({
        ok: true,
        data: {
          phone_number: '+14155550100',
          verdict: op === 'check_whatsapp' ? 'on_whatsapp' : op === 'caller_id' ? 'found' : 'valid',
          caller_name: 'Jane Doe',
          details: { carrier: 'AT&T', line_type: 'Mobile' },
        },
      }),
    };
  };

  const cache = createSessionCache();

  // Invalid phone should NOT trigger check_whatsapp or caller_id!
  const invalidRun = await enrichContactInputs({
    apiKey: 'pwl_key',
    email: 'buyer@shop.com',
    phoneNumber: '+10000000000',
    enableEmail: true,
    enablePhone: true,
    enableWhatsapp: true,
    enableCallerId: true,
    cache,
    fetchImpl: mockFetch,
  });
  assert.equal(invalidRun.assessment.riskVerdict, 'BLOCK');
  assert.deepEqual(
    opsCalled.map((c) => c.op),
    ['verify_email', 'validate_phone']
  );

  // Duplicate email + valid phone on second row reuses cached email result!
  const secondRun = await enrichContactInputs({
    apiKey: 'pwl_key',
    email: 'BUYER@shop.com',
    phoneNumber: '4155550100',
    countryCode: 'US',
    leadName: 'Jane Doe',
    enableEmail: true,
    enablePhone: true,
    enableWhatsapp: true,
    enableCallerId: true,
    cache,
    fetchImpl: mockFetch,
  });
  assert.equal(secondRun.assessment.riskVerdict, 'APPROVE');
  assert.equal(secondRun.apiCallsMade, 3); // validate_phone + check_whatsapp + caller_id (email was cached!)

  // Exact duplicate row makes 0 API calls
  const thirdRun = await enrichContactInputs({
    apiKey: 'pwl_key',
    email: 'buyer@shop.com',
    phoneNumber: '415-555-0100',
    countryCode: 'US',
    enableEmail: true,
    enablePhone: true,
    enableWhatsapp: true,
    enableCallerId: true,
    cache,
    fetchImpl: mockFetch,
  });
  assert.equal(thirdRun.apiCallsMade, 0);
});

test('Field formatting and 50-record Airtable batch chunking enforce Airtable SDK limits', async () => {
  const tableFields = [
    {
      id: 'fldVerdict',
      name: 'Verification Status',
      type: 'singleSelect',
      options: { choices: [{ name: 'APPROVE' }, { name: 'REVIEW' }, { name: 'BLOCK' }] },
    },
    { id: 'fldScore', name: 'Trust Score', type: 'number' },
    { id: 'fldWa', name: 'On WhatsApp', type: 'checkbox' },
    { id: 'fldFormula', name: 'Computed Formula', type: 'formula', isComputed: true },
    { id: 'fldDate', name: 'Verified Date', type: 'date' },
  ];

  const fields = buildAirtableRecordFieldsUpdate(
    tableFields,
    {
      riskVerdictOutputField: 'fldVerdict',
      trustScoreOutputField: 'fldScore',
      whatsappVerdictOutputField: 'fldWa',
      summaryOutputField: 'fldFormula',
      verifiedAtOutputField: 'fldDate',
    },
    {
      riskVerdict: 'approve',
      trustScore: 92,
      whatsappVerdict: 'on_whatsapp',
      summary: 'Should not write to computed field',
      verifiedAt: '2026-11-07T08:00:00.000Z',
    }
  );

  assert.deepEqual(fields, {
    fldVerdict: { name: 'APPROVE' },
    fldScore: 92,
    fldWa: true,
    fldDate: '2026-11-07',
  });

  const dummyRecords = Array.from({ length: 125 }, (_, idx) => ({
    id: `rec${idx}`,
    fields: { fldScore: 80 },
  }));
  const chunks = chunkRecordUpdates(dummyRecords);
  assert.equal(chunks.length, 3);
  assert.deepEqual(
    chunks.map((c) => c.length),
    [50, 50, 25]
  );

  const batchesWritten = [];
  const fakeTable = {
    checkPermissionsForUpdateRecords: () => ({ hasPermission: true }),
    updateRecordsAsync: async (batch) => {
      assert.ok(batch.length <= 50);
      batchesWritten.push(batch.length);
    },
  };
  const total = await applyBatchedRecordUpdates(fakeTable, dummyRecords);
  assert.equal(total, 125);
  assert.deepEqual(batchesWritten, [50, 50, 25]);
});

test('All Custom Extension modules and Automation/Scripting templates pass syntax checks', () => {
  const jsFiles = [
    'frontend/index.js',
    'frontend/App.js',
    'frontend/api.js',
    'frontend/enrichment.js',
    'frontend/templates.js',
    'automations/on-record-created-automation.js',
    'automations/scripting-extension-bulk-verify.js',
  ];
  for (const rel of jsFiles) {
    const abs = path.join(pkgRoot, rel);
    assert.equal(fs.existsSync(abs), true, `Expected ${rel} to exist`);
    execFileSync(process.execPath, ['--check', abs], { stdio: 'pipe' });
  }
  assert.ok(AUTOMATION_ON_RECORD_CREATED_SNIPPET.includes('https://proweblook.com/api/v1/airtable'));
  assert.ok(SCRIPTING_QUICK_ENRICH_SNIPPET.includes('remoteFetchAsync'));
});
