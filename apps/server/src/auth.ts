/**
 * Sesi & kata sandi — tanpa dependensi eksternal (node:crypto saja).
 *
 * Sesi = cookie bertanda tangan HMAC yang memuat id pengguna + kedaluwarsa.
 * Kata sandi = scrypt + salt acak, dibandingkan dengan timingSafeEqual.
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'lms_session';

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SESSION_SECRET wajib diset di produksi.');
    }
    return 'dev-only-insecure-secret';
  }
  return s;
}

const b64u = (buf: Buffer | string) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fromB64u = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/* ------------------------------- kata sandi ------------------------------- */

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const isPasswordHash = (v: string | null | undefined) => !!v && v.startsWith('scrypt$');

/* --------------------------------- sesi ---------------------------------- */

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function signSession(userId: string, ttlMs = DEFAULT_TTL_MS): string {
  const payload = b64u(JSON.stringify({ sub: userId, exp: Date.now() + ttlMs }));
  const sig = b64u(createHmac('sha256', secret()).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifySession(token: string | undefined | null): string | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = b64u(createHmac('sha256', secret()).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(fromB64u(payload).toString('utf8')) as { sub?: string; exp?: number };
    if (!data.sub || !data.exp || data.exp < Date.now()) return null;
    return data.sub;
  } catch {
    return null;
  }
}

export function cookieOptions(maxAgeMs = DEFAULT_TTL_MS) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/',
    maxAge: maxAgeMs,
  };
}
