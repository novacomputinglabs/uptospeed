const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('local broker queue schema and worker support per-account auth scope', async () => {
  const serverPy = await readFile(path.join(__dirname, '..', 'server', 'shotgrid_server.py'), 'utf8');

  assert.ok(serverPy.includes("auth_policy TEXT NOT NULL DEFAULT 'script_only'"),
    'Expected local_sync_queue auth_policy column.');
  assert.ok(serverPy.includes("allow_script_fallback INTEGER NOT NULL DEFAULT 0"),
    'Expected local_sync_queue allow_script_fallback column.');
  assert.ok(serverPy.includes("effective_actor TEXT NOT NULL DEFAULT 'script'"),
    'Expected local_sync_queue effective_actor column.');
  assert.ok(serverPy.includes("fallback_used INTEGER NOT NULL DEFAULT 0"),
    'Expected local_sync_queue fallback_used column.');
  assert.ok(serverPy.includes('auth_account_id TEXT'),
    'Expected auth_account_id storage in local tables.');
  assert.ok(serverPy.includes('def _local_broker_resolve_job_auth('),
    'Expected queue worker auth resolver by policy/account.');
  assert.ok(serverPy.includes('def _local_broker_update_job_actor('),
    'Expected queue worker actor updates on resolved auth.');
  assert.ok(serverPy.includes('def _local_broker_write_audit('),
    'Expected local sync audit writer.');
  assert.ok(serverPy.includes('INSERT INTO local_sync_audit'),
    'Expected queue outcomes to be audited.');
});
