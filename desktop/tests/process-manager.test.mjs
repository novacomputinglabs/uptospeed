import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import {
  DEFAULT_DESKTOP_MIGRATION_POLICY,
  DEFAULT_DESKTOP_RUNTIME_PROFILE_ID,
  LEGACY_MANAGED_KEY_FILENAME,
  buildBackendCommand,
  buildLegacyImportPlan,
  buildLegacyManagedKeyCandidates,
  importLegacyRuntimeData,
  listDesktopRuntimeProfiles,
  normalizeDesktopMigrationPolicy,
  normalizeDesktopRuntimeProfileId,
  resolveDesktopRuntimePaths,
  writeDesktopState,
  readDesktopState,
} from '../src/process-manager.mjs';

test('resolveDesktopRuntimePaths separates app root from user data in packaged mode', () => {
  const runtimePaths = resolveDesktopRuntimePaths({
    repoRoot: '/repo',
    userDataDir: '/user/data',
    resourcesPath: '/resources',
    isPackaged: true,
    platform: 'darwin',
    runtimeProfileId: 'Show A',
  });

  assert.equal(runtimePaths.appRoot, '/resources/app-root');
  assert.equal(runtimePaths.runtimeProfileId, 'show-a');
  assert.equal(runtimePaths.dataDir, '/user/data/profiles/show-a/runtime');
  assert.equal(runtimePaths.configDir, '/user/data/profiles/show-a/runtime');
  assert.equal(runtimePaths.backendExecutable, '/resources/backend/shotgrid_server');
  assert.equal(runtimePaths.gatewayEntry, '/resources/mcp/src/agent-gateway.mjs');
});

test('desktop runtime profile ids and migration policies are normalized', () => {
  assert.equal(normalizeDesktopRuntimeProfileId('  Show Alpha / 01  '), 'show-alpha-01');
  assert.equal(normalizeDesktopRuntimeProfileId(''), DEFAULT_DESKTOP_RUNTIME_PROFILE_ID);
  assert.equal(normalizeDesktopMigrationPolicy('IMPORT_LAST'), 'import_last');
  assert.equal(normalizeDesktopMigrationPolicy('unsupported'), DEFAULT_DESKTOP_MIGRATION_POLICY);
});

test('buildBackendCommand uses packaged executable and dev python fallback', () => {
  const packaged = buildBackendCommand({
    isPackaged: true,
    backendExecutable: '/resources/backend/shotgrid_server.exe',
  }, {
    env: {},
  });
  assert.deepEqual(packaged, {
    command: '/resources/backend/shotgrid_server.exe',
    args: [],
  });

  const dev = buildBackendCommand({
    isPackaged: false,
    repoRoot: '/repo',
  }, {
    platform: 'linux',
    env: {},
  });
  assert.equal(dev.command, 'python3');
  assert.deepEqual(dev.args, ['/repo/server/shotgrid_server.py']);
});

test('legacy key candidates prefer env overrides before platform defaults', () => {
  const candidates = buildLegacyManagedKeyCandidates('/repo', {
    LOCAL_BROKER_MANAGED_KEY_FILE: '.secrets/custom.key',
    LOCAL_BROKER_MANAGED_KEY_DIR: '.secrets/managed',
  }, {
    platform: 'linux',
    homeDir: '/home/tester',
  });

  assert.equal(candidates[0], '/repo/.secrets/custom.key');
  assert.equal(candidates[1], '/repo/.secrets/managed/local_broker.key');
  assert.ok(candidates.includes('/repo/local_broker.key'));
  assert.ok(candidates.includes('/home/tester/.config/uptospeed/local_broker.key'));
});

test('legacy import plan includes broker files and managed key', async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'uts-legacy-source-'));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'uts-runtime-data-'));

  try {
    await writeFile(path.join(sourceDir, '.local_sync_broker.sqlite3'), 'db');
    await writeFile(path.join(sourceDir, '.shotgrid_cache.json'), '{}');
    await writeFile(path.join(sourceDir, '.env.local'), 'LOCAL_BROKER_MANAGED_KEY_FILE=.secrets/key.txt\n', 'utf8');
    await mkdir(path.join(sourceDir, '.secrets'), { recursive: true });
    await writeFile(path.join(sourceDir, '.secrets', 'key.txt'), 'secret', 'utf8');

    const plan = await buildLegacyImportPlan(sourceDir, dataDir, { platform: 'linux' });
    assert.equal(plan.entries.length, 3);
    assert.ok(plan.entries.some((entry) => entry.name === '.local_sync_broker.sqlite3'));
    assert.ok(plan.entries.some((entry) => entry.name === '.shotgrid_cache.json'));
    assert.ok(plan.entries.some((entry) => entry.kind === 'managed_key'));
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('importLegacyRuntimeData copies runtime files into desktop data dir', async () => {
  const sourceDir = await mkdtemp(path.join(os.tmpdir(), 'uts-import-source-'));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'uts-import-target-'));

  try {
    await writeFile(path.join(sourceDir, '.local_sync_broker.sqlite3'), 'db', 'utf8');
    await writeFile(path.join(sourceDir, '.shotgrid_cache.json'), '{"ok":true}', 'utf8');
    await writeFile(path.join(sourceDir, LEGACY_MANAGED_KEY_FILENAME), 'desktop-key', 'utf8');

    const result = await importLegacyRuntimeData(sourceDir, dataDir, { platform: 'linux' });

    assert.equal(result.copied.length, 3);
    assert.equal(
      await readFile(path.join(dataDir, '.local_sync_broker.sqlite3'), 'utf8'),
      'db',
    );
    assert.equal(
      await readFile(path.join(dataDir, LEGACY_MANAGED_KEY_FILENAME), 'utf8'),
      'desktop-key',
    );
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('desktop state persists migration markers', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'uts-desktop-state-'));
  const statePath = path.join(tempDir, 'desktop-state.json');
  try {
    await writeDesktopState(statePath, {
      migrationPromptSeen: true,
      lastImportSource: '/repo',
      currentRuntimeProfileId: 'Show Beta',
      migrationPolicy: 'prompt',
    });
    const state = await readDesktopState(statePath);
    assert.equal(state.migrationPromptSeen, true);
    assert.equal(state.lastImportSource, '/repo');
    assert.equal(state.currentRuntimeProfileId, 'show-beta');
    assert.equal(state.migrationPolicy, 'prompt');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('listDesktopRuntimeProfiles returns normalized profile ids', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'uts-desktop-profiles-'));
  try {
    await mkdir(path.join(tempDir, 'profiles', 'Show_A'), { recursive: true });
    await mkdir(path.join(tempDir, 'profiles', 'show-b'), { recursive: true });
    const profiles = await listDesktopRuntimeProfiles(tempDir);
    assert.deepEqual(profiles, ['default', 'show_a', 'show-b']);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
