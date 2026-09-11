import { randomBytes } from 'node:crypto';
import { UploadError } from './store.js';

const token = () => randomBytes(24).toString('hex');
type Receiver = { readToken: string; expiresAt: number; fileId: string | null };

/** Separate capabilities let a scanned QR send a file without reading the inbox. */
export class Receivers {
  private sessions = new Map<string, Receiver>();
  constructor(private now = Date.now, private ttl = 10 * 60_000) {}
  cleanup() {
    for (const [id, session] of this.sessions) if (session.expiresAt <= this.now()) this.sessions.delete(id);
  }
  create() {
    this.cleanup();
    if (this.sessions.size >= 1000) throw new UploadError(503, 'Too many receivers. Try again shortly.');
    const id = token();
    const session: Receiver = { readToken: token(), expiresAt: this.now() + this.ttl, fileId: null };
    this.sessions.set(id, session);
    return { id, readToken: session.readToken, expiresAt: session.expiresAt };
  }
  private get(id: string) {
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= this.now()) {
      this.sessions.delete(id);
      throw new UploadError(404, 'Receive QR expired. Generate a new one on the receiving device.');
    }
    return session;
  }
  read(id: string, readToken: string) {
    const session = this.get(id);
    if (session.readToken !== readToken) throw new UploadError(403, 'Invalid receiver credentials.');
    return { fileId: session.fileId, expiresAt: session.expiresAt };
  }
  send(id: string, fileId: string) {
    const session = this.get(id);
    if (session.fileId && session.fileId !== fileId) throw new UploadError(409, 'This device already received a file. Generate a new receive QR.');
    session.fileId = fileId;
  }
}
