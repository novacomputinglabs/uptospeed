#!/usr/bin/env node

import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const removed = [];
const skipped = [];

function removeRelative(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  try {
    rmSync(absolutePath, { recursive: true, force: true });
    removed.push(relativePath);
  } catch (error) {
    skipped.push(`${relativePath} (${error.message})`);
  }
}

function purgeMatchingEntries(directoryRelativePath, predicate) {
  const directoryPath = path.join(repoRoot, directoryRelativePath);
  let entries = [];
  try {
    entries = readdirSync(directoryPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!predicate(entry.name, entry)) continue;
    removeRelative(path.join(directoryRelativePath, entry.name));
  }
}

const exactPaths = [
  '.shotgrid_cache.json',
  '.shotgrid_cache.json.tmp',
  'output',
  'public-launch',
  'desktop/dist',
  'desktop/releases',
  'desktop/resources/backend',
  '.codex/environments',
  'codex-reports',
];

for (const relativePath of exactPaths) {
  removeRelative(relativePath);
}

purgeMatchingEntries('.', (name) => {
  if (name === '.env') return true;
  if (name.startsWith('.env.') && name !== '.env.example') return true;
  if (name.startsWith('.local_sync_broker.sqlite3')) return true;
  if (name.startsWith('.shotgrid_cache.json')) return true;
  return false;
});

purgeMatchingEntries('installer', (name) => name.endsWith('.tgz'));

console.log(`Removed ${removed.length} local runtime/build path(s).`);
for (const entry of removed) {
  console.log(`- ${entry}`);
}

if (skipped.length > 0) {
  console.log(`Skipped ${skipped.length} path(s).`);
  for (const entry of skipped) {
    console.log(`- ${entry}`);
  }
}
