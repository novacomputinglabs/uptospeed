const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('task notes storage keys and remap support are wired', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(appJs.includes("TASK_NOTES: 'vfx_kanban_task_notes'"), 'Expected TASK_NOTES storage key.');
  assert.ok(appJs.includes("TASK_NOTES_QUEUE: 'vfx_kanban_task_notes_queue'"), 'Expected TASK_NOTES_QUEUE storage key.');
  assert.ok(appJs.includes('STORAGE_KEYS.TASK_NOTES'), 'Expected task notes key to be referenced in board storage wiring.');
  assert.ok(appJs.includes('STORAGE_KEYS.TASK_NOTES_QUEUE'), 'Expected task notes queue key to be referenced in board storage wiring.');

  assert.ok(appJs.includes('function remapTaskNotesTaskId'), 'Expected task notes remap helper.');
  assert.ok(appJs.includes('remapTaskNotesTaskId(oldId, newId);'), 'Expected ShotGrid create path to remap notes IDs.');
});
