import { describe, expect, test } from 'bun:test';
import { decideCodexRotation } from './codex-account-rotation.js';
import { decideFallback } from './fallback-chain.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordCreditBalances } from '../budget/codex-credit-pace.js';
import { writeQuotaSignal } from '../budget/codex-reset-credit-state.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { inspectCodexRotation, resolveCodexAccountForRun, _setCodexAccountOutboundSenderForTesting } from './codex-account-store.js';
import { saveTokens } from './store.js';
import { debug } from '../debug/log.js';
describe('일별 선불 크레딧 페이스', () => {
  const current = { name: 'third', storeKey: 'k-third', home: '/h/third', source: 'default' } as const;
  const team = { name: 'team', storeKey: 'k-team', home: '/h/team', reached: true, usedPercent: 100, creditBalance: 65_833, hasCredits: true };
  const base = { current, explicit: false, enabled: true, currentReached: false, currentUsedPercent: 90, resetCreditAvailability: 'unavailable', candidates: [team] } as const;
  // CODEX-ORDER(10-09): 구독 → 리셋권 → 크레딧. 페이스는 «구독 남은 계정도 리셋권도 없을 때»만 본다.
  const exhausted = { ...base, currentReached: true, currentUsedPercent: 100 } as const;
  test('찬 team 구독의 크레딧을 미달 몫만큼 먼저 쓰고, 몫이 차면 기존 판정으로 돌아간다', () => {
    expect(decideCodexRotation({ ...exhausted, creditPace: { active: true } }).reason).toBe('credit-pace');
    expect(decideCodexRotation({ ...exhausted, creditPace: { active: true } }).to?.name).toBe('team');
    // 순서 ① 구독이 남아 있으면 페이스가 켜져도 구독에 머문다.
    expect(decideCodexRotation({ ...base, creditPace: { active: true } }).reason).toBe('not-reached');
    // 순서 ② 리셋권이 있으면 페이스(크레딧)보다 먼저다.
    expect(decideCodexRotation({ ...exhausted, resetCreditAvailability: 'available', creditPace: { active: true } }).reason).toBe('reset-credit-available');
    expect(decideFallback({ rotation: { reason: 'credit-pace', to: team }, chain: ['codex-rotate', 'grok'], grokAvailable: true }))
      .toEqual({ action: 'codex-rotate', to: team });
    expect(decideFallback({ rotation: { reason: 'credit-pace' }, chain: ['codex-rotate', 'grok'], grokAvailable: true }))
      .toEqual({ action: 'stay', why: 'not-reached' });
    expect(decideCodexRotation({ ...base, creditPace: { active: false } }).reason).toBe('not-reached');
    expect(decideCodexRotation(base).reason).toBe('not-reached');
  });
  test('미달 구독·크레딧 불명 또는 없음이면 페이스가 아닌 기존 규칙', () => {
    for (const candidate of [{ ...team, reached: false, usedPercent: 8 }, { ...team, creditBalance: 0 }, { ...team, hasCredits: false }]) {
      expect(decideCodexRotation({ ...base, candidates: [candidate], creditPace: { active: true } }).reason).toBe('not-reached');
    }
  });
  test('잔액 많은 찬 계정을 선택하고 명시/비활성 설정은 페이스보다 우선한다', () => {
    const alternatives = [team, { ...team, name: 'backup', storeKey: 'k-backup', creditBalance: 90_000 }];
    expect(decideCodexRotation({ ...exhausted, candidates: alternatives, creditPace: { active: true } }).to?.name).toBe('backup');
    expect(decideCodexRotation({ ...base, candidates: alternatives, explicit: true, creditPace: { active: true } }).reason).toBe('explicit');
    expect(decideCodexRotation({ ...base, candidates: alternatives, enabled: false, creditPace: { active: true } }).reason).toBe('disabled');
  });
  test('순서 ① — 페이스가 켜져도 구독이 남은 다른 계정이 있으면 그 계정으로 회전한다(rotated)', () => {
    const fresh = { name: 'fresh', storeKey: 'k-fresh', home: '/h/fresh', reached: false, usedPercent: 10, creditBalance: 0, hasCredits: false };
    const d = decideCodexRotation({ ...exhausted, candidates: [team, fresh], creditPace: { active: true } });
    expect(d.reason).toBe('rotated');
    expect(d.to?.name).toBe('fresh');
  });
  test('현재 계정이 찬 구독이며 크레딧을 보유하면 그 자리에 머문다', () => {
    expect(decideCodexRotation({ ...base, currentReached: true, currentUsedPercent: 100, currentCreditBalance: 10, currentHasCredits: true, creditPace: { active: true } }).reason).toBe('credit-pace');
    expect(decideCodexRotation({ ...base, currentReached: true, currentUsedPercent: 100, currentCreditBalance: 10, currentHasCredits: true, creditPace: { active: true } }).to).toBeUndefined();
  });
});

test('policy + ledger + quota signal feed both inspection and runtime rotation', () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-pace-wiring-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  const previousSource = process.env.ELANOUS_STATE_DIR_SOURCE;
  try {
    process.env.ELANOUS_STATE_DIR = root;
    delete process.env.ELANOUS_STATE_DIR_SOURCE;
    setElanousConfigDir(root);
    mkdirSync(join(root, 'policy'), { recursive: true });
    writeFileSync(join(root, 'policy/llm.yaml'), 'credits:\n  codex: use\n  pace:\n    targetPerDay: 2200\n    until: 2099-12-31\n');
    const storePath = join(root, 'auth.json');
    const homes: Record<string, string> = Object.fromEntries(['third', 'team'].map(name => [name, join(root, name)]));
    for (const name of ['third', 'team']) {
      mkdirSync(homes[name]!, { recursive: true });
      saveTokens(`openai-codex:${name}`, { accessToken: 'a', refreshToken: 'r', expiresAt: null }, { mirrorCodex: false, codexHome: homes[name] }, storePath);
    }
    writeQuotaSignal(undefined, 100, homes.third, undefined, { balance: 0, hasCredits: false }); // CODEX-ORDER: 구독이 찬 뒤에만 페이스
    writeQuotaSignal(undefined, 100, homes.team, undefined, { balance: 65_833, hasCredits: true });
    recordCreditBalances({ team: 65_833 }, new Date());
    _setCodexAccountOutboundSenderForTesting(() => true);
    const env = { ELANOUS_CODEX_ACCOUNT: '', CODEX_HOME: homes.third } as NodeJS.ProcessEnv;
    // The unpinned default path needs to resolve to third while the account remains non-explicit.
    saveTokens('openai-codex', { accessToken: 'a', refreshToken: 'r', expiresAt: null }, { mirrorCodex: false, codexHome: homes.third }, storePath);
    expect(inspectCodexRotation(env, { storePath }).reason).toBe('credit-pace');
    expect(inspectCodexRotation(env, { storePath }).to).toBe('team');
    expect(resolveCodexAccountForRun(env, { storePath }).name).toBe('team');
    recordCreditBalances({ team: 62_000 }, new Date());
    writeQuotaSignal(undefined, 100, homes.team, undefined, { balance: 62_000, hasCredits: true });
    // 페이스 몫이 차면 페이스 갈래는 닫힌다. 정책 `credits.codex: use`(#26407 부터 파일이 실제로 읽힌다)라
    //   지출 순서 «다른 계정 구독 → 리셋권 → 선불 크레딧»의 마지막 칸으로 내려간다 — 지금 계정(third)은 크레딧 0 이라
    //   크레딧이 남은 team 으로 옮긴다(CREDIT-SPEND-ORDER 10-12: 이 이동은 «크레딧 진입» 표지를 단다).
    const afterPace = inspectCodexRotation(env, { storePath });
    expect(afterPace.reason).toBe('rotated');
    expect(afterPace.to).toBe('team');
    expect(decideCodexRotation({
      current: { name: 'third', storeKey: 'k-third', home: homes.third!, source: 'default' }, explicit: false, enabled: true,
      currentReached: true, currentUsedPercent: 100, resetCreditAvailability: 'unavailable', creditsAllowed: true,
      currentCreditBalance: 0, currentHasCredits: false, creditPace: { active: false },
      candidates: [{ name: 'team', storeKey: 'k-team', home: homes.team!, reached: true, usedPercent: 100, creditBalance: 62_000, hasCredits: true }],
    }).creditEntry).toBe(true);
  } finally {
    _setCodexAccountOutboundSenderForTesting(null);
    resetElanousConfigDir();
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = previous;
    if (previousSource === undefined) delete process.env.ELANOUS_STATE_DIR_SOURCE; else process.env.ELANOUS_STATE_DIR_SOURCE = previousSource;
    rmSync(root, { recursive: true, force: true });
  }
});

describe('크레딧 정책 — 크레딧이 더 남은 계정으로 (09-28)', () => {
  const cand = (name: string, creditBalance?: number, hasCredits?: boolean) => ({
    name, storeKey: `k-${name}`, home: `/h/${name}`, reached: true as const, usedPercent: 100,
    ...(creditBalance === undefined ? {} : { creditBalance }), ...(hasCredits === undefined ? {} : { hasCredits }),
  });
  const base = {
    current: { name: 'default', storeKey: 'openai-codex', home: '/h/default', source: 'default' },
    explicit: false, enabled: true, currentReached: true, currentUsedPercent: 100,
    resetCreditAvailability: 'unavailable', creditsAllowed: true,
  } as const;
  test('지금 계정 크레딧이 바닥나면 가장 많이 남은 계정으로 옮긴다', () => {
    const d = decideCodexRotation({ ...base, currentCreditBalance: 0, currentHasCredits: false, candidates: [cand('team', 29_998, true), cand('third', 25_000, true)] } as never);
    expect(d.reason).toBe('rotated');
    expect(d.to?.name).toBe('team');
  });
  test('다른 계정이 20% 넘게 많으면 옮기고, 비슷하면 머문다(흔들림 방지)', () => {
    expect(decideCodexRotation({ ...base, currentCreditBalance: 20_000, currentHasCredits: true, candidates: [cand('team', 29_998, true)] } as never).to?.name).toBe('team');
    expect(decideCodexRotation({ ...base, currentCreditBalance: 27_000, currentHasCredits: true, candidates: [cand('team', 29_998, true)] } as never).reason).toBe('credits-allowed');
  });
  test('잔액을 모르면 종전대로 머문다 · 크레딧 정책이 아니면 no-candidate', () => {
    expect(decideCodexRotation({ ...base, candidates: [cand('team')] } as never).reason).toBe('credits-allowed');
    expect(decideCodexRotation({ ...base, creditsAllowed: false, currentCreditBalance: 0, candidates: [cand('team', 29_998, true)] } as never).reason).toBe('no-candidate');
  });
  test('지금 계정 잔액을 입력으로 못 받으면 후보 목록의 같은 이름 줄에서 읽는다', () => {
    const d = decideCodexRotation({ ...base, candidates: [cand('default', 19_787, true), cand('team', 29_998, true), cand('third', 25_000, true)] } as never);
    expect(d.to?.name).toBe('team');
  });
});

describe('CREDIT-SPEND-ORDER — 크레딧 진입은 머물든 옮기든 💳 알림 ⊕ credit-spend-start (10-12 S2)', () => {
  function fixture(scen: 'stay' | 'move') {
    const root = mkdtempSync(join(tmpdir(), `codex-credit-entry-${scen}-`));
    setElanousConfigDir(root);
    mkdirSync(join(root, 'policy'), { recursive: true });
    writeFileSync(join(root, 'policy/llm.yaml'), 'credits:\n  codex: use\n');
    const storePath = join(root, 'auth.json');
    const homes: Record<string, string> = {};
    for (const name of ['team', 'third']) {
      homes[name] = join(root, name); mkdirSync(homes[name]!, { recursive: true });
      saveTokens(`openai-codex:${name}`, { accessToken: 'a', refreshToken: 'r', expiresAt: null }, { mirrorCodex: false, codexHome: homes[name] }, storePath);
    }
    saveTokens('openai-codex', { accessToken: 'a', refreshToken: 'r', expiresAt: null }, { mirrorCodex: false, codexHome: homes.third }, storePath);
    // 모든 구독 100% · 리셋권 없음 — 크레딧 단계.
    writeQuotaSignal(undefined, 100, homes.third, undefined, scen === 'stay' ? { balance: 50_000, hasCredits: true } : { balance: 0, hasCredits: false });
    writeQuotaSignal(undefined, 100, homes.team, undefined, scen === 'stay' ? { balance: 0, hasCredits: false } : { balance: 60_000, hasCredits: true });
    const sent: string[] = [];
    _setCodexAccountOutboundSenderForTesting((text) => { sent.push(text); return true; });
    const events: string[] = [];
    const originalLog = debug.log;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, ...rest: unknown[]) => {
      if (category === 'oauth.codex-account') events.push(event);
      return (originalLog as (...a: unknown[]) => void).call(debug, category, event, ...rest);
    }) as typeof debug.log;
    const env = { ELANOUS_CODEX_ACCOUNT: '', CODEX_HOME: homes.third } as NodeJS.ProcessEnv;
    const counterPath = join(root, 'budget', 'codex-credit-spend-alert.json');
    const cleanup = () => {
      (debug as { log: typeof debug.log }).log = originalLog;
      _setCodexAccountOutboundSenderForTesting(null);
      resetElanousConfigDir();
      rmSync(root, { recursive: true, force: true });
    };
    return { storePath, env, counterPath, sent, events, cleanup };
  }
  for (const [scen, reason, account] of [['stay', 'credits-allowed', 'default'], ['move', 'credits-rotated', 'team']] as const) {
    test(`${scen}: ${account} 크레딧으로(지금 계정 = 기본 슬롯 · third 홈) — 💳 1통 · credit-spend-start 1 · 둘째 호출 중복 0`, () => {
      const t = fixture(scen);
      try {
        const r1 = resolveCodexAccountForRun(t.env, { storePath: t.storePath, counterPath: t.counterPath });
        const r2 = resolveCodexAccountForRun(t.env, { storePath: t.storePath, counterPath: t.counterPath });
        expect([r1.name, r2.name]).toEqual([account, account]);
        const credit = t.sent.filter((text) => text.startsWith('💳 Codex credits in use'));
        expect(credit).toHaveLength(1);
        expect(credit[0]).toContain(`account: ${account}`);
        expect(credit[0]).toContain(`reason: ${reason}`);
        expect(t.events.filter((e) => e === 'credit-spend-start')).toHaveLength(1);
        expect(t.events.filter((e) => e === 'credit-spend-alert-skipped')).toHaveLength(1); // 둘째 호출 = already-alerted-today
      } finally { t.cleanup(); }
    });
  }
});
