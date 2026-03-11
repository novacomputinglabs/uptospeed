const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');

test('launcher script starts the supported agent stack and waits for health endpoints', async () => {
  const launcher = await readFile(path.join(__dirname, '..', 'scripts', 'launch_agent_stack.py'), 'utf8');

  assert.ok(launcher.includes('BACKEND_CMD = [sys.executable, "server/shotgrid_server.py"]'), 'Expected launcher to start the Python backend.');
  assert.ok(launcher.includes('GATEWAY_CMD = ["node", "src/agent-gateway.mjs"]'), 'Expected launcher to start the agent gateway.');
  assert.ok(launcher.includes('f"{STACK_URL}api/local/health"'), 'Expected launcher to wait for /api/local/health.');
  assert.ok(launcher.includes('f"{STACK_URL}api/shotgrid/health"'), 'Expected launcher to wait for /api/shotgrid/health.');
  assert.ok(launcher.includes('f"{STACK_URL}api/agents/health"'), 'Expected launcher to wait for /api/agents/health.');
  assert.ok(launcher.includes('gateway_env["UTS_MCP_BASE_URL"] = STACK_URL'), 'Expected launcher to bind the gateway to the writable backend.');
  assert.ok(launcher.includes('webbrowser.open(STACK_URL)'), 'Expected launcher to open the supported runtime in the browser.');
});

test('README documents the launcher-managed runtime and static fallback limits', async () => {
  const readme = await readFile(path.join(__dirname, '..', 'README.md'), 'utf8');

  assert.ok(readme.includes('python3 scripts/launch_agent_stack.py'), 'Expected README to document the launcher command.');
  assert.ok(readme.includes('Opening `index.html` directly is still supported as a read-only fallback'), 'Expected README to describe static fallback mode.');
  assert.ok(readme.includes('agent mutations stay disabled in static mode'), 'Expected README to clarify static-mode agent limits.');
});
