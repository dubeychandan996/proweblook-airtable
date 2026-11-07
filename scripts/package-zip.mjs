import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const distDir = path.join(root, 'dist');
fs.mkdirSync(distDir, { recursive: true });

const zipName = `proweblook-airtable-extension-v${pkg.version}.zip`;
const zipPath = path.join(distDir, zipName);
if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

const entries = [
  'block.json',
  'package.json',
  'README.md',
  'LICENSE',
  'frontend',
  'automations',
];

execFileSync('zip', ['-r', zipPath, ...entries], { cwd: root, stdio: 'inherit' });
console.log(`Packaged ${zipPath}`);
