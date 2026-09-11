const el = id => document.getElementById(id);
const maxBytes = 100_000_000;
let expiryTimer;
function showFile(info, uploaded) {
  el('upload-view').hidden = true;
  el('file-view').hidden = false;
  el('filename').textContent = info.name;
  el('file-state').textContent = uploaded ? 'Ready to share' : 'Ready to download';
  el('link').value = `${location.origin}/f/${info.id}`;
  el('download').href = `/download/${info.id}`;
  function tick() {
    const remaining = info.expiresAt - Date.now();
    if (remaining <= 0) { showExpired(); return; }
    el('details').textContent = `${(info.size / 1_000_000).toLocaleString(undefined, {maximumFractionDigits:2})} MB · Expires in ${Math.ceil(remaining / 60000)} min`;
  }
  tick();
  expiryTimer = setInterval(tick, 1000);
}
function showExpired(message = 'This file has expired or does not exist.') {
  clearInterval(expiryTimer);
  el('upload-view').hidden = true;
  el('file-view').hidden = false;
  el('file-state').textContent = 'File unavailable';
  el('filename').textContent = 'Gone.';
  el('details').textContent = message;
  el('share').hidden = true;
  el('download').hidden = true;
}
function upload(file) {
  if (!file || el('file').disabled) return;
  el('status').className = '';
  if (file.size > maxBytes) { el('status').textContent = 'Files must be 100 MB or smaller.'; el('status').className = 'error'; el('file').value = ''; return; }
  el('file').disabled = true;
  el('progress').hidden = false;
  el('progress').value = 0;
  el('status').textContent = `Uploading ${file.name}…`;
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/files?name=${encodeURIComponent(file.name)}`);
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.timeout = 120000;
  xhr.upload.onprogress = e => { if (e.lengthComputable) el('progress').value = e.loaded / e.total * 100; };
  function fail(message) { el('file').disabled = false; el('file').value = ''; el('progress').hidden = true; el('status').className = 'error'; el('status').textContent = message; }
  xhr.onload = () => {
    let data;
    try { data = JSON.parse(xhr.responseText); } catch { fail('Upload failed. Please try again.'); return; }
    if (xhr.status !== 201) { fail(data.error || 'Upload failed. Please try again.'); return; }
    history.replaceState(null, '', `/f/${data.id}`);
    showFile(data, true);
  };
  xhr.onerror = () => fail('Connection lost. Please try again.');
  xhr.ontimeout = () => fail('Upload timed out. Please try again.');
  xhr.send(file);
}
el('file').addEventListener('change', e => upload(e.target.files[0]));
for (const type of ['dragenter', 'dragover']) el('drop').addEventListener(type, e => { e.preventDefault(); el('drop').classList.add('drag'); });
for (const type of ['dragleave', 'drop']) el('drop').addEventListener(type, e => { e.preventDefault(); el('drop').classList.remove('drag'); });
el('drop').addEventListener('drop', e => { if (e.dataTransfer.files.length > 1) { el('status').textContent = 'Choose one file at a time.'; return; } upload(e.dataTransfer.files[0]); });
el('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(el('link').value); el('copy-status').textContent = 'Link copied.'; }
  catch { el('link').select(); el('copy-status').textContent = 'Select and copy the link above.'; }
});
const id = location.pathname.match(/^\/f\/([a-f0-9]{48})$/)?.[1];
if (id) {
  el('upload-view').hidden = true;
  fetch(`/api/files/${id}`).then(async response => { if (!response.ok) { showExpired(response.status === 404 ? undefined : 'Unable to load this file. Please refresh.'); return; } showFile(await response.json(), false); }).catch(() => showExpired('Unable to connect. Please refresh.'));
}
