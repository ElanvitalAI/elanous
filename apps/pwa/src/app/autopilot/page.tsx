// Autopilot surface (Phase B2 · 2026-07-09) — intake 를 Autopilot 으로 대개편.
// 골 → tier 분류 → 실행모델 라우팅 → 실행 → 증거 → 회상. Missions/자율행동 2 서브탭.
// 백엔드 /v1/autopilot/* (triage-preview·autonomy·arming) ⊕ /v1/missions.

'use client';

import { AutopilotPanel } from '@/components/autopilot/AutopilotPanel';

export default function AutopilotPage(): React.ReactNode {
  return <AutopilotPanel />;
}
