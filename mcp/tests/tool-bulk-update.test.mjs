import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolHandlers } from '../src/server.mjs';

function makeTask(taskId, name) {
  return {
    id: taskId,
    name,
    status: 'sch',
    targetStatus: 'ON TARGET',
    allocation: '100%',
    start: '2026-02-10',
    end: '2026-02-12',
    duration: '3',
    raw: {
      Id: taskId,
      'Task Name': name,
      Status: 'sch',
      'Target Status Summary': 'ON TARGET',
      '% Allocation': '100%',
      Start: '2026-02-10',
      End: '2026-02-12',
      Duration: '3'
    }
  };
}

test('bulk update preview reports ready, invalid, duplicate, and not-found entries', async () => {
  let bulkCalls = 0;
  const handlers = createToolHandlers({
    getTasks: async () => [makeTask('task-1', 'Task One'), makeTask('task-2', 'Task Two')],
    getStatusSchema: async () => ({
      fields: {
        status: {
          values: [{ value: 'sch' }, { value: 'ip' }, { value: 'fin' }]
        },
        targetStatus: {
          values: [{ value: 'ON TARGET' }, { value: 'PUSH' }]
        }
      }
    }),
    bulkUpdateTasks: async () => {
      bulkCalls += 1;
      return { success: true, updatedCount: 0, failedCount: 0, results: [] };
    }
  });

  const preview = await handlers.uts_bulk_update_tasks({
    updates: [
      { taskId: 'task-1', updates: { name: 'Task One Updated' } },
      { taskId: 'task-3', updates: { name: 'Missing' } },
      { taskId: 'task-2', updates: { status: 'BAD_STATUS' } },
      { taskId: 'task-1', updates: { allocation: '70%' } }
    ]
  });

  assert.equal(preview.preview, true);
  assert.equal(preview.ok, false);
  assert.equal(preview.data.readyCount, 1);
  assert.equal(preview.data.notFoundCount, 1);
  assert.equal(preview.data.invalidCount, 1);
  assert.equal(preview.data.duplicateCount, 1);
  assert.equal(bulkCalls, 0);
});

test('bulk update applies ready items when confirm=true', async () => {
  let bulkCalls = 0;
  const handlers = createToolHandlers({
    getTasks: async () => [makeTask('task-1', 'Task One')],
    bulkUpdateTasks: async () => {
      bulkCalls += 1;
      return {
        success: true,
        total: 1,
        updatedCount: 1,
        failedCount: 0,
        results: [{ taskId: 'task-1', ok: true, task: makeTask('task-1', 'Task One Updated') }]
      };
    }
  });

  const applied = await handlers.uts_bulk_update_tasks({
    updates: [{ taskId: 'task-1', updates: { name: 'Task One Updated' } }],
    confirm: true
  });

  assert.equal(applied.preview, false);
  assert.equal(applied.ok, true);
  assert.equal(applied.data.appliedCount, 1);
  assert.equal(applied.data.applyFailedCount, 0);
  assert.equal(bulkCalls, 1);
});
