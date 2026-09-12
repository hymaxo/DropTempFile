import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Store, UploadError, MAX_BYTES, type Session } from './store.js';
import { Receivers } from './receivers.js';
import { RateLimit, clientKey } from './rate-limit.js';

const store = new Store(process.env.DATA_DIR || './data');
await store.init();
const receivers = new Receivers();
const limits = new RateLimit();
const assets = new Map(await Promise.all(['index.html', 'bundle.js', 'style.css'].map(async name => [name, await readFile(join('public', name))] as const)));
const cleanup = setInterval(() => store.cleanup().catch(console.error), 1000);
cleanup.unref();
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  const json = (status: number, value: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const access = (id: string) => req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`session_${id}=`))?.split('=')[1] ?? '';
  const joined = (session: Session, status: number) => {
    const { token, ...publicSession } = session;
    res.setHeader('Set-Cookie', `session_${session.id}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000))}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
    json(status, publicSession);
  };
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new UploadError(403, 'Cross-site requests are not allowed.');
    if (req.method === 'GET' && url.pathname === '/health') return json(200, { ok: true });
    const client = clientKey(req.socket.remoteAddress ?? '', String(req.headers['x-forwarded-for'] ?? ''), process.env.TRUST_PROXY === 'true');
    if (req.method === 'POST' && url.pathname === '/api/sessions') {
      limits.take(`create:${client}`, 5, 15 * 60_000);
      limits.take('create:global', 20, 60_000);
      return joined(await store.createSession(), 201);
    }
    if (req.method === 'POST' && url.pathname === '/api/sessions/join') {
      limits.take(`join:${client}`, 5, 15 * 60_000);
      limits.take('join:global', 30, 60_000);
      let body = '';
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        body += chunk.toString();
        if (body.length > 256) throw new UploadError(400, 'Enter a six-digit code.');
      }
      let code: unknown;
      try { code = JSON.parse(body).code; } catch { throw new UploadError(400, 'Enter a six-digit code.'); }
      if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new UploadError(400, 'Enter a six-digit code.');
      return joined(await store.joinSession(code), 200);
    }
    const sessionRoute = url.pathname.match(/^\/api\/sessions\/([a-f0-9]{48})(\/files)?$/);
    if (sessionRoute && req.method === 'GET' && !sessionRoute[2]) return json(200, await store.getSession(sessionRoute[1], access(sessionRoute[1])));
    if (req.method === 'POST' && url.pathname === '/api/receivers') return json(201, receivers.create());
    const receive = url.pathname.match(/^\/api\/receivers\/([a-f0-9]{48})(?:\/files\/([a-f0-9]{48}))?$/);
    if (receive) {
      if (req.method === 'GET' && !receive[2]) return json(200, receivers.read(receive[1], String(req.headers.authorization || '').replace(/^Bearer /, '')));
      if (req.method === 'POST' && receive[2]) {
        const info = await store.get(receive[2]);
        if (!info) return json(404, { error: 'This file has expired or does not exist.' });
        if (info.sessionId) throw new UploadError(403, 'Use the session code to share session files.');
        receivers.send(receive[1], receive[2]);
        return json(200, { ok: true });
      }
    }
    if (req.method === 'POST' && (url.pathname === '/api/files' || sessionRoute?.[2])) {
      if (Number(req.headers['content-length']) > MAX_BYTES) return json(413, { error: 'Files must be 100 MB or smaller.' });
      const name = url.searchParams.get('name') || 'download';
      req.setTimeout(120_000, () => req.destroy());
      const sessionId = sessionRoute?.[1];
      const session = sessionId ? await store.getSession(sessionId, access(sessionId)) : null;
      const expiry = session ? setTimeout(() => req.destroy(), Math.max(1, session.expiresAt - Date.now())) : null;
      try { return json(201, await store.upload(req.iterator({ destroyOnReturn: false }), name, sessionId, sessionId ? access(sessionId) : '')); }
      finally { if (expiry) clearTimeout(expiry); }
    }
    const match = url.pathname.match(/^\/(api\/files|download)\/([a-f0-9]{48})$/);
    if (req.method === 'GET' && match) {
      const info = await store.get(match[2]);
      if (!info) return json(404, { error: 'This file has expired or does not exist.' });
      if (info.sessionId) await store.getSession(info.sessionId, access(info.sessionId));
      if (match[1] === 'api/files') return json(200, info);
      const file = await store.openDownload(info.id, info.sessionId ? access(info.sessionId) : '');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': info.size, 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(info.name).replace(/'/g, '%27')}` });
      let completed = false;
      try { await pipeline(file.stream, res); completed = true; }
      finally { await file.done(completed); }
      return;
    }
    const asset = ['/', '/receive', '/send'].includes(url.pathname) || /^\/(f|session)\/[a-f0-9]{48}$/.test(url.pathname) ? 'index.html' : url.pathname.slice(1);
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
    if (error instanceof UploadError && error.retryAfter) res.setHeader('Retry-After', error.retryAfter);
    json(error instanceof UploadError ? error.status : 500, { error: error instanceof UploadError ? error.message : 'Unable to complete the request. Try again.' });
  }
});
server.requestTimeout = 120_000;
server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('DropTempFile listening'));
process.on('SIGTERM', () => { clearInterval(cleanup); server.close(); });
