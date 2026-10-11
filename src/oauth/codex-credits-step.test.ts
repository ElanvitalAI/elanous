// CODEX-CREDITS-STEP — 체인 마지막 칸 `codex-credits` 계약(0.2.24 P0).
//
// 대표/OP 10-10: 정책 `fallback`(크레딧 ✗)이면 codex 가 다 찼을 때 grok 으로 간다. 그 grok 마저 못 쓰면
//   갈 곳이 없었다 ⇒ grok «뒤»에 `codex-credits` 를 두면 그때만 codex 를 선불 크레딧으로 쓴다.
//
// 불변식(이 스위트가 문다):
//   ① 기본 체인은 그대로 `['codex-rotate','grok']` — 크레딧 칸은 «명시»할 때만.
//   ② 회전이 쓸 계정을 냈으면 무변경(뒤 칸에 안 간다).   ③ grok 이 쓸 수 있으면 무변경.
//   ④ 정책 credits(옛 codexCreditsAllowed=true)면 무변경 — 회전이 이미 크레딧에 머문다(not-reached 로 접힌다).
//   ⑤ 잔액을 «모르면» 크레딧 칸을 건너뛴다(돈 · fail-closed).   ⑥ 모르는 이름은 종전처럼 버린다.
//   ⑦ 칸에 닿을 때마다 관측 한 줄(oauth.fallback-chain / codex-credits-step) — 이유 포함 · 비밀 없음.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import {
  DEFAULT_FALLBACK_CHAIN,
  decideFallback,
  describeFallback,
  normalizeFallbackChain,
  type FallbackStep,
} from './fallback-chain.js';
import type { RotationCandidate } from './codex-account-rotation.js';
import {
  _resetCodexRotationPinForTesting,
  _setCodexAccountOutboundSenderForTesting,
  _setGrokCredentialPresentForTesting,
  _setRotationConfigReaderForTesting,
  codexCreditAccountNames,
  resolveCodexAccountForRun,
  resolveRunFallback,
  rotatedCodexChildEnv,
} from './codex-account-store.js';
import { saveTokens } from './store.js';
import { writeQuotaSignal } from '../budget/codex-reset-credit-state.js';
import { providerNamesFromFallbackChain } from '../session-runtime/retry-policy.js';
import { chainFromFallbackNames } from '../self-implement/child-llm-preference.js';
import { decideBudget, decideLaunchBudget, type DecideBudgetInput } from '../self-implement/budget-gate.js';
import { planPodProvider } from '../task-orchestrator/surfaces/pod-account-broker.js';
import { codexBackend, decideRuntimeFallback, initialRuntimeFallback, resolveBackendSpawn } from '../agent-mission/driver.js';

const CHAIN: readonly FallbackStep[] = ['codex-rotate', 'grok', 'codex-credits'];
const CAND: RotationCandidate = { name: 'team', storeKey: 'openai-codex:team', home: '/h/team', reached: undefined };

describe('fallback-chain — codex-credits 칸', () => {
  test('① 기본 체인은 그대로 · 칸은 명시하면 유효 · 모르는 이름은 종전처럼 버린다', () => {
    expect([...DEFAULT_FALLBACK_CHAIN]).toEqual(['codex-rotate', 'grok']);
    expect(normalizeFallbackChain(undefined).chain).toEqual(['codex-rotate', 'grok']);
    expect(normalizeFallbackChain(['codex-rotate', 'grok', 'codex-credits']))
      .toEqual({ chain: ['codex-rotate', 'grok', 'codex-credits'], dropped: [], usedDefault: false });
    expect(normalizeFallbackChain(['codex-rotate', 'codex-credit', 'grok']).dropped).toEqual(['codex-credit']);
  });

  test('codex 전부 참(no-candidate) ⊕ grok 소진 ⊕ 잔액 확인 → codex-credits (건너뛴 이유를 값으로)', () => {
    const d = decideFallback({ rotation: { reason: 'no-candidate' }, chain: CHAIN, grokAvailable: true, grokQuota: 'exhausted', codexCreditsAvailable: true });
    expect(d).toEqual({ action: 'codex-credits', skipped: [{ step: 'grok', why: 'grok-exhausted' }] });
    expect(describeFallback(d)).toContain('크레딧');
  });

  test('grok 자격 없음도 건너뛰어 codex-credits', () => {
    expect(decideFallback({ rotation: { reason: 'no-candidate' }, chain: CHAIN, grokAvailable: false, codexCreditsAvailable: true }))
      .toEqual({ action: 'codex-credits', skipped: [{ step: 'grok', why: 'grok-unavailable' }] });
  });

  test('③ grok 이 쓸 수 있으면 무변경(grok) — unknown 도 종전처럼 통과', () => {
    for (const grokQuota of ['usable', 'unknown'] as const) {
      expect(decideFallback({ rotation: { reason: 'no-candidate' }, chain: CHAIN, grokAvailable: true, grokQuota, codexCreditsAvailable: true }))
        .toEqual({ action: 'switch-backend', backend: 'grok' });
    }
  });

  test('② 회전이 쓸 계정을 냈으면 무변경(codex-rotate)', () => {
    expect(decideFallback({ rotation: { reason: 'rotated', to: CAND }, chain: CHAIN, grokAvailable: false, codexCreditsAvailable: true }))
      .toEqual({ action: 'codex-rotate', to: CAND });
  });

  test('④ 회전이 한도 안이거나 크레딧에 머문다(not-reached)면 체인을 안 탄다', () => {
    expect(decideFallback({ rotation: { reason: 'not-reached' }, chain: CHAIN, grokAvailable: false, codexCreditsAvailable: true }))
      .toEqual({ action: 'stay', why: 'not-reached' });
  });

  test('⑤ 잔액을 모르거나 없으면 건너뛰고 이유를 남긴다(돈 · fail-closed)', () => {
    for (const codexCreditsAvailable of [undefined, false]) {
      expect(decideFallback({ rotation: { reason: 'no-candidate' }, chain: CHAIN, grokAvailable: true, grokQuota: 'exhausted', ...(codexCreditsAvailable === undefined ? {} : { codexCreditsAvailable }) }))
        .toEqual({ action: 'stay', why: 'codex-credits-unavailable' });
    }
  });

  test('칸이 없는 체인은 종전 그대로(grok 소진 → grok-exhausted 로 머문다)', () => {
    expect(decideFallback({ rotation: { reason: 'no-candidate' }, chain: ['codex-rotate', 'grok'], grokAvailable: true, grokQuota: 'exhausted', codexCreditsAvailable: true }))
      .toEqual({ action: 'stay', why: 'grok-exhausted' });
  });

  test('런타임: grok 이 한도 오류로 죽으면 다음 칸 codex-credits', () => {
    expect(decideFallback({ rotation: { reason: 'not-reached' }, chain: CHAIN, grokAvailable: true, currentStep: 'grok', currentCredentialRateLimited: true, codexCreditsAvailable: true }))
      .toEqual({ action: 'codex-credits', skipped: [] });
  });
});

describe('resolveRunFallback — 칸에 닿으면 관측 한 줄', () => {
  const dirs: string[] = [];
  const originalPolicyEnv = process.env.ELANOUS_CODEX_QUOTA_POLICY;
  const originalState = process.env.ELANOUS_STATE_DIR;
  const originalHome = process.env.CODEX_HOME;
  afterEach(() => {
    _setRotationConfigReaderForTesting(null);
    if (originalPolicyEnv === undefined) delete process.env.ELANOUS_CODEX_QUOTA_POLICY; else process.env.ELANOUS_CODEX_QUOTA_POLICY = originalPolicyEnv;
    if (originalState === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = originalState;
    if (originalHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = originalHome;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const run = (llm: Record<string, unknown>) => {
    delete process.env.ELANOUS_CODEX_QUOTA_POLICY;
    const root = mkdtempSync(join(tmpdir(), 'codex-credits-step-'));
    dirs.push(root);
    process.env.ELANOUS_STATE_DIR = root;
    process.env.CODEX_HOME = join(root, 'codex-home');
    _setRotationConfigReaderForTesting(() => ({ llm }));
    const logs: Array<{ category: string; event: string; data: any }> = [];
    const original = debug.log;
    (debug as any).log = (category: string, event: string, data: any) => { logs.push({ category, event, data }); };
    try {
      const decision = resolveRunFallback(process.env, {
        storePath: join(root, 'store.json'), grokAvailable: true, grokQuota: 'usable', codexCreditsAvailable: true,
        currentStep: 'grok', currentCredentialRateLimited: true,
      });
      return { decision, step: logs.find((l) => l.category === 'oauth.fallback-chain' && l.event === 'codex-credits-step')?.data };
    } finally { (debug as any).log = original; }
  };

  test('⑦ grok 한도 오류 → codex-credits ⊕ 관측(정책·현재 칸·이유)', () => {
    const { decision, step } = run({ codexQuotaPolicy: 'fallback', fallbackChain: ['codex-rotate', 'grok', 'codex-credits'] });
    expect(decision.action).toBe('codex-credits');
    expect(step).toMatchObject({ quotaPolicy: 'fallback', currentStep: 'grok', credentialRateLimited: true, chain: ['codex-rotate', 'grok', 'codex-credits'] });
    expect(JSON.stringify(step)).not.toMatch(/token|accessToken|refresh/i);
  });

  test('정책 within-quota 는 크레딧 칸을 쓰지 않는다(관측도 없다)', () => {
    const { decision, step } = run({ codexQuotaPolicy: 'within-quota', fallbackChain: ['codex-rotate', 'grok', 'codex-credits'] });
    expect(decision.action).toBe('stay');
    expect(step).toBeUndefined();
  });

  test('codexCreditAccountNames — 잔액이 확인된 계정만', () => {
    expect(codexCreditAccountNames([
      { ...CAND, name: 'a', creditBalance: 10 },
      { ...CAND, name: 'b', creditBalance: 0 },
      { ...CAND, name: 'c' },
      { ...CAND, name: 'd', creditBalance: 5, hasCredits: false },
      { ...CAND, name: 'e', home: '', creditBalance: 5 },
    ])).toEqual(['a']);
  });
});

describe('실제 계정 선택 — 주입 없이 스토어·신호에서 (GOODHART 반증)', () => {
  const dirs: string[] = [];
  const saved = { policy: process.env.ELANOUS_CODEX_QUOTA_POLICY, state: process.env.ELANOUS_STATE_DIR, home: process.env.CODEX_HOME, run: process.env.ELANOUS_RUN_ID, acct: process.env.ELANOUS_CODEX_ACCOUNT };
  afterEach(() => {
    _setRotationConfigReaderForTesting(null);
    _setGrokCredentialPresentForTesting(null);
    _setCodexAccountOutboundSenderForTesting(null);
    _resetCodexRotationPinForTesting();
    for (const [key, value] of [['ELANOUS_CODEX_QUOTA_POLICY', saved.policy], ['ELANOUS_STATE_DIR', saved.state], ['CODEX_HOME', saved.home], ['ELANOUS_RUN_ID', saved.run], ['ELANOUS_CODEX_ACCOUNT', saved.acct]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** 두 계정 모두 주간 100% · default 잔액 100 · team 잔액 4000(신호 파일로). */
  // `reserve` = llm.codexCreditReserve. The fixtures below predate the reserve (SUBSCRIPTION-EXHAUST-REROUTE) and pin it to 0;
  // `null` leaves the key out so the code default applies.
  const fleet = (chain: string[], balances: { default?: number; team?: number } = { default: 100, team: 4000 }, reserve: number | null = 0) => {
    delete process.env.ELANOUS_CODEX_QUOTA_POLICY;
    delete process.env.ELANOUS_RUN_ID;
    delete process.env.ELANOUS_CODEX_ACCOUNT;
    _setCodexAccountOutboundSenderForTesting(() => true);
    const root = mkdtempSync(join(tmpdir(), 'codex-credits-fleet-'));
    dirs.push(root);
    process.env.ELANOUS_STATE_DIR = root;
    const defaultHome = join(root, 'default-home');
    const teamHome = join(root, 'team-home');
    for (const h of [defaultHome, teamHome]) mkdirSync(h, { recursive: true });
    process.env.CODEX_HOME = defaultHome;
    const store = join(root, 'auth.json');
    const t = { accessToken: 'a', refreshToken: 'r', expiresAt: null };
    saveTokens('openai-codex', t, { mirrorCodex: false, codexHome: defaultHome }, store);
    saveTokens('openai-codex:team', t, { mirrorCodex: false, codexHome: teamHome }, store);
    writeQuotaSignal('weekly', 100, defaultHome, undefined, balances.default === undefined ? undefined : { balance: balances.default, hasCredits: true });
    writeQuotaSignal('weekly', 100, teamHome, undefined, balances.team === undefined ? undefined : { balance: balances.team, hasCredits: true });
    _setRotationConfigReaderForTesting(() => ({ llm: { codexQuotaPolicy: 'fallback', fallbackChain: chain, ...(reserve !== null ? { codexCreditReserve: reserve } : {}) } }));
    return { store, defaultHome, teamHome };
  };
  const capture = <T>(fn: () => T) => {
    const logs: Array<{ category: string; event: string; data: any }> = [];
    const original = debug.log;
    (debug as any).log = (category: string, event: string, data: any) => { logs.push({ category, event, data }); };
    try { return { value: fn(), steps: logs.filter((l) => l.category === 'oauth.fallback-chain' && l.event === 'codex-credits-step').map((l) => l.data) }; }
    finally { (debug as any).log = original; }
  };

  test('grok 자격 없음 ⊕ 칸 있음 → 회전이 잔액 많은 team 을 고르고 자식 CODEX_HOME 도 team · 관측 outcome=credits', () => {
    const { store, defaultHome, teamHome } = fleet(['codex-rotate', 'grok', 'codex-credits']);
    _setGrokCredentialPresentForTesting(() => false);
    const { value, steps } = capture(() => resolveCodexAccountForRun({ CODEX_HOME: defaultHome }, { storePath: store }));
    expect(value.name).toBe('team');
    expect(steps).toEqual([expect.objectContaining({ site: 'rotation', outcome: 'credits', to: 'team', skipped: [{ step: 'grok', why: 'grok-unavailable' }], creditAccountCount: 2 })]);
    _resetCodexRotationPinForTesting();
    expect(capture(() => rotatedCodexChildEnv({ CODEX_HOME: defaultHome }, { storePath: store })).value.CODEX_HOME).toBe(teamHome);
  });

  test('무변경 — 칸이 없으면 no-candidate(크레딧 ✗) · grok 자격이 있으면 grok 몫(크레딧 ✗)', () => {
    const a = fleet(['codex-rotate', 'grok']);
    _setGrokCredentialPresentForTesting(() => false);
    const noStep = capture(() => resolveCodexAccountForRun({ CODEX_HOME: a.defaultHome }, { storePath: a.store }));
    expect(noStep.value.name).toBe('default');
    expect(noStep.steps).toEqual([]);
    _resetCodexRotationPinForTesting();
    const b = fleet(['codex-rotate', 'grok', 'codex-credits']);
    _setGrokCredentialPresentForTesting(() => true);
    const grokFirst = capture(() => resolveCodexAccountForRun({ CODEX_HOME: b.defaultHome }, { storePath: b.store }));
    expect(grokFirst.value.name).toBe('default');
    expect(grokFirst.steps).toEqual([]);
    expect(capture(() => resolveRunFallback(process.env, { storePath: b.store, grokQuota: 'usable' })).value).toEqual({ action: 'switch-backend', backend: 'grok' });
  });

  test('실제 재시도 진입점: grok 캐시 unknown ⊕ grok 429 ⊕ 현재 계정 잔액 0 · team 잔액 → 자식 codex 의 CODEX_HOME = team', () => {
    const { store, defaultHome, teamHome } = fleet(['codex-rotate', 'grok', 'codex-credits'], { default: 0, team: 4000 });
    _setGrokCredentialPresentForTesting(() => true);   // 자격은 있고 캐시는 «모른다» — 회전 단계에선 칸에 안 닿는다
    const rateLimited = new Error('429 rate limit exceeded: usage limit reached');
    const state = { attemptedSteps: new Set<FallbackStep>(['codex-rotate', 'grok']), descents: 1, maxDescents: 2 };
    const { value: backend, steps } = capture(() => decideRuntimeFallback(rateLimited, 'grok', state,
      (input) => resolveRunFallback({ ...process.env, CODEX_HOME: defaultHome }, { storePath: store, ...input })));
    expect(backend?.name).toBe('codex');
    expect(resolveBackendSpawn(backend!, { CODEX_HOME: defaultHome, HOME: '/h' }).env.CODEX_HOME).toBe(teamHome);
    expect(steps).toEqual(expect.arrayContaining([expect.objectContaining({ site: 'chain', outcome: 'credits', to: 'team', currentStep: 'grok', credentialRateLimited: true })]));
  });

  test('명시 계정이면 그 계정 잔액만 본다 — 다른 계정 잔액으로 칸을 열지 않는다', () => {
    const rate = { currentStep: 'grok' as const, currentCredentialRateLimited: true as const };
    const a = fleet(['codex-rotate', 'grok', 'codex-credits'], { default: 0, team: 4000 });
    _setGrokCredentialPresentForTesting(() => true);
    const env = { ...process.env, CODEX_HOME: a.defaultHome, ELANOUS_CODEX_ACCOUNT: 'default' };
    expect(capture(() => resolveRunFallback(env, { storePath: a.store, ...rate })).value).toEqual({ action: 'stay', why: 'codex-credits-unavailable' });
    const b = fleet(['codex-rotate', 'grok', 'codex-credits'], { default: 50, team: 4000 });
    _setGrokCredentialPresentForTesting(() => true);
    const ok = capture(() => resolveRunFallback({ ...process.env, CODEX_HOME: b.defaultHome, ELANOUS_CODEX_ACCOUNT: 'default' }, { storePath: b.store, ...rate })).value;
    expect(ok.action).toBe('codex-credits');
    expect(ok.action === 'codex-credits' ? ok.to?.name : 'x').toBe('default');   // 계정은 안 바꾼다(명시 계정 그대로)
  });

  test('예비분(기본 2000) — 잔액이 예비분 이하인 계정으로는 칸을 열지 않는다 · 넘는 계정만 고른다', () => {
    const rate = { currentStep: 'grok' as const, currentCredentialRateLimited: true as const };
    const a = fleet(['codex-rotate', 'grok', 'codex-credits'], { default: 1500, team: 1900 }, null);
    _setGrokCredentialPresentForTesting(() => true);
    expect(capture(() => resolveRunFallback({ ...process.env, CODEX_HOME: a.defaultHome }, { storePath: a.store, ...rate })).value)
      .toEqual({ action: 'stay', why: 'codex-credits-unavailable' });
    const b = fleet(['codex-rotate', 'grok', 'codex-credits'], { default: 1500, team: 4000 }, null);
    _setGrokCredentialPresentForTesting(() => true);
    const ok = capture(() => resolveRunFallback({ ...process.env, CODEX_HOME: b.defaultHome }, { storePath: b.store, ...rate })).value;
    expect(ok.action === 'codex-credits' ? ok.to?.name : ok.action).toBe('team');
    const c = fleet(['codex-rotate', 'grok', 'codex-credits'], { default: 1500, team: 4000 }, null);
    _setGrokCredentialPresentForTesting(() => true);
    expect(capture(() => resolveRunFallback({ ...process.env, CODEX_HOME: c.defaultHome, ELANOUS_CODEX_ACCOUNT: 'default' }, { storePath: c.store, ...rate })).value)
      .toEqual({ action: 'stay', why: 'codex-credits-unavailable' });
  });

  test('명시 계정 team · 호스트 CODEX_HOME=default → 실제 재시도 경로의 자식 CODEX_HOME 은 team 홈', () => {
    const { store, defaultHome, teamHome } = fleet(['codex-rotate', 'grok', 'codex-credits'], { default: 0, team: 4000 });
    _setGrokCredentialPresentForTesting(() => true);
    const env = { ...process.env, CODEX_HOME: defaultHome, ELANOUS_CODEX_ACCOUNT: 'team' };
    const state = { attemptedSteps: new Set<FallbackStep>(['codex-rotate', 'grok']), descents: 1, maxDescents: 2 };
    const backend = capture(() => decideRuntimeFallback(new Error('429 rate limit exceeded: usage limit reached'), 'grok', state,
      (input) => resolveRunFallback(env, { storePath: store, ...input }))).value;
    expect(backend?.name).toBe('codex');
    expect(resolveBackendSpawn(backend!, { CODEX_HOME: defaultHome }).env.CODEX_HOME).toBe(teamHome);
  });

  test('순서를 바꾼 체인 — 칸을 건너뛰고 뒤 칸(grok)으로 가도 skipped 관측', () => {
    const { store, defaultHome } = fleet(['codex-rotate', 'codex-credits', 'grok'], {});
    _setGrokCredentialPresentForTesting(() => true);
    const r = capture(() => resolveRunFallback({ ...process.env, CODEX_HOME: defaultHome }, { storePath: store, grokQuota: 'usable' }));
    expect(r.value).toEqual({ action: 'switch-backend', backend: 'grok' });
    expect(r.steps).toEqual(expect.arrayContaining([expect.objectContaining({ site: 'chain', outcome: 'skipped', next: 'grok' })]));
  });

  test('순서를 바꾼 체인 — 칸을 건너뛰고 뒤 칸(grok)도 못 써 머물러도 skipped 관측', () => {
    const { store, defaultHome } = fleet(['codex-rotate', 'codex-credits', 'grok'], {});
    _setGrokCredentialPresentForTesting(() => false);
    const r = capture(() => resolveRunFallback({ ...process.env, CODEX_HOME: defaultHome }, { storePath: store }));
    expect(r.value).toEqual({ action: 'stay', why: 'grok-unavailable' });
    expect(r.steps).toEqual(expect.arrayContaining([expect.objectContaining({ site: 'chain', outcome: 'skipped', next: null })]));
  });

  test('칸에 안 닿으면 관측 없음 — grok 이 앞에서 받으면 끝', () => {
    const { store, defaultHome } = fleet(['codex-rotate', 'grok', 'codex-credits'], {});
    _setGrokCredentialPresentForTesting(() => true);
    const r = capture(() => resolveRunFallback({ ...process.env, CODEX_HOME: defaultHome }, { storePath: store, grokQuota: 'usable' }));
    expect(r.value).toEqual({ action: 'switch-backend', backend: 'grok' });
    expect(r.steps.filter((d) => d.site === 'chain')).toEqual([]);
  });

  test('잔액을 모르면 크레딧 ✗ — 칸에 닿은 «실패»도 관측(outcome=skipped)', () => {
    const { store, defaultHome } = fleet(['codex-rotate', 'grok', 'codex-credits'], {});
    _setGrokCredentialPresentForTesting(() => false);
    const { value, steps } = capture(() => resolveCodexAccountForRun({ CODEX_HOME: defaultHome }, { storePath: store }));
    expect(value.name).toBe('default');
    expect(steps).toEqual([expect.objectContaining({ site: 'rotation', outcome: 'skipped', why: 'codex-credits-unavailable' })]);
    const chainSkip = capture(() => resolveRunFallback(process.env, { storePath: store }));
    expect(chainSkip.value).toEqual({ action: 'stay', why: 'codex-credits-unavailable' });
    expect(chainSkip.steps.some((d) => d.site === 'chain' && d.outcome === 'skipped')).toBe(true);
  });
});

describe('소비처 — LLM provider 목록 · 발사 예산 관문 · Pod · 미션 런타임', () => {
  test('providerNamesFromFallbackChain — 칸은 openai-codex 로 · 이미 있으면 중복 제거', () => {
    expect(providerNamesFromFallbackChain(['codex-rotate', 'grok', 'codex-credits'])).toEqual(['openai-codex', 'grok']);
    expect(providerNamesFromFallbackChain(['grok', 'codex-credits'])).toEqual(['grok', 'openai-codex']);
  });

  test('chainFromFallbackNames — 크레딧 칸은 같은 provider 라도 따로 센다', () => {
    expect(chainFromFallbackNames(['codex-rotate', 'grok', 'codex-credits'])).toEqual([
      { provider: 'openai-codex' }, { provider: 'grok' }, { provider: 'openai-codex', codexCredits: true },
    ]);
    expect(chainFromFallbackNames(['codex-rotate', 'grok'])).toEqual([{ provider: 'openai-codex' }, { provider: 'grok' }]);
  });

  const budget = (patch: Partial<DecideBudgetInput> = {}): DecideBudgetInput => ({
    preference: { chain: chainFromFallbackNames(['codex-rotate', 'grok', 'codex-credits']), budgetGate: { onShortfall: 'decompose' } },
    codexCandidates: [
      { name: 'default', usedPercent: 100, creditBalance: 100 },
      { name: 'team', usedPercent: 96, creditBalance: 4000 },
    ],
    grokUsedPercent: 90,
    maxUsedPercent: { 'openai-codex': 95, grok: 80 },
    ...patch,
  });

  test('관문: codex 참 ⊕ grok 상한 초과 ⊕ 잔액 확인 → next-provider codex(크레딧)', () => {
    const d = decideBudget(budget());
    expect(d).toMatchObject({ action: 'next-provider', provider: 'openai-codex' });
    expect(d.reasons.at(-1)).toContain('codex-credits: team');
    const launch = decideLaunchBudget(budget()).decision;
    expect(launch).toMatchObject({ action: 'next-provider', provider: 'openai-codex' });
    expect(launch.reasons.at(-1)).toContain('codex-credits');
    const unmeasuredGrok = decideLaunchBudget(budget({ grokUsedPercent: undefined }));
    expect(unmeasuredGrok.decision).toMatchObject({ action: 'next-provider', provider: 'grok' });
    expect(unmeasuredGrok.unmeasuredProvider).toBe('grok');
  });

  test('관문: grok 이 되면 무변경(grok) · 잔액을 모르면 stop · 칸이 없으면 종전 stop', () => {
    expect(decideBudget(budget({ grokUsedPercent: 10 }))).toMatchObject({ action: 'next-provider', provider: 'grok' });
    expect(decideBudget(budget({ codexCandidates: [{ name: 'default', usedPercent: 100 }] })).action).toBe('stop');
    const noStep = budget();
    expect(decideBudget({ ...noStep, preference: { ...noStep.preference, chain: chainFromFallbackNames(['codex-rotate', 'grok']) } }).action).toBe('stop');
  });

  test('관문: 정책 credits 면 무변경 — 첫 칸 codex 가 크레딧으로 proceed', () => {
    const d = decideBudget(budget({ codexCreditsAllowed: true }));
    expect(d.action).toBe('proceed');
    expect(d.reasons.join(' ')).not.toContain('codex-credits:');
  });

  const podCands: RotationCandidate[] = [
    { name: 'default', storeKey: 'openai-codex', home: '/h/d', reached: true, usedPercent: 100, creditBalance: 50 },
    { name: 'team', storeKey: 'openai-codex:team', home: '/h/t', reached: true, usedPercent: 100, creditBalance: 4000 },
  ];
  const pod = (patch: Partial<Parameters<typeof planPodProvider>[0]>) => planPodProvider({
    codexCandidates: podCands, grokSubscription: true, grokApiKey: false, grokApiKeyOptIn: false, ...patch,
  });

  test('Pod: 칸 켜짐 ⊕ grok 소진 → 크레딧 계정(잔액 많은 순)', () => {
    // No reserve passed → the default reserve (2000) applies: money, fail-closed.
    expect(pod({ codexCreditsStep: true, grokQuota: 'exhausted' })).toMatchObject({ provider: 'openai-codex', accounts: ['team'] });
    expect(pod({ codexCreditsStep: true, grokQuota: 'exhausted', creditReserve: 0 })).toMatchObject({
      provider: 'openai-codex', accounts: ['team', 'default'], codexCreditsStep: true, skipped: ['codex-rotate:no-candidate', 'grok:grok-exhausted'],
    });
  });

  test('Pod: 예비분 이하 잔액 계정은 크레딧 칸 후보가 아니다', () => {
    expect(pod({ codexCreditsStep: true, grokQuota: 'exhausted', creditReserve: 2000 })).toMatchObject({ provider: 'openai-codex', accounts: ['team'], creditAccounts: ['team'] });
    expect(pod({ codexCreditsStep: true, grokQuota: 'exhausted', creditReserve: 5000 }).provider).toBe('grok');
  });

  test('Pod: 무변경 — 칸 없음 · grok 모름 · 잔액 없음이면 grok', () => {
    expect(pod({ grokQuota: 'exhausted' }).provider).toBe('grok');
    expect(pod({ codexCreditsStep: true, grokQuota: 'unknown' }).provider).toBe('grok');
    expect(pod({ codexCreditsStep: true, grokQuota: 'exhausted', codexCandidates: podCands.map((c) => ({ ...c, creditBalance: undefined })) }).provider).toBe('grok');
  });

  test('Pod: grok 자격도 없으면 칸이 크레딧으로 받는다(종전은 refuse)', () => {
    expect(pod({ grokSubscription: false, codexCreditsStep: true })).toMatchObject({ provider: 'openai-codex', codexCreditsStep: true });
    expect(pod({ grokSubscription: false }).provider).toBeNull();
  });

  test('미션 런타임: codex → grok → codex(크레딧) 연속 전환이 상한 안에서 허용된다', () => {
    const rateLimited = new Error('429 rate limit exceeded: usage limit reached');
    const chain: FallbackStep[] = ['codex-rotate', 'grok', 'codex-credits'];
    // 상한은 실제 미션 진입점의 초기화(initialRuntimeFallback)에서 — codex 로 떴으면 남은 칸 = 2(grok · codex-credits).
    const initial = initialRuntimeFallback(codexBackend, chain);
    expect(initial.maxDescents).toBe(2);
    expect(decideRuntimeFallback(rateLimited, 'codex-rotate', initial, () => ({ action: 'switch-backend', backend: 'grok' }))?.name).toBe('grok');
    const afterGrok = { attemptedSteps: new Set<FallbackStep>([...initial.attemptedSteps, 'grok']), descents: 1, maxDescents: initial.maxDescents };
    expect(decideRuntimeFallback(rateLimited, 'grok', afterGrok, () => ({ action: 'codex-credits' }))).toBe(codexBackend);
    expect(decideRuntimeFallback(rateLimited, 'codex-rotate', { ...afterGrok, attemptedSteps: new Set<FallbackStep>(['codex-rotate', 'grok', 'codex-credits']), descents: 2 }, () => ({ action: 'codex-credits' }))).toBeNull();
  });

  test('미션 런타임: grok 한도 오류 → codex(크레딧) 한 번만', () => {
    const rateLimited = new Error('429 rate limit exceeded: usage limit reached');
    const decide = () => ({ action: 'codex-credits' });
    const state = { attemptedSteps: new Set<FallbackStep>(['grok']), descents: 0, maxDescents: 1 };
    expect(decideRuntimeFallback(rateLimited, 'grok', state, decide)).toBe(codexBackend);
    expect(decideRuntimeFallback(rateLimited, 'grok', { ...state, attemptedSteps: new Set<FallbackStep>(['grok', 'codex-credits']) }, decide)).toBeNull();
  });
});
