const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('shotgrid errors are sanitized before rendering to the UI', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');

  assert.ok(appJs.includes('function looksLikeHtmlDocument(value)'), 'Expected HTML error detection helper.');
  assert.ok(appJs.includes('function summarizeShotGridHtmlError(value, status)'), 'Expected HTML error summarizer helper.');
  assert.ok(appJs.includes('Flow Production Tracking returned an HTML error page'), 'Expected concise Flow Production Tracking HTML error copy.');
  assert.ok(appJs.includes('Hint: ${hint}'), 'Expected sanitized HTML errors to preserve actionable hints.');
});

test('agent chat renders salvaged JSON replies, history status, and active run controls', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');
  const stylesCss = await readFile(path.join(__dirname, '..', 'styles.css'), 'utf8');

  assert.ok(appJs.includes('function agentRenderableAssistantText(raw) {'), 'Expected assistant preview extraction helper for salvaged JSON.');
  assert.ok(appJs.includes("await agentRequest('/api/agents/runs/cancel', {"), 'Expected active runs to expose a stop action.');
  assert.ok(appJs.includes('function renderAgentRunStateCard(run, threadId, providerLabel) {'), 'Expected explicit in-thread run state card rendering.');
  assert.ok(appJs.includes('function agentRunNeedsLiveSync(run) {'), 'Expected active runs to expose a live-sync helper.');
  assert.ok(appJs.includes('function syncAgentRunRefreshTicker() {'), 'Expected active runs to schedule a fallback refresh ticker.');
  assert.ok(appJs.includes('if (agentRunNeedsLiveSync(activeRun)) void refreshAgentRunsAndActions();'), 'Expected SSE failures to trigger a state refresh fallback.');
  assert.ok(appJs.includes('agent-chat-thread-badge'), 'Expected history entries to render run status badges.');
  assert.ok(appJs.includes('function agentThreadDisplayTitle(thread, fallback = AGENT_CHAT_EMPTY_TITLE) {'), 'Expected history titles to fall back to thread content when placeholders leak through.');

  assert.ok(stylesCss.includes('.agent-chat-thread-meta-row {'), 'Expected history items to lay out metadata and status badges together.');
  assert.ok(stylesCss.includes('.agent-tool-chip.status-canceled {'), 'Expected canceled run badge styling.');
});
