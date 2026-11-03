import { z } from 'zod';
import { ZiteError } from 'zitejs/backend';
import type { OrgSettings } from '@project/shared/server/settings';

/**
 * Helpers for the Settings endpoints: the settings shape the client caches
 * (the same subset bootstrap sends) and the validators every write goes through.
 */

export const settingsSchema = z.object({
  organizationName: z.string(),
  logoUrl: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  supportEmail: z.string().nullable(),
  brandColor: z.string(),
  academyName: z.string(),
  academyHeadline: z.string(),
  academyIntro: z.string(),
  signInPolicy: z.enum(['Invited only', 'Allowed domains', 'Anyone']),
  allowedDomains: z.array(z.string()),
  selfEnrollment: z.boolean(),
  leaderboardEnabled: z.boolean(),
  discussionsEnabled: z.boolean(),
  defaultStaffRole: z.enum(['Instructor', 'Learner']),
  reminderDaysBefore: z.number(),
  escalateOverdue: z.boolean(),
  emailSignature: z.string(),
  certificateTitle: z.string(),
  certificateSignatory: z.string(),
  certificateSignatoryTitle: z.string(),
  timezone: z.string(),
  defaultLocale: z.enum(['en', 'id']),
  learnUrl: z.string().nullable(),
});

export type SettingsPayload = z.infer<typeof settingsSchema>;

/** Exactly the fields bootstrap sends, so the client can merge a save straight into its cache. */
export function settingsPayload(s: OrgSettings): SettingsPayload {
  return {
    organizationName: s.organizationName,
    logoUrl: s.logoUrl,
    websiteUrl: s.websiteUrl,
    supportEmail: s.supportEmail,
    brandColor: s.brandColor,
    academyName: s.academyName,
    academyHeadline: s.academyHeadline,
    academyIntro: s.academyIntro,
    signInPolicy: s.signInPolicy,
    allowedDomains: s.allowedDomains,
    selfEnrollment: s.selfEnrollment,
    leaderboardEnabled: s.leaderboardEnabled,
    discussionsEnabled: s.discussionsEnabled,
    defaultStaffRole: s.defaultStaffRole,
    reminderDaysBefore: s.reminderDaysBefore,
    escalateOverdue: s.escalateOverdue,
    emailSignature: s.emailSignature,
    certificateTitle: s.certificateTitle,
    certificateSignatory: s.certificateSignatory,
    certificateSignatoryTitle: s.certificateSignatoryTitle,
    timezone: s.timezone,
    defaultLocale: s.defaultLocale,
    learnUrl: s.learnUrl,
  };
}

/** The first schema problem as a sentence, for a BAD_REQUEST a person can read. */
export function inputError(error: z.ZodError, fallback = "Some of those details aren't valid") {
  return new ZiteError(error.issues[0]?.message ?? fallback, 'BAD_REQUEST');
}

export const HEX_RE = /^#[0-9a-f]{6}$/i;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidTimezone(timeZone: string) {
  if (!timeZone || !/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(timeZone)) return false;
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * "example.org" → "https://example.org". Empty is null (cleared). Anything that
 * isn't a secure web address is refused with a message naming the field.
 */
export function httpsUrl(value: string | null | undefined, field: string): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ZiteError(`The ${field} isn't a web address. Use something like https://example.com.`, 'BAD_REQUEST');
  }
  if (url.protocol !== 'https:') throw new ZiteError(`The ${field} must be a secure https:// address.`, 'BAD_REQUEST');
  if (!url.hostname.includes('.')) throw new ZiteError(`The ${field} needs a full domain, like example.com.`, 'BAD_REQUEST');
  // URL adds a trailing slash to a bare domain; keep addresses the way people write them.
  return url.pathname === '/' && !url.search && !url.hash ? url.origin : url.toString();
}
