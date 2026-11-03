/**
 * Runtime lokal — permukaan `zitejs/caller` (SISI BROWSER).
 *
 * Di Zite, caller memanggil endpoint di runtime. Di sini ia `POST /api/<nama>`
 * ke server sendiri, membawa cookie sesi.
 *
 * Kontrak yang dipertahankan: `createCaller<TInput, TOutput>(nama)` mengembalikan
 * fungsi `(input?) => Promise<TOutput>`, sehingga `.zite/api.ts` yang sudah ada
 * (65 + 32 caller bertipe) tetap bekerja tanpa perubahan.
 */

export interface ApiErrorShape {
  code?: string;
  message?: string;
  userFacingMessage?: string;
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

const API_BASE = (import.meta as { env?: Record<string, string> }).env?.VITE_API_BASE_URL ?? '';

export type Caller<TInput = unknown, TOutput = unknown> = (
  input?: TInput,
) => Promise<TOutput>;

export function createCaller<TInput = unknown, TOutput = unknown>(name: string): Caller<TInput, TOutput> {
  return async (input?: TInput): Promise<TOutput> => {
    const res = await fetch(`${API_BASE}/api/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(input ?? {}),
    });

    const text = await res.text();
    const body = text ? (JSON.parse(text) as unknown) : null;

    if (!res.ok) {
      const err = (body ?? {}) as ApiErrorShape;
      throw new ApiError(
        err.userFacingMessage ?? err.message ?? `Permintaan gagal (${res.status})`,
        err.code ?? 'INTERNAL_ERROR',
        res.status,
      );
    }
    return body as TOutput;
  };
}
