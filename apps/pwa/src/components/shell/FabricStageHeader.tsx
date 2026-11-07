'use client';

// ── Mission Fabric 단계 헤더 (일관성 F3 · 2026-07-09) ─────────────────────
//
// 작업 실행과 스케줄 트리거를 잇는 간단한 브레드크럼.

import Link from 'next/link';

/** 파이프라인 단계 표(순서 = 데이터 흐름). 테스트가 이 표 shape 를 검증(Next 훅 의존 0). */
export const FABRIC_STAGES = [
  { key: 'tasks', href: '/tasks', num: '①', label: '작업', sub: 'Tasks' },
  { key: 'scheduler', href: '/scheduler', num: '②', label: '스케줄', sub: 'Schedules' },
] as const;
const STAGES = FABRIC_STAGES;

export type FabricStage = (typeof STAGES)[number]['key'];

/** 작업·스케줄 간 이동 헤더. */
export function FabricStageHeader({ active }: { active: FabricStage }) {
  return (
    <nav
      aria-label="Mission Fabric 파이프라인"
      data-testid="fabric-stage-header"
      className="flex flex-wrap items-center gap-1 text-xs"
    >
      <span className="mr-1 text-muted-foreground">Missions</span>
      {STAGES.map((s, i) => (
        <span key={s.key} className="flex items-center gap-1">
          <Link
            href={s.href}
            aria-current={s.key === active ? 'page' : undefined}
            className={[
              'rounded px-2 py-1 ring-1 transition-colors',
              s.key === active
                ? 'bg-primary/15 font-medium text-foreground ring-primary/40'
                : 'text-muted-foreground ring-border hover:bg-muted hover:text-foreground',
            ].join(' ')}
          >
            <span className="mr-1">{s.num}</span>{s.label}
            <span className="ml-1 text-[10px] opacity-70">{s.sub}</span>
          </Link>
          {i < STAGES.length - 1 && <span className="text-muted-foreground/50" aria-hidden>→</span>}
        </span>
      ))}
    </nav>
  );
}
