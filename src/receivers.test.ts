import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Receivers } from './receivers.js';
import { UploadError } from './store.js';

test('QR can send but cannot read; delivery is single-file and retry-safe', () => {
  const inboxes = new Receivers();
  const a = inboxes.create();
  const b = inboxes.create();
  assert.notEqual(a.id, a.readToken);
  assert.throws(() => inboxes.read(a.id, a.id), (e: unknown) => e instanceof UploadError && e.status === 403);
  assert.throws(() => inboxes.read(a.id, b.readToken));
  inboxes.send(a.id, 'file-one');
  inboxes.send(a.id, 'file-one');
  assert.equal(inboxes.read(a.id, a.readToken).fileId, 'file-one');
  assert.equal(inboxes.read(b.id, b.readToken).fileId, null);
  assert.throws(() => inboxes.send(a.id, 'file-two'), (e: unknown) => e instanceof UploadError && e.status === 409);
});
test('expired receive QR cannot send or read', () => {
  let now = 0;
  const inboxes = new Receivers(() => now, 100);
  const session = inboxes.create();
  now = 100;
  assert.throws(() => inboxes.send(session.id, 'file'));
  assert.throws(() => inboxes.read(session.id, session.readToken));
});
