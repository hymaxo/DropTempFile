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
  el('session-action-status').textContent = 'Creating session…';
  try { const created = await api('/api/sessions', { method: 'POST' }); location.assign(`/session/${created.id}`); }
  catch (error) { el('session-action-status').textContent = error.message; el('create-session').disabled = false; }
});
el('join-session').addEventListener('click', () => { el('join-dialog').showModal(); el('join-code').focus(); });
el('close-join').addEventListener('click', () => el('join-dialog').close());
el('join-form').addEventListener('submit', async event => {
  event.preventDefault();
  el('join-submit').disabled = true;
  el('join-status').textContent = 'Joining…';
  try {
    const joined = await api('/api/sessions/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: el('join-code').value.trim() }) });
    location.assign(`/session/${joined.id}`);
  } catch (error) { el('join-status').textContent = error.message; el('join-submit').disabled = false; }
});

const size = bytes => bytes < 1000 ? `${bytes} B` : bytes < 1_000_000 ? `${(bytes / 1000).toFixed(1)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;
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
  el('session-warning-text').textContent = message;
  el('session-warning-counter').textContent = '';
  el('session-clock').textContent = '00:00:00';
  el('session-code').textContent = 'Closed';
  el('copy-session-code').hidden = true;
  el('session-status').textContent = '';
  el('session-files').replaceChildren();
  el('session-count').textContent = '0';
}
function tick() {
  if (!session || stopped) return;
  const seconds = Math.max(0, Math.ceil((session.expiresAt - Date.now() - offset) / 1000));
  el('session-clock').textContent = clock(seconds);
  document.title = seconds <= 600 ? `${clock(seconds)} until deletion · DropTempFile` : 'Shared session · DropTempFile';
  if (seconds <= 0) { endSession('Session expired. All session files are permanently deleted.'); return; }
  if (seconds <= 600) {
    if (el('session-warning').hidden) {
      el('session-warning').hidden = false;
      el('session-warning-text').textContent = 'This session and all its files will be permanently deleted. Download what you need now.';
    }
    el('session-warning-counter').textContent = clock(seconds);
  }
}
function renderFiles(files) {
  const signature = JSON.stringify(files);
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
    const added = document.createElement('td'); added.textContent = new Date(file.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const count = document.createElement('td'); count.textContent = String(file.downloadCount);
    const action = document.createElement('td');
    const download = document.createElement('a'); download.href = `/download/${file.id}`; download.textContent = 'Download ↓'; download.setAttribute('aria-label', `Download ${file.name}`);
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
    el('session-delete-time').textContent = new Date(data.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    renderFiles(data.files);
    tick();
    el('session-connection').textContent = '';
  } catch (error) {
    if (error.status === 410) { endSession('Session expired. All session files are permanently deleted.'); return; }
    if (error.status === 403) { endSession('Join this session from the home page with its six-digit code.'); return; }
    el('session-connection').textContent = 'Connection lost. Reconnecting…';
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
      if (file.size > 100_000_000) throw new Error(`${file.name} is larger than 100 MB.`);
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        activeUpload = xhr;
        xhr.open('POST', `/api/sessions/${sessionId}/files?name=${encodeURIComponent(file.name)}`);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.timeout = 120000;
        el('session-status').textContent = `Uploading ${file.name}…`;
        xhr.upload.onprogress = event => { if (event.lengthComputable) el('session-status').textContent = `Uploading ${file.name} · ${Math.round(event.loaded / event.total * 100)}%`; };
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
    if (!stopped) el('session-status').textContent = files.length === 1 ? 'File added.' : `${files.length} files added.`;
  } catch (error) { if (!stopped) el('session-status').textContent = error.message; }
  finally { uploading = false; activeUpload = null; el('session-file').disabled = false; el('session-file').value = ''; }
}
el('copy-session-code').addEventListener('click', async () => {
  if (!session || stopped) return;
  try { await navigator.clipboard.writeText(session.code); el('session-status').textContent = 'Code copied.'; }
  catch { el('session-status').textContent = `Session code: ${session.code}`; }
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
