const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('agent chat renderer supports markdown blocks and clickable internal links', async () => {
  const appJs = await readFile(path.join(__dirname, '..', 'app.js'), 'utf8');
  const css = await readFile(path.join(__dirname, '..', 'styles.css'), 'utf8');

  assert.ok(appJs.includes('function renderAgentMarkdown('), 'Expected a markdown block renderer for assistant chat messages.');
  assert.ok(appJs.includes('function renderAgentMarkdownTable('), 'Expected markdown table rendering support.');
  assert.ok(appJs.includes('function openAgentChatTaskLink('), 'Expected task link click handler for agent chat.');
  assert.ok(appJs.includes('function openAgentChatEndeavorLink('), 'Expected endeavor link click handler for agent chat.');
  assert.ok(appJs.includes('task-notes:(?:\\/\\/)?'), 'Expected internal task notes markdown link support.');
  assert.ok(appJs.includes("return renderAgentMarkdown(raw);"), 'Expected assistant messages to render through the markdown formatter.');

  assert.ok(css.includes('.agent-chat-message h1,'), 'Expected markdown heading styles in agent chat.');
  assert.ok(css.includes('.agent-chat-blockquote'), 'Expected markdown blockquote styles in agent chat.');
  assert.ok(css.includes('.agent-chat-table'), 'Expected markdown table styles in agent chat.');
  assert.ok(css.includes('.agent-chat-entity-link'), 'Expected clickable internal-link styles in agent chat.');
});

test('agent provider prompt documents markdown presentation and clickable task links', async () => {
  const serverPy = await readFile(path.join(__dirname, '..', 'server', 'shotgrid_server.py'), 'utf8');

  assert.ok(
    serverPy.includes('rendered as markdown in the Agent chat'),
    'Expected the system prompt to document markdown rendering for assistant messages.'
  );
  assert.ok(
    serverPy.includes('[Comp cleanup](task://1234)'),
    'Expected the system prompt to document clickable task markdown links.'
  );
  assert.ok(
    serverPy.includes('[Comp cleanup notes](task-notes://1234)'),
    'Expected the system prompt to document clickable task-notes markdown links.'
  );
  assert.ok(
    serverPy.includes('[Weekly comp push](endeavor://endeavor-123)'),
    'Expected the system prompt to document clickable endeavor markdown links.'
  );
  assert.ok(
    serverPy.includes('Do not invent ids or internal links.'),
    'Expected the system prompt to prohibit invented internal links.'
  );
});
