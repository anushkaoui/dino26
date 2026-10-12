import { createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { HttpError, requireThat } from './errors.js';
export const hash = value => createHash('sha256').update(value).digest('hex');
export function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}
export function verify(token, secret, now, type) {
  requireThat(typeof token === 'string' && token.length < 1500, 401, 'SESSION_LOST', 'Please re-enter your roll number.');
  const [body, signature, extra] = token.split('.');
  const expected = createHmac('sha256', secret).update(body || '').digest('base64url');
  requireThat(!extra && equal(signature, expected), 401, 'SESSION_LOST', 'Please re-enter your roll number.');
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url')); } catch { throw new HttpError(401, 'SESSION_LOST', 'Invalid session.'); }
  requireThat(payload.type === type && Number.isFinite(payload.exp) && now < payload.exp,
    401, 'SESSION_LOST', 'Session expired. Please re-enter your roll number.');
  return payload;
}
export function normalizeRoll(roll) {
  requireThat(typeof roll === 'string', 400, 'BAD_ROLL', 'Enter an eight-character roll number.');
  const result = roll.trim().toUpperCase();
  requireThat(/^[A-Z0-9]{8}$/.test(result), 400, 'BAD_ROLL', 'Use exactly eight letters or numbers.');
  return result;
}
export class Limiter {
  constructor() { this.windows = new Map(); }
  use(key, limit, windowMs, now) {
    let window = this.windows.get(key);
    if (!window || now - window.start >= windowMs) { window = { start: now, count: 0 }; this.windows.set(key, window); }
    requireThat(++window.count <= limit, 429, 'SLOW_DOWN', 'Too many requests. Try again shortly.');
    if (this.windows.size > 10000) for (const [k, w] of this.windows)
      if (now - w.start > 60000) this.windows.delete(k);
    if (this.windows.size > 20000) this.windows.clear();
  }
}
