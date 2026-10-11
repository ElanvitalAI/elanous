// SUBSCRIPTION-EXHAUST-REROUTE (0.2.24) — 크레딧 예비분 ⊕ 넘김 = OpenRouter.
//   🩸 10-11: 구독 3계정 100% · 크레딧 29,401 · 하루 소모 25,132. 크레딧이 0 이 돼도 회전은 `credits-allowed` 로 codex 에 머문다.
//   계약: 잔액이 «알려져» 예비분 이하 → no-candidate → 폴백(우선 openrouter) · 예비분 초과 → 종전 · 모름 → 종전(fail-open).
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeQuotaSignal } from '../budget/codex-reset-credit-state.js';
import { debug } from '../debug/log.js';
import { decideCodexRotation } from './codex-account-rotation.js';
import { saveTokens } from './store.js';
import {
  _resetCodexRotationPinForTesting,
  _setRotationConfigReaderForTesting,
  CREDIT_RESERVE_OPENROUTER_MODEL,
  DEFAULT_CODEX_CREDIT_RESERVE,
  inspectCodexRotation,
  resolveRunFallback,
} from './codex-account-store.js';
import { planPodAccounts } from '../task-orchestrator/surfaces/pod-account-broker.js';
import { decideBudget, type DecideBudgetInput } from '../self-implement/budget-gate.js';

const current = { name: 'default', storeKey: 'openai-codex', home: '/h/default', source: 'default' } as const;
const decide = (balance: number | undefined, creditReserve: number | undefined) => decideCodexRotation({
  current: current as never, explicit: false, enabled: true, currentReached: true, currentUsedPercent: 100,
  resetCreditAvailability: 'unavailable', candidates: [], creditsAllowed: true,
  ...(balance === undefined ? {} : { currentCreditBalance: balance, currentHasCredits: true }),
  ...(creditReserve === undefined ? {} : { creditReserve }),
});

describe('decideCodexRotation — credit reserve', () => {
  test('잔액 ≤ 예비분 → no-candidate (넘김) ⊕ 근거 값', () => {
    expect(decide(1500, 2000)).toMatchObject({ reason: 'no-candidate', creditReserveHit: { balance: 1500, reserve: 2000 } });
    expect(decide(2000, 2000)).toMatchObject({ reason: 'no-candidate' });
    expect(decide(0, 0)).toMatchObject({ reason: 'no-candidate', creditReserveHit: { balance: 0, reserve: 0 } });
  });
  test('잔액 > 예비분 → 종전(credits-allowed)', () => {
    const d = decide(2001, 2000);
    expect(d.reason).toBe('credits-allowed');
    expect(d.creditReserveHit).toBeUndefined();
  });
  test('잔액 모름 → 종전(credits-allowed · fail-open)', () => {
    expect(decide(undefined, 2000).reason).toBe('credits-allowed');
  });
  test('예비분 미지정 → 종전 그대로(잔액 0 이어도 credits-allowed)', () => {
    expect(decide(0, undefined).reason).toBe('credits-allowed');
  });
  test('다른 계정이 예비분을 넘는 크레딧을 가지면 그쪽으로 옮긴다 · 예비분 이하 계정으로는 옮기지 않는다', () => {
    const other = (creditBalance: number) => ({ name: 'team', storeKey: 'openai-codex:team', home: '/h/team', reached: true, usedPercent: 100, creditBalance, hasCredits: true });
    const base = { current: current as never, explicit: false, enabled: true, currentReached: true, currentUsedPercent: 100,
      resetCreditAvailability: 'unavailable' as const, creditsAllowed: true, currentCreditBalance: 100, currentHasCredits: true, creditReserve: 2000 };
    expect(decideCodexRotation({ ...base, candidates: [other(9000)] })).toMatchObject({ reason: 'rotated', to: { name: 'team' } });
    expect(decideCodexRotation({ ...base, candidates: [other(1900)] })).toMatchObject({ reason: 'no-candidate', creditReserveHit: { balance: 100, reserve: 2000 } });
  });
});

describe('resolveRunFallback — 예비분 넘김 대상 = openrouter (운영 체인이 grok 이어도)', () => {
  const dirs: string[] = [];
  const savedHome = process.env.CODEX_HOME;
  const savedState = process.env.ELANOUS_STATE_DIR;
  afterEach(() => {
    _setRotationConfigReaderForTesting(null);
    _resetCodexRotationPinForTesting();
    if (savedHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedHome;
    if (savedState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = savedState;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const setup = (balance: number | undefined, llm: Record<string, unknown>) => {
    const root = mkdtempSync(join(tmpdir(), 'credit-reserve-'));
    dirs.push(root);
    process.env.ELANOUS_STATE_DIR = root;
    const home = join(root, 'codex-home');
    mkdirSync(home, { recursive: true });
    process.env.CODEX_HOME = home;
    const store = join(root, 'auth.json');
    saveTokens('openai-codex', { accessToken: 'a', refreshToken: 'r', expiresAt: null }, { mirrorCodex: false, codexHome: home }, store);
    writeQuotaSignal(undefined, 100, home, undefined, balance === undefined ? undefined : { balance, hasCredits: true });
    _setRotationConfigReaderForTesting(() => ({ llm: { codexQuotaPolicy: 'credits', fallbackChain: ['codex-rotate', 'grok'], ...llm } }));
    return store;
  };
  const run = (store: string) => {
    const logs: Array<{ category: string; event: string; data: any }> = [];
    const original = debug.log;
    (debug as any).log = (category: string, event: string, data: any) => { logs.push({ category, event, data }); };
    try {
      return { decision: resolveRunFallback(process.env, { storePath: store, grokAvailable: true, grokQuota: 'usable', openrouterAvailable: true }), logs };
    } finally { (debug as any).log = original; }
  };

  test('잔액 ≤ 예비분(기본 2000) → grok 이 아니라 openrouter/z-ai/glm-5.3 ⊕ credit-reserve-hit 관측', () => {
    const store = setup(1500, {});
    expect(inspectCodexRotation(process.env, { storePath: store })).toMatchObject({ reason: 'no-candidate', creditReserveHit: { balance: 1500, reserve: DEFAULT_CODEX_CREDIT_RESERVE } });
    const { decision, logs } = run(store);
    expect(decision).toEqual({ action: 'switch-backend', backend: 'openrouter', model: CREDIT_RESERVE_OPENROUTER_MODEL });
    expect(logs.find((l) => l.category === 'llm.codex' && l.event === 'credit-reserve-hit')?.data)
      .toMatchObject({ balance: 1500, reserve: 2000, next: 'openrouter', model: 'openrouter/z-ai/glm-5.3' });
  });

  test('설정 예비분 · 설정 OR 모델을 따른다', () => {
    const store = setup(4000, { codexCreditReserve: 5000, openrouter: { fallbackModel: 'openrouter/z-ai/glm-5.3-flash' } });
    expect(run(store).decision).toEqual({ action: 'switch-backend', backend: 'openrouter', model: 'openrouter/z-ai/glm-5.3-flash' });
  });

  test('잔액 > 예비분 → 종전(크레딧으로 머문다 · 체인 안 탐) · 관측 없음', () => {
    const store = setup(9000, {});
    const { decision, logs } = run(store);
    expect(decision).toEqual({ action: 'stay', why: 'not-reached' });
    expect(logs.some((l) => l.event === 'credit-reserve-hit')).toBe(false);
  });

  test('잔액 모름 → 종전', () => {
    const store = setup(undefined, {});
    expect(inspectCodexRotation(process.env, { storePath: store }).reason).toBe('credits-allowed');
    expect(run(store).decision).toEqual({ action: 'stay', why: 'not-reached' });
  });

  test('OpenRouter 키가 없으면 종전 체인의 다음 칸(grok)으로 — 넘김은 막지 않는다', () => {
    const store = setup(1500, {});
    const logs: string[] = [];
    const original = debug.log;
    (debug as any).log = (_c: string, e: string) => { logs.push(e); };
    try {
      expect(resolveRunFallback(process.env, { storePath: store, grokAvailable: true, grokQuota: 'usable', openrouterAvailable: false }))
        .toEqual({ action: 'switch-backend', backend: 'grok' });
    } finally { (debug as any).log = original; }
    expect(logs).toContain('credit-reserve-hit');
  });
});

describe('Pod 배분 · 발사 예산 관문도 같은 예비분을 본다', () => {
  const full = (name: string, creditBalance?: number) => ({ name, storeKey: `openai-codex:${name}`, home: `/h/${name}`, reached: true, usedPercent: 100,
    ...(creditBalance === undefined ? {} : { creditBalance, hasCredits: true }) });
  test('planPodAccounts: 예비분 이하(알려진 잔액) 계정은 크레딧 후보에서 빠진다 · 모르면 남는다 · 미지정이면 종전', () => {
    expect(planPodAccounts([full('a', 1500), full('b', 9000)], { creditsAllowed: true, creditReserve: 2000 }).usable).toEqual(['b']);
    expect(planPodAccounts([full('a', 1500)], { creditsAllowed: true, creditReserve: 2000 }).usable).toEqual([]);
    expect(planPodAccounts([full('a', 1500)], { creditsAllowed: true, creditReserve: 2000 }).excluded[0]?.why).toContain('reserve 2000');
    expect(planPodAccounts([full('a')], { creditsAllowed: true, creditReserve: 2000 }).usable).toEqual(['a']);
    expect(planPodAccounts([full('a', 1500)], { creditsAllowed: true }).usable).toEqual(['a']);
  });
  test('decideBudget: codex 크레딧 후보는 예비분 «초과»만', () => {
    const input = (codexCreditReserve?: number): DecideBudgetInput => ({
      preference: { chain: [{ provider: 'openai-codex' }], budgetGate: { onShortfall: 'next-provider' as const } },
      codexCandidates: [{ name: 'a', reached: true, usedPercent: 100, creditBalance: 1500, hasCredits: true }],
      grokUsedPercent: undefined, maxUsedPercent: { 'openai-codex': 95, grok: 80 } as never, codexCreditsAllowed: true,
      ...(codexCreditReserve === undefined ? {} : { codexCreditReserve }),
    });
    expect(decideBudget(input(2000)).action).toBe('stop');
    expect(decideBudget(input(1000)).action).toBe('proceed');
    expect(decideBudget(input()).action).toBe('proceed');
  });
});
