import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, mkdir, open, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  Menu,
  dialog,
  ipcMain,
  shell,
} from 'electron';
import {
  DEFAULT_DESKTOP_MIGRATION_POLICY,
  DEFAULT_DESKTOP_RUNTIME_PROFILE_ID,
  DEFAULT_HOST,
  buildBackendCommand,
  buildGatewayCommand,
  importLegacyRuntimeData,
  listDesktopRuntimeProfiles,
  normalizeDesktopMigrationPolicy,
  normalizeDesktopRuntimeProfileId,
  readDesktopState,
  reserveRuntimePorts,
  resolveDesktopRuntimePaths,
  waitForJsonHealth,
  writeDesktopState,
} from './process-manager.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BOOTSTRAP_HTML = path.join(__dirname, '..', 'ui', 'bootstrap.html');
const BOOTSTRAP_PRELOAD = path.join(__dirname, 'bootstrap-preload.cjs');
const MAIN_PRELOAD = path.join(__dirname, 'main-preload.cjs');
const STARTUP_TIMEOUT_MS = 90000;
const CHILD_STOP_TIMEOUT_MS = 8000;
const DESKTOP_AUTO_RESTART_DELAYS_MS = [1500, 3500, 7000, 15000];
const MANUAL_RUNTIME_RESTART_DEFER_MS = 180;
const DESKTOP_LAUNCHER_LABEL = 'Desktop runtime controls';

const reservedPorts = await reserveRuntimePorts(DEFAULT_HOST);
const requestedCdpPort = Number.parseInt(process.env.UTS_ELECTRON_CDP_PORT || '', 10);
if (Number.isInteger(requestedCdpPort) && requestedCdpPort > 0 && requestedCdpPort < 65536) {
  reservedPorts.cdpPort = requestedCdpPort;
}
app.commandLine.appendSwitch('remote-debugging-port', String(reservedPorts.cdpPort));
app.commandLine.appendSwitch('remote-debugging-address', DEFAULT_HOST);

let bootstrapWindow = null;
let mainWindow = null;
let runtime = null;
let runtimePaths = null;
let desktopState = {};
let runtimeStopping = false;
let runtimeReady = false;
let runtimeAutoRestartAttempt = 0;
let runtimeAutoRestartTimer = null;
let queuedRuntimeRestartTimer = null;
let availableRuntimeProfiles = [DEFAULT_DESKTOP_RUNTIME_PROFILE_ID];
let desktopRuntimeState = {
  phase: 'starting',
  detail: 'Initializing local services.',
  healthy: false,
  launcherCommand: DESKTOP_LAUNCHER_LABEL,
  autoRestartAttempt: 0,
  maxAutoRestartAttempts: DESKTOP_AUTO_RESTART_DELAYS_MS.length,
  profileId: DEFAULT_DESKTOP_RUNTIME_PROFILE_ID,
  availableProfiles: [DEFAULT_DESKTOP_RUNTIME_PROFILE_ID],
  migrationPolicy: DEFAULT_DESKTOP_MIGRATION_POLICY,
  restartScheduled: false,
  nextRestartAt: '',
  lastRestartAt: '',
  lastError: '',
  backendPort: reservedPorts.backendPort,
  gatewayPort: reservedPorts.gatewayPort,
  logsDir: '',
  dataDir: '',
  mcpProfileDir: '',
  backendPid: null,
  gatewayPid: null,
  checkedAt: nowIso(),
};
let bootstrapState = {
  mode: 'starting',
  title: 'Preparing desktop runtime',
  detail: 'Initializing local services.',
  steps: [],
  error: '',
  logs: [],
  message: '',
};

function nowIso() {
  return new Date().toISOString();
}

function toLogLine(kind, message) {
  return `[${nowIso()}] [${kind}] ${message}`;
}

async function ensureLogFile(logPath) {
  await mkdir(path.dirname(logPath), { recursive: true });
  const handle = await open(logPath, 'a');
  await handle.close();
}

function truncateLogs(lines, max = 120) {
  return lines.slice(Math.max(0, lines.length - max));
}

function currentLogs() {
  if (!runtime) return [];
  return truncateLogs([
    ...runtime.logBuffers.backend,
    ...runtime.logBuffers.gateway,
    ...runtime.logBuffers.main,
  ]);
}

async function appendMainLog(message) {
  if (!runtimePaths) return;
  const line = toLogLine('desktop', message);
  if (runtime?.logBuffers?.main) {
    runtime.logBuffers.main.push(line);
    runtime.logBuffers.main = truncateLogs(runtime.logBuffers.main);
  }
  try {
    await appendFile(path.join(runtimePaths.logsDir, 'desktop.log'), `${line}\n`, 'utf8');
  } catch (_error) {
    // Best-effort logging.
  }
}

async function refreshRuntimeProfiles() {
  try {
    availableRuntimeProfiles = await listDesktopRuntimeProfiles(app.getPath('userData'));
  } catch (_error) {
    availableRuntimeProfiles = [DEFAULT_DESKTOP_RUNTIME_PROFILE_ID];
  }
  return availableRuntimeProfiles;
}

function runtimePartitionForProfile(profileId = runtimePaths?.runtimeProfileId || desktopState.currentRuntimeProfileId) {
  return `persist:uptospeed-${normalizeDesktopRuntimeProfileId(profileId)}`;
}

function buildDesktopRuntimeSnapshot(overrides = {}) {
  const profileId = normalizeDesktopRuntimeProfileId(
    overrides.profileId || runtimePaths?.runtimeProfileId || desktopState.currentRuntimeProfileId,
  );
  return {
    ...desktopRuntimeState,
    profileId,
    availableProfiles: [...new Set((availableRuntimeProfiles || []).map((entry) => normalizeDesktopRuntimeProfileId(entry)))],
    migrationPolicy: normalizeDesktopMigrationPolicy(
      overrides.migrationPolicy || desktopState.migrationPolicy,
      DEFAULT_DESKTOP_MIGRATION_POLICY,
    ),
    launcherCommand: DESKTOP_LAUNCHER_LABEL,
    maxAutoRestartAttempts: DESKTOP_AUTO_RESTART_DELAYS_MS.length,
    backendPort: reservedPorts.backendPort,
    gatewayPort: reservedPorts.gatewayPort,
    logsDir: runtimePaths?.logsDir || '',
    dataDir: runtimePaths?.dataDir || '',
    mcpProfileDir: runtimePaths?.mcpProfileDir || '',
    backendPid: runtime?.backend?.pid || null,
    gatewayPid: runtime?.gateway?.pid || null,
    checkedAt: nowIso(),
    ...overrides,
  };
}

function broadcastDesktopRuntimeState() {
  const snapshot = buildDesktopRuntimeSnapshot();
  if (bootstrapWindow && !bootstrapWindow.isDestroyed()) {
    bootstrapWindow.webContents.send('desktop:runtime-state', snapshot);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:runtime-state', snapshot);
  }
}

function pushDesktopRuntimeState(overrides = {}) {
  desktopRuntimeState = buildDesktopRuntimeSnapshot(overrides);
  broadcastDesktopRuntimeState();
  return desktopRuntimeState;
}

function clearRuntimeAutoRestartTimer() {
  if (runtimeAutoRestartTimer) {
    clearTimeout(runtimeAutoRestartTimer);
    runtimeAutoRestartTimer = null;
  }
}

function clearQueuedRuntimeRestartTimer() {
  if (queuedRuntimeRestartTimer) {
    clearTimeout(queuedRuntimeRestartTimer);
    queuedRuntimeRestartTimer = null;
  }
}

function pushBootstrapState(nextPartial) {
  bootstrapState = {
    ...bootstrapState,
    ...nextPartial,
  };
  if (!Array.isArray(bootstrapState.steps)) bootstrapState.steps = [];
  if (!Array.isArray(bootstrapState.logs)) bootstrapState.logs = [];
  if (bootstrapWindow && !bootstrapWindow.isDestroyed()) {
    bootstrapWindow.webContents.send('desktop:bootstrap-state', bootstrapState);
  }
}

function setBootstrapMode(mode, updates = {}) {
  pushBootstrapState({
    mode,
    logs: currentLogs(),
    ...updates,
  });
}

function updateBootstrapSteps(steps, detail) {
  pushBootstrapState({
    mode: 'starting',
    title: 'Preparing desktop runtime',
    detail,
    steps,
    error: '',
    logs: currentLogs(),
  });
}

function createBootstrapWindow() {
  if (bootstrapWindow && !bootstrapWindow.isDestroyed()) return bootstrapWindow;

  bootstrapWindow = new BrowserWindow({
    width: 920,
    height: 700,
    minWidth: 820,
    minHeight: 620,
    show: false,
    title: 'UP TO SPEED Desktop',
    backgroundColor: '#18171e',
    autoHideMenuBar: true,
    webPreferences: {
      preload: BOOTSTRAP_PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  bootstrapWindow.on('ready-to-show', () => {
    bootstrapWindow?.show();
    bootstrapWindow?.focus();
    bootstrapWindow?.webContents.send('desktop:bootstrap-state', bootstrapState);
    bootstrapWindow?.webContents.send('desktop:runtime-state', buildDesktopRuntimeSnapshot());
  });

  bootstrapWindow.on('closed', () => {
    bootstrapWindow = null;
    if (!mainWindow) {
      app.quit();
    }
  });

  void bootstrapWindow.loadFile(BOOTSTRAP_HTML);
  return bootstrapWindow;
}

function resolveRuntimeUrls() {
  const backendBaseUrl = `http://${DEFAULT_HOST}:${reservedPorts.backendPort}/`;
  return {
    backendBaseUrl,
    appUrl: backendBaseUrl,
    mcpBaseUrl: `${backendBaseUrl}index.html`,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function launchedWithNodeInspector() {
  const args = [...process.execArgv, ...process.argv];
  return args.some((arg) => typeof arg === 'string' && arg.startsWith('--inspect'));
}

async function announcePlaywrightDevToolsEndpoint() {
  if (!launchedWithNodeInspector()) return;

  const versionUrl = `http://${DEFAULT_HOST}:${reservedPorts.cdpPort}/json/version`;
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(versionUrl);
      if (response.ok) {
        const payload = await response.json();
        const wsUrl = typeof payload?.webSocketDebuggerUrl === 'string'
          ? payload.webSocketDebuggerUrl.trim()
          : '';
        if (wsUrl.startsWith('ws://') || wsUrl.startsWith('wss://')) {
          console.error(`DevTools listening on ${wsUrl}`);
          await appendMainLog(`Announced Playwright DevTools endpoint ${wsUrl}`);
          return;
        }
      }
    } catch (_error) {
      // Keep polling until Chromium exposes the websocket endpoint.
    }
    await sleep(250);
  }

  await appendMainLog(`Timed out waiting for Chromium DevTools endpoint at ${versionUrl}`);
}

function makeRandomToken() {
  return randomBytes(24).toString('hex');
}

function childLogFile(kind) {
  return path.join(runtimePaths.logsDir, `${kind}.log`);
}

async function wireChildLogging(child, kind) {
  const logPath = childLogFile(kind);
  await ensureLogFile(logPath);

  const buffer = runtime.logBuffers[kind];
  const consume = async (chunk) => {
    const text = String(chunk || '').replace(/\r/g, '');
    if (!text.trim()) return;
    const lines = text
      .split('\n')
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .map((line) => toLogLine(kind, line));
    if (lines.length === 0) return;
    buffer.push(...lines);
    runtime.logBuffers[kind] = truncateLogs(buffer);
    pushBootstrapState({ logs: currentLogs() });
    try {
      await appendFile(logPath, `${lines.join('\n')}\n`, 'utf8');
    } catch (_error) {
      // Best-effort logging.
    }
  };

  child.stdout?.on('data', (chunk) => void consume(chunk));
  child.stderr?.on('data', (chunk) => void consume(chunk));
}

function spawnManagedChild(kind, commandSpec, options = {}) {
  const child = spawn(commandSpec.command, commandSpec.args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.once('exit', (code, signal) => {
    const exitingIntentionally = runtimeStopping || runtime?.stopping === true;
    const message = `${kind} exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
    void appendMainLog(message);
    if (!exitingIntentionally) {
      void handleRuntimeFailure(new Error(message));
    }
  });

  child.once('error', (error) => {
    void appendMainLog(`${kind} process error: ${error.message}`);
    void handleRuntimeFailure(error);
  });

  return child;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => {
    child.once('exit', resolve);
  });
  child.kill('SIGTERM');
  await Promise.race([
    exited,
    new Promise((resolve) => setTimeout(resolve, CHILD_STOP_TIMEOUT_MS)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function stopRuntime() {
  if (!runtime) return;
  runtimeStopping = true;
  runtime.stopping = true;
  await Promise.allSettled([
    stopChild(runtime.gateway),
    stopChild(runtime.backend),
  ]);
  runtime = null;
  runtimeStopping = false;
  pushDesktopRuntimeState({
    backendPid: null,
    gatewayPid: null,
  });
}

function runtimeHealthValidate(_status, payload) {
  return payload?.ok === true
    && payload?.gateway?.ok === true
    && payload?.gateway?.session?.mode === 'cdp'
    && payload?.gateway?.session?.usesStaticFallback !== true;
}

function restartDelayMs(attempt) {
  const index = Math.max(0, Math.min(DESKTOP_AUTO_RESTART_DELAYS_MS.length - 1, attempt - 1));
  return DESKTOP_AUTO_RESTART_DELAYS_MS[index];
}

async function showRuntimeFailureState(errorMessage) {
  const logs = currentLogs();
  await stopRuntime();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
  createBootstrapWindow();
  setBootstrapMode('error', {
    title: 'Desktop runtime needs attention',
    detail: 'Automatic recovery is exhausted. Review the logs or retry the desktop runtime.',
    error: errorMessage,
    logs,
  });
  pushDesktopRuntimeState({
    phase: 'error',
    healthy: false,
    detail: 'Automatic recovery is exhausted. Review the logs or retry the desktop runtime.',
    restartScheduled: false,
    nextRestartAt: '',
    lastError: errorMessage,
  });
}

async function triggerRuntimeRestart(reason, options = {}) {
  clearQueuedRuntimeRestartTimer();
  clearRuntimeAutoRestartTimer();
  const preserveAttempt = options.preserveAttempt === true;
  if (!preserveAttempt) runtimeAutoRestartAttempt = 0;
  runtimeReady = false;
  pushDesktopRuntimeState({
    phase: 'restarting',
    healthy: false,
    detail: String(reason || 'Restarting desktop runtime.'),
    restartScheduled: false,
    nextRestartAt: '',
    lastError: String(options.lastError || ''),
    autoRestartAttempt: runtimeAutoRestartAttempt,
  });
  await stopRuntime();
  await startRuntime({
    reason: String(reason || '').trim() || 'restart',
    preserveAttempt,
  });
}

function queueRuntimeRestart(reason, options = {}) {
  clearQueuedRuntimeRestartTimer();
  clearRuntimeAutoRestartTimer();
  const preserveAttempt = options.preserveAttempt === true;
  const detail = String(reason || 'Restarting desktop runtime.').trim() || 'Restarting desktop runtime.';
  const requestedDelay = Number(options.deferMs);
  const deferMs = Number.isFinite(requestedDelay)
    ? Math.max(0, Math.min(5000, requestedDelay))
    : MANUAL_RUNTIME_RESTART_DEFER_MS;
  const restartScheduled = deferMs > 0;
  const nextRestartAt = restartScheduled ? new Date(Date.now() + deferMs).toISOString() : '';
  pushDesktopRuntimeState({
    phase: 'restarting',
    healthy: false,
    detail,
    restartScheduled,
    nextRestartAt,
    lastError: String(options.lastError || ''),
    autoRestartAttempt: preserveAttempt ? runtimeAutoRestartAttempt : 0,
  });
  queuedRuntimeRestartTimer = setTimeout(() => {
    queuedRuntimeRestartTimer = null;
    void triggerRuntimeRestart(detail, options).catch((error) => void handleRuntimeFailure(error));
  }, deferMs);
  return buildDesktopRuntimeSnapshot({
    phase: 'restarting',
    healthy: false,
    detail,
    restartScheduled,
    nextRestartAt,
    lastError: String(options.lastError || ''),
    autoRestartAttempt: preserveAttempt ? runtimeAutoRestartAttempt : 0,
  });
}

async function handleRuntimeFailure(error) {
  const errorMessage = String(error?.message || error || 'Desktop runtime failed');
  await appendMainLog(`Runtime failure: ${errorMessage}`);
  runtimeReady = false;
  clearQueuedRuntimeRestartTimer();
  const nextAttempt = runtimeAutoRestartAttempt + 1;

  if (nextAttempt <= DESKTOP_AUTO_RESTART_DELAYS_MS.length) {
    runtimeAutoRestartAttempt = nextAttempt;
    const delayMs = restartDelayMs(nextAttempt);
    const seconds = Math.max(1, Math.ceil(delayMs / 1000));
    const detail = `${errorMessage} Restarting desktop services in ${seconds}s.`;
    const nextRestartAt = new Date(Date.now() + delayMs).toISOString();
    createBootstrapWindow();
    if (!mainWindow || mainWindow.isDestroyed()) {
      setBootstrapMode('starting', {
        title: 'Recovering desktop runtime',
        detail,
        steps: [
          { label: 'Restart backend', status: 'active' },
          { label: 'Restart gateway', status: 'pending' },
          { label: 'Reconnect workspace', status: 'pending' },
        ],
        error: '',
        logs: currentLogs(),
      });
    }
    pushDesktopRuntimeState({
      phase: 'restarting',
      healthy: false,
      detail,
      restartScheduled: true,
      nextRestartAt,
      lastError: errorMessage,
      autoRestartAttempt: nextAttempt,
    });
    clearRuntimeAutoRestartTimer();
    runtimeAutoRestartTimer = setTimeout(() => {
      void triggerRuntimeRestart(`Automatic recovery attempt ${nextAttempt}`, {
        preserveAttempt: true,
        lastError: errorMessage,
      }).catch((restartError) => void handleRuntimeFailure(restartError));
    }, delayMs);
    return;
  }

  await showRuntimeFailureState(errorMessage);
}

function sameOrigin(url) {
  try {
    return new URL(url).origin === new URL(resolveRuntimeUrls().backendBaseUrl).origin;
  } catch (_error) {
    return false;
  }
}

function attachWindowSecurity(windowRef) {
  windowRef.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?:|mailto:)/i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  windowRef.webContents.on('will-navigate', (event, url) => {
    if (sameOrigin(url)) return;
    if (/^(https?:|mailto:)/i.test(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
}

async function createMainWindow() {
  const expectedProfileId = normalizeDesktopRuntimeProfileId(runtimePaths?.runtimeProfileId || desktopState.currentRuntimeProfileId);
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.__utsRuntimeProfileId === expectedProfileId) {
      await mainWindow.loadURL(resolveRuntimeUrls().appUrl);
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
      broadcastDesktopRuntimeState();
      return mainWindow;
    }
    createBootstrapWindow();
    const staleWindow = mainWindow;
    mainWindow = null;
    staleWindow.destroy();
  }

  mainWindow = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1200,
    minHeight: 800,
    show: false,
    title: 'UP TO SPEED',
    backgroundColor: '#25242a',
    webPreferences: {
      preload: MAIN_PRELOAD,
      partition: runtimePartitionForProfile(expectedProfileId),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.__utsRuntimeProfileId = expectedProfileId;

  attachWindowSecurity(mainWindow);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(resolveRuntimeUrls().appUrl);
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    bootstrapWindow?.close();
    broadcastDesktopRuntimeState();
  });
  return mainWindow;
}

async function startRuntime(options = {}) {
  if (!runtimePaths) throw new Error('Runtime paths are not initialized');
  if (runtime) return;
  const preserveAttempt = options.preserveAttempt === true;
  const restartReason = String(options.reason || '').trim();
  if (!preserveAttempt) runtimeAutoRestartAttempt = 0;
  clearRuntimeAutoRestartTimer();

  createBootstrapWindow();
  await refreshRuntimeProfiles();
  await mkdir(runtimePaths.dataDir, { recursive: true });
  await mkdir(runtimePaths.logsDir, { recursive: true });
  await mkdir(runtimePaths.mcpProfileDir, { recursive: true });
  runtimeReady = false;
  pushDesktopRuntimeState({
    phase: restartReason ? 'restarting' : 'starting',
    healthy: false,
    detail: restartReason
      ? `Restarting desktop runtime${restartReason ? `: ${restartReason}` : ''}.`
      : 'Initializing local desktop services.',
    restartScheduled: false,
    nextRestartAt: '',
    lastError: '',
    autoRestartAttempt: runtimeAutoRestartAttempt,
  });

  const gatewayToken = makeRandomToken();
  const backendUrl = resolveRuntimeUrls().backendBaseUrl;
  const logBuffers = {
    backend: [],
    gateway: [],
    main: [],
  };

  runtime = {
    stopping: false,
    gatewayToken,
    logBuffers,
    backend: null,
    gateway: null,
  };

  updateBootstrapSteps(
    [
      { label: 'Reserve local ports', status: 'done' },
      { label: 'Start backend', status: 'active' },
      { label: 'Start gateway', status: 'pending' },
      { label: 'Open workspace', status: 'pending' },
    ],
    'Starting the Python backend on localhost.',
  );

  const backendCommand = buildBackendCommand(runtimePaths);
  const backendEnv = {
    HOST: DEFAULT_HOST,
    PORT: String(reservedPorts.backendPort),
    UTS_APP_ROOT: runtimePaths.appRoot,
    UTS_DATA_DIR: runtimePaths.dataDir,
    UTS_CONFIG_DIR: runtimePaths.configDir,
    UTS_AGENT_GATEWAY_HOST: DEFAULT_HOST,
    UTS_AGENT_GATEWAY_PORT: String(reservedPorts.gatewayPort),
    UTS_AGENT_GATEWAY_TOKEN: gatewayToken,
    UTS_AGENT_RUNTIME_LAUNCHER_COMMAND: DESKTOP_LAUNCHER_LABEL,
    UTS_DESKTOP_RUNTIME_PROFILE_ID: runtimePaths.runtimeProfileId,
  };

  runtime.backend = spawnManagedChild('backend', backendCommand, {
    cwd: runtimePaths.appRoot,
    env: backendEnv,
  });
  await wireChildLogging(runtime.backend, 'backend');

  await waitForJsonHealth(`${backendUrl}api/local/health`, {
    timeoutMs: STARTUP_TIMEOUT_MS,
    validate: (status, payload) => status === 200 && payload?.ok === true,
  });
  await waitForJsonHealth(`${backendUrl}api/shotgrid/health`, {
    timeoutMs: STARTUP_TIMEOUT_MS,
    validate: (status, payload) => status === 200 && typeof payload === 'object',
  });

  updateBootstrapSteps(
    [
      { label: 'Reserve local ports', status: 'done' },
      { label: 'Start backend', status: 'done' },
      { label: 'Start gateway', status: 'active' },
      { label: 'Open workspace', status: 'pending' },
    ],
    'Starting the agent gateway with CDP attached to this Electron window.',
  );

  const gatewayCommand = buildGatewayCommand(runtimePaths, { execPath: process.execPath });
  runtime.gateway = spawnManagedChild('gateway', gatewayCommand, {
    cwd: path.dirname(path.dirname(runtimePaths.gatewayEntry)),
    env: {
      ...gatewayCommand.env,
      UTS_AGENT_GATEWAY_HOST: DEFAULT_HOST,
      UTS_AGENT_GATEWAY_PORT: String(reservedPorts.gatewayPort),
      UTS_AGENT_GATEWAY_TOKEN: gatewayToken,
      UTS_MCP_SESSION_MODE: 'cdp',
      UTS_MCP_REQUIRE_CDP: '1',
      UTS_MCP_CDP_URL: `http://${DEFAULT_HOST}:${reservedPorts.cdpPort}`,
      UTS_MCP_BASE_URL: resolveRuntimeUrls().mcpBaseUrl,
      UTS_MCP_PROFILE_DIR: runtimePaths.mcpProfileDir,
    },
  });
  await wireChildLogging(runtime.gateway, 'gateway');

  await waitForJsonHealth(`${backendUrl}api/agents/health`, {
    timeoutMs: STARTUP_TIMEOUT_MS,
    validate: runtimeHealthValidate,
  });

  updateBootstrapSteps(
    [
      { label: 'Reserve local ports', status: 'done' },
      { label: 'Start backend', status: 'done' },
      { label: 'Start gateway', status: 'done' },
      { label: 'Open workspace', status: 'active' },
    ],
    'Loading the desktop workspace.',
  );

  await createMainWindow();
  runtimeReady = true;
  runtimeAutoRestartAttempt = 0;
  await refreshRuntimeProfiles();
  pushDesktopRuntimeState({
    phase: 'healthy',
    healthy: true,
    detail: 'Desktop runtime is healthy and connected.',
    restartScheduled: false,
    nextRestartAt: '',
    lastError: '',
    autoRestartAttempt: 0,
    lastRestartAt: nowIso(),
  });

  updateBootstrapSteps(
    [
      { label: 'Reserve local ports', status: 'done' },
      { label: 'Start backend', status: 'done' },
      { label: 'Start gateway', status: 'done' },
      { label: 'Open workspace', status: 'done' },
    ],
    'Workspace ready.',
  );
}

function currentMigrationPolicy() {
  return normalizeDesktopMigrationPolicy(
    desktopState.migrationPolicy,
    DEFAULT_DESKTOP_MIGRATION_POLICY,
  );
}

async function maybePromptForLegacyImport() {
  const existingDbPath = path.join(runtimePaths.dataDir, '.local_sync_broker.sqlite3');
  const hasExistingRuntime = await access(existingDbPath).then(() => true).catch(() => false);
  const policy = currentMigrationPolicy();
  if (hasExistingRuntime) return 'skip';
  if (policy === 'import_last' && String(desktopState.lastImportSource || '').trim()) {
    const imported = await runImportFlow(String(desktopState.lastImportSource || '').trim());
    return imported ? 'imported' : 'skip';
  }
  if (policy !== 'prompt' || desktopState.migrationPromptSeen) return 'skip';
  createBootstrapWindow();
  setBootstrapMode('import-prompt', {
    title: 'Import an existing workspace?',
    detail: 'Choose an old repo folder to bring over your local broker DB, cache, and managed SQLCipher key before desktop startup.',
    message: '',
    error: '',
  });
  return 'prompt';
}

async function markMigrationSeen(extra = {}) {
  desktopState = await writeDesktopState(runtimePaths.statePath, {
    ...desktopState,
    migrationPromptSeen: true,
    currentRuntimeProfileId: runtimePaths.runtimeProfileId,
    migrationPolicy: currentMigrationPolicy(),
    ...extra,
  });
  pushDesktopRuntimeState();
}

async function runImportFlow(selectedDir = '') {
  let sourceDir = selectedDir;
  if (!sourceDir) {
    const choice = await dialog.showOpenDialog(createBootstrapWindow(), {
      title: 'Select legacy UP TO SPEED repo folder',
      properties: ['openDirectory'],
    });
    if (choice.canceled || choice.filePaths.length === 0) return false;
    sourceDir = choice.filePaths[0];
  }

  setBootstrapMode('starting', {
    title: 'Importing existing desktop data',
    detail: `Copying runtime files from ${sourceDir}`,
    steps: [
      { label: 'Stop active runtime', status: 'done' },
      { label: 'Copy legacy files', status: 'active' },
      { label: 'Restart desktop services', status: 'pending' },
    ],
    error: '',
    message: '',
  });

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.hide();
  }
  await stopRuntime();

  const result = await importLegacyRuntimeData(sourceDir, runtimePaths.dataDir, { platform: process.platform });
  if (result.copied.length === 0) {
    setBootstrapMode('import-prompt', {
      title: 'Import an existing workspace?',
      detail: 'No importable runtime files were found in that folder.',
      message: `Checked ${sourceDir} for broker and cache files.`,
      error: '',
    });
    return false;
  }

  await markMigrationSeen({
    lastImportAt: nowIso(),
    lastImportSource: sourceDir,
  });
  await appendMainLog(`Imported legacy runtime data from ${sourceDir}`);
  await refreshRuntimeProfiles();
  return true;
}

async function continueFromPrompt() {
  await markMigrationSeen({ migrationSkippedAt: nowIso() });
  await startRuntime();
}

async function persistDesktopRuntimeState(extra = {}) {
  desktopState = await writeDesktopState(runtimePaths.statePath, {
    ...desktopState,
    currentRuntimeProfileId: runtimePaths.runtimeProfileId,
    migrationPolicy: currentMigrationPolicy(),
    ...extra,
  });
  await refreshRuntimeProfiles();
  pushDesktopRuntimeState();
  return desktopState;
}

async function readRuntimeLogFile(kind) {
  try {
    const filePath = kind === 'desktop'
      ? path.join(runtimePaths.logsDir, 'desktop.log')
      : childLogFile(kind);
    const raw = await readFile(filePath, 'utf8');
    return truncateLogs(String(raw || '').split(/\r?\n/).filter(Boolean), 200);
  } catch (_error) {
    return [];
  }
}

async function readDesktopRuntimeLogs() {
  const [desktopLines, backendLines, gatewayLines] = await Promise.all([
    readRuntimeLogFile('desktop'),
    readRuntimeLogFile('backend'),
    readRuntimeLogFile('gateway'),
  ]);
  return {
    desktop: desktopLines,
    backend: backendLines,
    gateway: gatewayLines,
    combined: truncateLogs([...desktopLines, ...backendLines, ...gatewayLines], 240),
  };
}

async function setDesktopRuntimeProfile(profileId) {
  const nextProfileId = normalizeDesktopRuntimeProfileId(profileId);
  if (nextProfileId === runtimePaths.runtimeProfileId) {
    await refreshRuntimeProfiles();
    return buildDesktopRuntimeSnapshot();
  }
  await persistDesktopRuntimeState({ currentRuntimeProfileId: nextProfileId });
  runtimePaths = resolveDesktopRuntimePaths({
    repoRoot: REPO_ROOT,
    userDataDir: app.getPath('userData'),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    platform: process.platform,
    runtimeProfileId: nextProfileId,
  });
  pushDesktopRuntimeState({ profileId: nextProfileId });
  return queueRuntimeRestart(`Switching runtime profile to ${nextProfileId}`, {
    deferMs: MANUAL_RUNTIME_RESTART_DEFER_MS,
  });
}

async function setDesktopMigrationPolicy(policy) {
  const nextPolicy = normalizeDesktopMigrationPolicy(policy);
  await persistDesktopRuntimeState({ migrationPolicy: nextPolicy });
  pushDesktopRuntimeState({ migrationPolicy: nextPolicy });
  return buildDesktopRuntimeSnapshot();
}

function createApplicationMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'Import Existing Repo Data...',
          click: () => {
            createBootstrapWindow();
            void runImportFlow().then(async (imported) => {
              if (imported) await startRuntime();
            }).catch((error) => void handleRuntimeFailure(error));
          },
        },
        {
          type: 'separator',
        },
        {
          role: 'quit',
        },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open Logs Folder',
          click: () => {
            void shell.openPath(runtimePaths.logsDir);
          },
        },
        {
          label: 'Open Runtime Data Folder',
          click: () => {
            void shell.openPath(runtimePaths.dataDir);
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('desktop:get-bootstrap-state', async () => bootstrapState);
ipcMain.handle('desktop:get-runtime-state', async () => {
  await refreshRuntimeProfiles();
  return buildDesktopRuntimeSnapshot();
});
ipcMain.handle('desktop:continue-without-import', async () => {
  try {
    await continueFromPrompt();
    return { ok: true };
  } catch (error) {
    await handleRuntimeFailure(error);
    return { ok: false, error: String(error?.message || error) };
  }
});
ipcMain.handle('desktop:import-legacy', async () => {
  try {
    const imported = await runImportFlow();
    if (imported) await startRuntime();
    return { ok: imported };
  } catch (error) {
    await handleRuntimeFailure(error);
    return { ok: false, error: String(error?.message || error) };
  }
});
ipcMain.handle('desktop:retry-launch', async () => {
  try {
    return {
      ok: true,
      runtime: queueRuntimeRestart('Manual retry requested from the desktop shell.', {
        deferMs: MANUAL_RUNTIME_RESTART_DEFER_MS,
      }),
    };
  } catch (error) {
    await handleRuntimeFailure(error);
    return { ok: false, error: String(error?.message || error) };
  }
});
ipcMain.handle('desktop:restart-runtime', async (_event, options = {}) => {
  try {
    const reason = String(options?.reason || 'Manual restart requested from the workspace.').trim();
    return {
      ok: true,
      runtime: queueRuntimeRestart(reason, {
        deferMs: MANUAL_RUNTIME_RESTART_DEFER_MS,
      }),
    };
  } catch (error) {
    await handleRuntimeFailure(error);
    return { ok: false, error: String(error?.message || error) };
  }
});
ipcMain.handle('desktop:get-runtime-logs', async () => {
  const logs = await readDesktopRuntimeLogs();
  return { ok: true, logs };
});
ipcMain.handle('desktop:set-runtime-profile', async (_event, payload = {}) => {
  try {
    const runtime = await setDesktopRuntimeProfile(payload?.profileId || payload?.profile_id);
    return { ok: true, runtime };
  } catch (error) {
    await handleRuntimeFailure(error);
    return { ok: false, error: String(error?.message || error) };
  }
});
ipcMain.handle('desktop:set-migration-policy', async (_event, payload = {}) => {
  try {
    const runtime = await setDesktopMigrationPolicy(payload?.policy);
    return { ok: true, runtime };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
});
ipcMain.handle('desktop:open-logs-dir', async () => {
  await shell.openPath(runtimePaths.logsDir);
  return { ok: true };
});
ipcMain.handle('desktop:open-runtime-dir', async () => {
  await shell.openPath(runtimePaths.dataDir);
  return { ok: true };
});
ipcMain.handle('desktop:quit', async () => {
  app.quit();
  return { ok: true };
});

app.on('before-quit', () => {
  if (runtime) runtime.stopping = true;
  clearQueuedRuntimeRestartTimer();
  clearRuntimeAutoRestartTimer();
});

app.on('window-all-closed', () => {
  app.quit();
});

async function initializeDesktopApp() {
  const initialPaths = resolveDesktopRuntimePaths({
    repoRoot: REPO_ROOT,
    userDataDir: app.getPath('userData'),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    platform: process.platform,
  });
  desktopState = await readDesktopState(initialPaths.statePath);
  runtimePaths = resolveDesktopRuntimePaths({
    repoRoot: REPO_ROOT,
    userDataDir: app.getPath('userData'),
    resourcesPath: process.resourcesPath,
    isPackaged: app.isPackaged,
    platform: process.platform,
    runtimeProfileId: desktopState.currentRuntimeProfileId || DEFAULT_DESKTOP_RUNTIME_PROFILE_ID,
  });
  await refreshRuntimeProfiles();
  createBootstrapWindow();
  void announcePlaywrightDevToolsEndpoint();
  createApplicationMenu();
  pushDesktopRuntimeState({
    phase: 'starting',
    healthy: false,
    detail: 'Preparing desktop runtime.',
  });
  await appendMainLog('Desktop app initialized.');

  const importState = await maybePromptForLegacyImport();
  if (importState === 'imported' || importState === 'skip') {
    await startRuntime().catch((error) => handleRuntimeFailure(error));
  }
}

void app.whenReady()
  .then(() => initializeDesktopApp())
  .catch((error) => {
    console.error(error);
  });
