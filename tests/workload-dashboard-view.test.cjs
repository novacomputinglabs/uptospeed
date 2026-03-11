const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('workload view mode is routed in board rendering and API', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(appJs.includes("if (state.viewMode === 'workload')"));
  assert.ok(appJs.includes('renderWorkloadDashboardView();'));
  assert.ok(
    /if \(!?\['kanban', 'list', 'workload', 'agent_permissions'\]\.includes\(mode\)\)/.test(appJs),
    'Expected API mode guard for kanban/list/workload/agent_permissions.',
  );
  assert.ok(appJs.includes('openWorkloadDashboard: () => {'));
  assert.ok(appJs.includes("/ Agent Permissions"));
});

test('keyboard shortcuts enforce panel-vs-dashboard behavior', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.match(
    appJs,
    /if \(e\.key === 'w' && !cmdKey && e\.shiftKey\) \{[\s\S]*openWorkloadDashboard\(\);/,
    'Expected Shift+W to open full workload dashboard.',
  );

  assert.match(
    appJs,
    /if \(e\.key === 'w' && !cmdKey && !e\.shiftKey\) \{[\s\S]*state\.viewMode === 'kanban' \|\| state\.viewMode === 'list'[\s\S]*toggleWorkloadPanel\(\);/,
    'Expected W to toggle the workload panel only in Kanban/List.',
  );

  assert.match(
    appJs,
    /function toggleWorkloadPanel\(\) \{[\s\S]*state\.viewMode === 'workload'[\s\S]*Quick workload panel is available in Kanban or List view\./,
    'Expected workload mode guard inside toggleWorkloadPanel.',
  );

  assert.match(
    appJs,
    /if \(e\.key === 'l' && !cmdKey\) \{[\s\S]*if \(state\.viewMode === 'workload'\) \{[\s\S]*state\.lastBoardViewMode === 'list' \? 'list' : 'kanban'/,
    'Expected L to return from workload view to the previous board mode.',
  );
});

test('UI state persistence accepts workload mode and workload range', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.match(
    appJs,
    /const savedViewMode = parsed\.viewMode === 'list'[\s\S]*parsed\.viewMode === 'workload'[\s\S]*setViewMode\(savedViewMode, \{ render: false \}\);/,
  );

  assert.ok(appJs.includes('workloadView: {'));
  assert.ok(appJs.includes('lastBoardViewMode: state.lastBoardViewMode === \'list\' ? \'list\' : \'kanban\''));
  assert.ok(appJs.includes('workloadView.dateRange?.start'));
  assert.ok(appJs.includes('workloadView.dateRange?.end'));
  assert.ok(appJs.includes('state.workloadDateRange = { start: startDate, end: endDate };'));
});

test('HTML and spotlight expose full workload dashboard + quick panel controls', async () => {
  const html = await readFile(path.join(__dirname, '..', 'index.html'), 'utf8');
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(html.includes('id="viewWorkload"'));
  assert.ok(html.includes('id="workloadPanelQuickBtn"'));
  assert.ok(/id="sidebarWorkloadBtn"[^>]*openWorkloadDashboard\(\)/.test(html));
  assert.ok(!/id="sidebarWorkloadBtn"[^>]*toggleWorkloadPanel\(\)/.test(html));
  assert.ok(html.includes('Open Full Dashboard'));

  assert.ok(html.includes('Toggle workload panel (Kanban/List)'));
  assert.ok(html.includes('Open workload dashboard'));

  assert.ok(appJs.includes("id: 'workloadDashboard'"));
  assert.ok(appJs.includes("id: 'workloadPanel'"));
});
