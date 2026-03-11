import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolHandlers } from '../src/server.mjs';

function makeTask(taskId = 'task-1') {
  return {
    id: taskId,
    name: 'Before Name',
    start: '2026-02-10',
    end: '2026-02-12',
    duration: '3',
    raw: {
      Id: taskId,
      'Task Name': 'Before Name',
      Start: '2026-02-10',
      End: '2026-02-12',
      Duration: '3'
    }
  };
}

test('mutating tools execute when confirm=true', async () => {
  const calls = {
    update: 0,
    create: 0,
    createAsset: 0,
    createSequence: 0,
    createShot: 0,
    createArtist: 0,
    createDepartment: 0,
    delete: 0,
    bulkUpdate: 0,
    autoBalancePlan: 0,
    createEndeavor: 0,
    updateEndeavor: 0,
    deleteEndeavor: 0,
    addToEndeavor: 0,
    removeFromEndeavor: 0,
    clearEndeavor: 0,
    undo: 0,
    redo: 0
  };

  const handlers = createToolHandlers({
    getTask: async (taskId) => makeTask(taskId),
    getTasks: async () => [{ id: 'task-1', project: 'Project A' }],
    getEndeavor: async () => ({ id: 'endeavor-1', title: 'Launch' }),
    getEndeavorTasks: async () => [{ id: 'task-1' }],
    updateTask: async () => {
      calls.update += 1;
      return { success: true, task: { id: 'task-1', name: 'After Name' } };
    },
    createTask: async () => {
      calls.create += 1;
      return { success: true, task: { id: 'task-9', name: 'New Task' } };
    },
    createAsset: async () => {
      calls.createAsset += 1;
      return { success: true, entityType: 'asset', queued: true, entity: { name: 'Asset A' } };
    },
    createSequence: async () => {
      calls.createSequence += 1;
      return { success: true, entityType: 'sequence', queued: true, entity: { name: 'Seq010' } };
    },
    createShot: async () => {
      calls.createShot += 1;
      return { success: true, entityType: 'shot', queued: true, entity: { name: 'Shot010' } };
    },
    createArtist: async () => {
      calls.createArtist += 1;
      return { success: true, entityType: 'artist', queued: true, entity: { name: 'Ada Lovelace' } };
    },
    createDepartment: async () => {
      calls.createDepartment += 1;
      return { success: true, entityType: 'department', queued: true, entity: { name: 'Rig' } };
    },
    deleteTask: async () => {
      calls.delete += 1;
      return { success: true, deletedTask: 'Before Name' };
    },
    createEndeavor: async () => {
      calls.createEndeavor += 1;
      return { success: true, endeavor: { id: 'endeavor-1', title: 'Launch' } };
    },
    updateEndeavor: async () => {
      calls.updateEndeavor += 1;
      return { success: true, endeavor: { id: 'endeavor-1', title: 'Launch v2' } };
    },
    deleteEndeavor: async () => {
      calls.deleteEndeavor += 1;
      return { success: true, removedIds: ['endeavor-1'] };
    },
    bulkUpdateTasks: async () => {
      calls.bulkUpdate += 1;
      return {
        success: true,
        updatedCount: 1,
        failedCount: 0,
        results: [{ taskId: 'task-1', ok: true }]
      };
    },
    getAutoBalancePlan: async () => {
      calls.autoBalancePlan += 1;
      return {
        success: true,
        changes: [{ taskId: 'task-1', newValue: '80%' }],
        splits: [],
        summary: { totalRecommendations: 1 }
      };
    },
    addTasksToEndeavor: async () => {
      calls.addToEndeavor += 1;
      return { success: true, changed: 1 };
    },
    removeTasksFromEndeavor: async () => {
      calls.removeFromEndeavor += 1;
      return { success: true, changed: 1 };
    },
    clearEndeavor: async () => {
      calls.clearEndeavor += 1;
      return { success: true };
    },
    undo: async () => {
      calls.undo += 1;
      return { success: true };
    },
    redo: async () => {
      calls.redo += 1;
      return { success: true };
    }
  });

  const updated = await handlers.uts_update_task({
    taskId: 'task-1',
    updates: { name: 'After Name' },
    confirm: true
  });
  assert.equal(updated.preview, false);
  assert.equal(updated.ok, true);

  const created = await handlers.uts_create_task({
    taskData: { asset: 'Asset A', department: 'Rig' },
    confirm: true
  });
  assert.equal(created.preview, false);
  assert.equal(created.ok, true);

  const bulkUpdated = await handlers.uts_bulk_update_tasks({
    updates: [{ taskId: 'task-1', updates: { name: 'After Name' } }],
    confirm: true
  });
  assert.equal(bulkUpdated.preview, false);
  assert.equal(bulkUpdated.ok, true);

  const autoBalanced = await handlers.uts_auto_balance_workload({
    confirm: true
  });
  assert.equal(autoBalanced.preview, false);
  assert.equal(autoBalanced.ok, true);

  const createdAsset = await handlers.uts_create_asset({
    name: 'Asset A',
    confirm: true
  });
  assert.equal(createdAsset.preview, false);
  assert.equal(createdAsset.ok, true);

  const createdSequence = await handlers.uts_create_sequence({
    name: 'Seq010',
    confirm: true
  });
  assert.equal(createdSequence.preview, false);
  assert.equal(createdSequence.ok, true);

  const createdShot = await handlers.uts_create_shot({
    name: 'Shot010',
    sequenceName: 'Seq010',
    confirm: true
  });
  assert.equal(createdShot.preview, false);
  assert.equal(createdShot.ok, true);

  const createdArtist = await handlers.uts_create_artist({
    firstName: 'Ada',
    lastName: 'Lovelace',
    login: 'ada',
    email: 'ada@example.com',
    confirm: true
  });
  assert.equal(createdArtist.preview, false);
  assert.equal(createdArtist.ok, true);

  const createdDepartment = await handlers.uts_create_department({
    name: 'Rig',
    confirm: true
  });
  assert.equal(createdDepartment.preview, false);
  assert.equal(createdDepartment.ok, true);

  const deleted = await handlers.uts_delete_task({ taskId: 'task-1', confirm: true });
  assert.equal(deleted.preview, false);
  assert.equal(deleted.ok, true);

  const createdEndeavor = await handlers.uts_create_endeavor({
    endeavorData: { title: 'Launch' },
    confirm: true
  });
  assert.equal(createdEndeavor.preview, false);
  assert.equal(createdEndeavor.ok, true);

  const updatedEndeavor = await handlers.uts_update_endeavor({
    endeavorId: 'endeavor-1',
    updates: { title: 'Launch v2' },
    confirm: true
  });
  assert.equal(updatedEndeavor.preview, false);
  assert.equal(updatedEndeavor.ok, true);

  const added = await handlers.uts_add_tasks_to_endeavor({
    endeavorId: 'endeavor-1',
    taskIds: ['task-2'],
    confirm: true
  });
  assert.equal(added.preview, false);
  assert.equal(added.ok, true);

  const removed = await handlers.uts_remove_tasks_from_endeavor({
    endeavorId: 'endeavor-1',
    taskIds: ['task-1'],
    confirm: true
  });
  assert.equal(removed.preview, false);
  assert.equal(removed.ok, true);

  const cleared = await handlers.uts_clear_endeavor({ endeavorId: 'endeavor-1', confirm: true });
  assert.equal(cleared.preview, false);
  assert.equal(cleared.ok, true);

  const deletedEndeavor = await handlers.uts_delete_endeavor({ endeavorId: 'endeavor-1', confirm: true });
  assert.equal(deletedEndeavor.preview, false);
  assert.equal(deletedEndeavor.ok, true);

  const undone = await handlers.uts_undo({});
  assert.equal(undone.preview, false);
  assert.equal(undone.ok, true);

  const redone = await handlers.uts_redo({});
  assert.equal(redone.preview, false);
  assert.equal(redone.ok, true);

  assert.deepEqual(calls, {
    update: 1,
    create: 1,
    createAsset: 1,
    createSequence: 1,
    createShot: 1,
    createArtist: 1,
    createDepartment: 1,
    delete: 1,
    bulkUpdate: 2,
    autoBalancePlan: 1,
    createEndeavor: 1,
    updateEndeavor: 1,
    deleteEndeavor: 1,
    addToEndeavor: 1,
    removeFromEndeavor: 1,
    clearEndeavor: 1,
    undo: 1,
    redo: 1
  });
});
