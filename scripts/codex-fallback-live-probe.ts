#!/usr/bin/env bun
// 운영 config 의 실물 회전 이유를 실물 decideFallback 에 먹인다 (READ-ONLY).
//
// ⛔ 이유를 손으로 박지 않는다 — `provider codex status --json` 의 `rotation.reason` 이 정본이다.
// ⛔ 체인·grok 자격도 가정하지 않는다 — 운영 config.json 과 resolveGrokCredential() 이 정본이다.
// ⛔ grok 잔량은 운영 budget 캐시만 읽는다 — 없으면 unknown 이고, 그때 판정은 조건부다.
// ⛔ 회전을 고정하지 않는다 · 리셋권을 쓰지 않는다 · 관측을 남기지 않는다 · 네트워크를 직접 치지 않는다.
//    `provider codex status` 가 이미 그 규율의 표면이다.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  decideFallback,
  grokQuotaFromUsageSnapshot,
  normalizeFallbackChain,
  type FallbackDecision,
  type FallbackStep,
  type RotationOutcome,
  type StayReason,
} from '../src/oauth/fallback-chain.js';
import {
  codexStoreKey,
  isValidAccountName,
} from '../src/oauth/codex-account.js';
import type { RotationCandidate } from '../src/oauth/codex-account-rotation.js';
import { resolveGrokCredential } from '../src/grok/credential.js';

const STAY_REASONS = ['explicit', 'disabled', 'not-reached', 'reset-credit-available', 'no-candidate'] as const;
type StayRotationReason = (typeof STAY_REASONS)[number];

export type GrokQuotaValue = 'usable' | 'exhausted' | 'unknown';
export type GrokQuotaSource = 'usage-store-cache' | 'unconfirmed';

export type LiveStatusRotation = {
  readonly reason?: unknown;
  readonly to?: unknown;
};

export type GrokQuotaProbeFields = {
  readonly grokQuota: GrokQuotaValue;
  readonly grokQuotaSource: GrokQuotaSource;
  readonly grokQuotaConfirmed: boolean;
  readonly decisionConditional: boolean;
};

export type LiveProbeInputs = {
  readonly liveReason: string;
  readonly chain: readonly FallbackStep[];
  readonly chainSource: 'config' | 'default';
  readonly grokAvailable: boolean;
  readonly grokAvailableSource: 'resolveGrokCredential';
} & GrokQuotaProbeFields;

export type LiveProbeLine = LiveProbeInputs & (
  | { readonly action: 'stay'; readonly why: StayReason; readonly backend?: never; readonly to?: never }
  | { readonly action: 'switch-backend'; readonly backend: 'grok' | 'claude' | 'openrouter'; readonly model?: string; readonly why?: never; readonly to?: never }
  | { readonly action: 'codex-rotate'; readonly to: string; readonly why?: never; readonly backend?: never }
  | { readonly action: 'codex-credits'; readonly to?: string; readonly why?: never; readonly backend?: never }
) & { readonly inputKind: 'live' };

function isStayRotationReason(value: string): value is StayRotationReason {
  return (STAY_REASONS as readonly string[]).includes(value);
}

function rotationTargetName(to: unknown): string {
  if (typeof to !== 'string' || to.length === 0 || !isValidAccountName(to)) {
    throw new Error(`rotation.to missing or invalid: ${JSON.stringify(to)}`);
  }
  return to;
}

/** status JSON 의 rotation 을 decideFallback 입력으로. 대상이 없거나 형식이 아니면 오류. */
export function rotationFromLive(reason: string, to: unknown): RotationOutcome {
  if (reason === 'rotated' || reason === 'reset-credit-unknown') {
    const name = rotationTargetName(to);
    const candidate: RotationCandidate = {
      name,
      storeKey: codexStoreKey(name),
      home: '',
      reached: undefined,
    };
    return { reason, to: candidate };
  }
  if (isStayRotationReason(reason)) return { reason };
  throw new Error(`unknown rotation.reason: ${reason}`);
}

export function readLiveFallbackChain(configDir: string): {
  readonly chain: readonly FallbackStep[];
  readonly chainSource: 'config' | 'default';
} {
  let fallbackChain: unknown;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && 'llm' in parsed) {
      const llm = (parsed as { llm?: { fallbackChain?: unknown } }).llm;
      fallbackChain = llm?.fallbackChain;
    }
  } catch {
    fallbackChain = undefined;
  }
  const { chain, usedDefault } = normalizeFallbackChain(fallbackChain);
  return { chain, chainSource: usedDefault ? 'default' : 'config' };
}

export function liveGrokAvailable(): boolean {
  return resolveGrokCredential() !== null;
}

/** 운영 budget 캐시 스냅샷 → 폴백이 쓰는 잔량. 없으면 미확인 unknown (네트워크 안 침). */
export function grokQuotaProbeFromSnapshot(snapshot: unknown): GrokQuotaProbeFields {
  if (snapshot == null || typeof snapshot !== 'object') {
    return {
      grokQuota: 'unknown',
      grokQuotaSource: 'unconfirmed',
      grokQuotaConfirmed: false,
      decisionConditional: true,
    };
  }
  const grokQuota = grokQuotaFromUsageSnapshot(snapshot as never);
  const grokQuotaConfirmed = grokQuota === 'usable' || grokQuota === 'exhausted';
  return {
    grokQuota,
    grokQuotaSource: 'usage-store-cache',
    grokQuotaConfirmed,
    decisionConditional: !grokQuotaConfirmed,
  };
}

export function readLiveGrokQuota(stateDir = join(homedir(), '.elanous')): GrokQuotaProbeFields {
  try {
    const raw = readFileSync(join(stateDir, 'budget', 'state.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const snapshot = parsed && typeof parsed === 'object' && 'snapshots' in parsed
      ? (parsed as { snapshots?: { grok?: unknown } }).snapshots?.grok
      : undefined;
    return grokQuotaProbeFromSnapshot(snapshot);
  } catch {
    return grokQuotaProbeFromSnapshot(undefined);
  }
}

export function parseLiveReason(parsed: { rotation?: LiveStatusRotation }): {
  readonly liveReason: string;
  readonly to: unknown;
} {
  const liveReason = parsed.rotation?.reason;
  if (typeof liveReason !== 'string' || liveReason.length === 0) {
    throw new Error('rotation.reason 이 없다');
  }
  return { liveReason, to: parsed.rotation?.to };
}

export function decideLiveFallback(
  liveReason: string,
  to: unknown,
  chain: readonly FallbackStep[],
  grokAvailable: boolean,
  grokQuota: GrokQuotaValue,
): FallbackDecision {
  return decideFallback({
    rotation: rotationFromLive(liveReason, to),
    chain,
    grokAvailable,
    grokQuota,
  });
}

export function probeLine(
  inputs: LiveProbeInputs,
  decision: FallbackDecision,
): LiveProbeLine {
  switch (decision.action) {
    case 'stay':
      return { ...inputs, action: 'stay', why: decision.why, inputKind: 'live' };
    case 'switch-backend':
      return { ...inputs, action: 'switch-backend', backend: decision.backend, inputKind: 'live' };
    case 'codex-rotate':
      return { ...inputs, action: 'codex-rotate', to: decision.to.name, inputKind: 'live' };
    case 'codex-credits':
      return { ...inputs, action: 'codex-credits', ...(decision.to ? { to: decision.to.name } : {}), inputKind: 'live' };
  }
}

/** status CLI 출력에서 JSON 객체만 잘라 읽는다. 선행 로그가 있어도 이유를 손으로 박지 않는다. */
export function parseStatusJson(raw: string): { rotation?: LiveStatusRotation } {
  const start = raw.search(/[{[]/);
  if (start < 0) throw new Error('provider codex status --json 이 JSON 을 안 냈다');
  return JSON.parse(raw.slice(start)) as { rotation?: LiveStatusRotation };
}

/** 엔트리포인트 합성 — status JSON ⊕ 운영 체인 ⊕ grok 자격/잔량 → 한 줄 JSON. */
export function composeLiveProbeLine(
  statusRaw: string,
  chain: readonly FallbackStep[],
  chainSource: 'config' | 'default',
  grokAvailable: boolean,
  quota: GrokQuotaProbeFields,
): LiveProbeLine {
  const { liveReason, to } = parseLiveReason(parseStatusJson(statusRaw));
  const decision = decideLiveFallback(liveReason, to, chain, grokAvailable, quota.grokQuota);
  return probeLine({
    liveReason,
    chain,
    chainSource,
    grokAvailable,
    grokAvailableSource: 'resolveGrokCredential',
    ...quota,
  }, decision);
}

export function emitLiveProbeLine(line: LiveProbeLine): string {
  return `${JSON.stringify(line)}\n`;
}

function main(): void {
  const repoRoot = join(import.meta.dir, '..');
  const configDir = join(homedir(), '.elanous');
  const raw = execFileSync('bun', [
    'bin/elanous.mjs', 'provider', 'codex', 'status', '--json', '--config-dir', configDir,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  const { chain, chainSource } = readLiveFallbackChain(configDir);
  const grokAvailable = liveGrokAvailable();
  const quota = readLiveGrokQuota(configDir);
  process.stdout.write(emitLiveProbeLine(
    composeLiveProbeLine(raw, chain, chainSource, grokAvailable, quota),
  ));
}

if (import.meta.main) main();
