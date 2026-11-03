#!/usr/bin/env node
/**
 * Hasilkan `schema.sql` dari `zite.schema.json` — sumber tunggal 24 tabel.
 *
 * Pemakaian:
 *   node packages/runtime/scripts/gen-schema.mjs [zite.schema.json] [schema.sql]
 *
 * Nama tabel di SQL memakai identifier SDK (PascalCase, mis. "GroupMembers"),
 * BUKAN nama tampilan ("Group Members"). Itu yang dipakai kode aplikasi di SQL
 * mentah dan di createTableClient(). Nama kolom = sdkName (camelCase).
 *
 * Aturan penyimpanan yang ditiru dari Zite: kolom teks yang tidak diset = ''
 * (bukan NULL), angka = numeric (dibaca sebagai string), checkbox = boolean.
 *
 * Catatan: single_select menyimpan LABEL ("Anyone"), bukan value internal —
 * itu yang dipakai aplikasi di perbandingan, jadi cukup text.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

const schemaPath = process.argv[2] ?? path.join(repoRoot, 'zite.schema.json');
const outPath = process.argv[3] ?? path.resolve(here, '..', 'schema.sql');

const q = (n) => `"${String(n).replace(/"/g, '""')}"`;
const pascal = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function sqlType(type) {
  switch (type) {
    case 'number':
      return 'numeric';
    case 'checkbox':
      return 'boolean NOT NULL DEFAULT false';
    case 'date':
      return 'date';
    case 'datetime':
      return 'timestamptz';
    default:
      // single_line_text, long_text, url, email, single_select, multi_select,
      // attachment, linked_record, user — semuanya disimpan sebagai teks.
      return "text NOT NULL DEFAULT ''";
  }
}

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

const tables = schema.tables.map((t) => ({
  identifier: pascal(t.sdkName),
  name: t.name,
  columns: t.fields.map((f) => ({
    name: f.sdkName,
    label: f.definition.name,
    type: f.definition.type,
  })),
}));

const seen = new Set();
for (const t of tables) {
  if (seen.has(t.identifier)) throw new Error(`Identifier tabel duplikat: ${t.identifier}`);
  seen.add(t.identifier);
}

const lines = [];
lines.push('-- Dibuat otomatis oleh packages/runtime/scripts/gen-schema.mjs');
lines.push(`-- Sumber: ${path.relative(repoRoot, schemaPath).replace(/\\/g, '/')}`);
lines.push(`-- ${tables.length} tabel. Jangan edit manual — ubah zite.schema.json lalu generate ulang.`);
lines.push('');
lines.push('CREATE EXTENSION IF NOT EXISTS pgcrypto;');
lines.push('');

// updated_at diurus database supaya tabel klien tidak perlu memikirkannya.
lines.push(`CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;`);
lines.push('');

for (const t of tables) {
  lines.push(`-- ${t.name}`);
  lines.push(`CREATE TABLE IF NOT EXISTS ${q(t.identifier)} (`);
  lines.push('  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),');
  for (const c of t.columns) {
    lines.push(`  ${q(c.name)} ${sqlType(c.type)},  -- ${c.label} (${c.type})`);
  }
  lines.push('  "created_at" timestamptz NOT NULL DEFAULT now(),');
  lines.push('  "updated_at" timestamptz NOT NULL DEFAULT now()');
  lines.push(');');
  lines.push(`DROP TRIGGER IF EXISTS ${q(`trg_${t.identifier}_updated`)} ON ${q(t.identifier)};`);
  lines.push(`CREATE TRIGGER ${q(`trg_${t.identifier}_updated`)} BEFORE UPDATE ON ${q(t.identifier)}`);
  lines.push('  FOR EACH ROW EXECUTE FUNCTION set_updated_at();');
  lines.push('');
}

// Akun masuk (pengganti identitas Zite). Password di-hash di aplikasi.
lines.push('-- Akun masuk lokal (pengganti identitas Zite)');
lines.push('CREATE TABLE IF NOT EXISTS "AuthUsers" (');
lines.push('  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),');
lines.push(`  "email" text NOT NULL UNIQUE,`);
lines.push(`  "name" text NOT NULL DEFAULT '',`);
lines.push(`  "firstName" text NOT NULL DEFAULT '',`);
lines.push(`  "lastName" text NOT NULL DEFAULT '',`);
lines.push('  "image" text,');
lines.push('  "passwordHash" text,');
lines.push('  "created_at" timestamptz NOT NULL DEFAULT now(),');
lines.push('  "updated_at" timestamptz NOT NULL DEFAULT now()');
lines.push(');');
lines.push('');

// View yang dibaca packages/shared/server/people.ts (profileFor).
lines.push('-- View yang dibaca people.ts: SELECT "name", "image" FROM "ziteUsers"');
lines.push('CREATE OR REPLACE VIEW "ziteUsers" AS');
lines.push('  SELECT "id", "name", "email", "firstName", "lastName", "image" FROM "AuthUsers";');
lines.push('');

writeFileSync(outPath, lines.join('\n'), 'utf8');

const counts = {};
for (const t of tables) for (const c of t.columns) counts[c.type] = (counts[c.type] ?? 0) + 1;
console.log(`schema.sql ditulis: ${outPath}`);
console.log(`  tabel: ${tables.length} | kolom data: ${tables.reduce((n, t) => n + t.columns.length, 0)}`);
console.log('  tipe:', Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', '));
