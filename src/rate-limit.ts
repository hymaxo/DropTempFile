import { isIP } from 'node:net';
import { UploadError } from './store.js';

/** Take the proxy-appended address, never the user-controlled first X-Forwarded-For entry. */
export function clientKey(remote: string, forwarded: string | undefined, trustProxy: boolean) {
  let ip = trustProxy && forwarded ? forwarded.split(',').at(-1)!.trim() : remote;
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (!isIP(ip)) return 'unknown';
  if (isIP(ip) === 6) {
    const expanded = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const [left, right = ''] = expanded.split('::');
    const a = left ? left.split(':') : [];
    const b = right ? right.split(':') : [];
    return [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b].slice(0, 4).map(x => x.padStart(4, '0')).join(':');
  }
  return ip;
}

export class RateLimit {
  private buckets = new Map<string, { count: number; until: number }>();
  constructor(private now = Date.now) {}
  take(key: string, limit: number, windowMs: number) {
    for (const [id, bucket] of this.buckets) if (bucket.until <= this.now()) this.buckets.delete(id);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= 10_000) throw new UploadError(429, 'Too many attempts. Try again in 15 minutes.', 900);
      bucket = { count: 0, until: this.now() + windowMs };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= limit) {
      const retry = Math.max(1, Math.ceil((bucket.until - this.now()) / 1000));
      throw new UploadError(429, `Too many attempts. Try again in ${Math.ceil(retry / 60)} min.`, retry);
    }
    bucket.count++;
  }
}
