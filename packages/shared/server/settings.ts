import { zite } from 'zitejs/db';
import { DEMO_ID, isDemo } from './demoPreview';
import { iso, num, str } from './sql';

/**
 * The organization's settings: one row, created on first read.
 *
 * Both apps read it — the learner app for branding and who may sign in, the
 * admin app for email, reminders and certificates — so it lives here.
 */

export type SignInPolicy = 'Invited only' | 'Allowed domains' | 'Anyone';

export type OrgSettings = {
  id: string;
  organizationName: string;
  logoUrl: string | null;
  websiteUrl: string | null;
  supportEmail: string | null;
  brandColor: string;
  academyName: string;
  academyHeadline: string;
  academyIntro: string;
  signInPolicy: SignInPolicy;
  /** Lowercase domains without "@", e.g. ["acme.com"]. */
  allowedDomains: string[];
  selfEnrollment: boolean;
  leaderboardEnabled: boolean;
  discussionsEnabled: boolean;
  defaultStaffRole: 'Instructor' | 'Learner';
  reminderDaysBefore: number;
  escalateOverdue: boolean;
  emailSignature: string;
  certificateTitle: string;
  certificateSignatory: string;
  certificateSignatoryTitle: string;
  timezone: string;
  /** Bahasa default organisasi: 'id' atau 'en'. */
  defaultLocale: 'en' | 'id';
  learnUrl: string | null;
  adminAppUrl: string | null;
  seededAt: string | null;
};

export const DEFAULT_BRAND = '#2f6b55';

/** Zona waktu default: Indonesia (WIB). */
export const DEFAULT_TIMEZONE = 'Asia/Jakarta';

export const DEFAULTS = {
  organizationName: 'Organisasi Anda',
  brandColor: DEFAULT_BRAND,
  academyName: 'Akademi',
  academyHeadline: 'Pelajari hal baru hari ini',
  academyIntro: 'Kursus, jalur pembelajaran, dan sesi langsung dari tim Anda. Lanjutkan dari tempat Anda berhenti, atau jelajahi katalog.',
  signInPolicy: 'Invited only' as SignInPolicy,
  defaultStaffRole: 'Instructor' as const,
  reminderDaysBefore: 3,
  certificateTitle: 'Sertifikat Penyelesaian',
  timezone: DEFAULT_TIMEZONE,
  defaultLocale: 'id' as const,
};

export function parseDomains(raw: unknown): string[] {
  return String(raw ?? '')
    .split(/[\s,;]+/)
    .map(d => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(d => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
}

function toSettings(r: Record<string, unknown>): OrgSettings {
  const blank = (v: unknown) => (v == null || v === '' ? null : String(v));
  const policy = String(r.signInPolicy ?? '');
  return {
    id: String(r.id),
    organizationName: str(r.organizationName) || DEFAULTS.organizationName,
    logoUrl: blank(r.logoUrl),
    websiteUrl: blank(r.websiteUrl),
    supportEmail: blank(r.supportEmail),
    brandColor: /^#[0-9a-f]{6}$/i.test(String(r.brandColor ?? '')) ? String(r.brandColor) : DEFAULTS.brandColor,
    academyName: str(r.academyName) || DEFAULTS.academyName,
    academyHeadline: str(r.academyHeadline) || DEFAULTS.academyHeadline,
    academyIntro: str(r.academyIntro) || DEFAULTS.academyIntro,
    signInPolicy: policy === 'Allowed domains' || policy === 'Anyone' ? policy : 'Invited only',
    allowedDomains: parseDomains(r.allowedDomains),
    selfEnrollment: r.selfEnrollment === true,
    leaderboardEnabled: r.leaderboardEnabled === true,
    discussionsEnabled: r.discussionsEnabled === true,
    defaultStaffRole: r.defaultStaffRole === 'Learner' ? 'Learner' : 'Instructor',
    reminderDaysBefore: Math.min(30, Math.max(0, num(r.reminderDaysBefore, DEFAULTS.reminderDaysBefore))),
    escalateOverdue: r.escalateOverdue === true,
    emailSignature: str(r.emailSignature) ?? '',
    certificateTitle: str(r.certificateTitle) || DEFAULTS.certificateTitle,
    certificateSignatory: str(r.certificateSignatory) ?? '',
    certificateSignatoryTitle: str(r.certificateSignatoryTitle) ?? '',
    timezone: str(r.timezone) || DEFAULTS.timezone,
    defaultLocale: r.defaultLocale === 'en' ? 'en' : 'id',
    learnUrl: blank(r.learnUrl),
    adminAppUrl: blank(r.adminAppUrl),
    seededAt: iso(r.seededAt),
  };
}

export async function getSettings(): Promise<OrgSettings> {
  const { rows } = await zite.sql({ query: `SELECT * FROM "Settings" ORDER BY created_at ASC LIMIT 1`, params: [] });
  if (rows[0]) return toSettings(rows[0]);
  const record = {
    organizationName: DEFAULTS.organizationName,
    brandColor: DEFAULTS.brandColor,
    academyName: DEFAULTS.academyName,
    academyHeadline: DEFAULTS.academyHeadline,
    academyIntro: DEFAULTS.academyIntro,
    signInPolicy: DEFAULTS.signInPolicy,
    selfEnrollment: true,
    leaderboardEnabled: true,
    discussionsEnabled: true,
    defaultStaffRole: DEFAULTS.defaultStaffRole,
    reminderDaysBefore: DEFAULTS.reminderDaysBefore,
    escalateOverdue: true,
    certificateTitle: DEFAULTS.certificateTitle,
    timezone: DEFAULTS.timezone,
    defaultLocale: DEFAULTS.defaultLocale,
  };
  // The demo's database is read-only and refuses the whole request on any write.
  if (isDemo()) return toSettings({ id: DEMO_ID, ...record });
  const created = await zite.settings.create({ record });
  return toSettings(created as unknown as Record<string, unknown>);
}

function currentAppUrl() {
  const url = (process.env.ZITE_APP_URL ?? '').replace(/\/+$/, '');
  return /^https:\/\//.test(url) ? url : '';
}

/**
 * Each app records its own public URL the first time it runs, so emails sent
 * from either app link to the right place without anyone configuring it.
 */
export async function rememberLearnUrl(settings: OrgSettings) {
  const url = currentAppUrl();
  // Never store the demo's host: emails would link to it, and its database is read-only.
  if (!url || url === settings.learnUrl || isDemo()) return settings;
  // Editor previews run on preview hosts; only the live URL is worth keeping.
  if (/sandbox|preview|editor|localhost/i.test(url) && settings.learnUrl) return settings;
  await zite.settings.update({ id: settings.id, record: { learnUrl: url } });
  return { ...settings, learnUrl: url };
}

export async function rememberAdminUrl(settings: OrgSettings) {
  const url = currentAppUrl();
  if (!url || url === settings.adminAppUrl || isDemo()) return settings;
  if (/sandbox|preview|editor|localhost/i.test(url) && settings.adminAppUrl) return settings;
  await zite.settings.update({ id: settings.id, record: { adminAppUrl: url } });
  return { ...settings, adminAppUrl: url };
}

const joinHash = (base: string | null, hashPath: string) => {
  if (!base) return '';
  return hashPath ? `${base}/#${hashPath.startsWith('/') ? hashPath : `/${hashPath}`}` : base;
};

/** A link into the learner app, e.g. `learnLink(s, '/courses/security-basics')`. Empty until the app has run once. */
export const learnLink = (settings: Pick<OrgSettings, 'learnUrl'>, hashPath = '') => joinHash(settings.learnUrl, hashPath);

/** A link into the admin app. */
export const adminLink = (settings: Pick<OrgSettings, 'adminAppUrl'>, hashPath = '') => joinHash(settings.adminAppUrl, hashPath);
