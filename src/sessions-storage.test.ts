import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, SESSION_TTL, TTL, UploadError, evictionScore, type FileInfo } from './store.js';
import { RateLimit, clientKey } from './rate-limit.js';

test('session membership, files and original deadline persist; late files expire with the session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'drop-session-'));
  let now = 1_000_000;
  try {
    const store = new Store(dir, () => now);
    await store.init();
    const session = await store.createSession();
    assert.match(session.code, /^\d{6}$/);
    assert.equal(session.expiresAt, now + SESSION_TTL);
    assert.equal((await store.joinSession(session.code)).id, session.id);
    await assert.rejects(store.getSession(session.id, 'wrong'), (e: unknown) => e instanceof UploadError && e.status === 403);
    await assert.rejects(store.upload([Buffer.from('blocked')], 'x', session.id, 'wrong'));
    now += SESSION_TTL - 1000;
    const file = await store.upload([Buffer.from('late')], 'late.txt', session.id, session.token);
    assert.equal(file.expiresAt, session.expiresAt);
    await assert.rejects(store.openDownload(file.id));
    const restarted = new Store(dir, () => now);
    await restarted.init();
    assert.equal((await restarted.getSession(session.id, session.token)).files[0].id, file.id);
    now = session.expiresAt;
    await assert.rejects(restarted.getSession(session.id, session.token));
    await assert.rejects(restarted.joinSession(session.code));
    await restarted.cleanup();
    assert.equal(await restarted.get(file.id), null);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'sessions.json'), 'utf8')), []);
    assert.deepEqual(await readdir(dir), ['sessions.json']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a session expiring during an upload cannot publish a late file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'drop-expiry-'));
  let now = 0;
  try {
    const store = new Store(dir, () => now); await store.init();
    const session = await store.createSession();
    async function* body() { yield Buffer.from('first'); now = session.expiresAt; yield Buffer.from('last'); }
    await assert.rejects(store.upload(body(), 'late', session.id, session.token));
    await store.cleanup();
    assert.deepEqual(await readdir(dir), ['sessions.json']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('one capacity applies to ordinary and session files, with cold older files evicted first', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'drop-capacity-'));
  let now = 0;
  try {
    const store = new Store(dir, () => now, TTL, 6, 12); await store.init();
    const old = await store.upload([Buffer.alloc(6)], 'old');
    now += 1000;
    const session = await store.createSession();
    const newer = await store.upload([Buffer.alloc(6)], 'shared', session.id, session.token);
    now += 1000;
    const fresh = await store.upload([Buffer.alloc(6)], 'fresh');
    assert.equal(await store.get(old.id), null);
    assert.ok(await store.get(newer.id)); assert.ok(await store.get(fresh.id));
    const restarted = new Store(dir, () => now, TTL, 6, 6); await restarted.init();
    const survivors = await Promise.all([restarted.get(newer.id), restarted.get(fresh.id)]);
    assert.equal(survivors.filter(Boolean).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('parallel partial uploads reserve storage before writing and release it on failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'drop-parallel-'));
  try {
    const store = new Store(dir, Date.now, TTL, 6, 10); await store.init();
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    let waiting = 0;
    async function* body() { yield Buffer.alloc(3); if (++waiting === 2) release(); await ready; yield Buffer.alloc(3); }
    const results = await Promise.allSettled([store.upload(body(), 'a'), store.upload(body(), 'b')]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const replacement = await store.upload([Buffer.alloc(6)], 'replacement');
    assert.ok(await store.get(replacement.id));
    assert.equal((await readdir(dir)).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('downloads protect bytes while active; only completed downloads update persistent activity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'drop-download-'));
  let now = 0;
  try {
    const store = new Store(dir, () => now, TTL, 6, 6); await store.init();
    const file = await store.upload([Buffer.from('123456')], 'file');
    const download = await store.openDownload(file.id);
    await assert.rejects(store.upload([Buffer.alloc(6)], 'blocked'));
    for await (const chunk of download.stream) assert.equal(chunk.toString(), '123456');
    now = 100;
    await download.done(true);
    const again = await store.openDownload(file.id);
    for await (const chunk of again.stream) assert.ok(chunk.length);
    await again.done(false);
    const restarted = new Store(dir, () => now, TTL, 6, 6); await restarted.init();
    const info = await restarted.get(file.id);
    assert.equal(info?.downloadCount, 1); assert.equal(info?.lastDownloadAt, 100);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('eviction ranks age, recent demand, popularity and proximity to expiry', () => {
  const now = 2 * TTL;
  const file: FileInfo = { id: 'x', name: 'x', size: 1, createdAt: TTL, expiresAt: 3 * TTL, downloadCount: 0, lastDownloadAt: null };
  const baseline = evictionScore(file, now);
  assert.ok(evictionScore({ ...file, createdAt: 0 }, now) > baseline);
  assert.ok(evictionScore({ ...file, lastDownloadAt: now }, now) < baseline);
  assert.ok(evictionScore({ ...file, downloadCount: 5 }, now) < baseline);
  assert.ok(evictionScore({ ...file, expiresAt: now + 1 }, now) > baseline);
});

test('rate limits do not reset with guesses or spoofed forwarding prefixes', () => {
  let now = 0; const limit = new RateLimit(() => now);
  const a = clientKey('127.0.0.1', 'fake, 203.0.113.7', true);
  const b = clientKey('127.0.0.1', 'different, 203.0.113.7', true);
  assert.equal(a, b);
  assert.equal(clientKey('203.0.113.7', '203.0.113.8', false), '203.0.113.7');
  assert.equal(clientKey('2001:db8:abcd:1::1', undefined, false), clientKey('2001:db8:abcd:1::ffff', undefined, false));
  for (let i = 0; i < 5; i++) limit.take(a, 5, 900_000);
  assert.throws(() => limit.take(b, 5, 900_000), (e: unknown) => e instanceof UploadError && e.status === 429 && e.retryAfter === 900);
  now = 900_000; assert.doesNotThrow(() => limit.take(a, 5, 900_000));
});
