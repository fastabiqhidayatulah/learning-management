import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Check, CircleCheck, Database, Download, FileCheck2, Link2Off, Loader2, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { clearDemoData, seedWorkspace, type ClearDemoDataOutputType } from 'zitejs/api';
import { Button } from '@project/components/ui/button';
import { Input } from '@project/components/ui/input';
import { cn } from '@project/components/lib/utils';
import { errorMessage } from '../../lib/errors';
import { useAppActions } from '../../lib/app-actions';
import { plural } from '../../lib/format';
import { useWorkspace } from '../../lib/workspace';
import { ProgressBar } from '../primitives/bits';
import { SettingsCard, SettingsPageTitle, SettingsRow, SettingsSection, inputClass, settingsKeys } from './ui';

type DryRun = ClearDemoDataOutputType;

const GROUPS: Array<{ title: string; rows: Array<{ key: string; one: string; many?: string }> }> = [
  { title: 'People and teams', rows: [{ key: 'people', one: 'demo person', many: 'demo people' }, { key: 'groups', one: 'group' }, { key: 'groupMembers', one: 'group membership' }] },
  { title: 'Courses and content', rows: [{ key: 'courses', one: 'course' }, { key: 'paths', one: 'learning path' }, { key: 'sections', one: 'section' }, { key: 'lessons', one: 'lesson' }, { key: 'pathCourses', one: 'course in a path', many: 'courses in paths' }, { key: 'categories', one: 'category', many: 'categories' }] },
  {
    title: 'Learning history',
    rows: [
      { key: 'enrollments', one: 'enrollment' },
      { key: 'pathEnrollments', one: 'path enrollment' },
      { key: 'lessonProgress', one: 'lesson progress record' },
      { key: 'quizAttempts', one: 'quiz attempt' },
      { key: 'submissions', one: 'assignment submission' },
      { key: 'certificates', one: 'certificate' },
    ],
  },
  {
    title: 'Everything around it',
    rows: [
      { key: 'sessions', one: 'live session' },
      { key: 'registrations', one: 'session registration' },
      { key: 'assignmentRules', one: 'assignment rule' },
      { key: 'comments', one: 'discussion post' },
      { key: 'views', one: 'saved view' },
      { key: 'notifications', one: 'notification' },
      { key: 'activity', one: 'activity record' },
    ],
  },
];

function WhatGoes({ data }: { data: DryRun }) {
  return (
    <div className="grid gap-x-6 gap-y-4 sm:grid-cols-2" data-dry-run>
      {GROUPS.map(g => {
        const rows = g.rows.filter(r => (data.tables[r.key] ?? 0) > 0);
        if (!rows.length) return null;
        return (
          <div key={g.title} className="min-w-0">
            <div className="mb-1.5 text-sm font-medium text-muted-foreground">{g.title}</div>
            <ul className="space-y-0.5 text-[14px]">
              {rows.map(r => {
                const n = data.tables[r.key] ?? 0;
                return (
                  <li key={r.key} className="flex items-baseline gap-2" data-table={r.key}>
                    <span className="w-12 shrink-0 text-right font-medium tabular-nums">{n.toLocaleString()}</span>
                    <span className="min-w-0 truncate text-muted-foreground">{n === 1 ? r.one : r.many ?? `${r.one}s`}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/** The way out of the demo: everything the seed made goes, anything created since stays. */
function RemoveDemo() {
  const ws = useWorkspace();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const orgName = ws.settings.organizationName;
  const { data, isPending, isError, refetch, isFetching } = useQuery({ queryKey: settingsKeys.demo, queryFn: () => clearDemoData({ dryRun: true }), staleTime: 0, refetchOnWindowFocus: false });
  const [typed, setTyped] = useState('');
  const [run, setRun] = useState<{ state: 'idle' | 'running' | 'failed' | 'done'; removed: number; startedAt: number; error?: string }>({ state: 'idle', removed: 0, startedAt: 0 });
  const [now, setNow] = useState(Date.now());
  const cancelled = useRef(false);

  useEffect(() => {
    if (run.state !== 'running') return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('beforeunload', warn);
    };
  }, [run.state]);
  useEffect(() => () => void (cancelled.current = true), []);

  const matches = typed.trim().toLowerCase() === orgName.trim().toLowerCase();
  const total = Math.max(1, data?.removed ?? 1);

  const start = async () => {
    if (!matches || run.state === 'running') return;
    const startedAt = Date.now();
    let removed = run.state === 'failed' ? run.removed : 0;
    setRun({ state: 'running', removed, startedAt });
    try {
      // Each call works for up to ~25 seconds and says whether there's more. Rate limits keep it to a few writes a second.
      for (let i = 0; i < 200; i++) {
        const res = await clearDemoData({ dryRun: false });
        removed += res.removed;
        if (!cancelled.current) setRun({ state: 'running', removed, startedAt });
        if (res.done) break;
      }
      setRun({ state: 'done', removed, startedAt });
      toast.success('Demo data removed', { description: `${removed.toLocaleString()} records deleted. The workspace is ready for your own training.` });
      await qc.invalidateQueries();
      navigate('/home');
    } catch (e) {
      setRun({ state: 'failed', removed, startedAt, error: errorMessage(e, "Couldn't finish removing the demo") });
      void qc.invalidateQueries();
    }
  };

  const elapsed = Math.max(0, Math.round((now - run.startedAt) / 1000));
  const pct = Math.min(1, run.removed / total);

  return (
    <SettingsSection title="Remove demo data" description="The sample company, Fernwood Supply Co., is loaded in this workspace. Remove it when you’re ready to use your own training data.">
      <SettingsCard>
        <div className="space-y-5 p-4 sm:p-5">
          <div>
            <div className="mb-3 flex items-center gap-2 text-[14px] font-medium">
              <Trash2 className="h-3.5 w-3.5 text-tone-danger" /> What goes
              {data && <span className="font-normal text-muted-foreground">· {plural(data.removed, 'record')}</span>}
            </div>
            {isPending ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="space-y-2">
                    <div className="skeleton h-2.5 w-24" />
                    <div className="skeleton h-3 w-40" />
                    <div className="skeleton h-3 w-32" />
                  </div>
                ))}
              </div>
            ) : isError || !data ? (
              <div className="flex items-center gap-3 text-[14px] text-muted-foreground">
                <span>Couldn’t count the demo records.</span>
                <Button size="sm" variant="outline" className="h-8" onClick={() => refetch()} disabled={isFetching}>Try again</Button>
              </div>
            ) : (
              <WhatGoes data={data} />
            )}
          </div>

          <div className="rounded-lg bg-subtle px-3.5 py-3">
            <div className="mb-2 flex items-center gap-2 text-[14px] font-medium">
              <ShieldCheck className="h-3.5 w-3.5 text-tone-success" /> What stays
            </div>
            <ul className="space-y-1 text-[13.5px] text-muted-foreground">
              <li className="flex gap-2"><Check className="mt-0.5 h-3 w-3 shrink-0" /> You ({ws.me.email}) and everyone who isn’t a Fernwood demo person.</li>
              <li className="flex gap-2"><Check className="mt-0.5 h-3 w-3 shrink-0" /> Anything created before the demo was loaded or since: courses, people, groups and their enrollments. Only rows attached to demo records (like a new enrollment in a demo course) go with them.</li>
              <li className="flex gap-2"><Check className="mt-0.5 h-3 w-3 shrink-0" /> Email templates, including your edits, and your logo.</li>
              {data && data.reset.length > 0 && (
                <li className="flex gap-2"><RotateCcw className="mt-0.5 h-3 w-3 shrink-0" /> <span>Still showing the demo’s values, so reset to neutral defaults: {data.reset.join(', ').toLowerCase().replace(/^./, c => c.toUpperCase())}.</span></li>
              )}
              {data && data.detached > 0 && (
                <li className="flex gap-2"><Link2Off className="mt-0.5 h-3 w-3 shrink-0" /> {plural(data.detached, 'real record')} that point at a demo person or group (as owner, manager, instructor or grader) are kept and simply unlinked.</li>
              )}
            </ul>
          </div>

          {run.state === 'running' || run.state === 'done' ? (
            <div className="space-y-2" aria-live="polite" data-demo-progress>
              <div className="flex items-center gap-2 text-[14px]">
                {run.state === 'done' ? <CircleCheck className="h-4 w-4 text-tone-success" /> : <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                <span className="font-medium">{run.state === 'done' ? 'Demo removed' : 'Removing the demo…'}</span>
                <span className="ml-auto tabular-nums text-muted-foreground">{run.removed.toLocaleString()} of {total.toLocaleString()}</span>
              </div>
              <ProgressBar value={run.state === 'done' ? 1 : Math.max(0.02, pct)} tone={run.state === 'done' ? 'success' : 'primary'} />
              <p className="text-sm text-muted-foreground">
                {run.state === 'done'
                  ? 'Taking you to Home…'
                  : `Records are removed a few at a time, so this takes a few minutes${elapsed > 5 ? ` (${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')} so far)` : ''}. Keep this tab open — if it’s interrupted, run it again and it picks up where it stopped.`}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {run.state === 'failed' && (
                <p className="rounded-md bg-tone-danger/[0.08] px-3 py-2 text-[13.5px] text-tone-danger" role="alert">
                  {run.error} {run.removed > 0 ? `${run.removed.toLocaleString()} records were already removed and stay removed.` : ''} Run it again to finish.
                </p>
              )}
              <label htmlFor="demo-confirm" className="block text-[14px]">
                To confirm, type <span className="select-all font-semibold">{orgName}</span>
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="demo-confirm"
                  value={typed}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={e => setTyped(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && void start()}
                  className={cn(inputClass, 'sm:max-w-[280px]')}
                />
                <Button size="sm" variant="destructive" className="h-9" disabled={!matches || !data} onClick={() => void start()}>
                  <Trash2 /> {run.state === 'failed' ? 'Finish removing the demo' : 'Remove demo data'}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">This can’t be undone. It takes a few minutes; you can keep working in another tab.</p>
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

/**
 * Offered only while the sample isn't loaded and the workspace has no courses,
 * learning paths or live sessions (the seed endpoint enforces the same rule),
 * so it goes away for good once real training exists. Removal takes its place
 * while the sample is in.
 */
function LoadSample() {
  const qc = useQueryClient();
  const app = useAppActions();
  const [loading, setLoading] = useState(false);

  const load = async () => {
    const ok = await app.confirm({
      title: 'Load sample data?',
      description: 'This adds Fernwood Supply Co., a made-up company with 39 people, 12 courses, 4 learning paths and a year of enrollments, progress and certificates. You can remove it later from this page.',
      confirmLabel: 'Load sample data',
    });
    if (!ok) return;
    setLoading(true);
    try {
      await seedWorkspace({});
      await qc.invalidateQueries();
      toast.success('Sample data loaded', { description: 'You can remove it from this page when you’re done with it.' });
    } catch (e) {
      toast.error(errorMessage(e, "Couldn't load the sample data"));
      void qc.invalidateQueries();
    } finally {
      setLoading(false);
    }
  };

  return (
    <SettingsSection title="Sample data" description="Fill this empty workspace with a made-up company to see how everything works.">
      <Button size="sm" variant="outline" className="h-8" disabled={loading} onClick={() => void load()}>
        {loading && <Loader2 className="animate-spin" />} {loading ? 'Loading sample data…' : 'Load sample data'}
      </Button>
    </SettingsSection>
  );
}

export function DataSettings() {
  const ws = useWorkspace();
  return (
    <>
      <SettingsPageTitle title="Data" description={ws.demo ? 'The demo company, getting your training records out, and where your data lives.' : 'Getting your training records out, and where your data lives.'} />

      <SettingsSection title="Export">
        <SettingsCard>
          <SettingsRow label="All enrollments" description="Open Enrollments, adjust filters if you like, then choose Export to CSV from the ⋯ menu. Each row has the learner, course, status, progress, due date, score and completion date." compact>
            <Button size="sm" variant="outline" asChild>
              <Link to="/enrollments">
                <Download /> Go to enrollments <ArrowRight />
              </Link>
            </Button>
          </SettingsRow>
          <SettingsRow label="Certificates" description="Every certificate issued, with credential IDs, expiry and status." compact>
            <Button size="sm" variant="outline" asChild>
              <Link to="/certificates">
                <FileCheck2 /> Certificates <ArrowRight />
              </Link>
            </Button>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Your data">
        <SettingsCard>
          <div className="space-y-3 px-4 py-4 text-[14px] text-muted-foreground">
            <p className="flex gap-2.5">
              <Database className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Everything here — people, courses, enrollments, progress, certificates — is stored in your organization’s Zite workspace database, in plain tables you can open, filter and export from Zite directly. Nothing is kept anywhere else.
              </span>
            </p>
            <p className="pl-[26px]">Progress is always recalculated from lesson records, so reports, certificates and what learners see never disagree. Completed training stays on record even if a course changes later, and deactivating someone keeps their history.</p>
            <p className="pl-[26px]">Certificates can be verified by anyone with the credential ID on the academy’s public verification page, until they’re revoked.</p>
          </div>
        </SettingsCard>
      </SettingsSection>

      {ws.demo ? <RemoveDemo /> : ws.canLoadSample ? <LoadSample /> : null}
    </>
  );
}
