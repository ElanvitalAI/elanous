'use client';

// 2026-09-26 대표 결정으로 되살림 · RFC-pwa-intake-front-door
// 1.2초 리다이렉트를 지우고 칸 하나 ⊕ 세 버튼(흡수 · 작업 분할 · 그래프)을 그린다.

import { IntakeApprovalsBanner } from '@/components/approvals/IntakeApprovalsBanner';
import { IntakeFrontDoor } from '@/components/intake/IntakeFrontDoor';

export default function IntakePage() {
  return <>
    <IntakeApprovalsBanner />
    <IntakeFrontDoor />
  </>;
}
