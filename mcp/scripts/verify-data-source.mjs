import { createBrowserSession } from '../src/session/browser-session.mjs';
import { KanbanClient } from '../src/bridge/kanban-client.mjs';

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function summarizeProjects(tasks) {
  const counts = new Map();
  for (const task of tasks) {
    const key = String(task?.project || 'unknown');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([project, count]) => ({ project, count }));
}

async function readRuntimeStatus(page) {
  return page.evaluate(async () => {
    const appSettings = (() => {
      if (typeof globalThis.appSettings === 'object' && globalThis.appSettings) return globalThis.appSettings;
      try {
        const candidate = globalThis.eval?.('appSettings');
        if (candidate && typeof candidate === 'object') return candidate;
      } catch (_error) {
        // ignore
      }
      return null;
    })();
    const shotgridEnabled =
      typeof globalThis.isShotGridEnabled === 'function' ? Boolean(globalThis.isShotGridEnabled()) : null;

    let health = null;
    try {
      if (typeof globalThis.shotGridUrl === 'function') {
        const res = await fetch(globalThis.shotGridUrl('/api/shotgrid/health'));
        const data = await res.json().catch(() => null);
        health = {
          ok: res.ok,
          status: res.status,
          ...(data && typeof data === 'object' ? data : {})
        };
      }
    } catch (error) {
      health = { ok: false, error: String(error?.message || error) };
    }

    return {
      pageUrl: globalThis.location?.href || null,
      shotgridEnabled,
      shotgridProjectId: appSettings?.shotgridProjectId ?? null,
      shotgridProjectName: appSettings?.shotgridProjectName ?? null,
      shotgridServerUrl: appSettings?.shotgridServerUrl ?? null,
      health
    };
  });
}

async function main() {
  let session;
  try {
    session = await createBrowserSession();
    const client = new KanbanClient(session.page, {
      toolTimeoutMs: session.config.toolTimeoutMs,
      shotgridRefreshCooldownMs: session.config.shotgridRefreshCooldownMs,
      forcedShotgridProjectId: session.config.forcedShotgridProjectId
    });

    const refresh = await client.refreshShotgridIfEnabled({ force: true });
    const runtime = await readRuntimeStatus(session.page);
    const stats = await client.getStats();
    const tasks = await client.getTasks();

    const result = {
      sessionMode: session.mode,
      baseUrl: session.baseUrl,
      forcedShotgridProjectId: session.config.forcedShotgridProjectId ?? null,
      pageUrl: runtime.pageUrl,
      shotgridEnabled: runtime.shotgridEnabled,
      shotgridProjectId: runtime.shotgridProjectId,
      shotgridProjectName: runtime.shotgridProjectName,
      shotgridServerUrl: runtime.shotgridServerUrl,
      shotgridHealth: runtime.health,
      refresh,
      boardStats: stats,
      taskSample: tasks.slice(0, 3).map((t) => ({ id: t.id, name: t.name, project: t.project })),
      topProjects: summarizeProjects(tasks)
    };

    const checks = [];
    const warnings = [];

    const healthProjectId = asNumber(runtime.health?.project_id);
    const selectedProjectId = asNumber(runtime.shotgridProjectId) || asNumber(session.config.forcedShotgridProjectId);

    if (runtime.shotgridEnabled !== true) {
      checks.push('ShotGrid is disabled in the current app session. Enable ShotGrid in the same browser profile/tab.');
    }

    if (!healthProjectId && !selectedProjectId) {
      checks.push('ShotGrid health has no project_id. Select a project in the UI or set SHOTGRID_PROJECT_ID on the proxy server.');
    }

    if (selectedProjectId && healthProjectId && selectedProjectId !== healthProjectId) {
      checks.push(
        `Project mismatch: UI project ${selectedProjectId} differs from proxy health project ${healthProjectId}.`
      );
    }

    if (session.mode === 'managed' && selectedProjectId) {
      warnings.push(
        'MCP is running in managed mode with a selected project id. This is deterministic and does not rely on an open browser tab.'
      );
    }

    if (checks.length) {
      result.verdict = 'FAIL';
      result.issues = checks;
      result.warnings = warnings;
      console.error('[verify:data] FAIL');
      for (const issue of checks) {
        console.error(`- ${issue}`);
      }
      for (const warning of warnings) {
        console.error(`- WARN: ${warning}`);
      }
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = 1;
      return;
    }

    result.verdict = 'OK';
    result.issues = [];
    result.warnings = warnings;
    console.error('[verify:data] OK');
    for (const warning of warnings) {
      console.error(`- WARN: ${warning}`);
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    if (session) await session.close();
  }
}

main().catch((error) => {
  console.error(`[verify:data] ERROR: ${error?.stack || error?.message || error}`);
  process.exit(1);
});
