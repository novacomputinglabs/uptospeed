function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function normalizeTaskIds(taskIds) {
  if (Array.isArray(taskIds)) return taskIds;
  if (typeof taskIds === 'string' && taskIds.trim()) return [taskIds];
  return [];
}

function isUnsupportedCreateEntityError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('unsupported operation type: create_entity');
}

function buildLocalBrokerCapabilityMessage(response = {}, context = {}) {
  const status = Number(response?.status || 0);
  const data = response?.data && typeof response.data === 'object' ? response.data : null;
  const raw = String(response?.raw || '').trim();
  const transport = context?.transport && typeof context.transport === 'object' ? context.transport : {};
  const syncMode = String(context?.syncMode || '').trim().toLowerCase();
  const syncSuffix = syncMode === 'local_only' ? ' Board sync mode is local_only.' : '';

  if (status === 404) {
    if (transport.usesStaticFallback === true) {
      return `Writes unavailable: MCP session is using the static fallback page, and no writable /api/local backend is configured.${syncSuffix} Start shotgrid_server.py or point UTS_MCP_BASE_URL / ShotGrid server URL at the writable backend.`;
    }
    return `Writes unavailable: current session origin does not expose /api/local/* routes.${syncSuffix} Start or restart shotgrid_server.py and rebind the MCP session to the writable backend.`;
  }

  if (status <= 0) {
    const reason = String(response?.error || data?.error || raw || 'network error');
    return `Writes unavailable: local broker backend is unreachable from the current MCP session (${reason}).${syncSuffix}`;
  }

  const message = String(data?.error || data?.errors?.[0]?.error || raw || `HTTP ${status}`).trim();
  return `Writes unavailable: local broker preflight failed (${message}).${syncSuffix}`;
}

function formatLocalBrokerApplyError(response = {}, context = {}) {
  const status = Number(response?.status || 0);
  if (status === 404 || status <= 0) {
    return buildLocalBrokerCapabilityMessage(response, context);
  }
  const data = response?.data && typeof response.data === 'object' ? response.data : null;
  const message =
    String(data?.error || data?.errors?.[0]?.error || response?.raw || `HTTP ${status || 'unknown'}`);
  return `Local broker apply failed: ${message}`;
}

const SHOTGRID_AUTH_POLICIES = new Set(['user_only', 'hybrid_explicit', 'script_only']);

function normalizeShotGridAuthPolicy(value, fallback = 'script_only') {
  const normalized = String(value || '').trim().toLowerCase();
  return SHOTGRID_AUTH_POLICIES.has(normalized) ? normalized : fallback;
}

function effectiveShotGridAuthPolicyFromStatus(status = {}) {
  const basePolicy = normalizeShotGridAuthPolicy(status?.auth_policy, 'script_only');
  if (basePolicy === 'script_only') return 'script_only';
  return status?.fallback_allowed === true ? 'hybrid_explicit' : 'user_only';
}

export class KanbanClient {
  constructor(page, options = {}) {
    this.page = page;
    this.toolTimeoutMs = Number.isFinite(options.toolTimeoutMs) ? options.toolTimeoutMs : 30000;
    this.shotgridRefreshCooldownMs = Number.isFinite(options.shotgridRefreshCooldownMs)
      ? options.shotgridRefreshCooldownMs
      : 15000;
    this.forcedShotgridProjectId = Number.isFinite(options.forcedShotgridProjectId)
      ? Number(options.forcedShotgridProjectId)
      : null;
    this.lastShotgridRefreshAt = 0;
    this.sessionInfo = options.sessionInfo && typeof options.sessionInfo === 'object'
      ? { ...options.sessionInfo }
      : null;
  }

  setPage(page) {
    this.page = page;
    this.lastShotgridRefreshAt = 0;
  }

  setSessionInfo(sessionInfo) {
    this.sessionInfo = sessionInfo && typeof sessionInfo === 'object'
      ? { ...sessionInfo }
      : null;
  }

  async invoke(method, args = []) {
    const call = this.page.evaluate(
      ({ methodName, methodArgs }) => {
        const api = globalThis.ShotgridKanbanAPI;
        if (!api) throw new Error('window.ShotgridKanbanAPI is not available');
        const fn = api[methodName];
        if (typeof fn !== 'function') {
          throw new Error(`window.ShotgridKanbanAPI.${methodName} is not a function`);
        }
        return fn(...methodArgs);
      },
      { methodName: method, methodArgs: args }
    );

    return withTimeout(call, this.toolTimeoutMs, `ShotgridKanbanAPI.${method}`);
  }

  resolveApiOrigin() {
    const candidates = [
      this.sessionInfo?.baseUrl,
      typeof this.page?.url === 'function' ? this.page.url() : null,
      'http://127.0.0.1:7331/index.html'
    ];

    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'string') continue;
      try {
        const url = new URL(candidate);
        return `${url.protocol}//${url.host}`;
      } catch (_error) {
        // continue
      }
    }
    return 'http://127.0.0.1:7331';
  }

  async getShotgridAuthStatus() {
    const call = this.page.evaluate(async ({ fallbackOrigin }) => {
      const normalizePolicy = (value, fallback = 'script_only') => {
        const normalized = String(value || '').trim().toLowerCase();
        if (normalized === 'user_only' || normalized === 'hybrid_explicit' || normalized === 'script_only') {
          return normalized;
        }
        return fallback;
      };

      const resolveSettings = () => {
        if (globalThis.appSettings && typeof globalThis.appSettings === 'object') {
          return globalThis.appSettings;
        }
        return {};
      };

      const settings = resolveSettings();
      const configuredPolicy = normalizePolicy(settings.shotgridAuthPolicy, 'script_only');
      const fallbackAllowed = settings.shotgridAllowScriptFallback === true;
      const effectivePolicy = configuredPolicy === 'script_only'
        ? 'script_only'
        : (fallbackAllowed ? 'hybrid_explicit' : 'user_only');

      const accountId = String(settings.shotgridAccountId || '').trim();
      const accountLabel = String(settings.shotgridAccountLabel || '').trim();
      const shotgridEnabled =
        typeof globalThis.isShotGridEnabled === 'function'
          ? Boolean(globalThis.isShotGridEnabled())
          : false;

      const buildUrl = (path) => {
        try {
          if (typeof globalThis.shotGridUrl === 'function') return globalThis.shotGridUrl(path);
        } catch (_error) {
          // ignore
        }
        try {
          return new URL(path, globalThis.location?.href || fallbackOrigin).toString();
        } catch (_error) {
          return `${fallbackOrigin.replace(/\/+$/, '')}${path}`;
        }
      };

      try {
        const res = await fetch(buildUrl('/api/shotgrid/auth/status'));
        const raw = await res.text();
        let data = null;
        try {
          data = JSON.parse(raw);
        } catch (_error) {
          data = null;
        }
        const accountFromStatus = data?.account && typeof data.account === 'object' ? data.account : null;
        const resolvedPolicy = normalizePolicy(data?.auth_policy, effectivePolicy);
        const resolvedFallbackAllowed =
          typeof data?.fallback_allowed === 'boolean'
            ? data.fallback_allowed
            : fallbackAllowed;
        const resolvedAccount =
          accountFromStatus ||
          (accountId
            ? {
              id: accountId,
              name: accountLabel || null
            }
            : null);
        return {
          requestOk: res.ok,
          statusCode: res.status,
          status: {
            ok: data?.ok === true,
            authenticated: data?.authenticated === true,
            mode: String(data?.mode || '').trim().toLowerCase(),
            script_configured: data?.script_configured === true,
            base_url: data?.base_url || '',
            auth_policy: resolvedPolicy,
            fallback_allowed: resolvedFallbackAllowed,
            fallback_used: data?.fallback_used === true,
            effective_actor: String(data?.effective_actor || '').trim().toLowerCase() || 'none',
            reauth_required: data?.reauth_required === true,
            account: resolvedAccount,
            shotgrid_enabled: shotgridEnabled,
            error: data?.error ? String(data.error) : ''
          },
          raw
        };
      } catch (error) {
        return {
          requestOk: false,
          statusCode: 0,
          status: {
            ok: false,
            authenticated: false,
            mode: 'none',
            script_configured: false,
            base_url: '',
            auth_policy: effectivePolicy,
            fallback_allowed: fallbackAllowed,
            fallback_used: false,
            effective_actor: 'none',
            reauth_required: false,
            account: accountId
              ? {
                id: accountId,
                name: accountLabel || null
              }
              : null,
            shotgrid_enabled: shotgridEnabled,
            error: String(error?.message || error)
          },
          raw: ''
        };
      }
    }, { fallbackOrigin: this.resolveApiOrigin() });

    const response = await withTimeout(call, this.toolTimeoutMs, 'ShotGrid auth status');
    const status = response?.status && typeof response.status === 'object' ? response.status : {};
    return {
      requestOk: response?.requestOk === true,
      statusCode: Number(response?.statusCode) || 0,
      raw: response?.raw || '',
      status: {
        ok: status.ok === true,
        authenticated: status.authenticated === true,
        mode: String(status.mode || '').trim().toLowerCase() || 'none',
        script_configured: status.script_configured === true,
        base_url: String(status.base_url || ''),
        auth_policy: normalizeShotGridAuthPolicy(status.auth_policy, 'script_only'),
        fallback_allowed: status.fallback_allowed === true,
        fallback_used: status.fallback_used === true,
        effective_actor: String(status.effective_actor || '').trim().toLowerCase() || 'none',
        reauth_required: status.reauth_required === true,
        account: status.account && typeof status.account === 'object' ? status.account : null,
        shotgrid_enabled: status.shotgrid_enabled === true,
        error: String(status.error || '')
      }
    };
  }

  async getWriteAuthEnvelope() {
    const authStatus = await this.getShotgridAuthStatus();
    const status = authStatus?.status || {};
    if (status.shotgrid_enabled !== true) {
      return { auth: null, status };
    }
    const effectivePolicy = effectiveShotGridAuthPolicyFromStatus(status);
    const accountId = String(status?.account?.id || '').trim();
    const auth = {
      policy: effectivePolicy,
      allow_script_fallback: effectivePolicy === 'hybrid_explicit' && status.fallback_allowed === true
    };
    if (accountId) auth.account_id = accountId;
    return { auth, status };
  }

  async getPreferredProjectId() {
    if (Number.isFinite(this.forcedShotgridProjectId) && this.forcedShotgridProjectId > 0) {
      return Number(this.forcedShotgridProjectId);
    }

    try {
      const trace = await this.getSessionTrace();
      const fromTrace = Number(trace?.page?.shotgridProjectId);
      if (Number.isFinite(fromTrace) && fromTrace > 0) return fromTrace;
    } catch (_error) {
      // ignore
    }

    return null;
  }

  async getBrokerWriteCapability() {
    let trace = null;
    try {
      trace = await this.getSessionTrace();
    } catch (_error) {
      trace = null;
    }

    const transport =
      trace?.transport && typeof trace.transport === 'object'
        ? trace.transport
        : {
          mode: this.sessionInfo?.mode || null,
          baseUrl: this.sessionInfo?.baseUrl || null,
          usesStaticFallback: this.sessionInfo?.usesStaticFallback === true
        };
    const syncMode = trace?.page?.syncMode || null;

    const call = this.page.evaluate(async ({ fallbackOrigin }) => {
      const buildUrl = () => {
        try {
          if (typeof globalThis.shotGridUrl === 'function') {
            return globalThis.shotGridUrl('/api/local/health');
          }
        } catch (_error) {
          // ignore
        }
        try {
          return new URL('/api/local/health', globalThis.location?.href || fallbackOrigin).toString();
        } catch (_error) {
          return `${fallbackOrigin.replace(/\/+$/, '')}/api/local/health`;
        }
      };

      try {
        const res = await fetch(buildUrl(), { method: 'GET' });
        const raw = await res.text();
        let data = null;
        try {
          data = JSON.parse(raw);
        } catch (_error) {
          data = null;
        }
        return {
          status: res.status,
          ok: res.ok,
          data,
          raw
        };
      } catch (error) {
        return {
          status: 0,
          ok: false,
          data: null,
          raw: '',
          error: String(error?.message || error)
        };
      }
    }, { fallbackOrigin: this.resolveApiOrigin() });

    const response = await withTimeout(call, this.toolTimeoutMs, 'Local broker health');
    const capability = {
      transport,
      syncMode,
      statusCode: Number(response?.status || 0),
      health: response?.data || null
    };

    if (response?.ok && response?.data?.ok === true) {
      return {
        ok: true,
        ...capability
      };
    }

    return {
      ok: false,
      ...capability,
      error: String(response?.error || response?.data?.error || response?.raw || '').trim(),
      message: buildLocalBrokerCapabilityMessage(response, { transport, syncMode })
    };
  }

  async applyLocalOperations(operations = [], options = {}) {
    const opList = Array.isArray(operations) ? operations.filter(Boolean) : [];
    if (opList.length === 0) {
      return { ok: true, queued: 0, applied: [], errors: [] };
    }

    const explicitProjectId = Number(options?.projectId);
    const projectId =
      Number.isFinite(explicitProjectId) && explicitProjectId > 0
        ? explicitProjectId
        : await this.getPreferredProjectId();
    const body = {
      operations: opList,
      source: 'mcp'
    };
    const authInfo = await this.getWriteAuthEnvelope();
    if (authInfo?.auth) {
      body.auth = authInfo.auth;
    }
    if (Number.isFinite(projectId) && projectId > 0) {
      body.project_id = projectId;
    }

    const call = this.page.evaluate(async ({ payload, fallbackOrigin }) => {
      const buildUrl = () => {
        try {
          if (typeof globalThis.shotGridUrl === 'function') {
            return globalThis.shotGridUrl('/api/local/apply');
          }
        } catch (_error) {
          // ignore
        }
        try {
          return new URL('/api/local/apply', globalThis.location?.href || fallbackOrigin).toString();
        } catch (_error) {
          return `${fallbackOrigin.replace(/\/+$/, '')}/api/local/apply`;
        }
      };

      const res = await fetch(buildUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const raw = await res.text();
      let data = null;
      try {
        data = JSON.parse(raw);
      } catch (_error) {
        data = null;
      }
      return {
        status: res.status,
        ok: res.ok,
        data,
        raw
      };
    }, { payload: body, fallbackOrigin: this.resolveApiOrigin() });

    const response = await withTimeout(call, this.toolTimeoutMs, 'Local broker apply');
    const data = response?.data;
    if (!response?.ok || !data || data.ok !== true) {
      throw new Error(formatLocalBrokerApplyError(response, {
        transport: {
          usesStaticFallback: this.sessionInfo?.usesStaticFallback === true
        }
      }));
    }
    return data;
  }

  async refreshShotgridIfEnabled(options = {}) {
    const { force = false } = options;
    const now = Date.now();
    if (!force && now - this.lastShotgridRefreshAt < this.shotgridRefreshCooldownMs) {
      return { attempted: false, skipped: 'cooldown' };
    }
    this.lastShotgridRefreshAt = now;

    const call = this.page.evaluate(async ({ forcedProjectIdValue }) => {
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
    }, { forcedProjectIdValue: this.forcedShotgridProjectId });

    return withTimeout(call, this.toolTimeoutMs, 'ShotGrid refresh');
  }

  async getStatusSchema() {
    const call = this.page.evaluate(() => {
      const normalize = (value) => (typeof value === 'string' ? value.trim() : '');

      const api = globalThis.ShotgridKanbanAPI;
      if (!api || typeof api.getTasks !== 'function') {
        return {
          entityType: 'Task',
          fields: {
            status: { field: 'status', values: [], defaultValue: 'sch' },
            targetStatus: { field: 'targetStatus', values: [], defaultValue: 'ON TARGET' }
          }
        };
      }

      const tasks = Array.isArray(api.getTasks()) ? api.getTasks() : [];
      const statusByValue = new Map();
      const targetStatusSet = new Set();

      for (const task of tasks) {
        const statusValue = normalize(task?.status);
        if (statusValue) {
          const existing = statusByValue.get(statusValue) || statusValue;
          const nextLabel = normalize(task?.statusLabel) || existing;
          statusByValue.set(statusValue, nextLabel);
        }

        const targetStatus = normalize(task?.targetStatus);
        if (targetStatus) targetStatusSet.add(targetStatus);
      }

      // Include visible status options from the filter dropdown when available.
      const filterStatus = globalThis.document?.getElementById?.('filterStatus');
      if (filterStatus && filterStatus.tagName === 'SELECT') {
        for (const option of filterStatus.options) {
          const value = normalize(option?.value);
          if (!value || value.startsWith('__')) continue;
          const label = normalize(option?.textContent) || value;
          if (!statusByValue.has(value)) statusByValue.set(value, label);
        }
      }

      const targetDefaults = [
        'ON TARGET',
        'INTERNAL - POTENTIAL DELAY',
        'INTERNAL - CONFIRMED DELAY',
        'PUSH',
        'APPROVED'
      ];
      for (const value of targetDefaults) targetStatusSet.add(value);

      const statusValues = [...statusByValue.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([value, label]) => ({ value, label }));

      const targetValues = [...targetStatusSet]
        .sort((a, b) => a.localeCompare(b))
        .map((value) => ({ value, label: value }));

      return {
        entityType: 'Task',
        fields: {
          status: {
            field: 'status',
            aliases: ['status', 'Status'],
            values: statusValues,
            defaultValue: 'sch'
          },
          targetStatus: {
            field: 'targetStatus',
            aliases: ['targetStatus', 'Target Status Summary'],
            values: targetValues,
            defaultValue: 'ON TARGET'
          }
        }
      };
    });

    return withTimeout(call, this.toolTimeoutMs, 'ShotgridKanbanAPI.statusSchema');
  }

  async getState() {
    return this.invoke('getState');
  }

  async getSessionTrace() {
    const pageTraceCall = this.page.evaluate(() => {
      const api = globalThis.ShotgridKanbanAPI;
      const stateSnapshot =
        api && typeof api.getState === 'function' ? api.getState() : null;

      const trace = globalThis.__UTS_SESSION_TRACE && typeof globalThis.__UTS_SESSION_TRACE === 'object'
        ? { ...globalThis.__UTS_SESSION_TRACE }
        : null;
      const settings = globalThis.appSettings && typeof globalThis.appSettings === 'object'
        ? globalThis.appSettings
        : null;

      let projectId = null;
      try {
        if (typeof globalThis.shotGridProjectId === 'function') {
          projectId = globalThis.shotGridProjectId();
        }
      } catch (_error) {
        projectId = null;
      }

      return {
        pageUrl: globalThis.location?.href || null,
        sessionTrace: stateSnapshot?.sessionTrace || trace,
        shotgridEnabled:
          stateSnapshot?.sessionTrace?.shotgridEnabled ??
          (typeof globalThis.isShotGridEnabled === 'function' ? globalThis.isShotGridEnabled() : null),
        shotgridProjectId: stateSnapshot?.sessionTrace?.shotgridProjectId ?? projectId,
        shotgridProjectName: stateSnapshot?.sessionTrace?.shotgridProjectName || settings?.shotgridProjectName || '',
        syncMode: stateSnapshot?.syncMode || (settings?.shotgridDirectCreate === true ? 'direct_shotgrid_create' : 'local_only')
      };
    });

    const pageTrace = await withTimeout(pageTraceCall, this.toolTimeoutMs, 'MCP session trace');

    return {
      transport: {
        mode: this.sessionInfo?.mode || null,
        baseUrl: this.sessionInfo?.baseUrl || null,
        usesStaticFallback: this.sessionInfo?.usesStaticFallback === true,
        restartedAt: this.sessionInfo?.restartedAt || null,
        restartCount: Number.isFinite(this.sessionInfo?.restartCount)
          ? this.sessionInfo.restartCount
          : 0,
        mcpSessionId: this.sessionInfo?.mcpSessionId || null
      },
      page: pageTrace
    };
  }

  async getStats() {
    return this.invoke('getStats');
  }

  async getTasks(options = {}) {
    return this.invoke('getTasks', [options]);
  }

  async getTask(taskId) {
    return this.invoke('getTask', [taskId]);
  }

  async getFilteredTasks(options = {}) {
    return this.invoke('getFilteredTasks', [options]);
  }

  async getEndeavors() {
    return this.invoke('getEndeavors');
  }

  async getEndeavor(endeavorId) {
    return this.invoke('getEndeavor', [endeavorId]);
  }

  async getEndeavorTasks(endeavorId, options = {}) {
    return this.invoke('getEndeavorTasks', [endeavorId, options]);
  }

  async setFilters(filters) {
    return this.invoke('setFilters', [filters]);
  }

  async clearFilters() {
    try {
      return await this.invoke('clearFilters');
    } catch (error) {
      const fallbackFilters = {
        project: '',
        asset: '',
        artist: '',
        department: '',
        status: '',
        search: '',
        endeavorFilter: { mode: 'all', endeavorId: null }
      };

      try {
        const fallback = await this.invoke('setFilters', [fallbackFilters]);
        return {
          ...(fallback && typeof fallback === 'object' ? fallback : { success: true }),
          fallbackApplied: true,
          warning: `clearFilters fallback used after error: ${String(error?.message || error)}`
        };
      } catch (fallbackError) {
        throw new Error(
          `clearFilters failed: ${String(error?.message || error)}; fallback setFilters failed: ${String(
            fallbackError?.message || fallbackError
          )}`
        );
      }
    }
  }

  async registerEntities(entries) {
    const items = Array.isArray(entries) ? entries.filter(Boolean) : [];
    if (items.length === 0) {
      return { success: true, changed: 0, catalog: null };
    }
    return this.invoke('registerEntities', [items]);
  }

  async updateTask(taskId, updates) {
    const result = await this.invoke('updateTask', [taskId, updates]);
    await this.refreshShotgridIfEnabled({ force: true });
    return result && typeof result === 'object' ? result : { success: true, task: null };
  }

  async createTask(taskData) {
    const result = await this.invoke('createTask', [taskData]);
    await this.refreshShotgridIfEnabled({ force: true });
    return result && typeof result === 'object' ? result : { success: true, task: null };
  }

  async deleteTask(taskId) {
    const result = await this.invoke('deleteTask', [taskId]);
    await this.refreshShotgridIfEnabled({ force: true });
    return result && typeof result === 'object' ? result : { success: true, deletedTask: taskId };
  }

  async createEntity(entityType, entity = {}, options = {}) {
    const normalizedType = typeof entityType === 'string' ? entityType.trim().toLowerCase() : '';
    if (!normalizedType) {
      throw new Error('Entity type is required');
    }

    let broker = null;
    let directCreate = null;
    try {
      broker = await this.applyLocalOperations(
        [
          {
            type: 'create_entity',
            entityType: normalizedType,
            entity,
            ifExists: 'return_existing'
          }
        ],
        { projectId: options?.projectId }
      );
    } catch (error) {
      if (!isUnsupportedCreateEntityError(error)) {
        throw error;
      }
      directCreate = await this.createEntityDirect(normalizedType, entity, options);
    }

    await this.refreshShotgridIfEnabled({ force: true });

    const applied = Array.isArray(broker?.applied)
      ? broker.applied.find(
        (item) => item?.type === 'create_entity' && String(item?.entityType || '').trim().toLowerCase() === normalizedType
      )
      : null;

    const catalogEntity =
      directCreate?.entity ||
      applied?.result ||
      applied?.entity ||
      entity ||
      null;
    if (catalogEntity) {
      await this.registerEntities([{ entityType: normalizedType, entity: catalogEntity }]);
    }

    return {
      success: true,
      entityType: normalizedType,
      entity: catalogEntity,
      existing: Boolean(directCreate?.existing ?? applied?.existing),
      queued: Boolean(directCreate ? false : applied?.queued),
      broker,
      direct: Boolean(directCreate)
    };
  }

  async createEntityDirect(entityType, entity = {}, options = {}) {
    const explicitProjectId = Number(options?.projectId);
    const projectId =
      Number.isFinite(explicitProjectId) && explicitProjectId > 0
        ? explicitProjectId
        : await this.getPreferredProjectId();

    const payload = {
      entityType,
      entity,
      ifExists: 'return_existing'
    };
    const authInfo = await this.getWriteAuthEnvelope();
    if (authInfo?.auth) {
      payload.auth = authInfo.auth;
    }
    if (Number.isFinite(projectId) && projectId > 0) {
      payload.project_id = projectId;
    }

    const call = this.page.evaluate(async ({ requestPayload, fallbackOrigin }) => {
      const buildUrl = () => {
        try {
          if (typeof globalThis.shotGridUrl === 'function') {
            return globalThis.shotGridUrl('/api/shotgrid/entities/create');
          }
        } catch (_error) {
          // ignore
        }
        try {
          return new URL('/api/shotgrid/entities/create', globalThis.location?.href || fallbackOrigin).toString();
        } catch (_error) {
          return `${fallbackOrigin.replace(/\/+$/, '')}/api/shotgrid/entities/create`;
        }
      };

      const res = await fetch(buildUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestPayload)
      });
      const raw = await res.text();
      let data = null;
      try {
        data = JSON.parse(raw);
      } catch (_error) {
        data = null;
      }
      return {
        status: res.status,
        ok: res.ok,
        data,
        raw
      };
    }, { requestPayload: payload, fallbackOrigin: this.resolveApiOrigin() });

    const response = await withTimeout(call, this.toolTimeoutMs, 'ShotGrid entity create');
    const data = response?.data;
    if (!response?.ok || !data || data.ok !== true) {
      const message =
        String(data?.error || data?.errors?.[0]?.error || response?.raw || `HTTP ${response?.status || 'unknown'}`);
      throw new Error(`ShotGrid entity create failed: ${message}`);
    }

    return {
      success: true,
      entityType: String(data.entityType || entityType || '').trim().toLowerCase(),
      entity: data.entity || null,
      existing: Boolean(data.existing)
    };
  }

  async createAsset(entity, options = {}) {
    return this.createEntity('asset', entity, options);
  }

  async createSequence(entity, options = {}) {
    return this.createEntity('sequence', entity, options);
  }

  async createShot(entity, options = {}) {
    return this.createEntity('shot', entity, options);
  }

  async createArtist(entity, options = {}) {
    return this.createEntity('artist', entity, options);
  }

  async createDepartment(entity, options = {}) {
    return this.createEntity('department', entity, options);
  }

  async getTaskNoteThreads(taskId) {
    return this.invoke('getTaskNoteThreads', [taskId]);
  }

  async getTaskNoteThread(taskId, threadId) {
    return this.invoke('getTaskNoteThread', [taskId, threadId]);
  }

  async addTaskNote(taskId, content, options = {}) {
    return this.invoke('addTaskNote', [taskId, content, options]);
  }

  async replyTaskNote(taskId, threadId, content, options = {}) {
    return this.invoke('replyTaskNote', [taskId, threadId, content, options]);
  }

  async getMilestones() {
    return this.invoke('getMilestones');
  }

  async getMilestone(milestoneId) {
    return this.invoke('getMilestone', [milestoneId]);
  }

  async createMilestone(milestoneData = {}) {
    return this.invoke('createMilestone', [milestoneData]);
  }

  async updateMilestone(milestoneId, updates = {}) {
    return this.invoke('updateMilestone', [milestoneId, updates]);
  }

  async deleteMilestone(milestoneId) {
    return this.invoke('deleteMilestone', [milestoneId]);
  }

  async getTaskDependencies(taskId) {
    return this.invoke('getTaskDependencies', [taskId]);
  }

  async addTaskDependency(taskId, blockerTaskId) {
    return this.invoke('addTaskDependency', [taskId, blockerTaskId]);
  }

  async removeTaskDependency(dependencyId) {
    return this.invoke('removeTaskDependency', [dependencyId]);
  }

  async getTaskBlockers(taskId) {
    return this.invoke('getTaskBlockers', [taskId]);
  }

  async createTaskBlocker(taskId, blockerData = {}) {
    return this.invoke('createTaskBlocker', [taskId, blockerData]);
  }

  async updateTaskBlocker(blockerId, updates = {}) {
    return this.invoke('updateTaskBlocker', [blockerId, updates]);
  }

  async deleteTaskBlocker(blockerId) {
    return this.invoke('deleteTaskBlocker', [blockerId]);
  }

  async bulkUpdateTasks(items = []) {
    const updates = Array.isArray(items)
      ? items.filter((entry) => entry && typeof entry.taskId === 'string' && entry.taskId.trim() && entry.updates)
      : [];
    if (updates.length === 0) {
      return { success: true, total: 0, updatedCount: 0, failedCount: 0, results: [] };
    }

    const actions = updates.map((entry) => ({
      type: 'update',
      taskId: entry.taskId,
      updates: entry.updates
    }));

    const bulkResult = await this.invoke('executeBulkActions', [actions]);
    await this.refreshShotgridIfEnabled({ force: true });

    const tasks = await this.getTasks();
    const byId = new Map((Array.isArray(tasks) ? tasks : []).map((task) => [task.id, task]));
    const apiResults = Array.isArray(bulkResult?.results) ? bulkResult.results : [];

    const results = updates.map((entry, index) => {
      const apiResult = apiResults[index] || null;
      const task = byId.get(entry.taskId) || null;
      const ok =
        apiResult?.result?.success === true ||
        (apiResult?.error ? false : task !== null);
      return {
        taskId: entry.taskId,
        ok,
        result: apiResult?.result || null,
        error: apiResult?.error || null,
        task
      };
    });

    const updatedCount = results.filter((item) => item.ok).length;
    return {
      success: updatedCount === results.length,
      total: results.length,
      updatedCount,
      failedCount: results.length - updatedCount,
      results,
      bulkResult
    };
  }

  async getWorkloadSnapshot(range = null) {
    return this.invoke('getWorkloadSnapshot', [range]);
  }

  async getAutoBalancePlan(range = null, strategy = {}) {
    return this.invoke('getAutoBalancePlan', [range, strategy]);
  }

  async createEndeavor(endeavorData) {
    return this.invoke('createEndeavor', [endeavorData]);
  }

  async updateEndeavor(endeavorId, updates) {
    return this.invoke('updateEndeavor', [endeavorId, updates]);
  }

  async deleteEndeavor(endeavorId) {
    return this.invoke('deleteEndeavor', [endeavorId]);
  }

  async addTasksToEndeavor(endeavorId, taskIds) {
    return this.invoke('addTasksToEndeavor', [endeavorId, normalizeTaskIds(taskIds)]);
  }

  async removeTasksFromEndeavor(endeavorId, taskIds) {
    return this.invoke('removeTasksFromEndeavor', [endeavorId, normalizeTaskIds(taskIds)]);
  }

  async clearEndeavor(endeavorId) {
    return this.invoke('clearEndeavor', [endeavorId]);
  }

  async setViewMode(mode) {
    return this.invoke('setViewMode', [mode]);
  }

  async selectTask(taskId) {
    return this.invoke('selectTask', [taskId]);
  }

  async openTaskNotes(taskId) {
    return this.invoke('openTaskNotes', [taskId]);
  }

  async getDesktopRuntime() {
    return this.invoke('getDesktopRuntime');
  }

  async getDesktopRuntimeLogs() {
    return this.invoke('getDesktopRuntimeLogs');
  }

  async restartDesktopRuntime(reason = '') {
    return this.invoke('restartDesktopRuntime', [reason]);
  }

  async setDesktopRuntimeProfile(profileId) {
    return this.invoke('setDesktopRuntimeProfile', [profileId]);
  }

  async setDesktopMigrationPolicy(policy) {
    return this.invoke('setDesktopMigrationPolicy', [policy]);
  }

  async undo() {
    return this.invoke('undo');
  }

  async redo() {
    return this.invoke('redo');
  }
}

export { normalizeTaskIds };
