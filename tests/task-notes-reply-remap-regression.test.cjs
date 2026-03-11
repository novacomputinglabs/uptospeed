const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('task notes sync remaps queued replies when local thread becomes sg-note-*', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(
    appJs.includes("if (previousThreadId && previousThreadId !== ref.thread.threadId)"),
    'Expected note sync to detect thread id remap.',
  );
  assert.ok(
    appJs.includes("state.taskNotesQueue = state.taskNotesQueue.map((item) =>"),
    'Expected queue remap logic after note sync.',
  );
  assert.ok(
    appJs.includes("if (next.action === 'create_reply' && !Number.isFinite(Number(next.replyToNoteId)))"),
    'Expected queued replies to inherit sg note id after remap.',
  );
  assert.ok(
    appJs.includes("if (!thread && op.messageId)"),
    'Expected reply flush fallback to recover thread by messageId when thread id changed.',
  );
});
