const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('server normalizes local task status/steps and exposes direct entity create endpoint', async () => {
  const serverPy = await readFile(path.join(__dirname, '..', 'server', 'shotgrid_server.py'), 'utf8');

  assert.ok(
    serverPy.includes('def _normalize_shotgrid_task_status'),
    'Expected status normalization helper for ShotGrid task payloads.'
  );
  assert.ok(
    serverPy.includes('"sch": "wtg"'),
    'Expected local scheduled status (sch) to map to ShotGrid waiting status (wtg).'
  );
  assert.ok(
    serverPy.includes('_PIPELINE_STEP_NONE_ALIASES'),
    'Expected pseudo-steps (e.g. Client milestones) normalization support.'
  );
  assert.ok(
    serverPy.includes('if parsed.path == "/api/shotgrid/entities/create":'),
    'Expected direct ShotGrid entity create endpoint for MCP fallback.'
  );
});
