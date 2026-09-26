/**
 * Repair signals (G7 · 1d — 관측 → 시스템 수리 신호).
 *
 * 무인 self-dev 루프의 실패를 **패턴으로 클러스터**해, "N개 goal이 같은 stage/errorCode 로
 * 실패 = harness 시스템 이슈(수리 후보)" vs "단일 goal 이슈(재정의)" 를 구분한다.
 * 도그푸드에서 사람이 수동으로 한 진단(worktree 락-레이스=SELF_IMPL_FAILED 다발·gate
 * 취약=gate-failed 다발)을 자동 surface → 1d 는 raw 실패가 아니라 **수리 신호**를 본다.
 *
 * 순수 — parked 목록만 입력. Cf. [[ROADMAP-elanous-is-all-pty-unified-autonomy-2026-07-21]] G7.
 */
import type { ParkedGoal } from './run-store.js';

export interface RepairSignal {
  /** 클러스터 키 — 유효한 abandoned 분류(우선) · stage · errorCode · status. */
  pattern: string;
  /** 클러스터에 기록된 원시 항목 수. */
  count: number;
  /** 같은 패턴의 서로 다른 실행(run) 수 — system/goal 판정 근거. */
  runCount: number;
  /** system = 같은 패턴이 서로 다른 run 2건 이상(harness 버그가 여러 goal 을 동시에 막았을 공산) ·
   *  goal = 단일 run 고유 이슈. */
  kind: 'system' | 'goal';
  affectedFeatures: string[];
  /** 사람이 읽을 수리 힌트. */
  hypothesis: string;
  /** 분류가 클러스터 키일 때, 그 분류를 선택한 기록된 판정 근거. */
  classificationBasis?: string;
}

type AbandonedClassification =
  | 'implementation-deficit'
  | 'report-deficit'
  | 'goal-unconvergeable-candidate'
  | 'contract-conflict'
  | 'run-deadline-exceeded'
  | 'quota-exhausted'
  | 'provider-error'
  | 'credential-failure'
  | 'merge-approved-abandoned'
  | 'artifact-deficit'
  | 'pr-declined'
  | 'already-satisfied';

const ABANDONED_CLASSIFICATIONS = new Set<AbandonedClassification>([
  'implementation-deficit',
  'report-deficit',
  'goal-unconvergeable-candidate',
  'contract-conflict',
  'run-deadline-exceeded',
  'quota-exhausted',
  'provider-error',
  'credential-failure',
  'merge-approved-abandoned',
  'artifact-deficit',
  'pr-declined',
  'already-satisfied',
]);

const SYSTEM_HYPOTHESES: Record<string, string> = {
  'merge-conflict': 'main-싱크 충돌 다발 — 병렬 병합/LLM 충돌해결(G2) 점검 or hot-file 직렬화(hotPaths) 강화.',
  'gate-failed': 'gate 다발 실패 — gate 병렬부하 강건성·scoped-test 폴백 점검.',
  'SELF_IMPL_FAILED': 'self-implement 조기실패 다발 — 인프라(worktree add 레이스·spawn·nest-cap) 점검.',
  'review-blocked': '리뷰 must-fix 다발 — goal 스펙 모호 or 리뷰 기준 과엄격 점검.',
  'timed-out': '자율 단계 wall-clock 초과 다발(hang) — `elanous logs --category self-implement --grep step-timeout` 로 어느 step(gate/review/merge/pr)이 끊기는지 특정 → 해당 seam 근본 hang(LLM/subprocess/network) 점검·타임아웃 조정(stepTimeouts).',
  interrupted: '다수 중단 — 오케스트레이터 안정성·타임아웃·리소스 점검.',
};

export const CLASSIFICATION_HINTS: Record<AbandonedClassification, { system: string; goal: string }> = {
  'implementation-deficit': {
    system: '구현 결손 다발 — 구현 프롬프트·도구 경계·재작업 루프를 점검.',
    goal: '구현 결손 단발 — 해당 goal의 구현 범위·증거를 보강하거나 재정의.',
  },
  'report-deficit': {
    system: '보고 결손 다발 — 산출물·증거 수집 경로를 점검.',
    goal: '보고 결손 단발 — 해당 goal의 산출물·완료 증거를 보강.',
  },
  'goal-unconvergeable-candidate': {
    system: '골 수렴불가 후보 다발 — 두 원인 후보를 함께 점검: (골 축) goal 스펙의 모순·모호성, (구현 축) 자식 구현이 리뷰 must-fix 지적을 해결하지 못함. 반복된 must-fix 문면을 열어 goal 계약과 상충하는지 확인해 둘을 가른다.',
    goal: '골 수렴불가 후보 — 두 원인 후보를 함께 점검: (골 축) goal 스펙의 모순·모호성, (구현 축) 자식 구현이 리뷰 must-fix 지적을 해결하지 못함. 반복된 must-fix 문면을 열어 goal 계약과 상충하는지 확인해 둘을 가른 뒤, 골 축이면 goal을 다시 작성·분해하고 구현 축이면 자식 재작업을 수리한다.',
  },
  'contract-conflict': {
    system: '계약 충돌 다발 — goal 계약·하니스 정책의 상충을 점검.',
    goal: '계약 충돌 단발 — 해당 goal의 상충하는 수용 기준을 정정.',
  },
  'run-deadline-exceeded': {
    system: '수명 상한 사망 다발 — 브랜치/PR 이 있으면 수확하고, 없으면 골을 재분해한다. 할당량 소진으로 읽지 않는다.',
    goal: '수명 상한 사망 단발 — 산출이 있으면 수확하고, 없으면 그 골을 재분해한다.',
  },
  'quota-exhausted': {
    system: '쿼터 소진 다발 — provider 회전·용량 정책을 점검.',
    goal: '쿼터 소진 단발 — 해당 goal은 환경 용량 회복 뒤 재개 판단.',
  },
  'provider-error': {
    system: 'provider 오류 다발 — provider 상태·재시도·폴백 경로를 점검.',
    goal: 'provider 오류 단발 — 해당 goal은 provider 복구 뒤 재시도 판단.',
  },
  'credential-failure': {
    system: '자격 증명 실패 다발 — provider 인증 설정·갱신 경로를 점검.',
    goal: '자격 증명 실패 단발 — 해당 goal은 인증 복구 뒤 재개 판단.',
  },
  'merge-approved-abandoned': {
    system: '머지 승인 뒤 중단 다발 — 승인 이후 착지·상태 전이 경로를 점검.',
    goal: '머지 승인 뒤 중단 단발 — 해당 승인 산출물의 착지·salvage를 확인.',
  },
  'artifact-deficit': {
    system: '산출물 결손 다발 — 비구현 goal 산출물 경로·템플릿을 점검.',
    goal: '산출물 결손 단발 — 해당 goal의 요구 산출물을 보완.',
  },
  'pr-declined': {
    system: 'PR 거절 다발 — PR 정책·리뷰 흐름을 점검.',
    goal: 'PR 거절 단발 — 해당 PR의 거절 사유를 반영하거나 goal을 재정의.',
  },
  'already-satisfied': {
    system: '이미 만족 다발 — 고칠 것이 없다. 같은 골을 다시 쏘지 말고 완료로 받아들여라.',
    goal: '이미 만족 단발 — 고칠 것이 없다. 해당 goal의 요구는 이미 구현돼 있으니 재발사하지 마라.',
  },
};

type ClassifiedParkedGoal = ParkedGoal & {
  failureClassification?: unknown;
  ledgerAbandonedClassification?: unknown;
  classificationBasis?: unknown;
};

function validAbandonedClassification(value: unknown): AbandonedClassification | undefined {
  return typeof value === 'string' && ABANDONED_CLASSIFICATIONS.has(value as AbandonedClassification)
    ? value as AbandonedClassification
    : undefined;
}

function abandonedClassification(goal: ParkedGoal): AbandonedClassification | undefined {
  const classified = goal as ClassifiedParkedGoal;
  return validAbandonedClassification(classified.ledgerAbandonedClassification)
    ?? validAbandonedClassification(classified.failureClassification);
}

function classificationBasis(goal: ParkedGoal): string | undefined {
  const value = (goal as ClassifiedParkedGoal).classificationBasis;
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function repairHypothesis(pattern: string, kind: 'system' | 'goal', classification?: AbandonedClassification): string {
  if (classification) return `${classification} — ${CLASSIFICATION_HINTS[classification][kind]}`;
  if (kind === 'goal') return '단발 — 그 goal 고유 이슈(재정의/포기 결정).';
  return SYSTEM_HYPOTHESES[pattern] ?? `동일 패턴(${pattern}) 다발 — harness 시스템 이슈 의심(수리 후보).`;
}

function patternFor(goal: ParkedGoal): string {
  return abandonedClassification(goal) ?? (goal.stage || goal.error?.code || goal.status);
}

/** A cancellation is attributable only when its run has one unambiguous upstream failure.
 * ParkedGoal deliberately stores no parent/cause pointer, so a run with several failures
 * leaves its cancelled rows as `cancelled` rather than inventing a causal relationship. */
function upstreamFailureByRun(parked: readonly ParkedGoal[]): Map<string, ParkedGoal | undefined> {
  const candidates = new Map<string, ParkedGoal[]>();
  for (const goal of parked) {
    if (goal.status === 'cancelled') continue;
    const failures = candidates.get(goal.runId) ?? [];
    failures.push(goal);
    candidates.set(goal.runId, failures);
  }
  return new Map([...candidates].map(([runId, failures]) => [runId, failures.length === 1 ? failures[0] : undefined]));
}

type SignalEvidence = { item: ParkedGoal; representative: ParkedGoal };

/** parked goal 을 수리 신호로 분석(system 우선·count 내림차순). */
export function analyzeRepairSignals(parked: ParkedGoal[]): RepairSignal[] {
  const upstreamByRun = upstreamFailureByRun(parked);
  const byPattern = new Map<string, SignalEvidence[]>();
  for (const item of parked) {
    const upstream = item.status === 'cancelled' ? upstreamByRun.get(item.runId) : undefined;
    // A cancelled descendant is evidence only when this run has one unambiguous
    // upstream failure. Ambiguous cancellations must not become an independent signal.
    if (item.status === 'cancelled' && !upstream) continue;
    const representative = upstream ?? item;
    const pattern = patternFor(representative);
    const evidence = byPattern.get(pattern) ?? [];
    evidence.push({ item, representative });
    byPattern.set(pattern, evidence);
  }
  const signals: RepairSignal[] = [];
  for (const [pattern, evidence] of byPattern) {
    const runCount = new Set(evidence.map(({ item }) => item.runId)).size;
    const kind: 'system' | 'goal' = runCount >= 2 ? 'system' : 'goal';
    const representative = evidence.find(({ representative: goal }) => goal.status !== 'cancelled')?.representative ?? evidence[0]!.representative;
    const classification = abandonedClassification(representative);
    const basis = classification ? classificationBasis(representative) : undefined;
    signals.push({
      pattern,
      count: evidence.length,
      runCount,
      kind,
      affectedFeatures: evidence.map(({ item }) => item.feature.slice(0, 60)),
      hypothesis: repairHypothesis(pattern, kind, classification),
      ...(basis ? { classificationBasis: basis } : {}),
    });
  }
  // ★ A(2026-07-21·false-failure 힐링) — reconcileMismatch(goal-loop 은 GOAL-COMPLETE 했는데 exit=fail·
  //   파이프라인 정당실패 아님 = 스폰 신호 단절)은 stage 패턴과 **직교**한 별도 신호. 성공 산출이 worktree 에
  //   보존돼 있으니 **재빌드 말고 salvage**(그 worktree 를 gate/review 통과시켜 승격)가 힐링 방향. 자기인지→힐링.
  const falseFailed = parked.filter((g) => g.reconcileMismatch);
  if (falseFailed.length > 0) {
    signals.unshift({
      pattern: 'false-failure',
      count: falseFailed.length,
      runCount: new Set(falseFailed.map((goal) => goal.runId)).size,
      kind: new Set(falseFailed.map((goal) => goal.runId)).size >= 2 ? 'system' : 'goal',
      affectedFeatures: falseFailed.map((g) => g.feature.slice(0, 60)),
      hypothesis: `스폰 신호 단절(goal-loop 성공·exit=fail) — 성공 산출이 worktree(screenSpace)에 보존됨. **재빌드 금지·salvage**(보존 worktree 를 gate/review 통과시켜 승격). 화면 전사=\`elanous self screen --space <screenSpace>\`.`,
    });
  }
  // system 신호 먼저(가장 actionable) → 그 안에서 count 내림차순. false-failure 는 unshift 로 최상단(salvage 우선).
  const head = signals.filter((s) => s.pattern === 'false-failure');
  const rest = signals.filter((s) => s.pattern !== 'false-failure');
  rest.sort((a, b) => (a.kind === b.kind ? b.count - a.count : a.kind === 'system' ? -1 : 1));
  return [...head, ...rest];
}
