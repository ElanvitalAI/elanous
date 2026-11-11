// ── UX 에이전트 라이브 배선 opt-in 게이트 (P4 Phase 2·2026-07-19) ──────────────
// user-config(autopilot.uxAgent.enabled) 로 라이브 배선을 켠다. 기본 OFF → 기존 하드코딩
// HITL(buildHitlButtonRows·buildClarifyMessages) 100% 그대로(회귀 0). 켜면 UXIntent 경로로 전환.
// 순수·fail-soft(config 오류 시 OFF).

import { getUserConfig } from '../user-config/reader.js';

interface UxAgentConfig { enabled?: unknown; surface?: { telegram?: unknown } }

/** UX 에이전트 라이브 배선 활성 여부(기본 OFF·비파괴). */
export function canUseUxAgent(): boolean {
  try {
    const ap = getUserConfig().raw?.autopilot as { uxAgent?: UxAgentConfig } | undefined;
    return ap?.uxAgent?.enabled === true;
  } catch { return false; }
}

/** 특정 서피스에 UX 렌더 활성 여부(텔레그램 우선·멀티서피스 후순위). enabled 켜지면 telegram 기본 허용. */
export function canRenderUxOn(surface: 'telegram'): boolean {
  try {
    const ap = getUserConfig().raw?.autopilot as { uxAgent?: UxAgentConfig } | undefined;
    if (ap?.uxAgent?.enabled !== true) return false;
    const s = ap.uxAgent.surface?.[surface];
    return s === undefined ? surface === 'telegram' : s === true; // 미지정 시 telegram 기본 ON
  } catch { return false; }
}
