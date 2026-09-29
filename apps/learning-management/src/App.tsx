import { setCertificateTimeZone } from '@project/shared/certificateDates';
import { ExternalLink } from 'lucide-react';
import { lazy, Suspense, useEffect, type ComponentType, type ReactNode } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Toaster } from '@project/components/ui/sonner';
import { TooltipProvider } from '@project/components/ui/tooltip';
import { AppShell } from './components/shell/AppShell';
import { errorMessage } from './lib/errors';
import { useBootstrap } from './lib/queries';
import { useTheme } from './lib/theme';
import { WorkspaceProvider } from './lib/workspace';
import { EnrollmentsPage, ViewPage } from './pages/EnrollmentsPage';
import { HomePage } from './pages/HomePage';

/**
 * HashRouter, not BrowserRouter: the app is served under a path the runtime
 * doesn't rewrite, so a refreshed path-based deep link would 404.
 *
 * Feature pages are lazy: each loads on demand (and is prefetched when the
 * browser is idle), so the first paint only carries the shell and Home, and a
 * problem in one page can never take down the others.
 */

const named = <K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K) => () => load().then(m => ({ default: m[name] }));

const loaders = {
  courses: named(() => import('./pages/CoursesPage'), 'CoursesPage'),
  course: named(() => import('./pages/CoursePage'), 'CoursePage'),
  paths: named(() => import('./pages/PathsPage'), 'PathsPage'),
  path: named(() => import('./pages/PathPage'), 'PathPage'),
  sessions: named(() => import('./pages/SessionsPage'), 'SessionsPage'),
  session: named(() => import('./pages/SessionPage'), 'SessionPage'),
  people: named(() => import('./pages/PeoplePage'), 'PeoplePage'),
  person: named(() => import('./pages/PersonPage'), 'PersonPage'),
  groups: named(() => import('./pages/GroupsPage'), 'GroupsPage'),
  group: named(() => import('./pages/GroupPage'), 'GroupPage'),
  assignments: named(() => import('./pages/AssignmentsPage'), 'AssignmentsPage'),
  certificates: named(() => import('./pages/CertificatesPage'), 'CertificatesPage'),
  reports: named(() => import('./pages/ReportsPage'), 'ReportsPage'),
  settings: named(() => import('./pages/SettingsPage'), 'SettingsPage'),
  inbox: named(() => import('./pages/InboxPage'), 'InboxPage'),
  grading: named(() => import('./pages/GradingPage'), 'GradingPage'),
  discussions: named(() => import('./pages/DiscussionsPage'), 'DiscussionsPage'),
};
const P = Object.fromEntries(Object.entries(loaders).map(([k, load]) => [k, lazy(load)])) as unknown as Record<keyof typeof loaders, ComponentType>;

function usePrefetchPages() {
  useEffect(() => {
    const run = () => Object.values(loaders).forEach(load => void load().catch(() => undefined));
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (idle) idle(run);
    else window.setTimeout(run, 1500);
  }, []);
}

const Page = ({ children }: { children: ReactNode }) => <Suspense fallback={<div className="min-h-0 flex-1" />}>{children}</Suspense>;

function BootScreen({ state, onRetry, message }: { state: 'loading' | 'error'; onRetry: () => void; message?: string }) {
  return (
    <div className="grid h-[100dvh] place-items-center bg-canvas px-6">
      <div className="flex max-w-sm flex-col items-center text-center animate-fade-up">
        <img src="/favicon.svg" alt="" className="mb-5 h-11 w-11 rounded-xl shadow-md" />
        {state === 'error' ? (
          <>
            <h1 className="text-[16px] font-semibold">Your academy couldn't load</h1>
            <p className="mt-1.5 text-[14px] text-muted-foreground">{message ?? "The workspace didn't respond. If you opened this in a new browser, make sure you're signed in to your organization."}</p>
            <button type="button" onClick={onRetry} className="mt-4 h-9 rounded-md border bg-background px-3 text-[14px] shadow-xs hover:bg-accent">
              Try again
            </button>
          </>
        ) : (
          <>
            <h1 className="text-[15px] font-medium">Loading your academy</h1>
            <div className="mt-4 h-1 w-40 overflow-hidden rounded-full bg-muted">
              <div className="h-full w-1/3 rounded-full bg-primary/70" style={{ animation: 'boot-slide 1.2s ease-in-out infinite' }} />
            </div>
            <style>{'@keyframes boot-slide{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}'}</style>
          </>
        )}
      </div>
    </div>
  );
}

function LearnerOnly({ name, academyName, learnUrl }: { name: string; academyName: string; learnUrl: string | null }) {
  return (
    <div className="grid h-[100dvh] place-items-center bg-canvas px-6">
      <div className="flex max-w-sm flex-col items-center text-center animate-fade-up">
        <img src="/favicon.svg" alt="" className="mb-5 h-11 w-11 rounded-xl shadow-md" />
        <h1 className="text-[16px] font-semibold">Hi {name.split(' ')[0]} — this is the admin side</h1>
        <p className="mt-1.5 text-[14px] text-muted-foreground">You have learner access. Your courses, certificates and progress live in {academyName}. If you need to build courses or manage training, ask an admin to make you an instructor.</p>
        {learnUrl && (
          <a href={learnUrl} className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3 text-[14px] font-medium text-primary-foreground shadow-xs hover:bg-primary/90">
            Open {academyName} <ExternalLink className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
    </div>
  );
}

function Boot() {
  const { data, isError, error, refetch } = useBootstrap();
  usePrefetchPages();

  // A new workspace opens empty, straight into the app. Sample data is opt-in, from Settings → Data.
  const refusal = isError ? errorMessage(error, '') : '';
  if (isError) return <BootScreen state="error" message={/deactivated/i.test(refusal) ? refusal : undefined} onRetry={() => void refetch()} />;
  if (data?.access === 'learner') return <LearnerOnly name={data.me.name} academyName={data.settings.academyName} learnUrl={data.settings.learnUrl} />;
  if (!data) return <BootScreen state="loading" onRetry={() => void refetch()} />;

  // Certificates are dated in the organization's zone; set before any certificate renders.
  setCertificateTimeZone(data.settings.timezone);
  return (
    <WorkspaceProvider data={data}>
      <Routes>
        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/home" replace />} />
          <Route path="/home" element={<HomePage />} />
          <Route path="/inbox" element={<Page><P.inbox /></Page>} />
          <Route path="/grading" element={<Page><P.grading /></Page>} />
          <Route path="/grading/:submissionId" element={<Page><P.grading /></Page>} />
          <Route path="/discussions" element={<Page><P.discussions /></Page>} />
          <Route path="/courses" element={<Page><P.courses /></Page>} />
          <Route path="/courses/:courseId" element={<Page><P.course /></Page>} />
          <Route path="/courses/:courseId/:tab" element={<Page><P.course /></Page>} />
          <Route path="/courses/:courseId/:tab/:itemId" element={<Page><P.course /></Page>} />
          <Route path="/paths" element={<Page><P.paths /></Page>} />
          <Route path="/paths/:pathId" element={<Page><P.path /></Page>} />
          <Route path="/paths/:pathId/:tab" element={<Page><P.path /></Page>} />
          <Route path="/paths/:pathId/:tab/:itemId" element={<Page><P.path /></Page>} />
          <Route path="/sessions" element={<Page><P.sessions /></Page>} />
          <Route path="/sessions/:sessionId" element={<Page><P.session /></Page>} />
          <Route path="/people" element={<Page><P.people /></Page>} />
          <Route path="/people/:personId" element={<Page><P.person /></Page>} />
          <Route path="/people/:personId/:tab" element={<Page><P.person /></Page>} />
          <Route path="/groups" element={<Page><P.groups /></Page>} />
          <Route path="/groups/:groupId" element={<Page><P.group /></Page>} />
          <Route path="/groups/:groupId/:tab" element={<Page><P.group /></Page>} />
          <Route path="/enrollments" element={<EnrollmentsPage />} />
          <Route path="/view/:viewId" element={<ViewPage />} />
          <Route path="/assignments" element={<Page><P.assignments /></Page>} />
          <Route path="/assignments/:ruleId" element={<Page><P.assignments /></Page>} />
          <Route path="/certificates" element={<Page><P.certificates /></Page>} />
          <Route path="/reports" element={<Page><P.reports /></Page>} />
          <Route path="/reports/:tab" element={<Page><P.reports /></Page>} />
          <Route path="/settings" element={<Navigate to={data.me.role === 'Admin' ? '/settings/general' : '/settings/profile'} replace />} />
          <Route path="/settings/:section" element={<Page><P.settings /></Page>} />
          <Route path="*" element={<Navigate to="/home" replace />} />
        </Route>
      </Routes>
    </WorkspaceProvider>
  );
}

export default function App() {
  const { resolved } = useTheme();
  return (
    <HashRouter>
      <TooltipProvider delayDuration={350} skipDelayDuration={200}>
        <Boot />
        {/* Lifted clear of the bulk-action bars that sit at the bottom of lists. */}
        <Toaster position="bottom-right" offset={{ bottom: 72, right: 16 }} mobileOffset={{ bottom: 72 }} theme={resolved} closeButton richColors={false} toastOptions={{ className: 'text-[14px]' }} />
      </TooltipProvider>
    </HashRouter>
  );
}
