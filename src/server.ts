import { createServer } from 'node:http';
import { readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Store, UploadError, MAX_BYTES } from './store.js';

const store = new Store(process.env.DATA_DIR || './data');
await store.init();
const assets = new Map(await Promise.all(['index.html', 'app.js', 'style.css'].map(async name => [name, await readFile(join('public', name))] as const)));
const cleanup = setInterval(() => store.cleanup().catch(console.error), 1000);
cleanup.unref();
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') return json(200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/api/files') {
      if (Number(req.headers['content-length']) > MAX_BYTES) return json(413, { error: 'Files must be 100 MB or smaller.' });
      const name = url.searchParams.get('name') || 'download';
      req.setTimeout(120_000, () => req.destroy());
      return json(201, await store.upload(req.iterator({ destroyOnReturn: false }), name));
    }
    const match = url.pathname.match(/^\/(api\/files|download)\/([a-f0-9]{48})$/);
    if (req.method === 'GET' && match) {
      const info = await store.get(match[2]);
      if (!info) return json(404, { error: 'This file has expired or does not exist.' });
      if (match[1] === 'api/files') return json(200, info);
      const file = await open(join(store.path(info.id), 'content'));
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': info.size, 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(info.name).replace(/'/g, '%27')}` });
      await pipeline(file.createReadStream(), res);
      return;
    }
    const asset = url.pathname === '/' || /^\/f\/[a-f0-9]{48}$/.test(url.pathname) ? 'index.html' : url.pathname.slice(1);
    if (req.method === 'GET' && assets.has(asset)) {
      res.writeHead(200, { 'Content-Type': asset.endsWith('.js') ? 'text/javascript' : asset.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' });
      res.end(assets.get(asset));
      return;
    }
    json(404, { error: 'Not found.' });
  } catch (error) {
    if (res.headersSent || res.destroyed) return;
    if (!(error instanceof UploadError)) console.error(error);
    res.setHeader('Connection', 'close');
    json(error instanceof UploadError ? error.status : 500, { error: error instanceof UploadError ? error.message : 'Unable to complete the request. Try again.' });
  }
});
server.requestTimeout = 120_000;
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('DropTempFile listening'));
process.on('SIGTERM', () => { clearInterval(cleanup); server.close(); });
