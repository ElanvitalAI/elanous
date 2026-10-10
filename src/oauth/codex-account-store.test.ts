// 회전 스냅샷의 홈 해석 — 쿼터 새로고침과 «같은 정본»(`effectiveCodexHome`)을 쓰는지 문다.
//
// 결함 모양: 기본 계정은 `codexHome` 이 기록되지 않아도 규칙(`CODEX_HOME || ~/.codex`)으로
// 홈이 정해져 있는데, 스냅샷이 저장된 값만 보면 usedPercent/resetCredit 가 미지가 되어
// 회전이 `reset-credit-unknown` 으로 건강한 기본 계정에서 도망친다.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAvailabilityState, writeQuotaSignal } from '../budget/codex-reset-credit-state.js';
import { debug } from '../debug/log.js';
import { resetLiveDetailCacheForTesting, writeLiveDetail } from '../live/detail-switch.js';
import { saveTokens } from './store.js';
import {
  _resetCodexRotationPinForTesting,
  _setCodexAccountOutboundSenderForTesting,
  _setRotationConfigReaderForTesting,
  autoConsumeCodexResetCredit,
  inspectCodexRotation,
  notifyCodexResetCreditConsumed,
  resolveCodexAccountForRun,
  resolveRunFallback,
} from './codex-account-store.js';

const madeDirs: string[] = [];
const original = {
  state: process.env.ELANOUS_STATE_DIR,
  home: process.env.CODEX_HOME,
};

beforeEach(() => {
  _setCodexAccountOutboundSenderForTesting(() => true);
});

afterEach(() => {
  if (original.state === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = original.state;
  if (original.home === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = original.home;
  _setRotationConfigReaderForTesting(null);
  _setCodexAccountOutboundSenderForTesting(null);
  _resetCodexRotationPinForTesting();
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function isolatedRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), label));
  madeDirs.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  return root;
}

function tokens() {
  return { accessToken: 'a', refreshToken: 'r', expiresAt: null };
}

function stripStoredHome(storePath: string, storeKey: string): void {
  const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as {
    providers: Record<string, { codexHome?: string }>;
  };
  delete parsed.providers[storeKey]?.codexHome;
  writeFileSync(storePath, `${JSON.stringify(parsed, null, 2)}\n`);
}

describe('회전 임계 관측 — 설정에서 판정까지', () => {
  test('inspect는 계정별 실효 임계와 상태를 내고 로그를 남기지 않으며 실행은 계정마다 기록한다', () => {
    const root = isolatedRoot('codex-threshold-observation-');
    const defaultHome = join(root, 'default-home');
    const teamHome = join(root, 'team-home');
    const thirdHome = join(root, 'third-home');
    for (const home of [defaultHome, teamHome, thirdHome]) mkdirSync(home, { recursive: true });
    process.env.CODEX_HOME = defaultHome;
    const store = join(root, 'auth.json');
    saveTokens('openai-codex', tokens(), { mirrorCodex: false, codexHome: defaultHome }, store);
    saveTokens('openai-codex:team', tokens(), { mirrorCodex: false, codexHome: teamHome }, store);
    saveTokens('openai-codex:third', tokens(), { mirrorCodex: false, codexHome: thirdHome }, store);
    writeQuotaSignal(undefined, 70, defaultHome);
    writeQuotaSignal(undefined, 80, teamHome);
    writeQuotaSignal(undefined, 85, thirdHome);
    _setRotationConfigReaderForTesting(() => ({ llm: {
      codexAccountRotationThresholdPercent: 90,
      codexAccountRotationThresholdPercentByAccount: { default: 75, team: 80, third: 0 },
    } }));
    const originalLog = debug.log;
    const recorded: Record<string, unknown>[] = [];
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data: Record<string, unknown>) => {
      if (category === 'oauth.codex-account' && event === 'rotation-account-threshold') recorded.push(data);
    }) as typeof debug.log;
    try {
      const first = inspectCodexRotation({ CODEX_HOME: defaultHome }, { storePath: store });
      expect(first.reason).toBe('not-reached');
      expect(first.thresholdPercent).toBe(75);
      expect(first.accountThresholds).toEqual([
        { name: 'default', thresholdPercent: 75, source: 'account-override', status: 'below-threshold', usedPercent: 70 },
        { name: 'team', thresholdPercent: 80, source: 'account-override', status: 'threshold-reached', usedPercent: 80 },
        { name: 'third', thresholdPercent: 90, source: 'global', status: 'below-threshold', usedPercent: 85 },
      ]);
      expect(recorded).toHaveLength(0);
      writeQuotaSignal(undefined, 75, defaultHome);
      const inspected = inspectCodexRotation({ CODEX_HOME: defaultHome }, { storePath: store });
      expect(inspected.reason).toBe('reset-credit-unknown');
      expect(inspected.to).toBe('third');
      expect(recorded).toHaveLength(0);
      expect(resolveCodexAccountForRun({ CODEX_HOME: defaultHome }, { storePath: store }).name).toBe('third');
      expect(recorded).toEqual([
        { name: 'default', thresholdPercent: 75, source: 'account-override', status: 'threshold-reached', usedPercent: 75 },
        { name: 'team', thresholdPercent: 80, source: 'account-override', status: 'threshold-reached', usedPercent: 80 },
        { name: 'third', thresholdPercent: 90, source: 'global', status: 'below-threshold', usedPercent: 85 },
      ]);
    } finally {
      (debug as { log: typeof debug.log }).log = originalLog;
    }
  });
});

describe('usageSnapshotForStore — 홈이 기록되지 않은 기본 계정', () => {
  test('ⓐ 기본 계정의 usedPercent·resetCreditAvailability 가 미지가 아니다', () => {
    const root = isolatedRoot('codex-store-default-home-');
    const defaultHome = join(root, 'default-home');
    mkdirSync(defaultHome, { recursive: true });
    process.env.CODEX_HOME = defaultHome;
    const store = join(root, 'auth.json');
    saveTokens('openai-codex', tokens(), { mirrorCodex: false }, store);
    stripStoredHome(store, 'openai-codex');
    expect(JSON.parse(readFileSync(store, 'utf8')).providers['openai-codex'].codexHome).toBeUndefined();

    writeQuotaSignal(undefined, 25, defaultHome);
    writeAvailabilityState(1, defaultHome);

    const outbound: string[] = [];
    _setCodexAccountOutboundSenderForTesting((text) => {
      outbound.push(text);
      return true;
    });
    notifyCodexResetCreditConsumed({ name: 'default' }, 1, { storePath: store, now: Date.now() });
    expect(outbound).toHaveLength(1);
    const text = outbound[0]!;
    expect(text).toContain('default=25%');
    expect(text).toContain('resetCredit=available');
    expect(text).not.toContain('default=unknown');
    expect(text).not.toMatch(/default=unknown resetCredit=unknown/);
  });

  test('ⓑ 임계 아래인 기본 계정은 reset-credit-unknown 으로 떠나지 않는다', () => {
    const root = isolatedRoot('codex-store-no-flee-');
    const defaultHome = join(root, 'default-home');
    const teamHome = join(root, 'team-home');
    mkdirSync(defaultHome, { recursive: true });
    mkdirSync(teamHome, { recursive: true });
    process.env.CODEX_HOME = defaultHome;
    const store = join(root, 'auth.json');
    saveTokens('openai-codex', tokens(), { mirrorCodex: false }, store);
    saveTokens('openai-codex:team', tokens(), { mirrorCodex: false, codexHome: teamHome }, store);
    stripStoredHome(store, 'openai-codex');

    writeQuotaSignal(undefined, 25, defaultHome);
    writeAvailabilityState(1, defaultHome);
    writeQuotaSignal(undefined, 2, teamHome);
    writeAvailabilityState(1, teamHome);

    _setRotationConfigReaderForTesting(() => ({}));
    _resetCodexRotationPinForTesting();
    const inspected = inspectCodexRotation(process.env, { storePath: store });
    expect(inspected.reason).not.toBe('reset-credit-unknown');
    expect(inspected.reason).toBe('not-reached');
    expect(inspected.to).toBeUndefined();
    expect(resolveCodexAccountForRun(process.env, { storePath: store }).name).toBe('default');
  });

  test('ⓒ 이름 계정이 홈을 정말 모르면 스냅샷이 미지로 남는다', () => {
    const root = isolatedRoot('codex-store-named-unknown-');
    const defaultHome = join(root, 'default-home');
    mkdirSync(defaultHome, { recursive: true });
    process.env.CODEX_HOME = defaultHome;
    const store = join(root, 'auth.json');
    saveTokens('openai-codex', tokens(), { mirrorCodex: false }, store);
    saveTokens('openai-codex:ghost', tokens(), { mirrorCodex: false }, store);
    stripStoredHome(store, 'openai-codex');
    stripStoredHome(store, 'openai-codex:ghost');
    expect(JSON.parse(readFileSync(store, 'utf8')).providers['openai-codex:ghost'].codexHome).toBeUndefined();

    writeQuotaSignal(undefined, 25, defaultHome);
    writeAvailabilityState(1, defaultHome);

    const outbound: string[] = [];
    _setCodexAccountOutboundSenderForTesting((text) => {
      outbound.push(text);
      return true;
    });
    notifyCodexResetCreditConsumed({ name: 'default' }, 1, { storePath: store, now: Date.now() });
    const text = outbound[0]!;
    expect(text).toContain('default=25%');
    expect(text).toContain('resetCredit=available');
    expect(text).toContain('ghost=unknown resetCredit=unknown');
  });

  test('ⓓ 쿼터가 실제로 임계를 넘은 계정에서는 회전이 일어난다', () => {
    const root = isolatedRoot('codex-store-over-threshold-');
    const defaultHome = join(root, 'default-home');
    const teamHome = join(root, 'team-home');
    mkdirSync(defaultHome, { recursive: true });
    mkdirSync(teamHome, { recursive: true });
    process.env.CODEX_HOME = defaultHome;
    const store = join(root, 'auth.json');
    saveTokens('openai-codex', tokens(), { mirrorCodex: false }, store);
    saveTokens('openai-codex:team', tokens(), { mirrorCodex: false, codexHome: teamHome }, store);
    stripStoredHome(store, 'openai-codex');

    writeQuotaSignal('rate_limit_reached', 96, defaultHome);
    writeAvailabilityState(0, defaultHome);
    writeQuotaSignal(undefined, 2, teamHome);
    writeAvailabilityState(1, teamHome);

    _setRotationConfigReaderForTesting(() => ({}));
    _resetCodexRotationPinForTesting();
    const inspected = inspectCodexRotation(process.env, { storePath: store });
    expect(inspected.reason).toBe('rotated');
    expect(inspected.to).toBe('team');
    expect(resolveCodexAccountForRun(process.env, { storePath: store }).name).toBe('team');
  });
});

/**
 * ⛔⭐⭐⭐ 2026-09-23 인시던트 회귀 — ***핀이 만료되지 않아 소진된 계정에 갇혔다.***
 *
 * 📏 실측: 런 셋이 `default`·`team`(둘 다 100% 소진)으로 수천 콜을 냈고, 같은 시각
 *   `third` 는 100% 남은 채 «0건»이었다. `inspectCodexRotation()` 은 그때도
 *   `reason:"rotated" · to:"third"` 라 답했다 — ***판정은 옳았고 핀이 그 답을 안 읽었다.***
 * 🔑 핀은 「한 런 안에서 토큰이 섞이는 것」을 막는 장치라 «지우면» 안 된다.
 *   ⇒ 탈출구를 ***「그 계정이 임계를 넘었을 때」로만*** 연다.
 */
describe('회전 핀 — 소진되면 «풀린다»', () => {
  function setupTwoAccounts(label: string): { store: string; defaultHome: string; thirdHome: string } {
    const root = isolatedRoot(label);
    const defaultHome = join(root, 'default-home');
    const thirdHome = join(root, 'third-home');
    mkdirSync(defaultHome, { recursive: true });
    mkdirSync(thirdHome, { recursive: true });
    process.env.CODEX_HOME = defaultHome;
    const store = join(root, 'auth.json');
    saveTokens('openai-codex', tokens(), { mirrorCodex: false }, store);
    // ⛔ 둘째 계정에 «자기 홈»을 준다 — 안 주면 기본 홈을 공유해 두 계정이 «같은 신호»를 본다
    //   (첫 판이 그 실수를 했고 시험이 「갇혔다」로 «거짓» 빨강을 냈다).
    saveTokens('openai-codex:third', tokens(), { mirrorCodex: false, codexHome: thirdHome }, store);
    _setRotationConfigReaderForTesting(() => ({}));
    _resetCodexRotationPinForTesting();
    return { store, defaultHome, thirdHome };
  }

  test('⛔ 핀이 박힌 뒤 그 계정이 «소진되면» 다른 계정으로 간다 (인시던트 재현)', () => {
    const { store, defaultHome, thirdHome } = setupTwoAccounts('codex-pin-exhaust-');
    process.env.ELANOUS_RUN_ID = 'run-pin-incident';
    try {
      // ⑴ 건강한 상태 — default 로 핀이 박힌다
      writeQuotaSignal(undefined, 25, defaultHome); writeAvailabilityState(1, defaultHome);
      writeQuotaSignal(undefined, 0, thirdHome); writeAvailabilityState(1, thirdHome);
      expect(resolveCodexAccountForRun(process.env, { storePath: store }).name).toBe('default');
      expect(resolveCodexAccountForRun(process.env, { storePath: store }).name).toBe('default');  // 핀이 «잡는다»

      // ⑵ 그 계정이 소진된다 — ***여기서 풀려야 한다***
      writeQuotaSignal(undefined, 100, defaultHome);
      const after = resolveCodexAccountForRun(process.env, { storePath: store });
      expect(after.name, '소진된 계정에 «갇혔다» — 이것이 2026-09-23 인시던트다').toBe('third');
    } finally { delete process.env.ELANOUS_RUN_ID; }
  });

  test('⛔ 소진되지 «않았으면» 핀은 그대로다 — 한 런에서 계정이 오락가락하면 토큰이 섞인다', () => {
    const { store, defaultHome, thirdHome } = setupTwoAccounts('codex-pin-hold-');
    process.env.ELANOUS_RUN_ID = 'run-pin-hold';
    try {
      writeQuotaSignal(undefined, 25, defaultHome); writeAvailabilityState(1, defaultHome);
      writeQuotaSignal(undefined, 0, thirdHome); writeAvailabilityState(1, thirdHome);
      expect(resolveCodexAccountForRun(process.env, { storePath: store }).name).toBe('default');
      writeQuotaSignal(undefined, 40, defaultHome);   // 올랐지만 임계(95) 아래
      expect(resolveCodexAccountForRun(process.env, { storePath: store }).name).toBe('default');
    } finally { delete process.env.ELANOUS_RUN_ID; }
  });

  test('⛔ 「모른다」를 «소진»으로 읽지 않는다 — 신호 없는 기계에서 핀이 무의미해진다', () => {
    const { store, defaultHome, thirdHome } = setupTwoAccounts('codex-pin-unknown-');
    process.env.ELANOUS_RUN_ID = 'run-pin-unknown';
    try {
      writeQuotaSignal(undefined, 25, defaultHome); writeAvailabilityState(1, defaultHome);
      writeQuotaSignal(undefined, 0, thirdHome); writeAvailabilityState(1, thirdHome);
      expect(resolveCodexAccountForRun(process.env, { storePath: store }).name).toBe('default');
      // 신호를 «지우지» 않고 그대로 둔 채 다시 묻는다 — 모름이 아니라 동일 값이므로 유지돼야 한다
      expect(resolveCodexAccountForRun(process.env, { storePath: store }).name).toBe('default');
    } finally { delete process.env.ELANOUS_RUN_ID; }
  });
});

describe('기본 계정은 정본에 홈을 안 적어도 회전 후보다 (🅢 2026-09-27)', () => {
  test('`openai-codex` 에 codexHome 이 없으면 기본 위치(CODEX_HOME)로 풀어 후보에 넣는다 — 이름 계정은 여전히 홈이 있어야 한다', () => {
    const root = isolatedRoot('codex-default-candidate-');
    const defaultHome = join(root, 'default-home');
    const teamHome = join(root, 'team-home');
    for (const home of [defaultHome, teamHome]) mkdirSync(home, { recursive: true });
    const store = join(root, 'auth.json');
    // 운영 모양: 기본 계정은 codexHome 없이 저장된다.
    saveTokens('openai-codex', tokens(), { mirrorCodex: false, codexHome: defaultHome }, store);
    stripStoredHome(store, 'openai-codex');
    saveTokens('openai-codex:team', tokens(), { mirrorCodex: false, codexHome: teamHome }, store);
    saveTokens('openai-codex:ghost', tokens(), { mirrorCodex: false, codexHome: join(root, 'ghost') }, store);
    stripStoredHome(store, 'openai-codex:ghost');
    writeQuotaSignal(undefined, 1, defaultHome);
    writeQuotaSignal(undefined, 98, teamHome);
    const inspected = inspectCodexRotation({ CODEX_HOME: defaultHome }, { storePath: store });
    const byName = Object.fromEntries(inspected.candidates.map((c) => [c.name, c]));
    expect(byName.default?.home).toBe(defaultHome);
    expect(byName.default?.usedPercent).toBe(1);
    expect(byName.team?.home).toBe(teamHome);
    expect(byName.ghost).toBeUndefined();
  });
});

describe('CODEX-ORDER ② — 리셋권 자동 소비(주입 가짜만 · 실물 소비 0)', () => {
  type Credit = { id: string; status: string; granted_at: string | null; expires_at: string | null; redeem_started_at: string | null; redeemed_at: string | null; title: string | null; description: string | null };
  const credit = (id: string, expires: string): Credit => ({ id, status: 'available', granted_at: null, expires_at: expires, redeem_started_at: null, redeemed_at: null, title: null, description: null });

  function setup() {
    const root = isolatedRoot('codex-reset-auto-');
    const homes = { default: join(root, 'default-home'), team: join(root, 'team-home') };
    for (const h of Object.values(homes)) mkdirSync(h, { recursive: true });
    process.env.CODEX_HOME = homes.default;
    const store = join(root, 'auth.json');
    saveTokens('openai-codex', tokens(), { mirrorCodex: false, codexHome: homes.default }, store);
    saveTokens('openai-codex:team', tokens(), { mirrorCodex: false, codexHome: homes.team }, store);
    // 구독 남은 계정 없음 ⊕ 리셋권 available.
    writeQuotaSignal(undefined, 100, homes.default); writeAvailabilityState(1, homes.default);
    writeQuotaSignal(undefined, 100, homes.team); writeAvailabilityState(1, homes.team);
    _setRotationConfigReaderForTesting(() => ({ llm: {} }));
    const consumed: Array<{ authFilePath?: string }> = [];
    const consume = (async (opts: { authFilePath?: string } = {}) => {
      consumed.push(opts);
      return { ok: true, value: { code: 'reset', credit: { ...credit('x', '2026-10-10T00:00:00Z'), status: 'redeemed', redeemed_at: 'now' } }, redeemRequestId: 'r' };
    }) as never;
    const list = (async (opts: { authFilePath?: string } = {}) => {
      const team = opts.authFilePath?.startsWith(homes.team);
      return { ok: true, value: { credits: [credit(team ? 'team-1' : 'def-1', team ? '2026-10-12T00:00:00Z' : '2026-10-20T00:00:00Z')], availableCount: 1, totalEarnedCount: 1 } };
    }) as never;
    const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
    const originalLog = debug.log;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data: Record<string, unknown>) => {
      events.push({ category, event, data });
    }) as typeof debug.log;
    const restore = () => { (debug as { log: typeof debug.log }).log = originalLog; };
    return { root, homes, store, consumed, consume, list, events, restore, counterPath: join(root, 'budget', 'codex-reset-auto-consume.json') };
  }

  test('판정이 reset-credit-available 이고 오늘 0회면 만료가 가장 이른 계정으로 정확히 한 번 소비하고 reset-consumed 를 남긴다', async () => {
    const t = setup();
    try {
      expect(inspectCodexRotation(process.env, { storePath: t.store }).reason).toBe('reset-credit-available');
      const out = await autoConsumeCodexResetCredit({ storePath: t.store, consume: t.consume, list: t.list, counterPath: t.counterPath });
      expect(out).toMatchObject({ consumed: true, account: 'team', todayCount: 1 });
      expect(t.consumed).toHaveLength(1);
      expect(t.consumed[0]!.authFilePath).toBe(join(t.homes.team, 'auth.json'));
      const ev = t.events.find((e) => e.category === 'codex.rotation' && e.event === 'reset-consumed');
      expect(ev?.data).toMatchObject({ account: 'team', expiresAt: '2026-10-12T00:00:00Z', todayCount: 1 });
    } finally { t.restore(); }
  });

  test('오늘 이미 상한(1)이면 소비하지 않고 reset-consume-skipped 에 상한 이유를 남긴다', async () => {
    const t = setup();
    try {
      mkdirSync(join(t.root, 'budget'), { recursive: true });
      writeFileSync(t.counterPath, JSON.stringify({ day: new Date().toISOString().slice(0, 10), count: 1 }));
      const out = await autoConsumeCodexResetCredit({ storePath: t.store, consume: t.consume, list: t.list, counterPath: t.counterPath });
      expect(out).toMatchObject({ consumed: false, reason: 'daily-cap-reached' });
      expect(t.consumed).toHaveLength(0);
      expect(t.events.find((e) => e.event === 'reset-consume-skipped')?.data).toMatchObject({ reason: 'daily-cap-reached' });
      // 크레딧 단계로 내려간다 — 판정은 여전히 리셋권을 가리키지만 적용부는 머문다(소비 없음).
      expect(inspectCodexRotation(process.env, { storePath: t.store }).reason).toBe('reset-credit-available');
    } finally { t.restore(); }
  });

  test('llm.codexResetAutoConsumePerDay=0 이면 끔', async () => {
    const t = setup();
    try {
      _setRotationConfigReaderForTesting(() => ({ llm: { codexResetAutoConsumePerDay: 0 } }));
      const out = await autoConsumeCodexResetCredit({ storePath: t.store, consume: t.consume, list: t.list, counterPath: t.counterPath });
      expect(out).toMatchObject({ consumed: false, reason: 'disabled' });
      expect(t.consumed).toHaveLength(0);
    } finally { t.restore(); }
  });

  test('⛔ 가짜를 안 주면 테스트 러너 안에서는 실물 소비에 닿지 않는다(resolve 경로 포함)', async () => {
    const t = setup();
    try {
      const out = await autoConsumeCodexResetCredit({ storePath: t.store, counterPath: t.counterPath });
      expect(out).toMatchObject({ consumed: false, reason: 'test-runtime-guard' });
      resolveCodexAccountForRun(process.env, { storePath: t.store });
      await new Promise((r) => setTimeout(r, 10));
      expect(t.events.some((e) => e.event === 'reset-consumed')).toBe(false);
      expect(t.events.filter((e) => e.event === 'reset-consume-skipped').every((e) => e.data.reason === 'test-runtime-guard')).toBe(true);
    } finally { t.restore(); }
  });
});

describe('OR-FALLBACK-TIER-1 — resolveRunFallback 이 config 의 openrouter 모델·키 존재를 판정에 싣는다', () => {
  const chainCfg = (fallbackModel?: string) => () => ({ llm: {
    fallbackChain: ['codex-rotate', 'openrouter'],
    ...(fallbackModel ? { openrouter: { fallbackModel } } : {}),
  } });
  const run = (openrouterAvailable: boolean) => {
    const root = isolatedRoot('or-fallback-');
    process.env.CODEX_HOME = join(root, 'codex-home');
    // 판단 스위치(MAX)를 이 격리 우주에서 켠다 — 그래야 ROUTE 결정(emitDecision)이 실제로 나간다.
    resetLiveDetailCacheForTesting();
    writeLiveDetail({ ttlMin: 5 }, { path: join(root, 'live', 'detail.json') });
    const logs: Array<{ category: string; event: string; data: any }> = [];
    const original = debug.log;
    (debug as any).log = (category: string, event: string, data: any) => { logs.push({ category, event, data }); };
    try {
      const decision = resolveRunFallback(process.env, {
        storePath: join(root, 'store.json'), grokAvailable: false, openrouterAvailable,
        currentStep: 'codex-rotate', currentCredentialRateLimited: true,
      });
      return {
        decision,
        decide: logs.find((l) => l.category === 'oauth.fallback-chain' && l.event === 'decide')?.data,
        route: logs.find((l) => l.category === 'harness.decision' && l.data?.kind === 'ROUTE')?.data,
      };
    } finally { (debug as any).log = original; resetLiveDetailCacheForTesting(); }
  };

  test('모델 ⊕ 키 → 그 모델로 전환하고 tier-map 칸(미측정)을 관측에 남긴다', () => {
    _setRotationConfigReaderForTesting(chainCfg('openrouter/z-ai/glm-5.3-flash'));
    const { decision, decide, route } = run(true);
    expect(decision).toEqual({ action: 'switch-backend', backend: 'openrouter', model: 'openrouter/z-ai/glm-5.3-flash' });
    expect(decide).toMatchObject({ openrouterAvailable: true, openrouterModelConfigured: true, model: 'openrouter/z-ai/glm-5.3-flash' });
    expect(decide.modelSpec).toContain('GLM 5.3 Flash');
    expect(decide.modelSpec).toContain('미측정');
    // ROUTE 결정의 reason 에 모델 id ⊕ tier-map 라벨 ⊕ 미측정 근거가 모두 실린다.
    expect(route?.target).toBe('openrouter');
    expect(route?.reason).toContain('openrouter/z-ai/glm-5.3-flash');
    expect(route?.reason).toContain('GLM 5.3 Flash (OpenRouter)');
    expect(route?.reason).toContain('미측정');
  });

  test('키 없음 / 모델 없음 → 머물고 openrouter-unavailable', () => {
    _setRotationConfigReaderForTesting(chainCfg('openrouter/z-ai/glm-5.3-flash'));
    expect(run(false).decision).toEqual({ action: 'stay', why: 'openrouter-unavailable' });
    _setRotationConfigReaderForTesting(chainCfg());
    expect(run(true).decision).toEqual({ action: 'stay', why: 'openrouter-unavailable' });
  });
});
