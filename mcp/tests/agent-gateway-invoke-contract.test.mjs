import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayPath = path.join(__dirname, '..', 'src', 'agent-gateway.mjs');

test('agent gateway keeps localhost token guard and invoke contract', async () => {
  const source = await readFile(gatewayPath, 'utf8');

  assert.ok(source.includes("const AUTH_HEADER = 'x-uts-agent-token'"));
  assert.ok(source.includes('createToolHandlers'));
  assert.ok(source.includes("if (method === 'GET' && url.pathname === '/health')"));
  assert.ok(source.includes("if (method === 'GET' && url.pathname === '/manifest')"));
  assert.ok(source.includes("if (method === 'POST' && url.pathname === '/invoke')"));
  assert.ok(source.includes('const toolName = String(body?.toolName || \'\').trim();'));
  assert.ok(source.includes('const args = body?.args && typeof body.args === \'object\' ? body.args : {};'));
});
