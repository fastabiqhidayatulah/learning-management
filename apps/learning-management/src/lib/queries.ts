import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { bootstrap, getCourse, getEnrollment, listEnrollments, search, searchPeople } from 'zitejs/api';
import type { EnrollmentFilters, EnrollmentOrdering } from './types';

/**
 * Query keys in one place, so invalidation and optimistic writes can't drift
 * from reads. Feature areas add their own keys under a distinct first segment
 * and invalidate by that segment. Reserved roots are listed here so two areas
 * never collide.
 */
export const qk = {
  bootstrap: ['bootstrap'] as const,
  enrollmentsRoot: ['enrollments'] as const,
  enrollments: (filters: EnrollmentFilters, ordering: string, limit: number) => ['enrollments', { filters, ordering, limit }] as const,
  enrollmentRoot: ['enrollment'] as const,
  enrollment: (id: string) => ['enrollment', id] as const,
  courseRoot: ['course'] as const,
  course: (id: string) => ['course', id] as const,
  peopleSearchRoot: ['people-search'] as const,
  searchRoot: ['search'] as const,
  // Reserved for feature areas:
  peopleRoot: ['people'] as const,
  personRoot: ['person'] as const,
  groupRoot: ['group'] as const,
  pathRoot: ['path'] as const,
  sessionsRoot: ['sessions'] as const,
  rulesRoot: ['rules'] as const,
  certificatesRoot: ['certificates'] as const,
  gradingRoot: ['grading'] as const,
  notificationsRoot: ['notifications'] as const,
  discussionsRoot: ['discussions'] as const,
  reportsRoot: ['reports'] as const,
  homeRoot: ['home'] as const,
  courseStatsRoot: ['course-stats'] as const,
  settingsRoot: ['settings'] as const,
};

/** A refusal (no access, the demo's read-only database) won't change on retry, so the boot screen shows it at once. */
const retryUnlessRefused = (count: number, error: unknown) => count < 2 && !/\b4\d\d\b|FORBIDDEN|UNAUTHORIZED|DEMO_READ_ONLY/.test(String((error as Error)?.message ?? error));

export function useBootstrap() {
  return useQuery({ queryKey: qk.bootstrap, queryFn: () => bootstrap({}), staleTime: 60_000, refetchOnWindowFocus: true, retry: retryUnlessRefused });
}

/** A missing record won't appear on retry; everything else (network, 5xx) gets a couple more tries. */
export const retryUnlessNotFound = (count: number, error: unknown) => !/not found|no longer exists|\(404\)/i.test(String((error as Error)?.message ?? '')) && count < 2;

export function useEnrollments(filters: EnrollmentFilters, ordering: EnrollmentOrdering = 'due_asc', opts: { enabled?: boolean; limit?: number } = {}) {
  const limit = opts.limit ?? 1000;
  return useQuery({
    queryKey: qk.enrollments(filters, ordering, limit),
    queryFn: () => listEnrollments({ filters, ordering, limit }),
    enabled: opts.enabled ?? true,
    placeholderData: keepPreviousData,
    staleTime: 20_000,
  });
}

export function useEnrollment(id: string | null | undefined) {
  return useQuery({ queryKey: qk.enrollment(id ?? ''), queryFn: () => getEnrollment({ id: id! }), enabled: Boolean(id), staleTime: 10_000, retry: retryUnlessNotFound });
}

export function useCourse(id: string | null | undefined) {
  return useQuery({ queryKey: qk.course(id ?? ''), queryFn: () => getCourse({ id: id! }), enabled: Boolean(id), staleTime: 15_000, retry: retryUnlessNotFound });
}

export function usePeopleSearch(q: string, opts: { ids?: string[]; groupId?: string; roles?: Array<'Admin' | 'Instructor' | 'Learner'>; enabled?: boolean; limit?: number } = {}) {
  const query = q.trim();
  return useQuery({
    queryKey: [...qk.peopleSearchRoot, query, opts.ids ?? null, opts.groupId ?? null, opts.roles ?? null, opts.limit ?? 30],
    queryFn: () => searchPeople({ q: query, ids: opts.ids, groupId: opts.groupId, roles: opts.roles, limit: opts.limit ?? 30 }),
    enabled: opts.enabled ?? true,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useSearch(q: string) {
  const query = q.trim();
  return useQuery({ queryKey: [...qk.searchRoot, query], queryFn: () => search({ query, limit: 6 }), enabled: query.length > 0, placeholderData: keepPreviousData, staleTime: 15_000 });
}
