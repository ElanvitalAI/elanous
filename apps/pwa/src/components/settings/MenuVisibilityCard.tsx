'use client';

// 메뉴 노출 카드(2026-09-28 탭 다이어트) — 공개 탭만 기본으로 보이고,
// Labs(베타)와 숨긴 탭은 이 기기에서만 켤 수 있다. 숨긴 탭도 주소로는 열린다.
// 판단 근거·목록: 내부 문서 `ROADMAP-pwa-tab-triage-and-launch-2026-09-28`

import { useEffect, useState } from 'react';
import { NAV_SHOW_HIDDEN_KEY, NAV_SHOW_LABS_KEY, SIDEBAR_NAV_ITEMS } from '@/components/shell/sidebar-nav-items';
import { readFlag, writeFlag } from '@/components/shell/nav-visibility-prefs';

export interface MenuVisibilityCardProps {
  /** 시험용 — 없으면 localStorage. */
  read?: (key: string) => boolean;
  write?: (key: string, on: boolean) => void;
}

export function MenuVisibilityCard({ read = readFlag, write = writeFlag }: MenuVisibilityCardProps = {}) {
  const [showLabs, setShowLabs] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  useEffect(() => {
    setShowLabs(read(NAV_SHOW_LABS_KEY));
    setShowHidden(read(NAV_SHOW_HIDDEN_KEY));
  }, [read]);
  const names = (level: 'labs' | 'hidden') =>
    SIDEBAR_NAV_ITEMS.filter((item) => item.visibility === level).map((item) => item.label).join(' · ');
  const toggle = (key: string, on: boolean, set: (v: boolean) => void) => { set(on); write(key, on); };
  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-4" aria-label="메뉴">
      <h2 className="text-base font-semibold">메뉴</h2>
      <p className="text-xs text-muted-foreground">
        메뉴에는 주요 탭만 보입니다. Labs(베타)와 숨긴 탭은 이 기기에서만 켤 수 있고, 숨긴 탭도 주소로는 열립니다.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          data-elanous-action="menu-show-labs"
          checked={showLabs}
          onChange={(e) => toggle(NAV_SHOW_LABS_KEY, e.target.checked, setShowLabs)}
        />
        <span>Labs 탭 보기 <span className="text-xs text-muted-foreground">({names('labs')})</span></span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          data-elanous-action="menu-show-hidden"
          checked={showHidden}
          onChange={(e) => toggle(NAV_SHOW_HIDDEN_KEY, e.target.checked, setShowHidden)}
        />
        <span>숨긴 탭 보기 <span className="text-xs text-muted-foreground">({names('hidden')})</span></span>
      </label>
    </section>
  );
}
