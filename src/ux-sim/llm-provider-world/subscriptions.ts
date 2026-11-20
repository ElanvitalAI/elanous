// UX-SIM · LLM provider 시뮬 세계 — 구독 장치 (LLM-AUTO-PROVIDER-E2E · 0.3.31)
//
// ⑤ SimClock · ① codex 구독 ×3 · ② Claude 구독 ×2. 전부 가짜 — 실 키/토큰/네트워크 0, 값 0.
// 출력(observe·call 문구)에는 이름·id·%·시각만 나온다. observe() 가 결정 함수 입력 LlmSpendRowState 를 만든다.

import type { LlmSpendRowState, SubscriptionWindowState, VaultLeaseState } from '../../nexus/llm-spend-policy/types.js';
import type { SimClock, SimCallResult, SimSubscriptionDevice } from './contract.js';

export const SIM_SUBSCRIPTIONS_DEVICE_ID = 'MD-UX-SIM-LLM-PROVIDER-WORLD-SUBSCRIPTIONS-TS'; // SimClock 도 이 장치에 묶는다

type WindowName = 'five-hour' | 'weekly';

const TZ_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i;

/** 시간대(Z 또는 ±hh:mm)가 붙은 ISO 만 받는다 — 시간대 없는 시각은 시계를 조용히 어긋나게 한다. */
function parseIsoWithZone(iso: string, what: string): number {
  if (typeof iso !== 'string' || !TZ_SUFFIX.test(iso.trim())) throw new Error(`${what}: ISO 시각에 시간대(Z 또는 ±hh:mm)가 필요하다`);
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`${what}: ISO 시각을 읽을 수 없다`);
  return ms;
}

/** 조작 가능한 시계. startIso 는 시간대 표기 필수. */
export function createSimClock(startIso: string): SimClock {
  let ms = parseIsoWithZone(startIso, 'createSimClock');
  return {
    now: () => new Date(ms),
    advance(delta: number) {
      if (!Number.isFinite(delta) || delta < 0) throw new Error('advance: 0 이상의 ms 만 앞으로 갈 수 있다');
      ms += delta;
    },
    set(iso: string) { ms = parseIsoWithZone(iso, 'set'); },
  };
}

const WINDOW_LEN_MS: Record<WindowName, number> = {
  'five-hour': 5 * 3_600_000, // 출처: LLM-AUTO-PROVIDER-E2E 시뮬 장치 (5h 창 길이)
  weekly: 7 * 24 * 3_600_000, // 출처: LLM-AUTO-PROVIDER-E2E 시뮬 장치 (주간 창 길이)
};
const DEFAULT_LEASE_TTL_MS = 3_600_000; // 출처: LLM-AUTO-PROVIDER-E2E 시뮬 장치 (기본 임대 TTL 1h)

interface WindowSlot { usedPct: number; resetsAtMs: number }

/** 시뮬 구독 장치 구현체 — 장치 위에 lease 슬롯(이름만) 조작면이 더 있다. */
export interface SimSubscriptionAccount extends SimSubscriptionDevice {
  /** 금고 임대 슬롯(이름·id·만료만 — 값 0). */
  setLease(lease: { readonly leaseId: string; readonly expiresAt: string }): void;
  /** 임대 없음(결정 함수는 이 행을 못 쓴다 · fail-closed). */
  clearLease(reason?: string): void;
}

interface AccountSpec { readonly deviceId: string; readonly row: string; readonly provider: string; readonly windows: readonly WindowName[] }

function createAccount(clock: SimClock, spec: AccountSpec): SimSubscriptionAccount {
  const slots = new Map<WindowName, WindowSlot>();
  for (const name of spec.windows) slots.set(name, { usedPct: 0, resetsAtMs: clock.now().getTime() + WINDOW_LEN_MS[name] });
  let lease: VaultLeaseState | undefined; // undefined = 기본 임대(시계 기준 TTL)

  /** 시계가 리셋 시각을 지났으면 0% 로 복귀하고 다음 리셋을 한 창 길이씩 민다. */
  const sync = (): void => {
    const now = clock.now().getTime();
    for (const [name, slot] of slots) {
      if (now < slot.resetsAtMs) continue;
      slot.usedPct = 0;
      const len = WINDOW_LEN_MS[name];
      slot.resetsAtMs += Math.ceil((now - slot.resetsAtMs + 1) / len) * len;
    }
  };
  const slotOf = (name: WindowName): WindowSlot => {
    const s = slots.get(name);
    if (!s) throw new Error(`${spec.row}: 이 계정에 ${name} 창이 없다`);
    return s;
  };
  const windows = () => {
    sync();
    return [...slots].map(([name, s]) => ({ name, usedPct: s.usedPct, resetsAt: new Date(s.resetsAtMs).toISOString() }));
  };
  /** 가장 찬 창(동률이면 앞 창)이 «이 계정의 창» 실측이다. */
  const binding = () => {
    const all = windows();
    return all.reduce((a, b) => (b.usedPct > a.usedPct ? b : a));
  };

  return {
    deviceId: spec.deviceId,
    row: spec.row,
    windows,
    setUsedPct(name, pct) {
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new Error('setUsedPct: 0..100 만');
      sync();
      slotOf(name).usedPct = pct;
    },
    exhaust(name, resetsAtIso) {
      const at = parseIsoWithZone(resetsAtIso, 'exhaust');
      sync();
      const s = slotOf(name);
      s.usedPct = 100;
      s.resetsAtMs = at;
    },
    setLease(l) { parseIsoWithZone(l.expiresAt, 'setLease'); lease = { leaseId: l.leaseId, expiresAt: l.expiresAt }; },
    clearLease(reason = 'sim-lease-cleared') { lease = { leaseId: null, reason }; },
    observe(): LlmSpendRowState {
      const now = clock.now();
      const w = binding();
      const window: SubscriptionWindowState = {
        status: 'measured', usedPct: w.usedPct, resetAt: w.resetsAt, source: `sim:${w.name}`, observedAt: now.toISOString(),
      };
      const l: VaultLeaseState = lease ?? { leaseId: `sim-lease-${spec.row}`, expiresAt: new Date(now.getTime() + DEFAULT_LEASE_TTL_MS).toISOString() };
      return { row: spec.row, provider: spec.provider, window, lease: l };
    },
    call(): SimCallResult {
      const full = windows().filter((w) => w.usedPct >= 100);
      if (full.length === 0) return { ok: true, device: spec.deviceId };
      // 모든 소진 창이 풀려야 다시 쓴다 → 가장 늦은 리셋.
      const resetsAt = full.map((w) => w.resetsAt).sort().at(-1) as string;
      return {
        ok: false, device: spec.deviceId, status: 429, code: 'usage_limit_reached',
        message: `The usage limit has been reached (${spec.row}: ${full.map((w) => w.name).join('+')}). Resets at ${resetsAt}.`,
        resetsAt,
      };
    },
  };
}

/** codex 구독 ×3 — 정책 행 codex-default · codex-team · codex-third. 창 5h·주간. */
export function createCodexSubscriptions(clock: SimClock): { readonly default: SimSubscriptionAccount; readonly team: SimSubscriptionAccount; readonly third: SimSubscriptionAccount } {
  const mk = (row: string) => createAccount(clock, { deviceId: SIM_SUBSCRIPTIONS_DEVICE_ID, row, provider: 'openai-codex', windows: ['five-hour', 'weekly'] });
  return { default: mk('codex-default'), team: mk('codex-team'), third: mk('codex-third') };
}

/** Claude 구독 ×2 — 행 claude-code-sub · claude-code-sub-2. 5h·주간 두 창, 한 창이라도 100% 면 소진. */
export function createClaudeSubscriptions(clock: SimClock): { readonly sub1: SimSubscriptionAccount; readonly sub2: SimSubscriptionAccount } {
  const mk = (row: string) => createAccount(clock, { deviceId: SIM_SUBSCRIPTIONS_DEVICE_ID, row, provider: 'anthropic', windows: ['five-hour', 'weekly'] });
  return { sub1: mk('claude-code-sub'), sub2: mk('claude-code-sub-2') };
}
