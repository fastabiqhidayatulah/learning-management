/**
 * Runtime lokal — permukaan `zitejs/pdf` (SISI SERVER).
 *
 * `Pdf.renderHtml({ html, filename }) => { url, filename }`.
 * Di Zite ini dirender gateway PDF; di sini dirender Chromium lokal lewat
 * Playwright, disimpan ke disk, dan disajikan di `/pdf/<file>`.
 *
 * Catatan pemanggil: endpoint admin mengembalikan seluruh hasil
 * (`res.url`/`res.filename`), sedangkan endpoint learner mendestruktur `{ url }`
 * — jadi kedua kunci wajib ada.
 *
 * Playwright di-import dinamis supaya paket frontend tidak ikut menariknya, dan
 * supaya error-nya jelas bila browser belum dipasang
 * (`npx playwright install chromium`).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export interface RenderHtmlParams {
  html: string;
  filename: string;
  /** Ukuran kertas CSS, mis. 'A4' atau '297mm 210mm'. */
  format?: string;
  landscape?: boolean;
}

export interface RenderHtmlResult {
  url: string;
  filename: string;
}

const pdfDir = () => process.env.PDF_DIR ?? path.resolve(process.cwd(), 'data', 'pdf');
const publicBase = () => (process.env.PUBLIC_BASE_URL ?? '').replace(/\/$/, '');

const safeName = (name: string) =>
  name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'document.pdf';

export const Pdf = {
  async renderHtml(params: RenderHtmlParams): Promise<RenderHtmlResult> {
    const dir = pdfDir();
    await mkdir(dir, { recursive: true });

    const stored = `${randomUUID()}-${safeName(params.filename)}`;
    const outPath = path.join(dir, stored);

    let browser: any;
    try {
      const pw: any = await import('playwright' as string);
      const chromium = (pw.default ?? pw).chromium;
      browser = await chromium.launch({ args: ['--no-sandbox'] });
    } catch (e) {
      throw new Error(
        'Mesin PDF belum siap. Pasang Playwright: `yarn add -D playwright` lalu `npx playwright install chromium`. ' +
          (e instanceof Error ? `(${e.message})` : ''),
      );
    }

    try {
      const page = await browser.newPage();
      await page.setContent(params.html, { waitUntil: 'networkidle' });
      const buffer = await page.pdf({
        printBackground: true,
        landscape: params.landscape ?? false,
        ...(params.format ? { width: params.format } : {}),
      });
      await writeFile(outPath, buffer);
      await page.close();
    } finally {
      await browser.close();
    }

    return { url: `${publicBase()}/pdf/${stored}`, filename: safeName(params.filename) };
  },
};
