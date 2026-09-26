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
import { saveTokens } from './store.js';
import {
  _resetCodexRotationPinForTesting,
  _setCodexAccountOutboundSenderForTesting,
  _setRotationConfigReaderForTesting,
  inspectCodexRotation,
  notifyCodexResetCreditConsumed,
  resolveCodexAccountForRun,
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
