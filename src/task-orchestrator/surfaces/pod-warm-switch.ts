import { isRecord } from '../../primitives/guards.js';
/**
 * warm Pod 재사용 ⑤ — 소비자별 «실전 사용 가능?» 손잡이 (PLAN-warm-reuse-tonight-2026-10-15 §5).
 *
 * 관측: 판정마다 `debug.log('pod.warm', 'switch-decision', …)` 한 줄(소비자·live·reason·표본 수).
 * 판단: config flag(`pod.warmReuse.{gateRecheck,land,ta}` · 기본 false) ⊕ 증거
 *       (lease 유효 · 카나리아 통과 · 같은 head/main/lock · 최근 mismatch 0 · 연속 일치 표본 ≥ minMatchSamples).
 * 수복: live=false 면 소비자는 기존 fresh Job 경로를 그대로 탄다 — reason 이 «무엇이 모자랐나»를 넘긴다.
 *
 * ⛔ 이 모듈은 판정만 한다. 소비자 결선(pod-command-job · gate-node · self-implement-pod)은 각 소비자 PR 몫이다.
 * ⛔ 못 잰 증거(undefined)는 «통과»가 아니라 «off» 다 — 모르면 켜지 않는다.
 * 순서: gate-recheck → land → ta. 앞 소비자가 «자기 증거로» live 가 아니면 뒤 소비자도 live 가 아니다
 *       (증거는 소비자별 — 뒤 소비자의 증거로 앞 소비자를 대신 판정하지 않는다 · 앞 증거가 없으면 off).
 */
import { debug } from '../../debug/log.js';
import type { ReleaseSchedule } from '../../release-loop/release-schedule.js';

export type PodPhase = 'normal' | 'rehearsal' | 'cut-gate' | 'publication';
export type PodKind = 'gate' | 'implementation';
export interface PodPhaseSchedule extends Pick<ReleaseSchedule, 'version' | 'cutAt' | 'publishAt'> {}
export interface PodPhaseTargets { gate: number; implementation: number }
export interface PodPhasePlan { phase: PodPhase; version: string | null; target: PodPhaseTargets; cutAt: string | null }
export interface PodPhasePrewarmConfig {
  targets?: Partial<Record<PodPhase, Partial<PodPhaseTargets>>>;
  gateIdentity?: { cutSha?: string; lockHash?: string };
}
export interface PodPhaseCandidateIdentity { kind?: PodKind; cutSha: string; lockHash: string }
export interface PodPhaseCandidateAssignment<T extends PodPhaseCandidateIdentity> { candidate: T; kind: PodKind }

const NORMAL_PHASE_TARGET: PodPhaseTargets = { gate: 0, implementation: 1 };
const PHASE_TARGETS: Record<PodPhase, PodPhaseTargets> = {
  normal: NORMAL_PHASE_TARGET,
  rehearsal: { gate: 1, implementation: 1 },
  'cut-gate': { gate: 2, implementation: 0 },
  publication: { gate: 1, implementation: 0 },
};

/** Schedule-derived targets; gate prewarm opens exactly 30 minutes before the scheduled cut. */
export function resolvePodPhasePlan(schedules: readonly PodPhaseSchedule[], nowMs: number,
  config?: PodPhasePrewarmConfig): PodPhasePlan {
  for (const schedule of schedules) {
    if (!Number.isFinite(Date.parse(schedule.cutAt))) throw new Error('invalid-release-schedule-cut-at');
    if (schedule.publishAt && !Number.isFinite(Date.parse(schedule.publishAt))) throw new Error('invalid-release-schedule-publish-at');
  }
  const active = schedules.flatMap(schedule => {
    const cut = Date.parse(schedule.cutAt), publish = schedule.publishAt ? Date.parse(schedule.publishAt) : NaN;
    if (!Number.isFinite(cut)) return [];
    const phase: PodPhase | null = nowMs >= cut - 30 * 60_000 && nowMs < cut ? 'cut-gate'
      : nowMs >= cut - 7 * 60 * 60_000 && nowMs < cut - 30 * 60_000 ? 'rehearsal'
        : Number.isFinite(publish) && nowMs >= cut && nowMs < publish ? 'publication' : null;
    return phase ? [{ schedule, cut, phase, rank: phase === 'cut-gate' ? 0 : phase === 'rehearsal' ? 1 : 2 }] : [];
  }).sort((a, b) => a.rank - b.rank || a.cut - b.cut)[0];
  const phase: PodPhase = active?.phase ?? 'normal';
  const upcoming = active;
  const configured = config?.targets?.[phase];
  const target = { gate: PHASE_TARGETS[phase].gate, implementation: PHASE_TARGETS[phase].implementation };
  for (const kind of ['gate', 'implementation'] as const) {
    const value = configured?.[kind];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) target[kind] = value;
  }
  return { phase, version: upcoming?.schedule.version ?? null, target, cutAt: upcoming?.schedule.cutAt ?? null };
}

export function podPhaseGateIdentityMatches(candidate: { cutSha: string; lockHash?: string; key?: { lockHash?: string } }, config: PodPhasePrewarmConfig): boolean {
  const identity = config.gateIdentity;
  const lockHash = candidate.lockHash ?? candidate.key?.lockHash;
  return !!identity?.cutSha && !!identity.lockHash && candidate.cutSha === identity.cutSha && lockHash === identity.lockHash;
}

/** Allocate the configured pool to phase demand; gate assignment always requires exact cut and lock identity. */
export function allocatePodPhaseCandidates<T extends PodPhaseCandidateIdentity>(
  candidates: readonly T[], target: PodPhaseTargets, config: PodPhasePrewarmConfig,
): PodPhaseCandidateAssignment<T>[] {
  const remaining = [...candidates];
  const assigned: PodPhaseCandidateAssignment<T>[] = [];
  const prefer = (kind: PodKind) => (left: T, right: T) => Number(right.kind === kind) - Number(left.kind === kind);
  const gateCandidates = remaining.filter(candidate => podPhaseGateIdentityMatches(candidate, config)).sort(prefer('gate'));
  const gates = gateCandidates.slice(0, target.gate);
  assigned.push(...gates.map(candidate => ({ candidate, kind: 'gate' as const })));
  for (const candidate of gates) remaining.splice(remaining.indexOf(candidate), 1);
  const implementations = remaining.sort(prefer('implementation')).slice(0, target.implementation);
  assigned.push(...implementations.map(candidate => ({ candidate, kind: 'implementation' as const })));
  return assigned;
}

export type WarmReuseConsumer = 'gate-recheck' | 'land' | 'ta';

/** 켜는 순서 — 뒤 소비자는 바로 앞 소비자가 live 일 때만 live 가 될 수 있다. */
export const WARM_REUSE_CONSUMER_ORDER: readonly WarmReuseConsumer[] = ['gate-recheck', 'land', 'ta'];

/** 연속 일치 표본 기본 하한(보수적). */
export const DEFAULT_WARM_MIN_MATCH_SAMPLES = 3;

/** `pod.warmReuse` config 절 — 타입이 어긋난 값은 off/기본값으로 읽는다. */
export interface WarmReuseSwitchConfig {
  gateRecheck?: boolean;
  land?: boolean;
  ta?: boolean;
  minMatchSamples?: number;
}

/** warm 워커 신원 — 기대값(fresh Job 쪽)과 워커 쪽을 같은 칸끼리 대조한다. */
export interface WarmReuseIdentity {
  head?: string;
  main?: string;
  lock?: string;
}

/** 판정 증거. 칸이 비면(undefined) «못 쟀다» = off. */
export interface WarmReuseEvidence {
  /** 같은 파일 fresh Job 대비 연속 일치(rc ⊕ JUnit 실패 ID) 표본 수. */
  consecutiveMatchSamples?: number;
  /** 최근 창의 warm↔fresh mismatch 수 — 0 이어야 live. */
  recentMismatchCount?: number;
  /** Nexus `pod-worker-lease` 가 현재 generation 으로 유효한가. */
  leaseValid?: boolean;
  /** 정비 뒤 카나리아 통과. */
  canaryPassed?: boolean;
  expected?: WarmReuseIdentity;
  worker?: WarmReuseIdentity;
}

/** 소비자별 증거 — 판정 대상 ⊕ 그 앞 소비자들의 증거가 모두 있어야 live 가 될 수 있다. */
export interface WarmReuseEvidenceByConsumer extends Partial<Record<WarmReuseConsumer, WarmReuseEvidence>> {
  /** Optional simulation provenance attached to the exact decision event. It does not affect the switch. */
  observation?: WarmReuseDecisionObservation;
}

export interface WarmReuseDecision {
  consumer: WarmReuseConsumer;
  live: boolean;
  /** `live` 이거나 첫 번째로 걸린 이유(예 `flag-off` · `predecessor-off:land` · `samples-short`). */
  reason: string;
}

export interface WarmReuseDecisionObservation {
  runId: string;
  verificationCommand: string;
  returnedChildren: {
    leaseGenerations: readonly number[];
    podUids: readonly string[];
    cleanupOutcomes: readonly string[];
    finalPodState: string | undefined;
    returnedChildProofs: readonly { parentRunId: string; childRunId: string; attemptId: string; leaseId: string; podUid: string }[];
  };
}

export type WarmPodPhase = 'rehearsal' | 'gate-prewarm' | 'gate' | 'publish' | 'steady';
export type WarmPodPhaseKind = 'gate' | 'implementation';
export interface WarmPodPhaseWindow {
  phase: 'rehearsal' | 'gate' | 'publish';
  startAtMs: number;
  endAtMs: number;
  targets: Partial<Record<WarmPodPhaseKind, number>>;
  /** Gate windows pin the exact release image and lock identity to prewarm and reuse. */
  cutSha?: string;
  lockHash?: string;
  imageDigest?: string;
}
export interface WarmPodPhaseSchedule {
  windows: readonly WarmPodPhaseWindow[];
  steadyTargets: Partial<Record<WarmPodPhaseKind, number>>;
  /** Latest BURST-HOST-JIT measured Pod preparation duration; absent means no readiness sample is available. */
  measuredPrepareDurationMs?: number;
}
export interface WarmPodPhasePlan {
  phase: WarmPodPhase;
  targets: Partial<Record<WarmPodPhaseKind, number>>;
  gateIdentity?: { cutSha: string; lockHash: string; imageDigest: string };
}
export interface WarmPodPhaseCandidate {
  kind?: WarmPodPhaseKind;
  spec: { cutSha: string; key: { lockHash: string; imageDigest: string }; workerId: string };
}

const DEFAULT_GATE_PREWARM_LEAD_MS = 30 * 60_000;
const PHASE_KINDS: readonly WarmPodPhaseKind[] = ['gate', 'implementation'];

/** Resolve one release phase from the operator's single private-provider schedule. */
export function resolveWarmPodPhasePlan(nowMs: number, schedule: WarmPodPhaseSchedule): WarmPodPhasePlan {
  if (!Number.isFinite(nowMs) || !Array.isArray(schedule.windows)) throw new Error('invalid warm Pod phase schedule');
  const measuredPrepareDurationMs = schedule.measuredPrepareDurationMs ?? 0;
  if (!Number.isSafeInteger(measuredPrepareDurationMs) || measuredPrepareDurationMs < 0)
    throw new Error('invalid measured warm Pod preparation duration');
  const lead = DEFAULT_GATE_PREWARM_LEAD_MS + measuredPrepareDurationMs;
  if (!Number.isSafeInteger(lead)) throw new Error('invalid warm Pod phase prewarm lead');
  const validateTargets = (targets: Partial<Record<WarmPodPhaseKind, number>>) => {
    if (!targets || typeof targets !== 'object' || Object.entries(targets).some(([kind, count]) =>
      !PHASE_KINDS.includes(kind as WarmPodPhaseKind) || !Number.isSafeInteger(count) || (count as number) < 0))
      throw new Error('invalid warm Pod phase targets');
  };
  validateTargets(schedule.steadyTargets);
  const windows = [...schedule.windows].sort((a, b) => a.startAtMs - b.startAtMs);
  for (let index = 0; index < windows.length; index++) {
    const window = windows[index]!;
    if (!['rehearsal', 'gate', 'publish'].includes(window.phase)
      || !Number.isSafeInteger(window.startAtMs) || !Number.isSafeInteger(window.endAtMs)
      || window.endAtMs <= window.startAtMs || (index > 0 && windows[index - 1]!.endAtMs > window.startAtMs))
      throw new Error('invalid or overlapping warm Pod phase window');
    validateTargets(window.targets);
    if (window.phase === 'gate' && (!/^[a-f0-9]{40}$/.test(window.cutSha ?? '')
      || !/^[a-f0-9]{64}$/.test(window.lockHash ?? '')
      || !/^sha256:[a-f0-9]{64}$/.test(window.imageDigest ?? '')))
      throw new Error('gate warm Pod phase requires exact cut, lock, and image identity');
  }
  const active = windows.find(window => nowMs >= window.startAtMs && nowMs < window.endAtMs);
  if (active?.phase === 'gate') return { phase: 'gate', targets: active.targets,
    gateIdentity: { cutSha: active.cutSha!, lockHash: active.lockHash!, imageDigest: active.imageDigest! } };
  const nextGate = windows.find(window => window.phase === 'gate' && window.startAtMs >= nowMs
    && window.startAtMs - nowMs <= lead);
  if (nextGate) return { phase: 'gate-prewarm', targets: nextGate.targets,
    gateIdentity: { cutSha: nextGate.cutSha!, lockHash: nextGate.lockHash!, imageDigest: nextGate.imageDigest! } };
  if (active) return { phase: active.phase, targets: active.targets };
  return { phase: 'steady', targets: schedule.steadyTargets };
}

/** Deterministic target selection shared by reconcile, request, and UX simulation. */
export function selectWarmPodPhaseCandidates<T extends WarmPodPhaseCandidate>(
  candidates: readonly T[], plan: WarmPodPhasePlan, eligible: (candidate: T) => boolean = () => true,
): T[] {
  const selected: T[] = [];
  for (const kind of PHASE_KINDS) {
    const target = plan.targets[kind] ?? 0;
    const eligibleCandidates = candidates.filter(candidate => eligible(candidate)
      && (candidate.kind ?? 'gate') === kind
      && (kind !== 'gate' || !plan.gateIdentity || (candidate.spec.cutSha === plan.gateIdentity.cutSha
        && candidate.spec.key.lockHash === plan.gateIdentity.lockHash
        && candidate.spec.key.imageDigest === plan.gateIdentity.imageDigest)))
      .slice().sort((left, right) => left.spec.workerId.localeCompare(right.spec.workerId));
    selected.push(...eligibleCandidates.slice(0, target));
  }
  return selected;
}

const FLAG_KEY: Record<WarmReuseConsumer, keyof Pick<WarmReuseSwitchConfig, 'gateRecheck' | 'land' | 'ta'>> = {
  'gate-recheck': 'gateRecheck',
  land: 'land',
  ta: 'ta',
};

const IDENTITY_FIELDS = ['head', 'main', 'lock'] as const;

/** minMatchSamples — 양의 안전 정수만, 아니면 기본값. */
export function resolveWarmMinMatchSamples(config: unknown): number {
  const raw = isRecord(config) ? config.minMatchSamples : undefined;
  return typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : DEFAULT_WARM_MIN_MATCH_SAMPLES;
}

/** flag — 문자 그대로 `true` 만 켠다. */
export function warmReuseFlagOn(config: unknown, consumer: WarmReuseConsumer): boolean {
  return isRecord(config) && config[FLAG_KEY[consumer]] === true;
}

function evidenceReason(evidence: WarmReuseEvidence | undefined, minSamples: number): string | null {
  if (!evidence) return 'evidence-unmeasured';
  // A measured mismatch is the most actionable reason even when it also makes the latest canary fail.
  if (typeof evidence.recentMismatchCount === 'number' && evidence.recentMismatchCount > 0) return 'recent-mismatch';
  if (evidence.leaseValid !== true) return evidence.leaseValid === false ? 'lease-invalid' : 'lease-unmeasured';
  if (evidence.canaryPassed !== true) return evidence.canaryPassed === false ? 'canary-failed' : 'canary-unmeasured';
  for (const field of IDENTITY_FIELDS) {
    const want = evidence.expected?.[field];
    const got = evidence.worker?.[field];
    if (typeof want !== 'string' || !want || typeof got !== 'string' || !got) return `identity-unmeasured:${field}`;
    // 원값 그대로 정확히 비교한다 — 앞뒤 공백 등 형식이 어긋난 값은 고쳐 읽지 않고 off.
    if (want !== want.trim() || got !== got.trim()) return `identity-malformed:${field}`;
    if (want !== got) return `identity-mismatch:${field}`;
  }
  const mismatches = evidence.recentMismatchCount;
  if (typeof mismatches !== 'number' || !Number.isSafeInteger(mismatches) || mismatches < 0) return 'mismatch-unmeasured';
  if (mismatches > 0) return 'recent-mismatch';
  const samples = evidence.consecutiveMatchSamples;
  if (typeof samples !== 'number' || !Number.isSafeInteger(samples) || samples < 0) return 'samples-unmeasured';
  if (samples < minSamples) return 'samples-short';
  return null;
}

function decide(consumer: WarmReuseConsumer, config: unknown, evidence: WarmReuseEvidenceByConsumer | undefined): string {
  if (!warmReuseFlagOn(config, consumer)) return 'flag-off';
  const index = WARM_REUSE_CONSUMER_ORDER.indexOf(consumer);
  if (index > 0) {
    const predecessor = WARM_REUSE_CONSUMER_ORDER[index - 1]!;
    if (decide(predecessor, config, evidence) !== 'live') return `predecessor-off:${predecessor}`;
  }
  const own = isRecord(evidence) ? evidence[consumer] : undefined;
  return evidenceReason(isRecord(own) ? own : undefined, resolveWarmMinMatchSamples(config)) ?? 'live';
}

/**
 * 소비자 하나가 지금 warm 워커를 «실전»으로 써도 되나.
 * `config` 는 `getUserConfig().pod?.warmReuse` 를 그대로 넘긴다(없으면 전부 off).
 * `evidence` 는 소비자별 — 대상 소비자 ⊕ 그 앞 소비자들의 칸이 모두 있어야 한다(앞 칸이 비면 `predecessor-off:<앞>`).
 */
export function decideWarmReuse(
  consumer: WarmReuseConsumer,
  config: WarmReuseSwitchConfig | undefined,
  evidence: WarmReuseEvidenceByConsumer | undefined,
): WarmReuseDecision {
  const reason = decide(consumer, config, evidence);
  const live = reason === 'live';
  const own = isRecord(evidence) && isRecord(evidence[consumer]) ? evidence[consumer] : undefined;
  debug.log('pod.warm', 'switch-decision', {
    consumer,
    live,
    reason,
    flag: warmReuseFlagOn(config, consumer),
    minMatchSamples: resolveWarmMinMatchSamples(config),
    samples: own?.consecutiveMatchSamples ?? null,
    recentMismatchCount: own?.recentMismatchCount ?? null,
    ...(evidence?.observation ? { runId: evidence.observation.runId,
      verificationCommand: evidence.observation.verificationCommand,
      returnedChildren: evidence.observation.returnedChildren } : {}),
  });
  return { consumer, live, reason };
}
