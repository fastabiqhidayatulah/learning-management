import { Menu, Search } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@project/components/ui/alert-dialog';
import { Sheet, SheetContent, SheetTitle } from '@project/components/ui/sheet';
import { cn } from '@project/components/lib/utils';
import { LocaleProvider, isLocale } from '@project/shared/i18n';
import { AppActionsContext, type AppActions, type ConfirmOptions, type EnrollIntent } from '../../lib/app-actions';
import { useHotkeys } from '../../lib/hotkeys';
import { useTheme } from '../../lib/theme';
import { useWorkspace } from '../../lib/workspace';
import { EnrollDialog } from '../dialogs/EnrollDialog';
import { EnrollmentPeek } from '../enrollments/EnrollmentPeek';
import { IconButton } from '../primitives/bits';
import { CommandPalette } from './CommandPalette';
import { guardedNavigate } from '../../lib/navGuard';
import { GO_KEYS, ShortcutsDialog } from './ShortcutsDialog';
import { Sidebar } from './Sidebar';

// Create dialogs belong to their feature areas and load on first use.
const CreateCourseDialog = lazy(() => import('../courses/CreateCourseDialog').then(m => ({ default: m.CreateCourseDialog })));
const CreatePathDialog = lazy(() => import('../paths/CreatePathDialog').then(m => ({ default: m.CreatePathDialog })));
const InviteDialog = lazy(() => import('../people/InviteDialog').then(m => ({ default: m.InviteDialog })));
const SessionDialog = lazy(() => import('../sessions/SessionDialog').then(m => ({ default: m.SessionDialog })));

function ConfirmDialog({ state, onResolve, returnFocus }: { state: (ConfirmOptions & { open: boolean }) | null; onResolve: (ok: boolean) => void; returnFocus: { current: HTMLElement | null } }) {
  return (
    <AlertDialog open={Boolean(state?.open)} onOpenChange={o => !o && onResolve(false)}>
      <AlertDialogContent
        onCloseAutoFocus={e => {
          const el = returnFocus.current;
          if (el && document.contains(el)) {
            e.preventDefault();
            el.focus();
          }
        }}
        className="max-w-md"
        onKeyDown={e => {
          // ⌘↵ confirms, like every other dialog in the app.
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            onResolve(true);
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle className="text-[16px]">{state?.title}</AlertDialogTitle>
          {state?.description && <AlertDialogDescription className="text-[14px]">{state.description}</AlertDialogDescription>}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="h-9 text-[14px]" onClick={() => onResolve(false)}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction autoFocus className={cn('h-9 text-[14px]', state?.destructive && 'bg-destructive text-destructive-foreground hover:bg-destructive/90')} onClick={() => onResolve(true)}>
            {state?.confirmLabel ?? 'Confirm'}
            <kbd className="ml-1.5 hidden rounded border border-current/25 px-1 text-[11.5px] font-normal opacity-70 sm:inline">⌘↵</kbd>
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function AppShell() {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const location = useLocation();
  const { toggle: toggleTheme } = useTheme();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [enrollmentId, setEnrollmentId] = useState<string | null>(null);
  const [enroll, setEnroll] = useState<{ open: boolean; intent?: EnrollIntent }>({ open: false });
  const [dialog, setDialog] = useState<null | 'course' | 'path' | 'invite' | 'session'>(null);
  const [sessionCourseId, setSessionCourseId] = useState<string | undefined>();
  const [contextCourseId, setContextCourse] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<(ConfirmOptions & { open: boolean }) | null>(null);
  const confirmResolver = useRef<((ok: boolean) => void) | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('lms:sidebar:collapsed') === '1';
    } catch {
      return false;
    }
  });
  const pendingG = useRef<number | null>(null);

  useEffect(() => {
    setMobileNav(false);
    setEnrollmentId(null);
  }, [location.pathname]);

  // Where focus was when a confirm opened, so closing it puts keyboard users back in place.
  const confirmReturnFocus = useRef<HTMLElement | null>(null);
  const confirm = useCallback((options: ConfirmOptions) => {
    return new Promise<boolean>(resolve => {
      confirmResolver.current = resolve;
      confirmReturnFocus.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
      setConfirmState({ ...options, open: true });
    });
  }, []);
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;

  const actions = useMemo<AppActions>(
    () => ({
      openPalette: q => {
        setPaletteQuery(q ?? '');
        setPaletteOpen(true);
      },
      openShortcuts: () => setShortcutsOpen(true),
      confirm,
      openEnrollment: id => setEnrollmentId(id),
      closeEnrollment: () => setEnrollmentId(null),
      enrollmentId,
      openEnroll: intent => setEnroll({ open: true, intent }),
      openCreateCourse: () => setDialog('course'),
      openCreatePath: () => setDialog('path'),
      openInvite: () => setDialog('invite'),
      openCreateSession: courseId => {
        setSessionCourseId(courseId);
        setDialog('session');
      },
      setContextCourse,
      contextCourseId,
    }),
    [confirm, enrollmentId, contextCourseId],
  );

  const toggleSidebar = () =>
    setCollapsed(c => {
      try {
        localStorage.setItem('lms:sidebar:collapsed', c ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !c;
    });

  useHotkeys({ 'mod+k': () => setPaletteOpen(o => !o) }, { allowInOverlay: true, allowInInputs: ['mod+k'] });
  useHotkeys({
    c: () => (collapsed || window.innerWidth < 768 ? setPaletteOpen(true) : window.dispatchEvent(new Event('lms:create'))),
    'shift+e': () => setEnroll({ open: true, intent: contextCourseId ? { targetType: 'Course', targetId: contextCourseId } : undefined }),
    '?': () => setShortcutsOpen(true),
    '[': toggleSidebar,
    'mod+shift+l': toggleTheme,
    g: () => {
      if (pendingG.current) window.clearTimeout(pendingG.current);
      pendingG.current = window.setTimeout(() => (pendingG.current = null), 1200);
    },
  });

  // "G then X" navigation, in the capture phase so list shortcuts don't claim the second key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!pendingG.current || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return;
      const key = e.key.toLowerCase();
      if (key === 'g') return;
      window.clearTimeout(pendingG.current);
      pendingG.current = null;
      const to = GO_KEYS.find(k => k.key === key)?.to;
      if (to) {
        e.preventDefault();
        e.stopImmediatePropagation();
        guardedNavigate(navigate, confirmRef.current, to);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [navigate]);

  const closeDialog = (o: boolean) => !o && setDialog(null);

  return (
    <LocaleProvider locale={isLocale(ws.settings.defaultLocale) ? ws.settings.defaultLocale : undefined}>
    <AppActionsContext.Provider value={actions}>
      <div className="flex h-[100dvh] overflow-hidden bg-canvas">
        <aside className={cn('hidden shrink-0 overflow-hidden transition-[width] duration-200 md:block', collapsed ? 'w-0' : 'w-[240px]')}>
          <div className="h-full w-[240px]">
            <Sidebar />
          </div>
        </aside>

        <div className={cn('flex min-w-0 flex-1 flex-col md:py-2 md:pr-2', collapsed && 'md:pl-2')}>
          <div className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3 md:hidden">
            <Sheet open={mobileNav} onOpenChange={setMobileNav}>
              <IconButton onClick={() => setMobileNav(true)} aria-label="Open navigation">
                <Menu />
              </IconButton>
              <SheetContent side="left" className="w-[280px] bg-sidebar p-0 [&>button:first-child]:hidden">
                <SheetTitle className="sr-only">Navigation</SheetTitle>
                <Sidebar onNavigate={() => setMobileNav(false)} />
              </SheetContent>
            </Sheet>
            <img src="/favicon.svg" alt="" className="h-5 w-5 rounded" />
            <span className="truncate text-[14.5px] font-semibold">{ws.settings.organizationName}</span>
            <IconButton className="ml-auto" onClick={() => setPaletteOpen(true)} aria-label="Search">
              <Search />
            </IconButton>
          </div>
          <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background md:rounded-lg md:border md:shadow-xs">
            <Outlet context={{ toggleSidebar, sidebarCollapsed: collapsed }} />
          </main>
        </div>

        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} initialQuery={paletteQuery} />
        <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
        <EnrollmentPeek id={enrollmentId} onClose={() => setEnrollmentId(null)} />
        <EnrollDialog open={enroll.open} onOpenChange={o => setEnroll(s => ({ ...s, open: o }))} intent={enroll.intent} />
        <Suspense fallback={null}>
          {dialog === 'course' && <CreateCourseDialog open onOpenChange={closeDialog} />}
          {dialog === 'path' && <CreatePathDialog open onOpenChange={closeDialog} />}
          {dialog === 'invite' && <InviteDialog open onOpenChange={closeDialog} />}
          {dialog === 'session' && <SessionDialog open onOpenChange={closeDialog} courseId={sessionCourseId} />}
        </Suspense>
        <ConfirmDialog
          state={confirmState}
          returnFocus={confirmReturnFocus}
          onResolve={ok => {
            confirmResolver.current?.(ok);
            confirmResolver.current = null;
            setConfirmState(s => (s ? { ...s, open: false } : s));
          }}
        />
      </div>
    </AppActionsContext.Provider>
    </LocaleProvider>
  );
}
