import { mkdir, readdir, readFile, rm, writeFile, open, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const MAX_BYTES = 100_000_000;
export const TTL = 60 * 60 * 1000;
export class UploadError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export type FileInfo = { id: string; name: string; size: number; expiresAt: number };

export class Store {
  private active = new Set<string>();
  constructor(readonly dir: string, private now = Date.now, private ttl = TTL, private maxBytes = MAX_BYTES) {}
  async init() { await mkdir(this.dir, { recursive: true }); await this.cleanup(); }
  path(id: string) { return join(this.dir, id); }
  async upload(body: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, name: string): Promise<FileInfo> {
    if (this.active.size >= 8) throw new UploadError(503, 'Busy. Try again shortly.');
    const id = randomBytes(24).toString('hex');
    this.active.add(id);
    const dir = this.path(id);
    try {
      const disk = await statfs(this.dir);
      if (disk.bavail * disk.bsize < (this.active.size + 1) * this.maxBytes) throw new UploadError(503, 'Storage is busy. Try again later.');
      await mkdir(dir);
      const file = await open(join(dir, 'content'), 'wx');
      let size = 0;
      try {
        for await (const chunk of body) {
          size += chunk.length;
          if (size > this.maxBytes) throw new UploadError(413, 'Files must be 100 MB or smaller.');
          await file.writeFile(chunk);
        }
      } finally { await file.close(); }
      const info = { id, name: name.replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 200) || 'download', size, expiresAt: this.now() + this.ttl };
      await writeFile(join(dir, 'meta.json'), JSON.stringify(info));
      return info;
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    } finally { this.active.delete(id); }
  }
  async get(id: string): Promise<FileInfo | null> {
    if (!/^[a-f0-9]{48}$/.test(id)) return null;
    try {
      const info: FileInfo = JSON.parse(await readFile(join(this.path(id), 'meta.json'), 'utf8'));
      if (info.expiresAt > this.now()) return info;
      await rm(this.path(id), { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return null;
  }
  async cleanup() {
    for (const id of await readdir(this.dir)) {
      if (!/^[a-f0-9]{48}$/.test(id) || this.active.has(id)) continue;
      if (!(await this.get(id))) {
        await rm(this.path(id), { recursive: true, force: true });
      }
    }
  }
}
