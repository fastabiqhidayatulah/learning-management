import { zite } from 'zitejs/db';
import { DEFAULT_BRAND, DEFAULTS, getSettings, type OrgSettings } from '@project/shared/server/settings';
import { num, withRetry } from '@project/shared/server/sql';
import { DEMO_ORG } from '../seed/org';

/**
 * The sample academy, how to recognise it, and how to take it away again.
 *
 * Nothing loads it on its own. An admin loads it from Settings → Data while
 * the workspace has no courses, learning paths or live sessions, and removes it
 * from the same page.
 *
 * Demo rows are the ones the seed created: everything inserted from just
 * before `seededAt` until a few minutes after it (the seed takes seconds).
 * Business timestamps like `enrolledAt` are backdated by the seed, but the
 * system `created_at` is the real insert time, so it's the reliable marker.
 * The window has a lower bound because the sample can go into a workspace
 * that is already partly set up: people, groups and categories created before
 * it stay. Seeded people all use reserved example domains, so a person is only
 * demo when both the window and the address say so, and the admin who loaded
 * it is never removed.
 */

/**
 * Normally 15 minutes. The local review harness shrinks it (via an env var the
 * live runtime never sets) so rows created a minute after seeding count as real
 * data without waiting a quarter of an hour. Parsed as a number, so nothing but
 * digits ever reaches the SQL.
 */
function windowMinutes() {
  const raw = Number(typeof process !== 'undefined' ? process.env?.DEMO_WINDOW_MINUTES : undefined);
  return Number.isFinite(raw) && raw > 0 && raw <= 1440 ? raw : 15;
}

export const DEMO_WINDOW = `INTERVAL '${windowMinutes()} minutes'`;

/**
 * "This row was created by the seed", for a query whose `$1` is `seededAt`.
 * The window opens a minute early to cover clock skew between the endpoint,
 * which stamps `seededAt`, and the database, which stamps `created_at`.
 */
export const inDemoWindow = (alias = '') => {
  const col = `${alias ? `${alias}.` : ''}created_at`;
  return `(${col} >= $1::timestamptz - INTERVAL '1 minute' AND ${col} <= $1::timestamptz + ${DEMO_WINDOW})`;
};

/** Work per removal call. The harness can shrink it (DEMO_BUDGET_MS) to exercise resuming across calls. */
function budgetDefault() {
  const raw = Number(typeof process !== 'undefined' ? process.env?.DEMO_BUDGET_MS : undefined);
  return Number.isFinite(raw) && raw >= 50 && raw <= 60_000 ? raw : 25_000;
}
export const EXAMPLE_EMAIL = `'@([a-z0-9-]+\\.)*example\\.(org|com|net)$'`;

/**
 * Whether the sample is in the workspace. `seededAt` is when it was loaded,
 * and removing it clears the field. Earlier versions wrote 2000-01-01 there
 * instead of clearing it, so anything before 2001 also means "not loaded".
 */
export const sampleLoaded = (settings: Pick<OrgSettings, 'seededAt'>) => Boolean(settings.seededAt) && Date.parse(settings.seededAt!) >= Date.parse('2001-01-01T00:00:00.000Z');

/**
 * Courses, learning paths and live sessions are what an organization builds
 * its training from, so any one of them means the workspace is in real use.
 * People, groups, categories and email templates don't count: setting those
 * up first and then loading the sample to look around is fine, and they
 * survive its removal.
 */
export async function hasRealContent(): Promise<boolean> {
  // Counts rather than EXISTS: a number parses the same whatever the driver returns, and this gates writing into a workspace.
  const { rows } = await zite.sql({
    query: `SELECT (SELECT COUNT(*) FROM "Courses") + (SELECT COUNT(*) FROM "Paths") + (SELECT COUNT(*) FROM "Sessions") AS "inUse"`,
    params: [],
  });
  return num(rows[0]?.inUse) > 0;
}

/** The sample can be loaded while it isn't loaded already and nothing real has been built yet. */
export async function canLoadSample(settings: Pick<OrgSettings, 'seededAt'>): Promise<boolean> {
  return !sampleLoaded(settings) && !(await hasRealContent());
}

/**
 * The organization details the sample fills in, and what each one reads when
 * nobody has set it. Loading writes the demo's value only over the default,
 * and removal puts the default back only where the demo's value is still
 * there, so anything an admin typed survives both.
 */
export const DEMO_ORG_FIELDS: Array<{ key: keyof typeof DEMO_ORG; unset: string | null; label: string }> = [
  { key: 'organizationName', unset: DEFAULTS.organizationName, label: 'Organization name' },
  { key: 'academyName', unset: DEFAULTS.academyName, label: 'Academy name' },
  { key: 'academyHeadline', unset: DEFAULTS.academyHeadline, label: 'Academy headline' },
  { key: 'academyIntro', unset: DEFAULTS.academyIntro, label: 'Academy introduction' },
  { key: 'brandColor', unset: DEFAULT_BRAND, label: 'Brand colour' },
  { key: 'supportEmail', unset: null, label: 'Support email' },
  { key: 'websiteUrl', unset: null, label: 'Website' },
  { key: 'emailSignature', unset: '', label: 'Email signature' },
  { key: 'certificateSignatory', unset: '', label: 'Certificate signatory' },
  { key: 'certificateSignatoryTitle', unset: '', label: 'Signatory title' },
  { key: 'timezone', unset: DEFAULTS.timezone, label: 'Time zone' },
];

/** The job title and hire date the seed gives the admin who loads it, so the story has a COO. */
export const SEED_ADMIN = { title: 'Chief Operating Officer', hireDaysAgo: 2600 };

/** The hire date the seed gave that admin, as a calendar day. */
export const seedAdminHireDate = (seededAt: string) => new Date(Date.parse(seededAt) - SEED_ADMIN.hireDaysAgo * 86_400_000).toISOString().slice(0, 10);

export type DemoCounts = { courses: number; people: number; enrollments: number };

/** What's left of the sample, or null when it isn't loaded. Zeros are possible (someone deleted it by hand), and still mean "loaded": removal finishes the job. */
export async function demoCounts(settings: OrgSettings): Promise<DemoCounts | null> {
  if (!sampleLoaded(settings)) return null;
  const { rows } = await zite.sql({
    query: `
      SELECT
        (SELECT COUNT(*) FROM "Courses" WHERE ${inDemoWindow()}) AS "courseTotal",
        (SELECT COUNT(*) FROM "People" WHERE ${inDemoWindow()} AND LOWER("email") ~ ${EXAMPLE_EMAIL}) AS "peopleTotal",
        (SELECT COUNT(*) FROM "Enrollments" WHERE ${inDemoWindow()}) AS "enrollmentTotal"`,
    params: [settings.seededAt],
  });
  const r = rows[0] ?? {};
  return { courses: num(r.courseTotal), people: num(r.peopleTotal), enrollments: num(r.enrollmentTotal) };
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

export type DemoTable =
  | 'notifications' | 'activity' | 'views' | 'lessonProgress' | 'quizAttempts' | 'submissions' | 'certificates' | 'registrations' | 'comments'
  | 'enrollments' | 'pathEnrollments' | 'groupMembers' | 'pathCourses' | 'assignmentRules' | 'sessions' | 'lessons' | 'sections'
  | 'groups' | 'categories' | 'paths' | 'courses' | 'people';

export type DemoRemoval = {
  dryRun: boolean;
  /** False when this call ran out of time before finishing; call again to continue. */
  done: boolean;
  /** Rows deleted by this call (or, in a dry run, that would be deleted in total). */
  removed: number;
  tables: Record<string, number>;
  /** Real rows that pointed at a demo person, group or enrollment and are unlinked rather than deleted. */
  detached: number;
  /** Organization details still showing the demo's values, reset to neutral defaults. */
  reset: string[];
};

type Deletable = { delete: (a: { id: string }) => Promise<unknown> };
type Updatable = { update: (a: { id: string; record: never }) => Promise<unknown> };

const PAGE = 2000;

/** Every id a query returns. zite.sql caps a result at 2000 rows, so page by id. */
async function ids(query: string, params: unknown[]): Promise<string[]> {
  const out: string[] = [];
  for (let after = ''; ; ) {
    const { rows } = await zite.sql({
      query: `SELECT q.id::text AS id FROM (${query}) q WHERE q.id::text > $${params.length + 1} ORDER BY q.id::text LIMIT ${PAGE}`,
      params: [...params, after],
    });
    out.push(...rows.map(r => String(r.id)));
    if (rows.length < PAGE) return out;
    after = out[out.length - 1];
  }
}


const unique = (...lists: string[][]) => [...new Set(lists.flat())];

/**
 * Remove the demo academy. Anything created before the seed or since it
 * stays, except rows that hang off a demo course, path, person, session, group
 * or enrollment: those would be orphaned, so they go too.
 *
 * Children are deleted first and parents last, and `seededAt` is cleared
 * only at the very end, so an interrupted run leaves nothing dangling and
 * simply finishes when run again. A dry run performs every lookup and returns
 * the counts without writing anything.
 *
 * Live Zite rate-limits bursts of writes (about 14 a second is safe), so a
 * full demo of ~2,500 rows takes a few minutes. Rather than one long request
 * that could time out, each call works for `budgetMs` and reports `done:
 * false` if there's more; every call re-derives what's left, so the client
 * just calls again and shows progress in between.
 */
export async function removeDemoData(actorId: string, { dryRun = false, budgetMs = budgetDefault() } = {}): Promise<DemoRemoval> {
  const deadline = Date.now() + budgetMs;
  const settings = await getSettings();
  const empty: DemoRemoval = { dryRun, done: true, removed: 0, tables: {}, detached: 0, reset: [] };
  if (!sampleLoaded(settings)) return empty;
  const at = settings.seededAt!;
  const inWindow = inDemoWindow;

  // ── What counts as demo ───────────────────────────────────────────────
  // Postgres refuses a bound parameter a query never references, so each lookup passes exactly what it uses.
  const courses = await ids(`SELECT id FROM "Courses" WHERE ${inWindow()}`, [at]);
  const paths = await ids(`SELECT id FROM "Paths" WHERE ${inWindow()}`, [at]);
  const people = await ids(`SELECT id FROM "People" WHERE ${inWindow()} AND LOWER("email") ~ ${EXAMPLE_EMAIL} AND id::text <> $2`, [at, actorId]);
  const groups = await ids(`SELECT id FROM "Groups" WHERE ${inWindow()}`, [at]);
  const sessions = await ids(`SELECT id FROM "Sessions" WHERE ${inWindow()} OR "courseId" = ANY($2::text[])`, [at, courses]);
  const lessons = await ids(`SELECT id FROM "Lessons" WHERE ${inWindow()} OR "courseId" = ANY($2::text[])`, [at, courses]);
  const sections = await ids(`SELECT id FROM "Sections" WHERE ${inWindow()} OR "courseId" = ANY($2::text[])`, [at, courses]);
  const enrollments = await ids(`SELECT id FROM "Enrollments" WHERE ${inWindow()} OR "courseId" = ANY($2::text[]) OR "personId" = ANY($3::text[])`, [at, courses, people]);
  const pathEnrollments = await ids(`SELECT id FROM "PathEnrollments" WHERE ${inWindow()} OR "pathId" = ANY($2::text[]) OR "personId" = ANY($3::text[])`, [at, paths, people]);
  const anyEnrollment = unique(enrollments, pathEnrollments);

  const byLearning = (table: string) =>
    ids(`SELECT id FROM "${table}" WHERE ${inWindow()} OR "enrollmentId" = ANY($2::text[]) OR "courseId" = ANY($3::text[]) OR "personId" = ANY($4::text[])`, [at, enrollments, courses, people]);
  const lessonProgress = await byLearning('LessonProgress');
  const quizAttempts = await byLearning('QuizAttempts');
  const submissions = await byLearning('Submissions');
  const certificates = await ids(
    `SELECT id FROM "Certificates" WHERE ${inWindow()} OR "courseId" = ANY($2::text[]) OR "pathId" = ANY($3::text[]) OR "personId" = ANY($4::text[]) OR "enrollmentId" = ANY($5::text[])`,
    [at, courses, paths, people, anyEnrollment],
  );
  const registrations = await ids(`SELECT id FROM "Registrations" WHERE ${inWindow()} OR "sessionId" = ANY($2::text[]) OR "personId" = ANY($3::text[])`, [at, sessions, people]);
  const questions = await ids(`SELECT id FROM "Comments" WHERE ${inWindow()} OR "courseId" = ANY($2::text[]) OR "lessonId" = ANY($3::text[]) OR "personId" = ANY($4::text[])`, [at, courses, lessons, people]);
  // A real reply under a demo question would be left answering nothing.
  const comments = unique(questions, await ids(`SELECT id FROM "Comments" WHERE "parentId" = ANY($1::text[])`, [questions]));
  const groupMembers = await ids(`SELECT id FROM "GroupMembers" WHERE ${inWindow()} OR "groupId" = ANY($2::text[]) OR "personId" = ANY($3::text[])`, [at, groups, people]);
  const pathCourses = await ids(`SELECT id FROM "PathCourses" WHERE ${inWindow()} OR "pathId" = ANY($2::text[]) OR "courseId" = ANY($3::text[])`, [at, paths, courses]);
  const rules = await ids(`SELECT id FROM "AssignmentRules" WHERE ${inWindow()} OR "courseId" = ANY($2::text[]) OR "pathId" = ANY($3::text[])`, [at, courses, paths]);
  const notifications = await ids(
    `SELECT id FROM "Notifications" WHERE ${inWindow()} OR "recipientId" = ANY($2::text[]) OR "actorId" = ANY($2::text[]) OR "courseId" = ANY($3::text[]) OR "pathId" = ANY($4::text[])`,
    [at, people, courses, paths],
  );
  const activity = await ids(
    `SELECT id FROM "Activity" WHERE ${inWindow()} OR "personId" = ANY($2::text[]) OR "actorId" = ANY($2::text[]) OR "courseId" = ANY($3::text[]) OR "pathId" = ANY($4::text[]) OR "enrollmentId" = ANY($5::text[])`,
    [at, people, courses, paths, anyEnrollment],
  );
  // A category goes only once nothing real would be left uncategorised by it.
  const categories = await ids(
    `SELECT c.id FROM "Categories" c
     WHERE ${inWindow('c')}
       AND NOT EXISTS (SELECT 1 FROM "Courses" x WHERE x."categoryId" = c.id::text AND NOT (x.id::text = ANY($2::text[])))
       AND NOT EXISTS (SELECT 1 FROM "Paths" y WHERE y."categoryId" = c.id::text AND NOT (y.id::text = ANY($3::text[])))`,
    [at, courses, paths],
  );
  // Saved views: the demo's own, a demo person's, and any whose filters point at something about to disappear.
  const referenced = unique(courses, paths, groups, categories, people);
  const views = await ids(
    `SELECT v.id FROM "Views" v
     WHERE ${inWindow('v')} OR v."ownerId" = ANY($2::text[])
        OR EXISTS (SELECT 1 FROM unnest($3::text[]) AS d(ref) WHERE v."config" LIKE '%' || d.ref || '%')`,
    [at, people, referenced],
  );

  // ── Real rows that point at demo people or records: unlink, don't delete ──
  type Detach = { client: Updatable; table: string; id: string; record: Record<string, unknown> };
  const detach: Detach[] = [];
  const nullOut = async (table: string, client: Updatable, column: string, targets: string[], keep: string[]) => {
    if (!targets.length) return;
    const found = await ids(`SELECT id FROM "${table}" WHERE "${column}" = ANY($1::text[]) AND NOT (id::text = ANY($2::text[]))`, [targets, keep]);
    for (const id of found) detach.push({ client, table, id, record: { [column]: null } });
  };
  await nullOut('People', zite.people as unknown as Updatable, 'managerId', people, people);
  await nullOut('Courses', zite.courses as unknown as Updatable, 'ownerId', people, courses);
  await nullOut('Paths', zite.paths as unknown as Updatable, 'ownerId', people, paths);
  await nullOut('Groups', zite.groups as unknown as Updatable, 'ownerId', people, groups);
  await nullOut('Sessions', zite.sessions as unknown as Updatable, 'instructorId', people, sessions);
  await nullOut('AssignmentRules', zite.assignmentRules as unknown as Updatable, 'createdById', people, rules);
  await nullOut('Enrollments', zite.enrollments as unknown as Updatable, 'assignedById', people, enrollments);
  await nullOut('Enrollments', zite.enrollments as unknown as Updatable, 'pathEnrollmentId', pathEnrollments, enrollments);
  await nullOut('PathEnrollments', zite.pathEnrollments as unknown as Updatable, 'assignedById', people, pathEnrollments);
  await nullOut('Submissions', zite.submissions as unknown as Updatable, 'gradedById', people, submissions);
  await nullOut('Certificates', zite.certificates as unknown as Updatable, 'issuedById', people, certificates);

  // JSON id lists on real rows: instructors on a course, a rule's groups and people.
  const pruneList = async (table: string, client: Updatable, column: string, targets: string[], keep: string[]) => {
    if (!targets.length) return;
    const { rows } = await zite.sql({
      query: `SELECT id::text AS id, "${column}" AS list FROM "${table}" t
              WHERE NOT (t.id::text = ANY($2::text[])) AND EXISTS (SELECT 1 FROM unnest($1::text[]) AS d(ref) WHERE COALESCE(t."${column}", '') LIKE '%' || d.ref || '%')`,
      params: [targets, keep],
    });
    const gone = new Set(targets);
    for (const r of rows) {
      let list: unknown;
      try {
        list = JSON.parse(String(r.list || '[]'));
      } catch {
        continue;
      }
      if (!Array.isArray(list)) continue;
      const next = list.filter(v => !gone.has(String(v)));
      if (next.length !== list.length) detach.push({ client, table, id: String(r.id), record: { [column]: JSON.stringify(next) } });
    }
  };
  await pruneList('Courses', zite.courses as unknown as Updatable, 'instructorIds', people, courses);
  await pruneList('AssignmentRules', zite.assignmentRules as unknown as Updatable, 'groupIds', groups, rules);
  await pruneList('AssignmentRules', zite.assignmentRules as unknown as Updatable, 'personIds', people, rules);

  // ── Organization details still showing the demo's ────────────────────
  const reset: Record<string, string | null> = {};
  const resetLabels: string[] = [];
  for (const f of DEMO_ORG_FIELDS) {
    if (settings[f.key] === DEMO_ORG[f.key]) {
      reset[f.key] = f.unset;
      resetLabels.push(f.label);
    }
  }

  // The seed gave the admin who loaded it a job title and hire date for the story; take them back if both are untouched.
  // The hire date is matched to within a day, so the database's time zone can't shift it off the match.
  const { rows: storyRows } = await zite.sql({
    query: `SELECT id::text AS id FROM "People"
            WHERE "title" = $1 AND "hireDate"::date BETWEEN $2::date - 1 AND $2::date + 1
              AND created_at <= $3::timestamptz AND NOT (LOWER("email") ~ ${EXAMPLE_EMAIL})`,
    params: [SEED_ADMIN.title, seedAdminHireDate(at), at],
  });
  const storyPeople = storyRows.map(r => String(r.id));
  if (storyPeople.length) resetLabels.push(storyPeople.includes(actorId) ? 'The demo job title on your profile' : 'The demo job title on the installing admin’s profile');

  // ── Delete: children first, parents last ─────────────────────────────
  let done = true;
  /** Writes for one step, two at a time and rate-limit-safe; stops taking new work once the time budget is spent. */
  const write = async <T,>(items: T[], fn: (item: T) => Promise<unknown>) => {
    if (dryRun) return items.length;
    if (!done || !items.length) return 0; // An earlier step ran out of time: keep the order, finish next call.
    let next = 0;
    let completed = 0;
    const worker = async () => {
      while (next < items.length) {
        if (Date.now() > deadline) {
          done = false;
          return;
        }
        const item = items[next++];
        await withRetry(() => fn(item));
        completed++;
      }
    };
    await Promise.all([worker(), worker()]);
    return completed;
  };

  const tables: Record<string, number> = {};
  let removed = 0;
  const remove = async (name: DemoTable, client: unknown, list: string[]) => {
    const n = await write(list, id => (client as Deletable).delete({ id }));
    tables[name] = n;
    removed += n;
  };

  await remove('notifications', zite.notifications, notifications);
  await remove('activity', zite.activity, activity);
  await remove('views', zite.views, views);
  await remove('lessonProgress', zite.lessonProgress, lessonProgress);
  await remove('quizAttempts', zite.quizAttempts, quizAttempts);
  await remove('submissions', zite.submissions, submissions);
  await remove('certificates', zite.certificates, certificates);
  await remove('registrations', zite.registrations, registrations);
  await remove('comments', zite.comments, comments);
  await remove('enrollments', zite.enrollments, enrollments);
  await remove('pathEnrollments', zite.pathEnrollments, pathEnrollments);
  await remove('groupMembers', zite.groupMembers, groupMembers);
  await remove('pathCourses', zite.pathCourses, pathCourses);
  await remove('assignmentRules', zite.assignmentRules, rules);
  await remove('sessions', zite.sessions, sessions);
  await remove('lessons', zite.lessons, lessons);
  await remove('sections', zite.sections, sections);

  // Real records stop pointing at people and groups that are about to go.
  const detached = await write(detach, d => d.client.update({ id: d.id, record: d.record as never }));

  await remove('groups', zite.groups, groups);
  await remove('categories', zite.categories, categories);
  await remove('paths', zite.paths, paths);
  await remove('courses', zite.courses, courses);
  await remove('people', zite.people, people);

  if (!dryRun && done) {
    await write(storyPeople, id => zite.people.update({ id, record: { title: null, hireDate: null } }));
    // Last write of all: once seededAt is cleared, the demo is officially gone and this can't run again.
    if (done) await withRetry(() => zite.settings.update({ id: settings.id, record: { ...reset, seededAt: null } as never }));
  }

  return { dryRun, done, removed, tables, detached, reset: resetLabels };
}
