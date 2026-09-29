import { z } from 'zod';
import { createEndpoint, ZiteError } from 'zitejs/backend';
import { zite } from 'zitejs/db';
import { gradeQuiz, parseQuizSettings, type QuizAnswers, type QuizSettings } from '@project/shared/lessons';
import { addMonthsIso, courseProgress, pathProgress, slugify } from '@project/shared/progress';
import { formatLongDay } from '@project/shared/merge';
import { ensureDefaultTemplates } from '@project/shared/server/email';
import { colorFor, getActor } from '@project/shared/server/people';
import { getSettings } from '@project/shared/server/settings';
import { chunked, day, eachWrite, str, withRetry } from '@project/shared/server/sql';
import { DEMO_ORG_FIELDS, hasRealContent, SEED_ADMIN, sampleLoaded } from '../server/demo';
import { CATEGORIES, COURSES, PATHS, THREADS, type SeedCourse, type SeedLesson } from '../seed/content';
import { ASSIGNMENTS, DEMO_ORG, emailFor, FEEDBACK_BANK, GROUPS, PEOPLE, REVIEWS, RULES, SELF_ENROLLED, SESSIONS, type SeedPerson } from '../seed/org';

/**
 * Load the sample academy when an admin asks for it from Settings → Data:
 * Fernwood Supply Co. with ~40 people, 12 courses, 4 learning paths,
 * assignment rules and a year of realistic history (completions,
 * recertifications, overdue stragglers, quiz attempts, assignments waiting to
 * be graded, certificates, live sessions and lesson Q&A).
 *
 * Nothing calls this automatically. It refuses while the sample is loaded or
 * once the workspace has courses, learning paths or live sessions of its own
 * (see `server/demo.ts`), so a second call can never load it twice. People,
 * groups and categories that already exist are left alone, and organization
 * details are only filled in where they still read the default.
 *
 * Deterministic (seeded PRNG) apart from row ids, so every install tells the
 * same story. Progress values are derived with the same functions the engine
 * uses, so the numbers agree with what recompute would produce.
 */

const DAY = 86_400_000;

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Outcome = 'completed' | 'in_progress' | 'not_started';

type Plan = {
  key: string;
  personKey: string;
  courseKey: string;
  cycle: number;
  enrolledAgo: number;
  dueAgo: number | null;
  source: 'Assigned' | 'Self-enrolled' | 'Automatic' | 'Path';
  by: string | null;
  rule: string | null;
  path: string | null;
  outcome: Outcome;
  completedAgo: number | null;
  share: number;
  lastAgo: number | null;
};

export default createEndpoint({
  description: 'Load the sample academy into an empty workspace, when an admin asks for it',
  authenticated: true,
  inputSchema: z.object({}),
  outputSchema: z.object({ counts: z.record(z.string(), z.number()) }),
  execute: async ({ context }) => {
    const actor = await getActor(context);
    if (actor.role !== 'Admin') throw new ZiteError('Only an admin can load the sample data', 'FORBIDDEN');
    const settings = await getSettings();
    if (sampleLoaded(settings)) throw new ZiteError('The sample data is already loaded. Remove it from Settings → Data before loading it again.', 'CONFLICT');
    if (await hasRealContent()) throw new ZiteError('Sample data can only be loaded into an empty workspace, and this one already has courses, learning paths or live sessions.', 'CONFLICT');

    const NOW = Date.now();
    // Organization details take the demo's values only where nobody has changed the default.
    const org = Object.fromEntries(DEMO_ORG_FIELDS.filter(f => settings[f.key] === f.unset).map(f => [f.key, DEMO_ORG[f.key]]));
    await withRetry(() => zite.settings.update({ id: settings.id, record: { ...org, seededAt: new Date(NOW).toISOString() } }));

    const rand = prng(20260914);
    const between = (min: number, max: number) => min + rand() * (max - min);
    const int = (min: number, max: number) => Math.floor(between(min, max + 1));
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    // Each written review is used once per course, drawn with the same single random step as pick().
    const reviewsLeft = new Map(Object.entries(REVIEWS).map(([k, v]) => [k, [...v]]));
    const nextReview = (courseKey: string) => {
      const left = reviewsLeft.get(courseKey) ?? [];
      const i = Math.floor(rand() * Math.max(1, left.length));
      return left.length ? left.splice(i, 1)[0] : null;
    };
    /** An ISO timestamp `days` ago, during working hours (UTC). Negative is the future. */
    const ago = (days: number, hour = int(13, 22)) => {
      const d = new Date(NOW - days * DAY);
      const minute = int(0, 59);
      d.setUTCHours(hour, minute, int(0, 59), 0);
      if (days >= 0 && d.getTime() > NOW - 60_000) {
        // Working hours today that haven't happened yet: spread over the hours before now rather than piling every event onto this minute.
        return new Date(NOW - ((((hour - 13) * 53 + minute) % 540) + 12) * 60_000).toISOString();
      }
      return new Date(Math.min(d.getTime(), NOW - 60_000 + (days < 0 ? -days * DAY : 0))).toISOString();
    };
    const dayAgo = (days: number) => new Date(NOW - days * DAY).toISOString().slice(0, 10);
    const credential = () => {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const block = () => Array.from({ length: 4 }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
      return `${block()}-${block()}-${block()}`;
    };
    const counts: Record<string, number> = {};
    const bulk = async (table: keyof typeof zite, records: Array<Record<string, unknown>>) => {
      const ids: string[] = [];
      await chunked(records, async batch => {
        const res = await (zite[table] as unknown as { bulkCreate: (a: { records: unknown[] }) => Promise<{ records: Array<{ id: string }> }> }).bulkCreate({ records: batch });
        ids.push(...res.records.map(r => r.id));
      });
      counts[String(table)] = (counts[String(table)] ?? 0) + records.length;
      return ids;
    };
    // Live Zite rate-limits bursts of writes, so these run two at a time with backoff.
    const inParallel = <T>(items: T[], fn: (item: T) => Promise<unknown>) => eachWrite(items, fn, 2);

    // ── People ────────────────────────────────────────────────────────────
    const personId = new Map<string, string>([['me', actor.id]]);
    const meSeed: SeedPerson = { key: 'me', name: actor.name, title: SEED_ADMIN.title, role: 'Admin', groups: ['hq', 'leaders'], manager: null, hireDaysAgo: SEED_ADMIN.hireDaysAgo, diligence: 0.85 };
    const allPeople = [meSeed, ...PEOPLE];
    const personByKey = new Map(allPeople.map(p => [p.key, p]));
    // The story's COO gets a job title and hire date, unless the admin already gave themselves either.
    const { rows: meRows } = await zite.sql({ query: `SELECT "title", "hireDate" FROM "People" WHERE id::text = $1`, params: [actor.id] });
    const storyProfile = !str(meRows[0]?.title) && !day(meRows[0]?.hireDate) ? { title: SEED_ADMIN.title, hireDate: dayAgo(SEED_ADMIN.hireDaysAgo) } : {};
    await withRetry(() => zite.people.update({ id: actor.id, record: { ...storyProfile, lastLearnedAt: ago(1) } }));

    let remaining = [...PEOPLE];
    while (remaining.length) {
      const ready = remaining.filter(p => !p.manager || personId.has(p.manager));
      if (!ready.length) throw new Error('Seed people have a reporting cycle');
      const ids = await bulk(
        'people',
        ready.map(p => {
          const email = emailFor(p);
          const status = p.status ?? 'Active';
          return {
            name: p.name,
            email,
            role: p.role,
            status,
            title: p.title,
            managerId: p.manager ? personId.get(p.manager)! : null,
            hireDate: dayAgo(p.hireDaysAgo),
            externalId: `FW-${String(1000 + PEOPLE.indexOf(p) * 7).padStart(5, '0')}`,
            color: colorFor(email),
            invitedAt: ago(p.hireDaysAgo + 2),
            lastSeenAt: p.role !== 'Learner' && status === 'Active' ? ago(int(0, 3)) : null,
            lastLearnedAt: status === 'Active' && p.hireDaysAgo > 0 ? ago(Math.min(p.hireDaysAgo, int(0, Math.round(30 * (1.1 - p.diligence))))) : null,
            deactivatedAt: status === 'Deactivated' ? ago(40) : null,
          };
        }),
      );
      ready.forEach((p, i) => personId.set(p.key, ids[i]));
      remaining = remaining.filter(p => !personId.has(p.key));
    }
    const active = allPeople.filter(p => (p.status ?? 'Active') !== 'Deactivated');

    // ── Groups and categories ─────────────────────────────────────────────
    const groupIds = await bulk('groups', GROUPS.map((g, i) => ({ name: g.name, kind: g.kind, color: g.color, description: g.description, ownerId: g.owner ? personId.get(g.owner) ?? null : null, position: i })));
    const groupId = new Map(GROUPS.map((g, i) => [g.key, groupIds[i]]));
    await bulk(
      'groupMembers',
      allPeople.flatMap(p => p.groups.map(g => ({ groupId: groupId.get(g)!, personId: personId.get(p.key)!, addedAt: ago(Math.min(p.hireDaysAgo, 300)), addedById: personId.get('maya')! }))),
    );
    const categoryIds = await bulk('categories', CATEGORIES.map((c, i) => ({ name: c.name, description: c.description, color: c.color, icon: c.icon, position: i })));
    const categoryId = new Map(CATEGORIES.map((c, i) => [c.key, categoryIds[i]]));

    // ── Courses, sections, lessons ────────────────────────────────────────
    const courseByKey = new Map(COURSES.map(c => [c.key, c]));
    const courseIds = await bulk(
      'courses',
      COURSES.map((c, i) => ({
        title: c.title,
        slug: slugify(c.title),
        summary: c.summary,
        description: c.description,
        objectives: JSON.stringify(c.objectives),
        coverImageUrl: c.cover,
        icon: c.icon,
        color: c.color,
        categoryId: categoryId.get(c.category) ?? null,
        level: c.level,
        status: c.status,
        visibility: c.visibility,
        ownerId: personId.get(c.owner)!,
        instructorIds: JSON.stringify((c.instructors ?? []).map(k => personId.get(k)!)),
        sequential: c.sequential,
        estimatedMinutes: c.sections.flatMap(s => s.lessons).reduce((sum, l) => sum + l.minutes, 0),
        dueDays: c.dueDays,
        certificateEnabled: c.certificate,
        certificateValidityMonths: c.validityMonths,
        skills: JSON.stringify(c.skills),
        publishedAt: c.status === 'Draft' ? null : ago(c.publishedDaysAgo),
        position: i,
      })),
    );
    const courseId = new Map(COURSES.map((c, i) => [c.key, courseIds[i]]));

    const sectionRows = COURSES.flatMap(c => c.sections.map((s, i) => ({ course: c, section: s, i })));
    const sectionIds = await bulk('sections', sectionRows.map(r => ({ title: r.section.title, courseId: courseId.get(r.course.key)!, description: r.section.description ?? null, position: r.i })));

    type LessonInfo = SeedLesson & { id: string; courseKey: string };
    const lessonRows = sectionRows.flatMap((r, si) => r.section.lessons.map((l, li) => ({ lesson: l, courseKey: r.course.key, sectionId: sectionIds[si], position: li })));
    const lessonIds = await bulk(
      'lessons',
      lessonRows.map(r => ({
        title: r.lesson.title,
        courseId: courseId.get(r.courseKey)!,
        sectionId: r.sectionId,
        type: r.lesson.type,
        body: r.lesson.body ?? null,
        mediaUrl: r.lesson.mediaUrl ?? null,
        mediaName: r.lesson.mediaName ?? null,
        settings: r.lesson.settings ? JSON.stringify(r.lesson.settings) : null,
        durationMinutes: r.lesson.minutes,
        optional: r.lesson.optional === true,
        position: r.position,
      })),
    );
    const lessonsByCourse = new Map<string, LessonInfo[]>();
    const lessonByKey = new Map<string, LessonInfo>();
    lessonRows.forEach((r, i) => {
      const info = { ...r.lesson, id: lessonIds[i], courseKey: r.courseKey };
      lessonByKey.set(r.lesson.key, info);
      lessonsByCourse.set(r.courseKey, [...(lessonsByCourse.get(r.courseKey) ?? []), info]);
    });

    // ── Paths ─────────────────────────────────────────────────────────────
    const pathIds = await bulk(
      'paths',
      PATHS.map((p, i) => ({
        title: p.title,
        slug: slugify(p.title),
        summary: p.summary,
        description: p.description,
        coverImageUrl: p.cover,
        icon: p.icon,
        color: p.color,
        categoryId: categoryId.get(p.category) ?? null,
        status: p.status,
        visibility: p.visibility,
        ownerId: personId.get(p.owner)!,
        sequential: p.sequential,
        dueDays: p.dueDays,
        certificateEnabled: p.certificate,
        certificateValidityMonths: p.validityMonths,
        publishedAt: p.status === 'Published' ? ago(200) : null,
        position: i,
      })),
    );
    const pathId = new Map(PATHS.map((p, i) => [p.key, pathIds[i]]));
    await bulk('pathCourses', PATHS.flatMap(p => p.courses.map((c, i) => ({ pathId: pathId.get(p.key)!, courseId: courseId.get(c)!, position: i, optional: false }))));

    // Normally already there from the first load; created here only if this runs before it.
    await ensureDefaultTemplates();

    const ruleIds = await bulk(
      'assignmentRules',
      RULES.map(r => ({
        name: r.name,
        targetType: r.targetType,
        courseId: r.targetType === 'Course' ? courseId.get(r.target)! : null,
        pathId: r.targetType === 'Path' ? pathId.get(r.target)! : null,
        audience: r.audience,
        groupIds: JSON.stringify(r.groups.map(g => groupId.get(g)!)),
        personIds: '[]',
        dueMode: 'Relative',
        dueDays: r.dueDays,
        dueDate: null,
        recurrenceMonths: r.recurrenceMonths,
        includeFutureMembers: true,
        sendEmail: true,
        status: r.status,
        createdById: personId.get(r.createdBy)!,
        lastRunAt: ago(int(0, 2)),
      })),
    );
    const ruleId = new Map(RULES.map((r, i) => [r.key, ruleIds[i]]));

    // ── Plan a year of enrollments ────────────────────────────────────────
    const plans = new Map<string, Plan>();
    const latestPlan = (personKey: string, courseKey: string) => {
      let best: Plan | null = null;
      for (const p of plans.values()) if (p.personKey === personKey && p.courseKey === courseKey && (!best || p.cycle > best.cycle)) best = p;
      return best;
    };

    function decide(person: SeedPerson, enrolledAgo: number, window: number): Pick<Plan, 'outcome' | 'completedAgo' | 'share' | 'lastAgo'> {
      const d = person.diligence;
      const r = rand();
      if (person.status === 'Invited' || enrolledAgo === 0) return { outcome: 'not_started', completedAgo: null, share: 0, lastAgo: null };
      if (enrolledAgo >= window + 3) {
        // Long-past work was chased and finished long ago; recent stragglers are the realistic overdue list.
        const pDone = enrolledAgo > window + 100 ? 0.93 + 0.07 * d : 0.45 + 0.5 * d;
        if (r < pDone) {
          const late = rand() < 0.14 + (1 - d) * 0.2;
          const took = Math.round(window * (late ? between(1.05, 1.7) : between(0.08, 0.95)));
          return { outcome: 'completed', completedAgo: Math.max(0, enrolledAgo - Math.max(1, took)), share: 1, lastAgo: null };
        }
        if (r < pDone + (1 - pDone) * 0.6) return { outcome: 'in_progress', completedAgo: null, share: between(0.2, 0.8), lastAgo: int(2, Math.min(enrolledAgo, 30)) };
        return { outcome: 'not_started', completedAgo: null, share: 0, lastAgo: null };
      }
      const t = enrolledAgo / window;
      const pDone = Math.min(0.85, t * 0.95 * (0.25 + 0.75 * d));
      if (r < pDone) return { outcome: 'completed', completedAgo: int(0, Math.max(0, enrolledAgo - 1)), share: 1, lastAgo: null };
      if (r < pDone + (1 - pDone) * Math.min(0.75, 0.35 + t)) return { outcome: 'in_progress', completedAgo: null, share: between(0.15, 0.85), lastAgo: int(0, Math.min(enrolledAgo, 8)) };
      return { outcome: 'not_started', completedAgo: null, share: 0, lastAgo: null };
    }

    function planCourse(personKey: string, courseKey: string, o: { enrolledAgo: number; dueDays: number | null; source: Plan['source']; by: string | null; rule: string | null; path?: string | null; cycle?: number; dueAgo?: number | null }) {
      const person = personByKey.get(personKey)!;
      const existingPlan = latestPlan(personKey, courseKey);
      if (existingPlan && (o.cycle ?? 1) <= existingPlan.cycle) {
        if (o.path && !existingPlan.path) existingPlan.path = o.path;
        return existingPlan;
      }
      const enrolledAgo = Math.max(0, Math.round(o.enrolledAgo));
      const window = o.dueDays ?? 30;
      const plan: Plan = {
        key: `${personKey}:${courseKey}:${o.cycle ?? 1}`,
        personKey,
        courseKey,
        cycle: o.cycle ?? 1,
        enrolledAgo,
        dueAgo: o.dueAgo !== undefined ? o.dueAgo : o.dueDays == null ? null : enrolledAgo - o.dueDays,
        source: o.source,
        by: o.by,
        rule: o.rule,
        path: o.path ?? null,
        ...decide(person, enrolledAgo, window),
      };
      plans.set(plan.key, plan);
      return plan;
    }

    // Everyone rules, with recertification cycles.
    for (const rule of RULES.filter(r => r.audience === 'Everyone')) {
      for (const person of active) {
        const enrolledAgo = Math.min(rule.launchedDaysAgo, person.hireDaysAgo);
        const first = planCourse(person.key, rule.target, { enrolledAgo, dueDays: rule.dueDays, source: 'Automatic', by: rule.createdBy, rule: rule.key });
        if (rule.recurrenceMonths && first.outcome === 'completed' && first.completedAgo != null) {
          const cycleDays = Math.round(rule.recurrenceMonths * 30.4);
          if (first.completedAgo >= cycleDays - 30) {
            planCourse(person.key, rule.target, { enrolledAgo: first.completedAgo - (cycleDays - 30), dueDays: 30, dueAgo: first.completedAgo - cycleDays, source: 'Automatic', by: rule.createdBy, rule: rule.key, cycle: 2 });
          }
        }
      }
    }

    // Path rules and path membership.
    type PathPlan = { key: string; personKey: string; pathKey: string; enrolledAgo: number; dueDays: number; source: 'Assigned' | 'Automatic'; by: string; rule: string | null };
    const pathPlans: PathPlan[] = [];
    const planPath = (personKey: string, pathKey: string, enrolledAgo: number, source: PathPlan['source'], by: string, rule: string | null) => {
      const path = PATHS.find(p => p.key === pathKey)!;
      const pp: PathPlan = { key: `${personKey}:${pathKey}`, personKey, pathKey, enrolledAgo, dueDays: path.dueDays, source, by, rule };
      pathPlans.push(pp);
      // Sequential paths unlock one course at a time, so later courses start later.
      path.courses.forEach((c, i) => {
        const prev = i > 0 ? latestPlan(personKey, path.courses[i - 1]) : null;
        const gate = path.sequential && prev ? (prev.outcome === 'completed' ? prev.completedAgo ?? enrolledAgo : -1) : enrolledAgo;
        if (gate < 0) {
          // Locked behind an unfinished course: enrolled, not started.
          const existingPlan = latestPlan(personKey, c);
          if (existingPlan) {
            if (!existingPlan.path) existingPlan.path = pp.key;
          } else {
            plans.set(`${personKey}:${c}:1`, { key: `${personKey}:${c}:1`, personKey, courseKey: c, cycle: 1, enrolledAgo, dueAgo: enrolledAgo - path.dueDays, source: 'Path', by, rule, path: pp.key, outcome: 'not_started', completedAgo: null, share: 0, lastAgo: null });
          }
          return;
        }
        planCourse(personKey, c, { enrolledAgo: gate, dueDays: Math.max(3, path.dueDays - (enrolledAgo - gate)), dueAgo: enrolledAgo - path.dueDays, source: 'Path', by, rule, path: pp.key });
      });
    };
    for (const person of active) {
      if (person.groups.includes('newhires')) planPath(person.key, 'onboarding', person.hireDaysAgo, 'Automatic', 'daniel', 'r-onboarding');
      else if (person.hireDaysAgo > 40 && person.hireDaysAgo < 260 && (person.status ?? 'Active') === 'Active') planPath(person.key, 'onboarding', person.hireDaysAgo, 'Assigned', 'daniel', null);
      if (person.groups.includes('leaders') && person.key !== 'maya') planPath(person.key, 'managers', 50, 'Automatic', 'maya', 'r-managers');
      if (person.groups.includes('dc') && person.role === 'Learner') planPath(person.key, 'dc', Math.min(200, person.hireDaysAgo), 'Automatic', 'tom', 'r-dc');
    }

    // Direct assignments and self-enrollment.
    for (const a of ASSIGNMENTS) {
      for (const person of active.filter(p => p.groups.some(g => a.groups.includes(g)) && p.role === 'Learner')) {
        planCourse(person.key, a.course, { enrolledAgo: Math.min(a.daysAgo, person.hireDaysAgo), dueDays: a.dueDays, source: 'Assigned', by: a.by, rule: null });
      }
    }
    for (const s of SELF_ENROLLED) for (const key of s.people) planCourse(key, s.course, { enrolledAgo: Math.min(s.daysAgo, personByKey.get(key)!.hireDaysAgo), dueDays: null, source: 'Self-enrolled', by: null, rule: null });

    // The installing admin gets a learner's view worth opening.
    const tune = (personKey: string, courseKey: string, patch: Partial<Plan>) => {
      const p = latestPlan(personKey, courseKey);
      if (p) Object.assign(p, patch);
    };
    tune('me', 'security', { outcome: 'completed', completedAgo: 64, share: 1 });
    tune('me', 'conduct', { outcome: 'in_progress', share: 0.5, lastAgo: 2, enrolledAgo: 40, dueAgo: -4 });
    tune('me', 'respect', { outcome: 'completed', completedAgo: 180, share: 1 });
    tune('me', 'feedback', { outcome: 'completed', completedAgo: 20, share: 1 });
    tune('me', 'oneonones', { outcome: 'in_progress', share: 0.4, lastAgo: 1 });
    // Work in flight: people part-way through courses with assignments.
    for (const [who, course] of [['l6', 'feedback'], ['l28', 'feedback'], ['l18', 'feedback'], ['l2', 'feedback'], ['l19', 'warehouse'], ['l24', 'warehouse'], ['l12', 'selling'], ['l16', 'selling'], ['l11', 'selling']] as const) {
      tune(who, course, { outcome: 'in_progress', completedAgo: null, share: 0.5, lastAgo: int(0, 4) });
    }
    // A leaver's history stays on record (and their certificate is revoked below).
    planCourse('l34', 'security', { enrolledAgo: 380, dueDays: 30, source: 'Automatic', by: 'aisha', rule: 'r-security' });
    tune('l34', 'security', { outcome: 'completed', completedAgo: 352, share: 1 });
    // A lapsed certification: last year's certificate expired a week ago and the renewal, due after a two-week grace
    // period, is still in progress. Built directly rather than through planCourse so the random sequence is unchanged.
    if (latestPlan('l27', 'security')) {
      for (const key of [...plans.keys()]) if (key.startsWith('l27:security:')) plans.delete(key);
      const lapsed = { personKey: 'l27', courseKey: 'security', source: 'Automatic' as const, by: 'aisha', rule: 'r-security', path: null };
      plans.set('l27:security:1', { ...lapsed, key: 'l27:security:1', cycle: 1, enrolledAgo: 400, dueAgo: 370, outcome: 'completed', completedAgo: 372, share: 1, lastAgo: 372 });
      plans.set('l27:security:2', { ...lapsed, key: 'l27:security:2', cycle: 2, enrolledAgo: 37, dueAgo: -7, outcome: 'in_progress', completedAgo: null, share: 0.4, lastAgo: 3 });
    }

    // A diligent new hire has already finished onboarding, as the path's description promises most people do.
    tune('l9', 'welcome', { outcome: 'completed', completedAgo: 18, share: 1, lastAgo: 18 });
    tune('l9', 'security', { outcome: 'completed', completedAgo: 15, share: 1, lastAgo: 15 });
    tune('l9', 'conduct', { outcome: 'completed', completedAgo: 12, share: 1, lastAgo: 12 });
    tune('l9', 'respect', { outcome: 'completed', completedAgo: 9, share: 1, lastAgo: 9 });

    // Sequential paths: nothing after an unfinished course can have been started through the path.
    for (const pp of pathPlans) {
      const path = PATHS.find(p => p.key === pp.pathKey)!;
      if (!path.sequential) continue;
      let blocked = false;
      for (const c of path.courses) {
        const plan = latestPlan(pp.personKey, c);
        if (!plan) continue;
        if (blocked && plan.source === 'Path' && plan.outcome !== 'not_started') Object.assign(plan, { outcome: 'not_started', completedAgo: null, share: 0, lastAgo: null });
        if (plan.outcome !== 'completed') blocked = true;
      }
    }

    // ── Path enrollments ──────────────────────────────────────────────────
    const coursePlansFor = (pp: PathPlan) => PATHS.find(p => p.key === pp.pathKey)!.courses.map(c => latestPlan(pp.personKey, c));
    const pathRows = pathPlans.map(pp => {
      const path = PATHS.find(p => p.key === pp.pathKey)!;
      const cps = coursePlansFor(pp);
      const done = new Set(cps.filter(c => c?.outcome === 'completed').map(c => c!.courseKey));
      const prog = pathProgress(path.courses.map((c, i) => ({ courseId: c, optional: false, position: i })), done);
      const started = cps.some(c => c && c.outcome !== 'not_started');
      const completedAgo = prog.complete ? Math.min(...cps.map(c => c?.completedAgo ?? 0)) : null;
      return {
        pp,
        record: {
          label: `${personByKey.get(pp.personKey)!.name} · ${path.title}`,
          personId: personId.get(pp.personKey)!,
          pathId: pathId.get(pp.pathKey)!,
          ruleId: pp.rule ? ruleId.get(pp.rule)! : null,
          source: pp.source,
          assignedById: personId.get(pp.by)!,
          status: prog.complete ? 'Completed' : started ? 'In progress' : 'Not started',
          progress: prog.percent,
          dueDate: dayAgo(pp.enrolledAgo - pp.dueDays),
          enrolledAt: ago(pp.enrolledAgo),
          startedAt: started ? ago(Math.max(0, pp.enrolledAgo - 1)) : null,
          completedAt: completedAgo != null ? ago(completedAgo) : null,
          cycle: 1,
        },
      };
    });
    const pathEnrollmentIds = await bulk('pathEnrollments', pathRows.map(r => r.record));
    const pathEnrollmentId = new Map(pathRows.map((r, i) => [r.pp.key, pathEnrollmentIds[i]]));

    // ── Enrollments and everything under them ─────────────────────────────
    const attended = new Set(SESSIONS.flatMap(s => s.registrants.filter(r => r.status === 'Attended').map(r => `${r.person}:${s.lesson}`)));
    const planList = [...plans.values()].sort((a, b) => b.enrolledAgo - a.enrolledAgo);
    const enrollmentRecords: Array<Record<string, unknown>> = [];
    type Child = { planIndex: number };
    const progressRows: Array<Record<string, unknown> & Child> = [];
    const attemptRows: Array<Record<string, unknown> & Child> = [];
    const submissionRows: Array<Record<string, unknown> & Child & { gradedBy?: string }> = [];
    const activityRows: Array<Record<string, unknown> & Child> = [];

    const answersFor = (quiz: QuizSettings, wrong: Set<string>): QuizAnswers => {
      const out: QuizAnswers = {};
      for (const q of quiz.questions) {
        const correct = !wrong.has(q.id);
        if (q.type === 'short') out[q.id] = correct ? q.acceptedAnswers[0] ?? '' : 'not sure';
        else {
          const right = q.options.filter(o => o.correct).map(o => o.id);
          const other = q.options.filter(o => !o.correct).map(o => o.id);
          out[q.id] = correct ? right : other.length ? [pick(other)] : [];
        }
      }
      return out;
    };

    planList.forEach((plan, planIndex) => {
      const course = courseByKey.get(plan.courseKey)!;
      const person = personByKey.get(plan.personKey)!;
      const lessons = lessonsByCourse.get(plan.courseKey) ?? [];
      const refs = lessons.map(l => ({ id: l.id, optional: l.optional === true }));
      const required = lessons.filter(l => !l.optional);
      // "In progress" needs at least one required lesson done and one left.
      if (plan.outcome === 'in_progress' && required.length < 2) plan.outcome = 'not_started';
      const doneKeys = new Set<string>();
      let current: LessonInfo | null = null;
      if (plan.outcome === 'completed') {
        for (const l of lessons) if (!l.optional || rand() < 0.5 || attended.has(`${plan.personKey}:${l.key}`)) doneKeys.add(l.key);
      } else if (plan.outcome === 'in_progress') {
        // Courses with an assignment: most people in progress are stuck at (or waiting on) it — that's the grading queue.
        const assignmentAt = required.findIndex(l => l.type === 'Assignment');
        const atAssignment = assignmentAt > 0 && rand() < 0.75;
        const k = atAssignment ? assignmentAt : Math.max(1, Math.min(required.length - 1, Math.round(required.length * plan.share)));
        let seen = 0;
        for (const l of lessons) {
          if (seen >= k) {
            current = l.optional ? current : l;
            if (!l.optional) break;
            continue;
          }
          if (!l.optional) seen++;
          if (!l.optional || rand() < 0.4) doneKeys.add(l.key);
        }
        if (!current) current = required.find(l => !doneKeys.has(l.key)) ?? null;
      }

      const startedAgo = plan.outcome === 'not_started' ? null : Math.max(0, plan.enrolledAgo - int(0, Math.min(5, plan.enrolledAgo)));
      const endAgo = plan.outcome === 'completed' ? plan.completedAgo ?? 0 : plan.lastAgo ?? 0;
      const doneLessons = lessons.filter(l => doneKeys.has(l.key));
      let quizScores: number[] = [];
      let seconds = 0;
      doneLessons.forEach((l, i) => {
        const whenAgo = startedAgo == null ? endAgo : Math.round(startedAgo - ((startedAgo - endAgo) * (i + 1)) / Math.max(1, doneLessons.length));
        const spent = Math.round(l.minutes * 60 * between(0.6, 1.5));
        seconds += spent;
        let score: number | null = null;
        let attempts = 0;
        if (l.type === 'Quiz') {
          const quiz = parseQuizSettings(l.settings);
          const failFirst = rand() < 0.35 - person.diligence * 0.2;
          const tries = failFirst ? 2 : 1;
          for (let t = 1; t <= tries; t++) {
            const passing = t === tries;
            const wrong = new Set<string>();
            const allowedWrong = passing ? Math.floor(quiz.questions.length * (1 - quiz.passingScore / 100)) : Math.max(1, Math.ceil(quiz.questions.length * (1 - quiz.passingScore / 100)) + 1);
            const nWrong = passing ? int(0, allowedWrong) : Math.min(quiz.questions.length, allowedWrong);
            for (const q of [...quiz.questions].sort(() => rand() - 0.5).slice(0, nWrong)) wrong.add(q.id);
            const answers = answersFor(quiz, wrong);
            const graded = gradeQuiz(quiz, answers);
            attemptRows.push({ planIndex, lessonId: l.id, personId: personId.get(plan.personKey)!, courseId: courseId.get(plan.courseKey)!, number: t, answers: JSON.stringify(answers), score: graded.score, passed: graded.passed, startedAt: ago(whenAgo + (tries - t) * 0.1), submittedAt: ago(whenAgo + (tries - t) * 0.1) });
            score = Math.max(score ?? 0, graded.score);
          }
          attempts = tries;
          quizScores.push(score ?? 0);
        }
        if (l.type === 'Assignment') {
          const grade = int(74, 98);
          submissionRows.push({ planIndex, lessonId: l.id, personId: personId.get(plan.personKey)!, courseId: courseId.get(plan.courseKey)!, attempt: 1, body: assignmentText(l.key, person.name), files: '[]', status: 'Passed', grade, feedback: pick(FEEDBACK_BANK), gradedBy: course.owner, submittedAt: ago(whenAgo + 1), gradedAt: ago(whenAgo) });
        }
        progressRows.push({
          planIndex,
          personId: personId.get(plan.personKey)!,
          courseId: courseId.get(plan.courseKey)!,
          lessonId: l.id,
          status: 'Completed',
          startedAt: ago(whenAgo + 0.05),
          completedAt: ago(whenAgo),
          timeSpentSeconds: spent,
          score,
          attempts,
          state: l.type === 'Checklist' ? JSON.stringify({ checked: ((l.settings?.items as Array<{ id: string }>) ?? []).map(it => it.id) }) : l.type === 'Video' ? JSON.stringify({ watched: 1 }) : null,
        });
      });
      if (current && plan.outcome === 'in_progress') {
        const spent = Math.round(current.minutes * 60 * between(0.1, 0.6));
        seconds += spent;
        const cur = current;
        let attempts = 0;
        let score: number | null = null;
        if (cur.type === 'Quiz' && rand() < 0.35) {
          const quiz = parseQuizSettings(cur.settings);
          const wrong = new Set(quiz.questions.slice(0, Math.max(2, Math.ceil(quiz.questions.length / 2))).map(q => q.id));
          const answers = answersFor(quiz, wrong);
          const graded = gradeQuiz(quiz, answers);
          attemptRows.push({ planIndex, lessonId: cur.id, personId: personId.get(plan.personKey)!, courseId: courseId.get(plan.courseKey)!, number: 1, answers: JSON.stringify(answers), score: graded.score, passed: graded.passed, startedAt: ago(endAgo), submittedAt: ago(endAgo) });
          attempts = 1;
          score = graded.score;
        }
        if (cur.type === 'Assignment') {
          const r = rand();
          if (r < 0.78) submissionRows.push({ planIndex, lessonId: cur.id, personId: personId.get(plan.personKey)!, courseId: courseId.get(plan.courseKey)!, attempt: 1, body: assignmentText(cur.key, person.name), files: cur.key === 'wh-report' && rand() < 0.5 ? HAZARD_PHOTO : '[]', status: 'Submitted', grade: null, feedback: null, submittedAt: ago(endAgo), gradedAt: null });
          else if (r < 0.92)
            submissionRows.push({ planIndex, lessonId: cur.id, personId: personId.get(plan.personKey)!, courseId: courseId.get(plan.courseKey)!, attempt: 1, body: assignmentText(cur.key, person.name, true), files: cur.key === 'wh-report' ? HAZARD_PHOTO : '[]', status: 'Needs revision', grade: 55, feedback: revisionFeedback(cur.key), gradedBy: course.owner, submittedAt: ago(endAgo + 2), gradedAt: ago(endAgo + 1) });
        }
        progressRows.push({ planIndex, personId: personId.get(plan.personKey)!, courseId: courseId.get(plan.courseKey)!, lessonId: cur.id, status: 'In progress', startedAt: ago(endAgo), completedAt: null, timeSpentSeconds: spent, score, attempts, state: null });
      }

      const completedIds = new Set(doneLessons.map(l => l.id));
      const prog = courseProgress(refs, completedIds);
      const status = plan.outcome === 'completed' ? 'Completed' : plan.outcome === 'in_progress' ? 'In progress' : 'Not started';
      const rated = plan.outcome === 'completed' && rand() < 0.6;
      const rating = rated ? pick([5, 5, 5, 4, 4, 4, 3]) : null;
      enrollmentRecords.push({
        label: `${person.name} · ${course.title}`,
        personId: personId.get(plan.personKey)!,
        courseId: courseId.get(plan.courseKey)!,
        pathEnrollmentId: plan.path ? pathEnrollmentId.get(plan.path) ?? null : null,
        ruleId: plan.rule ? ruleId.get(plan.rule) ?? null : null,
        source: plan.source,
        assignedById: plan.by ? personId.get(plan.by)! : null,
        status,
        progress: plan.outcome === 'completed' ? 100 : prog.percent,
        dueDate: plan.dueAgo == null ? null : dayAgo(plan.dueAgo),
        enrolledAt: ago(plan.enrolledAgo),
        startedAt: startedAgo == null ? null : ago(startedAgo),
        completedAt: plan.outcome === 'completed' ? ago(plan.completedAgo ?? 0) : null,
        lastActivityAt: plan.outcome === 'not_started' ? null : ago(endAgo),
        currentLessonId: current?.id ?? null,
        score: quizScores.length ? Math.round(quizScores.reduce((a, b) => a + b, 0) / quizScores.length) : null,
        timeSpentSeconds: seconds,
        cycle: plan.cycle,
        remindedAt: plan.outcome !== 'completed' && plan.dueAgo != null && plan.dueAgo > -4 && rand() < 0.5 ? ago(Math.max(0, plan.dueAgo + 3)) : null,
        overdueNotifiedAt: plan.outcome !== 'completed' && plan.dueAgo != null && plan.dueAgo > 0 ? ago(Math.max(0, plan.dueAgo - 1)) : null,
        rating,
        review: rated && rand() < 0.4 ? nextReview(plan.courseKey) : null,
        ratedAt: rated ? ago(plan.completedAgo ?? 0) : null,
      });
      activityRows.push({ planIndex, type: plan.source === 'Self-enrolled' ? 'self_enrolled' : 'enrolled', personId: personId.get(plan.personKey)!, actorId: plan.by ? personId.get(plan.by)! : personId.get(plan.personKey)!, courseId: courseId.get(plan.courseKey)!, data: JSON.stringify({ source: plan.source, courseTitle: course.title }), occurredAt: ago(plan.enrolledAgo) });
      if (startedAgo != null) activityRows.push({ planIndex, type: 'started', personId: personId.get(plan.personKey)!, actorId: personId.get(plan.personKey)!, courseId: courseId.get(plan.courseKey)!, occurredAt: ago(startedAgo) });
      if (plan.outcome === 'completed') activityRows.push({ planIndex, type: 'course_completed', personId: personId.get(plan.personKey)!, actorId: personId.get(plan.personKey)!, courseId: courseId.get(plan.courseKey)!, data: JSON.stringify({ courseTitle: course.title }), occurredAt: ago(plan.completedAgo ?? 0) });
    });

    const enrollmentIds = await bulk('enrollments', enrollmentRecords);
    const withEnrollment = <T extends Child>(rows: T[]) => rows.map(({ planIndex, ...rest }) => ({ ...rest, enrollmentId: enrollmentIds[planIndex] }));
    await bulk('lessonProgress', withEnrollment(progressRows));
    await bulk('quizAttempts', withEnrollment(attemptRows));
    // One learner is on a second attempt after being asked to revise, so the attempts timeline shows in the demo.
    // Derived from rows already built (no random draws), so the rest of the story is unchanged.
    const retry = submissionRows.find(r => r.status === 'Submitted' && Date.parse(String(r.submittedAt)) < NOW - 4 * DAY && [...lessonByKey.values()].some(l => l.id === r.lessonId && l.key === 'fb-write'));
    if (retry) {
      const at = Date.parse(String(retry.submittedAt));
      const owner = COURSES.find(c => courseId.get(c.key) === retry.courseId)?.owner ?? null;
      const person = allPeople.find(x => personId.get(x.key) === retry.personId);
      retry.attempt = 2;
      submissionRows.push({ ...retry, attempt: 1, body: assignmentText('fb-write', person?.name ?? 'there', true), files: '[]', status: 'Needs revision', grade: 45, feedback: revisionFeedback('fb-write'), gradedBy: owner ?? undefined, submittedAt: new Date(at - 3 * DAY).toISOString(), gradedAt: new Date(at - 2 * DAY).toISOString() });
    }
    await bulk('submissions', withEnrollment(submissionRows).map(({ gradedBy, ...r }) => ({ ...r, gradedById: typeof gradedBy === 'string' ? personId.get(gradedBy) ?? null : null })));

    // ── Certificates ──────────────────────────────────────────────────────
    const certPlans = planList.map((plan, i) => ({ plan, i })).filter(({ plan }) => plan.outcome === 'completed' && courseByKey.get(plan.courseKey)!.certificate);
    const certRecords: Array<{ credentialId: string; personId: string; courseId: string | null; pathId: string | null; enrollmentId: string; title: string; recipientName: string; issuedAt: string; expiresAt: string | null; status: string; score: number | null; revokedAt?: string; revokedReason?: string }> = certPlans.map(({ plan, i }) => {
      const course: SeedCourse = courseByKey.get(plan.courseKey)!;
      const issuedAt = ago(plan.completedAgo ?? 0);
      return {
        credentialId: credential(),
        personId: personId.get(plan.personKey)!,
        courseId: courseId.get(plan.courseKey)!,
        pathId: null,
        enrollmentId: enrollmentIds[i],
        title: course.title,
        recipientName: personByKey.get(plan.personKey)!.name,
        issuedAt,
        expiresAt: course.validityMonths ? addMonthsIso(issuedAt, course.validityMonths) : null,
        status: 'Active',
        score: (enrollmentRecords[i].score as number | null) ?? null,
      };
    });
    const pathCertRows = pathRows.map((r, i) => ({ r, i })).filter(({ r }) => r.record.status === 'Completed' && PATHS.find(p => p.key === r.pp.pathKey)!.certificate);
    for (const { r, i } of pathCertRows) {
      const path = PATHS.find(p => p.key === r.pp.pathKey)!;
      certRecords.push({ credentialId: credential(), personId: r.record.personId, courseId: null, pathId: r.record.pathId, enrollmentId: pathEnrollmentIds[i], title: path.title, recipientName: personByKey.get(r.pp.personKey)!.name, issuedAt: r.record.completedAt!, expiresAt: path.validityMonths ? addMonthsIso(r.record.completedAt!, path.validityMonths) : null, status: 'Active', score: null });
    }
    // One revoked certificate, for the record-keeping story.
    const revokeIndex = certRecords.findIndex(c => c.personId === personId.get('l34'));
    if (revokeIndex >= 0) Object.assign(certRecords[revokeIndex], { status: 'Revoked', revokedAt: ago(38), revokedReason: 'Left the company; badge access removed.' });
    const certIds = await bulk('certificates', certRecords);
    await inParallel(certPlans.map(({ i }, n) => ({ id: enrollmentIds[i], cert: certIds[n] })), x => zite.enrollments.update({ id: x.id, record: { certificateId: x.cert } }));
    await inParallel(pathCertRows.map(({ i }, n) => ({ id: pathEnrollmentIds[i], cert: certIds[certPlans.length + n] })), x => zite.pathEnrollments.update({ id: x.id, record: { certificateId: x.cert } }));
    certRecords.forEach((c, n) => activityRows.push({ planIndex: -1, type: 'certificate_issued', personId: c.personId, actorId: null, courseId: c.courseId ?? null, pathId: c.pathId ?? null, data: JSON.stringify({ credentialId: c.credentialId, title: c.title, certificateId: certIds[n] }), occurredAt: c.issuedAt }));

    // ── Sessions ──────────────────────────────────────────────────────────
    const sessionIds = await bulk(
      'sessions',
      SESSIONS.map(s => {
        const start = new Date(NOW + s.startsInDays * DAY);
        start.setUTCHours(s.hour, 0, 0, 0);
        return {
          title: s.title,
          courseId: s.course ? courseId.get(s.course)! : null,
          lessonId: s.lesson ? lessonByKey.get(s.lesson)!.id : null,
          description: s.description,
          startsAt: start.toISOString(),
          endsAt: new Date(start.getTime() + s.minutes * 60_000).toISOString(),
          timezone: DEMO_ORG.timezone,
          location: s.location,
          meetingUrl: s.meetingUrl,
          recordingUrl: s.recordingUrl,
          capacity: s.capacity,
          instructorId: personId.get(s.instructor)!,
          status: s.status,
        };
      }),
    );
    await bulk(
      'registrations',
      SESSIONS.flatMap((s, i) =>
        s.registrants.map(r => ({
          sessionId: sessionIds[i],
          personId: personId.get(r.person)!,
          status: r.status,
          registeredAt: ago(Math.max(1, (s.startsInDays < 0 ? -s.startsInDays : 0) + int(2, 12))),
          checkedInAt: r.status === 'Attended' ? new Date(NOW + s.startsInDays * DAY).toISOString() : null,
        })),
      ),
    );

    // ── Lesson Q&A ────────────────────────────────────────────────────────
    const questionIds = await bulk(
      'comments',
      THREADS.map(t => {
        const lesson = lessonByKey.get(t.lesson)!;
        return { body: t.body, courseId: courseId.get(lesson.courseKey)!, lessonId: lesson.id, personId: personId.get(t.by)!, parentId: null, postedAt: ago(t.daysAgo), pinned: t.pinned === true, resolvedAt: t.answer && t.daysAgo > 10 ? ago(t.daysAgo - 1) : null };
      }),
    );
    await bulk(
      'comments',
      THREADS.map((t, i) => ({ t, i }))
        .filter(({ t }) => t.answer)
        .map(({ t, i }) => {
          const lesson = lessonByKey.get(t.lesson)!;
          return { body: t.answer!.body, courseId: courseId.get(lesson.courseKey)!, lessonId: lesson.id, personId: personId.get(t.answer!.by)!, parentId: questionIds[i], postedAt: ago(Math.max(0, t.daysAgo - 0.3)), pinned: false };
        }),
    );

    // ── Notifications for the admin ───────────────────────────────────────
    const waiting = submissionRows.filter(s => s.status === 'Submitted').slice(0, 4);
    const open = THREADS.filter(t => !t.answer).slice(0, 3);
    const lessonTitle = (id: unknown) => [...lessonByKey.values()].find(l => l.id === id)?.title ?? 'an assignment';
    const personName = (id: unknown) => allPeople.find(p => personId.get(p.key) === id)?.name ?? 'Someone';
    await bulk('notifications', [
      ...waiting.map((s, i) => ({ title: `${personName(s.personId)} submitted “${lessonTitle(s.lessonId)}”`, body: 'Ready to grade.', type: 'submission_received', app: 'Admin', recipientId: actor.id, actorId: s.personId, courseId: s.courseId, link: '/grading', occurredAt: ago(i), readAt: null })),
      ...open.map((t, i) => ({ title: `${personByKey.get(t.by)!.name} asked a question on “${lessonByKey.get(t.lesson)!.title}”`, body: t.body, type: 'question_posted', app: 'Admin', recipientId: actor.id, actorId: personId.get(t.by)!, courseId: courseId.get(lessonByKey.get(t.lesson)!.courseKey)!, link: '/discussions', occurredAt: ago(t.daysAgo, 15 + i), readAt: null })),
      { title: 'Annual security awareness enrolled 3 new people', body: 'Including people who joined this week.', type: 'rule_ran', app: 'Admin', recipientId: actor.id, actorId: personId.get('aisha')!, courseId: courseId.get('security')!, link: '/assignments', occurredAt: ago(2), readAt: ago(1) },
      { title: 'Marcus Chen rated Giving and Receiving Feedback 5 stars', body: '“One of the better trainings we’ve had.”', type: 'course_rated', app: 'Admin', recipientId: actor.id, actorId: personId.get('l2')!, courseId: courseId.get('feedback')!, link: `/courses/${courseId.get('feedback')}`, occurredAt: ago(4), readAt: ago(3) },
      { title: 'New training: Code of Conduct & Ethics', body: `Due ${formatLongDay(dayAgo(-4))}`, type: 'course_assigned', app: 'Learn', recipientId: actor.id, actorId: personId.get('maya')!, courseId: courseId.get('conduct')!, link: `/courses/${slugify(COURSES[1].title)}`, occurredAt: ago(40), readAt: ago(39) },
      { title: 'You earned a certificate: Security Awareness Essentials', body: null, type: 'certificate_issued', app: 'Learn', recipientId: actor.id, actorId: null, courseId: courseId.get('security')!, link: '/certificates', occurredAt: ago(64), readAt: ago(63) },
      { title: 'Due in 4 days: Code of Conduct & Ethics', body: `Due ${formatLongDay(dayAgo(-4))}`, type: 'due_soon', app: 'Learn', recipientId: actor.id, actorId: null, courseId: courseId.get('conduct')!, link: `/courses/${slugify(COURSES[1].title)}`, occurredAt: ago(0, 13), readAt: null },
    ]);

    // ── Activity ──────────────────────────────────────────────────────────
    for (const s of submissionRows) {
      activityRows.push({ planIndex: s.planIndex, type: 'assignment_submitted', personId: s.personId, actorId: s.personId, courseId: s.courseId, lessonId: s.lessonId, occurredAt: s.submittedAt });
      if (s.gradedAt) activityRows.push({ planIndex: s.planIndex, type: 'assignment_graded', personId: s.personId, actorId: s.gradedBy ? personId.get(s.gradedBy) ?? null : null, courseId: s.courseId, lessonId: s.lessonId, data: JSON.stringify({ grade: s.grade, status: s.status }), occurredAt: s.gradedAt });
    }
    await bulk('activity', activityRows.map(({ planIndex, ...r }) => ({ ...r, enrollmentId: planIndex >= 0 ? enrollmentIds[planIndex] : null })));

    // ── Saved views ───────────────────────────────────────────────────────
    await bulk('views', [
      { name: 'Overdue compliance', ownerId: actor.id, scope: 'Shared', page: 'enrollments', config: JSON.stringify({ filters: { due: ['overdue'], categoryIds: [categoryId.get('compliance')] }, ordering: 'due_asc', groupBy: 'course' }), position: 0 },
      { name: 'Distribution center', ownerId: personId.get('tom')!, scope: 'Shared', page: 'enrollments', config: JSON.stringify({ filters: { groupIds: [groupId.get('dc')] }, ordering: 'due_asc', groupBy: 'person' }), position: 1 },
      { name: 'Stalled for 2+ weeks', ownerId: actor.id, scope: 'Personal', page: 'enrollments', config: JSON.stringify({ filters: { inactiveDays: 14, statuses: ['In progress'] }, ordering: 'activity_desc', groupBy: 'none' }), position: 2 },
    ]);

    return { counts };
  },
});

const HAZARD_PHOTO = JSON.stringify([{ name: 'hazard-photo.jpg', url: 'https://images.unsplash.com/photo-1586528116311-ad8dd3c8310d?w=1200&q=80', size: 284000, type: 'image/jpeg' }]);

function revisionFeedback(lessonKey: string) {
  if (lessonKey === 'fb-write') return 'This is praise rather than feedback — there’s no situation, no specific behavior and no impact yet. Pick one real moment, describe what you saw, say what it changed, and end with a question.';
  if (lessonKey === 'sel-plan') return 'These are all Situation questions. Add Problem and Implication questions that uncover what stock-outs and late deliveries actually cost them.';
  return 'Good start, but this needs a specific location and a proposed fix. Have another go and resubmit.';
}

function assignmentText(lessonKey: string, name: string, weak = false) {
  const first = name.split(' ')[0];
  if (lessonKey === 'wh-report') {
    return weak
      ? 'There was some stuff on the floor near receiving.'
      : `**Where:** Aisle 14, next to the lift assist station.\n\n**Hazard:** Shrink wrap offcuts piling up on the floor where pickers turn their carts. Someone could slip, especially on night shift when the lighting is dimmer.\n\n**What I did:** Cleared it into the recycling cage and let my shift supervisor know.\n\n**Fix:** A second wrap-waste bin at the end of aisle 14, and adding it to the hourly sweep checklist. — ${first}`;
  }
  if (lessonKey === 'sel-plan') {
    return `Account: regional school district (12 sites)\n\n**Situation**\n\n1. How do sites order supplies today — centrally or each school?\n2. Who signs off on purchases over $5k?\n\n**Problem**\n\n3. Where do orders get stuck or arrive late?\n4. What happens when a site runs out mid-term?\n\n**Implication**\n\n5. How much staff time goes into chasing deliveries each month?\n6. What did last year's stock-outs cost you in emergency purchases?\n\n**Need-payoff**\n\n7. If replenishment were automatic, what would your team do with that time?\n8. How would a single monthly invoice change things for finance?`;
  }
  if (lessonKey === 'fb-write') {
    return weak
      ? 'You did a great job on the project, thanks!'
      : `**Situation:** In Monday's weekly planning meeting,\n\n**Behavior:** you shared the stock-out numbers before anyone asked and suggested we move the reorder point for camping stoves,\n\n**Impact:** so we fixed it before the holiday weekend instead of after. It saved us a very busy Saturday.\n\n**Question:** What made you look at those numbers — is it something we should do every week?`;
  }
  return `Submission from ${first}.`;
}
