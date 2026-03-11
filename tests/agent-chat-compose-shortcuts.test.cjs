const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('agent chat composer uses enter to send and shift-enter for new lines', async () => {
  const html = await readFile(path.join(__dirname, '..', 'index.html'), 'utf8');
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(html.includes('enterkeyhint="send"'), 'Expected the agent chat textarea to hint a send action.');
  assert.equal(html.includes('title="Send (⌘Enter)"'), false, 'Expected the old send shortcut hint to be removed.');
  assert.ok(
    html.includes('title="Send (Enter; Shift+Enter for new line)"'),
    'Expected the send button tooltip to advertise the updated compose shortcut.'
  );
  assert.ok(appJs.includes("if (!event || event.key !== 'Enter') return;"), 'Expected the composer shortcut handler to intercept only Enter presses.');
  assert.ok(
    appJs.includes("if (event.isComposing || event.keyCode === 229 || event.shiftKey) return;"),
    'Expected the composer shortcut handler to preserve IME composition and Shift+Enter new lines.'
  );
  assert.ok(appJs.includes('sendAgentChatMessage();'), 'Expected the Enter shortcut to submit the agent chat message.');
});
