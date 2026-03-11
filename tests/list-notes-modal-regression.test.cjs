const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('list notes cell exposes Open Notes button and modal wiring', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');
  const html = await readFile(path.join(__dirname, '..', 'index.html'), 'utf8');
  const css = await readFile(path.join(__dirname, '..', 'styles.css'), 'utf8');

  assert.ok(appJs.includes('class="list-notes-open-btn"'), 'Expected list notes button markup in app.js renderer.');
  assert.ok(appJs.includes('openTaskNotesModal('), 'Expected openTaskNotesModal function usage in list notes cell.');
  assert.ok(appJs.includes('function renderTaskNotesModal'), 'Expected task notes modal renderer in app.js.');

  assert.ok(html.includes('id="taskNotesModal"'), 'Expected task notes modal in index.html.');
  assert.ok(html.includes('id="taskNotesComposerInput"'), 'Expected task notes composer input in index.html.');

  assert.ok(css.includes('.task-notes-modal'), 'Expected task notes modal styles in styles.css.');
  assert.ok(css.includes('.list-notes-open-btn'), 'Expected list notes button styles in styles.css.');
});
