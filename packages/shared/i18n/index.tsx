/**
 * i18n — Bahasa Indonesia & English.
 *
 * Paket ini dipakai kedua app. `en` adalah bentuk acuan (memastikan setiap kunci
 * punya arti), `id` boleh belum lengkap dan akan jatuh ke `en` bila kosong.
 *
 * Pemakaian:
 *   const { t, locale, setLocale } = useT();
 *   <span>{t('nav.home')}</span>
 *   t('greeting', { name: 'Budi' })   // "Halo, Budi"
 *
 * Pilihan bahasa disimpan di localStorage per peramban (`lms:locale`);
 * default organisasi ada di Settings.defaultLocale.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type Locale = 'en' | 'id';

export const DEFAULT_LOCALE: Locale = 'id';

export const LOCALES: { value: Locale; label: string; short: string }[] = [
  { value: 'id', label: 'Bahasa Indonesia', short: 'ID' },
  { value: 'en', label: 'English', short: 'EN' },
];

export const isLocale = (value: unknown): value is Locale => value === 'en' || value === 'id';

const STORAGE_KEY = 'lms:locale';

/* ------------------------------------------------------------------ *
 * Katalog
 * ------------------------------------------------------------------ */

const en = {
  // Navigasi
  'nav.home': 'Home',
  'nav.inbox': 'Inbox',
  'nav.grading': 'Grading',
  'nav.discussions': 'Discussions',
  'nav.workspace': 'Workspace',
  'nav.courses': 'Courses',
  'nav.paths': 'Learning paths',
  'nav.sessions': 'Live sessions',
  'nav.people': 'People',
  'nav.groups': 'Groups',
  'nav.enrollments': 'Enrollments',
  'nav.assignments': 'Assignment rules',
  'nav.certificates': 'Certificates',
  'nav.reports': 'Reports',
  'nav.views': 'Views',
  'nav.recentCourses': 'Recent courses',
  'nav.content': 'Content',
  'nav.learners': 'Learners',
  'nav.settings': 'Settings',

  // Menu akun
  'menu.language': 'Language',
  'menu.addPeople': 'Add or invite people',
  'menu.openAcademy': 'Open {academy}',
  'menu.darkTheme': 'Dark theme',
  'menu.lightTheme': 'Light theme',
  'menu.systemTheme': 'Match system theme',
  'menu.shortcuts': 'Keyboard shortcuts',

  // Menu buat
  'create.enroll': 'Enroll people',
  'create.course': 'New course',
  'create.path': 'New learning path',
  'create.session': 'Schedule a live session',
  'create.rule': 'New assignment rule',

  // Umum
  'common.search': 'Search',
  'common.create': 'Create',
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.navigation': 'Navigation',
  'common.openNav': 'Open navigation',
  'common.collapse': 'Collapse {title}',
  'common.expand': 'Expand {title}',
} as const;

/** Terjemahan Indonesia. Kunci yang belum ada di sini jatuh ke `en`. */
const id: Partial<Record<keyof typeof en, string>> = {
  'nav.home': 'Beranda',
  'nav.inbox': 'Kotak Masuk',
  'nav.grading': 'Penilaian',
  'nav.discussions': 'Diskusi',
  'nav.workspace': 'Ruang Kerja',
  'nav.courses': 'Kursus',
  'nav.paths': 'Jalur Pembelajaran',
  'nav.sessions': 'Sesi Langsung',
  'nav.people': 'Orang',
  'nav.groups': 'Grup',
  'nav.enrollments': 'Pendaftaran',
  'nav.assignments': 'Aturan Penugasan',
  'nav.certificates': 'Sertifikat',
  'nav.reports': 'Laporan',
  'nav.views': 'Tampilan',
  'nav.recentCourses': 'Kursus Terakhir',
  'nav.content': 'Konten',
  'nav.learners': 'Peserta',
  'nav.settings': 'Pengaturan',

  'menu.language': 'Bahasa',
  'menu.addPeople': 'Tambah atau undang orang',
  'menu.openAcademy': 'Buka {academy}',
  'menu.darkTheme': 'Tema gelap',
  'menu.lightTheme': 'Tema terang',
  'menu.systemTheme': 'Ikuti tema sistem',
  'menu.shortcuts': 'Pintasan papan ketik',

  'create.enroll': 'Daftarkan orang',
  'create.course': 'Kursus baru',
  'create.path': 'Jalur pembelajaran baru',
  'create.session': 'Jadwalkan sesi langsung',
  'create.rule': 'Aturan penugasan baru',

  'common.search': 'Cari',
  'common.create': 'Buat',
  'common.cancel': 'Batal',
  'common.confirm': 'Konfirmasi',
  'common.navigation': 'Navigasi',
  'common.openNav': 'Buka navigasi',
  'common.collapse': 'Tutup {title}',
  'common.expand': 'Buka {title}',
};

const CATALOGS: Record<Locale, Partial<Record<keyof typeof en, string>>> = { en, id };

export type MessageKey = keyof typeof en;

/* ------------------------------------------------------------------ *
 * Provider
 * ------------------------------------------------------------------ */

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

function readStored(): Locale | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isLocale(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function LocaleProvider({
  locale: orgDefault,
  children,
}: {
  /** Default organisasi dari Settings.defaultLocale. */
  locale?: Locale;
  children: ReactNode;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => readStored() ?? (isLocale(orgDefault) ? orgDefault : DEFAULT_LOCALE));

  // Ikuti default organisasi hanya bila pengguna belum pernah memilih.
  useEffect(() => {
    if (readStored() || !isLocale(orgDefault)) return;
    setLocaleState(orgDefault);
  }, [orgDefault]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* biarkan: pilihan tetap berlaku sampai halaman dimuat ulang */
    }
  }, []);

  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => {
      const message = CATALOGS[locale]?.[key] ?? en[key] ?? String(key);
      if (!vars) return message;
      return message.replace(/\{(\w+)\}/g, (_, name: string) => (name in vars ? String(vars[name]) : `{${name}}`));
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useT(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useT() harus dipakai di dalam <LocaleProvider>.');
  return ctx;
}
