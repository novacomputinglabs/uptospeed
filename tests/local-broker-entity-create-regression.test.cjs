const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('local broker supports create_entity operations and worker processing', async () => {
  const serverPy = await readFile(path.join(__dirname, '..', 'server', 'shotgrid_server.py'), 'utf8');

  assert.ok(serverPy.includes("op_type not in (\"update\", \"create\", \"delete\", \"create_entity\")"),
    'Expected create_entity operation type support in local apply.');
  assert.ok(serverPy.includes('def _local_broker_process_entity_create_job'),
    'Expected dedicated entity-create worker helper.');
  assert.ok(serverPy.includes("if op_type == \"entity_create\":"),
    'Expected entity_create branch in queue worker.');
  assert.ok(serverPy.includes("'entity_create'"),
    'Expected queue insertion to use entity_create op_type.');
});
