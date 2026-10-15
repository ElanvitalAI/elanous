// CREDIT-BILLING-LABEL(10-14) — 회전이 크레딧 소진을 정한 codex 호출은 `llm.usage` 가 `billing='credit'` 이다.
// 🩸 운영: credits-allowed 로 default 크레딧을 쓰는데 usage 는 subscription · included($0) 로 남았다.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAvailabilityState, writeQuotaSignal } from '../budget/codex-reset-credit-state.js';
import { debug } from '../debug/log.js';
import { logAgentTurnUsage } from '../llm.js';
import { _resetCodexBillingDecisionForTesting, codexCreditSpendReason } from './codex-billing-route.js';
import {
  _resetCodexRotationPinForTesting,
  _setCodexAccountOutboundSenderForTesting,
  _setRotationConfigReaderForTesting,
  resolveCodexAccountForRun,
} from './codex-account-store.js';
import { saveTokens } from './store.js';

const ENV_KEYS = ['ELANOUS_STATE_DIR', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'ELANOUS_CODEX_ACCOUNT', 'ELANOUS_RUN_ID'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _setRotationConfigReaderForTesting(null);
  _setCodexAccountOutboundSenderForTesting(null);
  _resetCodexRotationPinForTesting();
  _resetCodexBillingDecisionForTesting();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** default 계정 하나 · 주간 사용률 `usedPercent` · 크레딧 허가 정책. */
function fixture(usedPercent: number, credits?: { balance?: number; hasCredits?: boolean }) {
  const root = mkdtempSync(join(tmpdir(), 'codex-credit-billing-'));
  dirs.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  process.env.XDG_CONFIG_HOME = root;
  delete process.env.ELANOUS_CODEX_ACCOUNT;
  delete process.env.ELANOUS_RUN_ID;
  const home = join(root, 'default-home');
  mkdirSync(home, { recursive: true });
  process.env.CODEX_HOME = home;
  const store = join(root, 'elanous', 'auth.json');
  saveTokens('openai-codex', { accessToken: 'a', refreshToken: 'r', expiresAt: null }, { mirrorCodex: false, codexHome: home }, store);
  writeQuotaSignal(undefined, usedPercent, home, undefined, credits);
  writeAvailabilityState(0, home);
  _setRotationConfigReaderForTesting(() => ({ llm: { codexCreditsAllowed: true } }));
  _setCodexAccountOutboundSenderForTesting(() => true);
  return {
    root, store,
    env: { CODEX_HOME: home } as NodeJS.ProcessEnv,
    deps: { storePath: store, counterPath: join(root, 'budget', 'codex-credit-spend-alert.json') },
  };
}

function usageRowAfterTurn(): Record<string, unknown> {
  const rows: Array<Record<string, unknown>> = [];
  const spy = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'llm.usage' && event === 'llm-usage') rows.push((data ?? {}) as Record<string, unknown>);
  });
  try {
    logAgentTurnUsage('gpt-6-sol', { inputTokens: 1200, outputTokens: 300 }, { providerName: 'openai-codex' });
  } finally {
    spy.mockRestore();
  }
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

test('credits-allowed 판정 뒤의 codex 턴은 usage 에 billing=credit · cost.kind=credit 로 남는다', () => {
  const t = fixture(100);
  resolveCodexAccountForRun(t.env, t.deps);
  const row = usageRowAfterTurn();
  expect(row).toMatchObject({ billingProvider: 'openai-codex', billing: 'credit' });
  expect(row.cost).toMatchObject({ kind: 'credit', usd: null });
});

test('구독 한도 안이면 종전대로 billing=subscription · cost.kind=included', () => {
  const t = fixture(40);
  resolveCodexAccountForRun(t.env, t.deps);
  const row = usageRowAfterTurn();
  expect(row).toMatchObject({ billingProvider: 'openai-codex', billing: 'subscription' });
  expect(row.cost).toMatchObject({ kind: 'included', usd: 0 });
});

test('크레딧 판정 뒤 한도 안 판정이 오면 credit 표지가 남지 않는다', () => {
  const t = fixture(100);
  resolveCodexAccountForRun(t.env, t.deps);
  writeQuotaSignal(undefined, 40, t.env.CODEX_HOME!);
  resolveCodexAccountForRun(t.env, t.deps);
  expect(usageRowAfterTurn()).toMatchObject({ billing: 'subscription' });
});

test('같은 런 안에서 다시 해석해도 크레딧 과금 경로를 잇는다', () => {
  const t = fixture(100);
  process.env.ELANOUS_RUN_ID = 'run-credit-pin';
  const env = { ...t.env, ELANOUS_RUN_ID: 'run-credit-pin' } as NodeJS.ProcessEnv;
  resolveCodexAccountForRun(env, t.deps);
  _resetCodexBillingDecisionForTesting();
  resolveCodexAccountForRun(env, t.deps);
  expect(usageRowAfterTurn()).toMatchObject({ billing: 'credit' });
});

test('credits-rotated — 크레딧이 더 많은 다른 계정으로 옮긴 호출도 credit 으로 남는다', () => {
  // default 는 한도·크레딧 모두 바닥 · team 은 한도 100% 지만 크레딧이 예비분(기본 2000)을 넘는다 → rotated ⊕ creditEntry.
  const t = fixture(100, { balance: 0, hasCredits: false });
  const teamHome = join(t.root, 'team-home');
  mkdirSync(teamHome, { recursive: true });
  saveTokens('openai-codex:team', { accessToken: 'b', refreshToken: 's', expiresAt: null }, { mirrorCodex: false, codexHome: teamHome }, t.store);
  writeQuotaSignal(undefined, 100, teamHome, undefined, { balance: 5000, hasCredits: true });
  writeAvailabilityState(0, teamHome);
  expect(resolveCodexAccountForRun(t.env, t.deps).name).toBe('team');
  expect(codexCreditSpendReason()).toBe('credits-rotated');
  const row = usageRowAfterTurn();
  expect(row).toMatchObject({ billing: 'credit' });
  expect(row.cost).toMatchObject({ kind: 'credit', usd: null });
});

test('credit-pace — 하루 크레딧 몫을 쓰는 판정도 credit 으로 남는다', () => {
  const t = fixture(100, { balance: 500, hasCredits: true });
  // config-dir 은 state-dir 을 따른다 — 정책 파일에 크레딧 사용 ⊕ 기한을 둔다.
  mkdirSync(join(t.root, 'policy'), { recursive: true });
  const until = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  writeFileSync(join(t.root, 'policy', 'llm.yaml'), `credits:\n  codex: use\n  pace:\n    targetPerDay: 1\n    until: '${until}'\n`);
  resolveCodexAccountForRun(t.env, t.deps);
  expect(codexCreditSpendReason()).toBe('credit-pace');
  const row = usageRowAfterTurn();
  expect(row).toMatchObject({ billing: 'credit' });
  expect(row.cost).toMatchObject({ kind: 'credit', usd: null });
});
