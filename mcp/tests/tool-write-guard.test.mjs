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

test('mutating tools require confirm=true and return preview by default', async () => {
  let updateCalls = 0;
  let createCalls = 0;
  let createAssetCalls = 0;
  let createSequenceCalls = 0;
  let createShotCalls = 0;
  let createArtistCalls = 0;
  let createDepartmentCalls = 0;
  let deleteCalls = 0;
  let bulkUpdateCalls = 0;
  let autoBalancePlanCalls = 0;
  let createEndeavorCalls = 0;
  let updateEndeavorCalls = 0;
  let deleteEndeavorCalls = 0;
  let addTasksToEndeavorCalls = 0;
  let removeTasksFromEndeavorCalls = 0;
  let clearEndeavorCalls = 0;

  const handlers = createToolHandlers({
    getTask: async () => makeTask(),
    getTasks: async () => [{ id: 'task-1', project: 'Project A' }],
    getEndeavor: async () => ({ id: 'endeavor-1', title: 'Launch' }),
    getEndeavorTasks: async () => [{ id: 'task-1' }],
    updateTask: async () => {
      updateCalls += 1;
      return { success: true };
    },
    createTask: async () => {
      createCalls += 1;
      return { success: true };
    },
    createAsset: async () => {
      createAssetCalls += 1;
      return { success: true };
    },
    createSequence: async () => {
      createSequenceCalls += 1;
      return { success: true };
    },
    createShot: async () => {
      createShotCalls += 1;
      return { success: true };
    },
    createArtist: async () => {
      createArtistCalls += 1;
      return { success: true };
    },
    createDepartment: async () => {
      createDepartmentCalls += 1;
      return { success: true };
    },
    deleteTask: async () => {
      deleteCalls += 1;
      return { success: true };
    },
    createEndeavor: async () => {
      createEndeavorCalls += 1;
      return { success: true, endeavor: { id: 'endeavor-2' } };
    },
    updateEndeavor: async () => {
      updateEndeavorCalls += 1;
      return { success: true };
    },
    deleteEndeavor: async () => {
      deleteEndeavorCalls += 1;
      return { success: true };
    },
    bulkUpdateTasks: async () => {
      bulkUpdateCalls += 1;
      return { success: true, updatedCount: 1, failedCount: 0, results: [] };
    },
    getAutoBalancePlan: async () => {
      autoBalancePlanCalls += 1;
      return {
        success: true,
        changes: [{ taskId: 'task-1', newValue: '70%' }],
        splits: [],
        summary: { totalRecommendations: 1 }
      };
    },
    addTasksToEndeavor: async () => {
      addTasksToEndeavorCalls += 1;
      return { success: true, changed: 1 };
    },
    removeTasksFromEndeavor: async () => {
      removeTasksFromEndeavorCalls += 1;
      return { success: true, changed: 1 };
    },
    clearEndeavor: async () => {
      clearEndeavorCalls += 1;
      return { success: true };
    }
  });

  const updatePreview = await handlers.uts_update_task({
    taskId: 'task-1',
    updates: { name: 'After Name' }
  });
  assert.equal(updatePreview.preview, true);
  assert.equal(updatePreview.ok, true);

  const createPreview = await handlers.uts_create_task({
    taskData: { asset: 'Asset A', department: 'Rig' }
  });
  assert.equal(createPreview.preview, true);
  assert.equal(createPreview.ok, true);

  const bulkPreview = await handlers.uts_bulk_update_tasks({
    updates: [{ taskId: 'task-1', updates: { name: 'After Name' } }]
  });
  assert.equal(bulkPreview.preview, true);
  assert.equal(bulkPreview.ok, true);

  const autoBalancePreview = await handlers.uts_auto_balance_workload({});
  assert.equal(autoBalancePreview.preview, true);
  assert.equal(autoBalancePreview.ok, true);

  const createAssetPreview = await handlers.uts_create_asset({ name: 'Asset A' });
  assert.equal(createAssetPreview.preview, true);
  assert.equal(createAssetPreview.ok, true);

  const createSequencePreview = await handlers.uts_create_sequence({ name: 'Seq010' });
  assert.equal(createSequencePreview.preview, true);
  assert.equal(createSequencePreview.ok, true);

  const createShotPreview = await handlers.uts_create_shot({ name: 'Shot010', sequenceName: 'Seq010' });
  assert.equal(createShotPreview.preview, true);
  assert.equal(createShotPreview.ok, true);

  const createArtistPreview = await handlers.uts_create_artist({
    firstName: 'Ada',
    lastName: 'Lovelace',
    login: 'ada',
    email: 'ada@example.com'
  });
  assert.equal(createArtistPreview.preview, true);
  assert.equal(createArtistPreview.ok, true);

  const createDepartmentPreview = await handlers.uts_create_department({ name: 'Rig' });
  assert.equal(createDepartmentPreview.preview, true);
  assert.equal(createDepartmentPreview.ok, true);

  const deletePreview = await handlers.uts_delete_task({ taskId: 'task-1' });
  assert.equal(deletePreview.preview, true);
  assert.equal(deletePreview.ok, true);

  const createEndeavorPreview = await handlers.uts_create_endeavor({ endeavorData: { title: 'Launch' } });
  assert.equal(createEndeavorPreview.preview, true);
  assert.equal(createEndeavorPreview.ok, true);

  const updateEndeavorPreview = await handlers.uts_update_endeavor({
    endeavorId: 'endeavor-1',
    updates: { title: 'Updated Launch' }
  });
  assert.equal(updateEndeavorPreview.preview, true);
  assert.equal(updateEndeavorPreview.ok, true);

  const deleteEndeavorPreview = await handlers.uts_delete_endeavor({ endeavorId: 'endeavor-1' });
  assert.equal(deleteEndeavorPreview.preview, true);
  assert.equal(deleteEndeavorPreview.ok, true);

  const addPreview = await handlers.uts_add_tasks_to_endeavor({ endeavorId: 'endeavor-1', taskIds: ['task-2'] });
  assert.equal(addPreview.preview, true);
  assert.equal(addPreview.ok, true);

  const removePreview = await handlers.uts_remove_tasks_from_endeavor({ endeavorId: 'endeavor-1', taskIds: ['task-1'] });
  assert.equal(removePreview.preview, true);
  assert.equal(removePreview.ok, true);

  const clearPreview = await handlers.uts_clear_endeavor({ endeavorId: 'endeavor-1' });
  assert.equal(clearPreview.preview, true);
  assert.equal(clearPreview.ok, true);

  assert.equal(updateCalls, 0);
  assert.equal(createCalls, 0);
  assert.equal(createAssetCalls, 0);
  assert.equal(createSequenceCalls, 0);
  assert.equal(createShotCalls, 0);
  assert.equal(createArtistCalls, 0);
  assert.equal(createDepartmentCalls, 0);
  assert.equal(deleteCalls, 0);
  assert.equal(bulkUpdateCalls, 0);
  assert.equal(autoBalancePlanCalls, 1);
  assert.equal(createEndeavorCalls, 0);
  assert.equal(updateEndeavorCalls, 0);
  assert.equal(deleteEndeavorCalls, 0);
  assert.equal(addTasksToEndeavorCalls, 0);
  assert.equal(removeTasksFromEndeavorCalls, 0);
  assert.equal(clearEndeavorCalls, 0);
});

test('mutating tools fail fast when user auth policy requires a logged-in user session', async () => {
  let updateCalls = 0;

  const handlers = createToolHandlers({
    getShotgridAuthStatus: async () => ({
      requestOk: true,
      statusCode: 200,
      status: {
        ok: true,
        authenticated: false,
        mode: 'none',
        script_configured: true,
        auth_policy: 'user_only',
        fallback_allowed: false,
        fallback_used: false,
        effective_actor: 'none',
        reauth_required: true,
        account: { id: 'acct-1', name: 'Jane Doe' },
        shotgrid_enabled: true,
        error: ''
      }
    }),
    getTask: async () => makeTask(),
    updateTask: async () => {
      updateCalls += 1;
      return { success: true };
    }
  });

  const blocked = await handlers.uts_update_task({
    taskId: 'task-1',
    updates: { name: 'After Name' },
    confirm: true
  });

  assert.equal(blocked.ok, false);
  assert.match(blocked.summary, /requires an authenticated user/i);
  assert.equal(updateCalls, 0);
  assert.equal(blocked.data?.auth?.policy, 'user_only');
  assert.equal(blocked.data?.auth?.reauth_required, true);
});

test('broker-backed write tools fail fast when local broker capability is unavailable', async () => {
  let createAssetCalls = 0;
  let createTaskCalls = 0;

  const handlers = createToolHandlers({
    getShotgridAuthStatus: async () => ({
      requestOk: true,
      statusCode: 200,
      status: {
        ok: true,
        authenticated: true,
        mode: 'script',
        script_configured: true,
        auth_policy: 'script_only',
        fallback_allowed: false,
        fallback_used: false,
        effective_actor: 'script',
        reauth_required: false,
        account: null,
        shotgrid_enabled: true,
        error: ''
      }
    }),
    getBrokerWriteCapability: async () => ({
      ok: false,
      statusCode: 404,
      syncMode: 'local_only',
      transport: { usesStaticFallback: true, baseUrl: 'http://127.0.0.1:51234/index.html' },
      message: 'Writes unavailable: MCP session is using the static fallback page, and no writable /api/local backend is configured.'
    }),
    createAsset: async () => {
      createAssetCalls += 1;
      return { success: true };
    },
    createTask: async () => {
      createTaskCalls += 1;
      return { success: true };
    }
  });

  const createAssetBlocked = await handlers.uts_create_asset({
    name: 'Paris',
    confirm: true
  });
  assert.equal(createAssetBlocked.ok, false);
  assert.match(createAssetBlocked.summary, /Writes unavailable:/);
  assert.equal(createAssetCalls, 0);
  assert.equal(createAssetBlocked.data?.capability?.statusCode, 404);

  const createTaskBlocked = await handlers.uts_create_task({
    taskData: { asset: 'Paris', department: 'Rig' },
    confirm: true
  });
  assert.equal(createTaskBlocked.ok, false);
  assert.match(createTaskBlocked.summary, /Writes unavailable:/);
  assert.equal(createTaskCalls, 0);
  assert.equal(createTaskBlocked.data?.capability?.syncMode, 'local_only');
});

test('phase 1 and phase 2 planning write tools preview first and require confirm=true', async () => {
  let addTaskNoteCalls = 0;
  let replyTaskNoteCalls = 0;
  let createMilestoneCalls = 0;
  let addTaskDependencyCalls = 0;
  let createTaskBlockerCalls = 0;

  const handlers = createToolHandlers({
    addTaskNote: async () => {
      addTaskNoteCalls += 1;
      return { success: true, threadId: 'thread-1' };
    },
    replyTaskNote: async () => {
      replyTaskNoteCalls += 1;
      return { success: true, threadId: 'thread-1' };
    },
    createMilestone: async () => {
      createMilestoneCalls += 1;
      return { success: true, milestone: { id: 'milestone-1', title: 'Launch' } };
    },
    addTaskDependency: async () => {
      addTaskDependencyCalls += 1;
      return { success: true, dependency: { id: 'dependency-1' } };
    },
    createTaskBlocker: async () => {
      createTaskBlockerCalls += 1;
      return { success: true, blocker: { id: 'blocker-1' } };
    }
  });

  const notePreview = await handlers.uts_add_task_note({ taskId: 'task-1', content: 'Investigating' });
  assert.equal(notePreview.preview, true);
  assert.equal(addTaskNoteCalls, 0);

  const replyPreview = await handlers.uts_reply_task_note({ taskId: 'task-1', threadId: 'thread-1', content: 'On it' });
  assert.equal(replyPreview.preview, true);
  assert.equal(replyTaskNoteCalls, 0);

  const milestonePreview = await handlers.uts_create_milestone({ title: 'Launch' });
  assert.equal(milestonePreview.preview, true);
  assert.equal(createMilestoneCalls, 0);

  const dependencyPreview = await handlers.uts_add_task_dependency({ taskId: 'task-1', blockerTaskId: 'task-2' });
  assert.equal(dependencyPreview.preview, true);
  assert.equal(addTaskDependencyCalls, 0);

  const blockerPreview = await handlers.uts_create_task_blocker({
    taskId: 'task-1',
    blockerData: { title: 'Waiting on plates' }
  });
  assert.equal(blockerPreview.preview, true);
  assert.equal(createTaskBlockerCalls, 0);

  const noteApplied = await handlers.uts_add_task_note({ taskId: 'task-1', content: 'Investigating', confirm: true });
  assert.equal(noteApplied.ok, true);
  assert.equal(addTaskNoteCalls, 1);

  const replyApplied = await handlers.uts_reply_task_note({
    taskId: 'task-1',
    threadId: 'thread-1',
    content: 'On it',
    confirm: true
  });
  assert.equal(replyApplied.ok, true);
  assert.equal(replyTaskNoteCalls, 1);

  const milestoneApplied = await handlers.uts_create_milestone({ title: 'Launch', confirm: true });
  assert.equal(milestoneApplied.ok, true);
  assert.equal(createMilestoneCalls, 1);

  const dependencyApplied = await handlers.uts_add_task_dependency({
    taskId: 'task-1',
    blockerTaskId: 'task-2',
    confirm: true
  });
  assert.equal(dependencyApplied.ok, true);
  assert.equal(addTaskDependencyCalls, 1);

  const blockerApplied = await handlers.uts_create_task_blocker({
    taskId: 'task-1',
    blockerData: { title: 'Waiting on plates' },
    confirm: true
  });
  assert.equal(blockerApplied.ok, true);
  assert.equal(createTaskBlockerCalls, 1);
});
