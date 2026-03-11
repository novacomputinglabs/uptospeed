const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('list gantt does not hard-limit to 365 days', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(
    !appJs.includes('totalDays <= 0 || totalDays > 365'),
    'Expected legacy 365-day guard to be removed from list gantt rendering.',
  );

  const maxDaysMatch = appJs.match(/const\s+MAX_LIST_GANTT_DAYS\s*=\s*(\d+)\s*;/);
  assert.ok(maxDaysMatch, 'Expected MAX_LIST_GANTT_DAYS constant to exist.');

  const maxDays = Number(maxDaysMatch[1]);
  assert.ok(Number.isFinite(maxDays) && maxDays > 365, 'Expected MAX_LIST_GANTT_DAYS > 365.');
});

test('list gantt grid does not render per-day cells', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(
    !appJs.includes('class="list-gantt-cell'),
    'Expected list gantt grid to avoid generating per-day cell DOM nodes.',
  );
});
