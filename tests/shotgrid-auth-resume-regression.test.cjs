const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('shotgrid auth resume and logout forget-account flows are wired', async () => {
  const serverPy = await readFile(path.join(__dirname, '..', 'server', 'shotgrid_server.py'), 'utf8');

  assert.ok(serverPy.includes('if parsed.path == "/api/shotgrid/auth/resume":'),
    'Expected auth resume endpoint.');
  assert.ok(serverPy.includes('"error": "account_not_found"'),
    'Expected deterministic account_not_found resume failure.');
  assert.ok(serverPy.includes('"error": "reauth_required"'),
    'Expected deterministic reauth_required resume failure.');
  assert.ok(serverPy.includes('if parsed.path == "/api/shotgrid/auth/logout":'),
    'Expected auth logout endpoint.');
  assert.ok(serverPy.includes('forget_account') || serverPy.includes('forgetAccount'),
    'Expected logout forget-account request support.');
  assert.ok(serverPy.includes('"forgot_account": bool(forgot)'),
    'Expected logout response to expose forgot_account flag.');
  assert.ok(serverPy.includes('remember_me') || serverPy.includes('rememberMe'),
    'Expected login endpoint remember-me support.');
  assert.ok(serverPy.includes('def _auth_accounts_upsert('),
    'Expected remembered account persistence helper.');
});
