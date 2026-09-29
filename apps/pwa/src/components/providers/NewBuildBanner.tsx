'use client';

// 새 판 배너 — 데몬이 새 PWA 를 서빙하는데 이 탭은 옛 JS 로 돈다면 한 줄로 알리고 새로고침을 권한다.
// 확인 시점: 탭이 다시 보일 때 ⊕ 2분마다. 판정은 lib/new-build.ts(모르면 띄우지 않는다).

import { useEffect, useState } from 'react';
import { debugLog } from '@/lib/debug';
import { extractBuildId, isNewBuild } from '@/lib/new-build';

const CHECK_MS = 120_000;

function documentBuildId(): string | null {
  for (const script of Array.from(document.scripts)) {
    const id = script.textContent ? extractBuildId(script.textContent) : null;
    if (id) return id;
  }
  return null;
}

export function NewBuildBanner() {
  const [served, setServed] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    const mine = documentBuildId();
    setCurrent(mine);
    let stopped = false;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch('/app/', { cache: 'no-store' });
        if (!res.ok) return;
        const id = extractBuildId(await res.text());
        if (stopped) return;
        setServed(id);
        if (isNewBuild(mine, id)) debugLog('pwa.new-build.detected', { current: mine, served: id });
      } catch { /* 데몬이 잠깐 없을 수 있다 — 다음에 다시 본다 */ }
    };
    const timer = window.setInterval(() => { void check(); }, CHECK_MS);
    const onVisible = () => { void check(); };
    document.addEventListener('visibilitychange', onVisible);
    void check();
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  if (!isNewBuild(current, served)) return null;
  return (
    <div role="status" className="fixed inset-x-2 bottom-2 z-[60] mx-auto flex max-w-md items-center gap-3 rounded-md border border-primary/50 bg-background/95 px-3 py-2 text-sm shadow-lg" data-pwa-new-build>
      <span className="flex-1">새 판이 있습니다 — 이 화면은 이전 판으로 돌고 있어요.</span>
      <button type="button" onClick={() => { debugLog('pwa.new-build.reload', { current, served }); window.location.reload(); }} className="rounded-md bg-primary px-2 py-1 text-primary-foreground">
        새로고침
      </button>
    </div>
  );
}
