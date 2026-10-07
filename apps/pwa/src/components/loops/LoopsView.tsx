'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { FabricStageHeader } from '@/components/shell/FabricStageHeader';
import { LoopAgentsScene } from '@/components/inside/LoopAgentsScene';
import { LoopStatusPanel } from './LoopStatusPanel';
import { loopsView } from './loops-view';

/** 루프 상호작용 — /inside 장면③ 지도를 그대로 쓴다(로직 복제 0). `?journey=<카드 id>` 는 지도가 직접 읽는다. */
export function LoopInteractPanel() {
  return <main className="mx-auto min-w-0 max-w-[1400px] space-y-4 p-4">
    <FabricStageHeader active="scheduler" />
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><div className="flex items-center gap-2"><h1 className="text-xl font-semibold">루프 상호작용</h1><span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">beta · 운영용</span></div>
        <p className="mt-1 text-sm text-muted-foreground">자리·루프·런 사이에 오간 실제 사건 · 새 사건이 들어오면 다시 읽습니다</p></div>
      <Link href="/loops" className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-accent">루프 현황 →</Link>
    </header>
    <div className="min-w-0 rounded-2xl bg-[#0c1828] text-[#f1f5fa]"><LoopAgentsScene initialMode="map" /></div>
  </main>;
}

export function LoopsView() {
  const searchParams = useSearchParams();
  return loopsView(searchParams) === 'interact' ? <LoopInteractPanel /> : <LoopStatusPanel />;
}
