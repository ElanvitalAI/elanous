'use client';

// ── Mission Fabric 단계 헤더 (일관성 F3 · 2026-07-09) ─────────────────────
//
// autopilot·tasks·scheduler 3 표면이 "한 파이프라인의 단계"임을 눈에 보이게 하는
// 공유 브레드크럼. 각 단계는 링크 → 표면 간 이동 + 현재 단계 강조.
//   ① Autopilot 미션(포착) → ② Tasks 실행 → ③ Scheduler 트리거
// narrow-waist V3(2026-07-09): 구 "Intake 포착" 단계 제거 — 포착은 장소가 아니라
// "말하면 미션이 된다"(Autopilot 골던지기 컴포저 + 텔레그램 "미션:" 마커)로 흡수.
// 설계: 내부 문서 `DESIGN-intent-narrow-waist-2026-07-09` §3.

import Link from 'next/link';

/** 파이프라인 단계 표(순서 = 데이터 흐름). 테스트가 이 표 shape 를 검증(Next 훅 의존 0). */
export const FABRIC_STAGES = [
  { key: 'autopilot', href: '/autopilot', num: '①', label: '미션', sub: 'Autopilot' },
  { key: 'tasks', href: '/tasks', num: '②', label: '작업', sub: 'Tasks' },
  { key: 'scheduler', href: '/scheduler', num: '③', label: '스케줄', sub: 'Schedules' },
] as const;
const STAGES = FABRIC_STAGES;

export type FabricStage = (typeof STAGES)[number]['key'];

/** 3 표면 상단 공유 헤더 — Mission Fabric 파이프라인 위치 + 인접 단계 크로스링크. */
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
