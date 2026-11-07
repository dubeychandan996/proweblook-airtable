# ProWebLook for Airtable — Custom Extension & Automation Scripts

Bulk-verify **Email deliverability**, **Phone Carrier & VoIP status**, **Silent WhatsApp registration**, and **Caller ID (CNAM)** directly inside Airtable bases, views, and automations — powered by the dedicated `POST https://proweblook.com/api/v1/airtable/{operation}` adapter.

## 3 Ways to Use in Airtable

### 1. 30-Second Scripting Extension (Zero CLI Setup — Works on Any Airtable Plan)
1. Open your Airtable Base → **Extensions** → **Add an extension** → **Scripting**.
2. Paste [`automations/scripting-extension-bulk-verify.js`](automations/scripting-extension-bulk-verify.js).
3. Select your **Table**, **View**, **Source Email/Phone columns**, and **Output columns** in the sidebar UI.
4. Click **Run** and enter your ProWebLook API key from [`https://proweblook.com/user/api`](https://proweblook.com/user/api) (50 free credits per product on signup).

### 2. Real-Time Airtable Automation ("When Record Created")
1. Open **Automations** in Airtable → Trigger: **When record is created** (e.g., from an Airtable Form, Typeform, HubSpot sync, or Shopify COD webhook).
2. Add Action → **Run a script** → paste [`automations/on-record-created-automation.js`](automations/on-record-created-automation.js).
3. Map input variables `recordId`, `tableName`, `email`, `phone`, `countryCode`, `leadName`, and `apiKey`.
4. Every incoming lead or order automatically receives a **0–100 Trust Score** and **`APPROVE` / `REVIEW` / `BLOCK`** verdict within seconds.

### 3. Full Custom Extension (`@airtable/blocks`)
1. In Airtable → **Extensions** → **Add an extension** → **Build a custom extension**.
2. Clone this package and run with `@airtable/blocks-cli`:
   ```bash
   npm install
   npx @airtable/blocks-cli run
   # Deploy permanently to your Airtable workspace:
   npx @airtable/blocks-cli release
   ```

## Key Safeguards
- **Skip Already-Verified Records (Default ON):** Re-running bulk enrichment skips rows that already have a completed verdict, preventing accidental double credit usage.
- **Session Deduplication Cache:** Duplicate emails or phone numbers within a batch are queried once and applied to every matching record.
- **50-Record Batch Writes:** Updates are chunked to Airtable's `50`-record `updateRecordsAsync` contract with pre-flight permission checks.
- **Short-Circuit Invalid Phones:** If `validate_phone` returns `invalid`, paid `check_whatsapp` and `caller_id` calls are skipped automatically.

## Verification & Packaging

```bash
npm test
npm run validate
npm run pack:zip
```
