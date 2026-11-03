import { z } from 'zod';
import { createEndpoint } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { toCourse, toPath } from '@project/shared/server/courses';
import { ensureDefaultTemplates } from '@project/shared/server/email';
import { canEditCourse, getActor, isStaff } from '@project/shared/server/people';
import { getSettings, rememberAdminUrl } from '@project/shared/server/settings';
import { bool, iso, num, ref, str } from '@project/shared/server/sql';
import { isConfigured } from '../server/ai';
import { canLoadSample, demoCounts } from '../server/demo';

/**
 * Everything the admin app renders names from, loaded once and indexed on the
 * client: settings, staff, groups, categories, courses and paths with their
 * headline numbers, templates, saved views and the sidebar counts.
 *
 * Learners (and the long tail of people generally) are NOT here — an
 * organization can have thousands. Lists carry names in their rows, and the
 * person pickers search on demand.
 *
 * A new workspace starts empty. Its first load creates the settings row, makes
 * the first person in an Admin and adds the default email templates; the
 * sample academy only arrives if an admin loads it from Settings → Data.
 */

const counts = z.object({ enrolled: z.number(), notStarted: z.number(), inProgress: z.number(), completed: z.number(), overdue: z.number() });

const Output = z.object({
    access: z.enum(['staff', 'learner']),
    me: z.object({ id: z.string(), name: z.string(), email: z.string(), role: z.enum(['Admin', 'Instructor', 'Learner']), color: z.string(), avatarUrl: z.string().nullable() }),
    settings: z.object({
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
    }),
    staff: z.array(z.object({ id: z.string(), name: z.string(), email: z.string(), role: z.string(), status: z.string(), color: z.string(), avatarUrl: z.string().nullable(), title: z.string().nullable(), lastSeenAt: z.string().nullable() })),
    peopleCount: z.object({ total: z.number(), active: z.number(), invited: z.number(), deactivated: z.number() }),
    groups: z.array(z.object({ id: z.string(), name: z.string(), kind: z.string(), description: z.string(), color: z.string(), ownerId: z.string().nullable(), ownerName: z.string().nullable(), position: z.number(), memberCount: z.number() })),
    categories: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), color: z.string(), icon: z.string(), position: z.number(), courseCount: z.number() })),
    courses: z.array(z.object({
      id: z.string(), title: z.string(), slug: z.string(), summary: z.string(), icon: z.string(), color: z.string(), coverImageUrl: z.string().nullable(),
      categoryId: z.string().nullable(), level: z.string(), status: z.enum(['Draft', 'Published', 'Archived']), visibility: z.enum(['Catalog', 'Private']),
      ownerId: z.string().nullable(), instructorIds: z.array(z.string()), sequential: z.boolean(), estimatedMinutes: z.number(), dueDays: z.number().nullable(),
      certificateEnabled: z.boolean(), certificateValidityMonths: z.number().nullable(), skills: z.array(z.string()), publishedAt: z.string().nullable(),
      position: z.number(), createdAt: z.string().nullable(), updatedAt: z.string().nullable(), lessonCount: z.number(), canEdit: z.boolean(),
      counts, rating: z.object({ average: z.number().nullable(), count: z.number() }),
    })),
    paths: z.array(z.object({
      id: z.string(), title: z.string(), slug: z.string(), summary: z.string(), icon: z.string(), color: z.string(), coverImageUrl: z.string().nullable(),
      categoryId: z.string().nullable(), status: z.enum(['Draft', 'Published', 'Archived']), visibility: z.enum(['Catalog', 'Private']), ownerId: z.string().nullable(),
      sequential: z.boolean(), dueDays: z.number().nullable(), certificateEnabled: z.boolean(), certificateValidityMonths: z.number().nullable(),
      publishedAt: z.string().nullable(), position: z.number(), createdAt: z.string().nullable(), courseIds: z.array(z.string()), counts,
    })),
    templates: z.array(z.object({ id: z.string(), name: z.string(), subject: z.string(), body: z.string(), trigger: z.string(), enabled: z.boolean(), position: z.number() })),
    views: z.array(z.object({ id: z.string(), name: z.string(), ownerId: z.string().nullable(), scope: z.enum(['Personal', 'Shared']), page: z.string(), config: z.string(), position: z.number() })),
    counts: z.object({ inboxUnread: z.number(), toGrade: z.number(), openQuestions: z.number(), overdue: z.number(), expiringCertificates: z.number(), upcomingSessions: z.number() }),
    features: z.object({ ai: z.boolean() }),
    /** Admins only: what's left of the demo while it's loaded, otherwise null. */
    demo: z.object({ courses: z.number(), people: z.number(), enrollments: z.number() }).nullable(),
    /** Admins only: whether the sample academy can be loaded (see `canLoadSample`). */
    canLoadSample: z.boolean(),
});

export default createEndpoint({
  description: 'Load workspace reference data for the signed-in staff member',
  authenticated: true,
  inputSchema: z.object({}),
  outputSchema: Output,
  execute: async ({ context }): Promise<z.infer<typeof Output>> => {
    const actor = await getActor(context);
    let settings = await getSettings();
    settings = await rememberAdminUrl(settings);

    const baseSettings = {
      organizationName: settings.organizationName,
      logoUrl: settings.logoUrl,
      websiteUrl: settings.websiteUrl,
      supportEmail: settings.supportEmail,
      brandColor: settings.brandColor,
      academyName: settings.academyName,
      academyHeadline: settings.academyHeadline,
      academyIntro: settings.academyIntro,
      signInPolicy: settings.signInPolicy,
      allowedDomains: settings.allowedDomains,
      selfEnrollment: settings.selfEnrollment,
      leaderboardEnabled: settings.leaderboardEnabled,
      discussionsEnabled: settings.discussionsEnabled,
      defaultStaffRole: settings.defaultStaffRole,
      reminderDaysBefore: settings.reminderDaysBefore,
      escalateOverdue: settings.escalateOverdue,
      emailSignature: settings.emailSignature,
      certificateTitle: settings.certificateTitle,
      certificateSignatory: settings.certificateSignatory,
      certificateSignatoryTitle: settings.certificateSignatoryTitle,
      timezone: settings.timezone,
      defaultLocale: settings.defaultLocale,
      learnUrl: settings.learnUrl,
    };

    const { rows: meRows } = await zite.sql({ query: `SELECT "color", "avatarUrl" FROM "People" WHERE id::text = $1`, params: [actor.id] });
    const me = { id: actor.id, name: actor.name, email: actor.email, role: actor.role, color: str(meRows[0]?.color) || '#2f6b55', avatarUrl: ref(meRows[0]?.avatarUrl) };
    const empty = { staff: [], peopleCount: { total: 0, active: 0, invited: 0, deactivated: 0 }, groups: [], categories: [], courses: [], paths: [], templates: [], views: [], counts: { inboxUnread: 0, toGrade: 0, openQuestions: 0, overdue: 0, expiringCertificates: 0, upcomingSessions: 0 }, features: { ai: false }, demo: null, canLoadSample: false };

    // Learners who open the admin app see a friendly pointer to the learner app, nothing else.
    if (!isStaff(actor)) {
      return { access: 'learner' as const, me, settings: baseSettings, ...empty };
    }

    const templatesQuery = { query: `SELECT * FROM "EmailTemplates" ORDER BY COALESCE("position", 0) ASC, created_at ASC`, params: [] };
    const [staffRes, peopleRes, groupsRes, categoriesRes, coursesRes, lessonCountRes, courseCountsRes, pathsRes, pathCoursesRes, pathCountsRes, firstTemplatesRes, viewsRes, countsRes] = await Promise.all([
      zite.sql({ query: `SELECT id, "name", "email", "role", "status", "color", "avatarUrl", "title", "lastSeenAt" FROM "People" WHERE "role" IN ('Admin', 'Instructor') ORDER BY LOWER("name") ASC`, params: [] }),
      zite.sql({
        query: `SELECT COUNT(*) AS "total", COUNT(*) FILTER (WHERE COALESCE("status", 'Active') = 'Active') AS "active", COUNT(*) FILTER (WHERE "status" = 'Invited') AS "invited", COUNT(*) FILTER (WHERE "status" = 'Deactivated') AS "deactivated" FROM "People"`,
        params: [],
      }),
      zite.sql({
        query: `SELECT g.*, o."name" AS "ownerName", (SELECT COUNT(*) FROM "GroupMembers" gm JOIN "People" p ON p.id::text = gm."personId" WHERE gm."groupId" = g.id::text AND COALESCE(p."status", '') <> 'Deactivated') AS "memberTotal"
                FROM "Groups" g LEFT JOIN "People" o ON o.id::text = g."ownerId" ORDER BY COALESCE(g."position", 0) ASC, LOWER(g."name") ASC`,
        params: [],
      }),
      zite.sql({ query: `SELECT cat.*, (SELECT COUNT(*) FROM "Courses" c WHERE c."categoryId" = cat.id::text AND COALESCE(c."status", '') <> 'Archived') AS "courseTotal" FROM "Categories" cat ORDER BY COALESCE(cat."position", 0) ASC, LOWER(cat."name") ASC`, params: [] }),
      zite.sql({ query: `SELECT * FROM "Courses" ORDER BY COALESCE("position", 0) ASC, created_at ASC`, params: [] }),
      zite.sql({ query: `SELECT "courseId", COUNT(*) AS "lessonTotal" FROM "Lessons" GROUP BY "courseId"`, params: [] }),
      zite.sql({
        query: `SELECT "courseId",
                  COUNT(*) FILTER (WHERE COALESCE("status", '') <> 'Withdrawn') AS "enrolledTotal",
                  COUNT(*) FILTER (WHERE "status" = 'Not started') AS "notStartedTotal",
                  COUNT(*) FILTER (WHERE "status" = 'In progress') AS "inProgressTotal",
                  COUNT(*) FILTER (WHERE "status" = 'Completed') AS "completedTotal",
                  COUNT(*) FILTER (WHERE "status" IN ('Not started', 'In progress') AND "dueDate" < (NOW() AT TIME ZONE 'UTC')::date) AS "overdueTotal",
                  AVG("rating") FILTER (WHERE "rating" IS NOT NULL AND "rating" > 0) AS "ratingAverage",
                  COUNT(*) FILTER (WHERE "rating" IS NOT NULL AND "rating" > 0) AS "ratingTotal"
                FROM "Enrollments" e
                -- One row per person: their latest recertification cycle, like every enrollment list.
                WHERE NOT EXISTS (SELECT 1 FROM "Enrollments" e2 WHERE e2."personId" = e."personId" AND e2."courseId" = e."courseId" AND COALESCE(e2."cycle", 1) > COALESCE(e."cycle", 1))
                GROUP BY "courseId"`,
        params: [],
      }),
      zite.sql({ query: `SELECT * FROM "Paths" ORDER BY COALESCE("position", 0) ASC, created_at ASC`, params: [] }),
      zite.sql({ query: `SELECT "pathId", "courseId" FROM "PathCourses" ORDER BY COALESCE("position", 0) ASC, created_at ASC`, params: [] }),
      zite.sql({
        query: `SELECT "pathId",
                  COUNT(*) FILTER (WHERE COALESCE("status", '') <> 'Withdrawn') AS "enrolledTotal",
                  COUNT(*) FILTER (WHERE "status" = 'Not started') AS "notStartedTotal",
                  COUNT(*) FILTER (WHERE "status" = 'In progress') AS "inProgressTotal",
                  COUNT(*) FILTER (WHERE "status" = 'Completed') AS "completedTotal",
                  COUNT(*) FILTER (WHERE "status" IN ('Not started', 'In progress') AND "dueDate" < (NOW() AT TIME ZONE 'UTC')::date) AS "overdueTotal"
                FROM "PathEnrollments" pe
                WHERE NOT EXISTS (SELECT 1 FROM "PathEnrollments" pe2 WHERE pe2."personId" = pe."personId" AND pe2."pathId" = pe."pathId" AND COALESCE(pe2."cycle", 1) > COALESCE(pe."cycle", 1))
                GROUP BY "pathId"`,
        params: [],
      }),
      zite.sql(templatesQuery),
      zite.sql({ query: `SELECT * FROM "Views" WHERE "scope" = 'Shared' OR "ownerId" = $1 ORDER BY COALESCE("position", 0) ASC, created_at ASC`, params: [actor.id] }),
      zite.sql({
        query: `
          SELECT
            (SELECT COUNT(*) FROM "Notifications" n WHERE n."recipientId" = $1 AND n."app" = 'Admin' AND n."readAt" IS NULL AND n."archivedAt" IS NULL) AS "inboxUnread",
            (SELECT COUNT(*) FROM "Submissions" s JOIN "Courses" c ON c.id::text = s."courseId"
               WHERE s."status" = 'Submitted' AND ($2::text = 'Admin' OR COALESCE(c."ownerId", '') IN ('', $1::text) OR COALESCE(c."instructorIds", '') LIKE '%' || $1::text || '%')) AS "toGrade",
            (SELECT COUNT(*) FROM "Comments" q
               WHERE COALESCE(q."parentId", '') = '' AND q."resolvedAt" IS NULL
                 AND NOT EXISTS (SELECT 1 FROM "People" a WHERE a.id::text = q."personId" AND a."role" IN ('Admin', 'Instructor'))
                 AND NOT EXISTS (SELECT 1 FROM "Comments" r JOIN "People" p ON p.id::text = r."personId" WHERE r."parentId" = q.id::text AND p."role" IN ('Admin', 'Instructor'))) AS "openQuestions",
            (SELECT COUNT(*) FROM "Enrollments" e JOIN "People" op ON op.id::text = e."personId" WHERE e."status" IN ('Not started', 'In progress') AND e."dueDate" < (NOW() AT TIME ZONE 'UTC')::date AND COALESCE(op."status", '') <> 'Deactivated') AS "overdue",
            (SELECT COUNT(*) FROM "Certificates" ce WHERE ce."status" = 'Active' AND ce."expiresAt" IS NOT NULL AND ce."expiresAt" > NOW() AND ce."expiresAt" <= NOW() + INTERVAL '30 days') AS "expiringCertificates",
            (SELECT COUNT(*) FROM "Sessions" se WHERE COALESCE(se."status", '') <> 'Cancelled' AND se."startsAt" > NOW() AND se."startsAt" <= NOW() + INTERVAL '7 days') AS "upcomingSessions"`,
        params: [actor.id, actor.role],
      }),
    ]);

    // A new workspace gets its default emails on the first staff load.
    const templatesRes = !firstTemplatesRes.rows.length && (await ensureDefaultTemplates()) ? await zite.sql(templatesQuery) : firstTemplatesRes;

    const lessonCounts = new Map(lessonCountRes.rows.map(r => [String(r.courseId), num(r.lessonTotal)]));
    const toCounts = (r: Record<string, unknown> | undefined) => ({
      enrolled: num(r?.enrolledTotal),
      notStarted: num(r?.notStartedTotal),
      inProgress: num(r?.inProgressTotal),
      completed: num(r?.completedTotal),
      overdue: num(r?.overdueTotal),
    });
    const courseCounts = new Map(courseCountsRes.rows.map(r => [String(r.courseId), r]));
    const pathCounts = new Map(pathCountsRes.rows.map(r => [String(r.pathId), r]));
    const pathCourseIds = new Map<string, string[]>();
    for (const r of pathCoursesRes.rows) pathCourseIds.set(String(r.pathId), [...(pathCourseIds.get(String(r.pathId)) ?? []), String(r.courseId)]);
    const pc = peopleRes.rows[0] ?? {};
    const c = countsRes.rows[0] ?? {};

    const isAdmin = actor.role === 'Admin';
    return {
      access: 'staff' as const,
      me,
      settings: baseSettings,
      staff: staffRes.rows.map(p => ({
        id: String(p.id),
        name: str(p.name) ?? '',
        email: str(p.email) ?? '',
        role: str(p.role) || 'Instructor',
        status: str(p.status) || 'Active',
        color: str(p.color) || '#8b8d98',
        avatarUrl: ref(p.avatarUrl),
        title: ref(p.title),
        lastSeenAt: iso(p.lastSeenAt),
      })),
      peopleCount: { total: num(pc.total), active: num(pc.active), invited: num(pc.invited), deactivated: num(pc.deactivated) },
      groups: groupsRes.rows.map(g => ({
        id: String(g.id),
        name: str(g.name) ?? '',
        kind: str(g.kind) || 'Team',
        description: str(g.description) ?? '',
        color: str(g.color) || '#8b8d98',
        ownerId: ref(g.ownerId),
        ownerName: ref(g.ownerName),
        position: num(g.position),
        memberCount: num(g.memberTotal),
      })),
      categories: categoriesRes.rows.map(k => ({
        id: String(k.id),
        name: str(k.name) ?? '',
        description: str(k.description) ?? '',
        color: str(k.color) || '#8b8d98',
        icon: str(k.icon) ?? '',
        position: num(k.position),
        courseCount: num(k.courseTotal),
      })),
      courses: coursesRes.rows.map(r => {
        const course = toCourse(r);
        const cc = courseCounts.get(course.id);
        return {
          id: course.id,
          title: course.title,
          slug: course.slug,
          summary: course.summary,
          icon: course.icon,
          color: course.color,
          coverImageUrl: course.coverImageUrl,
          categoryId: course.categoryId,
          level: course.level,
          status: course.status,
          visibility: course.visibility,
          ownerId: course.ownerId,
          instructorIds: course.instructorIds,
          sequential: course.sequential,
          estimatedMinutes: course.estimatedMinutes,
          dueDays: course.dueDays,
          certificateEnabled: course.certificateEnabled,
          certificateValidityMonths: course.certificateValidityMonths,
          skills: course.skills,
          publishedAt: course.publishedAt,
          position: course.position,
          createdAt: course.createdAt,
          updatedAt: course.updatedAt,
          lessonCount: lessonCounts.get(course.id) ?? 0,
          canEdit: canEditCourse(actor, course),
          counts: toCounts(cc),
          rating: { average: cc?.ratingAverage != null ? Math.round(num(cc.ratingAverage) * 10) / 10 : null, count: num(cc?.ratingTotal) },
        };
      }),
      paths: pathsRes.rows.map(r => {
        const p = toPath(r);
        return {
          id: p.id,
          title: p.title,
          slug: p.slug,
          summary: p.summary,
          icon: p.icon,
          color: p.color,
          coverImageUrl: p.coverImageUrl,
          categoryId: p.categoryId,
          status: p.status,
          visibility: p.visibility,
          ownerId: p.ownerId,
          sequential: p.sequential,
          dueDays: p.dueDays,
          certificateEnabled: p.certificateEnabled,
          certificateValidityMonths: p.certificateValidityMonths,
          publishedAt: p.publishedAt,
          position: p.position,
          createdAt: p.createdAt,
          courseIds: pathCourseIds.get(p.id) ?? [],
          counts: toCounts(pathCounts.get(p.id)),
        };
      }),
      templates: templatesRes.rows.map(t => ({ id: String(t.id), name: str(t.name) ?? '', subject: str(t.subject) ?? '', body: str(t.body) ?? '', trigger: str(t.trigger) ?? '', enabled: bool(t.enabled), position: num(t.position) })),
      views: viewsRes.rows.map(v => ({ id: String(v.id), name: str(v.name) ?? '', ownerId: ref(v.ownerId), scope: v.scope === 'Shared' ? ('Shared' as const) : ('Personal' as const), page: str(v.page) || 'enrollments', config: str(v.config) || '{}', position: num(v.position) })),
      counts: {
        inboxUnread: num(c.inboxUnread),
        toGrade: num(c.toGrade),
        openQuestions: num(c.openQuestions),
        overdue: num(c.overdue),
        expiringCertificates: num(c.expiringCertificates),
        upcomingSessions: num(c.upcomingSessions),
      },
      features: { ai: isConfigured() },
      demo: isAdmin ? await demoCounts(settings) : null,
      canLoadSample: isAdmin && !coursesRes.rows.length && !pathsRes.rows.length ? await canLoadSample(settings) : false,
    };
  },
});
