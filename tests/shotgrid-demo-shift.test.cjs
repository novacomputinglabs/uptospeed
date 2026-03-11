const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('settings modal exposes ShotGrid demo date-shift in dev mode', async () => {
  const html = await readFile(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(html.includes('id="settingsDevToolsSection"'));
  assert.ok(html.includes('onclick="shiftShotGridTaskDatesToYear(2026)"'));
});

test('ShotGrid demo date-shift only targets ShotGrid tasks', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.ok(appJs.includes('function shiftShotGridTaskDatesToYear'));
  assert.ok(appJs.includes("__source === 'shotgrid'"));
  assert.ok(appJs.includes('shotgridDirtyById'));
  assert.ok(appJs.includes('targetYear = 2026'));
  assert.ok(appJs.includes('90th percentile'));
});
