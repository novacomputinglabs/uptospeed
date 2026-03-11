#!/usr/bin/env node

import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const exportRoot = path.join(repoRoot, 'public-launch');

const excludedPrefixes = [
  '.git',
  '.codex',
  '.vscode',
  'public-launch',
  'output',
  'docs',
  'codex-reports',
  'desktop/dist',
  'desktop/releases',
  'desktop/resources/backend',
];

const excludedFiles = new Set([
  'AGENTS.md',
  'security_best_practices_report.md',
  'autodesk_gs_vocab_principles_raw.json',
  'autodesk_gs_vocab_principles_report.md',
  'linear_app_scrape_report.md',
  'linear_key_pages_scrape.json',
  'linear_sitemap_urls.txt',
]);

function normalizeRelativePath(relativePath) {
  return relativePath.split(path.sep).join('/');
}

function shouldExclude(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const baseName = path.basename(normalized);

  if (!normalized || normalized === '.') return false;
  if (excludedFiles.has(normalized)) return true;
  if (excludedPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) return true;
  if (baseName === '.DS_Store') return true;
  if (baseName === '.vscode') return true;
  if (baseName === 'node_modules') return true;
  if (baseName === '.env') return true;
  if (baseName.startsWith('.env.') && baseName !== '.env.example') return true;
  if (baseName.startsWith('.local_sync_broker.sqlite3')) return true;
  if (baseName === '.shotgrid_cache.json' || baseName.startsWith('.shotgrid_cache.json.')) return true;
  if (baseName === '.secrets') return true;
  if (normalized.startsWith('installer/') && baseName.endsWith('.tgz')) return true;
  return false;
}

function copyTree(sourceDir, targetDir) {
  mkdirSync(targetDir, { recursive: true });
  const entries = readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name);
    const relativePath = path.relative(repoRoot, sourcePath);
    if (shouldExclude(relativePath)) continue;

    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyTree(sourcePath, targetPath);
      continue;
    }

    if (entry.isSymbolicLink()) {
      continue;
    }

    copyFileSync(sourcePath, targetPath);
    const mode = lstatSync(sourcePath).mode;
    chmodSync(targetPath, mode);
  }
}

rmSync(exportRoot, { recursive: true, force: true });
copyTree(repoRoot, exportRoot);

console.log(`Created public export at ${exportRoot}`);
