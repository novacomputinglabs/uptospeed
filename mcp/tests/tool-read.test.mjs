import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolHandlers } from '../src/server.mjs';

function makeClient(overrides = {}) {
  const applyPage = (rows, options = {}) => {
    const limit = Number.isFinite(Number(options?.limit)) && Number(options.limit) > 0
      ? Math.floor(Number(options.limit))
      : null;
    const offset = Number.isFinite(Number(options?.offset)) && Number(options.offset) >= 0
      ? Math.floor(Number(options.offset))
      : 0;
    const start = Math.min(offset, rows.length);
    const end = limit === null ? rows.length : Math.min(start + limit, rows.length);
    return rows.slice(start, end);
  };

  const allTasks = [{ id: '1' }, { id: '2' }, { id: '3' }];
  const filteredTasks = [{ id: '2' }];
  const endeavors = [{ id: 'endeavor-1', title: 'Launch' }];
  const endeavorTasks = [{ id: '1', name: 'Scoped Task' }];

  return {
    getState: async () => ({ taskCount: 3, endeavorCount: 1, inEndeavorCount: 1 }),
    getStats: async () => ({ total: 3, filtered: 2 }),
    getTasks: async (options = {}) => applyPage(allTasks, options),
    getTask: async (taskId) => ({ id: taskId, name: 'Test Task' }),
    getFilteredTasks: async (options = {}) => applyPage(filteredTasks, options),
    getEndeavors: async () => endeavors,
    getEndeavorTasks: async (_endeavorId, options = {}) => applyPage(endeavorTasks, options),
    getWorkloadSnapshot: async () => ({ stats: { overallocatedArtists: 2 } }),
    setFilters: async (filters) => ({ success: true, filtered: 1, filters }),
    clearFilters: async () => ({ success: true }),
    ...overrides
  };
}

test('read tools return standard envelope', async () => {
  const handlers = createToolHandlers(makeClient());

  const state = await handlers.uts_get_state({});
  assert.equal(state.ok, true);
  assert.equal(state.action, 'uts_get_state');
  assert.equal(state.preview, false);
  assert.ok(typeof state.summary === 'string');
  assert.equal(Array.isArray(state.warnings), true);
  assert.deepEqual(state.data, { taskCount: 3, endeavorCount: 1, inEndeavorCount: 1 });

  const stats = await handlers.uts_get_stats({});
  assert.equal(stats.ok, true);
  assert.deepEqual(stats.data, { total: 3, filtered: 2 });

  const tasks = await handlers.uts_get_tasks({});
  assert.equal(tasks.ok, true);
  assert.equal(tasks.data.length, 3);

  const pagedTasks = await handlers.uts_get_tasks({ limit: 1, offset: 1 });
  assert.equal(pagedTasks.ok, true);
  assert.equal(pagedTasks.data.length, 1);
  assert.equal(pagedTasks.data[0].id, '2');

  const oneTask = await handlers.uts_get_task({ taskId: '2' });
  assert.equal(oneTask.ok, true);
  assert.equal(oneTask.data.id, '2');

  const filtered = await handlers.uts_get_filtered_tasks({});
  assert.equal(filtered.ok, true);
  assert.equal(filtered.data.length, 1);

  const pagedFiltered = await handlers.uts_get_filtered_tasks({ limit: 1, offset: 0 });
  assert.equal(pagedFiltered.ok, true);
  assert.equal(pagedFiltered.data.length, 1);

  const endeavors = await handlers.uts_get_endeavors({});
  assert.equal(endeavors.ok, true);
  assert.equal(endeavors.data.length, 1);

  const endeavorTasks = await handlers.uts_get_endeavor_tasks({ endeavorId: 'endeavor-1' });
  assert.equal(endeavorTasks.ok, true);
  assert.equal(endeavorTasks.data.length, 1);

  const pagedEndeavorTasks = await handlers.uts_get_endeavor_tasks({ endeavorId: 'endeavor-1', limit: 1, offset: 0 });
  assert.equal(pagedEndeavorTasks.ok, true);
  assert.equal(pagedEndeavorTasks.data.length, 1);

  const workload = await handlers.uts_get_workload_snapshot({});
  assert.equal(workload.ok, true);
  assert.equal(workload.data.stats.overallocatedArtists, 2);

  const setFilters = await handlers.uts_set_filters({
    filters: { project: 'Project A', endeavorMode: 'specific', endeavorId: 'endeavor-1' }
  });
  assert.equal(setFilters.ok, true);
  assert.deepEqual(setFilters.data.filters, {
    project: 'Project A',
    endeavorMode: 'specific',
    endeavorId: 'endeavor-1',
    endeavorFilter: {
      mode: 'specific',
      endeavorId: 'endeavor-1'
    }
  });
});
