// UX-SIM · LLM provider 시뮬 세계 — 장치 공통 계약 (LLM-AUTO-PROVIDER-E2E · 0.3.31)
//
// 대표 11-20 13:2x «시뮬레이션 장치 충분히 만들어서 LLM provider 자동화 진행» — 장치 먼저.
// ⛔ 전부 가짜 · 실 키/토큰/네트워크/호스트 0. 값은 어디에도 없다(이름·id·%·USD·시각만).
// ⛔ 장치 원장 = 넥서스 시뮬 장치 원장(src/nexus/api/ux-sim-devices.ts 계열 카탈로그) — 매뉴얼 목록 금지.
//    장치 하나 = catalog/sim-world-device-catalog-fragments/devices/<MD-id>.json 한 파일.
//
// 이 파일은 «장치들이 지켜야 할 모양»만 정한다. 구현은 장치 파일마다(각자 소유):
//   subscriptions.ts  — SimClock · codex 구독 ×3 · Claude 구독 ×2
//   credit-acp.ts     — OpenRouter 크레딧 · claude-acp 장치
//   supply-remote.ts  — 금고/공급 대상(pod·ta·config-dir) · 원격 호스트 heartbeat
//
// 장치가 내놓는 «관측»은 결정 함수가 먹는 LlmSpendRowState 와 같다(src/nexus/llm-spend-policy/types.ts)
// — 장치 → observe() → decideLlmSpend/runLlmSpendGuard 가 시뮬 세계의 한 길이다.

import type { LlmSpendRowState } from '../../nexus/llm-spend-policy/types.js';

/** 조작 가능한 시계 — 창 리셋·신선도 창을 «시간을 돌려» 시험한다. 모든 장치가 같은 시계를 공유한다. */
export interface SimClock {
  now(): Date;
  /** ms 만큼 앞으로. */
  advance(ms: number): void;
  /** 절대 시각으로(ISO · 시간대 표기 필수). */
  set(iso: string): void;
}

/** 장치 호출의 결과(가짜 공급자 응답) — 상태 코드와 «사람이 읽는 오류 문구»(비밀 0 시험 대상). */
export type SimCallResult =
  | { readonly ok: true; readonly device: string; readonly costUsd?: number }
  | { readonly ok: false; readonly device: string; readonly status: 401 | 402 | 429 | 503; readonly code: string; readonly message: string; readonly resetsAt?: string };

/** 모든 장치의 공통 면. */
export interface SimDevice {
  /** 장치 원장 id (MD-UX-SIM-… 와 1:1). */
  readonly deviceId: string;
  /** 결정 함수 정책 행 이름(codex-default·openrouter·claude-acp …). 해당 없으면 undefined. */
  readonly row?: string;
  /** 지금 상태를 결정 함수 입력 모양으로(값 0). 장치 헬스가 아닌 행은 undefined 를 돌려줄 수 있다. */
  observe(): LlmSpendRowState | undefined;
  /** 이 장치로 호출 한 번(가짜) — 창/잔액/장치 상태에 따라 ok 또는 429·402·503. */
  call(opts?: { readonly role?: string; readonly estimateUsd?: number; readonly model?: string }): SimCallResult;
}

/** 구독 장치(codex·Claude) — 창 사용 %·리셋 시각을 조작한다. */
export interface SimSubscriptionDevice extends SimDevice {
  /** 창 사용률을 직접 지정(0..100). */
  setUsedPct(window: 'five-hour' | 'weekly', pct: number): void;
  /** 한 창을 소진(100%)시키고 리셋 시각을 정한다(ISO). 이후 call() 은 429 usage_limit_reached + resetsAt. */
  exhaust(window: 'five-hour' | 'weekly', resetsAtIso: string): void;
  /** 시계가 리셋 시각을 지났으면 창이 0% 로 돌아간다(자동) — 시계 advance 뒤 observe() 에 반영. */
  readonly windows: () => ReadonlyArray<{ readonly name: 'five-hour' | 'weekly'; readonly usedPct: number; readonly resetsAt: string }>;
}

/** 유료 크레딧 장치(OpenRouter). */
export interface SimCreditDevice extends SimDevice {
  setBalanceUsd(usd: number): void;
  setSpendCap(cap: { readonly dailyUsd?: number; readonly monthlyUsd?: number }): void;
  setAutoTopUp(opts: { readonly enabled: boolean; readonly amountUsd?: number }): void;
  /** 잔액 < 호출 비용이면 402 insufficient_credits. 자동 충전 on 이면 충전 이벤트를 남기고 통과. */
  readonly events: () => ReadonlyArray<{ readonly at: string; readonly kind: 'topup' | 'insufficient' | 'charge'; readonly usd: number }>;
}

/** claude-acp 장치(호스트 전용). */
export interface SimAcpDevice extends SimDevice {
  readonly hostOnly: true;
  setAlive(alive: boolean): void;
  setSessions(n: number): void;
  readonly maxSessions: number;
}

/** 금고/공급 대상 — pod·ta·원격 config-dir. supply 는 값 없이 «이름·대상·TTL» 만 기록한다. */
export interface SimSupplyTarget {
  readonly deviceId: string;
  readonly kind: 'pod' | 'ta' | 'host' | 'config-dir';
  readonly name: string;
  /** 공급된 임대(이름·남은 TTL·어디) — 값 0. */
  leases(): ReadonlyArray<{ readonly vaultItem: string; readonly leaseId: string; readonly expiresAt: string }>;
  /** 공급 시도 — 허용 목록 밖이면 거부(사유 코드). */
  supply(vaultItem: string): { readonly ok: true; readonly leaseId: string } | { readonly ok: false; readonly reason: string };
  revoke(leaseId: string): void;
}

/** 원격 호스트 + heartbeat(desiredSha). */
export interface SimRemoteHost {
  readonly deviceId: string;
  readonly name: string;
  /** 마지막 heartbeat — desiredSha 와 observedSha 가 다르면 «어긋남». */
  heartbeat(): { readonly at: string; readonly desiredSha: string; readonly observedSha: string; readonly alive: boolean };
  setDesiredSha(sha: string): void;
  setObservedSha(sha: string): void;
  setAlive(alive: boolean): void;
}

/** 시뮬 세계 한 벌 — 시나리오가 받는 입구. 모든 장치가 한 시계를 공유한다. */
export interface LlmProviderWorld {
  readonly clock: SimClock;
  readonly codex: { readonly default: SimSubscriptionDevice; readonly team: SimSubscriptionDevice; readonly third: SimSubscriptionDevice };
  readonly claude: { readonly sub1: SimSubscriptionDevice; readonly sub2: SimSubscriptionDevice };
  readonly openrouter: SimCreditDevice;
  readonly acp: SimAcpDevice;
  readonly targets: { readonly pod: SimSupplyTarget; readonly ta: SimSupplyTarget; readonly configDir: SimSupplyTarget };
  readonly remote: SimRemoteHost;
  /** 정책 행 이름 → 장치(구독·크레딧·acp). 결정 함수 입력 states 를 만든다. */
  states(): LlmSpendRowState[];
}
