import test from 'node:test';
import assert from 'node:assert/strict';
import { KanbanClient } from '../src/bridge/kanban-client.mjs';

const SAMPLE_ASSET = { id: 1412, name: 'SampleAsset', code: 'SampleAsset' };

function createFakePage(mode = 'broker') {
  const calls = [];
  const page = {
    calls,
    async evaluate(_fn, args) {
      calls.push(args);

      if (args && typeof args === 'object' && 'methodName' in args) {
        if (args.methodName === 'registerEntities') {
          return { success: true, changed: 1 };
        }
        throw new Error(`Unexpected invoke method: ${args.methodName}`);
      }

      if (args && typeof args === 'object' && 'forcedProjectIdValue' in args) {
        return { attempted: false, reason: 'shotgrid disabled' };
      }

      if (args && typeof args === 'object' && 'fallbackOrigin' in args && !('payload' in args) && !('requestPayload' in args)) {
        return {
          requestOk: true,
          statusCode: 200,
          status: {
            ok: true,
            authenticated: true,
            mode: 'script',
            script_configured: true,
            auth_policy: 'script_only',
            fallback_allowed: false,
            fallback_used: false,
            effective_actor: 'script',
            reauth_required: false,
            account: null,
            shotgrid_enabled: true,
            error: ''
          },
          raw: ''
        };
      }

      if (args?.payload?.operations) {
        if (mode === 'broker') {
          return {
            status: 200,
            ok: true,
            data: {
              ok: true,
              queued: 1,
              applied: [
                {
                  type: 'create_entity',
                  entityType: 'asset',
                  queued: true,
                  existing: false,
                  entity: SAMPLE_ASSET
                }
              ],
              errors: []
            },
            raw: ''
          };
        }
        return {
          status: 409,
          ok: false,
          data: {
            ok: false,
            error: 'Unsupported operation type: create_entity'
          },
          raw: '{"ok":false}'
        };
      }

      if (args?.requestPayload) {
        return {
          status: 201,
          ok: true,
          data: {
            ok: true,
            entityType: 'asset',
            existing: false,
            entity: SAMPLE_ASSET
          },
          raw: ''
        };
      }

      throw new Error(`Unexpected page.evaluate call: ${JSON.stringify(args)}`);
    }
  };
  return page;
}

test('createEntity uses broker create_entity when transport supports it', async () => {
  const page = createFakePage('broker');
  const client = new KanbanClient(page, { toolTimeoutMs: 1000 });

  const result = await client.createAsset({ name: SAMPLE_ASSET.name, code: SAMPLE_ASSET.code }, { projectId: 70 });

  assert.equal(result.success, true);
  assert.equal(result.direct, false);
  assert.equal(result.queued, true);
  assert.equal(result.existing, false);
  assert.equal(result.entity?.name, SAMPLE_ASSET.name);

  const brokerCall = page.calls.find((call) => Array.isArray(call?.payload?.operations));
  assert.ok(brokerCall, 'expected local broker apply call');
});

test('createEntity falls back to direct ShotGrid entity create when broker rejects create_entity', async () => {
  const page = createFakePage('fallback');
  const client = new KanbanClient(page, { toolTimeoutMs: 1000 });

  const result = await client.createAsset({ name: SAMPLE_ASSET.name, code: SAMPLE_ASSET.code }, { projectId: 70 });

  assert.equal(result.success, true);
  assert.equal(result.direct, true);
  assert.equal(result.queued, false);
  assert.equal(result.existing, false);
  assert.equal(result.entity?.name, SAMPLE_ASSET.name);

  const directCall = page.calls.find((call) => call?.requestPayload?.entityType === 'asset');
  assert.ok(directCall, 'expected direct /api/shotgrid/entities/create fallback call');
  assert.equal(directCall.requestPayload.project_id, 70);
});

test('clearFilters falls back to setFilters when clearFilters throws', async () => {
  const page = {
    calls: [],
    async evaluate(_fn, args) {
      this.calls.push(args);
      if (args?.methodName === 'clearFilters') {
        throw new Error('Cannot set properties of null');
      }
      if (args?.methodName === 'setFilters') {
        return { success: true, filtered: 0 };
      }
      throw new Error(`Unexpected invoke method: ${args?.methodName || 'unknown'}`);
    }
  };

  const client = new KanbanClient(page, { toolTimeoutMs: 1000 });
  const result = await client.clearFilters();

  assert.equal(result.success, true);
  assert.equal(result.fallbackApplied, true);
  assert.equal(typeof result.warning, 'string');
  assert.equal(page.calls.some((call) => call?.methodName === 'clearFilters'), true);
  assert.equal(page.calls.some((call) => call?.methodName === 'setFilters'), true);
});

test('getBrokerWriteCapability returns a clear message when static fallback lacks local broker routes', async () => {
  const page = {
    async evaluate(_fn, args) {
      if (args === undefined) {
        return {
          pageUrl: 'http://127.0.0.1:51234/index.html',
          sessionTrace: null,
          shotgridEnabled: false,
          shotgridProjectId: null,
          shotgridProjectName: '',
          syncMode: 'local_only'
        };
      }

      if (args?.fallbackOrigin) {
        return {
          status: 404,
          ok: false,
          data: null,
          raw: 'Not Found'
        };
      }

      throw new Error(`Unexpected page.evaluate call: ${JSON.stringify(args)}`);
    }
  };

  const client = new KanbanClient(page, {
    toolTimeoutMs: 1000,
    sessionInfo: {
      mode: 'managed',
      baseUrl: 'http://127.0.0.1:51234/index.html',
      usesStaticFallback: true
    }
  });

  const result = await client.getBrokerWriteCapability();

  assert.equal(result.ok, false);
  assert.equal(result.statusCode, 404);
  assert.equal(result.syncMode, 'local_only');
  assert.match(result.message, /static fallback page/i);
});

test('getBrokerWriteCapability succeeds when the local broker health endpoint is available', async () => {
  const page = {
    async evaluate(_fn, args) {
      if (args === undefined) {
        return {
          pageUrl: 'http://127.0.0.1:7331/index.html',
          sessionTrace: null,
          shotgridEnabled: true,
          shotgridProjectId: 70,
          shotgridProjectName: 'Project A',
          syncMode: 'shared_local_broker'
        };
      }

      if (args?.fallbackOrigin) {
        return {
          status: 200,
          ok: true,
          data: {
            ok: true,
            worker_alive: true
          },
          raw: '{"ok":true}'
        };
      }

      throw new Error(`Unexpected page.evaluate call: ${JSON.stringify(args)}`);
    }
  };

  const client = new KanbanClient(page, {
    toolTimeoutMs: 1000,
    sessionInfo: {
      mode: 'managed',
      baseUrl: 'http://127.0.0.1:7331/index.html',
      usesStaticFallback: false
    }
  });

  const result = await client.getBrokerWriteCapability();

  assert.equal(result.ok, true);
  assert.equal(result.statusCode, 200);
  assert.equal(result.syncMode, 'shared_local_broker');
  assert.equal(result.health?.worker_alive, true);
});
