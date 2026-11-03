/**
 * Runtime lokal — permukaan `zitejs/auth` (SISI BROWSER).
 *
 * Di Zite, sesi disuntik oleh `app-runtime.js`. Di sini sesi adalah cookie
 * httpOnly milik server sendiri, dan `useAuth()` membacanya dari `GET /auth/me`.
 *
 * Kontrak yang dipertahankan (dipakai apps/learner-portal/src/lib/auth.tsx):
 *   const { user, isLoading, loginWithRedirect, logout } = useAuth();
 */

import { useCallback, useEffect, useState } from 'react';

export interface User {
  id: string;
  email: string;
  name?: string;
  firstName?: string | null;
  lastName?: string | null;
  image?: string | null;
}

const API_BASE = (import.meta as { env?: Record<string, string> }).env?.VITE_API_BASE_URL ?? '';

let cached: { user: User | null } | null = null;

export function useAuth() {
  const [user, setUser] = useState<User | null>(cached?.user ?? null);
  const [isLoading, setIsLoading] = useState(!cached);

  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/auth/me`, { credentials: 'include' })
      .then(async (res) => (res.ok ? ((await res.json()) as { user: User | null }).user : null))
      .catch(() => null)
      .then((u) => {
        if (!alive) return;
        cached = { user: u };
        setUser(u);
        setIsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const loginWithRedirect = useCallback((opts?: { redirectUrl?: string }) => {
    const target = opts?.redirectUrl ?? window.location.href;
    window.location.href = `${API_BASE}/auth/login?redirect=${encodeURIComponent(target)}`;
  }, []);

  const logout = useCallback(() => {
    cached = null;
    window.location.href = `${API_BASE}/auth/logout`;
  }, []);

  return { user, isLoading, loginWithRedirect, logout };
}

/** Dipakai halaman login kita sendiri untuk mengirim kredensial. */
export async function signInWithPassword(email: string, password: string): Promise<User> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  });
  const body = (await res.json().catch(() => ({}))) as { user?: User; message?: string };
  if (!res.ok || !body.user) throw new Error(body.message ?? 'Gagal masuk');
  cached = { user: body.user };
  return body.user;
}
