import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSync } from 'esbuild';
import { JSDOM } from 'jsdom';

const bundle = buildSync({ entryPoints: ['public/app.js'], bundle: true, write: false, format: 'iife' }).outputFiles[0].text;
async function page(languages: string[], saved?: string, blockedStorage = false) {
  const dom = new JSDOM(await readFile('public/index.html', 'utf8'), { url: 'https://tmp.example/', runScripts: 'outside-only' });
  Object.defineProperty(dom.window.navigator, 'languages', { value: languages, configurable: true });
  if (saved) dom.window.localStorage.setItem('droptempfile.language', saved);
  if (blockedStorage) Object.defineProperty(dom.window, 'localStorage', { get() { throw new Error('Blocked'); } });
  dom.window.eval(bundle);
  return dom;
}
function select(dom: JSDOM, value: string) {
  const input = dom.window.document.getElementById('language') as HTMLSelectElement;
  input.value = value;
  input.dispatchEvent(new dom.window.Event('change'));
}

test('automatic language follows supported browser preferences; saved choices win and unavailable storage is safe', async () => {
  for (const [languages, saved, expected, blocked] of [
    [['ru-RU', 'en'], undefined, 'ru', false],
    [['en-GB', 'ru'], undefined, 'en', false],
    [['fr', 'ru'], undefined, 'ru', false],
    [['de'], undefined, 'en', false],
    [['ru'], 'en', 'en', false],
    [['en'], 'ru', 'ru', false],
    [['ru'], 'invalid', 'ru', false],
    [['ru'], undefined, 'ru', true],
  ] as const) {
    const dom = await page([...languages], saved, blocked);
    try {
      assert.equal(dom.window.document.documentElement.lang, expected);
      select(dom, 'en');
      assert.equal(dom.window.document.documentElement.lang, 'en');
    } finally { dom.window.close(); }
  }
});

test('switching during upload preserves the request and file input, translates status and server errors, and persists preference', async () => {
  const dom = await page(['ru-RU']);
  let sends = 0;
  let finish = () => {};
  class Upload {
    upload = {};
    status = 413;
    responseText = JSON.stringify({ error: 'Files must be 100 MB or smaller.' });
    onload = () => {};
    open() {}
    setRequestHeader() {}
    send() { sends++; finish = () => this.onload(); }
  }
  Object.defineProperty(dom.window, 'XMLHttpRequest', { value: Upload });
  try {
    const doc = dom.window.document;
    const input = doc.getElementById('file') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new dom.window.File(['hello'], '<test>.txt')] });
    input.dispatchEvent(new dom.window.Event('change'));
    assert.equal(doc.getElementById('status')!.textContent, 'Загружаем <test>.txt…');
    select(dom, 'en');
    assert.equal(doc.getElementById('status')!.textContent, 'Uploading <test>.txt…');
    assert.equal(input.disabled, true);
    assert.equal(doc.getElementById('file'), input);
    assert.equal(sends, 1);
    finish();
    select(dom, 'ru');
    assert.equal(doc.getElementById('status')!.textContent, 'Размер файла не должен превышать 100 МБ.');
    assert.equal(input.getAttribute('aria-label'), 'Выберите файл для загрузки');
    assert.equal(dom.window.localStorage.getItem('droptempfile.language'), 'ru');
    select(dom, 'auto');
    Object.defineProperty(dom.window.navigator, 'languages', { value: ['en'] });
    dom.window.dispatchEvent(new dom.window.Event('languagechange'));
    assert.equal(doc.documentElement.lang, 'en');
  } finally { dom.window.close(); }
});
