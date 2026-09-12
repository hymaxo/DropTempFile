import { t, setText, locale, onLanguageChange } from './i18n.js';
const el = id => document.getElementById(id);
const sessionId = location.pathname.match(/^\/session\/([a-f0-9]{48})$/)?.[1];
let session;
let offset = 0;
let pollTimer;
let countTimer;
let stopped = false;
let uploading = false;
let activeUpload;
let lastRows = '';

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || 'Request failed. Try again.'); error.status = response.status; throw error; }
  return data;
}
el('create-session').addEventListener('click', async () => {
  el('create-session').disabled = true;
  setText(el('session-action-status'), () => t('Creating session…'));
  try { const created = await api('/api/sessions', { method: 'POST' }); location.assign(`/session/${created.id}`); }
  catch (error) { setText(el('session-action-status'), () => t(error.message)); el('create-session').disabled = false; }
});
el('join-session').addEventListener('click', () => { el('join-dialog').showModal(); el('join-code').focus(); });
el('close-join').addEventListener('click', () => el('join-dialog').close());
el('join-form').addEventListener('submit', async event => {
  event.preventDefault();
  el('join-submit').disabled = true;
  setText(el('join-status'), () => t('Joining…'));
  try {
    const joined = await api('/api/sessions/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: el('join-code').value.trim() }) });
    location.assign(`/session/${joined.id}`);
  } catch (error) { setText(el('join-status'), () => t(error.message)); el('join-submit').disabled = false; }
});

const size = bytes => new Intl.NumberFormat(locale(), { style: 'unit', unit: bytes < 1000 ? 'byte' : bytes < 1_000_000 ? 'kilobyte' : 'megabyte', maximumFractionDigits: 1 }).format(bytes < 1000 ? bytes : bytes < 1_000_000 ? bytes / 1000 : bytes / 1_000_000);
const clock = seconds => [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
function endSession(message) {
  stopped = true;
  clearTimeout(pollTimer);
  clearInterval(countTimer);
  activeUpload?.abort();
  el('session-upload').hidden = true;
  el('session-table').hidden = true;
  el('session-empty').hidden = true;
  el('session-warning').hidden = false;
  setText(el('session-warning-text'), () => t(message));
  setText(el('session-warning-counter'), () => t(''));
  setText(el('session-clock'), () => t('00:00:00'));
  setText(el('session-code'), () => t('Closed'));
  el('copy-session-code').hidden = true;
  setText(el('session-status'), () => t(''));
  el('session-files').replaceChildren();
  setText(el('session-count'), () => t('0'));
}
function tick() {
  if (!session || stopped) return;
  const seconds = Math.max(0, Math.ceil((session.expiresAt - Date.now() - offset) / 1000));
  el('session-clock').textContent = clock(seconds);
  setText(document.querySelector('title'), () => t(seconds <= 600 ? t("{0} until deletion · DropTempFile", [clock(seconds)]) : 'Shared session · DropTempFile'));
  if (seconds <= 0) { endSession('Session expired. All session files are permanently deleted.'); return; }
  if (seconds <= 600) {
    if (el('session-warning').hidden) {
      el('session-warning').hidden = false;
      setText(el('session-warning-text'), () => t('This session and all its files will be permanently deleted. Download what you need now.'));
    }
    el('session-warning-counter').textContent = clock(seconds);
  }
}
function renderFiles(files) {
  const signature = locale() + JSON.stringify(files);
  if (signature === lastRows) return;
  lastRows = signature;
  el('session-count').textContent = String(files.length);
  el('session-empty').hidden = files.length > 0;
  el('session-table').hidden = files.length === 0;
  const rows = files.map(file => {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    name.textContent = file.name;
    name.className = 'session-file-name';
    const bytes = document.createElement('td'); bytes.textContent = size(file.size);
    const added = document.createElement('td'); added.textContent = new Date(file.createdAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
    const count = document.createElement('td'); count.textContent = String(file.downloadCount);
    const action = document.createElement('td');
    const download = document.createElement('a'); download.href = `/download/${file.id}`; download.textContent = t('Download ↓'); download.setAttribute('aria-label', t('Download {0}', [file.name]));
    action.append(download); row.append(name, bytes, added, count, action);
    return row;
  });
  el('session-files').replaceChildren(...rows);
}
async function refresh() {
  if (stopped) return;
  try {
    const data = await api(`/api/sessions/${sessionId}`);
    if (stopped) return;
    session = data;
    offset = data.serverTime - Date.now();
    el('session-code').textContent = data.code;
    setText(el('session-delete-time'), () => t(new Date(data.expiresAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })));
    renderFiles(data.files);
    tick();
    setText(el('session-connection'), () => t(''));
  } catch (error) {
    if (error.status === 410) { endSession('Session expired. All session files are permanently deleted.'); return; }
    if (error.status === 403) { endSession('Join this session from the home page with its six-digit code.'); return; }
    setText(el('session-connection'), () => t('Connection lost. Reconnecting…'));
  }
  if (!stopped) { clearTimeout(pollTimer); pollTimer = setTimeout(refresh, document.hidden ? 10000 : 3000); }
}
async function uploadFiles(files) {
  if (!session || stopped || uploading || !files.length) return;
  uploading = true;
  el('session-file').disabled = true;
  try {
    for (const file of files) {
      if (stopped) break;
      if (file.size > 100_000_000) { setText(el('session-status'), () => t('{0} is larger than 100 MB.', [file.name])); return; }
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        activeUpload = xhr;
        xhr.open('POST', `/api/sessions/${sessionId}/files?name=${encodeURIComponent(file.name)}`);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.timeout = 120000;
        setText(el('session-status'), () => t("Uploading {0}…", [file.name]));
        xhr.upload.onprogress = event => { if (event.lengthComputable) setText(el('session-status'), () => t("Uploading {0} · {1}%", [file.name, Math.round(event.loaded / event.total * 100)])); };
        xhr.onload = () => {
          if (xhr.status === 201) { resolve(); return; }
          let message = 'Upload failed. Try again.';
          try { message = JSON.parse(xhr.responseText).error || message; } catch {}
          if (xhr.status === 410) endSession(message);
          reject(new Error(message));
        };
        xhr.onerror = () => reject(new Error('Connection lost. Try again.'));
        xhr.ontimeout = () => reject(new Error('Upload timed out. Try again.'));
        xhr.onabort = () => reject(new Error('Upload cancelled.'));
        xhr.send(file);
      });
      await refresh();
    }
    if (!stopped) setText(el('session-status'), () => t(files.length === 1 ? 'File added.' : t("{0} files added.", [files.length])));
  } catch (error) { if (!stopped) setText(el('session-status'), () => t(error.message)); }
  finally { uploading = false; activeUpload = null; el('session-file').disabled = false; el('session-file').value = ''; }
}
el('copy-session-code').addEventListener('click', async () => {
  if (!session || stopped) return;
  try { await navigator.clipboard.writeText(session.code); setText(el('session-status'), () => t('Code copied.')); }
  catch { setText(el('session-status'), () => t("Session code: {0}", [session.code])); }
});
el('session-file').addEventListener('change', event => uploadFiles([...event.target.files]));
for (const type of ['dragenter', 'dragover']) el('session-upload').addEventListener(type, event => { event.preventDefault(); el('session-upload').classList.add('drag'); });
for (const type of ['dragleave', 'drop']) el('session-upload').addEventListener(type, event => { event.preventDefault(); el('session-upload').classList.remove('drag'); });
el('session-upload').addEventListener('drop', event => uploadFiles([...event.dataTransfer.files]));
document.addEventListener('paste', event => {
  if (!sessionId || stopped || uploading) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && target.type !== 'file'))) return;
  const files = [...(event.clipboardData?.files || [])];
  const text = event.clipboardData?.getData('text/plain') || '';
  if (!files.length && /[\r\n]/.test(text)) files.push(new File([text], 'pasted-text.txt', { type: 'text/plain;charset=utf-8' }));
  if (!files.length) return;
  event.preventDefault(); uploadFiles(files);
});
if (sessionId) {
  el('upload-view').hidden = true;
  el('session-view').hidden = false;
  document.querySelector('main').classList.add('session-main');
  refresh();
  countTimer = setInterval(tick, 1000);
}

onLanguageChange(() => { if (session && !stopped) { renderFiles(session.files); el('session-delete-time').textContent = new Date(session.expiresAt).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' }); tick(); } });
