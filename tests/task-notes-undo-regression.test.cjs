const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('undo/redo supports task notes state and queue patch ops', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(appJs.includes("case 'notes.setTaskState'"), 'Expected notes.setTaskState undo op support.');
  assert.ok(appJs.includes("case 'notes.setQueueState'"), 'Expected notes.setQueueState undo op support.');

  assert.ok(appJs.includes("op: 'notes.setTaskState'"), 'Expected task note state patches to be recorded.');
  assert.ok(appJs.includes("op: 'notes.setQueueState'"), 'Expected task note queue patches to be recorded.');
  assert.ok(appJs.includes('scheduleTaskNotesQueueFlush(0);'), 'Expected undo/redo to trigger queue flush for note deletions/recreates.');
});
