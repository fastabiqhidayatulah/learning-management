# TODO — Self-host LMS + Bahasa Indonesia

> Daftar kerja untuk `D:\repos\learning-management` setelah analisa selesai.
> Konteks & alasan: [`RENCANA-SELFHOST-LMS.md`](./RENCANA-SELFHOST-LMS.md).
> Aturan server: `D:\STRUKTUR-SERVER.md`.
>
> Legenda: `[ ]` belum · `[~]` jalan (kode ada, belum diverifikasi) · `[x]` selesai ·
> `[!]` terblokir keputusan. **Jangan centang tanpa bukti** (perintah/uji yang dijalankan).

---

## 📍 Checkpoint — 31 Oktober 2026

**Ringkas:** aplikasi sudah **berjalan mandiri tanpa Zite** di localhost, dan data
contoh untuk **semua modul** sudah terisi. Yang tersisa: deploy sebagai service
(Fase 5), isi terjemahan (Fase 7 — ditunda), dan bridge email/PDF/AI (Fase 4).

### Cara menjalankan (uji lokal)

```powershell
# dari D:\repos\learning-management
& 'C:\Program Files\nodejs\node.exe' --env-file=.env.local `
    apps\server\dist\learning-management\server.mjs
```

- Buka **http://127.0.0.1:3360/auth/login** (halaman login dilayani server sendiri).
- Akun: `admin@pmp.web.id` / `AdminNbi2026` — kredensial DB, `SESSION_SECRET`, dan
  seluruh konfigurasi ada di `.env.local` (gitignored).
- Setelah mengubah kode: `corepack yarn workspace @project/learning-management build`
  lalu `node apps/server/scripts/build.mjs`, baru jalankan ulang.

### Sudah terverifikasi (ada buktinya)

| Bidang | Bukti |
|---|---|
| Database | PostgreSQL 16.14, DB `learning_management`, **25 tabel** + view `ziteUsers`, 367 kolom |
| Server | boot, listen 3360, `/healthz` `200`, SPA + aset `200` |
| Endpoint | `bootstrap`, `getHome`, `listPeople`, `listGroups`, `getCourse` (jalur error) — jalan di atas Postgres lokal |
| Build | `tsc` + `vite build` kedua app bersih; bundel server 65 + 32 endpoint |
| Isolasi platform | `pg` tidak ada di bundel browser; 97 endpoint + `packages/shared` **tanpa perubahan kode** |
| Seed | 24/24 tabel terisi (People 40, Courses 12, Lessons 45, Enrollments 223, Certificates 135, Activity 759, dst.) |
| Timezone | `Asia/Jakarta` (kode + baris `Settings`) |
| Bahasa | switcher + **navigasi sidebar** Indonesia; default org `id` |

### Belum selesai

| Fase | Status |
|---|---|
| 3 — Auth | login/logout/sesi/cookie sudah jalan; **alur undangan & `signInPolicy`** belum |
| 4 — Bridge server | upload ke disk **sudah**; **PDF, email SMTP, AI** belum |
| 5 — Deploy | **belum** (masih proses manual di localhost, belum NSSM/cloudflared) |
| 7 — i18n isi | **ditunda** (±2.000 string masih Inggris) |
| 8 — Kualitas | belum (belum ada smoke test, `docs/` masih terbatas) |

### Jebakan lingkungan — jangan ditemukan ulang

1. `yarn` tidak terpasang → pakai **`corepack yarn`**.
2. Registry `registry.yarnpkg.com` tidak bisa diakses di server ini → sudah dialihkan
   ke `registry.npmjs.org` di `C:\Users\Administrator\.yarnrc`.
3. `NODE_ENV=production` membuat devDependency terlewat → install dengan
   **`--production=false`** sebelum build SPA.
4. `--prefer-offline` membuat resolusi rentang versi gagal — jangan dipakai.
5. Unduhan paket lambat (±4 menit untuk install penuh) → dependensi server sengaja
   ditekan seminimal mungkin (tanpa multer, tanpa node-cron).
6. `zite.schema.json` adalah **sumber tunggal** nama tabel & kolom. Menambah kolom
   wajib di dua tempat: `zite.schema.json` **dan** `ALTER TABLE` — kalau tidak,
   penulisan kolom itu akan diabaikan diam-diam oleh runtime.
7. Isi `apps/server/dist` **hasil build** — jangan diedit tangan.

### Langkah berikutnya yang disarankan

1. **Fase 5** — jadikan service NSSM + cloudflared (`lms`/`learn`), supaya tidak
   bergantung pada terminal yang terbuka.
2. **Fase 3 sisa** — alur undangan + `signInPolicy`, karena itu yang dipakai
   sehari-hari setelah go-live.
3. **Fase 4** — PDF sertifikat & email SMTP (butuh keputusan SMTP).
4. **Fase 7** — terjemahan isi halaman (lihat prioritas di bawah).

---

## Fase 0 — Fondasi & keputusan

- [x] Konfirmasi keputusan (RENCANA §9): lepas penuh dari Zite; auth email+password lokal; PDF Playwright+Chromium; i18n = UI+email+notifikasi+sertifikat; default Indonesia; 2 service `:3360`/`:3361` → `lms`/`learn`.
- [ ] `[!]` Masih terbuka: SMTP (Fase 4) dan data awal.
- [x] Kunci strategi alias: pertahankan `.zite/*` sebagai sumber tipe, ganti isi di balik alias `zitejs/*` (nol perubahan pada 97 endpoint + `packages/shared`).
- [x] Buat `packages/runtime/` + `package.json`.
- [x] Buat `apps/server/` (Express + dispatch endpoint + auth + penjadwal) + `scripts/build.mjs`.
- [x] Tambah esbuild untuk bundel endpoint server (`zitejs/*` → `packages/runtime/*`).
- [x] Buat `.env.example` baru (self-host) dan perbarui `.gitignore`.
- [x] Hapus ketergantungan runtime eksternal dari kedua `vite.config.ts` (`insertHtml`/`app-runtime.js`, `ziteId`).
- [x] Alihkan alias `zitejs/*` di kedua `vite.config.ts` **dan** kedua `tsconfig.json` ke `packages/runtime`.
- [x] Putuskan nasib `.zite/`: dipertahankan sebagai sumber tipe + `zitejs/db` + `zitejs/api`.
- [x] Verifikasi tidak ada berkas frontend yang mengimpor `zitejs/db`/`runtime` (kalau ada, `pg` ikut ke bundle browser).
- [x] `tsc` hijau untuk **kedua** app dan `vite build` sukses setelah alias berubah (diverifikasi).
- [x] `pg` **tidak** ikut ke bundle browser (diverifikasi pada `dist/`).

**Selesai bila:** `tsc --noEmit` hijau untuk kedua app dan tidak ada impor `zitejs` ke `node_modules/zitejs`.

---

## Fase 1 — Runtime shim + PostgreSQL

### DB client (`packages/runtime/client.ts`)
- [~] `createTableClient` — `findAll`/`findOne`/`create`/`update`/`delete`/`bulkCreate` di atas `pg`.
- [~] Semantik: filter op (`contains`,`not`,`in`,`notIn`,`lt`,`lte`,`gt`,`gte`), `limit` default 500/maks 2000, `undefined` ditolak, `matchOn` upsert, `bulkCreate` maks 100.
- [~] Teks kosong ditulis `''` (bukan `NULL`); angka/tanggal dinormalisasi.
- [~] `createSqlClient`: SELECT-only, cap 2000 row + `truncated`, timeout 10s.
- [~] Date OID 1082 di-pin sebagai string (cegah geser tanggal di zona +07:00).
- [~] `createAuthClient`: `findAllUsers`, `updateUserProfile`.

### Skema & DB
- [x] `scripts/gen-schema.mjs`: `zite.schema.json` → `schema.sql` (24 tabel, 280 kolom, terverifikasi).
- [x] Petakan tipe: 9 tipe (single_line_text/long_text/url/email/single_select → text; number → numeric; checkbox → boolean; date; datetime).
- [x] Nama tabel = identifier SDK PascalCase (`"GroupMembers"`), bukan nama tampilan.
- [x] Buat database `learning_management` + role `learning_management_app` di `E:\Data\Database\PostgreSQL`.
- [x] Terapkan `schema.sql`; verifikasi **25 tabel** + view `ziteUsers` (367 kolom).
- [x] Seed baris `Settings` tunggal (dibuat otomatis pada pembacaan pertama).

**Selesai bila:** satu endpoint baca (mis. `getSettings`) mengembalikan data benar dari Postgres lokal.

---

## Fase 2 — Server + dispatch endpoint

- [x] `apps/server`: Express — static `dist/` + `POST /api/<nama>`.
- [x] Peta nama endpoint → `execute` (registry di-generate dari `src/api/*.ts`).
- [x] `context`: `user` dari sesi; `context` tanpa user untuk jadwal.
- [x] Validasi `inputSchema.parse(input)`; petakan `ZiteError` → status HTTP.
- [x] Health check `GET /healthz`.
- [~] Penjadwal endpoint (pengganti jadwal Zite) — interval 60 s, zona waktu via `Intl`.
- [x] Bundel **kedua** app berhasil — 65 (admin) + 32 (learner) endpoint, semua `zitejs/*` ter-resolve ke `packages/runtime`.
- [x] Server lokal berjalan & listen; `/healthz` `200`. Endpoint nyata diuji: `bootstrap`, `getHome`, `listPeople`, `listGroups`, `getCourse` (jalur error), SPA + aset.
- [x] **Seed contoh untuk semua modul** dijalankan lewat `seedWorkspace` — ke-24 tabel terisi (People 40, Courses 12, Lessons 45, Enrollments 223, Certificates 135, Sessions 7, Activity 759, dst.).
- [ ] Pastikan log terstruktur ke stdout/stderr (diarahkan NSSM ke `D:\logs\…`).

**Selesai bila:** Home admin & Home learner merender data nyata dari Postgres lokal.

---

## Fase 3 — Auth self-host

- [x] Tabel `AuthUsers` (ada di `schema.sql`) + `ziteUsers` view.
- [x] Endpoint `POST /auth/login`, `GET /auth/logout`, `GET /auth/me`; cookie httpOnly bertanda tangan.
- [x] Hash kata sandi scrypt + `timingSafeEqual` (tanpa dependensi).
- [x] Shum `zitejs/auth`: `useAuth()` → `{ user, isLoading, loginWithRedirect, logout }`.
- [x] Halaman login server-rendered; `safeRedirect` menolak redirect lintas origin.
- [ ] Alur undangan: admin invite → set password / tautan → email "Invitation".
- [ ] Hormati `signInPolicy` (Invited only / Allowed domains / Anyone).
- [ ] Pastikan `getActor`/`getLearner` bekerja tanpa diubah.

**Selesai bila:** login → dashboard; logout; user baru sesuai kebijakan sign-in.

---

## Fase 4 — Bridge sisi server

- [x] `zitejs/upload` → `POST /api/upload` (JSON base64) → disk `E:\Data\Application\…\uploads`; URL publik absolut. *(tanpa multer)*
- [ ] `zitejs/pdf` → HTML→PDF lokal (Playwright + Chromium); simpan ke `…\pdf`; bersihkan berkas sementara.
- [ ] `zitejs/email` → SMTP (nodemailer, opsional); `Email`/`createEmailClient('email-1')`; hormati `muteEmails`.
- [ ] Jadwalkan & uji `sendReminders` (14:00 UTC) dari proses admin.
- [ ] Ganti env `ZITE_ANTHROPIC_ACCESS_TOKEN` → `ANTHROPIC_API_KEY` (AI opsional).

**Selesai bila:** upload logo/avatar, unduh sertifikat PDF, kirim test email, dan jalankan `sendReminders` manual.

---

## Fase 5 — Deploy sesuai STRUKTUR-SERVER.md

- [ ] Siapkan `D:\apps\learning-management` & `D:\apps\learner-portal` (hasil build + `npm install`/`yarn --production`), **tanpa `.git`**.
- [ ] Siapkan `D:\logs\learning-management` & `D:\logs\learner-portal`.
- [ ] Pastikan bind hanya `127.0.0.1` (3360/3361).
- [ ] Daftarkan NSSM `LearningManagement` & `LearnerPortal` (`Application` full path node, `AppDirectory`, `AppStdout`, `AppStderr`, `Start SERVICE_AUTO_START`).
- [ ] Verifikasi `Get-Service` / `sc query` = RUNNING; tidak ada error di stderr.
- [ ] Cloudflared: tambah ingress `lms.pmp.web.id → 127.0.0.1:3360` dan `learn.pmp.web.id → 127.0.0.1:3361` **di atas** `http_status:404`.
- [ ] `cloudflared tunnel ingress validate` → harus `OK`.
- [ ] `nssm restart cloudflared` → cek `STATE : 4 RUNNING` + `Registered tunnel connection … protocol=quic`.
- [ ] DNS Cloudflare: CNAME `lms` & `learn` → `71a9532e-…cfargotunnel.com`, **Proxied**.
- [ ] Tes lokal (`curl http://127.0.0.1:3360`) lalu publik (`https://lms.pmp.web.id`).
- [ ] Catat port 3360/3361 + 2 hostname ke tabel §7.2/§9.2 `STRUKTUR-SERVER.md` dan referensi skill.
- [ ] Backup: jadwalkan `pg_dump` harian ke `E:\Data\Backup\learning-management\`.

**Selesai bila:** kedua app dapat diakses HTTPS publik, service autostart, log di `D:\logs`.

---

## Fase 6 — i18n tulang (Bahasa Indonesia)

- [x] `packages/shared/i18n/`: katalog `en` + `id`, `t(key, vars)`, `LocaleProvider`, `useT()`, `<html lang>` dinamis, pilihan disimpan di `localStorage` (`lms:locale`).
- [x] Skema: `defaultLocale` di `Settings` (`zite.schema.json` + DDL + `OrgSettings` + `DEFAULTS` + `settingsPayload` + `bootstrap`).
- [x] **Menu bahasa** di sidebar (submenu pada menu organisasi) dengan penanda bahasa aktif.
- [x] Navigasi sidebar diterjemahkan (Beranda, Kotak Masuk, Penilaian, Kursus, Jalur Pembelajaran, dst.).
- [ ] `formatDate`/`formatNumber` sadar-locale (date-fns `id`), `plural()` disederhanakan.
- [ ] Alirkan `locale` ke `saveSettings`/`saveProfile`/`saveMyProfile`/`getMe` + pemilih di halaman Pengaturan.
- [ ] Ubah label map terpusat jadi key: `DUE_STATE_LABEL`, `CERTIFICATE_STATE_LABEL`, `LESSON_TYPE_META`, `QUESTION_TYPE_LABEL`, `FILE_KIND_LABEL`, `TYPE_META`, `TRIGGER_INFO`, `MERGE_TAGS`, `DEFAULTS`.
- [ ] Peta nilai-enum-DB → key **di semua picker/filter** (nilai tersimpan tetap Inggris).

**Selesai bila:** ganti bahasa mengganti seluruh UI tanpa reload penuh. *(Saat ini: switcher + navigasi; sisa ±2.000 string masih Inggris — lihat Fase 7.)*

---

## Fase 7 — i18n isi ⏸️ **PENDING (ditunda atas permintaan)**

> **Status: ditunda.** Belum dikerjakan. Saat ini yang sudah berbahasa Indonesia
> hanya **navigasi sidebar** (Fase 6). Sisa ±2.000 string — isi halaman, tombol,
> toast, dialog, notifikasi, email, sertifikat, CSV/ICS — **masih Inggris**.
>
> Prasyaratnya sudah siap: `packages/shared/i18n` (katalog `en`/`id` + `useT()`)
> dan `defaultLocale` di `Settings`. Pekerjaan ini bersifat multi-sesi; urutan
> yang disarankan ada di daftar bawah.
>
> **Prioritas saat dilanjutkan** (paling terlihat dulu): 1) judul & isi halaman
> Beranda, 2) label status/enum dari `packages/shared` (satu kali ubah, banyak
> tempat), 3) `lib/format.ts` (tanggal & "Hari ini/Besok" + date-fns locale `id`),
> 4) tombol/toast/dialog umum, 5) halaman Pengaturan, 6) portal learner,
> 7) pesan server (`ZiteError`) + notifikasi, 8) email 11 template + sertifikat,
> 9) CSV/ICS.

- [ ] De-duplikasi `apps/*/src/lib/format.ts` → helper bersama sadar-locale.
- [ ] Ganti `'en-US'`/`'en-CA'` hardcoded: `certificateDates.ts`, `merge.ts`, `learnFormat.ts`, `reminders.ts`.
- [ ] Ekstrak string UI **admin** (118 file TSX): JSX text, `toast`, `aria-label`, `title`, `placeholder`, `alt`.
- [ ] Ekstrak string UI **learner** (39 file TSX).
- [ ] Pesan server: 345 `ZiteError('…')` → kode error + terjemahan klien.
- [ ] Notifikasi in-app: simpan `type` + params, render saat dibaca (bukan teks Inggris jadi).
- [ ] Email 11 template: kolom `locale` + seed default `id`; render saat kirim.
- [ ] Sertifikat: `certificateHtml.ts` (PDF) + `CertificateArt.tsx` (layar) — sinkron.
- [ ] CSV/ICS: header, sel, dan `.ics`.
- [ ] Putuskan & kerjakan konten demo (`seed/content.ts`, `seed/org.ts`).
- [ ] Audit layout: tombol/nav/tabel berlebar tetap vs teks Indonesia yang lebih panjang.

**Selesai bila:** tidak ada string Inggris tersisa di alur utama (login → kursus → kuis → sertifikat → email).

---

## Fase 8 — Kualitas & dokumentasi

- [ ] Smoke test end-to-end (alur admin & learner) yang bisa dijalankan di CI/headless.
- [ ] `docs/deployment/` — cara install, NSSM, cloudflared, uninstall.
- [ ] `docs/database/` — skema, lokasi `E:\Data\Database\PostgreSQL`, backup/restore.
- [ ] `docs/api/` — daftar 97 endpoint + auth + error code.
- [ ] `docs/changelog/` — mulai dari versi self-host pertama.
- [ ] `README.md` — ganti bagian "Install in your own workspace" dengan panduan self-host.
- [ ] Catatan proyek di `D:\documents\`.
- [ ] Ratchet i18n: string UI baru wajib lewat `t()` (cek sederhana di CI).

**Selesai bila:** orang lain bisa deploy dari `docs/` tanpa bertanya, dan test lulus.

---

## Catatan blokir

- Fase 1–5 dapat jalan paralel dengan Fase 6 (i18n tulang) setelah keputusan §9.
- Fase 7 butuh Fase 6 selesai.
- Fase 5 butuh Fase 2–4 berfungsi lokal.
- Fase 1 (buat DB) butuh kredensial superuser PostgreSQL.
