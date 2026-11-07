import React, { useState, useRef, useCallback, useMemo } from 'react';
import { cursor } from '@airtable/blocks';
import {
  useBase,
  useRecords,
  useGlobalConfig,
  useLoadable,
  useWatchable,
  Box,
  Heading,
  Text,
  Button,
  Input,
  Switch,
  SelectButtons,
  TablePickerSynced,
  ViewPickerSynced,
  FieldPickerSynced,
  ProgressBar,
  Link,
} from '@airtable/blocks/ui';
import { fetchBalances, sanitizeApiKey, normalizeCountryHint } from './api.js';
import {
  getRecordFieldText,
  shouldSkipVerifiedRecord,
  createSessionCache,
  enrichContactInputs,
  buildAirtableRecordFieldsUpdate,
  applyBatchedRecordUpdates,
} from './enrichment.js';
import {
  AUTOMATION_ON_RECORD_CREATED_SNIPPET,
  SCRIPTING_QUICK_ENRICH_SNIPPET,
} from './templates.js';

const h = React.createElement;

export const GLOBAL_CONFIG_KEYS = Object.freeze({
  API_KEY: 'proweblookApiKey',
  TABLE_ID: 'selectedTableId',
  VIEW_ID: 'selectedViewId',
  DEFAULT_COUNTRY: 'defaultCountryCode',
  SKIP_VERIFIED: 'skipAlreadyVerified',
  ENABLE_EMAIL: 'enableEmail',
  ENABLE_PHONE: 'enablePhone',
  ENABLE_WHATSAPP: 'enableWhatsapp',
  ENABLE_CALLER_ID: 'enableCallerId',
  SRC_EMAIL_FIELD: 'sourceEmailFieldId',
  SRC_PHONE_FIELD: 'sourcePhoneFieldId',
  SRC_NAME_FIELD: 'sourceLeadNameFieldId',
  OUT_EMAIL_VERDICT: 'emailVerdictOutputField',
  OUT_PHONE_VERDICT: 'phoneVerdictOutputField',
  OUT_PHONE_CARRIER: 'phoneCarrierOutputField',
  OUT_PHONE_LINE_TYPE: 'phoneLineTypeOutputField',
  OUT_NORMALIZED_PHONE: 'normalizedPhoneOutputField',
  OUT_WHATSAPP_VERDICT: 'whatsappVerdictOutputField',
  OUT_CALLER_NAME: 'callerNameOutputField',
  OUT_TRUST_SCORE: 'trustScoreOutputField',
  OUT_RISK_VERDICT: 'riskVerdictOutputField',
  OUT_SUMMARY: 'summaryOutputField',
  OUT_VERIFIED_AT: 'verifiedAtOutputField',
});

const TAB_OPTIONS = [
  { value: 'bulk', label: 'Bulk Enrich' },
  { value: 'inspector', label: 'Record Inspector' },
  { value: 'automations', label: 'Automations' },
  { value: 'settings', label: 'Credits & Key' },
];

function VerdictBadge({ verdict }) {
  const upper = String(verdict || '').toUpperCase();
  let bg = '#eef2ff';
  let fg = '#3730a3';
  if (['APPROVE', 'DELIVERABLE', 'VALID', 'ON_WHATSAPP', 'FOUND'].includes(upper)) {
    bg = '#dcfce7';
    fg = '#166534';
  } else if (['BLOCK', 'UNDELIVERABLE', 'INVALID'].includes(upper)) {
    bg = '#fee2e2';
    fg = '#991b1b';
  } else if (['REVIEW', 'UNKNOWN', 'NOT_ON_WHATSAPP'].includes(upper)) {
    bg = '#fef3c7';
    fg = '#92400e';
  }
  return h(
    'span',
    {
      style: {
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '999px',
        fontSize: '11px',
        fontWeight: 700,
        letterSpacing: '0.03em',
        backgroundColor: bg,
        color: fg,
      },
    },
    upper || 'N/A'
  );
}

export function ProWebLookAirtableApp() {
  const base = useBase();
  const globalConfig = useGlobalConfig();
  useLoadable(cursor);
  useWatchable(cursor, ['activeTableId', 'selectedRecordIds']);

  const [activeTab, setActiveTab] = useState('bulk');
  const [apiKeyDraft, setApiKeyDraft] = useState(
    () => String(globalConfig.get(GLOBAL_CONFIG_KEYS.API_KEY) || '')
  );
  const [balances, setBalances] = useState(null);
  const [balanceError, setBalanceError] = useState('');
  const [isCheckingBalance, setIsCheckingBalance] = useState(false);

  const [isRunningBulk, setIsRunningBulk] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({
    processed: 0,
    total: 0,
    updated: 0,
    skipped: 0,
    apiCalls: 0,
    statusText: '',
    error: '',
  });
  const abortRef = useRef(null);

  const [inspectorState, setInspectorState] = useState({
    loading: false,
    result: null,
    error: '',
  });
  const [copiedKey, setCopiedKey] = useState('');

  const storedApiKey = sanitizeApiKey(String(globalConfig.get(GLOBAL_CONFIG_KEYS.API_KEY) || ''));
  const selectedTableId = globalConfig.get(GLOBAL_CONFIG_KEYS.TABLE_ID);
  const table =
    (selectedTableId && base.getTableByIdIfExists(selectedTableId)) ||
    (cursor.activeTableId && base.getTableByIdIfExists(cursor.activeTableId)) ||
    base.tables[0] ||
    null;

  const selectedViewId = globalConfig.get(GLOBAL_CONFIG_KEYS.VIEW_ID);
  const view = (table && selectedViewId && table.getViewByIdIfExists(selectedViewId)) || null;
  const records = useRecords(view || table);

  const defaultCountry = String(globalConfig.get(GLOBAL_CONFIG_KEYS.DEFAULT_COUNTRY) || 'US');
  const skipAlreadyVerified = globalConfig.get(GLOBAL_CONFIG_KEYS.SKIP_VERIFIED) !== false;
  const enableEmail = globalConfig.get(GLOBAL_CONFIG_KEYS.ENABLE_EMAIL) !== false;
  const enablePhone = globalConfig.get(GLOBAL_CONFIG_KEYS.ENABLE_PHONE) !== false;
  const enableWhatsapp = globalConfig.get(GLOBAL_CONFIG_KEYS.ENABLE_WHATSAPP) !== false;
  const enableCallerId = Boolean(globalConfig.get(GLOBAL_CONFIG_KEYS.ENABLE_CALLER_ID));

  const mapping = useMemo(
    () => ({
      sourceEmailField: globalConfig.get(GLOBAL_CONFIG_KEYS.SRC_EMAIL_FIELD) || '',
      sourcePhoneField: globalConfig.get(GLOBAL_CONFIG_KEYS.SRC_PHONE_FIELD) || '',
      sourceNameField: globalConfig.get(GLOBAL_CONFIG_KEYS.SRC_NAME_FIELD) || '',
      emailVerdictOutputField: globalConfig.get(GLOBAL_CONFIG_KEYS.OUT_EMAIL_VERDICT) || '',
      phoneVerdictOutputField: globalConfig.get(GLOBAL_CONFIG_KEYS.OUT_PHONE_VERDICT) || '',
      phoneCarrierOutputField: globalConfig.get(GLOBAL_CONFIG_KEYS.OUT_PHONE_CARRIER) || '',
      phoneLineTypeOutputField: globalConfig.get(GLOBAL_CONFIG_KEYS.OUT_PHONE_LINE_TYPE) || '',
      normalizedPhoneOutputField: globalConfig.get(GLOBAL_CONFIG_KEYS.OUT_NORMALIZED_PHONE) || '',
      whatsappVerdictOutputField: globalConfig.get(GLOBAL_CONFIG_KEYS.OUT_WHATSAPP_VERDICT) || '',
      callerNameOutputField: globalConfig.get(GLOBAL_CONFIG_KEYS.OUT_CALLER_NAME) || '',
      trustScoreOutputField: globalConfig.get(GLOBAL_CONFIG_KEYS.OUT_TRUST_SCORE) || '',
      riskVerdictOutputField: globalConfig.get(GLOBAL_CONFIG_KEYS.OUT_RISK_VERDICT) || '',
      summaryOutputField: globalConfig.get(GLOBAL_CONFIG_KEYS.OUT_SUMMARY) || '',
      verifiedAtOutputField: globalConfig.get(GLOBAL_CONFIG_KEYS.OUT_VERIFIED_AT) || '',
    }),
    [globalConfig]
  );

  const queueStats = useMemo(() => {
    if (!records || records.length === 0) {
      return { total: 0, toVerify: 0, skippedVerified: 0, emptyInputs: 0 };
    }
    let toVerify = 0;
    let skippedVerified = 0;
    let emptyInputs = 0;
    for (const rec of records) {
      if (
        shouldSkipVerifiedRecord(rec, mapping, {
          skipAlreadyVerified,
          enableEmail,
          enablePhone,
          enableWhatsapp,
          enableCallerId,
        })
      ) {
        skippedVerified += 1;
        continue;
      }
      const em = mapping.sourceEmailField ? getRecordFieldText(rec, mapping.sourceEmailField) : '';
      const ph = mapping.sourcePhoneField ? getRecordFieldText(rec, mapping.sourcePhoneField) : '';
      if (!em && !ph) {
        emptyInputs += 1;
        continue;
      }
      toVerify += 1;
    }
    return { total: records.length, toVerify, skippedVerified, emptyInputs };
  }, [
    records,
    mapping,
    skipAlreadyVerified,
    enableEmail,
    enablePhone,
    enableWhatsapp,
    enableCallerId,
  ]);

  const setGlobalIfPermitted = useCallback(
    async (key, val) => {
      const check = globalConfig.checkPermissionsForSet(key, val);
      if (check.hasPermission) {
        await globalConfig.setAsync(key, val);
      }
    },
    [globalConfig]
  );

  const handleSaveAndTestKey = useCallback(async () => {
    const clean = sanitizeApiKey(apiKeyDraft);
    setBalanceError('');
    if (!clean) {
      setBalanceError('Enter a valid non-empty ProWebLook API key.');
      return;
    }
    setIsCheckingBalance(true);
    try {
      const data = await fetchBalances({ apiKey: clean });
      setBalances(data);
      await setGlobalIfPermitted(GLOBAL_CONFIG_KEYS.API_KEY, clean);
    } catch (err) {
      setBalanceError(err.message || 'Unable to verify API key.');
    } finally {
      setIsCheckingBalance(false);
    }
  }, [apiKeyDraft, setGlobalIfPermitted]);

  const handleStartBulk = useCallback(async () => {
    const activeKey = sanitizeApiKey(storedApiKey || apiKeyDraft);
    if (!activeKey) {
      setActiveTab('settings');
      setBalanceError('Connect your ProWebLook API key before running bulk enrichment.');
      return;
    }
    if (!table || !records || records.length === 0) {
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    const sessionCache = createSessionCache();
    const pendingUpdates = [];

    setIsRunningBulk(true);
    setBulkProgress({
      processed: 0,
      total: queueStats.toVerify,
      updated: 0,
      skipped: queueStats.skippedVerified,
      apiCalls: 0,
      statusText: 'Starting enrichment...',
      error: '',
    });

    let processed = 0;
    let updated = 0;
    let skipped = 0;
    let apiCalls = 0;

    try {
      for (const rec of records) {
        if (controller.signal.aborted) {
          break;
        }
        if (
          shouldSkipVerifiedRecord(rec, mapping, {
            skipAlreadyVerified,
            enableEmail,
            enablePhone,
            enableWhatsapp,
            enableCallerId,
          })
        ) {
          skipped += 1;
          continue;
        }

        const email = mapping.sourceEmailField
          ? getRecordFieldText(rec, mapping.sourceEmailField)
          : '';
        const phoneNumber = mapping.sourcePhoneField
          ? getRecordFieldText(rec, mapping.sourcePhoneField)
          : '';
        const leadName = mapping.sourceNameField
          ? getRecordFieldText(rec, mapping.sourceNameField)
          : '';

        if (!email && !phoneNumber) {
          continue;
        }

        const enriched = await enrichContactInputs({
          apiKey: activeKey,
          email,
          phoneNumber,
          countryCode: normalizeCountryHint(defaultCountry),
          leadName,
          enableEmail,
          enablePhone,
          enableWhatsapp,
          enableCallerId,
          cache: sessionCache,
          signal: controller.signal,
        });

        apiCalls += enriched.apiCallsMade;
        processed += 1;

        const fields = buildAirtableRecordFieldsUpdate(
          table.fields,
          mapping,
          enriched.assessment
        );
        if (Object.keys(fields).length > 0) {
          pendingUpdates.push({ id: rec.id, fields });
        }

        if (pendingUpdates.length >= 50) {
          const batchToFlush = pendingUpdates.splice(0, 50);
          await applyBatchedRecordUpdates(table, batchToFlush);
          updated += batchToFlush.length;
        }

        setBulkProgress({
          processed,
          total: queueStats.toVerify,
          updated,
          skipped,
          apiCalls,
          statusText: `Verified ${processed} of ${queueStats.toVerify} records...`,
          error: '',
        });

        // Gentle pacing when making live API calls so 60 req/min rate limit is respected
        if (enriched.apiCallsMade > 0) {
          await new Promise((r) => setTimeout(r, 1100 * enriched.apiCallsMade));
        }
      }

      if (pendingUpdates.length > 0 && !controller.signal.aborted) {
        await applyBatchedRecordUpdates(table, pendingUpdates);
        updated += pendingUpdates.length;
      }

      setBulkProgress((prev) => ({
        ...prev,
        processed,
        updated,
        skipped,
        apiCalls,
        statusText: controller.signal.aborted
          ? `Stopped after updating ${updated} records.`
          : `Completed! Updated ${updated} records (${skipped} already-verified skipped).`,
      }));
    } catch (err) {
      if (err && err.name !== 'AbortError') {
        setBulkProgress((prev) => ({
          ...prev,
          error: err.message || 'Bulk enrichment encountered an error.',
          statusText: `Paused after updating ${updated} records.`,
        }));
      }
    } finally {
      setIsRunningBulk(false);
      abortRef.current = null;
    }
  }, [
    storedApiKey,
    apiKeyDraft,
    table,
    records,
    queueStats,
    mapping,
    skipAlreadyVerified,
    enableEmail,
    enablePhone,
    enableWhatsapp,
    enableCallerId,
    defaultCountry,
  ]);

  const selectedRecord = useMemo(() => {
    if (!records || !cursor.selectedRecordIds || cursor.selectedRecordIds.length === 0) {
      return null;
    }
    const targetId = cursor.selectedRecordIds[0];
    return records.find((r) => r.id === targetId) || null;
  }, [records, cursor.selectedRecordIds]);

  const handleInspectSelectedRecord = useCallback(
    async (writeBack = false) => {
      const activeKey = sanitizeApiKey(storedApiKey || apiKeyDraft);
      if (!activeKey) {
        setActiveTab('settings');
        setBalanceError('Connect your ProWebLook API key first.');
        return;
      }
      if (!selectedRecord || !table) {
        return;
      }
      setInspectorState({ loading: true, result: null, error: '' });
      try {
        const email = mapping.sourceEmailField
          ? getRecordFieldText(selectedRecord, mapping.sourceEmailField)
          : '';
        const phoneNumber = mapping.sourcePhoneField
          ? getRecordFieldText(selectedRecord, mapping.sourcePhoneField)
          : '';
        const leadName = mapping.sourceNameField
          ? getRecordFieldText(selectedRecord, mapping.sourceNameField)
          : '';

        const enriched = await enrichContactInputs({
          apiKey: activeKey,
          email,
          phoneNumber,
          countryCode: normalizeCountryHint(defaultCountry),
          leadName,
          enableEmail,
          enablePhone,
          enableWhatsapp,
          enableCallerId,
        });

        if (writeBack) {
          const fields = buildAirtableRecordFieldsUpdate(
            table.fields,
            mapping,
            enriched.assessment
          );
          if (Object.keys(fields).length > 0) {
            await applyBatchedRecordUpdates(table, [{ id: selectedRecord.id, fields }]);
          }
        }

        setInspectorState({ loading: false, result: enriched.assessment, error: '' });
      } catch (err) {
        setInspectorState({
          loading: false,
          result: null,
          error: err.message || 'Verification failed.',
        });
      }
    },
    [
      storedApiKey,
      apiKeyDraft,
      selectedRecord,
      table,
      mapping,
      defaultCountry,
      enableEmail,
      enablePhone,
      enableWhatsapp,
      enableCallerId,
    ]
  );

  const handleCopySnippet = useCallback((key, text) => {
    if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(''), 2000);
    }
  }, []);

  return h(
    Box,
    { padding: 3, backgroundColor: '#f8fafc', minHeight: '100vh' },
    // Top Header
    h(
      Box,
      {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 2,
      },
      h(
        Box,
        null,
        h(Heading, { size: 'small', marginBottom: '2px' }, 'ProWebLook Lead & WhatsApp Verifier'),
        h(
          Text,
          { textColor: 'light', size: 'small' },
          'Real-time Email, Phone Carrier/VoIP, Silent WhatsApp & Caller ID inside Airtable'
        )
      ),
      h(
        Button,
        {
          size: 'small',
          variant: storedApiKey ? 'secondary' : 'primary',
          onClick: () => setActiveTab('settings'),
        },
        storedApiKey ? 'API Key Connected' : 'Connect API Key'
      )
    ),

    // Navigation Tabs
    h(
      Box,
      { marginBottom: 3 },
      h(SelectButtons, {
        value: activeTab,
        onChange: (val) => setActiveTab(val),
        options: TAB_OPTIONS,
        size: 'small',
      })
    ),

    // TAB 1: BULK ENRICH
    activeTab === 'bulk' &&
      h(
        Box,
        {
          backgroundColor: 'white',
          padding: 3,
          borderRadius: 'large',
          border: 'default',
        },
        h(Heading, { size: 'xsmall', marginBottom: 2 }, '1. Select Target Table & View'),
        h(
          Box,
          { display: 'flex', marginBottom: 3, style: { gap: '8px' } },
          h(
            Box,
            { flex: 1 },
            h(Text, { size: 'small', marginBottom: 1 }, 'Table'),
            h(TablePickerSynced, { globalConfigKey: GLOBAL_CONFIG_KEYS.TABLE_ID })
          ),
          table &&
            h(
              Box,
              { flex: 1 },
              h(Text, { size: 'small', marginBottom: 1 }, 'View (Optional)'),
              h(ViewPickerSynced, {
                table,
                globalConfigKey: GLOBAL_CONFIG_KEYS.VIEW_ID,
                shouldAllowPickingNone: true,
              })
            )
        ),

        h(Heading, { size: 'xsmall', marginBottom: 2 }, '2. Verification Signals'),
        h(
          Box,
          { marginBottom: 3 },
          h(Switch, {
            value: enableEmail,
            onChange: (v) => setGlobalIfPermitted(GLOBAL_CONFIG_KEYS.ENABLE_EMAIL, v),
            label: 'Email Verification (SMTP, MX, Disposable & Catch-All)',
            marginBottom: 1,
          }),
          h(Switch, {
            value: enablePhone,
            onChange: (v) => setGlobalIfPermitted(GLOBAL_CONFIG_KEYS.ENABLE_PHONE, v),
            label: 'Phone Carrier & Line Type (Mobile vs Landline vs VoIP)',
            marginBottom: 1,
          }),
          h(Switch, {
            value: enableWhatsapp,
            onChange: (v) => setGlobalIfPermitted(GLOBAL_CONFIG_KEYS.ENABLE_WHATSAPP, v),
            label: 'Silent WhatsApp Registration Check (Zero OTP sent)',
            marginBottom: 1,
          }),
          h(Switch, {
            value: enableCallerId,
            onChange: (v) => setGlobalIfPermitted(GLOBAL_CONFIG_KEYS.ENABLE_CALLER_ID, v),
            label: 'Caller ID (CNAM) Lookup & Lead Name Matching',
          })
        ),

        table &&
          h(
            Box,
            { marginBottom: 3 },
            h(Heading, { size: 'xsmall', marginBottom: 2 }, '3. Map Source & Output Columns'),
            h(
              Box,
              { display: 'flex', marginBottom: 2, style: { gap: '8px' } },
              h(
                Box,
                { flex: 1 },
                h(Text, { size: 'small', marginBottom: 1 }, 'Source Email Field'),
                h(FieldPickerSynced, {
                  table,
                  globalConfigKey: GLOBAL_CONFIG_KEYS.SRC_EMAIL_FIELD,
                  shouldAllowPickingNone: true,
                })
              ),
              h(
                Box,
                { flex: 1 },
                h(Text, { size: 'small', marginBottom: 1 }, 'Source Phone Field'),
                h(FieldPickerSynced, {
                  table,
                  globalConfigKey: GLOBAL_CONFIG_KEYS.SRC_PHONE_FIELD,
                  shouldAllowPickingNone: true,
                })
              )
            ),
            h(
              Box,
              { display: 'flex', marginBottom: 2, style: { gap: '8px' } },
              h(
                Box,
                { flex: 1 },
                h(Text, { size: 'small', marginBottom: 1 }, 'Lead Name Field (for Caller ID)'),
                h(FieldPickerSynced, {
                  table,
                  globalConfigKey: GLOBAL_CONFIG_KEYS.SRC_NAME_FIELD,
                  shouldAllowPickingNone: true,
                })
              ),
              h(
                Box,
                { width: '130px' },
                h(Text, { size: 'small', marginBottom: 1 }, 'Default Country'),
                h(Input, {
                  value: defaultCountry,
                  placeholder: 'US',
                  onChange: (e) =>
                    setGlobalIfPermitted(
                      GLOBAL_CONFIG_KEYS.DEFAULT_COUNTRY,
                      e.target.value.toUpperCase().slice(0, 2)
                    ),
                })
              )
            ),
            h(
              Box,
              { display: 'flex', marginBottom: 2, style: { gap: '8px' } },
              h(
                Box,
                { flex: 1 },
                h(Text, { size: 'small', marginBottom: 1 }, 'Output: Risk Verdict (APPROVE/BLOCK)'),
                h(FieldPickerSynced, {
                  table,
                  globalConfigKey: GLOBAL_CONFIG_KEYS.OUT_RISK_VERDICT,
                  shouldAllowPickingNone: true,
                })
              ),
              h(
                Box,
                { flex: 1 },
                h(Text, { size: 'small', marginBottom: 1 }, 'Output: Trust Score (0-100)'),
                h(FieldPickerSynced, {
                  table,
                  globalConfigKey: GLOBAL_CONFIG_KEYS.OUT_TRUST_SCORE,
                  shouldAllowPickingNone: true,
                })
              )
            ),
            h(
              Box,
              { display: 'flex', marginBottom: 2, style: { gap: '8px' } },
              h(
                Box,
                { flex: 1 },
                h(Text, { size: 'small', marginBottom: 1 }, 'Output: WhatsApp Status'),
                h(FieldPickerSynced, {
                  table,
                  globalConfigKey: GLOBAL_CONFIG_KEYS.OUT_WHATSAPP_VERDICT,
                  shouldAllowPickingNone: true,
                })
              ),
              h(
                Box,
                { flex: 1 },
                h(Text, { size: 'small', marginBottom: 1 }, 'Output: Summary / Notes'),
                h(FieldPickerSynced, {
                  table,
                  globalConfigKey: GLOBAL_CONFIG_KEYS.OUT_SUMMARY,
                  shouldAllowPickingNone: true,
                })
              )
            )
          ),

        h(Switch, {
          value: skipAlreadyVerified,
          onChange: (v) => setGlobalIfPermitted(GLOBAL_CONFIG_KEYS.SKIP_VERIFIED, v),
          label: 'Skip already-verified records automatically (prevents double credit usage)',
          marginBottom: 3,
        }),

        // Queue Preview Banner
        h(
          Box,
          {
            padding: 2,
            backgroundColor: '#f1f5f9',
            borderRadius: 'default',
            marginBottom: 2,
          },
          h(
            Text,
            { size: 'small' },
            `Ready: ${queueStats.toVerify} unverified records in view · ${queueStats.skippedVerified} already verified (skipped) · ${queueStats.emptyInputs} empty`
          )
        ),

        bulkProgress.total > 0 &&
          h(
            Box,
            { marginBottom: 2 },
            h(ProgressBar, {
              progress:
                bulkProgress.total > 0
                  ? Math.min(1, bulkProgress.processed / bulkProgress.total)
                  : 0,
              barColor: '#2563eb',
            }),
            h(Text, { size: 'small', marginTop: 1 }, bulkProgress.statusText)
          ),

        bulkProgress.error &&
          h(
            Text,
            { size: 'small', textColor: '#b91c1c', marginBottom: 2 },
            bulkProgress.error
          ),

        h(
          Box,
          { display: 'flex', style: { gap: '8px' } },
          !isRunningBulk
            ? h(
                Button,
                {
                  variant: 'primary',
                  disabled: queueStats.toVerify === 0,
                  onClick: handleStartBulk,
                },
                `Verify ${queueStats.toVerify} Records`
              )
            : h(
                Button,
                {
                  variant: 'danger',
                  onClick: () => abortRef.current && abortRef.current.abort(),
                },
                'Stop Enrichment'
              )
        )
      ),

    // TAB 2: SINGLE RECORD INSPECTOR
    activeTab === 'inspector' &&
      h(
        Box,
        {
          backgroundColor: 'white',
          padding: 3,
          borderRadius: 'large',
          border: 'default',
        },
        h(Heading, { size: 'xsmall', marginBottom: 1 }, 'Live Single-Record Inspector'),
        h(
          Text,
          { size: 'small', textColor: 'light', marginBottom: 3 },
          'Select any cell or row in your Airtable Grid to preview or write verification signals for that record.'
        ),
        !selectedRecord
          ? h(
              Box,
              { padding: 3, backgroundColor: '#f8fafc', borderRadius: 'default' },
              h(Text, { size: 'small' }, 'Click any record in your Airtable table to inspect it.')
            )
          : h(
              Box,
              null,
              h(
                Text,
                { fontWeight: 'strong', marginBottom: 2 },
                `Selected Record: ${selectedRecord.name || selectedRecord.id}`
              ),
              h(
                Box,
                { display: 'flex', marginBottom: 3, style: { gap: '8px' } },
                h(
                  Button,
                  {
                    variant: 'secondary',
                    disabled: inspectorState.loading,
                    onClick: () => handleInspectSelectedRecord(false),
                  },
                  inspectorState.loading ? 'Checking...' : 'Preview Only'
                ),
                h(
                  Button,
                  {
                    variant: 'primary',
                    disabled: inspectorState.loading,
                    onClick: () => handleInspectSelectedRecord(true),
                  },
                  'Verify & Save to Record'
                )
              ),
              inspectorState.error &&
                h(Text, { size: 'small', textColor: '#b91c1c' }, inspectorState.error),
              inspectorState.result &&
                h(
                  Box,
                  { padding: 2, backgroundColor: '#f8fafc', borderRadius: 'default' },
                  h(
                    Box,
                    { display: 'flex', alignItems: 'center', marginBottom: 1, style: { gap: '8px' } },
                    h(VerdictBadge, { verdict: inspectorState.result.riskVerdict }),
                    h(
                      Text,
                      { fontWeight: 'strong' },
                      `Trust Score: ${inspectorState.result.trustScore} / 100`
                    )
                  ),
                  h(Text, { size: 'small' }, inspectorState.result.summary)
                )
            )
      ),

    // TAB 3: AUTOMATION & SCRIPTING TEMPLATES
    activeTab === 'automations' &&
      h(
        Box,
        {
          backgroundColor: 'white',
          padding: 3,
          borderRadius: 'large',
          border: 'default',
        },
        h(Heading, { size: 'xsmall', marginBottom: 1 }, 'Real-Time Airtable Automation Script'),
        h(
          Text,
          { size: 'small', textColor: 'light', marginBottom: 2 },
          'Auto-verify every new Airtable Form submission, Typeform lead, or Shopify COD order in the background using "When record created -> Run a script".'
        ),
        h(
          Button,
          {
            size: 'small',
            marginBottom: 2,
            onClick: () =>
              handleCopySnippet('automation', AUTOMATION_ON_RECORD_CREATED_SNIPPET),
          },
          copiedKey === 'automation' ? 'Copied Automation Script!' : 'Copy Automation Script'
        ),
        h(
          'pre',
          {
            style: {
              fontSize: '11px',
              backgroundColor: '#0f172a',
              color: '#e2e8f0',
              padding: '10px',
              borderRadius: '6px',
              overflowX: 'auto',
              maxHeight: '160px',
              marginBottom: '16px',
            },
          },
          AUTOMATION_ON_RECORD_CREATED_SNIPPET
        ),
        h(Heading, { size: 'xsmall', marginBottom: 1 }, 'Scripting Extension Quick-Run'),
        h(
          Button,
          {
            size: 'small',
            marginBottom: 2,
            onClick: () => handleCopySnippet('scripting', SCRIPTING_QUICK_ENRICH_SNIPPET),
          },
          copiedKey === 'scripting' ? 'Copied Scripting Snippet!' : 'Copy Scripting Snippet'
        ),
        h(
          'pre',
          {
            style: {
              fontSize: '11px',
              backgroundColor: '#0f172a',
              color: '#e2e8f0',
              padding: '10px',
              borderRadius: '6px',
              overflowX: 'auto',
              maxHeight: '140px',
            },
          },
          SCRIPTING_QUICK_ENRICH_SNIPPET
        )
      ),

    // TAB 4: CREDITS & API KEY
    activeTab === 'settings' &&
      h(
        Box,
        {
          backgroundColor: 'white',
          padding: 3,
          borderRadius: 'large',
          border: 'default',
        },
        h(Heading, { size: 'xsmall', marginBottom: 1 }, 'ProWebLook API Key'),
        h(
          Text,
          { size: 'small', textColor: 'light', marginBottom: 2 },
          'Every new ProWebLook account includes 50 free credits per product. Generate your key at ',
          h(Link, { href: 'https://proweblook.com/user/api', target: '_blank' }, 'proweblook.com/user/api'),
          '.'
        ),
        h(
          Box,
          { display: 'flex', marginBottom: 2, style: { gap: '8px' } },
          h(
            Box,
            { flex: 1 },
            h(Input, {
              type: 'password',
              value: apiKeyDraft,
              placeholder: 'Paste your ProWebLook API key',
              onChange: (e) => setApiKeyDraft(e.target.value),
            })
          ),
          h(
            Button,
            {
              variant: 'primary',
              disabled: isCheckingBalance,
              onClick: handleSaveAndTestKey,
            },
            isCheckingBalance ? 'Validating...' : 'Save & Check Credits'
          )
        ),
        balanceError &&
          h(Text, { size: 'small', textColor: '#b91c1c', marginBottom: 2 }, balanceError),
        balances &&
          h(
            Box,
            { padding: 2, backgroundColor: '#f8fafc', borderRadius: 'default' },
            h(
              Text,
              { size: 'small', fontWeight: 'strong', marginBottom: 1 },
              `Connected Account: ${balances.account_email}`
            ),
            h(
              Text,
              { size: 'small' },
              `Email: ${balances.email?.amount ?? 0} · Phone: ${balances.phone?.amount ?? 0} · WhatsApp: ${balances.whatsapp?.amount ?? 0} · Caller ID: ${balances.caller?.amount ?? 0}`
            )
          )
      )
  );
}
