import { Email } from 'zitejs/email';
import { zite } from 'zitejs/db';
import { firstName, renderMerge, type MergeContext } from '../merge';
import { isDemo } from './demoPreview';
import { learnLink, type OrgSettings } from './settings';
import { str, withRetry } from './sql';

/**
 * Email to learners, managers and staff, through Zite's email integration.
 *
 * Automatic emails come from templates keyed by trigger, which admins edit in
 * Settings. A disabled or missing template means "don't send"; a failed send
 * is logged and swallowed — the enrollment, grade or certificate it
 * accompanied still happened. People who muted emails get in-app
 * notifications only.
 */

export type TemplateTrigger =
  | 'Course assigned'
  | 'Path assigned'
  | 'Due reminder'
  | 'Overdue'
  | 'Manager overdue digest'
  | 'Certificate issued'
  | 'Certificate expiring'
  | 'Submission graded'
  | 'Session registered'
  | 'Session reminder'
  | 'Invitation';

export const TEMPLATE_TRIGGERS: TemplateTrigger[] = [
  'Invitation',
  'Course assigned',
  'Path assigned',
  'Due reminder',
  'Overdue',
  'Manager overdue digest',
  'Submission graded',
  'Certificate issued',
  'Certificate expiring',
  'Session registered',
  'Session reminder',
];

export type TemplateRow = { id: string; name: string; subject: string; body: string; trigger: string; enabled: boolean };

export async function findTemplate(trigger: TemplateTrigger, opts: { requireEnabled?: boolean } = { requireEnabled: true }): Promise<TemplateRow | null> {
  const { rows } = await zite.sql({
    query: `
      SELECT id, "name", "subject", "body", "trigger", "enabled" FROM "EmailTemplates"
      WHERE "trigger" = $1 ${opts.requireEnabled ? 'AND COALESCE("enabled", false) = true' : ''}
      ORDER BY COALESCE("position", 0) ASC, created_at ASC LIMIT 1`,
    params: [trigger],
  });
  const r = rows[0];
  if (!r) return null;
  return { id: String(r.id), name: str(r.name) ?? '', subject: str(r.subject) ?? '', body: str(r.body) ?? '', trigger: str(r.trigger) ?? '', enabled: r.enabled === true };
}

export function baseMergeContext(settings: OrgSettings, person?: { name?: string | null; email?: string | null } | null): MergeContext {
  return {
    learner_name: person?.name ?? '',
    learner_first_name: firstName(person?.name) || 'there',
    learner_email: person?.email ?? '',
    organization_name: settings.organizationName,
    academy_name: settings.academyName,
    academy_link: learnLink(settings),
  };
}

type Block = { type: 'text'; content: string } | { type: 'button'; label: string; href: string; alignment?: 'left' } | { type: 'divider' } | { type: 'spacer'; height: number };

function toBlocks(text: string, settings: OrgSettings, button?: { label: string; href: string } | null, signature = true) {
  const paragraphs = text.replace(/\r\n/g, '\n').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const blocks: Block[] = paragraphs.map(p => ({ type: 'text' as const, content: p }));
  if (button?.href && /^https:\/\//.test(button.href)) blocks.push({ type: 'spacer', height: 4 }, { type: 'button', label: button.label, href: button.href, alignment: 'left' });
  const sig = settings.emailSignature.trim();
  if (signature && sig) blocks.push({ type: 'divider' }, { type: 'text', content: sig });
  return blocks;
}

export async function sendEmail(input: { to: string; subject: string; text: string; settings: OrgSettings; button?: { label: string; href: string } | null; signature?: boolean }): Promise<'Sent' | 'Failed'> {
  const to = input.to.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) return 'Failed';
  // Demo people use reserved example domains; never send real mail to them.
  if (/@([a-z0-9-]+\.)*example\.(com|org|net)$/i.test(to)) return 'Sent';
  try {
    const res = await Email.send({
      to,
      subject: input.subject.slice(0, 200),
      body: toBlocks(input.text, input.settings, input.button, input.signature ?? true) as never,
      ...(input.settings.supportEmail ? { replyTo: input.settings.supportEmail } : {}),
      ...(input.settings.logoUrl && /^https:\/\//.test(input.settings.logoUrl) ? { logo: { url: input.settings.logoUrl, height: 36 } } : {}),
    });
    return res?.success === false ? 'Failed' : 'Sent';
  } catch (e) {
    console.error('Email send failed', e instanceof Error ? e.message : e);
    return 'Failed';
  }
}

/**
 * Send a triggered template to one person, if the template is on and the
 * person hasn't muted email. Returns what happened, for callers that report it.
 */
export async function emailPerson(input: {
  trigger: TemplateTrigger;
  settings: OrgSettings;
  person: { email: string; name?: string | null; muteEmails?: boolean | null };
  context?: MergeContext;
  link?: string | null;
  buttonLabel?: string;
  template?: TemplateRow | null;
}): Promise<'Sent' | 'Failed' | 'Skipped'> {
  if (input.person.muteEmails && input.trigger !== 'Invitation') return 'Skipped';
  const template = input.template === undefined ? await findTemplate(input.trigger) : input.template;
  if (!template) return 'Skipped';
  const ctx: MergeContext = { ...baseMergeContext(input.settings, input.person), ...(input.context ?? {}) };
  return sendEmail({
    to: input.person.email,
    subject: renderMerge(template.subject, ctx),
    text: renderMerge(template.body, ctx),
    settings: input.settings,
    button: input.link ? { label: input.buttonLabel ?? 'Open in the academy', href: input.link } : null,
  });
}

/**
 * Give a new workspace the default emails, so invitations, assignments and
 * reminders go out from the first day. Only an empty table is filled: after
 * that, a switched-off template stays off, and a trigger added in a later
 * version waits for an admin to set it up in Settings. Returns whether it
 * created anything.
 */
export async function ensureDefaultTemplates(): Promise<boolean> {
  if (isDemo()) return false;
  const { rows } = await zite.sql({ query: `SELECT 1 AS "found" FROM "EmailTemplates" LIMIT 1`, params: [] });
  if (rows.length) return false;
  await withRetry(() => zite.emailTemplates.bulkCreate({ records: DEFAULT_TEMPLATES.map((t, i) => ({ ...t, position: i })) }));
  return true;
}

/** The starting set of templates. Created on a new workspace's first load and restorable from Settings. */
export const DEFAULT_TEMPLATES: Array<{ name: string; trigger: TemplateTrigger; subject: string; body: string; enabled: boolean }> = [
  {
    name: 'Invitation',
    trigger: 'Invitation',
    subject: "You’re invited to {{academy_name}}",
    body: "Hi {{learner_first_name}},\n\n{{organization_name}} has set up {{academy_name}} for training and development, and you’ve been added.\n\nSign in with this email address to see the courses assigned to you and explore the catalog.",
    enabled: true,
  },
  {
    name: 'Course assigned',
    trigger: 'Course assigned',
    subject: 'New training: {{course_title}}',
    body: 'Hi {{learner_first_name}},\n\nYou have been assigned {{course_title}}.\n\nPlease complete it by {{due_date}}. You can stop at any time and pick up exactly where you left off.',
    enabled: true,
  },
  {
    name: 'Learning path assigned',
    trigger: 'Path assigned',
    subject: 'Your learning path: {{course_title}}',
    body: "Hi {{learner_first_name}},\n\nYou’ve been enrolled in the {{course_title}} learning path. It brings together a series of courses to take in order.\n\nTarget completion date: {{due_date}}.",
    enabled: true,
  },
  {
    name: 'Due date reminder',
    trigger: 'Due reminder',
    subject: 'Reminder: {{course_title}} is due in {{days_left}}',
    body: "Hi {{learner_first_name}},\n\nA friendly reminder that {{course_title}} is due on {{due_date}}. You’re almost there — it only takes a few minutes to keep going.",
    enabled: true,
  },
  {
    name: 'Overdue training',
    trigger: 'Overdue',
    subject: 'Overdue: {{course_title}}',
    body: 'Hi {{learner_first_name}},\n\n{{course_title}} was due on {{due_date}} and is not yet complete. Please finish it as soon as you can.\n\nIf something is stopping you, reply to this email and we will help.',
    enabled: true,
  },
  {
    name: 'Manager digest: overdue training',
    trigger: 'Manager overdue digest',
    subject: 'Your team has overdue training',
    body: 'Hi {{manager_name}},\n\nSome of your direct reports have training past its due date:\n\n{{overdue_list}}\n\nA quick nudge from you goes a long way. You can see your team’s progress in the academy.',
    enabled: true,
  },
  {
    name: 'Assignment graded',
    trigger: 'Submission graded',
    subject: 'Your assignment has been reviewed: {{lesson_title}}',
    body: 'Hi {{learner_first_name}},\n\nYour submission for "{{lesson_title}}" in {{course_title}} has been reviewed.\n\nGrade: {{grade}}\n\nFeedback from your instructor:\n{{feedback}}',
    enabled: true,
  },
  {
    name: 'Certificate earned',
    trigger: 'Certificate issued',
    subject: 'Congratulations — you completed {{course_title}}',
    body: 'Hi {{learner_first_name}},\n\nWell done! You have completed {{course_title}} and earned a certificate.\n\nCredential ID: {{credential_id}}\n\nYou can download it or share its verification link any time.',
    enabled: true,
  },
  {
    name: 'Certificate expiring',
    trigger: 'Certificate expiring',
    subject: 'Your {{course_title}} certificate expires on {{expires_on}}',
    body: "Hi {{learner_first_name}},\n\nYour certificate for {{course_title}} expires on {{expires_on}}. We’ve re-enrolled you so you can recertify before then.",
    enabled: true,
  },
  {
    name: 'Session registration',
    trigger: 'Session registered',
    subject: "You’re registered: {{session_title}}",
    body: "Hi {{learner_first_name}},\n\nYou’re registered for {{session_title}}.\n\nWhen: {{session_time}}\nWhere: {{session_location}}\n\nWe’ll send a reminder the day before.",
    enabled: true,
  },
  {
    name: 'Session reminder',
    trigger: 'Session reminder',
    subject: 'Tomorrow: {{session_title}}',
    body: 'Hi {{learner_first_name}},\n\nThis is a reminder that {{session_title}} starts {{session_time}}.\n\nWhere: {{session_location}}',
    enabled: true,
  },
];
