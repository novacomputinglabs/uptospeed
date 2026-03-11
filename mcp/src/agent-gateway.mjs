import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserSession } from './session/browser-session.mjs';
import { KanbanClient } from './bridge/kanban-client.mjs';
import {
  MCP_TOOL_DEFINITIONS,
  createToolHandlers,
  isMutatingTool
} from './server.mjs';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 7340;
const AUTH_HEADER = 'x-uts-agent-token';
const DEFAULT_TOKEN = 'uptospeed-agent-gateway-dev-token';

function jsonResponse(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(null);
        return;
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error(`Invalid JSON: ${error?.message || error}`));
      }
    });
    req.on('error', reject);
  });
}

function isLocalRequest(req) {
  const remote = String(req.socket?.remoteAddress || '');
  if (!remote) return false;
  if (remote === '127.0.0.1' || remote === '::1') return true;
  return remote.endsWith('127.0.0.1');
}

function getGatewayToken() {
  const fromEnv = String(process.env.UTS_AGENT_GATEWAY_TOKEN || '').trim();
  return fromEnv || DEFAULT_TOKEN;
}

function isAuthorizedRequest(req, token) {
  if (!isLocalRequest(req)) return false;
  const incoming = String(req.headers[AUTH_HEADER] || '').trim();
  if (!incoming) return false;
  return crypto.timingSafeEqual(Buffer.from(incoming), Buffer.from(token));
}

export function createGatewayManifest(definitions = MCP_TOOL_DEFINITIONS) {
  return (Array.isArray(definitions) ? definitions : [])
    .map((definition) => ({
      name: definition.name,
      title: definition.title,
      description: definition.description,
      mutating: isMutatingTool(definition.name)
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function startAgentGateway() {
  const host = String(process.env.UTS_AGENT_GATEWAY_HOST || DEFAULT_HOST).trim() || DEFAULT_HOST;
  const port = Number.parseInt(String(process.env.UTS_AGENT_GATEWAY_PORT || DEFAULT_PORT), 10) || DEFAULT_PORT;
  const token = getGatewayToken();

  const session = await createBrowserSession();
  const client = new KanbanClient(session.page, {
    toolTimeoutMs: session.config.toolTimeoutMs,
    shotgridRefreshCooldownMs: session.config.shotgridRefreshCooldownMs,
    forcedShotgridProjectId: session.config.forcedShotgridProjectId,
    sessionInfo: {
      mode: session.mode,
      baseUrl: session.baseUrl,
      usesStaticFallback: session.usesStaticFallback === true
    }
  });
  const handlers = createToolHandlers(client);
  const manifest = createGatewayManifest();

  const server = http.createServer(async (req, res) => {
    const method = String(req.method || '').toUpperCase();
    const url = new URL(req.url || '/', `http://${host}:${port}`);

    if (!isAuthorizedRequest(req, token)) {
      jsonResponse(res, 401, {
        ok: false,
        error: `Unauthorized. Requests must be localhost and include ${AUTH_HEADER}.`
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/health') {
      jsonResponse(res, 200, {
        ok: true,
        host,
        port,
        toolCount: manifest.length,
        session: {
          mode: session.mode,
          baseUrl: session.baseUrl,
          usesStaticFallback: session.usesStaticFallback === true
        }
      });
      return;
    }

    if (method === 'GET' && url.pathname === '/manifest') {
      jsonResponse(res, 200, { ok: true, tools: manifest });
      return;
    }

    if (method === 'POST' && url.pathname === '/invoke') {
      try {
        const body = await parseRequestBody(req);
        const toolName = String(body?.toolName || '').trim();
        const args = body?.args && typeof body.args === 'object' ? body.args : {};
        if (!toolName) {
          jsonResponse(res, 400, { ok: false, error: 'toolName is required.' });
          return;
        }
        const handler = handlers[toolName];
        if (typeof handler !== 'function') {
          jsonResponse(res, 404, { ok: false, error: `Unknown tool: ${toolName}` });
          return;
        }
        const payload = await handler(args);
        jsonResponse(res, 200, { ok: true, payload });
      } catch (error) {
        jsonResponse(res, 400, {
          ok: false,
          error: String(error?.message || error)
        });
      }
      return;
    }

    jsonResponse(res, 404, { ok: false, error: 'Not found.' });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const closeAll = async () => {
    await new Promise((resolve) => server.close(resolve));
    await session.close();
  };

  process.on('SIGINT', () => {
    closeAll().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    closeAll().finally(() => process.exit(0));
  });

  console.error(`[uptospeed-agent-gateway] Listening on http://${host}:${port}`);
  console.error(`[uptospeed-agent-gateway] Auth header: ${AUTH_HEADER}`);
  return { server, session };
}

const modulePath = fileURLToPath(import.meta.url);
const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';

if (modulePath === entryPath) {
  startAgentGateway().catch((error) => {
    console.error(`[uptospeed-agent-gateway] Failed to start: ${error?.stack || error}`);
    process.exit(1);
  });
}
