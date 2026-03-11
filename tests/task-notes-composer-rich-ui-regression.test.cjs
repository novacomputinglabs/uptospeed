const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('task notes composer supports mention popover and attachment controls', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');
  const html = await readFile(path.join(__dirname, '..', 'index.html'), 'utf8');
  const css = await readFile(path.join(__dirname, '..', 'styles.css'), 'utf8');

  assert.ok(html.includes('id="taskNotesMentionPopover"'), 'Expected mention popover container in task notes composer.');
  assert.ok(html.includes('id="taskNotesImageInput"'), 'Expected hidden image input for task notes attachments.');
  assert.ok(html.includes('id="taskNotesFileInput"'), 'Expected hidden file input for task notes attachments.');
  assert.ok(html.includes('onclick="focusTaskNotesMention()"'), 'Expected mention trigger button in composer toolbar.');
  assert.ok(html.includes('onclick="openTaskNotesImagePicker()"'), 'Expected image attachment button in composer toolbar.');

  assert.ok(appJs.includes('function updateTaskNotesMentionPopover()'), 'Expected mention popover update helper in app.js.');
  assert.ok(appJs.includes('function selectTaskNotesMention('), 'Expected mention selection helper in app.js.');
  assert.ok(appJs.includes('function addTaskNotesAttachmentsFromFileList('), 'Expected file/image attachment handler in app.js.');
  assert.ok(appJs.includes('function addTaskNotesLink()'), 'Expected link attachment helper in app.js.');
  assert.ok(appJs.includes('renderTaskNotesMessageAttachments(message)'), 'Expected task notes renderer to show attachments.');

  assert.ok(css.includes('.task-notes-mention-popover'), 'Expected mention popover styles.');
  assert.ok(css.includes('.task-notes-composer-attachments'), 'Expected composer attachment styles.');
  assert.ok(css.includes('.task-notes-message-attachments'), 'Expected timeline attachment styles.');
});
