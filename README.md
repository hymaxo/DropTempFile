# DropTempFile

Temporary file sharing at https://tmp.nolarp.space.

- One file per upload, up to 100 MB (100,000,000 bytes).
- Files expire 60 minutes after upload finishes. Download access ends at expiry; a sweep removes expired bytes every second while running, and on startup.
- Random 192-bit share links. Anyone with a link can download. No public file listing.
- Every file page shows a QR code for its share link.
- On the upload page, press Ctrl + V (or ⌘ + V on macOS) to paste an image or file directly from the clipboard. Multiline clipboard text is uploaded as `pasted-text.txt`; single-line text remains untouched. Text paste remains available in link fields.
- Open **Receive QR** on the receiving device, then use **Scan receive QR** on an uploaded file's page to send it there. The receiver opens the download page automatically. You can also paste the receive link, or scan it with a phone camera and upload a new file directly to that device.
- Receive QRs expire after 10 minutes and accept one file. Receive sessions are held in memory and expire on restart. Separate private polling tokens prevent a sender from reading another device's inbox. Sending never extends the file's original expiry.
- Streams uploads to disk, rejects oversized streams, and removes interrupted uploads.
- Persistent Docker volume preserves files and expiry times across restarts. Eight concurrent uploads maximum; new uploads are rejected when disk space is low.
- Downloads are attachments, never rendered as uploaded HTML or scripts.

## Local development

Requires Node.js 22 or newer.

```sh
npm ci
npm run dev
```

Open http://localhost:3000. `npm run build` checks TypeScript; `npm test` checks storage, expiry, size limits, and interruption cleanup.

## Deployment

Use the repository's `docker-compose.yml` with Coolify's Docker Compose build pack and connected GitHub App. Set the `web` service domain to `https://tmp.nolarp.space:3000`. Coolify manages routing and HTTPS. No host ports are published.

`PORT` defaults to 3000; `DATA_DIR` defaults to `./data` and is `/app/data` in Docker. Run a single replica per volume. Files cannot be deleted by the process while the container is stopped; startup cleanup removes overdue files before serving requests. Already-started downloads may finish after expiry. Deletion does not retract copies already downloaded.

## API

`POST /api/files?name=example.txt` accepts the raw file body and returns `{id, name, size, expiresAt}`. `GET /api/files/:id` returns metadata and `GET /download/:id` downloads it. Expired and unknown links return 404. `GET /health` is the container health check.

`POST /api/receivers` creates `{id, readToken, expiresAt}`. Poll `GET /api/receivers/:id` with `Authorization: Bearer <readToken>`. `POST /api/receivers/:id/files/:fileId` delivers an existing, unexpired file. Camera scanning happens locally in the browser; no video is uploaded.
