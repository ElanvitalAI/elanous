'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { debugLog } from '@/lib/debug';
import { SIDEBAR_NAV_ITEMS } from './sidebar-nav-items';
import { visitRecord, type VisitState } from './nav-visit';

/** AppShell 에 한 번 — 탭이 바뀔 때 `pwa.nav.visit`, 창을 숨길 때 `pwa.nav.leave`(머문 시간). */
export function useNavVisitLog(): void {
  const pathname = usePathname();
  const state = useRef<VisitState | null>(null);
  useEffect(() => {
    const out = visitRecord(state.current, pathname ?? '/', Date.now(), SIDEBAR_NAV_ITEMS);
    if (!out) return;
    state.current = out.next;
    debugLog('pwa.nav.visit', out.record);
  }, [pathname]);
  useEffect(() => {
    const onHide = () => {
      const cur = state.current;
      if (document.visibilityState !== 'hidden' || !cur) return;
      debugLog('pwa.nav.leave', { tab: cur.tab, dwellMs: Math.max(0, Date.now() - cur.at) });
      // 돌아오면 머문 시간을 다시 센다(숨긴 동안은 «머묾»이 아니다).
      state.current = { tab: cur.tab, at: Number.POSITIVE_INFINITY };
    };
    const onShow = () => {
      if (document.visibilityState === 'visible' && state.current && !Number.isFinite(state.current.at)) state.current = { tab: state.current.tab, at: Date.now() };
    };
    document.addEventListener('visibilitychange', onHide);
    document.addEventListener('visibilitychange', onShow);
    return () => { document.removeEventListener('visibilitychange', onHide); document.removeEventListener('visibilitychange', onShow); };
  }, []);
}
