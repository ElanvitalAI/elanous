// UX-SIM · LLM provider 시뮬 세계 — 한 벌 조립기 (LLM-AUTO-PROVIDER-E2E · 0.3.31)
//
// ⛔ 전부 가짜 · 실 키/토큰/네트워크/호스트 0. 시계 하나(SimClock)를 모든 장치가 공유한다.
// states() 가 정책 행 이름 → 장치 observe() 모음(LlmSpendRowState[])이다 — 결정 함수·가드가 먹는 입력 그대로.

import type { LlmSpendRowState } from '../../nexus/llm-spend-policy/types.js';
import type { LlmProviderWorld } from './contract.js';
import { createAcpDevice, createOpenRouterDevice, type ClaudeAcpDevice, type OpenRouterDevice } from './credit-acp.js';
import {
  createClaudeSubscriptions, createCodexSubscriptions, createSimClock, type SimSubscriptionAccount,
} from './subscriptions.js';
import {
  createRemoteHost, createSupplyTargets, type SimRemoteHostDevice, type SimSupplyPolicy, type SimSupplyTargets,
} from './supply-remote.js';

export const DEFAULT_WORLD_START_ISO = '2026-11-20T00:00:00Z';
const DEFAULT_ACP_MAX_SESSIONS = 4; // 출처: LLM-AUTO-PROVIDER-E2E 시뮬 장치 (기본 정책 claude-acp maxSessions 와 같은 값)

const DEFAULT_LEASE_TTL_MS = 3_600_000; // 출처: LLM-AUTO-PROVIDER-E2E 시뮬 장치 (기본 임대 TTL 1h)

export interface LlmProviderWorldOptions {
  /** 시계 시작(ISO · 시간대 필수). 기본 2026-11-20T00:00:00Z. */
  readonly startIso?: string;
  /** OpenRouter 시작 잔액(USD). 기본 0. */
  readonly balanceUsd?: number;
  /** claude-acp 동시 세션 상한. 기본 4. */
  readonly acpMaxSessions?: number;
  /** 금고 항목 → 공급 허용 대상 종류(없으면 supply-remote 기본). */
  readonly supplyPolicy?: SimSupplyPolicy;
  readonly remoteHostName?: string;
}

/** 계약의 LlmProviderWorld 에 장치별 구체 조작면을 더한 모양. */
export interface SimLlmProviderWorld extends LlmProviderWorld {
  readonly codex: { readonly default: SimSubscriptionAccount; readonly team: SimSubscriptionAccount; readonly third: SimSubscriptionAccount };
  readonly claude: { readonly sub1: SimSubscriptionAccount; readonly sub2: SimSubscriptionAccount };
  readonly openrouter: OpenRouterDevice;
  readonly acp: ClaudeAcpDevice;
  readonly targets: SimSupplyTargets;
  readonly remote: SimRemoteHostDevice;
}

export function createLlmProviderWorld(opts: LlmProviderWorldOptions = {}): SimLlmProviderWorld {
  const clock = createSimClock(opts.startIso ?? DEFAULT_WORLD_START_ISO);
  const codex = createCodexSubscriptions(clock);
  const claude = createClaudeSubscriptions(clock);
  const openrouter = createOpenRouterDevice(clock, { balanceUsd: opts.balanceUsd ?? 0 });
  const acp = createAcpDevice(clock, { maxSessions: opts.acpMaxSessions ?? DEFAULT_ACP_MAX_SESSIONS });
  const targets = createSupplyTargets(clock, opts.supplyPolicy === undefined ? {} : { policy: opts.supplyPolicy });
  const remote = createRemoteHost(clock, opts.remoteHostName ?? 'sim-remote-host');
  return {
    clock, codex, claude, openrouter, acp, targets, remote,
    states(): LlmSpendRowState[] {
      // 크레딧·acp 장치는 임대 슬롯이 없다 — 세계가 «이름만» 있는 기본 임대(시계 기준 1h)를 붙인다(구독 장치는 자기 슬롯 그대로).
      const expiresAt = new Date(clock.now().getTime() + DEFAULT_LEASE_TTL_MS).toISOString();
      return [codex.default, codex.team, codex.third, claude.sub1, claude.sub2, openrouter, acp]
        .map((device) => device.observe())
        .filter((state): state is LlmSpendRowState => state !== undefined)
        .map((state) => (state.lease === undefined ? { ...state, lease: { leaseId: `sim-lease-${state.row}`, expiresAt } } : state));
    },
  };
}
