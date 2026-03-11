const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('ShotGrid push fields include Task Name + Pipeline Step', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.match(
    appJs,
    /const\s+SHOTGRID_PUSH_FIELDS\s*=\s*\[[\s\S]*'Task Name'[\s\S]*'Pipeline Step'[\s\S]*\]/,
    'Expected SHOTGRID_PUSH_FIELDS to include Task Name and Pipeline Step.',
  );

  assert.match(
    appJs,
    /function\s+snapshotTaskForShotGrid\([\s\S]*'Task Name'[\s\S]*'Pipeline Step'/,
    'Expected snapshotTaskForShotGrid to include Task Name and Pipeline Step.',
  );
});

test('ShotGrid server push supports Task Name + Pipeline Step', async () => {
  const serverPy = await readFile(path.join(__dirname, '..', 'server', 'shotgrid_server.py'), 'utf8');

  assert.ok(serverPy.includes('def _sg_find_step_by_name'), 'Expected server to implement step lookup.');
  assert.ok(serverPy.includes('"Task Name" in item'), 'Expected server to accept Task Name updates.');
  assert.ok(serverPy.includes('"Pipeline Step" in item'), 'Expected server to accept Pipeline Step updates.');
});

