const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('fullscreen gantt grid does not render per-day cells', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(
    !appJs.includes('gantt-grid-cell'),
    'Expected fullscreen gantt grid to avoid generating per-day gantt-grid-cell DOM nodes.',
  );
});

test('gantt drag/resize snaps to weekdays (weekends ignored)', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(appJs.includes('function coerceToWeekday'), 'Expected coerceToWeekday helper to exist.');
  assert.ok(appJs.includes('function addBusinessDays'), 'Expected addBusinessDays helper to exist.');

  assert.ok(
    /function endGanttDrag[\s\S]*coerceToWeekday\(newStart[\s\S]*addBusinessDays\(newStart,\s*durationDays\s*-\s*1\)/.test(appJs),
    'Expected fullscreen gantt drag to coerce weekends and preserve business duration.',
  );

  assert.ok(
    appJs.includes('function endGanttResize') && appJs.includes('coerceToWeekday(newEnd'),
    'Expected fullscreen gantt resize to coerce weekend dates to weekdays.',
  );

  assert.ok(
    /function endListGanttDrag[\s\S]*coerceToWeekday\(newStart[\s\S]*addBusinessDays\(newStart,\s*durationDays\s*-\s*1\)/.test(appJs),
    'Expected list gantt drag to coerce weekends and preserve business duration.',
  );

  assert.ok(
    appJs.includes('function endListGanttResize') && appJs.includes('coerceToWeekday(newEnd'),
    'Expected list gantt resize to coerce weekend dates to weekdays.',
  );

  assert.ok(!appJs.includes('calendarSpanDays'), 'Expected gantt dragging to avoid preserving raw calendar spans.');
});

test('fullscreen gantt bars render without ReferenceError', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  const start = appJs.indexOf('function renderGanttBars');
  const end = appJs.indexOf('function startGanttDrag');
  assert.ok(start !== -1 && end !== -1 && end > start, 'Expected renderGanttBars and startGanttDrag functions to exist.');

  const section = appJs.slice(start, end);
  assert.ok(
    /const\s+isSelected\s*=\s*(ganttState\.selectedTaskId\s*===\s*task\.Id|isTaskSelected\(\s*task\.Id\s*\))/.test(section),
    'Expected renderGanttBars to define isSelected before using it in the template literal.',
  );
});
