// 탭 «방문» 계측(트리아지 P1 · 🅕 2026-09-28) — 「이 탭이 의미 있나」를 수로 답한다.
// 경로를 메뉴 항목(탭)으로 접어 `pwa.nav.visit` 한 줄을 낸다: 들어온 탭 ⊕ 직전 탭에 머문 시간.
// ⛔ 전체 경로·쿼리는 싣지 않는다(노트 이름·세션 id 가 섞인다) — 탭 href 와 노출 등급만.
// 조회: `elanous logs --category pwa.nav.visit` · 떠날 때(탭 숨김) = `pwa.nav.leave`.

import type { NavVisibility, SidebarNavItem } from './sidebar-nav-items';

export interface NavTab {
  /** 메뉴 항목 href — 메뉴에 없는 경로면 `other`. */
  tab: string;
  visibility: NavVisibility | 'other';
}

/** 경로 → 탭. 가장 긴 접두 일치(`/` 는 정확히 `/` 만). basePath·끝 슬래시는 호출자가 떼고 준다. */
export function tabForPath(path: string, items: readonly Pick<SidebarNavItem, 'href' | 'visibility'>[]): NavTab {
  const p = (path.split(/[?#]/)[0] ?? '/').replace(/\/+$/, '') || '/';
  let best: Pick<SidebarNavItem, 'href' | 'visibility'> | null = null;
  for (const item of items) {
    const href = item.href.split('?')[0]!.replace(/\/+$/, '') || '/';
    const hit = href === '/' ? p === '/' : p === href || p.startsWith(`${href}/`);
    if (hit && (!best || href.length > best.href.length)) best = { ...item, href };
  }
  return best ? { tab: best.href, visibility: best.visibility ?? 'public' } : { tab: 'other', visibility: 'other' };
}

export interface VisitState { tab: string; at: number }

/** 새 경로에 들어왔을 때의 기록 — 같은 탭 안 이동(하위 경로)은 방문이 아니다(null). */
export function visitRecord(
  prev: VisitState | null,
  path: string,
  now: number,
  items: readonly Pick<SidebarNavItem, 'href' | 'visibility'>[],
): { record: { tab: string; visibility: string; from: string | null; dwellMs: number | null }; next: VisitState } | null {
  const t = tabForPath(path, items);
  if (prev && prev.tab === t.tab) return null;
  return {
    record: { tab: t.tab, visibility: t.visibility, from: prev?.tab ?? null, dwellMs: prev ? Math.max(0, now - prev.at) : null },
    next: { tab: t.tab, at: now },
  };
}
