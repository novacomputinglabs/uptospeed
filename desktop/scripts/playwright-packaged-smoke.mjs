import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { reserveFreePort } from '../src/process-manager.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..', '..');
const outputDir = path.join(repoRoot, 'output', 'playwright');
const screenshotPath = path.join(outputDir, 'electron-packaged-full-smoke.png');
const reportPath = path.join(outputDir, 'electron-packaged-full-smoke.json');
const requireFromMcp = createRequire(path.join(repoRoot, 'mcp', 'package.json'));
const { chromium } = requireFromMcp('playwright');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch (_error) {
    return false;
  }
}

async function readJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed for ${url}: ${response.status}`);
  }
  return await response.json();
}

async function waitForValue(factory, validate, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 60000));
  const intervalMs = Math.max(100, Number(options.intervalMs || 250));
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let lastValue = null;

  while (Date.now() < deadline) {
    try {
      lastValue = await factory();
      if (validate(lastValue)) return lastValue;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }

  const detail = lastError
    ? `lastError=${String(lastError.message || lastError)}`
    : `lastValue=${JSON.stringify(lastValue)}`;
  throw new Error(`Timed out waiting for value (${detail})`);
}

async function detectMacBundleDir(releasesDir) {
  const children = await readdir(releasesDir, { withFileTypes: true });
  for (const entry of children) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith('mac')) continue;
    const bundleDir = path.join(releasesDir, entry.name, 'UP TO SPEED.app');
    if (await pathExists(bundleDir)) return bundleDir;
  }
  return '';
}

async function resolvePackagedExecutable() {
  const explicit = String(process.env.UTS_ELECTRON_APP_EXECUTABLE || '').trim();
  if (explicit) {
    if (!(await pathExists(explicit))) {
      throw new Error(`UTS_ELECTRON_APP_EXECUTABLE does not exist: ${explicit}`);
    }
    return explicit;
  }

  const releasesDir = path.join(repoRoot, 'desktop', 'releases');
  if (process.platform === 'darwin') {
    const bundleDir = await detectMacBundleDir(releasesDir);
    if (!bundleDir) {
      throw new Error(`No macOS bundle found in ${releasesDir}. Run "npm run dist:dir" in desktop/ first.`);
    }
    return path.join(bundleDir, 'Contents', 'MacOS', 'UP TO SPEED');
  }
  if (process.platform === 'win32') {
    const candidate = path.join(releasesDir, 'win-unpacked', 'UP TO SPEED.exe');
    if (await pathExists(candidate)) return candidate;
    throw new Error(`No Windows unpacked build found at ${candidate}. Run "npm run dist:dir" in desktop/ first.`);
  }
  const candidate = path.join(releasesDir, 'linux-unpacked', 'UP TO SPEED');
  if (await pathExists(candidate)) return candidate;
  throw new Error(`No Linux unpacked build found at ${candidate}. Run "npm run dist:dir" in desktop/ first.`);
}

function attachChildLogReaders(child, buckets) {
  child.stdout?.on('data', (chunk) => {
    buckets.stdout.push(String(chunk || ''));
  });
  child.stderr?.on('data', (chunk) => {
    buckets.stderr.push(String(chunk || ''));
  });
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    sleep(5000).then(() => false),
  ]);
  if (!exited) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', () => resolve(true)));
  }
}

async function waitForCdpTarget(cdpPort) {
  const listUrl = `http://127.0.0.1:${cdpPort}/json/list`;
  return await waitForValue(
    async () => await readJson(listUrl),
    (targets) => Array.isArray(targets) && targets.some((target) => {
      const url = String(target?.url || '');
      return target?.type === 'page' && url.startsWith('http://127.0.0.1:');
    }),
    { timeoutMs: 90000, intervalMs: 250 },
  );
}

async function resolveMainPage(browser) {
  return await waitForValue(
    async () => {
      const contexts = browser.contexts();
      for (const context of contexts) {
        const page = context.pages().find((candidate) => {
          const url = candidate.url();
          return typeof url === 'string' && url.startsWith('http://127.0.0.1:');
        });
        if (page) return page;
      }
      return null;
    },
    (page) => Boolean(page),
    { timeoutMs: 30000, intervalMs: 250 },
  );
}

async function waitForEnabled(page, selector, timeoutMs = 30000) {
  await page.waitForFunction((targetSelector) => {
    const element = document.querySelector(targetSelector);
    return !!element && !element.disabled;
  }, selector, { timeout: timeoutMs });
}

async function pickFirstCustomSelectOption(page, selectId) {
  const customRoot = page.locator(`#${selectId} + .custom-select`);
  await customRoot.locator('.custom-select-trigger').click();
  const optionText = await customRoot.locator('.custom-select-option').evaluateAll((elements) => {
    const firstMatch = elements.find((element, index) => {
      if (index === 0) return false;
      const text = String(element.textContent || '').trim();
      if (!text) return false;
      const style = window.getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    return firstMatch ? String(firstMatch.textContent || '').trim() : '';
  });
  assert(optionText, `No selectable option found for ${selectId}`);
  await customRoot.locator('.custom-select-option', { hasText: optionText }).first().click();
  await page.waitForFunction(({ targetSelectId, expectedText }) => {
    const text = document.querySelector(`#${targetSelectId} + .custom-select .custom-select-trigger .custom-select-text`);
    return text && String(text.textContent || '').trim() === expectedText;
  }, { targetSelectId: selectId, expectedText: optionText });
  return optionText;
}

async function clickAndWaitForClass(page, selector, className, expected = true) {
  await page.locator(selector).click();
  await page.waitForFunction(({ targetSelector, targetClass, shouldHaveClass }) => {
    const element = document.querySelector(targetSelector);
    return !!element && element.classList.contains(targetClass) === shouldHaveClass;
  }, { targetSelector: selector, targetClass: className, shouldHaveClass: expected });
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const executable = await resolvePackagedExecutable();
  const cdpPort = await reserveFreePort();
  const logs = { stdout: [], stderr: [] };
  const launchedAt = new Date().toISOString();
  const child = spawn(executable, [], {
    cwd: repoRoot,
    env: {
      ...process.env,
      UTS_ELECTRON_CDP_PORT: String(cdpPort),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  attachChildLogReaders(child, logs);

  let browser = null;
  const steps = [];
  try {
    child.once('exit', (code, signal) => {
      if (browser) return;
      console.error(`Packaged app exited before Playwright attached (code=${code} signal=${signal})`);
    });

    await waitForValue(
      async () => await readJson(`http://127.0.0.1:${cdpPort}/json/version`),
      (payload) => typeof payload?.webSocketDebuggerUrl === 'string' && payload.webSocketDebuggerUrl.startsWith('ws://'),
      { timeoutMs: 90000, intervalMs: 250 },
    );
    await waitForCdpTarget(cdpPort);

    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const page = await resolveMainPage(browser);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('#appShell', { state: 'visible', timeout: 30000 });
    await waitForEnabled(page, '#newTaskButton', 60000);

    const appUrl = page.url();
    const appOrigin = new URL(appUrl).origin;
    const title = await page.title();
    assert.equal(title, 'UP TO SPEED', 'Main window title did not match');
    steps.push({ step: 'startup', status: 'passed', url: appUrl, title });

    const agentHealth = await readJson(`${appOrigin}/api/agents/health`);
    assert.equal(agentHealth?.gateway?.ok, true, 'Agent gateway health was not ok');
    assert.equal(agentHealth?.gateway?.session?.mode, 'cdp', 'Gateway did not attach in CDP mode');
    assert.equal(agentHealth?.gateway?.session?.usesStaticFallback, false, 'Gateway unexpectedly fell back to static mode');
    steps.push({ step: 'agent-health', status: 'passed', session: agentHealth.gateway.session });

    const localHealth = await readJson(`${appOrigin}/api/local/health`);
    assert.equal(localHealth?.encryption?.mode, 'sqlcipher', 'Local broker encryption is not SQLCipher');
    assert.equal(localHealth?.encryption?.key_source, 'managed', 'Local broker key source is not managed');
    steps.push({ step: 'local-health', status: 'passed', dataDir: localHealth.data_dir, encryption: localHealth.encryption });

    await page.locator('#sidebarProfileTrigger').click();
    await page.waitForSelector('#sidebarProfileMenu.open', { state: 'visible' });
    const workspaceCount = await page.locator('#workspaceSource option').count();
    assert(workspaceCount >= 1, 'Workspace selector did not contain any options');
    await page.locator('header').click();
    await page.waitForFunction(() => !document.getElementById('sidebarProfileMenu')?.classList.contains('open'));
    steps.push({ step: 'workspace-menu', status: 'passed', workspaceCount });

    await page.locator('#viewList').click();
    await page.waitForFunction(() => document.getElementById('viewModeLabel')?.textContent?.includes('/ List'));
    await page.locator('#viewWorkload').click();
    await page.waitForFunction(() => document.getElementById('viewModeLabel')?.textContent?.includes('/ Workload'));
    await page.waitForSelector('#workloadDashboardBody', { state: 'visible' });
    await page.locator('#viewKanban').click();
    await page.waitForFunction(() => document.getElementById('viewModeLabel')?.textContent?.includes('/ Kanban'));
    steps.push({ step: 'view-switching', status: 'passed' });

    await clickAndWaitForClass(page, '#workloadPanelQuickBtn', 'active', true);
    await page.waitForSelector('#workloadPanel.open', { state: 'visible' });
    await page.locator('#workloadPanel .panel-close').click();
    await page.waitForFunction(() => !document.getElementById('workloadPanel')?.classList.contains('open'));
    steps.push({ step: 'workload-panel', status: 'passed' });

    await page.locator('button[title="Settings"]').click();
    await page.waitForSelector('#settingsModal.open', { state: 'visible' });
    await page.waitForSelector('#settingsTheme', { state: 'visible' });
    await page.locator('#settingsModal .panel-close').click();
    await page.waitForFunction(() => !document.getElementById('settingsModal')?.classList.contains('open'));
    steps.push({ step: 'settings-modal', status: 'passed' });

    await page.locator('#agentChatToggleBtn').click();
    await page.waitForSelector('#agentChatDock.open', { state: 'visible' });
    await page.waitForSelector('#agentChatInput', { state: 'visible' });
    await page.locator('button[aria-label="Close agent chat"]').click();
    await page.waitForFunction(() => !document.getElementById('agentChatDock')?.classList.contains('open'));
    steps.push({ step: 'agent-chat-dock', status: 'passed' });

    await page.locator('#sidebarAgentPermissionsBtn').click();
    await page.waitForFunction(() => document.getElementById('viewModeLabel')?.textContent?.includes('/ Agent Permissions'));
    await page.waitForFunction(() => {
      const board = document.getElementById('board');
      if (!board) return false;
      return Boolean(board.querySelector('.agent-permissions-view') || board.querySelector('.empty-state'));
    });
    await page.locator('#viewKanban').click();
    await page.waitForFunction(() => document.getElementById('viewModeLabel')?.textContent?.includes('/ Kanban'));
    steps.push({ step: 'agent-permissions-view', status: 'passed' });

    await page.locator('#sidebarEndeavorsBtn').click();
    await page.waitForSelector('#endeavorsPanel.open', { state: 'visible' });
    await page.waitForSelector('#endeavorTitle', { state: 'visible' });
    await page.locator('#endeavorsPanel .panel-close').click();
    await page.waitForFunction(() => !document.getElementById('endeavorsPanel')?.classList.contains('open'));
    steps.push({ step: 'endeavors-panel', status: 'passed' });

    const uniqueTaskName = `Playwright Smoke ${Date.now()}`;
    await page.locator('#newTaskButton').click();
    await page.waitForSelector('#createModal.open', { state: 'visible' });
    await page.waitForSelector('#createModal .modal', { state: 'visible' });
    const selectedAsset = await pickFirstCustomSelectOption(page, 'createAsset');
    const selectedDept = await pickFirstCustomSelectOption(page, 'createDept');
    await page.locator('#createTaskName').fill(uniqueTaskName);
    await page.locator('#createDescription').fill('Packaged Electron smoke test task');
    await page.locator('#createModal .btn.btn-primary').click();
    await page.waitForFunction(() => !document.getElementById('createModal')?.classList.contains('open'));
    await page.locator('#filterSearch').fill(uniqueTaskName);
    await page.waitForFunction((taskName) => {
      const board = document.getElementById('board');
      return !!board && board.innerText.includes(taskName);
    }, uniqueTaskName);
    await waitForEnabled(page, '#undoBtn', 10000);
    await page.locator('#undoBtn').click();
    await page.waitForFunction((taskName) => {
      const board = document.getElementById('board');
      return !!board && !board.innerText.includes(taskName);
    }, uniqueTaskName);
    await page.locator('#filterSearch').fill('');
    steps.push({
      step: 'create-task-search-undo',
      status: 'passed',
      taskName: uniqueTaskName,
      selectedAsset,
      selectedDept,
    });

    await page.screenshot({ path: screenshotPath, fullPage: true });
    const report = {
      launchedAt,
      executable,
      cdpPort,
      screenshotPath,
      appUrl,
      steps,
      agentHealth,
      localHealth,
      stderrTail: logs.stderr.join('').trim().split('\n').slice(-40),
      stdoutTail: logs.stdout.join('').trim().split('\n').slice(-40),
    };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ok: true, reportPath, screenshotPath, steps }, null, 2));
  } catch (error) {
    const failure = {
      launchedAt,
      executable,
      cdpPort,
      error: String(error?.stack || error),
      stderrTail: logs.stderr.join('').trim().split('\n').slice(-80),
      stdoutTail: logs.stdout.join('').trim().split('\n').slice(-80),
    };
    try {
      await writeFile(reportPath, `${JSON.stringify(failure, null, 2)}\n`, 'utf8');
    } catch (_writeError) {
      // Ignore report write failures during error handling.
    }
    throw error;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
    await terminateChild(child);
  }
}

try {
  await main();
} catch (error) {
  console.error(String(error?.stack || error));
  process.exitCode = 1;
}
