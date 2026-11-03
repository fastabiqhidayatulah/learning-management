/**
 * Titik masuk server. Satu bundel per app (lihat scripts/build.mjs), jadi
 * `__APP__` sudah berupa konstanta saat build — tidak ada lookup saat runtime.
 *
 * Variabel lingkungan penting: PORT, HOST, DATABASE_URL/PG*, SESSION_SECRET,
 * UPLOADS_DIR, PDF_DIR, PUBLIC_BASE_URL, SPA_DIR, ADMIN_EMAIL/ADMIN_PASSWORD.
 */

import { createServer, ensureBootstrapAdmin } from './http.js';
import { startScheduler } from './scheduler.js';
import { endpoints, __registryApp } from './.generated/endpoints.js';

declare const __APP__: string;

const app = __APP__;
const port = Number(process.env.PORT ?? 3360);
const host = process.env.HOST ?? '127.0.0.1';

const server = createServer(app, endpoints);

server.listen(port, host, () => {
  console.log(`[${app}] mendengarkan di http://${host}:${port}`);
  console.log(`[${app}] ${Object.keys(endpoints).length} endpoint dimuat (registry: ${__registryApp})`);
  void ensureBootstrapAdmin().catch((e) => console.error('[auth] bootstrap gagal', e));
  startScheduler(app, endpoints);
});

const shutdown = (signal: string) => {
  console.log(`[${app}] menerima ${signal}, berhenti…`);
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
