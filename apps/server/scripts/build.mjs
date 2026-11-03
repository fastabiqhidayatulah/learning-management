/**
 * Build server: satu bundel mandiri per app.
 *
 *   node apps/server/scripts/build.mjs                 # kedua app
 *   node apps/server/scripts/build.mjs learner-portal  # satu app
 *
 * Untuk setiap app:
 *   1. hasilkan registry endpoint dari apps/<app>/src/api/*.ts
 *   2. bundel apps/server/src/main.ts + registry + packages/runtime + endpoints
 *      menjadi dist/<app>/server.mjs
 *
 * `zitejs/*` di-alias ke packages/runtime/* — inilah yang membuat 97 endpoint
 * dan packages/shared berjalan tanpa perubahan satu baris pun.
 *
 * PENTING: registry ditulis ke SATU berkas (`src/.generated/endpoints.ts`) yang
 * diimpor `main.ts`. Karena itu build WAJIB berurutan dan di-await — kalau dua
 * build berjalan bersamaan, yang terakhir menulis registry akan menang dan app
 * lain akan memuat endpoint yang salah (65 admin ↔ 32 learner).
 */

import { build } from 'esbuild';
import { mkdirSync, readdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const serverRoot = path.resolve(here, '..');
const generatedDir = path.join(serverRoot, 'src', '.generated');
const registryPath = path.join(generatedDir, 'endpoints.ts');

const APP_DIRS = {
  'learning-management': 'apps/learning-management',
  'learner-portal': 'apps/learner-portal',
};

const requested = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const apps = requested.length ? requested : Object.keys(APP_DIRS);

for (const app of apps) {
  const appDir = APP_DIRS[app];
  if (!appDir) throw new Error(`App tidak dikenal: ${app}. Pilih: ${Object.keys(APP_DIRS).join(', ')}`);
  await buildApp(app, appDir);
}

async function buildApp(app, appDir) {
  const apiDir = path.join(repoRoot, appDir, 'src', 'api');
  if (!existsSync(apiDir)) throw new Error(`Tidak ada folder endpoint: ${apiDir}`);

  const files = readdirSync(apiDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .sort();

  // 1. Registry endpoint (menggantikan .zite/api.ts versi server).
  mkdirSync(generatedDir, { recursive: true });
  const lines = [];
  const names = [];
  files.forEach((f, i) => {
    const name = f.replace(/\.ts$/, '');
    const rel = path.relative(generatedDir, path.join(apiDir, f)).replace(/\\/g, '/');
    lines.push(`import ep${i} from '${rel.startsWith('.') ? rel : `./${rel}`}';`);
    names.push([name, `ep${i}`]);
  });
  lines.push('');
  lines.push(`// Registry untuk app: ${app} (${files.length} endpoint). Jangan edit manual.`);
  // Penanda yang pasti bertahan setelah bundling, untuk memverifikasi bahwa
  // bundel ini memuat registry milik app yang benar.
  lines.push(`export const __registryApp = '__LMS_REGISTRY__${app}';`);
  lines.push('export const endpoints: Record<string, any> = {');
  for (const [name, varName] of names) lines.push(`  ${JSON.stringify(name)}: ${varName},`);
  lines.push('};');
  writeFileSync(registryPath, lines.join('\n') + '\n', 'utf8');

  // 2. Bundel (di-await: registry harus benar-benar terbaca oleh build ini).
  const outDir = path.join(serverRoot, 'dist', app);
  rmSync(outDir, { recursive: true, force: true });

  await build({
    entryPoints: [path.join(serverRoot, 'src', 'main.ts')],
    outfile: path.join(outDir, 'server.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: true,
    define: { __APP__: JSON.stringify(app) },
    // Paket npm asli tetap external (di-install di D:\apps), yang di-bundle
    // hanya kode workspace (@project/*) dan endpoint.
    external: ['express', 'pg', 'pg-native', 'nodemailer', 'playwright'],
    banner: {
      js: [
        "import { createRequire as __createRequire } from 'node:module';",
        'const require = __createRequire(import.meta.url);',
      ].join('\n'),
    },
    alias: {
      'zitejs/db': path.join(repoRoot, '.zite', 'db.ts'),
      'zitejs/api': path.join(repoRoot, appDir, '.zite', 'api.ts'),
      'zitejs/backend/base': path.join(repoRoot, 'packages', 'runtime', 'backend.ts'),
      'zitejs/backend': path.join(repoRoot, 'packages', 'runtime', 'backend.ts'),
      'zitejs/runtime': path.join(repoRoot, 'packages', 'runtime', 'client.ts'),
      'zitejs/pdf': path.join(repoRoot, 'packages', 'runtime', 'pdf.ts'),
      'zitejs/upload': path.join(repoRoot, 'packages', 'runtime', 'upload.ts'),
      'zitejs/email': path.join(repoRoot, appDir, '.zite', 'integrations', 'email.ts'),
      'zitejs/caller': path.join(repoRoot, 'packages', 'runtime', 'caller.ts'),
      'zitejs/auth': path.join(repoRoot, 'packages', 'runtime', 'auth.tsx'),
    },
  });

  // 3. Verifikasi: pastikan registry yang tertanam memang milik app ini.
  const bundle = readFileSync(path.join(outDir, 'server.mjs'), 'utf8');
  const marker = `__LMS_REGISTRY__${app}`;
  if (!bundle.includes(marker)) {
    throw new Error(
      `${app}: bundel tidak memuat registry yang benar (race antar-build?). ` +
        `Periksa ${path.relative(repoRoot, generatedDir)} dan pastikan build berurutan.`,
    );
  }

  console.log(`✔ ${app}: ${files.length} endpoint → ${path.relative(repoRoot, path.join(outDir, 'server.mjs'))}`);
}
