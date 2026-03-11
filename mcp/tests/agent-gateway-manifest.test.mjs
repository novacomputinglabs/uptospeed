import test from 'node:test';
import assert from 'node:assert/strict';
import { createGatewayManifest } from '../src/agent-gateway.mjs';

test('agent gateway manifest includes MCP tools with mutating metadata', () => {
  const manifest = createGatewayManifest();
  assert.ok(Array.isArray(manifest), 'Expected manifest array.');
  assert.ok(manifest.length > 0, 'Expected at least one tool in manifest.');

  const updateTask = manifest.find((item) => item.name === 'uts_update_task');
  const getTasks = manifest.find((item) => item.name === 'uts_get_tasks');
  const addTaskNote = manifest.find((item) => item.name === 'uts_add_task_note');
  const getMilestones = manifest.find((item) => item.name === 'uts_get_milestones');
  const addTaskDependency = manifest.find((item) => item.name === 'uts_add_task_dependency');
  const getDesktopRuntime = manifest.find((item) => item.name === 'uts_get_desktop_runtime');
  const restartDesktopRuntime = manifest.find((item) => item.name === 'uts_restart_desktop_runtime');

  assert.ok(updateTask, 'Expected uts_update_task in manifest.');
  assert.ok(getTasks, 'Expected uts_get_tasks in manifest.');
  assert.ok(addTaskNote, 'Expected uts_add_task_note in manifest.');
  assert.ok(getMilestones, 'Expected uts_get_milestones in manifest.');
  assert.ok(addTaskDependency, 'Expected uts_add_task_dependency in manifest.');
  assert.ok(getDesktopRuntime, 'Expected uts_get_desktop_runtime in manifest.');
  assert.ok(restartDesktopRuntime, 'Expected uts_restart_desktop_runtime in manifest.');
  assert.equal(updateTask.mutating, true);
  assert.equal(getTasks.mutating, false);
  assert.equal(addTaskNote.mutating, true);
  assert.equal(getMilestones.mutating, false);
  assert.equal(addTaskDependency.mutating, true);
  assert.equal(getDesktopRuntime.mutating, false);
  assert.equal(restartDesktopRuntime.mutating, false);
});
