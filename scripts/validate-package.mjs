import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const requiredFiles = [
  'block.json',
  'package.json',
  'README.md',
  'LICENSE',
  'frontend/index.js',
  'frontend/App.js',
  'frontend/api.js',
  'frontend/enrichment.js',
  'frontend/templates.js',
  'automations/on-record-created-automation.js',
  'automations/scripting-extension-bulk-verify.js',
];

for (const rel of requiredFiles) {
  const full = path.join(root, rel);
  if (!fs.existsSync(full)) {
    throw new Error(`Missing required Airtable extension file: ${rel}`);
  }
}

const blockJson = JSON.parse(fs.readFileSync(path.join(root, 'block.json'), 'utf8'));
if (blockJson.version !== '1.0' || blockJson.frontendEntry !== './frontend/index.js') {
  throw new Error('block.json must declare version "1.0" and frontendEntry "./frontend/index.js".');
}

const pkgJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!pkgJson.dependencies || !pkgJson.dependencies['@airtable/blocks']) {
  throw new Error('package.json must include @airtable/blocks dependency.');
}

console.log('PASS: Airtable Custom Extension & Automation package validated.');
