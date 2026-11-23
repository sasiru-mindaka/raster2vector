import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const host = '127.0.0.1';
const port = Number(process.env.PORT || 8000);
const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.wasm': 'application/wasm', '.txt': 'text/plain; charset=utf-8'
};

http.createServer((req, res) => {
  if (!['GET', 'HEAD'].includes(req.method || '')) {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method Not Allowed');
    return;
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url || '/', `http://${host}:${port}`).pathname); }
  catch { res.writeHead(400).end('Bad Request'); return; }
  if (pathname === '/') pathname = '/index.html';
  const target = path.resolve(root, `.${pathname}`);
  if (target !== root && !target.startsWith(root + path.sep)) {
    res.writeHead(403).end('Forbidden'); return;
  }
  let info;
  try { info = statSync(target); } catch { res.writeHead(404).end('Not Found'); return; }
  if (!info.isFile()) { res.writeHead(404).end('Not Found'); return; }
  res.writeHead(200, {
    'Content-Type': mime[path.extname(target).toLowerCase()] || 'application/octet-stream',
    'Content-Length': info.size,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache'
  });
  if (req.method === 'HEAD') res.end();
  else createReadStream(target).pipe(res);
}).listen(port, host, () => {
  console.log(`Raster2Vector is running at http://${host}:${port}`);
  console.log('Press Ctrl+C to stop.');
});
