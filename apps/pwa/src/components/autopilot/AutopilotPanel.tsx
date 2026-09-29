'use client';

// ── Autopilot 섹션 (Phase B2 · 겹침 해소 F2 · 2026-07-09) ──────────────────
//
// Mission Fabric 통합: Autopilot = 미션 지휘 센터(PFC Layer2). "골 던지기(즉시
// 자율 미션화)"는 Missions 탭 인라인 컴포저로 흡수 — 구 최상위 "Triage" 탭 제거
// (intake 와 "두 개의 문" 겹침 해소). 포착의 리뷰 우선 경로는 Intake 가 담당.
//   Missions    모든 미션(사람 intake + 자율)의 계보·상태 + 인라인 골 던지기
//   Repo Watch  참조 에이전트 repo 흡수 후보(hermes/openclaw/codex)
//   자율행동    자율루프가 무엇을 왜 했나(surface_events domain=elanous)
//   루프 오케스트라  5 자율루프 순환 그래프(기존 LoopsPanel 결합)

import { useEffect, useMemo, useState } from 'react';
import { useDaemon } from '@/components/providers/DaemonProvider';
import { LoopsPanel } from '@/components/loops/LoopsPanel';
import { AutopilotRepoWatch } from './AutopilotRepoWatch';
import { AutopilotAutonomyLog } from './AutopilotAutonomyLog';
import { AutopilotMissions } from './AutopilotMissions';
import { FabricStageHeader } from '@/components/shell/FabricStageHeader';
import { AutopilotApi, type ArmingStatus } from '@/lib/autopilot-api';

const TABS = [
  { id: 'missions', label: 'Missions' },
  { id: 'repo', label: 'Repo Watch' },
  { id: 'autonomy', label: '자율행동' },
  { id: 'loops', label: '루프 오케스트라' },
] as const;
type TabId = (typeof TABS)[number]['id'];

function ArmingBanner({ arming }: { arming: ArmingStatus | null }) {
  if (!arming) return null;
  const chip = (on: boolean, label: string) => (
    <span className={['rounded px-2 py-0.5 text-xs ring-1',
      on ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/30' : 'bg-muted text-muted-foreground ring-border'].join(' ')}>
      {label} {on ? 'ON' : 'OFF'}
    </span>
  );
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>자율 경계:</span>
      {chip(arming.absorb, `흡수 PR초안(${arming.absorbBackend})`)}
      {chip(arming.merge, 'mandate merge')}
      {chip(arming.reboot, '재부팅')}
      {chip(arming.materialize ?? false, '자율 구체화')}
      <span className="text-[11px]">· 재부팅은 항상 HITL · 기본 disarmed(fail-closed)</span>
    </div>
  );
}

export function AutopilotPanel() {
  const { client } = useDaemon();
  const api = useMemo(() => new AutopilotApi(client), [client]);
  const [tab, setTab] = useState<TabId>('missions');
  const [arming, setArming] = useState<ArmingStatus | null>(null);

  useEffect(() => {
    let alive = true;
    void api.arming().then((r) => { if (alive) setArming(r.arming); }).catch(() => {});
    return () => { alive = false; };
  }, [api]);

  return (
    <div className="mx-auto max-w-[1400px] px-4 pt-4">
      <div className="mb-3">
        <FabricStageHeader active="autopilot" />
      </div>
      <div className="mb-3 space-y-2">
        <h1 className="text-lg font-semibold">Missions <span className="text-sm font-normal text-muted-foreground">미션 지휘 센터 · Autopilot</span></h1>
        <p className="text-sm text-muted-foreground">미션(사람 + 자율)의 계보·상태·자율행동. 아래 &ldquo;골 던지기&rdquo; 또는 텔레그램 &ldquo;미션:&rdquo; 마커로 소망을 던지면 미션이 됩니다.</p>
        <ArmingBanner arming={arming} />
      </div>
      <div className="flex gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={[
              '-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors',
              tab === t.id ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="py-4">
        {tab === 'missions' && <AutopilotMissions api={api} />}
        {tab === 'repo' && <AutopilotRepoWatch api={api} />}
        {tab === 'autonomy' && <AutopilotAutonomyLog api={api} />}
        {tab === 'loops' && <LoopsPanel />}
      </div>
    </div>
  );
}
