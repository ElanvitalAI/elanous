// NEXUS · LLM 지출 관측 저장소 — 행별 창·크레딧 관측(실제 신호 + 합성 사건) (LLM-AUTO-PROVIDER-E2E)
//
// 저장 위치: <config-dir>/nexus/llm-spend-observations.json (원장 폴더 llm-spend-policy/ 의 «부모» · 0600 · tmp+rename 원자 쓰기).
// 담는 것: 행 이름 · 공급자 이름 · 수치 · 시각 · source('real'|'synthetic') — 값(비밀) 0.
//   · real = settleLlmCall 이 받은 실제 429 usage_limit_reached / 402 신호.
//   · synthetic = 시험 우주에서만 `eln llm policy inject --live-synthetic` 이 쓴 합성 사건(되돌림 대상은 synthetic 만).
//     운영 신원의 실 관문 observer 는 synthetic 을 읽지 않는다(기본 무시) — 합성은 «결정 드라이런» 으로만 본다.
// 신선도 판단은 «결정 함수의 것» — 여기는 최신 관측을 있는 그대로 행 상태(observedAt 포함)로 내보낸다.

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withFileLockSync } from '../../storage/file-lock.js';
import { nexusRootDir } from '../paths.js';
import { llmSpendPolicyDir } from './ledger.js';
import type { LlmSpendRowState } from './types.js';

export const SPEND_OBSERVATIONS_FILE = 'llm-spend-observations.json';
export const MAX_OBSERVATION_RECORDS = 200; // 출처: #39183 배선 설계 — 행·종류별 최신만 남기므로 200 은 넉넉한 상한(초기값)

export type SpendObservationKind = 'window' | 'balance' | 'spend' | 'autoTopUp';
export type SpendObservationSource = 'real' | 'synthetic';

export interface SpendObservation {
  readonly id: string;
  readonly row: string;
  readonly provider: string;
  readonly kind: SpendObservationKind;
  readonly source: SpendObservationSource;
  readonly observedAt: string;
  /** window */
  readonly usedPct?: number;
  readonly resetAt?: string;
  /** window — 소진 기울기(%/h). 없으면 projectBurn 은 «모름»(null). */
  readonly slopePctPerHour?: number;
  /** balance */
  readonly usd?: number;
  /** spend */
  readonly todayUsd?: number;
  readonly monthUsd?: number;
  /** autoTopUp */
  readonly enabled?: boolean;
  readonly amountUsd?: number;
  /** 어떤 사건에서 왔나(usage_limit_reached · insufficient_credits · window-reset · spend-cap · auto-topup). */
  readonly event?: string;
}

export async function spendObservationsFile(policyDirOverride?: string): Promise<string> {
  // 정책 폴더(<nexus>/llm-spend-policy)의 부모 = <nexus>. 주입 폴더도 같은 규칙(시험).
  const policyDir = await llmSpendPolicyDir(policyDirOverride);
  return join(policyDirOverride ? dirname(policyDir) : nexusRootDir(), SPEND_OBSERVATIONS_FILE);
}

function isObservation(v: unknown): v is SpendObservation {
  if (v === null || typeof v !== 'object') return false;
  const c = v as Record<string, unknown>;
  return typeof c.id === 'string' && typeof c.row === 'string' && typeof c.provider === 'string'
    && (c.kind === 'window' || c.kind === 'balance' || c.kind === 'spend' || c.kind === 'autoTopUp')
    && (c.source === 'real' || c.source === 'synthetic')
    && typeof c.observedAt === 'string' && Number.isFinite(Date.parse(c.observedAt));
}

/** 읽기 — 파일 없음/깨짐 = 빈 목록(관측 없음 = 모름 · 결정 함수가 그 행을 fail-closed 로 건너뛴다). */
export async function readSpendObservations(policyDirOverride?: string): Promise<SpendObservation[]> {
  const file = await spendObservationsFile(policyDirOverride);
  try {
    if (!existsSync(file)) return [];
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { records?: unknown };
    return Array.isArray(parsed.records) ? parsed.records.filter(isObservation) : [];
  } catch { return []; }
}

function writeAtomic0600(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, 'utf8');
  try { chmodSync(tmp, 0o600); renameSync(tmp, file); } catch (error) {
    try { unlinkSync(tmp); } catch { /* 이미 없다 */ }
    throw error;
  }
}

async function mutate(policyDirOverride: string | undefined, fn: (records: SpendObservation[]) => SpendObservation[]): Promise<SpendObservation[]> {
  const file = await spendObservationsFile(policyDirOverride);
  mkdirSync(dirname(file), { recursive: true });
  return withFileLockSync(`${file}.lock`, () => {
    let current: SpendObservation[] = [];
    try { if (existsSync(file)) { const p = JSON.parse(readFileSync(file, 'utf8')) as { records?: unknown }; if (Array.isArray(p.records)) current = p.records.filter(isObservation); } } catch { current = []; }
    const next = fn(current).slice(-MAX_OBSERVATION_RECORDS);
    writeAtomic0600(file, `${JSON.stringify({ version: 1, records: next })}\n`);
    return next;
  });
}

/** 관측 한 건 추가 — 같은 (행·종류·source) 의 이전 관측은 대체된다. */
export async function appendSpendObservation(obs: SpendObservation, policyDirOverride?: string): Promise<void> {
  if (!isObservation(obs)) throw new Error('appendSpendObservation: invalid observation');
  await mutate(policyDirOverride, (records) => [
    ...records.filter((r) => !(r.row === obs.row && r.kind === obs.kind && r.source === obs.source)), obs,
  ]);
}

/** 합성 관측 되돌림 — id 하나 또는 'all'(합성 전부). 실제(real) 관측은 건드리지 않는다. 지운 id 를 돌려준다. */
export async function revokeSyntheticObservations(idOrAll: string, policyDirOverride?: string): Promise<string[]> {
  const removed: string[] = [];
  await mutate(policyDirOverride, (records) => records.filter((r) => {
    const hit = r.source === 'synthetic' && (idOrAll === 'all' || r.id === idOrAll);
    if (hit) removed.push(r.id);
    return !hit;
  }));
  return removed;
}

/** 관측 → 행 상태. (행·종류)마다 observedAt 이 가장 늦은 것을 쓴다(같으면 파일 뒤쪽). */
export function observationsToRowStates(records: readonly SpendObservation[]): LlmSpendRowState[] {
  const latest = new Map<string, SpendObservation>();
  for (const r of records) {
    const key = `${r.row}\u0000${r.kind}`;
    const prev = latest.get(key);
    if (!prev || Date.parse(r.observedAt) >= Date.parse(prev.observedAt)) latest.set(key, r);
  }
  const rows = new Map<string, LlmSpendRowState>();
  for (const r of latest.values()) {
    const base = rows.get(r.row) ?? { row: r.row, provider: r.provider };
    if (r.kind === 'window' && r.usedPct !== undefined) {
      rows.set(r.row, { ...base, window: { status: 'measured', usedPct: r.usedPct, ...(r.resetAt !== undefined ? { resetAt: r.resetAt } : {}), ...(r.slopePctPerHour !== undefined ? { slopePctPerHour: r.slopePctPerHour } : {}), source: r.source, observedAt: r.observedAt } });
    } else if (r.kind === 'balance' && r.usd !== undefined) {
      rows.set(r.row, { ...base, balance: { status: 'measured', usd: r.usd, totalCreditsUsd: r.usd, totalUsageUsd: 0, source: r.source, observedAt: r.observedAt } });
    } else if (r.kind === 'spend') {
      rows.set(r.row, { ...base, spend: { ...(r.todayUsd !== undefined ? { todayUsd: r.todayUsd } : {}), ...(r.monthUsd !== undefined ? { monthUsd: r.monthUsd } : {}), source: r.source, observedAt: r.observedAt } });
    } else if (r.kind === 'autoTopUp' && r.enabled !== undefined) {
      rows.set(r.row, { ...base, autoTopUp: { status: 'measured', enabled: r.enabled, ...(r.amountUsd !== undefined ? { amountUsd: r.amountUsd } : {}), source: r.source, observedAt: r.observedAt } });
    }
  }
  return [...rows.values()];
}

/** 읽기 단계 필터 — 합성(synthetic) 관측을 뺀다. 실 관문 observer 의 «기본» 이다. */
export function withoutSyntheticObservations(records: readonly SpendObservation[]): SpendObservation[] {
  return records.filter((r) => r.source !== 'synthetic');
}

export interface ObservationObserverOptions {
  /**
   * 합성 관측도 읽을지 — 호출 때마다 평가한다. 기본(생략) = false: 실 관문은 synthetic 을 «기본 무시».
   * 실 관문 배선(llm-call-live)만 «시험 우주 신원(getTestStateRoot)이 있을 때» true 를 돌려준다 — 이 옵션은 기능 스위치가 아니다.
   */
  readonly includeSynthetic?: () => boolean;
}

/** gate 의 기본 observer — 관측 저장소를 읽어 행 상태로 낸다. 대표 synthetic 은 기본 무시(읽기 단계에서 제외). */
export function createObservationObserver(policyDirOverride?: string, options: ObservationObserverOptions = {}): () => Promise<LlmSpendRowState[]> {
  return async () => {
    const records = await readSpendObservations(policyDirOverride);
    return observationsToRowStates(options.includeSynthetic?.() === true ? records : withoutSyntheticObservations(records));
  };
}
