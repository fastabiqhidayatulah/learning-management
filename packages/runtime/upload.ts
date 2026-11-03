/**
 * Runtime lokal — permukaan `zitejs/upload` (SISI BROWSER).
 *
 * Di Zite, `uploadFile` mengunggah ke storage Zite. Di sini berkas dikirim
 * sebagai JSON base64 ke `POST /api/upload` milik server sendiri, yang
 * menyimpannya ke disk dan mengembalikan URL publik absolut.
 *
 * Sengaja JSON (bukan multipart) supaya server tidak perlu dependensi parser
 * multipart — penting di server ini yang unduhan paketnya lambat.
 *
 * Kontrak yang dipertahankan: `uploadFile({ data, filename }) => { fileUrl }`.
 */

export interface UploadResult {
  fileUrl: string;
  filename?: string;
  size?: number;
  mimeType?: string;
}

const API_BASE = (import.meta as { env?: Record<string, string> }).env?.VITE_API_BASE_URL ?? '';

async function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Gagal membaca berkas'));
    reader.readAsDataURL(blob);
  });
}

export async function uploadFile(input: {
  data: Blob | File | ArrayBuffer;
  filename: string;
}): Promise<UploadResult> {
  const blob = input.data instanceof Blob ? input.data : new Blob([input.data as ArrayBuffer]);
  const data = await toDataUrl(blob);

  const res = await fetch(`${API_BASE}/api/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ filename: input.filename, data }),
  });

  const text = await res.text();
  const body = text ? (JSON.parse(text) as Partial<UploadResult> & { message?: string }) : {};
  if (!res.ok || !body.fileUrl) {
    throw new Error(body.message ?? `Unggah gagal (${res.status})`);
  }

  return {
    fileUrl: body.fileUrl,
    filename: body.filename ?? input.filename,
    size: body.size,
    mimeType: blob.type || undefined,
  };
}
