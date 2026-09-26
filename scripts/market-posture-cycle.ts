#!/usr/bin/env bun
// ── market_posture 생산자 사이클 — DEFCON 국면 감시 루프(생산자) · 2026-07-16 ────
//
// ★ [외부 구현·claude-code] — 아크1(생산자 코어)의 통합 글루. SE 자율 팹이 이 페이즈(생산자
//   사이클 연결)를 과대/예산소진으로 세우지 못해(2회 실패), 외부 도구(claude-code)가 대표 승인
//   하에 직접 구현했다. 미션 self-cognition 에는 provenance=external 로 주입한다(elanous autopilot
//   inject + self log --mission). 이 파일은 아크1의 산정기(market-posture.ts)·저장소
//   (market-posture-store.ts)를 재사용해 입력을 융합·게시하는 얇은 오케스트레이터일 뿐이다.
//
// 역할: regime.db(RegimeVector) + capstone_regime.json + emergency(tripwire) 입력을 융합해
//   deriveMarketPosture 로 MarketPosture v2 를 산정하고, publishMarketPosture 로 단일 canonical
//   sink 에 원자적으로 게시한다(생산자-소비자). 조율·게이트·크론이 loadMarketPosture 로 구독.
//   ★관측/기민성만 — 방향성 주문·freezeNewBuys·집행 필드 없음(계약이 강제). dep seam = 테스트.
//
// 설계: 내부 문서 `RFC-defcon-market-alertness-regime-loop-2026-07-16` §S1(공용화)·S3(생산자 루프).

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { latestRegimeVector, openRegimeDb } from '../src/domains/regime-store.js';
import type { RegimeVector } from '../src/domains/regime-synth.js';
import {
  deriveMarketPosture, progressiveDefcon, tripwireDefcon, normalizeLeveragedReturn, DEFAULT_DEFCON_THRESHOLDS,
  type DeriveMarketPostureInput, type MarketPosture, type ThreatDriver, type TripwireInputs,
} from '../src/domains/market-posture.js';
import { loadMarketPosture, publishMarketPosture, type PublishResult } from '../src/domains/market-posture-store.js';
import { debug, redactSecretText } from '../src/debug/log.js';
import { decideLeverage, type LeveragePlan } from '../src/domains/capstone-leverage.js';
import type { CapstoneTarget } from '../src/domains/capstone-signals.js';

const CAPSTONE_REGIME_PATH = join(homedir(), '.elanous/conatus/capstone_regime.json');
const VALID_TARGETS: readonly CapstoneTarget[] = ['LONG_100', 'CASH_100', 'HEDGE_1D', 'HEDGE_HOLD'];

/**
 * regime.db RegimeVector 의 축을 progressive-fusion threat drivers 로 매핑(순수·RFC §S2 점진).
 * 종합 RISK_OFF 심도·국면 전환·지정학/dislocation/community_buzz 의 음의 방향이 threat 기여.
 * ★drivers 는 DEFCON 5/4/3 만 만든다(2/1 은 tripwire·emergency). 방향(집행)과 직교(기민성 축).
 */
export function regimeToThreatDrivers(regime: RegimeVector): ThreatDriver[] {
  const drivers: ThreatDriver[] = [];
  // 종합 RISK_OFF 심도 — composite 음의 크기(0..1).
  drivers.push({ key: 'regime_risk_off', contribution: Math.min(1, Math.max(0, -regime.composite)), weight: 1 });
  // 국면 전환(다축 동시 부호전환) — 조기경보.
  if (regime.transition) drivers.push({ key: 'regime_transition', contribution: 0.7, weight: 0.8 });
  // 축별 음의 방향(위험회피) → threat 기여.
  for (const ax of regime.axes ?? []) {
    if (!/geopolit|dislocation|community_buzz/i.test(ax.axis)) continue;
    if (ax.direction < 0) {
      drivers.push({ key: ax.axis, contribution: Math.min(1, Math.max(0, ax.strength * ax.confidence)), weight: 0.5 });
    }
  }
  return drivers;
}

function defaultReadCapstone(): { lastTarget?: string } | null {
  try { return existsSync(CAPSTONE_REGIME_PATH) ? JSON.parse(readFileSync(CAPSTONE_REGIME_PATH, 'utf8')) : null; }
  catch { return null; }
}

/** capstone_regime.json(lastTarget) + 현 국면 → LeveragePlan(레버리지 맥락). fail-soft. */
export function loadLeveragePlan(regime: RegimeVector, readCapstone: () => { lastTarget?: string } | null = defaultReadCapstone): LeveragePlan {
  const cap = readCapstone();
  const raw = cap?.lastTarget;
  const bear = regime.regimeLabel === 'RISK_OFF';
  const target: CapstoneTarget = VALID_TARGETS.includes(raw as CapstoneTarget)
    ? (raw as CapstoneTarget) : (bear ? 'CASH_100' : 'LONG_100');
  return decideLeverage(target, bear, regime.transition);
}

export interface MarketPostureCycleDeps {
  loadRegime?: () => RegimeVector | null;
  readCapstone?: () => { lastTarget?: string } | null;
  /** 지수/현물/레버리지/선물 tripwire(라이브 emergency 피드·dep seam). 기본 없음 → freshness UNKNOWN. */
  readEmergency?: () => TripwireInputs | null;
  now?: () => number;
  publish?: (posture: ReturnType<typeof deriveMarketPosture>) => PublishResult;
  load?: () => MarketPosture | null;
}

/** 입력 조립(순수·dep 주입) — regime+capstone+emergency 융합 → DeriveMarketPostureInput. */
export function assembleMarketPostureInput(regime: RegimeVector, deps: MarketPostureCycleDeps = {}): DeriveMarketPostureInput {
  const nowMs = (deps.now ?? Date.now)();
  const emergency = deps.readEmergency?.() ?? null;
  const hasEmergency = !!emergency && (
    (emergency.indices?.length ?? 0) + (emergency.spots?.length ?? 0) +
    (emergency.leveragedEtfs?.length ?? 0) + (emergency.futures?.length ?? 0) > 0
    || emergency.systemCrisis === true);
  return {
    asOf: new Date(nowMs).toISOString(),
    provenance: {
      sources: ['regime.db', 'capstone_regime.json', hasEmergency ? 'emergency' : 'emergency:none'],
      calculatedBy: 'market-posture-cycle',
    },
    // 라이브 emergency 피드가 있으면 tripwire 판정 FRESH, 없으면 UNKNOWN(정직 — 2/1 tripwire 미판정).
    freshness: {
      status: hasEmergency ? 'FRESH' : 'UNKNOWN',
      observedAt: regime.asOf,
      ageMs: Math.max(0, nowMs - Date.parse(regime.asOf)),
    },
    regime,
    leverage: loadLeveragePlan(regime, deps.readCapstone ?? defaultReadCapstone),
    drivers: regimeToThreatDrivers(regime),
    ...(emergency ? { tripwire: emergency } : {}),
  };
}

export interface MarketPostureCycleResult { published: boolean; defcon?: number; note: string; }

function postureLog(event: string, data: unknown, warn = false): void {
  try { debug.log('posture.defcon', event, data, warn ? { level: 'warn' } : undefined); }
  catch { /* 관측 실패가 산정·게시를 막지 않는다. */ }
}

/** 생산자 사이클 — regime+capstone+emergency 융합 → derive → publish(단일 canonical sink). */
export function runMarketPostureCycle(deps: MarketPostureCycleDeps = {}): MarketPostureCycleResult {
  const regime = (deps.loadRegime ?? defaultLoadRegime)();
  if (!regime) {
    postureLog('skipped', { reason: 'regime-missing' });
    return { published: false, note: 'regime.db 최신 벡터 없음 — posture 미산정(입력 결측·게시 스킵)' };
  }
  const input = assembleMarketPostureInput(regime, deps);
  const posture = deriveMarketPosture(input);
  // Before publication: the canonical/last-good reader is the source of the previous value.
  let previousDefcon: MarketPosture['defcon'] | null = null;
  try { previousDefcon = (deps.load ?? loadMarketPosture)()?.defcon ?? null; }
  catch { /* 관측용 이전값 읽기 실패는 게시를 막지 않는다. */ }
  const changed = previousDefcon !== null && previousDefcon !== posture.defcon;
  let cause: 'tripwire' | 'drivers' = 'drivers';
  let tripwires: Array<{ type: string; name?: string; value?: number }> = [];
  try {
    const thresholds = { ...DEFAULT_DEFCON_THRESHOLDS, ...input.thresholds };
    cause = tripwireDefcon(input.tripwire, thresholds) < progressiveDefcon(input.drivers, thresholds)
      ? 'tripwire' : 'drivers';
    const tw = input.tripwire;
    tripwires = [
      ...(tw?.indices ?? []).filter(index => index.circuitBreaker ||
        (Number.isFinite(index.dayReturn) && index.dayReturn <= thresholds.indexLevel2)).map(index => ({
        type: 'index', name: redactSecretText(index.symbol), value: index.dayReturn,
      })),
      ...(tw?.spots ?? []).filter(spot => Number.isFinite(spot.dayReturn) && spot.dayReturn <= thresholds.spotLevel2)
        .map(spot => ({ type: 'spot', name: redactSecretText(spot.symbol), value: spot.dayReturn })),
      ...(tw?.leveragedEtfs ?? []).filter(etf => {
        const equivalent = normalizeLeveragedReturn(etf.dayReturn, etf.leverage);
        return Number.isFinite(equivalent) && equivalent <= thresholds.leverageEquivalentLevel2 + 1e-9;
      }).map(etf => ({
        type: 'leveragedEtf', name: redactSecretText(etf.symbol),
        value: normalizeLeveragedReturn(etf.dayReturn, etf.leverage),
      })),
      ...(tw?.futures ?? []).filter(future => future.limitDown || future.gapDown)
        .map(future => ({ type: 'future', name: redactSecretText(future.symbol) })),
      ...(tw?.systemCrisis ? [{ type: 'systemCrisis' }] : []),
    ];
  } catch { /* 관측용 원인·트립와이어 투영 실패는 게시를 막지 않는다. */ }
  try {
    postureLog('computed', {
      defcon: posture.defcon, previousDefcon, changed,
      regimeLabel: redactSecretText(regime.regimeLabel),
      drivers: (input.drivers ?? []).map(d => ({ name: redactSecretText(d.key), value: d.contribution, weight: d.weight })),
      tripwires,
      freshness: input.freshness,
    });
  } catch { /* 관측용 페이로드 실패는 게시를 막지 않는다. */ }
  const r = (deps.publish ?? publishMarketPosture)(posture);
  if (r?.ok && changed) postureLog('changed', { from: previousDefcon, to: posture.defcon, cause });
  if (!r?.ok) {
    try { postureLog('publish-rejected', { reason: redactSecretText(r?.reason ?? '알 수 없음') }, true); }
    catch { /* 관측용 사유 투영 실패는 결과를 바꾸지 않는다. */ }
  }
  return {
    published: !!r?.ok, defcon: posture.defcon,
    note: r?.ok
      ? `market_posture 게시 — DEFCON ${posture.defcon}·regime ${regime.regimeLabel}·drivers ${input.drivers?.length ?? 0}`
      : `게시 거부: ${r?.reason ?? '알 수 없음'}`,
  };
}

function defaultLoadRegime(): RegimeVector | null {
  try { const db = openRegimeDb(); try { return latestRegimeVector(db); } finally { db.close(); } }
  catch { return null; }
}

// CLI 진입 — 크론이 직접 실행(scripts/market-posture-cycle.ts). import 시엔 실행 안 함.
if (import.meta.main) {
  try {
    const { registerStandaloneLogSink } = await import('../src/domains/standalone-log-sink.js');
    await registerStandaloneLogSink('market-posture-cycle');
  } catch { /* 로그 싱크 장애는 사이클을 막지 않는다. */ }
  // ★ 루프 에이전트 자기등록(대표 2026-07-16 점검) — DEFCON 국면 감시 루프(autonomous 생산자)를
  //   loop-agent-registry 에 매 실행 자기등록(계약루프 패턴 동일). 부팅마다 supersede·좀비 감지·
  //   elanous loops 자산 원장 신선. 미션(apm)·크론(schedule id) 귀속. fail-soft(등록 실패가 사이클 안 막음).
  try {
    const { registerLoopAgentSafe } = await import('../src/domains/loop-agent-registry.js');
    registerLoopAgentSafe({
      loopId: 'autonomous:market-posture',
      name: 'DEFCON 국면 감시 루프',
      summary: 'market_posture(regime.db+capstone+emergency 융합→DEFCON 5단계) 산정·게시 생산자',
      loopKind: 'autonomous',
      lifecycle: 'permanent',
      missionId: 'apm_defcon-regime-watch-loop_5d6ca7',
      scheduleIds: ['af5511a6a40e'],
    });
  } catch { /* fail-soft */ }
  const r = runMarketPostureCycle();
  console.log(`[market-posture-cycle] ${r.note}`);
  process.exit(r.published ? 0 : 1);
}
