import {
  Award, BarChart3, BookOpen, CalendarClock, Check, ChevronRight, ClipboardCheck, ExternalLink, GraduationCap, Home, Inbox, Keyboard, Languages, Laptop, Layers, MessagesSquare, Moon, Plus, Route, Search, Settings, Sun, UserPlus, Users, UsersRound, Workflow,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@project/components/ui/dropdown-menu';
import { cn } from '@project/components/lib/utils';
import { LOCALES, useT } from '@project/shared/i18n';
import { useAppActions } from '../../lib/app-actions';
import { MOD } from '../../lib/hotkeys';
import { useTheme } from '../../lib/theme';
import { useWorkspace } from '../../lib/workspace';
import { PersonAvatar } from '../primitives/Avatar';
import { Kbd, Tip } from '../primitives/bits';
import { CourseGlyph } from '../primitives/icons';

function useStoredToggle(key: string, initial = true) {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(`lms:sidebar:${key}`);
      return v === null ? initial : v === '1';
    } catch {
      return initial;
    }
  });
  const toggle = () =>
    setValue(v => {
      try {
        localStorage.setItem(`lms:sidebar:${key}`, v ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !v;
    });
  return [value, toggle] as const;
}

const RECENT_KEY = 'lms:recent-courses';

/** Courses opened recently, most recent first — the sidebar's quick links. */
export function rememberCourse(id: string) {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
    const next = [id, ...list.filter(x => x !== id)].slice(0, 6);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    window.dispatchEvent(new Event('lms:recent-courses'));
  } catch {
    /* ignore */
  }
}

function useRecentCourses() {
  const read = () => {
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[];
    } catch {
      return [];
    }
  };
  const [ids, setIds] = useState<string[]>(read);
  useEffect(() => {
    const on = () => setIds(read());
    window.addEventListener('lms:recent-courses', on);
    return () => window.removeEventListener('lms:recent-courses', on);
  }, []);
  return ids;
}

/** The organization's logo, falling back to the app's own mark when it's unset or fails to load. */
function OrgMark({ logoUrl }: { logoUrl: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (logoUrl && failed !== logoUrl) return <img src={logoUrl} alt="" onError={() => setFailed(logoUrl)} className="h-5 w-5 rounded-[5px] object-cover" />;
  return <img src="/favicon.svg" alt="" className="h-5 w-5 rounded-[5px]" />;
}

function Item({ to, icon, label, count, onNavigate, end, accent, indent }: { to: string; icon: ReactNode; label: string; count?: number | null; onNavigate?: () => void; end?: boolean; accent?: boolean; indent?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      onClick={onNavigate}
      className={({ isActive }) =>
        cn(
          'group flex h-8 items-center gap-2 rounded-md px-2 text-[14px] text-sidebar-foreground transition-colors duration-75 hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground',
          indent && 'pl-[30px]',
          isActive && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground',
        )
      }
    >
      <span className="flex w-4 shrink-0 items-center justify-center [&_svg]:h-[15px] [&_svg]:w-[15px]">{icon}</span>
      <span className="truncate">{label}</span>
      {count ? <span className={cn('ml-auto text-sm tabular-nums', accent ? 'rounded-full bg-primary px-1.5 text-[12px] font-medium leading-[20px] text-primary-foreground' : 'text-muted-foreground')}>{count}</span> : null}
    </NavLink>
  );
}

function SectionHeader({ label, open, onToggle, action }: { label: string; open: boolean; onToggle: () => void; action?: ReactNode }) {
  return (
    <div className="group/sh flex h-8 items-center pl-2 pr-1">
      <button type="button" onClick={onToggle} className="flex flex-1 items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
        {label}
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
      </button>
      <span className="opacity-0 transition-opacity focus-within:opacity-100 group-hover/sh:opacity-100">{action}</span>
    </div>
  );
}

function CourseBlock({ courseId, onNavigate }: { courseId: string; onNavigate?: () => void }) {
  const ws = useWorkspace();
  const { t } = useT();
  const c = ws.courseById.get(courseId);
  const location = useLocation();
  const [open, toggle] = useStoredToggle(`course:${courseId}`, false);
  if (!c) return null;
  const inCourse = location.pathname.startsWith(`/courses/${c.id}`);
  return (
    <div>
      <div className={cn('group flex h-8 items-center rounded-md pr-1 text-[14px] text-sidebar-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground', inCourse && !open && 'bg-sidebar-accent/60')}>
        <NavLink to={`/courses/${c.id}`} end onClick={onNavigate} className="flex min-w-0 flex-1 items-center gap-2 pl-2">
          <CourseGlyph icon={c.icon} color={c.color} size={16} />
          <span className={cn('truncate', inCourse && 'font-medium text-sidebar-accent-foreground')}>{c.title}</span>
        </NavLink>
        {c.status !== 'Published' && <span className="ml-1 text-2xs text-muted-foreground">{c.status}</span>}
        <button type="button" onClick={toggle} aria-label={open ? t('common.collapse', { title: c.title }) : t('common.expand', { title: c.title })} className="ml-0.5 flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">
          <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
        </button>
      </div>
      {open && (
        <div className="mt-px space-y-px">
          <Item indent to={`/courses/${c.id}/content`} icon={<BookOpen />} label={t('nav.content')} onNavigate={onNavigate} />
          <Item indent to={`/courses/${c.id}/learners`} icon={<Users />} label={t('nav.learners')} count={c.counts.enrolled || null} onNavigate={onNavigate} />
          <Item indent to={`/courses/${c.id}/settings`} icon={<Settings />} label={t('nav.settings')} onNavigate={onNavigate} />
        </div>
      )}
    </div>
  );
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const ws = useWorkspace();
  const app = useAppActions();
  const { t, locale, setLocale } = useT();
  const { resolved, toggle, setPref } = useTheme();
  const [workspaceOpen, toggleWorkspace] = useStoredToggle('workspace');
  const [viewsOpen, toggleViews] = useStoredToggle('views');
  const [recentOpen, toggleRecent] = useStoredToggle('recent');
  const recent = useRecentCourses().filter(id => ws.courseById.has(id)).slice(0, 5);
  const me = ws.staffById.get(ws.me.id) ?? { ...ws.me, status: 'Active' };
  const [createOpen, setCreateOpen] = useState(false);
  // "C" opens the create menu — only in the docked sidebar, not the mobile sheet copy.
  useEffect(() => {
    if (onNavigate) return;
    const open = () => setCreateOpen(true);
    window.addEventListener('lms:create', open);
    return () => window.removeEventListener('lms:create', open);
  }, [onNavigate]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 shrink-0 items-center gap-1 px-2.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-sidebar-accent/70">
              <OrgMark logoUrl={ws.settings.logoUrl} />
              <span className="truncate text-[14.5px] font-semibold tracking-tight">{ws.settings.organizationName}</span>
              <ChevronRight className="h-3 w-3 shrink-0 rotate-90 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel className="flex items-center gap-2 py-2 font-normal">
              <PersonAvatar person={me} size={24} />
              <span className="min-w-0">
                <span className="block truncate text-[14px] font-medium">{ws.me.name}</span>
                <span className="block truncate text-sm text-muted-foreground">{ws.me.email} · {ws.me.role}</span>
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="text-[14px]">
              <NavLink to="/settings" onClick={onNavigate}><Settings className="h-3.5 w-3.5" /> Settings</NavLink>
            </DropdownMenuItem>
            {ws.isAdmin && (
              <DropdownMenuItem className="text-[14px]" onSelect={() => app.openInvite()}>
                <UserPlus className="h-3.5 w-3.5" /> Add or invite people
              </DropdownMenuItem>
            )}
            {ws.settings.learnUrl && (
              <DropdownMenuItem asChild className="text-[14px]">
                <a href={ws.settings.learnUrl} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" /> Open {ws.settings.academyName}</a>
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-[14px]" onSelect={toggle}>
              {resolved === 'dark' ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />} {resolved === 'dark' ? 'Light theme' : 'Dark theme'}
            </DropdownMenuItem>
            <DropdownMenuItem className="text-[14px]" onSelect={() => setPref('system')}>
              <Laptop className="h-3.5 w-3.5" /> Match system theme
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="text-[14px]">
                <Languages className="h-3.5 w-3.5" /> {t('menu.language')}
                <span className="ml-auto text-sm text-muted-foreground">{LOCALES.find(l => l.value === locale)?.short}</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {LOCALES.map(l => (
                  <DropdownMenuItem key={l.value} className="text-[14px]" onSelect={() => setLocale(l.value)}>
                    {l.label}
                    {locale === l.value && <Check className="ml-auto h-3.5 w-3.5" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem className="text-[14px]" onSelect={() => app.openShortcuts()}>
              <Keyboard className="h-3.5 w-3.5" /> {t('menu.shortcuts')} <span className="ml-auto"><Kbd>?</Kbd></span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Tip label="Search" keys={[MOD, 'K']}>
          <button type="button" onClick={() => app.openPalette()} aria-label="Search" className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground">
            <Search className="h-4 w-4" />
          </button>
        </Tip>
        <DropdownMenu open={createOpen} onOpenChange={setCreateOpen}>
          <Tip label="Create" keys={['C']}>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="Create" className="flex h-7 w-7 items-center justify-center rounded-md border bg-background text-foreground shadow-2xs hover:bg-accent">
                <Plus className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem className="text-[14px]" onSelect={() => app.openEnroll(app.contextCourseId ? { targetType: 'Course', targetId: app.contextCourseId } : undefined)}>
              <GraduationCap className="h-3.5 w-3.5" /> Enroll people <span className="ml-auto text-2xs text-muted-foreground">⇧E</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-[14px]" onSelect={() => app.openCreateCourse()}>
              <BookOpen className="h-3.5 w-3.5" /> New course
            </DropdownMenuItem>
            <DropdownMenuItem className="text-[14px]" onSelect={() => app.openCreatePath()}>
              <Route className="h-3.5 w-3.5" /> New learning path
            </DropdownMenuItem>
            <DropdownMenuItem className="text-[14px]" onSelect={() => app.openCreateSession(app.contextCourseId ?? undefined)}>
              <CalendarClock className="h-3.5 w-3.5" /> Schedule a live session
            </DropdownMenuItem>
            {ws.isAdmin && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-[14px]" onSelect={() => app.openInvite()}>
                  <UserPlus className="h-3.5 w-3.5" /> Add or invite people
                </DropdownMenuItem>
                <DropdownMenuItem asChild className="text-[14px]">
                  <NavLink to="/assignments?new=1" onClick={onNavigate}><Workflow className="h-3.5 w-3.5" /> New assignment rule</NavLink>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <nav className="min-h-0 flex-1 space-y-px overflow-y-auto px-2 pb-4" aria-label="Main">
        <Item to="/home" icon={<Home />} label={t('nav.home')} onNavigate={onNavigate} />
        <Item to="/inbox" icon={<Inbox />} label={t('nav.inbox')} count={ws.counts.inboxUnread} onNavigate={onNavigate} />
        <Item to="/grading" icon={<ClipboardCheck />} label={t('nav.grading')} count={ws.counts.toGrade} accent={ws.counts.toGrade > 0} onNavigate={onNavigate} />
        <Item to="/discussions" icon={<MessagesSquare />} label={t('nav.discussions')} count={ws.counts.openQuestions} onNavigate={onNavigate} />

        <div className="pt-4">
          <SectionHeader label={t('nav.workspace')} open={workspaceOpen} onToggle={toggleWorkspace} />
          {workspaceOpen && (
            <div className="space-y-px">
              <Item to="/courses" icon={<BookOpen />} label={t('nav.courses')} onNavigate={onNavigate} />
              <Item to="/paths" icon={<Route />} label={t('nav.paths')} onNavigate={onNavigate} />
              {/* Sidebar counts mean "needs you" (inbox, grading, questions); upcoming sessions are not a to-do. */}
              <Item to="/sessions" icon={<CalendarClock />} label={t('nav.sessions')} onNavigate={onNavigate} />
              <Item to="/people" icon={<Users />} label={t('nav.people')} onNavigate={onNavigate} />
              <Item to="/groups" icon={<UsersRound />} label={t('nav.groups')} onNavigate={onNavigate} />
              <Item to="/enrollments" icon={<Layers />} label={t('nav.enrollments')} onNavigate={onNavigate} />
              <Item to="/assignments" icon={<Workflow />} label={t('nav.assignments')} onNavigate={onNavigate} />
              <Item to="/certificates" icon={<Award />} label={t('nav.certificates')} onNavigate={onNavigate} />
              <Item to="/reports" icon={<BarChart3 />} label={t('nav.reports')} onNavigate={onNavigate} />
            </div>
          )}
        </div>

        {ws.views.length > 0 && (
          <div className="pt-4">
            <SectionHeader label={t('nav.views')} open={viewsOpen} onToggle={toggleViews} />
            {viewsOpen && (
              <div className="space-y-px">
                {ws.views.map(v => (
                  <Item key={v.id} to={`/view/${v.id}`} icon={<span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/60" />} label={v.name} onNavigate={onNavigate} />
                ))}
              </div>
            )}
          </div>
        )}

        {recent.length > 0 && (
          <div className="pt-4">
            <SectionHeader label={t('nav.recentCourses')} open={recentOpen} onToggle={toggleRecent} />
            {recentOpen && (
              <div className="space-y-px">
                {recent.map(id => (
                  <CourseBlock key={id} courseId={id} onNavigate={onNavigate} />
                ))}
              </div>
            )}
          </div>
        )}
      </nav>

      <div className="shrink-0 space-y-px border-t border-sidebar-border px-2 py-2">
        {ws.settings.learnUrl && (
          <a href={ws.settings.learnUrl} target="_blank" rel="noreferrer" className="flex h-8 items-center gap-2 rounded-md px-2 text-[14px] text-sidebar-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground">
            <ExternalLink className="h-[15px] w-[15px]" /> <span className="truncate">Open {ws.settings.academyName}</span>
          </a>
        )}
        <NavLink to="/settings/profile" onClick={onNavigate} className="flex h-9 items-center gap-2 rounded-md px-2 text-[14px] text-sidebar-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-accent-foreground">
          <PersonAvatar person={me} size={20} />
          <span className="truncate">{ws.me.name}</span>
          <span className="ml-auto text-sm text-muted-foreground">{ws.me.role}</span>
        </NavLink>
      </div>
    </div>
  );
}
