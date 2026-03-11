import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startStaticServer } from './static-server.mjs';

const REQUIRED_API_METHODS = [
  'getState',
  'getStats',
  'getTasks',
  'getTask',
  'getFilteredTasks',
  'getEndeavors',
  'getEndeavor',
  'getEndeavorTasks',
  'getTaskNoteThreads',
  'getTaskNoteThread',
  'addTaskNote',
  'replyTaskNote',
  'getMilestones',
  'getMilestone',
  'createMilestone',
  'updateMilestone',
  'deleteMilestone',
  'getTaskDependencies',
  'addTaskDependency',
  'removeTaskDependency',
  'getTaskBlockers',
  'createTaskBlocker',
  'updateTaskBlocker',
  'deleteTaskBlocker',
  'setViewMode',
  'selectTask',
  'openTaskNotes',
  'getDesktopRuntime',
  'getDesktopRuntimeLogs',
  'restartDesktopRuntime',
  'setDesktopRuntimeProfile',
  'setDesktopMigrationPolicy',
  'setFilters',
  'clearFilters',
  'updateTask',
  'createTask',
  'deleteTask',
  'createEndeavor',
  'updateEndeavor',
  'deleteEndeavor',
  'addTasksToEndeavor',
  'removeTasksFromEndeavor',
  'clearEndeavor',
  'undo',
  'redo'
];

const SESSION_MODES = new Set(['auto', 'managed', 'cdp']);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_APP_URL = 'http://127.0.0.1:7331/index.html';
const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';

function parseBooleanEnv(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseIntEnv(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOptionalIntEnv(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseSessionMode(value, fallback = 'auto') {
  const normalized = String(value || '').trim().toLowerCase();
  return SESSION_MODES.has(normalized) ? normalized : fallback;
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

async function isUrlReachable(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    return res.ok || (res.status >= 200 && res.status < 500);
  } catch (_error) {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export function resolveSessionConfig(env = process.env) {
  const explicitBaseUrl = (env.UTS_MCP_BASE_URL || '').trim();
  const preferredBaseUrl = explicitBaseUrl || DEFAULT_APP_URL;

  return {
    sessionMode: parseSessionMode(env.UTS_MCP_SESSION_MODE, 'auto'),
    requireCdp: parseBooleanEnv(env.UTS_MCP_REQUIRE_CDP, false),
    cdpReusePage: parseBooleanEnv(env.UTS_MCP_CDP_REUSE_PAGE, true),
    cdpUrl: (env.UTS_MCP_CDP_URL || DEFAULT_CDP_URL).trim(),
    headless: parseBooleanEnv(env.UTS_MCP_HEADLESS, true),
    profileDir:
      env.UTS_MCP_PROFILE_DIR || path.join(os.homedir(), '.codex', 'uptospeed-mcp-profile'),
    navTimeoutMs: parseIntEnv(env.UTS_MCP_NAV_TIMEOUT_MS, 30000),
    toolTimeoutMs: parseIntEnv(env.UTS_MCP_TOOL_TIMEOUT_MS, 30000),
    shotgridRefreshCooldownMs: parseIntEnv(env.UTS_MCP_SHOTGRID_REFRESH_COOLDOWN_MS, 15000),
    bootstrapShotgridSync: parseBooleanEnv(env.UTS_MCP_BOOTSTRAP_SYNC, true),
    forcedShotgridProjectId: parseOptionalIntEnv(env.UTS_MCP_SHOTGRID_PROJECT_ID, null),
    explicitBaseUrl,
    preferredBaseUrl,
    repoRoot: env.UTS_MCP_REPO_ROOT || DEFAULT_REPO_ROOT
  };
}

async function waitForKanbanApi(page, timeoutMs) {
  await page.waitForFunction(
    (methods) => {
      const api = globalThis.ShotgridKanbanAPI;
      if (!api) return false;
      return methods.every((name) => typeof api[name] === 'function');
    },
    REQUIRED_API_METHODS,
    { timeout: timeoutMs }
  );
}

async function refreshShotGridOnBootstrap(page, timeoutMs, forcedProjectId = null) {
  return withTimeout(
    page.evaluate(async ({ forcedProjectIdValue }) => {
      if (typeof globalThis.isShotGridEnabled !== 'function') {
        return { attempted: false, reason: 'isShotGridEnabled unavailable' };
      }

      const maybeEnableShotGridFromServer = async () => {
        if (globalThis.isShotGridEnabled()) return false;

        const resolveAppSettings = () => {
          if (typeof globalThis.appSettings === 'object' && globalThis.appSettings) {
            return globalThis.appSettings;
          }
          try {
            const candidate = globalThis.eval?.('appSettings');
            if (candidate && typeof candidate === 'object') return candidate;
          } catch (_error) {
            // ignore
          }
          return null;
        };

        const appSettingsRef = resolveAppSettings();

        const explicitProjectId = Number(forcedProjectIdValue);
        if (
          Number.isFinite(explicitProjectId) &&
          explicitProjectId > 0 &&
          appSettingsRef
        ) {
          appSettingsRef.shotgridEnabled = true;
          appSettingsRef.shotgridProjectId = explicitProjectId;
          if (typeof globalThis.saveSettingsToStorage === 'function') {
            globalThis.saveSettingsToStorage();
          }
          if (typeof globalThis.updateShotGridUi === 'function') {
            globalThis.updateShotGridUi();
          }
          return true;
        }

        try {
          if (typeof globalThis.shotGridUrl !== 'function' || !appSettingsRef) return false;
          const res = await fetch(globalThis.shotGridUrl('/api/shotgrid/health'));
          const data = await res.json().catch(() => null);
          const configuredPolicy = (() => {
            const raw = String(appSettingsRef.shotgridAuthPolicy || '').trim().toLowerCase();
            if (raw === 'user_only' || raw === 'hybrid_explicit' || raw === 'script_only') {
              return raw;
            }
            return 'script_only';
          })();
          const fallbackAllowed = appSettingsRef.shotgridAllowScriptFallback === true;
          const effectivePolicy = configuredPolicy === 'script_only'
            ? 'script_only'
            : (fallbackAllowed ? 'hybrid_explicit' : 'user_only');
          const requiresUserAuth = effectivePolicy !== 'script_only';
          const hasUserAuth = data?.authenticated === true && data?.mode === 'user';
          const canUseServerAuth =
            res.ok &&
            data &&
            (requiresUserAuth
              ? hasUserAuth
              : (hasUserAuth || data.script_configured === true));
          if (!canUseServerAuth) return false;

          let projectId = Number(data?.project_id);
          let projectName = '';

          // If health does not advertise a default project, pick the first accessible one.
          if (!(Number.isFinite(projectId) && projectId > 0)) {
            try {
              const projectsRes = await fetch(globalThis.shotGridUrl('/api/shotgrid/projects'));
              const projectsData = await projectsRes.json().catch(() => null);
              const projects = Array.isArray(projectsData?.projects) ? projectsData.projects : [];
              const firstProject = projects.find((project) => {
                const id = Number(project?.id);
                return Number.isFinite(id) && id > 0;
              });
              if (firstProject) {
                projectId = Number(firstProject.id);
                projectName = typeof firstProject.name === 'string' ? firstProject.name : '';
              }
            } catch (_projectsError) {
              // ignore
            }
          }

          if (!(Number.isFinite(projectId) && projectId > 0)) return false;

          appSettingsRef.shotgridEnabled = true;
          appSettingsRef.shotgridProjectId = projectId;
          if (projectName) appSettingsRef.shotgridProjectName = projectName;
          if (typeof globalThis.saveSettingsToStorage === 'function') {
            globalThis.saveSettingsToStorage();
          }
          if (typeof globalThis.updateShotGridUi === 'function') {
            globalThis.updateShotGridUi();
          }
          return true;
        } catch (_error) {
          return false;
        }
      };

      await maybeEnableShotGridFromServer();

      if (!globalThis.isShotGridEnabled()) {
        return { attempted: false, reason: 'shotgrid disabled' };
      }

      try {
        if (typeof globalThis.mergeFromShotGrid === 'function') {
          const ok = await globalThis.mergeFromShotGrid({ background: true, force: true });
          return { attempted: true, ok: Boolean(ok), method: 'mergeFromShotGrid' };
        }
        if (typeof globalThis.syncFromShotGrid === 'function') {
          const ok = await globalThis.syncFromShotGrid({ skipConfirm: true, background: true, force: true });
          return { attempted: true, ok: Boolean(ok), method: 'syncFromShotGrid' };
        }
        return { attempted: false, reason: 'sync function unavailable' };
      } catch (error) {
        return {
          attempted: true,
          ok: false,
          error: String(error?.message || error),
          method: 'unknown'
        };
      }
    }, { forcedProjectIdValue: forcedProjectId }),
    timeoutMs,
    'bootstrap ShotGrid sync'
  );
}

async function runBootstrapSync(page, config) {
  if (!config.bootstrapShotgridSync) {
    return { attempted: false, reason: 'disabled by config' };
  }

  try {
    return await refreshShotGridOnBootstrap(page, config.navTimeoutMs, config.forcedShotgridProjectId);
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      error: String(error?.message || error),
      method: 'bootstrap'
    };
  }
}

async function navigateAndPreparePage(page, baseUrl, config) {
  await page.goto(baseUrl, {
    waitUntil: 'domcontentloaded',
    timeout: config.navTimeoutMs
  });
  await waitForKanbanApi(page, config.navTimeoutMs);
  return runBootstrapSync(page, config);
}

function pickContextForTarget(browser, targetUrl) {
  const contexts = browser.contexts();
  if (!contexts.length) return null;

  try {
    const targetOrigin = new URL(targetUrl).origin;
    for (const ctx of contexts) {
      for (const pg of ctx.pages()) {
        if (typeof pg.url === 'function' && pg.url().startsWith(targetOrigin)) {
          return ctx;
        }
      }
    }
  } catch (_error) {
    // ignore and fall back
  }

  return contexts[0] || null;
}

function pickPageForTarget(context, targetUrl) {
  const pages = context.pages();
  if (!pages.length) return null;

  try {
    const targetOrigin = new URL(targetUrl).origin;
    for (const page of pages) {
      if (typeof page.url === 'function' && page.url().startsWith(targetOrigin)) {
        return page;
      }
    }
  } catch (_error) {
    // ignore and fall back
  }

  return pages[0] || null;
}

async function tryCreateCdpSession(config) {
  const browser = await chromium.connectOverCDP(config.cdpUrl, {
    timeout: config.navTimeoutMs
  });

  const context = pickContextForTarget(browser, config.preferredBaseUrl);
  if (!context) {
    await browser.close();
    throw new Error('No browser context found in CDP session');
  }

  let page = null;
  let ownsPage = false;

  if (config.cdpReusePage) {
    page = pickPageForTarget(context, config.preferredBaseUrl);
  }

  if (!page) {
    page = await context.newPage();
    ownsPage = true;
  }

  try {
    let bootstrapInfo = null;

    if (config.cdpReusePage && !ownsPage) {
      let sameOrigin = false;
      try {
        const targetOrigin = new URL(config.preferredBaseUrl).origin;
        sameOrigin = typeof page.url === 'function' && page.url().startsWith(targetOrigin);
      } catch (_error) {
        sameOrigin = false;
      }

      if (sameOrigin) {
        try {
          await waitForKanbanApi(page, Math.min(10000, config.navTimeoutMs));
          bootstrapInfo = await runBootstrapSync(page, config);
        } catch (_error) {
          bootstrapInfo = null;
        }
      }
    }

    if (!bootstrapInfo) {
      bootstrapInfo = await navigateAndPreparePage(page, config.preferredBaseUrl, config);
    }

    return {
      mode: 'cdp',
      config,
      baseUrl: config.preferredBaseUrl,
      usesStaticFallback: false,
      page,
      context,
      browser,
      staticServer: null,
      bootstrapInfo,
      close: async () => {
        try {
          if (ownsPage && !page.isClosed()) await page.close({ runBeforeUnload: false });
        } catch (_error) {
          // no-op
        }
        await browser.close();
      }
    };
  } catch (error) {
    try {
      if (ownsPage && !page.isClosed()) await page.close({ runBeforeUnload: false });
    } catch (_ignore) {
      // no-op
    }
    await browser.close();
    throw error;
  }
}

async function createManagedSession(config) {
  let staticServer = null;
  let baseUrl = config.explicitBaseUrl || config.preferredBaseUrl;

  const canUsePreferred = await isUrlReachable(baseUrl, Math.min(3000, config.navTimeoutMs));
  if (!canUsePreferred) {
    staticServer = await startStaticServer(config.repoRoot);
    baseUrl = staticServer.baseUrl;
  }

  const context = await chromium.launchPersistentContext(config.profileDir, {
    headless: config.headless,
    viewport: { width: 1600, height: 1000 }
  });

  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  try {
    const bootstrapInfo = await navigateAndPreparePage(page, baseUrl, config);
    return {
      mode: 'managed',
      config,
      baseUrl,
      usesStaticFallback: Boolean(staticServer),
      page,
      context,
      browser: null,
      staticServer,
      bootstrapInfo,
      close: async () => {
        await context.close();
        if (staticServer) await staticServer.close();
      }
    };
  } catch (error) {
    await context.close();
    if (staticServer) await staticServer.close();
    throw error;
  }
}

export async function createBrowserSession(config = {}) {
  const finalConfig = {
    ...resolveSessionConfig(),
    ...config
  };

  if (finalConfig.sessionMode === 'cdp') {
    return tryCreateCdpSession(finalConfig);
  }

  if (finalConfig.sessionMode === 'auto') {
    try {
      return await tryCreateCdpSession(finalConfig);
    } catch (error) {
      if (finalConfig.requireCdp) {
        throw new Error(`CDP attach failed and UTS_MCP_REQUIRE_CDP=1: ${error.message}`);
      }
      console.error(`[uptospeed-mcp] CDP attach unavailable, falling back to managed mode: ${error.message}`);
    }
  }

  return createManagedSession(finalConfig);
}

export { REQUIRED_API_METHODS };
