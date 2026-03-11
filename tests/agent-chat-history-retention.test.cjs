const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('agent chat keeps existing thread history visible while a run is active', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(
    appJs.includes('const ensured = mergeAgentThreadSnapshot(thread);'),
    'Expected chat sends to merge thread metadata without overwriting the local message timeline.'
  );
  assert.equal(
    appJs.includes("messages: payload?.message && typeof payload.message === 'object'"),
    false,
    'Expected run creation to stop replacing the current thread history with a one-message snapshot.'
  );
});

test('agent chat only autoscrolls when the user is already at the latest message', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(appJs.includes('function shouldAgentChatAutoscroll(container, threadId) {'), 'Expected an agent chat autoscroll guard helper.');
  assert.ok(
    appJs.includes('const shouldStickToBottom = shouldAgentChatAutoscroll(messagesContainer, selectedThreadId);'),
    'Expected the chat dock renderer to decide whether to preserve the current scroll position.'
  );
  assert.ok(
    appJs.includes('messagesContainer.scrollTop = shouldStickToBottom ? messagesContainer.scrollHeight : previousScrollTop;'),
    'Expected the chat dock renderer to preserve scroll position when reviewing older messages.'
  );
});
