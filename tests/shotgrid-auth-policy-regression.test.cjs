const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('shotgrid auth policy resolver and write routes use explicit auth context', async () => {
  const serverPy = await readFile(path.join(__dirname, '..', 'server', 'shotgrid_server.py'), 'utf8');

  assert.ok(serverPy.includes('def _parse_auth_envelope('),
    'Expected auth envelope parser helper.');
  assert.ok(serverPy.includes('def _resolve_request_auth('),
    'Expected policy-aware request auth resolver.');
  assert.ok(serverPy.includes('if parsed.path == "/api/shotgrid/tasks/push":'),
    'Expected tasks/push route to exist.');
  assert.ok(serverPy.includes('if parsed.path == "/api/shotgrid/tasks/create":'),
    'Expected tasks/create route to exist.');
  assert.ok(serverPy.includes('if parsed.path == "/api/shotgrid/task-notes":'),
    'Expected task-notes route to exist.');
  assert.ok(serverPy.includes('auth_ctx = _resolve_request_auth(self, repo_root, body=body)'),
    'Expected write routes to resolve auth via policy-aware context.');
  assert.ok(serverPy.includes('_inject_auth_metadata(payload, auth_ctx)'),
    'Expected write responses to return effective actor/fallback metadata.');
  assert.ok(serverPy.includes('"auth_policy": auth_policy'),
    'Expected auth status payload to include auth_policy.');
  assert.ok(serverPy.includes('"effective_actor": effective_actor'),
    'Expected auth status payload to include effective_actor.');
});
