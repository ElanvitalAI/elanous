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
export type WarmReuseEvidenceByConsumer = Partial<Record<WarmReuseConsumer, WarmReuseEvidence>>;

export interface WarmReuseDecision {
  consumer: WarmReuseConsumer;
  live: boolean;
  /** `live` 이거나 첫 번째로 걸린 이유(예 `flag-off` · `predecessor-off:land` · `samples-short`). */
  reason: string;
}

const FLAG_KEY: Record<WarmReuseConsumer, keyof Pick<WarmReuseSwitchConfig, 'gateRecheck' | 'land' | 'ta'>> = {
  'gate-recheck': 'gateRecheck',
  land: 'land',
  ta: 'ta',
};

const IDENTITY_FIELDS = ['head', 'main', 'lock'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

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
  });
  return { consumer, live, reason };
}
