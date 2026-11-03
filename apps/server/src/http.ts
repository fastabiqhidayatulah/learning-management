/**
 * Server HTTP: melayani SPA yang sudah di-build + menjalankan endpoint.
 *
 * Alur satu permintaan API:
 *   POST /api/<nama> → resolusi sesi → context.user → (opsional) validasi
 *   inputSchema → execute() → JSON. ZiteError dipetakan ke status HTTP.
 *
 * Ini yang menggantikan runtime endpoint Zite. Tidak ada logika bisnis di sini:
 * semua ada di endpoint yang sudah ada, tak berubah.
 */

import express, { type Express, type Request, type Response } from 'express';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { HTTP_STATUS_BY_CODE, isZiteError, type ZiteRequestContext } from '@project/runtime/backend';
import { rawQuery } from '@project/runtime/client';
import {
  SESSION_COOKIE,
  cookieOptions,
  hashPassword,
  signSession,
  verifyPassword,
  verifySession,
} from './auth.js';

/* --------------------------------- tipe ---------------------------------- */

export type EndpointLike = {
  description?: string;
  authenticated?: boolean;
  schedule?: unknown;
  inputSchema?: { parse: (v: unknown) => unknown };
  execute: (params: { input: any; context: any; stream?: any }) => unknown;
};

export type EndpointMap = Record<string, EndpointLike>;

type AuthRow = {
  id: string;
  email: string;
  name: string;
  firstName: string;
  lastName: string;
  image: string | null;
  passwordHash: string | null;
};

/* --------------------------------- env ----------------------------------- */

const uploadsDir = () => process.env.UPLOADS_DIR ?? path.resolve(process.cwd(), 'data', 'uploads');
const pdfDir = () => process.env.PDF_DIR ?? path.resolve(process.cwd(), 'data', 'pdf');
const publicBase = () => (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');
const spaDir = () => process.env.SPA_DIR ?? path.resolve(process.cwd(), 'public');
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024);

const findUserByEmail = async (email: string) => {
  const rows = await rawQuery<AuthRow>(
    `SELECT "id", "email", "name", "firstName", "lastName", "image", "passwordHash"
       FROM "AuthUsers" WHERE LOWER("email") = LOWER($1) LIMIT 1`,
    [email.trim()],
  );
  return rows[0];
};

const findUserById = async (id: string) => {
  const rows = await rawQuery<AuthRow>(
    `SELECT "id", "email", "name", "firstName", "lastName", "image", "passwordHash"
       FROM "AuthUsers" WHERE "id" = $1 LIMIT 1`,
    [id],
  );
  return rows[0];
};

const publicUser = (row: AuthRow) => ({
  id: String(row.id),
  email: String(row.email),
  name: row.name || [row.firstName, row.lastName].filter(Boolean).join(' ').trim() || String(row.email),
  firstName: row.firstName || null,
  lastName: row.lastName || null,
  image: row.image ?? null,
});

async function currentUser(req: Request): Promise<AuthRow | undefined> {
  const token = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
  const userId = verifySession(token);
  if (!userId) return undefined;
  return findUserById(userId);
}

/** Akun pertama dari env, supaya instalasi baru bisa masuk tanpa akses DB manual. */
export async function ensureBootstrapAdmin() {
  const email = process.env.ADMIN_EMAIL?.trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) return;
  const rows = await rawQuery<{ n: string }>(`SELECT COUNT(*)::text AS n FROM "AuthUsers"`, []);
  if (Number(rows[0]?.n ?? 0) > 0) return;
  await rawQuery(`INSERT INTO "AuthUsers" ("email", "name", "firstName", "passwordHash") VALUES ($1, $2, $3, $4)`, [
    email,
    email.split('@')[0],
    email.split('@')[0],
    hashPassword(password),
  ]);
  console.log(`[auth] akun awal dibuat: ${email}`);
}

/* -------------------------------- helpers -------------------------------- */

/** Hanya izinkan redirect kembali ke origin sendiri. */
function safeRedirect(target: unknown, host: string): string {
  if (typeof target !== 'string' || !target) return '/';
  try {
    const url = new URL(target, `http://${host}`);
    return url.host === host ? url.pathname + url.search + url.hash : '/';
  } catch {
    return target.startsWith('/') ? target : '/';
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const loginPage = (opts: { error?: string; redirect: string; academy: string }) => `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Masuk — ${esc(opts.academy)}</title>
<style>body{font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;background:#f7f5f2;margin:0;display:grid;place-items:center;min-height:100vh}
form{background:#fff;border:1px solid #e6e2dc;border-radius:12px;padding:28px;width:min(380px,92vw)}
h1{font-size:20px;margin:0 0 18px}label{display:block;font-weight:600;margin:14px 0 6px}
input{width:100%;padding:10px;border:1px solid #d8d3cc;border-radius:8px;font-size:15px;box-sizing:border-box}
button{margin-top:20px;width:100%;padding:11px;border:0;border-radius:8px;background:#1f1b17;color:#fff;font-size:15px;font-weight:600;cursor:pointer}
.err{background:#fdecec;border:1px solid #f3c2c2;color:#8a1f1f;padding:10px;border-radius:8px;margin-bottom:8px;font-size:14px}</style>
</head><body><form method="post" action="/auth/login">
<h1>Masuk ke ${esc(opts.academy)}</h1>
${opts.error ? `<div class="err">${esc(opts.error)}</div>` : ''}
<input type="hidden" name="redirect" value="${esc(opts.redirect)}">
<label for="email">Email</label><input id="email" name="email" type="email" required autofocus>
<label for="password">Kata sandi</label><input id="password" name="password" type="password" required>
<button type="submit">Masuk</button>
</form></body></html>`;

/* -------------------------------- server --------------------------------- */

export function createServer(app: string, endpoints: EndpointMap): Express {
  const server = express();
  server.disable('x-powered-by');
  // Badan JSON boleh besar: unggahan lewat base64 (lihat packages/runtime/upload.ts),
  // jadi satu berkas 25 MB menjadi sekitar 34 MB JSON.
  server.use(express.json({ limit: process.env.BODY_LIMIT ?? '40mb' }));
  server.use(express.urlencoded({ extended: true }));

  // Cookie parsing seadanya — cukup untuk satu cookie sesi.
  server.use((req, _res, next) => {
    const header = req.headers.cookie ?? '';
    const cookies: Record<string, string> = {};
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    (req as Request & { cookies: Record<string, string> }).cookies = cookies;
    next();
  });

  server.get('/healthz', async (_req, res) => {
    try {
      await rawQuery('SELECT 1', []);
      res.json({ ok: true, app });
    } catch (e) {
      res.status(503).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  /* ------------------------------- auth ------------------------------- */

  server.get('/auth/me', async (req, res) => {
    const user = await currentUser(req);
    res.json({ user: user ? publicUser(user) : null });
  });

  server.get('/auth/login', (req, res) => {
    const redirect = safeRedirect(req.query.redirect, req.headers.host ?? '');
    res.type('html').send(
      loginPage({
        redirect,
        academy: process.env.APP_NAME ?? app,
        error: typeof req.query.error === 'string' ? req.query.error : undefined,
      }),
    );
  });

  server.post('/auth/login', async (req, res) => {
    const body = req.body as { email?: string; password?: string; redirect?: string };
    const redirect = safeRedirect(body.redirect, req.headers.host ?? '');
    const wantsJson = req.headers.accept?.includes('application/json') ?? false;

    if (!body.email || !body.password) {
      if (wantsJson) return res.status(400).json({ message: 'Email dan kata sandi wajib diisi' });
      return res.redirect(`/auth/login?redirect=${encodeURIComponent(redirect)}&error=${encodeURIComponent('Email dan kata sandi wajib diisi')}`);
    }

    const user = await findUserByEmail(body.email);
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      if (wantsJson) return res.status(401).json({ message: 'Email atau kata sandi salah' });
      return res.redirect(`/auth/login?redirect=${encodeURIComponent(redirect)}&error=${encodeURIComponent('Email atau kata sandi salah')}`);
    }

    res.cookie(SESSION_COOKIE, signSession(String(user.id)), cookieOptions());
    if (wantsJson) return res.json({ user: publicUser(user) });
    res.redirect(redirect);
  });

  server.get('/auth/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.redirect('/auth/login');
  });

  /* ------------------------------ unggahan ----------------------------- */

  server.post('/api/upload', async (req, res) => {
    const user = await currentUser(req);
    if (!user) return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Masuk dulu untuk mengunggah' });

    const { filename, data } = (req.body ?? {}) as { filename?: string; data?: string };
    if (!filename || !data) return res.status(400).json({ code: 'BAD_REQUEST', message: 'Berkas tidak lengkap' });

    // Terima data URL atau base64 mentah.
    const base64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) return res.status(400).json({ code: 'BAD_REQUEST', message: 'Berkas kosong' });
    if (buffer.length > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ code: 'BAD_REQUEST', message: `Berkas melebihi ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB` });
    }

    const dir = uploadsDir();
    await mkdir(dir, { recursive: true });
    const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, '-') || 'file';
    const stored = `${randomUUID()}-${safe}`;
    await writeFile(path.join(dir, stored), buffer);

    res.json({
      fileUrl: `${publicBase()}/uploads/${stored}`,
      filename,
      size: buffer.length,
    });
  });

  server.use('/uploads', express.static(uploadsDir(), { fallthrough: false, index: false }));
  server.use('/pdf', express.static(pdfDir(), { fallthrough: false, index: false }));

  /* ------------------------------ endpoint ----------------------------- */

  server.post('/api/:name', async (req: Request, res: Response) => {
    const name = req.params.name;
    const endpoint = endpoints[name];
    if (!endpoint) return res.status(404).json({ code: 'NOT_FOUND', message: `Endpoint "${name}" tidak dikenal` });

    const user = await currentUser(req);
    if (endpoint.authenticated && !user) {
      return res.status(401).json({ code: 'UNAUTHORIZED', message: 'Masuk dulu untuk melanjutkan' });
    }

    let input: unknown = req.body ?? {};
    if (endpoint.inputSchema?.parse) {
      try {
        input = endpoint.inputSchema.parse(input);
      } catch (e) {
        // Runtime Zite tidak menegakkan inputSchema; server kita menegakkannya,
        // karena kode endpoint mengandalkan bentuk input yang sudah tervalidasi.
        return res.status(400).json({
          code: 'BAD_REQUEST',
          message: e instanceof Error ? e.message : 'Input tidak valid',
        });
      }
    }

    const context: ZiteRequestContext = {
      user: user
        ? { id: String(user.id), email: String(user.email), firstName: user.firstName || null, lastName: user.lastName || null }
        : (undefined as never),
      app,
    };

    try {
      const output = await endpoint.execute({ input, context });
      res.json(output ?? null);
    } catch (e) {
      if (isZiteError(e)) {
        return res.status(e.code ? (HTTP_STATUS_BY_CODE[e.code] ?? 500) : 500).json({
          code: e.code,
          message: e.message,
          userFacingMessage: e.userFacingMessage,
        });
      }
      console.error(`[${app}] ${name} gagal`, e);
      res.status(500).json({ code: 'INTERNAL_ERROR', message: e instanceof Error ? e.message : 'Kesalahan server' });
    }
  });

  /* -------------------------------- SPA -------------------------------- */

  server.use(express.static(spaDir(), { index: 'index.html' }));
  server.get('*', (_req, res) => res.sendFile(path.join(spaDir(), 'index.html')));

  return server;
}
