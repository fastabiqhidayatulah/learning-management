# Rencana: Self-host Learning Management di SRV-TEKNIK + Fitur Bahasa Indonesia

> Dokumen ini hasil analisa (termasuk analisa statis REA) atas
> `D:\repos\learning-management`, lalu direncanakan agar sesuai
> **`D:\STRUKTUR-SERVER.md`** dan ditambah **bahasa Indonesia**.
> Daftar kerja ada di [`TODO.md`](./TODO.md).

---

## 0. Ringkasan

Repo ini adalah **Zite solution** (template LMS), **bukan aplikasi mandiri**.
Frontend-nya React + Vite, tetapi **seluruh backend-nya berjalan di runtime Zite
(cloud)**: 97 endpoint, database, auth, penjadwalan, upload, PDF, dan email semua
lewat bridge `zitejs`. Tidak ada satu pun proses server di repo ini.

Konsekuensinya: **"sesuai STRUKTUR-SERVER.md" tidak bisa dicapai hanya dengan
memindahkan folder.** Perlu menambahkan runtime + server sendiri di server NBI.
Rencana ini memilih pendekatan **Runtime Shim** (meniru permukaan modul Zite di
atas PostgreSQL lokal) supaya ±76.000 baris logika bisnis yang sudah ada **tidak
perlu ditulis ulang**.

---

## 1. Hasil analisa

### 1.1 Bentuk aplikasi (terverifikasi)

| Aspek | Kenyataan | Bukti |
|---|---|---|
| Dua app | `apps/learning-management` (admin, internal), `apps/learner-portal` (learner, eksternal) | `apps/*/index.html → src/main.tsx → App.tsx` |
| Router | `HashRouter` (tidak butuh rewrite rule di web server) | `apps/*/src/App.tsx` |
| Backend | **tidak ada** proses server; `express`/`morgan`/`body-parser` terdaftar tapi **tidak pernah diimpor** | grep `from 'express'` → 0 hasil |
| Endpoint | 97 file `createEndpoint({...})` (65 admin + 32 learner) — objek konfigurasi murni | `apps/*/src/api/*.ts` |
| `createEndpoint` | fungsi **identitas** (hanya tipe) — tidak ada runtime | `apps/*/.zite/backend.ts` |
| Pemanggil frontend | `createCaller(...)` dari `zitejs/caller` → `POST /api/<nama>` | `apps/*/.zite/api.ts` |
| Database | **tidak ada** `pg`, DSN, atau koneksi langsung. Semua via `zitejs/runtime` | `.zite/db.ts` |
| Auth | sesi di-inject runtime Zite (`context.user`, `window._ziteUsageToken`, `app-runtime.js`) | `packages/shared/server/people.ts:104,197` |
| Penjadwalan | endpoint `sendReminders` dgn `schedule: daily 14:00 UTC` — dipicu runtime Zite | `apps/learning-management/src/api/sendReminders.ts:26` |
| Upload/PDF/Email | bridge Zite: `zitejs/upload`, `zitejs/pdf`, `zitejs/email` | `src/api/certificatePdf.ts`, `packages/shared/server/email.ts` |
| Build | `tsc -b && vite build` per app → `dist/` statis. **Bisa offline.** | `apps/*/package.json` |
| Test | **tidak ada** (no vitest/jest, no test script) | — |
| Docs | ada README/CONTRIBUTING; **tidak ada `docs/`** | — |

### 1.2 Temuan REA (analisa statis, bukti)

Dijalankan: `rea analyze-javascript-application apps/learning-management --detail summary`
(`rea` 6.8.0, authority `shipped-artifact`, confidence `derived`).
Bundle bukti: 110 MB, `artifact sha256 aadd8fbe…3044`, 246 file diparse.

- Graf modul: **2.089 node, 2.713 edge** (`imports` 1890, `contains` 650, `exposes` 157, `calls` 14).
- Node `endpoint` terdeteksi; format artefak `directory`.
- **Kopling platform (yang wajib diganti)** — edge impor per specifier:

  | Specifier | Jumlah impor |
  |---|---|
  | `zitejs/backend` | 184 |
  | `zitejs/db` | 102 |
  | `zitejs/api` | 10 |
  | `zitejs/pdf` | 2 |
  | `zitejs/caller` | 2 |
  | `zitejs/runtime` | 2 |
  | `zitejs/vite-plugin` | 2 |

- Kopling internal (dipertahankan apa adanya): `@project/shared/server/sql` 211,
  `@project/shared/server/people` 204, `…/settings` 46, `…/courses` 40, dst.

> Artinya: **titik ganti sangat sedikit dan terpusat.** Mengganti 7 specifier
> platform = seluruh 97 endpoint dan `packages/shared` tetap kompilasi & jalan.

Batasan REA (dicatat apa adanya): analisa statis murni — **tidak** mengeksekusi
kode, resolusi paket `external`/`not-found` karena `node_modules` belum terpasang,
dan 303 entri `Resource constraint` (fakta per-file tetap tersimpan di node file).
Karena itu analisa ini dilengkapi pembacaan sumber langsung (bukan satu-satunya dasar).

### 1.3 Kondisi i18n: **nol**

Tidak ada i18next/react-intl/lingui, tidak ada `t()`, tidak ada file katalog
terjemahan. `<html lang="en">` hardcoded. Perkiraan **~2.000–3.000 string** di
~160 file TSX + ~40 modul server, **345 pemanggilan `ZiteError('…')`** berbahasa
Inggris, 11 template email, 2 perender sertifikat, plus CSV/ICS.

Titik yang sudah bagus (murah untuk i18n): label status/enum sudah terpusat di
`packages/shared/progress.ts`, `lessons.ts`, `ui/LessonMedia.tsx`, `server/settings.ts`.
Timezone sudah rapi dan terpisah dari locale.

**Jebakan terpenting:** nilai enum **disimpan sebagai string Inggris di DB dan
dipakai sebagai kunci logika/SQL** (`WHERE e."status" IN ('Not started','In progress')`).
Nilai tersimpan **tidak boleh** diterjemahkan — hanya label tampilan.

---

## 2. Konflik dengan `D:\STRUKTUR-SERVER.md` (gap)

| Aturan STRUKTUR-SERVER | Kondisi repo sekarang | Gap |
|---|---|---|
| §4.1 runner Node mandiri (`server.js`, `scripts/`, `public/`) | tidak ada server sama sekali | **Buat server sendiri** |
| §5 service via NSSM (bukan PM2), `Application`/`AppDirectory`/`AppStdout`/`AppStderr` | tidak ada proses untuk di-service | **Buat entrypoint + daftar NSSM** |
| §6 DB di `E:\Data\Database\PostgreSQL` | DB dikelola Zite | **Buat skema + user di Postgres lokal** |
| §8.3 source + `README.md`/`.env.example`/`.gitignore` | ada (bagus) | tambah `.env.example` baru |
| §8.6 `docs/` wajib | **tidak ada** | **dokumen ini = awal `docs/`** |
| §7 publik via cloudflared `pmp.web.id` | tidak relevan (Zite hosting) | **ingress 2 hostname** |
| §9.2 port unik ≥1222 | tidak ada port | pilih & catat port |
| §10 data besar di `E:\Data\…` | upload/PDF di Zite | **pindah ke `E:\Data\Application\…`** |
| — | **tidak ada test/lint/CI deploy** | tambahkan minimal smoke test |

---

## 3. Keputusan arsitektur

### 3.1 Opsi yang dipertimbangkan

- **A. Runtime Shim (direkomendasikan).** Tulis ulang **hanya primitif platform**
  (`zitejs/*`) di atas PostgreSQL lokal, plus satu server HTTP tipis yang
  memuat & men-dispatch 97 endpoint yang sudah ada. Logika bisnis tidak disentuh.
- **B. Tulis ulang backend** jadi Express/Nest konvensional. Menyentuh 97 endpoint
  + `packages/shared/server` + `.zite/*` — biaya besar, risiko regresi tinggi.
- **C. Tetap di Zite**, hanya deploy frontend. **Tidak memenuhi** aturan server
  (tidak ada program di `D:\apps`, tidak ada service, tidak ada DB lokal).

### 3.2 Rekomendasi: **Opsi A**

Kunci teknisnya: endpoint adalah objek `{ inputSchema, execute({input, context}) }`
dan `createEndpoint` hanya fungsi identitas. Jadi server kita cukup:

1. bundel `apps/<app>/src/api/*.ts` dengan **esbuild** (alias `zitejs/*` → shim kita),
2. peta `nama endpoint → execute`,
3. `POST /api/<nama>`: resolusi sesi → `context.user`, (opsional) validasi
   `inputSchema`, panggil `execute`, kirim output; error `ZiteError` → status+pesan.

### 3.3 Primitif platform yang harus diganti

| Modul lama | Ganti dengan | Isi |
|---|---|---|
| `zitejs/backend`, `zitejs/backend/base` | `packages/runtime/backend` | `createEndpoint` (identitas), `ZiteError`, tipe context |
| `zitejs/db`, `zitejs/runtime` | `packages/runtime/db` | `createTableClient` (findAll/findOne/create/update/delete/bulkCreate), `createSqlClient` (SELECT-only, cap 2000, timeout 10s, identifier SDK-name, view `ziteUsers`), `createAuthClient` — di atas `pg` |
| `zitejs/api`, `zitejs/caller` | `packages/runtime/caller` | `createCaller(name)` → `POST /api/<name>` (kirim cookie sesi) |
| `zitejs/auth` | `packages/runtime/auth` | `useAuth()` (user/isLoading/loginWithRedirect/logout) + tipe `User` |
| `zitejs/upload` | `packages/runtime/upload` | `uploadFile()` → disk lokal, kembalikan URL publik |
| `zitejs/pdf` | `packages/runtime/pdf` | `Pdf.renderHtml()` → HTML→PDF lokal |
| `zitejs/email` | `packages/runtime/email` | `Email`/`createEmailClient('email-1')` → SMTP |
| `zitejs/vite-plugin` (`ziteId`) + `insertHtml(app-runtime.js)` | **hapus** dari `vite.config.ts` | tidak ada runtime eksternal |

Aturan semantik yang harus ditiru shim (dipakai luas di kode):
- **teks kosong = `''`, bukan `NULL`** (lihat `packages/shared/server/sql.ts`).
- angka/hitung/sum datang sebagai **string** → `num()/str()/iso()` sudah menangani.
- `zite.sql` hanya SELECT; identifier SDK-name (`"Enrollments"`, `"courseId"`).
- `bulkCreate` maks 100 record/`call`; `withRetry` + `eachWrite` sudah menangani burst.
- urutan `ORDER BY created_at` dipakai → setiap tabel wajib punya `created_at`.

### 3.4 Skema database

Generate DDL dari **`zite.schema.json`** (sumber tunggal, 24 tabel):
- nama tabel = `name` (PascalCase, dikutip), kolom = `sdkName` (camelCase, dikutip);
- `id uuid pk default gen_random_uuid()`, `created_at`, `updated_at`;
- pemetaan tipe: text/url/email/long_text/single_select/attachment/linked/user → `text`
  (default `''`), `number` → `numeric`, `checkbox` → `boolean`, tanggal → `date`,
  datetime → `timestamptz`;
- view `"ziteUsers"(id, name, email, firstName, lastName, image)`;
- **hapus keras** (hard delete) untuk menyederhanakan — hindari emulasi soft-delete,
  kecuali ternyata ada alur yang butuh restore.

### 3.5 Auth (self-host, wajib baru)

Runtime Zite tidak ada lagi → perlu identitas sendiri:
- tabel `AuthUsers` (id, email, name, image, firstName, lastName, passwordHash);
- login email+password (argon2/bcrypt) + cookie sesi httpOnly/bertanda tangan
  (`iron-session` atau `express-session`), plus alur undangan (status `Invited`
  dan template email "Invitation" **sudah ada** di app);
- `people.ts` (`getActor`/`getLearner`) **tidak diubah** — cukup isi `context.user`
  dari sesi + sediakan view `ziteUsers`.

---

## 4. Pemetaan konkret ke aturan server

| Aturan | Nilai yang dipakai |
|---|---|
| Nama app (§8.1) | `learning-management` (admin), `learner-portal` (learner) |
| Source/git (§8.3) | `D:\repos\learning-management` (sudah ada, branch `main`) |
| Program (§8.2) | `D:\apps\learning-management`, `D:\apps\learner-portal` |
| Log (§8.4) | `D:\logs\learning-management\{stdout,stderr}.log`, `D:\logs\learner-portal\{stdout,stderr}.log` |
| Data kecil (§8.5) | `D:\apps\<app>\data` |
| Data besar (§8.5) | `E:\Data\Application\learning-management\{uploads,pdf}`, `…\learner-portal\…` |
| Database (§8.8) | PostgreSQL `E:\Data\Database\PostgreSQL` — database `learning_management`, role `learning_management_app` |
| Backup (§8.8) | `E:\Data\Backup\learning-management\` (dump `.sql` harian) |
| Service (§8.7) | NSSM: `LearningManagement` (3360), `LearnerPortal` (3361); `StartType` Automatic |
| Port (§9.2) | **3360** (admin), **3361** (learner) — diverifikasi bebas dari daftar listen saat ini |
| Publik (§7) | ingress `lms.pmp.web.id → http://127.0.0.1:3360`, `learn.pmp.web.id → http://127.0.0.1:3361`; bind **127.0.0.1** saja |
| Docs (§8.6) | `docs/` di repo ini + catatan di `D:\documents` |

Contoh NSSM (mengikuti `references/nssm-service.md`):

```powershell
$nssm='D:\apps\nssm\win64\nssm.exe'
New-Item -ItemType Directory -Force 'D:\logs\learning-management' | Out-Null
& $nssm install LearningManagement 'C:\Program Files\nodejs\node.exe' 'D:\apps\learning-management\server.js'
& $nssm set LearningManagement AppDirectory 'D:\apps\learning-management'
& $nssm set LearningManagement AppStdout 'D:\logs\learning-management\learning-management-stdout.log'
& $nssm set LearningManagement AppStderr 'D:\logs\learning-management\learning-management-stderr.log'
& $nssm set LearningManagement Start SERVICE_AUTO_START
```

---

## 5. Fitur Bahasa Indonesia

**Pendekatan:** i18n penuh (bukan sekadar string replacement), `en` sebagai basis,
`id` sebagai target, default app = **Bahasa Indonesia**.

1. **Paket baru `packages/shared/i18n/`** — `en.ts`, `id.ts`, `t(key, params)`,
   `LocaleProvider`, `useT()`; `formatDate/formatNumber` sadar-locale
   (date-fns + `date-fns/locale/id`), `plural()` disederhanakan (ID tanpa plural).
2. **Provider** di root kedua app; `<html lang>` jadi dinamis.
3. **Peta label → key** (murah, sudah terpusat): `DUE_STATE_LABEL`,
   `CERTIFICATE_STATE_LABEL`, `LESSON_TYPE_META`, `QUESTION_TYPE_LABEL`,
   `FILE_KIND_LABEL`, `TYPE_META`, `TRIGGER_INFO`, `MERGE_TAGS`, `DEFAULTS`.
   **Nilai enum tersimpan tetap Inggris**; konversi nilai→key hanya di batas render
   (termasuk dropdown filter yang dibangun dari nilai mentah).
4. **Lapisan format** — de-duplikasi `apps/*/src/lib/format.ts` ke helper bersama;
   ganti `'en-US'`/`'en-CA'` hardcoded di `certificateDates.ts`, `merge.ts`,
   `learnFormat.ts`, `reminders.ts`.
5. **Pesan server** — 345 `ZiteError('…')`: ganti ke **kode error** yang
   diterjemahkan di klien (+ `userFacingMessage`).
6. **Notifikasi in-app** — sekarang **disimpan sudah jadi Inggris**. Ubah jadi
   simpan `type` + params, render saat dibaca.
7. **Email (11 template)** — tambah dimensi `locale` (kolom di `EmailTemplates`)
   dan seed default `id`, atau render merge/subject/body saat kirim.
8. **Sertifikat** — lokalkan `packages/shared/certificateHtml.ts` (server/PDF) dan
   `packages/shared/ui/CertificateArt.tsx` (layar) — keduanya cermin, jaga sinkron.
9. **Skema** — tambah `locale` di `Settings` (default org) dan `People` (override
   user) pada `zite.schema.json`, lalu alirkan ke `saveSettings`/`saveProfile`.
10. **CSV/ICS** — header & sel ekspor, dan `.ics` di `learnFormat.ts`.
11. **Konten demo** (`seed/content.ts`, `seed/org.ts`, ~82 string) — putuskan:
    diterjemahkan juga atau dianggap data.

Catatan tata letak: teks Indonesia biasanya lebih panjang dari Inggris — cek
tombol/nav/tabel berlebar tetap dan spot `truncate`/`nowrap`.

---

## 6. Fase pelaksanaan

- **Fase 0 — Fondasi & keputusan.** Konfirmasi §8 di bawah; buat `packages/runtime`
  kerangka + `apps/server` kerangka + skrip `build:server` (esbuild).
- **Fase 1 — Runtime shim + DB.** Implement `db` (table client + sql client) di atas
  `pg`; generate DDL dari `zite.schema.json`; buat DB/role; seed `Settings` awal.
- **Fase 2 — Server + dispatch endpoint.** `POST /api/<nama>`, resolusi sesi,
  validasi `inputSchema`, error mapping; serve `dist/` kedua app.
- **Fase 3 — Auth.** Tabel `AuthUsers`, login/logout/sesi, `useAuth` shim, undangan.
- **Fase 4 — Bridge sisi server.** upload (disk E:), PDF lokal, email SMTP,
  scheduler `sendReminders` (node-cron di proses admin).
- **Fase 5 — Deploy sesuai STRUKTUR-SERVER.** `D:\apps`, `D:\logs`, NSSM, port,
  cloudflared `lms`/`learn`, DNS CNAME Proxied, catat ke tabel port & hostname.
- **Fase 6 — i18n tulang.** `packages/shared/i18n`, provider, peta label, format,
  skema `locale`, switcher bahasa.
- **Fase 7 — i18n isi.** String UI admin → learner → pesan server → notifikasi →
  email → sertifikat → CSV/ICS.
- **Fase 8 — Kualitas.** Smoke test end-to-end, `docs/` lengkap (deployment,
  database, changelog, API/config), backup rutin.

---

## 7. Lingkungan & catatan operasional (hasil uji di SRV-TEKNIK)

Ditemukan saat pelaksanaan Fase 0 — penting agar tidak terulang di deploy:

1. **`yarn` tidak terpasang.** Hanya `npm` + `corepack`. Node **v24.18.0**,
   corepack **0.35.0**. Selalu pakai **`corepack yarn …`** (corepack mengambil
   yarn 1.22.22 sesuai `packageManager` di `package.json`).
2. **Registry default yarn tidak bisa diakses.** `registry.yarnpkg.com` gagal
   ("Couldn't find package … on the npm registry"), sedangkan
   `registry.npmjs.org` normal (1,4 s). Perbaikan yang dipakai (mesin, bukan repo):
   `corepack yarn config set registry https://registry.npmjs.org`
   → tertulis di `C:\Users\Administrator\.yarnrc`.
3. **`NODE_ENV=production` membuat devDependency dilewati** (typescript, vite,
   `@vitejs/plugin-react` tidak terpasang). Selalu install dengan
   **`corepack yarn install --production=false`** sebelum build SPA.
4. **`--prefer-offline` jangan dipakai** — resolusi rentang versi gagal walau
   paketnya ada di cache. Cache yarn v6 (`…\Yarn\Cache\v6`) sudah berisi ±600
   paket termasuk `zitejs@0.9.115`.
5. **Unduhan lambat** — install penuh pertama ±4 menit. Karena itu dependensi
   server sengaja ditekan seminimal mungkin (tanpa multer, tanpa node-cron).

---

## 8. Risiko & mitigasi

| Risiko | Dampak | Mitigasi |
|---|---|---|
| Semantik DB Zite (teks `''`, cap 2000, `ziteUsers`) tak persis sama | bug halus di laporan/agregat | uji endpoint laporan satu per satu vs data seed |
| Soft-delete / `zite.auth` jarang dipakai tapi kritis | fitur orang/profil rusak | audit semua pemanggilan `delete()` & `zite.auth` |
| PDF butuh Chromium (playwright) | installer + RAM di server | putuskan mesin PDF di Fase 0 |
| ~2.000–3.000 string i18n | pekerjaan besar & rawan lupa | ekstraksi bertahap + ratchet (string baru wajib key) |
| Nilai enum Inggris di DB vs label | filter tampil Inggris | peta nilai→key wajib di semua picker |
| Tidak ada test di repo | regresi tak terdeteksi | tambah smoke test sebelum Fase 5 |

---

## 9. Keputusan

**TERKUNCI**

- **Arah** — jalankan penuh **lepas dari Zite** (Opsi A, §3.2). Tidak ada
  akun/workspace Zite saat runtime; `zitejs` hanya dipakai selama transisi
  (alias + tipe) lalu dilepas. Sasaran akhir: server sendiri + PostgreSQL lokal +
  SMTP + penyimpanan disk.
- **Auth** — email + password lokal, dengan alur undangan.
- **PDF** — Playwright + Chromium.
- **Cakupan i18n** — UI + email + notifikasi + sertifikat (konten demo = data).
- **Bahasa default** — Indonesia, `en` sebagai cadangan.
- **Service & publikasi** — 2 service: `LearningManagement` :3360 → `lms.pmp.web.id`,
  `LearnerPortal` :3361 → `learn.pmp.web.id`.

**Masih terbuka**

1. **Email** — pakai SMTP server mana (relay internal / Gmail / lain) dan alamat
   pengirim? *(tidak memblokir Fase 0–3; dibutuhkan di Fase 4)*

**Selesai**

- **Data awal** — dipakai **seed bawaan** (`seedWorkspace`), sudah dijalankan:
  ke-24 tabel terisi (Fernwood Supply Co., 39 orang, 12 kursus, 4 jalur).
- **Timezone default** — `Asia/Jakarta` (`DEFAULT_TIMEZONE` di `packages/shared/server/settings.ts`).
- **Bahasa** — `packages/shared/i18n` + `Settings.defaultLocale` (default `id`).
