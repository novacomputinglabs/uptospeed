const assert = require('node:assert/strict');
const { mkdtemp, realpath, rm, writeFile } = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const REPO_ROOT = path.join(__dirname, '..');

async function reservePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForJson(url, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      const payload = await res.json();
      if (res.ok) return payload;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

test('desktop runtime env reroots broker paths and dotenv lookup', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'uts-desktop-data-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'uts-desktop-config-'));
  const port = await reservePort();
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    LOCAL_BROKER_AUTO_ENCRYPTION: '0',
    UTS_APP_ROOT: REPO_ROOT,
    UTS_DATA_DIR: dataDir,
    UTS_CONFIG_DIR: configDir,
    UTS_AGENT_RUNTIME_LAUNCHER_COMMAND: 'Desktop runtime controls',
  };
  await writeFile(path.join(configDir, '.env.local'), 'SHOTGRID_URL=https://studio.example.com\n', 'utf8');
  const child = spawn('python3', ['server/shotgrid_server.py'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const localHealth = await waitForJson(`http://127.0.0.1:${port}/api/local/health`);
    assert.equal(localHealth.app_root, REPO_ROOT);
    assert.equal(localHealth.data_dir, await realpath(dataDir));
    assert.equal(localHealth.config_dir, await realpath(configDir));
    assert.equal(localHealth.db_path, path.join(await realpath(dataDir), '.local_sync_broker.sqlite3'));

    const shotgridHealth = await waitForJson(`http://127.0.0.1:${port}/api/shotgrid/health`);
    assert.equal(shotgridHealth.default_site_url, 'https://studio.example.com');

    const agentsHealth = await waitForJson(`http://127.0.0.1:${port}/api/agents/health`);
    assert.equal(agentsHealth.launcher_command, 'Desktop runtime controls');
  } finally {
    await stopProcess(child);
    await rm(dataDir, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }
});
