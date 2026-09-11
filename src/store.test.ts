import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, UploadError } from './store.js';

test('upload survives restart; expiry denies access and removes bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'drop-test-'));
  try {
    let now = 1000;
    const store = new Store(dir, () => now, 100);
    await store.init();
    const info = await store.upload([Buffer.from('hello')], '../test.txt');
    assert.equal(info.name, '.._test.txt');
    assert.equal(await readFile(join(store.path(info.id), 'content'), 'utf8'), 'hello');
    const restarted = new Store(dir, () => now, 100);
    await restarted.init();
    assert.equal((await restarted.get(info.id))?.size, 5);
    now = 1100;
    assert.equal(await restarted.get(info.id), null);
    assert.deepEqual(await readdir(dir), []);
    assert.equal(await restarted.get('../outside'), null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('stream size limit accepts boundary and removes oversized or interrupted uploads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'drop-test-'));
  try {
    const store = new Store(dir, Date.now, 100, 5);
    await store.init();
    await assert.rejects(store.upload([Buffer.from('123'), Buffer.from('456')], 'large'), (error: unknown) => error instanceof UploadError && error.status === 413);
    async function* broken() { yield Buffer.from('12'); throw new Error('disconnected'); }
    await assert.rejects(store.upload(broken(), 'partial'));
    assert.deepEqual(await readdir(dir), []);
    assert.equal((await store.upload([Buffer.from('12345')], 'exact')).size, 5);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('cleanup deletes expired files without a download request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'drop-test-'));
  try {
    let now = 0;
    const store = new Store(dir, () => now, 10);
    await store.init();
    await store.upload([Buffer.from('test')], 'test');
    now = 10;
    await store.cleanup();
    assert.deepEqual(await readdir(dir), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
