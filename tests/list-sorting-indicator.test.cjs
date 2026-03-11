const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('list view partial updates refresh the sort indicator in the header', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(
    appJs.includes("const existingListHeader = document.getElementById('listHeader');"),
    'Expected renderListView to look up #listHeader for partial updates.',
  );

  assert.ok(
    /const\s+canPartialUpdate\s*=\s*existingListHeader\s*&&\s*existingListBody\s*&&\s*existingGanttTimeline\s*&&/m.test(appJs),
    'Expected canPartialUpdate to require an existing list header node.',
  );

  assert.ok(
    /if\s*\(\s*canPartialUpdate\s*\)\s*\{[\s\S]*?existingListHeader\.innerHTML\s*=\s*buildListHeaderHtml\(\)\s*;/m.test(appJs),
    'Expected partial update path to rebuild the list header HTML (sort arrow + highlight).',
  );
});

