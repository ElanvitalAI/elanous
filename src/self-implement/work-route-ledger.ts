// HARNESS-DIFFICULTY-ROUTER — 코어 결정 원장 쓰기(가벼운 모듈 · 골 저작기 의존 없음).
// 결정 한 줄 → logs.db(`harness.route-decision/decision`) ⊕ 런 원장(event `harness.route-decision`). fail-soft.
// ⚠️ `round` 칸은 싣지 않는다 — `usage outcomes` 는 data.round 로 라운드를 센다.

import type { CoreDecisionLedgerRecord, CoreMode } from '../model-tier/orchestration-core.js';
import type { UserConfig } from '../user-config/schema.js';
import { debug } from '../debug/log.js';
import type { RunLedgerEntry } from './run-ledger.js';

export const WORK_ROUTE_LEDGER_EVENT = 'harness.route-decision';

/** 생략·무효값 = shadow. `on` 만 적용한다. */
export function resolveWorkRouteMode(config: Pick<UserConfig, 'harness'> | undefined): CoreMode {
  return config?.harness?.difficultyRouter === 'on' ? 'on' : 'shadow';
}

export interface WorkRouteLedgerDeps {
  readonly append?: (entry: RunLedgerEntry) => void;
  readonly log?: (category: string, event: string, data: Record<string, unknown>) => void;
}

export async function recordWorkRouteDecision(record: CoreDecisionLedgerRecord, deps: WorkRouteLedgerDeps = {}): Promise<boolean> {
  const runId = record.runId.trim();
  if (!runId) return false;
  const { runId: _omit, ...data } = record;
  const log = deps.log ?? ((category, event, payload) => debug.log(category, event, payload));
  try { log(WORK_ROUTE_LEDGER_EVENT, 'decision', { runId, ...data }); } catch { /* observation is fail-soft */ }
  try {
    const append = deps.append ?? (await import('./run-ledger.js')).appendRunLedgerEntry;
    append({ timestamp: new Date().toISOString(), runId, event: WORK_ROUTE_LEDGER_EVENT, data: { ...data } });
    return true;
  } catch (error) {
    try { log(WORK_ROUTE_LEDGER_EVENT, 'ledger-write-failed', { runId, error: error instanceof Error ? error.name : 'unknown' }); } catch { /* fail-soft */ }
    return false;
  }
}
