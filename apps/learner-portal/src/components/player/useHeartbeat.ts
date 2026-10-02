import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { trackLesson } from 'zitejs/api';
import { playerKeys, type Player } from './queries';

const BEAT_MS = 30_000;
const MAX_SECONDS = 120;

/**
 * Time on a lesson, counted only while the tab is visible and sent every 30
 * seconds, when the tab is hidden, and when the learner moves on. Opening a
 * lesson also tells the server where they are, so "resume" lands here.
 */
export function useHeartbeat(slug: string, lessonId: string | undefined, enabled: boolean) {
  const qc = useQueryClient();

  useEffect(() => {
    // The demo's database is read-only and refuses the whole request on any write.
    if (!enabled || !lessonId || (window as { __ziteDemo?: unknown }).__ziteDemo) return;
    let pending = 0;
    let last = Date.now();
    let visible = document.visibilityState === 'visible';

    const tick = () => {
      const now = Date.now();
      if (visible) pending += (now - last) / 1000;
      last = now;
    };
    const send = () => {
      tick();
      const seconds = Math.min(MAX_SECONDS, Math.floor(pending));
      if (seconds < 1) return;
      pending -= seconds;
      trackLesson({ lessonId, courseSlug: slug, seconds }).catch(() => undefined);
    };

    // Arrival: mark the lesson started and reflect that in the outline without a refetch.
    trackLesson({ lessonId, courseSlug: slug, seconds: 0 })
      .then(res => {
        let startedCourse = res.startedCourse;
        qc.setQueryData<Player>(playerKeys.player(slug), prev => {
          if (!prev?.enrollment) return prev;
          const lessons = prev.lessons.map(l => (l.id === lessonId && l.state === 'available' ? { ...l, state: 'in_progress' as const } : l));
          if (prev.enrollment.status === 'Not started') startedCourse = true;
          return { ...prev, lessons, enrollment: { ...prev.enrollment, currentLessonId: lessonId, status: prev.enrollment.status === 'Not started' ? 'In progress' : prev.enrollment.status } };
        });
        if (startedCourse) for (const root of ['me', 'home', 'learning', 'course', 'path']) void qc.invalidateQueries({ queryKey: [root] });
      })
      .catch(() => undefined);

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') send();
      else tick();
    }, BEAT_MS);
    const onVisibility = () => {
      tick();
      visible = document.visibilityState === 'visible';
      if (!visible) send();
    };
    const onHide = () => send();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', onHide);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onHide);
      send();
    };
  }, [slug, lessonId, enabled, qc]);
}
