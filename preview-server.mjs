import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import { extname, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.argv[2]) || 8000;

// Bind both loopback families. Binding only "localhost" resolves to ::1 on some
// machines, which leaves http://127.0.0.1:<port>/ unreachable.
const PRIMARY_HOST = '127.0.0.1';
const SECONDARY_HOST = '::1';
const HOST = 'localhost';

// Identity endpoint: preview.cmd probes it to tell this server apart from
// an unrelated program that happens to hold the port.
const PING_PATH = '/.bifrost-ping';
const PING_TOKEN = 'BIFROST_PREVIEW_OK';

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

function safeFilePath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, `http://${HOST}`).pathname);
  const requestedPath = pathname === '/' ? '/index.html' : pathname;
  const filePath = resolve(root, `.${normalize(requestedPath)}`);
  const relativePath = relative(root, filePath);

  return relativePath && !relativePath.startsWith('..') && !relativePath.includes(':')
    ? filePath
    : null;
}

async function handleRequest(request, response) {
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('Method Not Allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, `http://${HOST}`).pathname);
  } catch {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Bad Request');
    return;
  }

  if (pathname === PING_PATH) {
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    response.end(request.method === 'HEAD' ? undefined : PING_TOKEN);
    return;
  }

  let filePath;
  try {
    filePath = safeFilePath(request.url);
  } catch {
    response.writeHead(400);
    response.end('Bad Request');
    return;
  }

  if (!filePath) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    const contentType = contentTypes[extname(filePath).toLowerCase()] || 'application/octet-stream';
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': contentType,
    });
    response.end(request.method === 'HEAD' ? undefined : file);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Internal Server Error');
      return;
    }

    // 与 GitHub Pages 行为对齐：未知路径返回 404.html，由其脚本完成深链重定向
    try {
      const notFound = await fs.readFile(resolve(root, '404.html'));
      response.writeHead(404, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8',
      });
      response.end(request.method === 'HEAD' ? undefined : notFound);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not Found');
    }
  }
}

function openBrowser(url) {
  // --no-open keeps the server usable from scripts and headless checks.
  if (process.platform === 'win32' && !process.argv.includes('--no-open')) {
    execFile('cmd.exe', ['/d', '/c', 'start', '', url]);
  }
}

const listeners = [];

function reportListenFailure(error) {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Try: preview.cmd ${port + 1}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
}

// Listen on both loopback addresses so localhost and 127.0.0.1 both work.
// The secondary family is optional: a host with IPv6 disabled still serves on IPv4.
function bind(address, isPrimary, onSettled) {
  const server = createServer(handleRequest);
  server.once('error', (error) => {
    if (isPrimary) {
      reportListenFailure(error);
      return;
    }
    onSettled();
  });
  server.listen(port, address, () => {
    listeners.push(server);
    onSettled();
  });
}

bind(PRIMARY_HOST, true, () => {
  bind(SECONDARY_HOST, false, () => {
    if (!listeners.length) {
      return;
    }

    const url = `http://${HOST}:${port}/`;
    console.log(`BIFROST preview running at ${url} (also http://${PRIMARY_HOST}:${port}/)`);
    openBrowser(url);
    console.log('Press Ctrl+C to stop the server.');
  });
});
