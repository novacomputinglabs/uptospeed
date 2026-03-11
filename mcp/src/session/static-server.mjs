import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

function resolveFilePath(rootDir, requestPath) {
  const normalized = path.normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const resolved = path.resolve(rootDir, `.${path.sep}${normalized}`);
  if (!resolved.startsWith(rootDir)) return null;
  return resolved;
}

async function readFileFromRequest(rootDir, requestPath) {
  let filePath = resolveFilePath(rootDir, requestPath);
  if (!filePath) {
    return { status: 403, body: 'Forbidden', type: 'text/plain; charset=utf-8' };
  }

  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { status: 404, body: 'Not Found', type: 'text/plain; charset=utf-8' };
    }
    throw error;
  }

  if (fileStat.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  try {
    const fileBuffer = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    return {
      status: 200,
      body: fileBuffer,
      type: MIME_TYPES[ext] || 'application/octet-stream'
    };
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { status: 404, body: 'Not Found', type: 'text/plain; charset=utf-8' };
    }
    throw error;
  }
}

export async function startStaticServer(rootDir) {
  const absoluteRoot = path.resolve(rootDir);

  const server = createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url || '/', 'http://127.0.0.1');
      let requestPath = decodeURIComponent(parsedUrl.pathname);
      if (requestPath === '/') requestPath = '/index.html';

      const response = await readFileFromRequest(absoluteRoot, requestPath);
      res.writeHead(response.status, { 'content-type': response.type });
      res.end(response.body);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`Server Error: ${error.message}`);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  if (!address || typeof address !== 'object') {
    throw new Error('Failed to start static server');
  }

  return {
    server,
    rootDir: absoluteRoot,
    baseUrl: `http://127.0.0.1:${address.port}/index.html`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}
