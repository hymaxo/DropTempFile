import QRCode from 'qrcode';
import jsQR from 'jsqr';

const el = id => document.getElementById(id);
const maxBytes = 100_000_000;
let expiryTimer;
let currentFile;
let pendingReceiver = location.pathname === '/send' ? location.hash.slice(1) : null;
if (pendingReceiver && !/^[a-f0-9]{48}$/.test(pendingReceiver)) pendingReceiver = null;
if (pendingReceiver) document.querySelector('.intro').textContent = 'Choose a file to send to the receiving device.';
function showFile(info, uploaded) {
  currentFile = info;
  clearInterval(expiryTimer);
  el('receive-view').hidden = true;
  el('upload-view').hidden = true;
  el('file-view').hidden = false;
  el('filename').textContent = info.name;
  el('file-state').textContent = uploaded ? 'Ready to share' : 'Ready to download';
  el('link').value = `${location.origin}/f/${info.id}`;
  el('download').href = `/download/${info.id}`;
  QRCode.toCanvas(el('file-qr'), el('link').value, { width: 220, margin: 4 }).catch(() => { el('file-qr').hidden = true; });
  function tick() {
    const remaining = info.expiresAt - Date.now();
    if (remaining <= 0) { showExpired(); return; }
    el('details').textContent = `${(info.size / 1_000_000).toLocaleString(undefined, {maximumFractionDigits:2})} MB · Expires in ${Math.ceil(remaining / 60000)} min`;
  }
  tick();
  expiryTimer = setInterval(tick, 1000);
  if (pendingReceiver) { const receiver = pendingReceiver; pendingReceiver = null; sendTo(receiver); }
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
  el('send-tools').hidden = true;
  currentFile = null;
  stopCamera();
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

async function request(path, options) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed. Please try again.');
  return data;
}
function receiverFrom(text) {
  const url = new URL(text);
  if (url.origin !== location.origin || url.pathname !== '/send' || !/^#[a-f0-9]{48}$/.test(url.hash)) throw new Error('Scan a receive QR from this site, or paste its receive link.');
  return url.hash.slice(1);
}
let sending = false;
async function sendTo(receiver) {
  if (!currentFile || sending) return;
  sending = true;
  el('send-status').textContent = 'Sending…';
  el('send-status').className = '';
  try {
    await request(`/api/receivers/${receiver}/files/${currentFile.id}`, { method: 'POST' });
    el('send-status').textContent = 'Sent. Your file is ready on the receiving device.';
  } catch (error) { el('send-status').textContent = error.message; el('send-status').className = 'error'; }
  finally { sending = false; }
}
el('send-form').addEventListener('submit', e => {
  e.preventDefault();
  try { sendTo(receiverFrom(el('receiver-link').value)); }
  catch (error) { el('send-status').textContent = error.message; }
});

let cameraStream;
let scanTimer;
let cameraGeneration = 0;
function stopCamera() {
  cameraGeneration++;
  clearTimeout(scanTimer);
  cameraStream?.getTracks().forEach(track => track.stop());
  cameraStream = null;
  el('camera').srcObject = null;
  if (el('scanner').open) el('scanner').close();
}
el('close-scanner').addEventListener('click', stopCamera);
el('scanner').addEventListener('cancel', stopCamera);
el('scan').addEventListener('click', async () => {
  el('scanner').showModal();
  el('scan-status').textContent = 'Opening camera…';
  const generation = ++cameraGeneration;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera unavailable. Close this window and paste a receive link instead.');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    if (generation !== cameraGeneration) { stream.getTracks().forEach(track => track.stop()); return; }
    cameraStream = stream;
    el('camera').srcObject = stream;
    await el('camera').play();
    el('scan-status').textContent = 'Point your camera at the other device’s receive QR.';
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    // Decode at four frames per second only while the scanner is visible.
    function scan() {
      if (generation !== cameraGeneration) return;
      const video = el('camera');
      if (video.readyState >= 2 && video.videoWidth) {
        canvas.width = Math.min(640, video.videoWidth);
        canvas.height = Math.round(video.videoHeight * canvas.width / video.videoWidth);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'dontInvert' });
        if (code) {
          try { const receiver = receiverFrom(code.data); stopCamera(); sendTo(receiver); return; }
          catch (error) { el('scan-status').textContent = error.message; }
        }
      }
      scanTimer = setTimeout(scan, 250);
    }
    scan();
  } catch (error) {
    if (generation !== cameraGeneration) return;
    cameraStream?.getTracks().forEach(track => track.stop());
    cameraStream = null;
    el('scan-status').textContent = error.name === 'NotAllowedError' ? 'Camera permission denied. Allow camera access, or close and paste a receive link.' : error.message;
  }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });
window.addEventListener('pagehide', stopCamera);

let receiveTimer;
let receiveGeneration = 0;
async function startReceiver() {
  const generation = ++receiveGeneration;
  clearTimeout(receiveTimer);
  el('upload-view').hidden = true;
  el('receive-view').hidden = false;
  el('receive-qr').hidden = true;
  el('new-receiver').hidden = true;
  el('receive-link-details').hidden = true;
  el('receive-status').textContent = 'Creating receive QR…';
  try {
    const session = await request('/api/receivers', { method: 'POST' });
    const link = `${location.origin}/send#${session.id}`;
    el('receive-link').value = link;
    await QRCode.toCanvas(el('receive-qr'), link, { width: 280, margin: 4 });
    el('receive-qr').hidden = false;
    el('receive-link-details').hidden = false;
    async function poll() {
      if (generation !== receiveGeneration) return;
      if (Date.now() >= session.expiresAt) { expireReceiver(); return; }
      try {
        const response = await fetch(`/api/receivers/${session.id}`, { headers: { Authorization: `Bearer ${session.readToken}` } });
        if (response.status === 404 || response.status === 403) { expireReceiver(); return; }
        if (!response.ok) throw new Error();
        const state = await response.json();
        if (state.fileId) {
          // Navigate to a download page, never silently open the uploaded file itself.
          location.assign(`/f/${state.fileId}`);
          return;
        }
        el('receive-status').textContent = `Waiting for a file · QR expires in ${Math.ceil((session.expiresAt - Date.now()) / 60000)} min`;
      } catch { el('receive-status').textContent = 'Connection lost. Reconnecting…'; }
      receiveTimer = setTimeout(poll, 2000);
    }
    poll();
  } catch { expireReceiver('Unable to create a receive QR. Try again.'); }
}
function expireReceiver(message = 'Receive QR expired. Generate a new one.') {
  clearTimeout(receiveTimer);
  el('receive-status').textContent = message;
  el('receive-qr').hidden = true;
  el('receive-link-details').hidden = true;
  el('new-receiver').hidden = false;
}
el('new-receiver').addEventListener('click', startReceiver);
el('copy-receive').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(el('receive-link').value); el('copy-receive').textContent = 'Copied'; }
  catch { el('receive-link').select(); }
});
if (location.pathname === '/receive') startReceiver();
