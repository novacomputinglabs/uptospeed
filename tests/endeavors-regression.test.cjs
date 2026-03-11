const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('legacy sprint storage migrates into project-scoped endeavors', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(appJs.includes("LEGACY_SPRINT: 'vfx_kanban_sprint'"));
  assert.ok(appJs.includes('function migrateLegacySprintToEndeavors(legacySprintTaskIds)'));
  assert.ok(appJs.includes("const title = singleProject ? 'Migrated Sprint' : `Migrated Sprint - ${project}`;"));
  assert.ok(appJs.includes('addTaskToEndeavorMembership(taskId, endeavor.id);'));
  assert.ok(appJs.includes('localStorage.removeItem(STORAGE_KEYS.LEGACY_SPRINT);'));

  assert.ok(
    appJs.includes("normalizeEndeavorFilter({ mode: filters.sprintOnly === true ? 'any' : 'all', endeavorId: null })"),
    'Expected UI state migration to map legacy sprintOnly to endeavor filter mode.',
  );
});

test('endeavor rollups dedupe descendant task IDs and derive status/progress', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(appJs.includes('function getRolledUpTaskIdsForEndeavor(endeavorId)'));
  assert.ok(
    /function getRolledUpTaskIdsForEndeavor[\s\S]*const taskIds = new Set\(\)[\s\S]*for \(const id of ids\)[\s\S]*for \(const taskId of getDirectTaskIdsForEndeavor\(id\)\) taskIds\.add\(taskId\)/.test(appJs),
    'Expected rolled-up endeavor task IDs to be deduplicated across descendants.',
  );

  assert.ok(appJs.includes('const progressPercent = total > 0 ? Math.round((completed / total) * 100) : 0;'));
  assert.ok(
    /if \(total > 0 && progressPercent >= 100\) \{\s*status = 'completed';[\s\S]*else if \(start\) \{[\s\S]*if \(startDate && startDate > today\) status = 'planned';[\s\S]*else \{\s*status = 'planned';\s*\}/.test(appJs),
    'Expected derived endeavor status logic for completed/planned/active states.',
  );
});

test('endeavor filter modes support all, any, and specific', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(appJs.includes("const ENDEAVOR_FILTER_MODES = new Set(['all', 'any', 'specific']);"));
  assert.ok(appJs.includes("if (filter.mode === 'all') return true;"));
  assert.ok(appJs.includes("if (filter.mode === 'any') return taskIds.length > 0;"));
  assert.ok(appJs.includes("if (filter.mode === 'specific') {"));
  assert.ok(appJs.includes('const includeDescendants = options.includeDescendants !== false;'));
});

test('task assignment to endeavors enforces project scope', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(appJs.includes('function taskCanBelongToEndeavor(taskId, endeavorId)'));
  assert.ok(appJs.includes("return getTaskProjectLabel(task) === String(endeavor.project || '');"));
  assert.ok(appJs.includes('if (!taskCanBelongToEndeavor(taskId, endeavor.id)) continue;'));
});

test('gantt renders endeavor rows and supports collapse/expand context', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(appJs.includes('function buildGanttRenderRows(filteredTasks)'));
  assert.ok(appJs.includes("type: 'endeavor'"));
  assert.ok(appJs.includes('flattenEndeavorTree()'));
  assert.ok(appJs.includes("toggleEndeavorCollapse('"));
  assert.ok(appJs.includes("class=\"gantt-bar endeavor-bar\""));
  assert.ok(appJs.includes('renderGanttBars(rows, cellWidth);'));
});
