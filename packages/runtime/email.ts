/**
 * Runtime lokal — email lewat SMTP biasa (nodemailer), menggantikan gateway
 * email Zite.
 *
 * Kontrak yang dipertahankan: `Email.send({ to, subject, body: blocks, … })`
 * mengembalikan `{ success, messageId }`. `packages/shared/server/email.ts`
 * menyusun `body` sebagai blok text/button/divider/spacer, dan mengabaikan
 * kegagalan (enrollment/grading tetap terjadi walau email gagal).
 */

export type EmailBlock =
  | { type: 'text'; content: string }
  | { type: 'heading'; content: string }
  | { type: 'button'; label: string; href: string; alignment?: 'left' | 'center' | 'right' }
  | { type: 'divider' }
  | { type: 'spacer'; height: number };

export interface SendEmailParams {
  to: string | string[];
  subject: string;
  body: EmailBlock[];
  from?: string;
  replyTo?: string;
  direction?: 'ltr' | 'rtl';
  logo?: { url: string; height?: number };
}

export interface SendEmailResult {
  success: boolean;
  messageId: string;
}

export interface EmailClient {
  send(params: SendEmailParams): Promise<SendEmailResult>;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Ubah blok jadi HTML email sederhana dan aman (tabel, inline style). */
function renderHtml(params: SendEmailParams): string {
  const dir = params.direction ?? 'ltr';
  const parts: string[] = [];
  for (const b of params.body) {
    switch (b.type) {
      case 'text':
        parts.push(
          `<p style="margin:0 0 14px 0;font:15px/1.6 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f1b17">${esc(
            b.content,
          ).replace(/\n/g, '<br>')}</p>`,
        );
        break;
      case 'heading':
        parts.push(
          `<h2 style="margin:0 0 14px 0;font:600 20px/1.35 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f1b17">${esc(
            b.content,
          )}</h2>`,
        );
        break;
      case 'button':
        parts.push(
          `<p style="margin:0 0 16px 0;text-align:${b.alignment ?? 'left'}"><a href="${esc(b.href)}" style="display:inline-block;padding:11px 18px;border-radius:8px;background:#1f1b17;color:#ffffff;text-decoration:none;font:600 15px/1 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">${esc(
            b.label,
          )}</a></p>`,
        );
        break;
      case 'divider':
        parts.push('<hr style="border:0;border-top:1px solid #e6e2dc;margin:20px 0">');
        break;
      case 'spacer':
        parts.push(`<div style="height:${Math.max(0, Math.min(80, b.height))}px"></div>`);
        break;
    }
  }
  const logo = params.logo?.url
    ? `<img src="${esc(params.logo.url)}" alt="" height="${params.logo.height ?? 36}" style="display:block;margin:0 0 20px 0;border:0">`
    : '';
  return [
    `<div dir="${dir}" style="background:#f7f5f2;padding:28px 12px">`,
    `<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px 26px;border:1px solid #e6e2dc">`,
    logo,
    parts.join('\n'),
    `</div></div>`,
  ].join('\n');
}

function transportOptions() {
  const host = process.env.SMTP_HOST;
  if (!host) return null;
  const port = Number(process.env.SMTP_PORT ?? 587);
  return {
    host,
    port,
    secure: process.env.SMTP_SECURE === 'true' || port === 465,
    auth:
      process.env.SMTP_USER && process.env.SMTP_PASS
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
  };
}

export function createEmailClient(_integrationId: string): EmailClient {
  return {
    async send(params: SendEmailParams): Promise<SendEmailResult> {
      const options = transportOptions();
      if (!options) {
        console.warn('[runtime:email] SMTP_HOST belum diset — email tidak dikirim:', params.subject);
        return { success: false, messageId: '' };
      }
      // Import dinamis: paket nodemailer tidak dibutuhkan oleh bundle frontend.
      const nodemailer: any = await import('nodemailer' as string);
      const transport = (nodemailer.default ?? nodemailer).createTransport(options);
      const from = params.from ?? process.env.MAIL_FROM ?? process.env.SMTP_USER ?? 'no-reply@pmp.web.id';
      const info = await transport.sendMail({
        from,
        to: Array.isArray(params.to) ? params.to.join(', ') : params.to,
        subject: params.subject,
        html: renderHtml(params),
        replyTo: params.replyTo ?? process.env.MAIL_REPLY_TO ?? undefined,
      });
      return { success: true, messageId: String(info.messageId ?? '') };
    },
  };
}
