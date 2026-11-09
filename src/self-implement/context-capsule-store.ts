import { isStringArray } from '../primitives/guards.js';
// ── Context Capsule durable handoff store (F2 · 2026-07-25 · [[PLAN §11-4]]) ──────
//
// §11 PTY 코디네이션 플릿의 **컨텍스트 교환 척추**: 상류 잡(self-dev/agent PTY)이 자기 목표-완료
// capsule 을 job-id 키로 durable 스토어에 넣고, 하류 잡이 그걸 grounding(provenance='pty')으로 read 한다.
// **라이브 라우팅(F3/F4) 없이** capsule-at-handoff 로 컴포지션 — arbiter 무관(F2 는 arbiter-free).
//
// ⚠️ 재발명 0 — durable 저장은 공용 `agent-substrate/cold-ledger`(never-prune·config-dir 격리·fail-soft)
//    재사용. 이 모듈은 그 위에 capsule 전용 kind 네임스페이스 + **read 시 런타임 검증**(손상·구버전 데이터가
//    유효 capsule 로 반환되지 않게)을 얹는 얇은 어댑터(순수 계약 context-capsule.ts 의 IO 부담 분리).

import { writeColdSnapshot, readColdSnapshot, listColdSnapshotIds } from '../agent-substrate/cold-ledger.js';
import { buildHarnessContextCapsule, type HarnessContextCapsule } from './context-capsule.js';

/** cold-ledger archive 네임스페이스 — `<configDir>/archive/context-capsule/<jobId>/snapshot.json`. 모듈 내부용. */
const CONTEXT_CAPSULE_KIND = 'context-capsule';

/**
 * 상류 잡이 자기 capsule 을 durable 스토어에 넣는다(job-id 키). cold-ledger 위임(never-prune·fail-soft —
 * 보관 실패가 상위 잡을 막지 않음). 같은 jobId 재저장은 덮어씀(최신 capsule).
 */
export function persistContextCapsule(jobId: string, capsule: HarnessContextCapsule): void {
  writeColdSnapshot<HarnessContextCapsule>(jobId, CONTEXT_CAPSULE_KIND, capsule);
}

/** 파싱된 스냅샷이 HarnessContextCapsule 구조인지(손상·구버전 방어) — 필드 타입 + 배열 **원소** + groundingRefs
 *  {ref,provenance} shape 까지 검증(원소 손상 `inScope:[123]` 등 차단). provenance **값** 검증은 이후
 *  buildHarnessContextCapsule 이 담당(알 수 없는 값 throw→null). */
function isCapsuleShape(o: unknown): o is HarnessContextCapsule {
  if (!o || typeof o !== 'object') return false;
  const c = o as Record<string, unknown>;
  return typeof c.objective === 'string' && typeof c.target === 'string'
    && isStringArray(c.inScope) && isStringArray(c.outOfScope)
    && isStringArray(c.successCriteria) && isStringArray(c.evidenceRequired)
    && isStringArray(c.riskBoundaries)
    && Array.isArray(c.groundingRefs) && c.groundingRefs.every((g) => {
      if (!g || typeof g !== 'object') return false;
      const r = g as Record<string, unknown>;
      return typeof r.ref === 'string' && typeof r.provenance === 'string';
    })
    // createdAt = 파싱 가능한 timestamp 여야(비정상 값이 최근성 정렬 오염 방지·리뷰 should-fix).
    && typeof c.createdAt === 'string' && !Number.isNaN(Date.parse(c.createdAt));
}

/**
 * 하류 잡이 상류 jobId 의 capsule 을 read 한다(grounding 소비용). 없거나 **손상·구버전**이면 null(fail-soft) —
 * 하류는 그 경우 자기 grounding 만으로 진행. 구조 검증 + `buildHarnessContextCapsule`(provenance 런타임 검증·
 * 정규화 복사) 재통과분만 반환 → 신뢰 못 할 데이터가 유효 capsule 로 새지 않는다.
 */
export function readContextCapsule(jobId: string): HarnessContextCapsule | null {
  const raw = readColdSnapshot<unknown>(jobId, CONTEXT_CAPSULE_KIND);
  if (!isCapsuleShape(raw)) return null;
  try {
    return buildHarnessContextCapsule(raw);   // provenance 검증(예: 알 수 없는 값) + 독립 복사
  } catch {
    return null;   // 알 수 없는 provenance 등 → null(손상 취급)
  }
}

/**
 * ⭐ F2 검색-코퍼스 소스(2026-07-25·대표 아이디어) — 저장된 모든 capsule 을 나열한다. 하류 잡의 grounding
 * 검색(groundMissionInCapsules)이 골 관련도로 걸러 provenance='pty' 팩트로 편입 → **dependsOn DAG 없이**
 * 상류 산출을 grounding 으로 자동 발견(§11 컨텍스트 교환의 검색-코퍼스 실현). 손상분 제외(read 검증). id=archive slug.
 */
export function listContextCapsules(max = 1000): Array<{ id: string; capsule: HarnessContextCapsule }> {
  const out: Array<{ id: string; capsule: HarnessContextCapsule }> = [];
  // ⚠️runaway backstop(리뷰 perf) — never-prune archive 무한 누적 시 순회·파싱 선형 저하 방지. 관련도는
  //   groundMissionInCapsules 가 이 전체 결과 대상으로 계산(MF2: 최근성 선-truncate 금지). 정식 mtime-인덱스·
  //   보존정책은 후속(수천 capsule 규모 시). 현 규모(자기개발 잡)에선 1000 backstop 이 실질 truncate 없음.
  for (const id of listColdSnapshotIds(CONTEXT_CAPSULE_KIND).slice(0, Math.max(0, max))) {
    const capsule = readContextCapsule(id);   // slug 은 이미 safe → 그대로 read + 검증
    if (capsule) out.push({ id, capsule });
  }
  return out;
}
