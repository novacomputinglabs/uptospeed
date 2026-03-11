import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolHandlers } from '../src/server.mjs';

test('read tools force refresh shortly after a successful mutation', async () => {
  const refreshCalls = [];
  let createCalls = 0;

  const handlers = createToolHandlers({
    refreshShotgridIfEnabled: async (options = {}) => {
      refreshCalls.push(options);
      return { attempted: true, ok: true };
    },
    getTasks: async () => [{ id: 'task-1', project: 'Project A' }],
    createTask: async () => {
      createCalls += 1;
      return { success: true, task: { id: 'local-1', name: 'New Task' } };
    }
  });

  await handlers.uts_create_task({
    taskData: { asset: 'Asset A', department: 'Rig' },
    confirm: true
  });
  await handlers.uts_get_tasks({});

  assert.equal(createCalls, 1);
  assert.equal(refreshCalls.length >= 2, true);
  assert.equal(refreshCalls[refreshCalls.length - 1]?.force, true);
});

test('preview mutations do not trigger forced read refresh', async () => {
  const refreshCalls = [];
  let createCalls = 0;

  const handlers = createToolHandlers({
    refreshShotgridIfEnabled: async (options = {}) => {
      refreshCalls.push(options);
      return { attempted: true, ok: true };
    },
    getTasks: async () => [{ id: 'task-1', project: 'Project A' }],
    createTask: async () => {
      createCalls += 1;
      return { success: true, task: { id: 'local-1', name: 'New Task' } };
    }
  });

  await handlers.uts_create_task({
    taskData: { asset: 'Asset A', department: 'Rig' }
  });
  await handlers.uts_get_tasks({});

  assert.equal(createCalls, 0);
  assert.equal(refreshCalls.some((entry) => entry?.force === true), false);
});
