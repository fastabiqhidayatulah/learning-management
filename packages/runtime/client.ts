/**
 * Runtime lokal — permukaan `zitejs/runtime`.
 *
 * Menggantikan `createTableClient` / `createSqlClient` / `createAuthClient` /
 * `createEmailClient` milik Zite dengan implementasi di atas PostgreSQL biasa.
 *
 * Berkas `.zite/db.ts` yang sudah ada TIDAK diubah: ia tetap jadi sumber tipe
 * (24 tabel + view `ziteUsers`), dan cukup diarahkan ke sini lewat alias
 * `zitejs/runtime`. Karena itu 97 endpoint + `packages/shared` nol perubahan.
 *
 * Semantik yang sengaja ditiru dari Zite (dipakai luas di kode aplikasi):
 *   - kolom teks yang tidak diset disimpan sebagai '' — BUKAN NULL.
 *   - angka, hitungan, dan jumlah kembali sebagai string (lihat num()/str()).
 *   - `zite.sql` hanya SELECT, identifier memakai nama SDK, cap 2000 baris.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool, types as pgTypes, type PoolClient } from 'pg';

/* ------------------------------------------------------------------ *
 * Parser tipe
 * ------------------------------------------------------------------ */

/**
 * DATE harus kembali sebagai string 'YYYY-MM-DD', bukan Date.
 * Kalau di-parse jadi Date, `day()` di packages/shared/server/sql.ts memakai
 * toISOString() sehingga di zona +07:00 (WIB) tanggalnya bergeser satu hari.
 * Ini bug data yang halus, jadi di-pin di sini.
 */
const DATE_OID = 1082;
pgTypes.setTypeParser(DATE_OID, (v: string) => v);

/* ------------------------------------------------------------------ *
 * Skema (zite.schema.json) — sumber tunggal nama tabel & kolom
 * ------------------------------------------------------------------ */

type FieldType =
  | 'single_line_text'
  | 'long_text'
  | 'url'
  | 'email'
  | 'single_select'
  | 'multi_select'
  | 'number'
  | 'checkbox'
  | 'date'
  | 'date_time'
  | 'attachment'
  | 'linked_record'
  | 'user'
  | string;

type ColumnInfo = { sdkName: string; type: FieldType; label: string };
type TableInfo = { name: string; columns: Map<string, ColumnInfo> };

const SCHEMA_CANDIDATES = [
  process.env.LMS_SCHEMA_PATH,
  path.resolve(process.cwd(), 'zite.schema.json'),
  path.resolve(process.cwd(), '../../zite.schema.json'),
].filter(Boolean) as string[];

let tables: Map<string, TableInfo> | null = null;

function loadTables(): Map<string, TableInfo> {
  if (tables) return tables;
  let raw: string | null = null;
  let used = '';
  for (const p of SCHEMA_CANDIDATES) {
    try {
      raw = readFileSync(p, 'utf8');
      used = p;
      break;
    } catch {
      /* coba kandidat berikutnya */
    }
  }
  if (!raw) {
    throw new Error(
      `zite.schema.json tidak ditemukan. Set LMS_SCHEMA_PATH. Dicari: ${SCHEMA_CANDIDATES.join(', ')}`,
    );
  }
  const parsed = JSON.parse(raw) as {
    tables: {
      name: string;
      sdkName: string;
      fields: { sdkName: string; definition: { name: string; type: FieldType } }[];
    }[];
  };
  tables = new Map();
  for (const t of parsed.tables) {
    const columns = new Map<string, ColumnInfo>();
    for (const f of t.fields) {
      columns.set(f.sdkName, { sdkName: f.sdkName, type: f.definition.type, label: f.definition.name });
    }
    // Identifier SQL = PascalCase(sdkName), mis. "GroupMembers" — BUKAN nama
    // tampilan "Group Members". Itu yang dipakai createTableClient() dan SQL mentah.
    const identifier = t.sdkName.charAt(0).toUpperCase() + t.sdkName.slice(1);
    tables.set(identifier, { name: identifier, columns });
  }
  if (process.env.LMS_DEBUG) console.error(`[runtime] skema dimuat dari ${used}: ${tables.size} tabel`);
  return tables;
}

/** Tipe yang disimpan sebagai TEXT (kosong = '', bukan NULL). */
const TEXT_TYPES = new Set([
  'single_line_text',
  'long_text',
  'url',
  'email',
  'single_select',
  'multi_select',
  'attachment',
  'linked_record',
  'user',
]);

const isTextColumn = (col: ColumnInfo | undefined) => !!col && TEXT_TYPES.has(col.type);
const isNumberColumn = (col: ColumnInfo | undefined) => col?.type === 'number';
const isBoolColumn = (col: ColumnInfo | undefined) => col?.type === 'checkbox';

/* ------------------------------------------------------------------ *
 * Koneksi
 * ------------------------------------------------------------------ */

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      host: process.env.PGHOST ?? '127.0.0.1',
      port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
      database: process.env.PGDATABASE ?? 'learning_management',
      user: process.env.PGUSER ?? 'learning_management_app',
      password: process.env.PGPASSWORD,
      max: Number(process.env.PG_POOL_MAX ?? 10),
      statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 10_000),
      idleTimeoutMillis: 30_000,
    });
    pool.on('error', (e) => console.error('[runtime:pg] idle client error', e));
  }
  return pool;
}

/** Tutup pool (dipakai skrip/job yang berumur pendek). */
export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Query mentah untuk kebutuhan server sendiri (auth, health check).
 * Endpoint aplikasi TIDAK memakai ini — mereka lewat `zite.sql` (SELECT-only).
 */
export async function rawQuery<T = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const res = await getPool().query(text, values);
  return res.rows as T[];
}

const q = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

/* ------------------------------------------------------------------ *
 * Filter
 * ------------------------------------------------------------------ */

const OPERATORS = ['contains', 'not', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte'] as const;

class Params {
  values: unknown[] = [];
  add(v: unknown) {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

function isOperatorObject(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.keys(v).some((k) => (OPERATORS as readonly string[]).includes(k));
}

function buildWhere(filters: Record<string, unknown> | undefined, p: Params): string {
  if (!filters) return '';
  const clauses: string[] = [];
  for (const [field, value] of Object.entries(filters)) {
    const col = q(field);
    if (value === undefined) {
      throw new Error(
        `Filter "${field}" bernilai undefined — itu akan mengembalikan record sembarang. Periksa nilainya dulu.`,
      );
    }
    if (isOperatorObject(value)) {
      for (const [op, operand] of Object.entries(value)) {
        switch (op) {
          case 'contains':
            clauses.push(`${col} ILIKE ${p.add(`%${String(operand)}%`)}`);
            break;
          case 'not':
            clauses.push(operand === null ? `${col} IS NOT NULL` : `${col} <> ${p.add(operand)}`);
            break;
          case 'in':
            clauses.push(
              (operand as unknown[]).length ? `${col} = ANY(${p.add(operand)})` : 'FALSE',
            );
            break;
          case 'notIn':
            if ((operand as unknown[]).length) clauses.push(`NOT (${col} = ANY(${p.add(operand)}))`);
            break;
          case 'lt':
            clauses.push(`${col} < ${p.add(operand)}`);
            break;
          case 'lte':
            clauses.push(`${col} <= ${p.add(operand)}`);
            break;
          case 'gt':
            clauses.push(`${col} > ${p.add(operand)}`);
            break;
          case 'gte':
            clauses.push(`${col} >= ${p.add(operand)}`);
            break;
          default:
            throw new Error(`Operator filter tidak dikenal: "${op}"`);
        }
      }
      continue;
    }
    if (value === null) clauses.push(`${col} IS NULL`);
    else clauses.push(`${col} = ${p.add(value)}`);
  }
  return clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
}

function applySort(sort: unknown): string {
  if (!sort) return '';
  const parts: string[] = [];
  const push = (field: string, dir: unknown) =>
    parts.push(`${q(field)} ${String(dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC'}`);
  if (Array.isArray(sort)) {
    for (const s of sort) {
      if (typeof s === 'string') push(s, 'asc');
      else if (s && typeof s === 'object') {
        const e = s as Record<string, unknown>;
        const field = (e.field ?? e.sdkName ?? e.name) as string | undefined;
        if (field) push(field, e.direction ?? e.dir ?? e.order);
      }
    }
  } else if (typeof sort === 'object') {
    for (const [field, dir] of Object.entries(sort as Record<string, unknown>)) push(field, dir);
  }
  return parts.length ? ` ORDER BY ${parts.join(', ')}` : '';
}

/* ------------------------------------------------------------------ *
 * Normalisasi nilai tulis
 * ------------------------------------------------------------------ */

function normaliseWrites(
  table: TableInfo,
  record: Record<string, unknown>,
): { cols: string[]; values: unknown[] } {
  const cols: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(record)) {
    const col = table.columns.get(key);
    if (!col) {
      if (process.env.LMS_DEBUG) console.error(`[runtime] kolom tak dikenal diabaikan: ${table.name}.${key}`);
      continue;
    }
    cols.push(key);
    if (value === null || value === undefined) {
      // Aturan Zite: kolom teks kosong = '', bukan NULL.
      values.push(isTextColumn(col) ? '' : null);
      continue;
    }
    if (value instanceof Date) values.push(value);
    else if (isBoolColumn(col)) values.push(value === true || value === 'true');
    else if (isNumberColumn(col)) values.push(value === '' ? null : Number(value));
    else values.push(value);
  }
  return { cols, values };
}

/* ------------------------------------------------------------------ *
 * createTableClient
 * ------------------------------------------------------------------ */

export interface FindAllParams {
  filters?: Record<string, unknown>;
  sort?: unknown;
  offset?: number;
  limit?: number;
  fields?: string[];
}

/** Hasil update: record dikembalikan dua kali (datar dan di bawah `fields`) — sama seperti Zite. */
export type UpdateResult<TRecord> = Partial<TRecord> & { id: string; fields: Partial<TRecord> };

/** Hasil bulkCreate: seperti Zite, setiap record membawa bentuk datar sekaligus `fields`. */
export type BulkCreateResult<TRecord> = {
  success: boolean;
  records: (TRecord & { fields: Omit<TRecord, 'id'> })[];
};

export interface TableClient<TRecord, TInput = TRecord> {
  findAll(params?: FindAllParams): Promise<{ records: TRecord[]; hasMore: boolean }>;
  findOne(params?: { id?: string; filters?: Record<string, unknown>; fields?: string[] }): Promise<TRecord | undefined>;
  /** `Partial` — endpoint mengirim hanya kolom yang berubah, persis seperti SDK Zite. */
  create(params: { record: Partial<TInput> }): Promise<TRecord>;
  update(params: { id: string; record: Partial<TInput> }): Promise<UpdateResult<TRecord>>;
  delete(params: { id: string }): Promise<{ success: true; id: string }>;
  bulkCreate(params: { records: Partial<TInput>[]; matchOn?: string[] }): Promise<BulkCreateResult<TRecord>>;
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

export function createTableClient<TRecord extends { id: string }, TInput = TRecord>(
  tableName: string,
): TableClient<TRecord, TInput> {
  const table = () => {
    const t = loadTables().get(tableName);
    if (!t) throw new Error(`Tabel "${tableName}" tidak ada di zite.schema.json`);
    return t;
  };

  return {
    async findAll(params = {}) {
      const t = table();
      const p = new Params();
      const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const offset = params.offset ?? 0;
      const fields = params.fields?.length ? params.fields.map(q).join(', ') : '*';
      const where = buildWhere(params.filters, p);
      const order = applySort(params.sort);
      const sql = `SELECT ${fields} FROM ${q(t.name)}${where}${order} LIMIT ${p.add(limit + 1)} OFFSET ${p.add(offset)}`;
      const res = await getPool().query(sql, p.values);
      const hasMore = res.rows.length > limit;
      return { records: (hasMore ? res.rows.slice(0, limit) : res.rows) as TRecord[], hasMore };
    },

    async findOne(params = {}) {
      const t = table();
      const p = new Params();
      const where = params.id ? ` WHERE ${q('id')} = ${p.add(params.id)}` : buildWhere(params.filters, p);
      const fields = params.fields?.length ? params.fields.map(q).join(', ') : '*';
      const res = await getPool().query(`SELECT ${fields} FROM ${q(t.name)}${where} LIMIT 1`, p.values);
      return res.rows[0] as TRecord | undefined;
    },

    async create({ record }) {
      const t = table();
      const { cols, values } = normaliseWrites(t, record as Record<string, unknown>);
      const names = cols.map(q).join(', ');
      const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
      const res = await getPool().query(
        `INSERT INTO ${q(t.name)} (${names}) VALUES (${placeholders}) RETURNING *`,
        values,
      );
      return res.rows[0] as TRecord;
    },

    async update({ id, record }) {
      const t = table();
      const { cols, values } = normaliseWrites(t, record as Record<string, unknown>);
      if (!cols.length) return { id, fields: {} } as UpdateResult<TRecord>;
      const sets = cols.map((c, i) => `${q(c)} = $${i + 1}`).join(', ');
      values.push(id);
      const res = await getPool().query(
        `UPDATE ${q(t.name)} SET ${sets} WHERE ${q('id')} = $${values.length} RETURNING *`,
        values,
      );
      const row = res.rows[0] as TRecord | undefined;
      if (!row) throw new Error(`${tableName} ${id} tidak ditemukan`);
      return { ...(record as Partial<TRecord>), id, fields: record as Partial<TRecord> };
    },

    async delete({ id }) {
      // Hapus keras. Zite memakai soft-delete, tapi aplikasi ini tidak punya
      // alur restore — jadi hard delete lebih sederhana dan tidak butuh emulasi
      // filtering di createSqlClient.
      const t = table();
      const p = new Params();
      await getPool().query(`DELETE FROM ${q(t.name)} WHERE ${q('id')} = ${p.add(id)}`, p.values);
      return { success: true, id };
    },

    async bulkCreate({ records, matchOn }) {
      const t = table();
      if (!records.length) return { success: true, records: [] };
      const out: (TRecord & { fields: Omit<TRecord, 'id'> })[] = [];
      // Zite membatasi 100 record per panggilan.
      for (let i = 0; i < records.length; i += 100) {
        const batch = records.slice(i, i + 100);
        const { cols, rows } = bulkShape(t, batch as Record<string, unknown>[]);
        const p = new Params();
        const tuples = rows
          .map((r) => `(${r.map((v) => p.add(v)).join(', ')})`)
          .join(', ');
        let onConflict = '';
        if (matchOn?.length) {
          const target = matchOn.map(q).join(', ');
          const updates = cols
            .filter((c) => !matchOn.includes(c))
            .map((c) => `${q(c)} = EXCLUDED.${q(c)}`)
            .join(', ');
          onConflict = ` ON CONFLICT (${target}) DO ${updates ? `UPDATE SET ${updates}` : 'NOTHING'}`;
        }
        const res = await getPool().query(
          `INSERT INTO ${q(t.name)} (${cols.map(q).join(', ')}) VALUES ${tuples}${onConflict} RETURNING *`,
          p.values,
        );
        for (const row of res.rows as TRecord[]) {
          const { id: _omitted, ...rest } = row as TRecord & { id: string };
          out.push({ ...row, fields: rest as Omit<TRecord, 'id'> });
        }
      }
      return { success: true, records: out };
    },
  };
}

/** Bentuk satu batch insert dari daftar record yang mungkin punya kolom berbeda. */
function bulkShape(table: TableInfo, records: Record<string, unknown>[]) {
  const cols = [...new Set(records.flatMap((r) => Object.keys(r).filter((k) => table.columns.has(k))))];
  const rows = records.map((r) => {
    const { values } = normaliseWrites(table, Object.fromEntries(cols.map((c) => [c, r[c]])));
    return values;
  });
  return { cols, rows };
}

/* ------------------------------------------------------------------ *
 * createSqlClient
 * ------------------------------------------------------------------ */

export interface SqlResult {
  rows: Record<string, unknown>[];
  columns: { name: string; originalName: string }[];
  rowCount: number;
  truncated: boolean;
}

export interface SqlClient {
  (params: { query: string; params?: unknown[] }): Promise<SqlResult>;
}

const SQL_ROW_CAP = 2000;
const SELECT_ONLY = /^\s*(with|select)\b/i;

export function createSqlClient(): SqlClient {
  return async ({ query, params = [] }) => {
    const trimmed = query.trim().replace(/;+\s*$/, '');
    if (!SELECT_ONLY.test(trimmed)) {
      throw new Error('zite.sql() hanya menerima SELECT (termasuk WITH). Pakai tabel .create/.update/.delete untuk menulis.');
    }
    // Bungkus supaya cap 2000 dihitung di database, bukan setelah menarik semua baris.
    const wrapped = `SELECT * FROM (${trimmed}) AS _zite_q LIMIT ${SQL_ROW_CAP + 1}`;
    let client: PoolClient | null = null;
    try {
      client = await getPool().connect();
      const res = await client.query({ text: wrapped, values: params });
      const truncated = res.rows.length > SQL_ROW_CAP;
      const rows = truncated ? res.rows.slice(0, SQL_ROW_CAP) : res.rows;
      return {
        rows,
        columns: res.fields.map((f) => ({ name: f.name, originalName: f.name })),
        rowCount: rows.length,
        truncated,
      };
    } finally {
      client?.release();
    }
  };
}

/* ------------------------------------------------------------------ *
 * createAuthClient
 * ------------------------------------------------------------------ */

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  firstName?: string;
  lastName?: string;
  image: string | null;
}

export interface AuthClient<TUser extends AuthUser = AuthUser> {
  findAllUsers(params?: FindAllParams & { appIds?: string[] }): Promise<{ users: TUser[]; hasMore: boolean }>;
  updateUserProfile(
    userId: string,
    patch: { firstName?: string; lastName?: string; image?: string | null },
  ): Promise<{ id: string }>;
}

export function createAuthClient<TUser extends AuthUser = AuthUser>(): AuthClient<TUser> {
  return {
    async findAllUsers(params = {}) {
      const p = new Params();
      const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
      const where = buildWhere(params.filters, p);
      const order = applySort(params.sort);
      const res = await getPool().query(
        `SELECT * FROM "AuthUsers"${where}${order} LIMIT ${p.add(limit + 1)} OFFSET ${p.add(params.offset ?? 0)}`,
        p.values,
      );
      const hasMore = res.rows.length > limit;
      const rows = hasMore ? res.rows.slice(0, limit) : res.rows;
      return {
        users: rows.map((r) => ({
          id: String(r.id),
          name: String(r.name ?? ''),
          email: String(r.email ?? ''),
          firstName: r.firstName ? String(r.firstName) : undefined,
          lastName: r.lastName ? String(r.lastName) : undefined,
          image: r.image ? String(r.image) : null,
        })) as TUser[],
        hasMore,
      };
    },

    async updateUserProfile(userId, patch) {
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) continue;
        values.push(v);
        sets.push(`${q(k)} = $${values.length}`);
      }
      if (!sets.length) return { id: userId };
      values.push(userId);
      await getPool().query(
        `UPDATE "AuthUsers" SET ${sets.join(', ')}, ${q('updated_at')} = NOW() WHERE ${q('id')} = $${values.length}`,
        values,
      );
      return { id: userId };
    },
  };
}

/* ------------------------------------------------------------------ *
 * Email — implementasi di ./email.ts. Di-re-export supaya
 * `import { createEmailClient } from 'zitejs/runtime'` dan
 * `export type { EmailBlock, … } from 'zitejs/runtime'` tetap bekerja.
 * ------------------------------------------------------------------ */

export { createEmailClient } from './email.js';
export type { EmailBlock, EmailClient, SendEmailParams, SendEmailResult } from './email.js';
