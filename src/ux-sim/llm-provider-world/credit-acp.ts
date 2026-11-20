// UX-SIM · LLM provider 시뮬 세계 — ③ OpenRouter 크레딧 장치 · ④ claude-acp 장치 (LLM-AUTO-PROVIDER-E2E)
//
// ⛔ 전부 가짜 · 실 키/토큰/네트워크/호스트 0. 값은 어디에도 없다(이름·%·USD·시각만).
// 시계는 장치 A(subscriptions.ts)가 구현한다 — 여기선 계약 SimClock 만 받는다.
// 장치 observe() 는 결정 함수가 먹는 LlmSpendRowState 를 그대로 만든다(src/nexus/llm-spend-policy/types.ts).

import type { LlmSpendPolicyRole, LlmSpendRowState } from '../../nexus/llm-spend-policy/types.js';
import { isLlmSpendPolicyRole } from '../../nexus/llm-spend-policy/types.js';
import type { SimAcpDevice, SimCallResult, SimClock, SimCreditDevice } from './contract.js';

const SOURCE = 'sim:llm-provider-world';

type CreditEvent = { readonly at: string; readonly kind: 'topup' | 'insufficient' | 'charge'; readonly usd: number };
type RoleSpend = { todayUsd: number; monthUsd: number };

const usd = (n: number): string => `$${n.toFixed(2)}`;

function assertFinite(name: string, n: number): void {
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a finite number >= 0`);
}

// ── ③ OpenRouter 크레딧 ─────────────────────────────────────────────────────────

export interface OpenRouterDevice extends SimCreditDevice {
  readonly row: 'openrouter';
  readonly deviceId: 'MD-UX-SIM-LLM-PROVIDER-WORLD-CREDIT-ACP-TS';
  /** 지금 설정된 지출 상한(정책 판정은 결정 함수 몫 — 장치는 보관·노출만 한다). */
  spendCap(): { readonly dailyUsd?: number; readonly monthlyUsd?: number };
}

export function createOpenRouterDevice(clock: SimClock, init: { readonly balanceUsd?: number } = {}): OpenRouterDevice {
  let balance = init.balanceUsd ?? 0;
  assertFinite('balanceUsd', balance);
  let totalCredits = balance;
  let totalUsage = 0;
  let cap: { dailyUsd?: number; monthlyUsd?: number } = {};
  let topUp: { enabled: boolean; amountUsd?: number } = { enabled: false };
  const events: CreditEvent[] = [];
  let today = 0;
  let month = 0;
  const byRole = new Map<LlmSpendPolicyRole, RoleSpend>();
  let dayKey = clock.now().toISOString().slice(0, 10);

  /** 시계가 날/달을 넘겼으면 그 누적을 0 으로(관측·호출 직전에 항상 호출). */
  const rollover = (): void => {
    const k = clock.now().toISOString().slice(0, 10);
    if (k === dayKey) return;
    const monthChanged = k.slice(0, 7) !== dayKey.slice(0, 7);
    today = 0;
    for (const v of byRole.values()) v.todayUsd = 0;
    if (monthChanged) {
      month = 0;
      for (const v of byRole.values()) v.monthUsd = 0;
    }
    dayKey = k;
  };
  const record = (kind: CreditEvent['kind'], amount: number): void => {
    events.push({ at: clock.now().toISOString(), kind, usd: amount });
  };

  return {
    deviceId: 'MD-UX-SIM-LLM-PROVIDER-WORLD-CREDIT-ACP-TS',
    row: 'openrouter',
    setBalanceUsd(v) {
      assertFinite('balanceUsd', v);
      if (v > balance) totalCredits += v - balance;
      balance = v;
    },
    setSpendCap(c) {
      for (const [k, v] of Object.entries(c)) if (v !== undefined) assertFinite(k, v);
      cap = { ...c };
    },
    setAutoTopUp(o) {
      if (o.amountUsd !== undefined) assertFinite('amountUsd', o.amountUsd);
      topUp = o.amountUsd === undefined ? { enabled: o.enabled } : { enabled: o.enabled, amountUsd: o.amountUsd };
    },
    spendCap: () => ({ ...cap }),
    events: () => events.map((e) => ({ ...e })),
    call(opts = {}): SimCallResult {
      rollover();
      const cost = opts.estimateUsd ?? 0;
      assertFinite('estimateUsd', cost);
      if (balance < cost && topUp.enabled && (topUp.amountUsd ?? 0) > 0) {
        const amount = topUp.amountUsd!;
        balance += amount;
        totalCredits += amount;
        record('topup', amount);
      }
      if (balance < cost) {
        record('insufficient', cost);
        return {
          ok: false, device: 'openrouter', status: 402, code: 'insufficient_credits',
          message: `OpenRouter credits insufficient: balance ${usd(balance)} is below call cost ${usd(cost)}`,
        };
      }
      balance -= cost;
      totalUsage += cost;
      today += cost;
      month += cost;
      if (opts.role !== undefined && isLlmSpendPolicyRole(opts.role)) {
        const r = byRole.get(opts.role) ?? { todayUsd: 0, monthUsd: 0 };
        r.todayUsd += cost;
        r.monthUsd += cost;
        byRole.set(opts.role, r);
      }
      record('charge', cost);
      return { ok: true, device: 'openrouter', costUsd: cost };
    },
    observe(): LlmSpendRowState {
      rollover();
      const observedAt = clock.now().toISOString();
      const roles: Partial<Record<LlmSpendPolicyRole, { todayUsd: number; monthUsd: number }>> = {};
      for (const [k, v] of byRole) roles[k] = { ...v };
      return {
        row: 'openrouter',
        provider: 'openrouter',
        balance: { status: 'measured', usd: balance, totalCreditsUsd: totalCredits, totalUsageUsd: totalUsage, source: SOURCE, observedAt },
        autoTopUp: topUp.amountUsd === undefined
          ? { status: 'measured', enabled: topUp.enabled, source: SOURCE, observedAt }
          : { status: 'measured', enabled: topUp.enabled, amountUsd: topUp.amountUsd, source: SOURCE, observedAt },
        spend: { todayUsd: today, monthUsd: month, byRole: roles, source: SOURCE, observedAt },
      };
    },
  };
}

// ── ④ claude-acp 장치(호스트 전용) ──────────────────────────────────────────────

export interface AcpWindow {
  readonly usedPct: number;
  readonly resetAt?: string;
}

export interface ClaudeAcpDevice extends SimAcpDevice {
  readonly row: 'claude-acp';
  readonly deviceId: 'MD-UX-SIM-LLM-PROVIDER-WORLD-CREDIT-ACP-TS';
  /** 구독 창 실측(capPct 관례는 정책 몫 — 장치는 %·리셋 시각만 보관). null 이면 창 미주입. */
  setWindow(w: AcpWindow | null): void;
  sessions(): number;
  isAlive(): boolean;
}

export function createAcpDevice(clock: SimClock, opts: { readonly maxSessions: number }): ClaudeAcpDevice {
  const maxSessions = opts.maxSessions;
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error('maxSessions must be an integer >= 1');
  let alive = true;
  let sessions = 0;
  let window: AcpWindow | null = null;

  return {
    deviceId: 'MD-UX-SIM-LLM-PROVIDER-WORLD-CREDIT-ACP-TS',
    row: 'claude-acp',
    hostOnly: true,
    maxSessions,
    setAlive(v) { alive = v; },
    setSessions(n) {
      if (!Number.isInteger(n) || n < 0) throw new Error('sessions must be an integer >= 0');
      sessions = n;
    },
    setWindow(w) {
      if (w !== null && (!Number.isFinite(w.usedPct) || w.usedPct < 0 || w.usedPct > 100)) throw new Error('usedPct must be within 0..100');
      window = w;
    },
    sessions: () => sessions,
    isAlive: () => alive,
    call(): SimCallResult {
      if (!alive) {
        return { ok: false, device: 'claude-acp', status: 503, code: 'device_down', message: 'claude-acp device is down on the host' };
      }
      if (sessions >= maxSessions) {
        return {
          ok: false, device: 'claude-acp', status: 503, code: 'session_limit',
          message: `claude-acp session limit reached: ${sessions} of ${maxSessions} sessions in use`,
        };
      }
      return { ok: true, device: 'claude-acp' };
    },
    observe(): LlmSpendRowState {
      const observedAt = clock.now().toISOString();
      const base = { row: 'claude-acp', provider: 'claude-acp', device: { status: 'measured', alive, sessions, observedAt } } as const;
      if (window === null) return base;
      return {
        ...base,
        window: window.resetAt === undefined
          ? { status: 'measured', usedPct: window.usedPct, source: SOURCE, observedAt }
          : { status: 'measured', usedPct: window.usedPct, resetAt: window.resetAt, source: SOURCE, observedAt },
      };
    },
  };
}
