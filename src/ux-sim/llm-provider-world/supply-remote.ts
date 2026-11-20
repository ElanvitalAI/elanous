// UX-SIM · LLM provider 시뮬 세계 — 장치 C: 금고/공급 대상 + 원격 호스트 heartbeat (LLM-AUTO-PROVIDER-E2E)
//
// ⛔ 전부 가짜 · 실 키/토큰/네트워크/호스트 0 · 값 0(이름·leaseId·시각만). config-dir 은 실제 파일을 쓰지 않고 메모리 모델.
// 거부 사유 이름은 실제 src/secret/supply.ts 와 같다: host-only-item · item-not-allowed · target-not-allowed · handler-unwired.
// (실제 supply 에는 'claude-acp-host-only' 라는 이름이 없다 — claude-acp 의 pod/ta 거부는 'host-only-item'.)

import type { SimClock, SimRemoteHost, SimSupplyTarget } from './contract.js';

export type SupplyRefusal = 'host-only-item' | 'item-not-allowed' | 'target-not-allowed' | 'handler-unwired';

/** 코드 상수 — host 가 아니면 못 받는 항목(supply.ts HOST_ONLY_ITEMS 와 같다). */
const HOST_ONLY_ITEMS: readonly string[] = ['claude-acp'];

/** 항목 → 공급 허용 대상 종류(정책 시늉). */
export type SimSupplyPolicy = Readonly<Record<string, ReadonlyArray<SimSupplyTarget['kind']>>>;

export const DEFAULT_SUPPLY_POLICY: SimSupplyPolicy = {
  'codex-default': ['host', 'config-dir'],
  'codex-team': ['pod', 'ta', 'host', 'config-dir'],
  'claude-acp': ['host', 'config-dir'],
};

/** 임대 TTL 기본값. */
export const SUPPLY_LEASE_TTL_MS = 3_600_000; // 출처: LLM-AUTO-PROVIDER-E2E 시뮬 장치

export interface SimSupplyTargetDevice extends SimSupplyTarget {
  /** 이 대상의 주입기 배선 여부(pod/ta 의 Secret 주입기) — false 면 허용 항목도 handler-unwired. */
  setWired(wired: boolean): void;
  /** Secret 마운트 꼴 또는 0600 파일 꼴 — 값 없이 모양만. */
  readonly shape: { readonly mount: 'secret-volume' | 'file'; readonly mode?: number };
}

function makeTarget(
  clock: SimClock,
  deviceId: string,
  kind: SimSupplyTarget['kind'],
  name: string,
  shape: SimSupplyTargetDevice['shape'],
  policy: SimSupplyPolicy,
  ttlMs: number,
): SimSupplyTargetDevice {
  let wired = true;
  let seq = 0;
  const rows = new Map<string, { vaultItem: string; expiresAtMs: number }>();
  const live = () => {
    const t = clock.now().getTime();
    for (const [id, r] of rows) if (r.expiresAtMs <= t) rows.delete(id);
  };
  return {
    deviceId, kind, name, shape,
    setWired(w) { wired = w; },
    leases() {
      live();
      return [...rows].map(([leaseId, r]) => ({ vaultItem: r.vaultItem, leaseId, expiresAt: new Date(r.expiresAtMs).toISOString() }));
    },
    supply(vaultItem) {
      if (HOST_ONLY_ITEMS.includes(vaultItem) && (kind === 'pod' || kind === 'ta')) return { ok: false, reason: 'host-only-item' };
      const allowed = policy[vaultItem];
      if (!allowed) return { ok: false, reason: 'item-not-allowed' };
      if (!allowed.includes(kind)) return { ok: false, reason: 'target-not-allowed' };
      if ((kind === 'pod' || kind === 'ta') && !wired) return { ok: false, reason: 'handler-unwired' };
      const leaseId = `${deviceId}-lease-${++seq}`;
      rows.set(leaseId, { vaultItem, expiresAtMs: clock.now().getTime() + ttlMs });
      return { ok: true, leaseId };
    },
    revoke(leaseId) { rows.delete(leaseId); },
  };
}

export interface SimSupplyTargets {
  readonly pod: SimSupplyTargetDevice;
  readonly ta: SimSupplyTargetDevice;
  readonly configDir: SimSupplyTargetDevice;
}

/** pod:<Job> · ta:<카드>(같은 Pod 경로) · config-dir(0600 파일 꼴) 가짜 3종. */
export function createSupplyTargets(
  clock: SimClock,
  opts: { readonly policy?: SimSupplyPolicy; readonly ttlMs?: number; readonly job?: string; readonly card?: string; readonly dir?: string } = {},
): SimSupplyTargets {
  const policy = opts.policy ?? DEFAULT_SUPPLY_POLICY;
  const ttl = opts.ttlMs ?? SUPPLY_LEASE_TTL_MS;
  return {
    pod: makeTarget(clock, 'MD-UX-SIM-LLM-SUPPLY-TARGETS-TS:pod', 'pod', `pod:${opts.job ?? 'job-1'}`, { mount: 'secret-volume' }, policy, ttl),
    ta: makeTarget(clock, 'MD-UX-SIM-LLM-SUPPLY-TARGETS-TS:ta', 'ta', `ta:${opts.card ?? 'card-1'}`, { mount: 'secret-volume' }, policy, ttl),
    configDir: makeTarget(clock, 'MD-UX-SIM-LLM-SUPPLY-TARGETS-TS:config-dir', 'config-dir', opts.dir ?? '/sim/config-dir', { mount: 'file', mode: 0o600 }, policy, ttl),
  };
}

export interface SimRemoteHostDevice extends SimRemoteHost {
  /** desiredSha ≠ observedSha 이면 true(어긋남). */
  drifted(): boolean;
}

/** 원격 호스트 + heartbeat — at 은 시계 now(). */
export function createRemoteHost(clock: SimClock, name: string): SimRemoteHostDevice {
  let desiredSha = '';
  let observedSha = '';
  let alive = true;
  return {
    deviceId: 'MD-UX-SIM-LLM-REMOTE-HOST-TS',
    name,
    heartbeat() { return { at: clock.now().toISOString(), desiredSha, observedSha, alive }; },
    setDesiredSha(sha) { desiredSha = sha; },
    setObservedSha(sha) { observedSha = sha; },
    setAlive(a) { alive = a; },
    drifted() { return desiredSha !== observedSha; },
  };
}
