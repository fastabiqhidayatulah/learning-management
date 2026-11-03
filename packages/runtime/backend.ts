/**
 * Runtime lokal — permukaan `zitejs/backend` (dan `zitejs/backend/base`).
 *
 * Ini menggantikan `apps/<app>/.zite/backend.ts` sekaligus
 * `zitejs/dist/esm/backend`. Bentuknya sengaja identik supaya 97 endpoint di
 * `src/api/*.ts` dan seluruh `packages/shared/server/*` tetap kompilasi tanpa
 * satu pun perubahan.
 *
 * `createEndpoint` tetap fungsi identitas: endpoint adalah objek konfigurasi
 * murni `{ inputSchema, execute({ input, context }) }` yang dijalankan server
 * kita sendiri (lihat `apps/server`).
 */

/* ------------------------------------------------------------------ *
 * Tipe yang dulu datang dari `zitejs/backend/base` dan `zitejs/auth`
 * ------------------------------------------------------------------ */

export type ZiteErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

/** Kode yang benar-benar dipetakan ke status HTTP oleh server. */
export const HTTP_STATUS_BY_CODE: Record<string, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

/** Pengguna yang terlihat oleh sebuah endpoint — TIDAK lengkap seperti User di browser. */
export type ZiteEndpointUser = {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  /** Sisa kolom dari tabel user kita (role, status, …), bila ada. */
  [key: string]: unknown;
};

export interface ZiteRequestContext {
  user: ZiteEndpointUser;
  /** Alamat app pemanggil: 'learning-management' | 'learner-portal'. */
  app?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface ZiteScheduledContext {
  /** Jadwal tidak punya sesi. */
  user: null;
  scheduledAt: string;
  scheduleId?: string;
  [key: string]: unknown;
}

export interface ZiteSchedule {
  scheduleType: 'recurring' | 'once';
  schedule: {
    frequency: 'daily' | 'weekly' | 'monthly' | string;
    interval: number;
    times: string[];
    daysOfWeek?: number[];
    dayOfMonth?: number;
  };
  timezone: string;
  overlapPolicy?: 'skip' | 'allow' | 'queue';
}

export interface ZiteWebhook {
  /** Nama webhook yang memicu endpoint ini. */
  name?: string;
  secret?: string;
}

export interface ZiteStreamInterface {
  write(chunk: string): void;
  close(): void;
}

/* ------------------------------------------------------------------ *
 * createEndpoint
 * ------------------------------------------------------------------ */

type SchemaLike<TOut, TIn = TOut> = { _output: TOut; _input: TIn; parse: (data: unknown) => TOut };

export interface EndpointConfig<
  TInput = unknown,
  TOutput = unknown,
  TStream extends boolean = false,
  TSchedule extends ZiteSchedule | undefined = undefined,
  TWebhook extends ZiteWebhook | undefined = undefined,
  TRawInput = TInput,
> {
  description?: string;
  inputSchema?: SchemaLike<TInput, TRawInput>;
  /** Dokumentasi saja — tidak divalidasi. */
  outputSchema?: SchemaLike<unknown>;
  stream?: TStream;
  authenticated?: boolean;
  /** Bila diset, endpoint juga dipicu jadwal (lihat scheduler di apps/server). */
  schedule?: TSchedule;
  /** Bila diset, webhook masuk juga bisa memicu endpoint ini. */
  webhook?: TWebhook;
  execute: (
    params: {
      input: TInput;
      context: TSchedule extends ZiteSchedule
        ? ZiteRequestContext | ZiteScheduledContext
        : TWebhook extends ZiteWebhook
          ? ZiteRequestContext | ZiteScheduledContext
          : ZiteRequestContext;
    } & (TStream extends true ? { stream: ZiteStreamInterface } : {}),
  ) => Promise<TOutput> | TOutput;
}

export type InferSchemaType<T> = T extends { _output: infer U } ? U : T;

export function createEndpoint<
  TInput = unknown,
  TOutput = unknown,
  TStream extends boolean = false,
  TSchedule extends ZiteSchedule | undefined = undefined,
  TWebhook extends ZiteWebhook | undefined = undefined,
  TRawInput = TInput,
>(
  config: EndpointConfig<TInput, TOutput, TStream, TSchedule, TWebhook, TRawInput>,
): EndpointConfig<TInput, TOutput, TStream, TSchedule, TWebhook, TRawInput> {
  return config;
}

/* ------------------------------------------------------------------ *
 * ZiteError
 * ------------------------------------------------------------------ */

/**
 * Error yang aman ditampilkan ke pengguna. Dua bentuk konstruktor dipertahankan
 * persis seperti milik worker Zite: bentuk objek (disarankan) dan bentuk
 * positional yang dipakai kode lama.
 */
export class ZiteError extends Error {
  code: ZiteErrorCode;
  /** Pesan pendek, non-teknis, layak ditampilkan ke pengguna akhir. */
  userFacingMessage?: string;

  constructor(options: { code: ZiteErrorCode; message: string; userFacingMessage?: string });
  constructor(message: string, code?: ZiteErrorCode);
  constructor(
    optionsOrMessage: { code: ZiteErrorCode; message: string; userFacingMessage?: string } | string,
    legacyCode?: ZiteErrorCode,
  ) {
    if (typeof optionsOrMessage === 'string') {
      super(optionsOrMessage);
      this.code = legacyCode ?? 'INTERNAL_ERROR';
    } else {
      super(optionsOrMessage.message);
      this.code = optionsOrMessage.code;
      this.userFacingMessage = optionsOrMessage.userFacingMessage;
    }
    this.name = 'ZiteError';
  }

  /** Status HTTP yang dipakai server untuk error ini. */
  get httpStatus(): number {
    return HTTP_STATUS_BY_CODE[this.code] ?? 500;
  }
}

export const isZiteError = (e: unknown): e is ZiteError => e instanceof ZiteError;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface ProcessEnv {
      ZITE_APP_URL: string;
    }
  }
}
