/**
 * Penjadwal endpoint — menggantikan penjadwal Zite.
 *
 * Tanpa dependensi: satu interval 60 detik yang menghitung waktu lokal di zona
 * waktu jadwal, lalu menjalankan endpoint saat jam:menit cocok (sekali per
 * tanggal+jam). `context.user` = null dan `scheduledAt` diisi, persis seperti
 * jadwal Zite — sehingga `sendReminders` yang memeriksa `if (context?.user)`
 * tetap berperilaku benar.
 */

import type { EndpointMap, EndpointLike } from './http.js';

type Frequency = 'daily' | 'weekly' | 'monthly';

type Job = {
  name: string;
  endpoint: EndpointLike;
  frequency: Frequency;
  hour: number;
  minute: number;
  timezone: string;
  daysOfWeek: number[];
  dayOfMonth: number | null;
  interval: number;
  lastKey: string;
};

type LocalParts = { key: string; hour: number; minute: number; weekday: number; day: number; month: number; year: number };

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Bagian waktu lokal di zona waktu tertentu, tanpa dependensi. */
function localParts(now: Date, timeZone: string): LocalParts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(now)) parts[p.type] = p.value;
  const hour = Number(parts.hour === '24' ? '0' : parts.hour);
  const minute = Number(parts.minute);
  const ymd = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    key: `${ymd} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    hour,
    minute,
    weekday: WEEKDAYS[parts.weekday ?? 'Mon'] ?? 1,
    day: Number(parts.day),
    month: Number(parts.month),
    year: Number(parts.year),
  };
}

function toJobs(app: string, endpoints: EndpointMap): Job[] {
  const jobs: Job[] = [];
  for (const [name, endpoint] of Object.entries(endpoints)) {
    const schedule = endpoint.schedule as
      | {
          schedule?: { frequency?: string; interval?: number; times?: string[]; daysOfWeek?: number[]; dayOfMonth?: number };
          timezone?: string;
        }
      | undefined;
    const spec = schedule?.schedule;
    if (!spec?.frequency || !spec.times?.length) continue;

    const frequency = spec.frequency as Frequency;
    if (frequency !== 'daily' && frequency !== 'weekly' && frequency !== 'monthly') {
      console.warn(`[${app}] jadwal ${name}: frekuensi "${spec.frequency}" belum didukung, dilewati`);
      continue;
    }

    // Satu job per waktu terdaftar (biasanya hanya satu).
    for (const time of spec.times) {
      const [hour, minute] = time.split(':').map((v) => Number(v));
      if (Number.isNaN(hour) || Number.isNaN(minute)) {
        console.warn(`[${app}] jadwal ${name}: waktu "${time}" tidak valid, dilewati`);
        continue;
      }
      jobs.push({
        name,
        endpoint,
        frequency,
        hour,
        minute,
        timezone: schedule?.timezone || 'UTC',
        daysOfWeek: spec.daysOfWeek?.length ? spec.daysOfWeek : [1],
        dayOfMonth: spec.dayOfMonth ?? 1,
        interval: Math.max(1, spec.interval ?? 1),
        lastKey: '',
      });
    }
  }
  return jobs;
}

function matchesDay(job: Job, local: LocalParts): boolean {
  switch (job.frequency) {
    case 'daily':
      return true;
    case 'weekly':
      return job.daysOfWeek.includes(local.weekday);
    case 'monthly': {
      const daysInMonth = new Date(Date.UTC(local.year, local.month, 0)).getUTCDate();
      const target = Math.min(job.dayOfMonth ?? 1, daysInMonth);
      return local.day === target;
    }
  }
}

export function startScheduler(app: string, endpoints: EndpointMap): () => void {
  const jobs = toJobs(app, endpoints);
  if (!jobs.length) return () => {};

  for (const job of jobs) {
    console.log(
      `[${app}] jadwal terdaftar: ${job.name} (${job.frequency} ${String(job.hour).padStart(2, '0')}:${String(job.minute).padStart(2, '0')} ${job.timezone})`,
    );
  }

  const tick = async () => {
    const now = new Date();
    for (const job of jobs) {
      let local: LocalParts;
      try {
        local = localParts(now, job.timezone);
      } catch {
        local = localParts(now, 'UTC');
      }
      if (local.hour !== job.hour || local.minute !== job.minute) continue;
      if (job.lastKey === local.key) continue;
      if (!matchesDay(job, local)) continue;

      job.lastKey = local.key;
      const started = Date.now();
      try {
        await job.endpoint.execute({
          input: {},
          context: { user: null, scheduledAt: now.toISOString(), app },
        });
        console.log(`[${app}] jadwal ${job.name} selesai dalam ${Date.now() - started}ms`);
      } catch (e) {
        console.error(`[${app}] jadwal ${job.name} gagal`, e instanceof Error ? e.message : e);
      }
    }
  };

  const timer = setInterval(() => void tick(), 60_000);
  // Cek sekali saat start, supaya jam yang pas tidak menunggu satu menit.
  void tick();

  return () => clearInterval(timer);
}
