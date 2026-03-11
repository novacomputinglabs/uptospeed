const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('undo/redo does not deep-clone the full task list via JSON', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(
    !appJs.includes('JSON.parse(JSON.stringify(state.tasks))'),
    'Expected undo/redo to avoid JSON deep-cloning the entire task list.',
  );
});

