// 재귀 depth cap (⑩ · 2026-07-20) — "액자 In 액자"(elanous→자식 elanous→손자…) 무한재귀/fork-bomb 방지.
//
// [[PLAN-unified-autonomous-agent-substrate-2026-07-20]] §6a. injector=self(elanous 이 자식 elanous 을
// spawn)이고 자식도 SelfImplement/delegate 툴을 갖기에, 깊이 상한으로 폭주만 끊는다(중첩 자체는 허용 —
// 하위 위임 체인이 미션 자율해결의 능력). ACP self-build 노출(#4764)로 재귀 표면이 커져 중요도↑.
//
// 메커니즘: 부모가 `ELANOUS_NEST_DEPTH` 를 자식 env 에 실어(childNestEnv) 자식은 depth+1 로 인지.
// depth >= maxNestDepth 면 spawn 툴을 카탈로그에서 제외 + dispatch 거부(defense-in-depth).
// 상한 = config `substrate.maxNestDepth`(config-first) → env `ELANOUS_MAX_NEST_DEPTH` → 기본 5(액자 5중·
// 2026-07-21 대표 상향: 조율자→executor→하위 위임 체인에 헤드룸. config 로 재조정 가능).
// ④ runGoalLoop.maxIterations(턴 내 루프)와 직교 — 이건 프로세스 중첩(spawn) 상한.

import { logDiagnostic } from '../mss/logging/diagnostic-sink.js';
import { originObservationFields } from './origin-observation.js';

let bootObserved = false;

/** 현재 프로세스의 중첩 깊이(부모가 env 로 주입·최상위=0). */
export function getNestDepth(): number {
  const raw = process.env.ELANOUS_NEST_DEPTH;
  const n = raw !== undefined ? Number(raw) : 0;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** 중첩 상한. config-first(substrate.maxNestDepth) → env(ELANOUS_MAX_NEST_DEPTH) → 기본 5. */
export function getMaxNestDepth(): number {
  try {
    const mod = require('../user-config.js') as typeof import('../user-config.js');
    const raw = (mod.getUserConfig() as { substrate?: { maxNestDepth?: number } }).substrate?.maxNestDepth;
    if (typeof raw === 'number' && raw >= 0) return Math.floor(raw);
  } catch { /* config 미가용 — env/기본으로 */ }
  const envRaw = process.env.ELANOUS_MAX_NEST_DEPTH;
  if (envRaw !== undefined) {
    const n = Number(envRaw);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return 5;
}

/** 이 깊이에서 자식을 더 spawn 하면 상한 초과인가(= spawn 툴 비활성 대상). */
export function nestCapReached(): boolean {
  return getNestDepth() >= getMaxNestDepth();
}

/** 자식 프로세스 env 에 실을 depth 증가분. 부모 spawn 시 `{ ...env, ...childNestEnv() }`. */
export function childNestEnv(): Record<string, string> {
  return { ELANOUS_NEST_DEPTH: String(getNestDepth() + 1) };
}

/** 관측/로그용 스냅샷. */
export function nestInfo(): { depth: number; max: number; capReached: boolean } {
  const depth = getNestDepth();
  const max = getMaxNestDepth();
  return { depth, max, capReached: depth >= max };
}

/** 프로세스 부팅 시 중첩 깊이를 한 번만 관측한다. */
export function observeNestAtBoot(): void {
  if (bootObserved) return;
  bootObserved = true;
  try { logDiagnostic('substrate.nest', 'boot', { ...nestInfo(), ...originObservationFields() }); } catch { /* fail-soft */ }
}

/** 테스트에서 프로세스 단발 관측 상태를 격리한다. */
export function resetNestBootObservationForTest(): void {
  bootObserved = false;
}
