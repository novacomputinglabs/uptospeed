import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createGatewayRequestHandler } from '../src/agent-gateway.mjs';

test('gateway rejects malformed auth and bodies, then continues serving', async () => {
  const token = 'local-test-token';
  const server = http.createServer(createGatewayRequestHandler({
    host: '127.0.0.1', port: 7340, token,
    session: { mode: 'test', baseUrl: 'http://localhost' }, manifest: [],
    handlers: { echo: async (args) => args }
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const request = (url, body, auth = token) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port,
      path: url, method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-uts-agent-token': auth }
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject);
    req.end(body);
  });
  try {
    for (const auth of ['', 'x', 'x'.repeat(128), 'é'.repeat(token.length)]) {
      assert.equal((await request('/health', undefined, auth)).status, 401);
    }
    assert.equal((await request('http://[', undefined)).status, 400);
    assert.equal((await request('/invoke', '{')).status, 400);
    assert.equal((await request('/invoke', 'x'.repeat(1024 * 1024 + 1))).status, 413);
    assert.equal((await request('/invoke', JSON.stringify({ toolName: 'echo', args: { ok: 1 } }))).body.payload.ok, 1);
    assert.equal((await request('/health')).status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
