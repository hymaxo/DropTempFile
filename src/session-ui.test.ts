import { buildSync } from 'esbuild';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { SESSION_TTL } from './store.js';

test('folder renders safe names, warns at ten minutes, and closes all file actions at expiry', async () => {
  const html = await readFile('public/index.html', 'utf8');
  const script = buildSync({ entryPoints: ['public/sessions.js'], bundle: true, write: false, format: 'iife' }).outputFiles[0].text;
  const id = 'a'.repeat(48);
  const dom = new JSDOM(html, { url: `https://tmp.nolarp.space/session/${id}`, runScripts: 'outside-only' });
  let now = 1_000_000;
  const expiresAt = now + SESSION_TTL;
  let tick = () => {};
  Object.defineProperty(dom.window.Date, 'now', { value: () => now });
  Object.defineProperty(dom.window, 'setInterval', { value: (callback: () => void) => { tick = callback; return 1; } });
  Object.defineProperty(dom.window, 'setTimeout', { value: () => 1 });
  Object.defineProperty(dom.window, 'fetch', { value: async () => ({ ok: true, json: async () => ({ id, code: '001234', serverTime: now, expiresAt, files: [{ id: 'b'.repeat(48), name: '<img src=x onerror=alert(1)>.txt', size: 24, createdAt: now, downloadCount: 2 }] }) }) });
  try {
    dom.window.eval(script);
    await new Promise(resolve => setImmediate(resolve));
    const doc = dom.window.document;
    assert.equal(doc.getElementById('session-code')?.textContent, '001234');
    assert.equal(doc.querySelector('#session-files img'), null);
    assert.match(doc.getElementById('session-files')!.textContent!, /<img/);
    assert.equal(doc.getElementById('session-warning')!.hidden, true);
    const language = doc.getElementById('language') as HTMLSelectElement;
    language.value = 'ru';
    language.dispatchEvent(new dom.window.Event('change'));
    assert.equal(doc.querySelector('#session-files a')!.textContent, 'Скачать ↓');
    assert.match(doc.querySelector('.session-file-name')!.textContent!, /<img/);
    assert.equal(doc.getElementById('session-code')!.textContent, '001234');
    language.value = 'en';
    language.dispatchEvent(new dom.window.Event('change'));
    assert.equal(doc.querySelector('#session-files a')!.textContent, 'Download ↓');
    now = expiresAt - 600_000; tick();
    assert.equal(doc.getElementById('session-warning')!.hidden, false);
    assert.equal(doc.getElementById('session-warning-counter')!.textContent, '00:10:00');
    assert.match(doc.title, /00:10:00/);
    now = expiresAt; tick();
    assert.equal(doc.getElementById('session-upload')!.hidden, true);
    assert.equal(doc.getElementById('session-table')!.hidden, true);
    assert.equal(doc.querySelectorAll('#session-files a').length, 0);
    assert.match(doc.getElementById('session-warning-text')!.textContent!, /permanently deleted/);
  } finally { dom.window.close(); }
});
