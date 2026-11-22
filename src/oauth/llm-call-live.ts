// LLM 호출 관문 «실경로» 배선 헬퍼 — streamLLM 합류점이 부른다. (LLM-AUTO-PROVIDER-E2E)
//
// 대표 11-18 정책: 옵션·깃발·단계 스위치 0. 켜짐 = «이 우주에 정책 정본(policy.yaml)이 있다».
//   · 정책 없음 → gateLlmCall 이 pass-through(원장 observe 1줄) → 호출부는 아무것도 바꾸지 않는다.
//   · 정책 있음 → 가드 적용(행 선택 · 멈춤). 있는데 깨짐 → 멈춤(policy-unreadable).
//   되돌림 = 정책 파일 제거(또는 되돌리기 PR).
// ⛔ 이 헬퍼는 금고 임대를 «공급» 하지 않는다 — 임대 상태는 observers 슬롯(시험은 주입)이 낸다. 임대 없는 행은 결정 함수가 «불가» 로 처리한다.

import { join } from 'node:path';
import { getTestStateRoot } from '../nexus/paths.js';
import { readStoredSpendPolicy } from '../nexus/llm-spend-policy/store.js';
import { appendSpendTransition, llmSpendPolicyDir } from '../nexus/llm-spend-policy/ledger.js';
import {
  appendSpendObservation, createObservationObserver, type SpendObservation,
} from '../nexus/llm-spend-policy/observations.js';
import { isLlmSpendPolicyRole, type LlmSpendPolicyRole } from '../nexus/llm-spend-policy/types.js';
import { createCreditRowStateObserver, type CreditAdapterDeps } from '../nexus/llm-spend-policy/credit-adapter.js';
import { managementLeasesForSpend } from './llm-call-live-lease-source.js';
import {
  gateLlmCall, readPolicyFromStore, type LlmCallGateDeps, type LlmCallGateRequest, type LlmCallGateResult, type LlmSignalRecord,
} from './llm-call-gate.js';
import { createFileGuardStore } from './llm-spend-guard.js';
import { createFileReservationLedger } from './llm-spend-reservation.js';

/** 합성 id 가 아닌 «실제 관측» id. */
function realObservationId(record: LlmSignalRecord): string {
  return `real-${record.row}-${record.signal.kind}-${Date.parse(record.at)}`;
}

/** settle 의 실제 신호 → 관측 저장소 기록(source 'real'). 429 usage_limit_reached = 창 소진 · 402 = 잔액 0. */
export function signalToObservation(record: LlmSignalRecord): SpendObservation {
  const base = { id: realObservationId(record), row: record.row, provider: record.provider, source: 'real' as const, observedAt: record.at, event: record.signal.kind };
  return record.signal.kind === 'usage_limit_reached'
    ? { ...base, kind: 'window', usedPct: 100, ...(record.signal.resetsAt !== undefined ? { resetAt: record.signal.resetsAt } : {}) }
    : { ...base, kind: 'balance', usd: 0 };
}

const passThroughObserved = new Set<string>();

/** 기본 배선 deps — 파일 기억·예약 원장·전환 원장·관측 저장소(모두 넥서스 데이터 영역). 시험은 overrides 로 덮는다. */
export async function defaultLiveGateDeps(
  policyDir?: string,
  extra: { credit?: CreditAdapterDeps } = {},
): Promise<LlmCallGateDeps> {
  const dir = await llmSpendPolicyDir(policyDir);
  // CC-1 잔액 어댑터 관측기(LLM-POLICY-OR-MANAGEMENT-LEASE) — «임대가 실제로 주입된» 경우에만 관측기 목록에 들어간다.
  //   임대 값이 하나도 없으면 관측기를 붙이지 않는다(= 기존 observers 그대로 → 결정·출력 계약 영향 0 · 네트워크 0).
  //   ⛔ 임대는 «주입 경계» — 이 헬퍼는 금고를 스스로 조회하지 않는다(관리 키 발급은 HITL 대기).
  const observers = [createObservationObserver(policyDir, { includeSynthetic: () => getTestStateRoot() !== undefined })];
  const credit = extra.credit;
  if (credit !== undefined && Object.values(credit.leases ?? {}).some((lease) => typeof lease === 'string' && lease.length > 0)) {
    observers.push(createCreditRowStateObserver(() => readPolicyFromStore(policyDir), credit));
  }
  return {
    readPolicy: () => readPolicyFromStore(policyDir),
    // 대표 합성 관측은 «시험 우주 신원» 일 때만 읽는다(운영 신원 = 기본 무시). 호출마다 평가.
    observers,
    memory: createFileGuardStore(join(dir, 'guard-memory.json')),
    reservations: createFileReservationLedger(join(dir, 'reservations.json')),
    appendLedger: async (entry) => {
      // 정책 없는 우주의 pass-through observe 줄은 프로세스당 1줄만 — 호출마다 쌓지 않는다(핫패스 I/O·원장 부풀음 방지).
      if (entry.action === 'observe' && entry.what === 'pass-through') {
        if (passThroughObserved.has(dir)) return;
        passThroughObserved.add(dir);
      }
      await appendSpendTransition(entry, policyDir);
    },
    now: () => new Date(),
    lowBalanceMailer: async (mail) => {
      const { openMsgStore } = await import('../msg/msg-store.js');
      const store = openMsgStore();
      let id: number;
      try { id = store.post({ from: 'LLM-GATE', to: 'OP', kind: 'llm-low-balance', intent: 'alert', body: `${mail.subject}\n${mail.body}` }).id; } finally { store.close(); }
      // 깨움은 기다리지 않는다 — 관문(모든 LLM 호출의 길)이 깨움 지연에 묶이지 않게. 우편은 이미 영속이라 실패해도 무시.
      void import('../loops/msg-wake.js').then((m) => m.wakeRecipient('OP', id, { from: 'LLM-GATE', kind: 'llm-low-balance' })).catch(() => undefined);
    },
    recordSignal: async (record) => { await appendSpendObservation(signalToObservation(record), policyDir); },
  };
}

/** streamLLM 의 usageRole → 지출 정책 역할. 정책 역할이 아니면 authoring(기본 역할 절). */
export function spendRoleFor(usageRole: string | undefined): LlmSpendPolicyRole {
  return isLlmSpendPolicyRole(usageRole) ? usageRole : 'authoring';
}

/** 행 이름 → codex 계정 이름(ELANOUS_CODEX_ACCOUNT 입력). `codex-team` → `team` · `codex-default` → `default`. */
export function codexAccountNameForRow(row: string): string | undefined {
  const m = /^codex-([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(row);
  return m ? m[1] : undefined;
}

/** 관문 호출 — 기본 deps 위에 overrides 를 얹는다. gate 가 던지지 않지만 deps 구성 실패도 «통과» 로 접지 않는다(정책 있으면 멈춤). */
export async function runLiveGate(
  request: LlmCallGateRequest,
  overrides: Partial<LlmCallGateDeps> & { policyDir?: string; credit?: CreditAdapterDeps } = {},
): Promise<LlmCallGateResult> {
  const { policyDir, credit, ...rest } = overrides;
  // #17 production 조달: credit 을 명시하지 않은 호출(사용자가 치는 그대로)도 금고 static lease 사본에서
  // 관리 키를 조달해 관측기에 넣는다. 임대 없으면 빈 위임 → 관측기 0(missing-management-lease · 네트워크 0).
  const creditResolved = credit ?? { leases: managementLeasesForSpend() };
  const deps = { ...(await defaultLiveGateDeps(policyDir, { credit: creditResolved })), ...rest };
  return gateLlmCall(request, deps);
}

/**
 * 관문 «자체» 오류(락 오류·기억 저장 실패·deps 구성 실패 — gate 가 던진 것)의 처분.
 *   · 정책 정본 없음 → 통과(정책 없는 우주 = 지금 동작 그대로).
 *   · 정책 정본 있음(또는 있는지 못 읽음) → 멈춤(fail-closed) + 원장 `gate-error` 줄. «가드 없이 호출» 은 없다.
 */
export async function gateErrorOutcome(error: unknown, opts: { policyDir?: string; actor?: string; now?: () => Date } = {}): Promise<LlmCallGateResult> {
  let present = true; // 정책 유무조차 못 읽으면 «있다» 로 본다(fail-closed)
  try { present = (await readStoredSpendPolicy(opts.policyDir)).present; } catch { present = true; }
  if (!present) return { outcome: 'pass-through', ledgerLines: [], skipped: [] };
  const reason = `gate-error(관문 오류 — 정책이 있는 우주라 fail-closed 멈춤): ${error instanceof Error ? error.message : String(error)}`;
  const entry = { at: (opts.now?.() ?? new Date()).toISOString(), actor: opts.actor ?? 'stream-llm', action: 'decision' as const, what: 'stop', from: null, to: null, reason };
  const ledgerLines = [];
  try { await appendSpendTransition(entry, opts.policyDir); ledgerLines.push(entry); } catch { /* 원장 실패도 멈춤은 그대로 */ }
  return { outcome: 'stop', reason, ledgerLines, skipped: [] };
}
