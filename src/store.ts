import { mkdir, readdir, readFile, rm, writeFile, open, statfs, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import type { ReadStream } from 'node:fs';

export const MAX_BYTES = 100_000_000;
export const STORAGE_BYTES = 20_000_000_000;
export const TTL = 60 * 60 * 1000;
export const SESSION_TTL = 3 * TTL;
export class UploadError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) { super(message); }
}
export type FileInfo = { id: string; name: string; size: number; expiresAt: number; createdAt: number; downloadCount: number; lastDownloadAt: number | null; sessionId?: string };
export type Session = { id: string; code: string; token: string; createdAt: number; expiresAt: number };
const validId = (id: string) => /^[a-f0-9]{48}$/.test(id);
const token = () => randomBytes(24).toString('hex');

/** Higher scores evict older, colder files closer to expiry first. Activity protection is bounded. */
export function evictionScore(file: FileInfo, now: number) {
  const age = Math.max(0, now - file.createdAt) / TTL;
  const idle = Math.max(0, now - (file.lastDownloadAt ?? file.createdAt)) / TTL;
  const remaining = Math.max(0, file.expiresAt - now) / TTL;
  return 3 * age + 2 * idle + 3 / (1 + remaining) - Math.min(3, Math.log2(1 + file.downloadCount));
}

export class Store {
  private active = new Map<string, { size: number; sessionId?: string }>();
  private files = new Map<string, FileInfo>();
  private sessions = new Map<string, Session>();
  private downloads = new Map<string, Set<ReadStream>>();
  private queue: Promise<unknown> = Promise.resolve();
  private bytes = 0;
  constructor(readonly dir: string, private now = Date.now, private ttl = TTL, private maxBytes = MAX_BYTES, private capacity = STORAGE_BYTES) {}
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }
  path(id: string) { return join(this.dir, id); }
  private async save(path: string, value: unknown) {
    await writeFile(`${path}.tmp`, JSON.stringify(value));
    await rename(`${path}.tmp`, path);
  }
  private saveSessions() { return this.save(join(this.dir, 'sessions.json'), [...this.sessions.values()]); }
  private saveFile(file: FileInfo) { return this.save(join(this.path(file.id), 'meta.json'), file); }
  async init() {
    await mkdir(this.dir, { recursive: true });
    try {
      const sessions: Session[] = JSON.parse(await readFile(join(this.dir, 'sessions.json'), 'utf8'));
      for (const session of sessions) this.sessions.set(session.id, session);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    for (const id of await readdir(this.dir)) {
      if (!validId(id)) continue;
      try {
        const raw: FileInfo = JSON.parse(await readFile(join(this.path(id), 'meta.json'), 'utf8'));
        const info = { ...raw, createdAt: raw.createdAt ?? raw.expiresAt - this.ttl, downloadCount: raw.downloadCount ?? 0, lastDownloadAt: raw.lastDownloadAt ?? null };
        this.files.set(id, info);
        this.bytes += info.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await rm(this.path(id), { recursive: true, force: true });
      }
    }
    await this.cleanup();
    await this.locked(() => this.makeRoom(0));
  }
  private session(id: string, access?: string) {
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= this.now()) throw new UploadError(410, 'Session expired. Its files have been permanently deleted.');
    if (access !== undefined && access !== session.token) throw new UploadError(403, 'Join this session to access its files.');
    return session;
  }
  createSession() {
    return this.locked(async () => {
      await this.sweep();
      if (this.sessions.size >= 1000) throw new UploadError(503, 'Too many sessions. Try again later.');
      let code: string;
      do { code = String(randomInt(1_000_000)).padStart(6, '0'); } while ([...this.sessions.values()].some(s => s.code === code));
      const createdAt = this.now();
      const session = { id: token(), code, token: token(), createdAt, expiresAt: createdAt + SESSION_TTL };
      this.sessions.set(session.id, session);
      try { await this.saveSessions(); } catch (error) { this.sessions.delete(session.id); throw error; }
      return { ...session };
    });
  }
  joinSession(code: string) {
    return this.locked(async () => {
      const session = [...this.sessions.values()].find(s => s.code === code && s.expiresAt > this.now());
      if (!session) throw new UploadError(404, 'Invalid or expired session code.');
      return { ...session };
    });
  }
  getSession(id: string, access: string) {
    return this.locked(async () => {
      const session = this.session(id, access);
      const { token: secret, ...publicSession } = session;
      return { ...publicSession, files: [...this.files.values()].filter(f => f.sessionId === id && f.expiresAt > this.now()).sort((a, b) => b.createdAt - a.createdAt), serverTime: this.now() };
    });
  }
  private async remove(id: string) {
    for (const stream of this.downloads.get(id) ?? []) stream.destroy(new Error('File expired or removed.'));
    const file = this.files.get(id);
    await rm(this.path(id), { recursive: true, force: true });
    if (file) { this.bytes -= file.size; this.files.delete(id); }
  }
  private async sweep() {
    for (const file of this.files.values()) {
      if (file.expiresAt <= this.now() || (file.sessionId && !this.sessions.has(file.sessionId))) await this.remove(file.id);
    }
    let changed = false;
    for (const [id, session] of this.sessions) if (session.expiresAt <= this.now()) { this.sessions.delete(id); changed = true; }
    if (changed) await this.saveSessions();
  }
  private async makeRoom(extra: number) {
    await this.sweep();
    const pending = [...this.active.values()].reduce((sum, upload) => sum + upload.size, 0);
    const disk = await statfs(this.dir);
    let needed = Math.max(this.bytes + pending + extra - this.capacity, extra + this.maxBytes - disk.bavail * disk.bsize);
    if (needed <= 0) return;
    const candidates = [...this.files.values()].filter(f => !this.downloads.get(f.id)?.size).sort((a, b) => evictionScore(b, this.now()) - evictionScore(a, this.now()) || a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    if (candidates.reduce((sum, f) => sum + f.size, 0) < needed) throw new UploadError(503, 'Storage is busy. Try again shortly.');
    for (const file of candidates) {
      if (needed <= 0) break;
      await this.remove(file.id);
      needed -= file.size;
    }
  }
  async upload(body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, name: string, sessionId?: string, access = ''): Promise<FileInfo> {
    const id = token();
    await this.locked(async () => {
      if (this.active.size >= 8) throw new UploadError(503, 'Busy. Try again shortly.');
      if (sessionId) this.session(sessionId, access);
      this.active.set(id, { size: 0, sessionId });
    });
    const dir = this.path(id);
    try {
      await mkdir(dir);
      const file = await open(join(dir, 'content'), 'wx');
      let size = 0;
      try {
        for await (const chunk of body) {
          size += chunk.length;
          if (size > this.maxBytes) throw new UploadError(413, 'Files must be 100 MB or smaller.');
          await this.locked(async () => {
            if (sessionId) this.session(sessionId, access);
            await this.makeRoom(chunk.length);
            this.active.get(id)!.size = size;
          });
          await file.writeFile(chunk);
        }
      } finally { await file.close(); }
      return await this.locked(async () => {
        const createdAt = this.now();
        const expiresAt = sessionId ? this.session(sessionId, access).expiresAt : createdAt + this.ttl;
        const info: FileInfo = { id, name: name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 200) || 'download', size, expiresAt, createdAt, downloadCount: 0, lastDownloadAt: null, ...(sessionId ? { sessionId } : {}) };
        await this.saveFile(info);
        this.files.set(id, info);
        this.bytes += size;
        this.active.delete(id);
        return { ...info };
      });
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    } finally { await this.locked(async () => { this.active.delete(id); }); }
  }
  private async lookup(id: string) {
    const file = this.files.get(id);
    if (!file) return null;
    if (file.expiresAt <= this.now() || (file.sessionId && !this.sessions.has(file.sessionId))) { await this.remove(id); return null; }
    return file;
  }
  get(id: string) { return this.locked(async () => { const file = await this.lookup(id); return file ? { ...file } : null; }); }
  openDownload(id: string, access = '') {
    return this.locked(async () => {
      const info = await this.lookup(id);
      if (!info) throw new UploadError(404, 'File expired or removed to free storage.');
      if (info.sessionId) this.session(info.sessionId, access);
      const file = await open(join(this.path(id), 'content'));
      const stream = file.createReadStream();
      const streams = this.downloads.get(id) ?? new Set<ReadStream>();
      streams.add(stream);
      this.downloads.set(id, streams);
      const expiry = setTimeout(() => stream.destroy(new Error('File expired.')), Math.max(1, info.expiresAt - this.now()));
      const done = (completed: boolean) => this.locked(async () => {
        clearTimeout(expiry);
        streams.delete(stream);
        if (!streams.size) this.downloads.delete(id);
        if (completed && this.files.has(id) && info.expiresAt > this.now()) {
          info.downloadCount++;
          info.lastDownloadAt = this.now();
          await this.saveFile(info);
        }
      });
      return { info: { ...info }, stream, done };
    });
  }
  cleanup() { return this.locked(() => this.sweep()); }
}
