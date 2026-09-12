# DropTempFile

Temporary file sharing at https://tmp.nolarp.space.

- One file per upload, up to 100 MB (100,000,000 bytes).
- Default uploads expire 60 minutes after upload finishes. A sweep removes expired bytes every second while running, and on startup. Downloads are stopped at expiry.
- Default uploads have random 192-bit share links. Anyone with a link can download. No public file listing.
- Every file page shows a QR code for its share link.
- On the upload page, press Ctrl + V (or ⌘ + V on macOS) to paste an image or file directly from the clipboard. Multiline clipboard text is uploaded as `pasted-text.txt`; single-line text remains untouched. Text paste remains available in link fields.
- Open **Receive QR** on the receiving device, then use **Scan receive QR** on an uploaded file's page to send it there. The receiver opens the download page automatically. You can also paste the receive link, or scan it with a phone camera and upload a new file directly to that device.
- Receive QRs expire after 10 minutes and accept one file. Receive sessions are held in memory and expire on restart. Separate private polling tokens prevent a sender from reading another device's inbox. Sending never extends the file's original expiry.
- Streams uploads to disk, rejects oversized streams, and removes interrupted uploads.
- Persistent Docker volume preserves files, sessions, expiry times, and download statistics across restarts. Eight concurrent uploads maximum.
- Downloads are attachments, never rendered as uploaded HTML or scripts.

## Shared sessions

Click **Start session** and share the six-digit code. Other devices use **Join session** on the home page. Every member can upload, paste, and download in a shared folder. Multiple selected/dropped files are uploaded sequentially, each limited to 100 MB. The list refreshes every three seconds.

Sessions last exactly three hours from creation. Every file in a session shares that original deadline, including files added near the end. At ten minutes remaining, an alert and live countdown appear; the browser tab title also counts down. Expiry removes session metadata and files without a recovery path. An upload crossing the deadline is cancelled and removed.

Joining sets a random 192-bit session capability in a Secure (production), HttpOnly, SameSite=Strict cookie. Session listings, file metadata, and downloads require membership, even when someone knows a file URL. Sessions are independent of Receive QR; use the session code to share their files.

Join attempts are limited to five per client IP per 15 minutes, including successful attempts, plus a global limit of 30 per minute. Creation is limited to five per IP per 15 minutes and 20 globally per minute. HTTP 429 responses include Retry-After. IPv6 addresses share a /64 bucket. Counters are in memory and reset on process restart. The Compose deployment sets TRUST_PROXY=true because only Coolify exposes HTTP; the last proxy-appended X-Forwarded-For address identifies clients, not user-supplied prefixes. Leave this unset for direct deployments.

## Shared storage budget

Session files and ordinary uploads share a 20 GB (20,000,000,000 byte) content budget. Pending uploads reserve their bytes under the same serialized accounting before disk writes, so concurrent streams cannot overfill the budget. Metadata uses a small amount of additional disk space. An extra one-file disk headroom is maintained for the underlying volume.

Expired files go first. If more room is needed, files receive an eviction score: `3 × ageHours + 2 × idleHours + 3 / (1 + remainingHours) - min(3, log2(1 + completedDownloads))`. Higher scores are removed first, with oldest creation time breaking ties. This prefers older, unused files near expiry, while recent downloads and repeated use offer bounded protection. Activity never extends expiry. Active downloads are protected from capacity eviction; if no eligible files can free enough room, the upload returns 503. Downloads stop at scheduled expiry regardless of popularity. Removed files immediately disappear from the session list and their links stop working.

## Local development

Requires Node.js 22 or newer.

```sh
npm ci
npm run dev
```

Open http://localhost:3000. `npm run build` checks TypeScript and bundles the client; `npm test` checks sessions, storage limits, expiry, download activity, rate limits, and the countdown UI.

## Deployment

Use the repository's `docker-compose.yml` with Coolify's Docker Compose build pack and connected GitHub App. Set the `web` service domain to `https://tmp.nolarp.space:3000`. Coolify manages routing and HTTPS. No host ports are published.

`PORT` defaults to 3000; `DATA_DIR` defaults to `./data` and is `/app/data` in Docker. Run a single replica per volume. Files cannot be deleted by the process while the container is stopped; startup cleanup removes overdue files before serving requests. Deletion does not retract copies already downloaded. Do not back up the uploads volume if expired content must not be retained in backups.

## API

`POST /api/files?name=example.txt` accepts the raw file body and returns `{id, name, size, expiresAt}`. `GET /api/files/:id` returns metadata and `GET /download/:id` downloads it. Expired and unknown links return 404. `GET /health` is the container health check.

`POST /api/receivers` creates `{id, readToken, expiresAt}`. Poll `GET /api/receivers/:id` with `Authorization: Bearer <readToken>`. `POST /api/receivers/:id/files/:fileId` delivers an existing, unexpired file. Camera scanning happens locally in the browser; no video is uploaded.

`POST /api/sessions` creates a session and sets its membership cookie. `POST /api/sessions/join` with JSON `{ "code": "123456" }` joins and sets the same cookie. `GET /api/sessions/:id` lists files and returns serverTime/expiresAt; `POST /api/sessions/:id/files?name=example.txt` uploads raw bytes. Keep the cookie for session downloads. Expired sessions return 410, missing membership returns 403.

The interface supports English and Russian. The header language selector defaults to Auto, using the first supported browser language (English fallback). Manual choices are saved in local storage. Language changes apply immediately without restarting uploads or sessions.
