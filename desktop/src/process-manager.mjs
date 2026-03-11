import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';

export const DEFAULT_HOST = '127.0.0.1';
export const LEGACY_RUNTIME_FILE_NAMES = [
  '.local_sync_broker.sqlite3',
  '.local_sync_broker.sqlite3-shm',
  '.local_sync_broker.sqlite3-wal',
  '.shotgrid_cache.json',
];
export const LEGACY_MANAGED_KEY_FILENAME = 'local_broker.key';
export const DESKTOP_STATE_VERSION = 1;
export const DEFAULT_DESKTOP_RUNTIME_PROFILE_ID = 'default';
export const DEFAULT_DESKTOP_MIGRATION_POLICY = 'skip';
const DESKTOP_MIGRATION_POLICIES = new Set(['skip', 'prompt', 'import_last']);

export function normalizeDesktopRuntimeProfileId(value, fallback = DEFAULT_DESKTOP_RUNTIME_PROFILE_ID) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return normalized || fallback;
}

export function normalizeDesktopMigrationPolicy(value, fallback = DEFAULT_DESKTOP_MIGRATION_POLICY) {
  const normalized = String(value || '').trim().toLowerCase();
  return DESKTOP_MIGRATION_POLICIES.has(normalized) ? normalized : fallback;
}

export async function listDesktopRuntimeProfiles(userDataDir) {
  const profilesRoot = path.join(userDataDir, 'profiles');
  const discovered = new Set([DEFAULT_DESKTOP_RUNTIME_PROFILE_ID]);
  try {
    const entries = await readdir(profilesRoot, { withFileTypes: true });
    entries.forEach((entry) => {
      if (!entry?.isDirectory?.()) return;
      discovered.add(normalizeDesktopRuntimeProfileId(entry.name));
    });
  } catch (_error) {
    // No profiles have been created yet.
  }
  return [...discovered].sort((left, right) => {
    if (left === DEFAULT_DESKTOP_RUNTIME_PROFILE_ID) return -1;
    if (right === DEFAULT_DESKTOP_RUNTIME_PROFILE_ID) return 1;
    return left.localeCompare(right);
  });
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch (_error) {
    return false;
  }
}

export async function reserveFreePort(host = DEFAULT_HOST) {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

export async function reserveRuntimePorts(host = DEFAULT_HOST) {
  const backendPort = await reserveFreePort(host);
  const gatewayPort = await reserveFreePort(host);
  const cdpPort = await reserveFreePort(host);
  return { host, backendPort, gatewayPort, cdpPort };
}

export async function waitForJsonHealth(url, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 60000));
  const intervalMs = Math.max(100, Number(options.intervalMs || 500));
  const validate = typeof options.validate === 'function'
    ? options.validate
    : ((status) => status === 200);
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  let lastStatus = null;
  let lastPayload = null;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      lastStatus = res.status;
      const text = await res.text();
      try {
        lastPayload = text ? JSON.parse(text) : null;
      } catch (_error) {
        lastPayload = text || null;
      }
      if (validate(lastStatus, lastPayload)) {
        return { status: lastStatus, payload: lastPayload };
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  const parts = [`Health check timed out for ${url}`];
  if (lastStatus !== null) parts.push(`status=${lastStatus}`);
  if (lastPayload !== null) parts.push(`payload=${JSON.stringify(lastPayload)}`);
  if (lastError) parts.push(`error=${String(lastError.message || lastError)}`);
  throw new Error(parts.join(' '));
}

export function defaultPythonCommand(platform = process.platform) {
  return platform === 'win32' ? 'python' : 'python3';
}

export function resolveDesktopRuntimePaths(options) {
  const {
    repoRoot,
    userDataDir,
    resourcesPath,
    isPackaged,
    platform = process.platform,
    runtimeProfileId = DEFAULT_DESKTOP_RUNTIME_PROFILE_ID,
  } = options;

  if (!repoRoot) throw new Error('repoRoot is required');
  if (!userDataDir) throw new Error('userDataDir is required');
  if (!resourcesPath) throw new Error('resourcesPath is required');

  const profileId = normalizeDesktopRuntimeProfileId(runtimeProfileId);
  const profilesRoot = path.join(userDataDir, 'profiles');
  const profileRoot = path.join(profilesRoot, profileId);
  const runtimeDir = path.join(profileRoot, 'runtime');
  const logsDir = path.join(profileRoot, 'logs');
  const statePath = path.join(userDataDir, 'desktop-state.json');
  const mcpProfileDir = path.join(profileRoot, 'mcp-profile');
  const appRoot = isPackaged ? path.join(resourcesPath, 'app-root') : repoRoot;
  const backendExecutableName = platform === 'win32' ? 'shotgrid_server.exe' : 'shotgrid_server';
  const backendExecutable = isPackaged ? path.join(resourcesPath, 'backend', backendExecutableName) : '';
  const gatewayEntry = isPackaged
    ? path.join(resourcesPath, 'mcp', 'src', 'agent-gateway.mjs')
    : path.join(repoRoot, 'mcp', 'src', 'agent-gateway.mjs');

  return {
    repoRoot,
    userDataDir,
    resourcesPath,
    isPackaged: Boolean(isPackaged),
    runtimeProfileId: profileId,
    profilesRoot,
    profileRoot,
    appRoot,
    dataDir: runtimeDir,
    configDir: runtimeDir,
    logsDir,
    statePath,
    mcpProfileDir,
    backendExecutable,
    gatewayEntry,
  };
}

export function buildBackendCommand(runtimePaths, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (runtimePaths.isPackaged) {
    const explicitExecutable = String(env.UTS_DESKTOP_BACKEND_EXECUTABLE || '').trim();
    return {
      command: explicitExecutable || runtimePaths.backendExecutable,
      args: [],
    };
  }

  const explicitPython = String(env.UTS_DESKTOP_PYTHON || '').trim();
  return {
    command: explicitPython || defaultPythonCommand(platform),
    args: [path.join(runtimePaths.repoRoot, 'server', 'shotgrid_server.py')],
  };
}

export function buildGatewayCommand(runtimePaths, options = {}) {
  const execPath = options.execPath || process.execPath;
  return {
    command: execPath,
    args: [runtimePaths.gatewayEntry],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
    },
  };
}

function parseDotenv(text) {
  const parsed = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [key, ...rest] = line.split('=');
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) continue;
    parsed[normalizedKey] = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
  }
  return parsed;
}

async function readLegacyEnvConfig(sourceDir) {
  const merged = {};
  for (const fileName of ['.env', '.env.local']) {
    const filePath = path.join(sourceDir, fileName);
    if (!(await pathExists(filePath))) continue;
    Object.assign(merged, parseDotenv(await readFile(filePath, 'utf8')));
  }
  return merged;
}

function legacyDefaultManagedKeyDir(platform = process.platform, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const appData = options.appData || process.env.APPDATA || '';
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'UP_TO_SPEED');
  }
  if (platform === 'win32') {
    return appData
      ? path.join(appData, 'UP_TO_SPEED')
      : path.join(homeDir, 'AppData', 'Roaming', 'UP_TO_SPEED');
  }
  return path.join(homeDir, '.config', 'uptospeed');
}

function resolveLegacyPath(rawValue, sourceDir) {
  const expanded = String(rawValue || '').trim().replace(/^~(?=$|[\\/])/, os.homedir());
  if (!expanded) return '';
  return path.isAbsolute(expanded) ? expanded : path.resolve(sourceDir, expanded);
}

export function buildLegacyManagedKeyCandidates(sourceDir, envConfig = {}, options = {}) {
  const candidates = [];
  const managedKeyFile = resolveLegacyPath(envConfig.LOCAL_BROKER_MANAGED_KEY_FILE, sourceDir);
  if (managedKeyFile) candidates.push(managedKeyFile);

  const managedKeyDir = resolveLegacyPath(envConfig.LOCAL_BROKER_MANAGED_KEY_DIR, sourceDir);
  if (managedKeyDir) candidates.push(path.join(managedKeyDir, LEGACY_MANAGED_KEY_FILENAME));

  const explicitKeyFile = resolveLegacyPath(envConfig.LOCAL_BROKER_ENCRYPTION_KEY_FILE, sourceDir);
  if (explicitKeyFile) candidates.push(explicitKeyFile);

  candidates.push(path.join(sourceDir, LEGACY_MANAGED_KEY_FILENAME));
  candidates.push(path.join(legacyDefaultManagedKeyDir(options.platform, options), LEGACY_MANAGED_KEY_FILENAME));

  return [...new Set(candidates.filter(Boolean))];
}

export async function buildLegacyImportPlan(sourceDir, dataDir, options = {}) {
  const envConfig = await readLegacyEnvConfig(sourceDir);
  const entries = [];

  for (const fileName of LEGACY_RUNTIME_FILE_NAMES) {
    const source = path.join(sourceDir, fileName);
    if (!(await pathExists(source))) continue;
    entries.push({
      kind: 'runtime',
      name: fileName,
      source,
      destination: path.join(dataDir, fileName),
    });
  }

  const keyCandidates = buildLegacyManagedKeyCandidates(sourceDir, envConfig, options);
  for (const candidate of keyCandidates) {
    if (!(await pathExists(candidate))) continue;
    entries.push({
      kind: 'managed_key',
      name: LEGACY_MANAGED_KEY_FILENAME,
      source: candidate,
      destination: path.join(dataDir, LEGACY_MANAGED_KEY_FILENAME),
    });
    break;
  }

  return { sourceDir, dataDir, envConfig, entries };
}

async function backupIfPresent(destination, backupDir) {
  if (!(await pathExists(destination))) return null;
  await mkdir(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, path.basename(destination));
  await rename(destination, backupPath);
  return backupPath;
}

export async function importLegacyRuntimeData(sourceDir, dataDir, options = {}) {
  const plan = await buildLegacyImportPlan(sourceDir, dataDir, options);
  if (plan.entries.length === 0) {
    return { plan, copied: [], backups: [] };
  }

  await mkdir(dataDir, { recursive: true });
  const backupDir = path.join(dataDir, 'import-backups', new Date().toISOString().replace(/[:.]/g, '-'));
  const copied = [];
  const backups = [];

  for (const entry of plan.entries) {
    const backedUp = await backupIfPresent(entry.destination, backupDir);
    if (backedUp) backups.push({ destination: entry.destination, backup: backedUp });
    await copyFile(entry.source, entry.destination);
    copied.push(entry);
  }

  return { plan, copied, backups };
}

export async function readDesktopState(statePath) {
  try {
    const raw = await readFile(statePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return {
      ...parsed,
      currentRuntimeProfileId: normalizeDesktopRuntimeProfileId(
        parsed.currentRuntimeProfileId || parsed.runtimeProfileId,
      ),
      migrationPolicy: normalizeDesktopMigrationPolicy(parsed.migrationPolicy),
    };
  } catch (_error) {
    return {
      currentRuntimeProfileId: DEFAULT_DESKTOP_RUNTIME_PROFILE_ID,
      migrationPolicy: DEFAULT_DESKTOP_MIGRATION_POLICY,
    };
  }
}

export async function writeDesktopState(statePath, state) {
  await mkdir(path.dirname(statePath), { recursive: true });
  const payload = {
    version: DESKTOP_STATE_VERSION,
    currentRuntimeProfileId: normalizeDesktopRuntimeProfileId(
      state?.currentRuntimeProfileId || state?.runtimeProfileId,
    ),
    migrationPolicy: normalizeDesktopMigrationPolicy(state?.migrationPolicy),
    ...state,
  };
  payload.currentRuntimeProfileId = normalizeDesktopRuntimeProfileId(payload.currentRuntimeProfileId);
  payload.migrationPolicy = normalizeDesktopMigrationPolicy(payload.migrationPolicy);
  await writeFile(statePath, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}
