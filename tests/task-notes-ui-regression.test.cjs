const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('task notes modal uses mock avatars and thread switcher UI', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');
  const html = await readFile(path.join(__dirname, '..', 'index.html'), 'utf8');
  const css = await readFile(path.join(__dirname, '..', 'styles.css'), 'utf8');

  assert.ok(appJs.includes('getMockAvatarPlaceholderUrl(message.author'), 'Expected task notes avatar to use mock placeholder URLs.');
  assert.ok(appJs.includes('function switchTaskNotesThread('), 'Expected task notes thread switch handler.');
  assert.ok(!appJs.includes('task-notes-badge local'), 'Expected local source badge to be removed from task notes renderer.');
  assert.ok(!appJs.includes('task-notes-badge mock'), 'Expected mock source badge to be removed from task notes renderer.');

  assert.ok(html.includes('id="taskNotesThreadSwitcher"'), 'Expected thread switcher container in task notes modal.');

  assert.ok(css.includes('.task-notes-thread-switcher'), 'Expected thread switcher styles.');
  assert.ok(css.includes('.task-notes-avatar-image'), 'Expected task notes avatar image styles.');
});
