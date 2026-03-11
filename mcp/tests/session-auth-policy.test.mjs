import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('bootstrap ShotGrid sync respects user-auth-required policy checks', async () => {
  const browserSessionPath = path.join(__dirname, '..', 'src', 'session', 'browser-session.mjs');
  const kanbanClientPath = path.join(__dirname, '..', 'src', 'bridge', 'kanban-client.mjs');

  const browserSessionSrc = await readFile(browserSessionPath, 'utf8');
  const kanbanClientSrc = await readFile(kanbanClientPath, 'utf8');

  assert.ok(browserSessionSrc.includes('const requiresUserAuth = effectivePolicy !== \'script_only\''),
    'Expected browser bootstrap to branch on user-required auth policy.');
  assert.ok(browserSessionSrc.includes('const hasUserAuth = data?.authenticated === true && data?.mode === \'user\''),
    'Expected browser bootstrap to require authenticated user mode when policy demands it.');

  assert.ok(kanbanClientSrc.includes('const requiresUserAuth = effectivePolicy !== \'script_only\''),
    'Expected MCP refresh path to branch on user-required auth policy.');
  assert.ok(kanbanClientSrc.includes('const hasUserAuth = data?.authenticated === true && data?.mode === \'user\''),
    'Expected MCP refresh path to validate authenticated user mode.');
});
