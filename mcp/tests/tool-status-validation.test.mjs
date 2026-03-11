import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolHandlers } from '../src/server.mjs';

function makeTask(taskId = 'task-1') {
  return {
    id: taskId,
    name: 'Before Name',
    status: 'sch',
    targetStatus: 'ON TARGET',
    start: '2026-02-10',
    end: '2026-02-12',
    duration: '3',
    raw: {
      Id: taskId,
      'Task Name': 'Before Name',
      Status: 'sch',
      'Target Status Summary': 'ON TARGET',
      Start: '2026-02-10',
      End: '2026-02-12',
      Duration: '3'
    }
  };
}

function makeStatusSchema() {
  return {
    entityType: 'Task',
    fields: {
      status: {
        field: 'status',
        values: [
          { value: 'sch', label: 'Scheduled' },
          { value: 'ip', label: 'In Progress' },
          { value: 'fin', label: 'Final' }
        ]
      },
      targetStatus: {
        field: 'targetStatus',
        values: [
          { value: 'ON TARGET', label: 'ON TARGET' },
          { value: 'PUSH', label: 'PUSH' }
        ]
      }
    }
  };
}

test('status validation blocks invalid status values before write', async () => {
  let updateCalls = 0;
  let createCalls = 0;

  const handlers = createToolHandlers({
    getStatusSchema: async () => makeStatusSchema(),
    getTask: async () => makeTask(),
    getTasks: async () => [{ id: 'task-1', project: 'Project A' }],
    updateTask: async () => {
      updateCalls += 1;
      return { success: true };
    },
    createTask: async () => {
      createCalls += 1;
      return { success: true };
    }
  });

  const invalidUpdate = await handlers.uts_update_task({
    taskId: 'task-1',
    updates: { status: 'UNKNOWN_STATUS' },
    confirm: true
  });

  assert.equal(invalidUpdate.ok, false);
  assert.match(invalidUpdate.summary, /Invalid status value/);
  assert.equal(updateCalls, 0);
  assert.equal(invalidUpdate.warnings.some((warning) => warning.includes('uts://schema/statuses')), true);

  const invalidCreate = await handlers.uts_create_task({
    taskData: { name: 'Task X', targetStatus: 'UNKNOWN_TARGET' },
    confirm: true
  });

  assert.equal(invalidCreate.ok, false);
  assert.match(invalidCreate.summary, /Invalid targetStatus value/);
  assert.equal(createCalls, 0);
  assert.equal(invalidCreate.warnings.some((warning) => warning.includes('uts://schema/statuses')), true);
});

test('status-like tool errors include schema hint warning', async () => {
  const handlers = createToolHandlers({
    getStatusSchema: async () => makeStatusSchema(),
    getTask: async () => makeTask(),
    updateTask: async () => {
      throw new Error('sg_status_list invalid value: must be one of [wtg, ip, fin]');
    }
  });

  const result = await handlers.uts_update_task({
    taskId: 'task-1',
    updates: { status: 'ip' },
    confirm: true
  });

  assert.equal(result.ok, false);
  assert.equal(Array.isArray(result.warnings), true);
  assert.equal(result.warnings.some((warning) => warning.includes('uts://schema/statuses')), true);
});
