import { isFiniteNumber, isNonEmptyString, isRecord, isStringArray } from '../primitives/guards.js';
// ── market_posture 저장소 어댑터 (RFC §S3 · 2026-07-14) ────────────────────
//
// MarketPosture v2 계약(src/domains/market-posture.ts)의 유일한 canonical sink.
// 생산자는 `publishMarketPosture`로 단 하나의 파일에 원자적으로 게시하고, 소비자는
// `loadMarketPosture`로 읽는다. 이 모듈은 절대 새 직렬화기/DB 엔진을 만들지 않는다 —
// 코드베이스 전반의 확립된 atomic write 관례(tmp write + renameSync)와 JSON.stringify
// 만 재사용한다(예: src/execution-history.ts, src/auto-research/experiment-ledger.ts).
//
// 책임(오직 이것만):
//   1) version 검증 — 잘못된 schemaVersion/malformed 입력은 게시 거부.
//   2) 원자적 교체 — tmp + rename 으로 부분 쓰기가 canonical 을 훼손하지 못하게.
//   3) stale 표시 — 읽는 시점의 나이가 임계를 넘으면 freshness 를 STALE 로 강등.
//   4) 손상 시 last-known-good 읽기 — canonical 이 깨지면 직전 정상본(sidecar)을 반환.
//
// 매매/실행/arming 결정은 여기서 하지 않는다. DEFCON 은 관측 cadence 신호일 뿐이다.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DATA_DIR } from '../config.js';
import {
  MARKET_POSTURE_SCHEMA_VERSION,
  type DefconLevel,
  type FreshnessStatus,
  type MarketPosture,
} from './market-posture.js';

/** 유일한 canonical sink. 생산자는 오직 이 파일에만 게시한다. */
export function defaultMarketPosturePath(): string {
  return join(DATA_DIR, 'market-posture.json');
}

/** 손상 복구용 last-known-good sidecar(canonical 의 파생물). */
function lastGoodPath(path: string): string {
  return `${path}.last-good`;
}

/** 기본 stale 임계: 관측 후 6시간이 지나면 STALE 로 강등. */
export const DEFAULT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export interface MarketPostureStoreOptions {
  /** canonical sink 경로 override(테스트/격리용). 기본은 defaultMarketPosturePath(). */
  path?: string;
}

export interface PublishMarketPostureOptions extends MarketPostureStoreOptions {
  /** 결정론적 sidecar 타임스탬프용(현재 미사용, 향후 확장 여지). */
  now?: Date;
}

export interface LoadMarketPostureOptions extends MarketPostureStoreOptions {
  /** stale 판정 기준 시각. 기본 = new Date(). */
  now?: Date;
  /** 이 나이(ms)를 초과하면 freshness 를 STALE 로 강등. 기본 6h. */
  staleAfterMs?: number;
}

export interface PublishResult {
  ok: boolean;
  /** 게시 거부 사유(ok=false 일 때만). */
  reason?: string;
}

const VALID_FRESHNESS: ReadonlySet<FreshnessStatus> = new Set(['FRESH', 'STALE', 'UNKNOWN']);

/**
 * MarketPosture v2 계약을 엄격히 검증한다(중첩 필드·enum·타임스탬프·defcon 유한성/범위).
 * 유효하면 그 객체를, 아니면 null 을 반환한다(예외를 던지지 않음 — fail-soft).
 */
export function validateMarketPosture(value: unknown): MarketPosture | null {
  if (!isRecord(value)) return null;

  // version 검증: 정확히 알려진 schemaVersion 만 허용.
  if (value.schemaVersion !== MARKET_POSTURE_SCHEMA_VERSION) return null;

  if (!isNonEmptyString(value.asOf, false)) return null;

  // defcon: 유한 + 정수 + 허용 범위 1..5.
  const defcon = value.defcon;
  if (!isFiniteNumber(defcon) || !Number.isInteger(defcon) || defcon < 1 || defcon > 5) {
    return null;
  }

  // response 중첩 검증: cadence/해상도/알림만 허용하며 방향성 집행 필드는 없다.
  const response = value.response;
  if (!isRecord(response)) return null;
  if (![1, 2, 5, 15, 30].includes(response.cadenceMultiplier as number)) return null;
  if (!['rules', 'gate2', 'cross-check', 'deep', 'emergency'].includes(response.depth as string)) return null;
  if (!['batch', 'priority', 'immediate'].includes(response.alertMode as string)) return null;
  if (typeof response.emergencySweep !== 'boolean' || typeof response.gate2HitlRequired !== 'boolean') return null;

  // provenance 중첩 검증.
  const prov = value.provenance;
  if (!isRecord(prov)) return null;
  if (!isStringArray(prov.sources)) return null;
  if (!isNonEmptyString(prov.calculatedBy, false)) return null;

  // freshness 중첩 검증(enum + 타임스탬프 + 유한 나이).
  const fresh = value.freshness;
  if (!isRecord(fresh)) return null;
  if (typeof fresh.status !== 'string' || !VALID_FRESHNESS.has(fresh.status as FreshnessStatus)) {
    return null;
  }
  if (!isNonEmptyString(fresh.observedAt, false) || Number.isNaN(Date.parse(fresh.observedAt))) return null;
  if (!isFiniteNumber(fresh.ageMs) || fresh.ageMs < 0) return null;

  // regime 중첩 검증.
  const regime = value.regime;
  if (!isRecord(regime)) return null;
  if (!isFiniteNumber(regime.composite)) return null;
  if (!isNonEmptyString(regime.label, false)) return null;
  if (typeof regime.transition !== 'boolean') return null;
  if (!isStringArray(regime.transitionAxes)) return null;
  if (!isNonEmptyString(regime.asOf, false)) return null;

  // leverage 중첩 검증.
  const lev = value.leverage;
  if (!isRecord(lev)) return null;
  if (!isNonEmptyString(lev.regime, false)) return null;
  if (!isFiniteNumber(lev.effectiveExposure)) return null;

  // 여기까지 통과 = 계약을 만족. 원본을 좁혀 그대로 반환.
  return value as unknown as MarketPosture;
}

/** 확립된 관례를 재사용한 원자적 쓰기(tmp write → renameSync). 새 직렬화기 없음. */
function atomicWriteJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  renameSync(tmp, path);
}

function readValidatedFile(path: string): MarketPosture | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return validateMarketPosture(parsed);
  } catch {
    return null; // 손상(JSON 파싱 실패 등) → 상위에서 last-known-good 로 폴백.
  }
}

/**
 * MarketPosture 를 canonical sink 에 게시한다. 게시 전에 계약을 검증하여 잘못된
 * version/malformed/부분 입력이 절대 canonical 을 훼손하지 못하게 막고(요구 3),
 * 원자적 교체(tmp+rename)로 부분 쓰기도 배제한다. 검증에 통과한 posture 는 동시에
 * last-known-good sidecar 로도 복제되어 이후 손상 복구(요구 4)의 근거가 된다.
 */
export function publishMarketPosture(
  posture: MarketPosture,
  opts: PublishMarketPostureOptions = {},
): PublishResult {
  const path = opts.path ?? defaultMarketPosturePath();

  const valid = validateMarketPosture(posture);
  if (!valid) {
    // 거부: 기존 정상 posture 는 손대지 않는다.
    return { ok: false, reason: 'invalid or malformed market posture (version/contract check failed)' };
  }

  // canonical 먼저 원자적으로 교체하고, 그 다음 last-known-good 을 갱신한다.
  atomicWriteJson(path, valid);
  try {
    atomicWriteJson(lastGoodPath(path), valid);
  } catch {
    /* sidecar 실패는 fail-soft — canonical 게시는 이미 성공. */
  }
  return { ok: true };
}

/**
 * canonical sink 에서 MarketPosture 를 읽는다. canonical 이 없거나 손상/무효면
 * last-known-good sidecar 로 폴백한다(요구 4). 읽는 시점 기준 나이가 stale 임계를
 * 넘으면 freshness 를 STALE 로 강등하여 반환한다(요구 4의 stale 표시). 정상본이
 * 전혀 없으면 null.
 */
export function loadMarketPosture(opts: LoadMarketPostureOptions = {}): MarketPosture | null {
  const path = opts.path ?? defaultMarketPosturePath();
  const now = opts.now ?? new Date();
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

  // canonical 우선, 손상 시 last-known-good 로 폴백.
  const loaded = readValidatedFile(path) ?? readValidatedFile(lastGoodPath(path));
  if (!loaded) return null;

  return markStaleIfExpired(loaded, now, staleAfterMs);
}

/** 관측 시각 기준 나이가 임계를 넘으면 freshness.status 를 STALE 로 강등한 사본을 반환. */
function markStaleIfExpired(
  posture: MarketPosture,
  now: Date,
  staleAfterMs: number,
): MarketPosture {
  const observed = Date.parse(posture.freshness.observedAt);
  if (Number.isNaN(observed)) return posture;
  const ageMs = now.getTime() - observed;
  if (ageMs <= staleAfterMs || posture.freshness.status === 'STALE') return posture;
  return {
    ...posture,
    freshness: { ...posture.freshness, status: 'STALE', ageMs },
  };
}

/** re-export 편의(소비자가 계약 상수를 함께 쓰기 쉽도록). */
export { MARKET_POSTURE_SCHEMA_VERSION };
export type { MarketPosture, DefconLevel };
