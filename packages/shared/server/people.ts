import { ZiteError } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { parseIdList } from '../progress';
import { DEMO_EMAIL, DEMO_ID, isDemo } from './demoPreview';
import { getSettings, type OrgSettings } from './settings';
import { colorFor } from '../palette';

/**
 * Everyone in the app is a Person: learners, instructors and admins share one
 * table, so anyone can be assigned training, report to a manager and earn a
 * certificate regardless of role.
 *
 * Every endpoint resolves the actor from the SESSION and never from an id in
 * the request, so nobody can complete lessons, grade or enroll as someone else.
 *
 * Roles:
 *   Admin      — everything, including people, roles, rules and settings
 *   Instructor — builds and teaches courses, grades, enrolls learners, sees reports
 *   Learner    — the learner app only
 */

export type Role = 'Admin' | 'Instructor' | 'Learner';
export const ROLES: Role[] = ['Admin', 'Instructor', 'Learner'];
export const asRole = (v: unknown): Role => (v === 'Admin' || v === 'Instructor' ? v : 'Learner');

export type Actor = { id: string; name: string; email: string; role: Role; status: string; managerId: string | null; created: boolean };

export const isStaff = (a: Pick<Actor, 'role'>) => a.role === 'Admin' || a.role === 'Instructor';

export function assertStaff(actor: Actor) {
  if (!isStaff(actor)) throw new ZiteError('You have learner access only. Ask an admin if you need to build courses or manage training.', 'FORBIDDEN');
}

export function assertAdmin(actor: Actor) {
  if (actor.role !== 'Admin') throw new ZiteError('Only admins can do that', 'FORBIDDEN');
}

/** Admins edit everything; instructors edit courses they own or teach. */
export function canEditCourse(actor: Pick<Actor, 'id' | 'role'>, course: { ownerId?: string | null; instructorIds?: unknown }) {
  if (actor.role === 'Admin') return true;
  if (actor.role !== 'Instructor') return false;
  if (!course.ownerId) return true;
  return course.ownerId === actor.id || parseIdList(course.instructorIds).includes(actor.id);
}

export function assertCanEditCourse(actor: Actor, course: { ownerId?: string | null; instructorIds?: unknown; title?: string | null }) {
  assertStaff(actor);
  if (!canEditCourse(actor, course)) {
    throw new ZiteError(`Only the course owner, its instructors or an admin can change ${course.title ? `“${course.title}”` : 'this course'}`, 'FORBIDDEN');
  }
}

type UserLike = { email?: string | null; firstName?: string | null; lastName?: string | null } | null | undefined;

/** A stable colour per person, so an avatar never changes between loads. */
export { colorFor };

export function nameFromEmail(email: string) {
  return email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\d+/g, '').trim().replace(/\b\w/g, c => c.toUpperCase()) || email;
}

export const normaliseEmail = (e: string | null | undefined) => (e ?? '').trim().toLowerCase();
export const isEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

async function profileFor(context: { user?: UserLike }, email: string) {
  const { rows } = await zite.sql({ query: `SELECT "name", "image" FROM "ziteUsers" WHERE LOWER("email") = $1 LIMIT 1`, params: [email] });
  const profile = rows[0] ?? {};
  const name = [context.user?.firstName, context.user?.lastName].filter(Boolean).join(' ').trim() || (profile.name ? String(profile.name) : '') || nameFromEmail(email);
  return { name, image: profile.image ? String(profile.image) : null };
}

type PersonRow = { id: string; name: string; email: string; role: string; status: string; managerId: string; lastSeenAt: string | null; lastLearnedAt: string | null };

export async function findPersonByEmail(email: string): Promise<PersonRow | undefined> {
  const { rows } = await zite.sql({
    query: `SELECT id, "name", "email", "role", "status", "managerId", "lastSeenAt", "lastLearnedAt" FROM "People" WHERE LOWER("email") = $1 ORDER BY created_at ASC LIMIT 1`,
    params: [normaliseEmail(email)],
  });
  return rows[0] as PersonRow | undefined;
}

const SEEN_EVERY_MS = 10 * 60 * 1000;

const PERSON_COLUMNS = `p.id, p."name", p."email", p."role", p."status", p."managerId", p."lastSeenAt", p."lastLearnedAt"`;

function toActor(row: PersonRow, email: string, created = false): Actor {
  return {
    id: String(row.id),
    name: String(row.name || nameFromEmail(email)),
    email,
    role: asRole(row.role),
    status: String(row.status || 'Active'),
    managerId: row.managerId ? String(row.managerId) : null,
    created,
  };
}

/**
 * The signed-in person in the ADMIN app (an internal app, so everyone here is
 * already an organization member). The first person in becomes an Admin; later
 * newcomers get the organization's default staff role. Learners are returned,
 * not rejected — callers decide with `assertStaff`, so bootstrap can explain.
 */
export async function getActor(context: { user?: UserLike }): Promise<Actor> {
  const email = normaliseEmail(context.user?.email);
  if (!email) throw new ZiteError('You need to be signed in', 'UNAUTHORIZED');

  const row = await findPersonByEmail(email);
  if (row) {
    if (row.status === 'Deactivated') throw new ZiteError('Your access has been deactivated. Ask an admin to reactivate you.', 'FORBIDDEN');
    const patch: Record<string, unknown> = {};
    if (row.status === 'Invited') patch.status = 'Active';
    const seen = row.lastSeenAt ? Date.parse(String(row.lastSeenAt)) : 0;
    if (Date.now() - seen > SEEN_EVERY_MS) patch.lastSeenAt = new Date().toISOString();
    if (Object.keys(patch).length && !isDemo(context)) await zite.people.update({ id: String(row.id), record: patch as never });
    return toActor({ ...row, status: (patch.status as string) ?? row.status }, email);
  }
  if (isDemo(context)) return demoStaff(context);

  const { name, image } = await profileFor(context, email);
  const { rows: admins } = await zite.sql({ query: `SELECT 1 FROM "People" WHERE "role" = 'Admin' AND COALESCE("status", '') <> 'Deactivated' LIMIT 1`, params: [] });
  const role: Role = admins.length ? (await getSettings()).defaultStaffRole : 'Admin';
  const now = new Date().toISOString();
  const created = await zite.people.create({
    record: { name, email, role, status: 'Active', color: colorFor(email), avatarUrl: image, lastSeenAt: now },
  });
  return { id: created.id, name, email, role, status: 'Active', managerId: null, created: true };
}

/**
 * The demo's visitor matches no one, and its read-only database can't add them,
 * so they act as the workspace's first admin (or first instructor), and as an
 * in-memory admin when there is no staff yet.
 */
async function demoStaff(context: { user?: UserLike }): Promise<Actor> {
  const { rows } = await zite.sql({
    query: `SELECT ${PERSON_COLUMNS} FROM "People" p WHERE p."role" IN ('Admin', 'Instructor') AND COALESCE(p."status", '') <> 'Deactivated' ORDER BY (p."role" = 'Admin') DESC, p.created_at ASC, p.id ASC LIMIT 1`,
    params: [],
  });
  const row = rows[0] as PersonRow | undefined;
  if (row) return toActor(row, normaliseEmail(row.email));
  return { id: DEMO_ID, name: context.user?.firstName || 'Demo User', email: DEMO_EMAIL, role: 'Admin', status: 'Active', managerId: null, created: false };
}

/** The demo's visitor sees the academy as one sample learner: the oldest who has enrollments, so the pages have something to show. */
async function demoLearner(): Promise<Actor | null> {
  const { rows } = await zite.sql({
    query: `SELECT ${PERSON_COLUMNS} FROM "People" p WHERE p."role" = 'Learner' AND COALESCE(p."status", '') <> 'Deactivated'
      ORDER BY EXISTS (SELECT 1 FROM "Enrollments" e WHERE e."personId" = p.id::text) DESC, (p."status" = 'Active') DESC, p.created_at ASC, p.id ASC LIMIT 1`,
    params: [],
  });
  const row = rows[0] as PersonRow | undefined;
  return row ? toActor(row, normaliseEmail(row.email)) : null;
}

export type LearnerAccess = { ok: true; actor: Actor } | { ok: false; reason: 'signed_out' | 'not_invited' | 'deactivated'; email: string | null };

/**
 * The signed-in person in the LEARNER app (external, so anyone on the web can
 * sign in). Existing people get in; newcomers only when the sign-in policy
 * allows them, and then as Learners. Never throws for access problems — the
 * app shows a kind explanation instead.
 */
export async function resolveLearner(context: { user?: UserLike }, settings?: OrgSettings): Promise<LearnerAccess> {
  const email = normaliseEmail(context.user?.email);
  if (!email) return { ok: false, reason: 'signed_out', email: null };
  const row = await findPersonByEmail(email);
  if (row) {
    if (row.status === 'Deactivated') return { ok: false, reason: 'deactivated', email };
    const patch: Record<string, unknown> = {};
    if (row.status === 'Invited') patch.status = 'Active';
    const seen = row.lastLearnedAt ? Date.parse(String(row.lastLearnedAt)) : 0;
    if (Date.now() - seen > SEEN_EVERY_MS) patch.lastLearnedAt = new Date().toISOString();
    if (Object.keys(patch).length && !isDemo(context)) await zite.people.update({ id: String(row.id), record: patch as never });
    return { ok: true, actor: toActor({ ...row, status: (patch.status as string) ?? row.status }, email) };
  }
  if (isDemo(context)) {
    const persona = await demoLearner();
    return persona ? { ok: true, actor: persona } : { ok: false, reason: 'not_invited', email };
  }
  const s = settings ?? (await getSettings());
  const domain = email.split('@')[1] ?? '';
  const allowed = s.signInPolicy === 'Anyone' || (s.signInPolicy === 'Allowed domains' && s.allowedDomains.some(d => domain === d || domain.endsWith(`.${d}`)));
  if (!allowed) return { ok: false, reason: 'not_invited', email };
  const { name, image } = await profileFor(context, email);
  const now = new Date().toISOString();
  const created = await zite.people.create({
    record: { name, email, role: 'Learner', status: 'Active', color: colorFor(email), avatarUrl: image, lastLearnedAt: now },
  });
  // Rules that enroll "everyone" (or future members) apply to newcomers right away.
  const { applyRulesForNewPerson } = await import('./rules');
  await applyRulesForNewPerson(created.id).catch(e => console.error('Auto-enrollment failed', e));
  return { ok: true, actor: { id: created.id, name, email, role: 'Learner', status: 'Active', managerId: null, created: true } };
}

/** For learner-app endpoints: the actor, or a clear error the client turns into the right screen. */
export async function getLearner(context: { user?: UserLike }, settings?: OrgSettings): Promise<Actor> {
  const access = await resolveLearner(context, settings);
  if (access.ok) return access.actor;
  if (access.reason === 'signed_out') throw new ZiteError('Sign in to continue', 'UNAUTHORIZED');
  if (access.reason === 'deactivated') throw new ZiteError('Your access has been deactivated. Contact your administrator.', 'FORBIDDEN');
  throw new ZiteError("You haven't been invited yet. Ask your administrator to add you.", 'FORBIDDEN');
}

/** Active admins — the fallback audience for anything nobody else owns. */
export async function adminIds(): Promise<string[]> {
  const { rows } = await zite.sql({ query: `SELECT id::text AS id FROM "People" WHERE "role" = 'Admin' AND COALESCE("status", '') <> 'Deactivated'`, params: [] });
  return rows.map(r => String(r.id));
}

/** Staff responsible for a course: its owner and instructors, or every admin when nobody is named. */
export async function courseStaffIds(courseId: string): Promise<string[]> {
  const { rows } = await zite.sql({ query: `SELECT "ownerId", "instructorIds" FROM "Courses" WHERE id::text = $1`, params: [courseId] });
  const r = rows[0];
  const ids = new Set<string>();
  if (r?.ownerId) ids.add(String(r.ownerId));
  for (const id of parseIdList(r?.instructorIds)) ids.add(id);
  if (!ids.size) return adminIds();
  const { rows: active } = await zite.sql({
    query: `SELECT id::text AS id FROM "People" WHERE id::text = ANY($1::text[]) AND COALESCE("status", '') <> 'Deactivated' AND "role" IN ('Admin', 'Instructor')`,
    params: [[...ids]],
  });
  return active.length ? active.map(a => String(a.id)) : adminIds();
}
