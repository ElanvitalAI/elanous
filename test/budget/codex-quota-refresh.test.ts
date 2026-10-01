import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { refreshCodexQuotaSignals } from '../../src/budget/codex-quota-refresh.js';
import { readQuotaSignalObservedAt, writeQuotaSignal } from '../../src/budget/codex-reset-credit-state.js';

const madeDirs: string[] = [];
const originalStateDir = process.env.ELANOUS_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = originalStateDir;
  for (const dir of madeDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('refreshCodexQuotaSignals', () => {
  test('fresh accounts are not fetched while missing signals are refreshed', async () => {
    const fetched: string[] = [];
    const result = await refreshCodexQuotaSignals({
      deps: {
        now: () => 1_000_000,
        listAccounts: () => [
          { name: 'fresh', storeKey: 'openai-codex' },
          { name: 'stale', storeKey: 'openai-codex:stale' },
        ],
        loadAccount: (key) => ({ codexHome: `/homes/${key}` }),
        readObservedAt: (_now, home) => home.endsWith('openai-codex') ? 999_999 : undefined,
        fetch: async (home) => { fetched.push(home); },
      },
    });
    expect(result.accounts).toEqual([
      { account: 'fresh', status: 'fresh' },
      { account: 'stale', status: 'refreshed' },
    ]);
    expect(fetched).toEqual(['/homes/openai-codex:stale']);
  });

  test('account timeout aborts its fetch and continues with later accounts', async () => {
    const fetched: string[] = [];
    let timedOutSignal: AbortSignal | undefined;
    const result = await refreshCodexQuotaSignals({
      accountTimeoutMs: 5,
      deps: {
        now: () => 1_000_000,
        listAccounts: () => [
          { name: 'slow', storeKey: 'openai-codex:slow' },
          { name: 'later', storeKey: 'openai-codex:later' },
        ],
        loadAccount: (key) => ({ codexHome: `/homes/${key}` }),
        readObservedAt: () => undefined,
        fetch: async (home, signal) => {
          fetched.push(home);
          if (home.endsWith('slow')) {
            timedOutSignal = signal;
            await new Promise<void>(() => {});
          }
        },
      },
    });
    // ⭐ 이 계정은 «재다가» 상한을 넘겼다 ⇒ timed-out. 던진 것(failed)과 다른 값이어야
    //   조회에서 「네트워크가 느리다」와 「인증이 깨졌다」가 갈린다.
    expect(result.accounts).toEqual([
      { account: 'slow', status: 'timed-out' },
      { account: 'later', status: 'refreshed' },
    ]);
    expect(timedOutSignal?.aborted).toBe(true);
    expect(fetched).toEqual(['/homes/openai-codex:slow', '/homes/openai-codex:later']);
  });

  test('missing homes are skipped and a failed account does not stop later accounts', async () => {
    const fetched: string[] = [];
    const result = await refreshCodexQuotaSignals({
      deps: {
        now: () => 1_000_000,
        listAccounts: () => [
          { name: 'unknown', storeKey: 'openai-codex:unknown' },
          { name: 'broken', storeKey: 'openai-codex:broken' },
          { name: 'later', storeKey: 'openai-codex:later' },
        ],
        loadAccount: (key) => key.endsWith('unknown') ? {} : { codexHome: `/homes/${key}` },
        readObservedAt: () => undefined,
        fetch: async (home) => {
          fetched.push(home);
          if (home.endsWith('broken')) throw new Error('measurement failed');
        },
      },
    });
    expect(result.accounts).toEqual([
      { account: 'unknown', status: 'missing-home' },
      { account: 'broken', status: 'failed' },
      { account: 'later', status: 'refreshed' },
    ]);
    expect(fetched).toEqual(['/homes/openai-codex:broken', '/homes/openai-codex:later']);
  });

  test('account record and signal reader failures are isolated from later accounts', async () => {
    const fetched: string[] = [];
    const result = await refreshCodexQuotaSignals({
      deps: {
        now: () => 1_000_000,
        listAccounts: () => [
          { name: 'broken-record', storeKey: 'openai-codex:broken-record' },
          { name: 'broken-signal', storeKey: 'openai-codex:broken-signal' },
          { name: 'later', storeKey: 'openai-codex:later' },
        ],
        loadAccount: (key) => {
          if (key.endsWith('broken-record')) throw new Error('account store unavailable');
          return { codexHome: `/homes/${key}` };
        },
        readObservedAt: (_now, home) => {
          if (home.endsWith('broken-signal')) throw new Error('signal unreadable');
          return undefined;
        },
        fetch: async (home) => { fetched.push(home); },
      },
    });
    expect(result.accounts).toEqual([
      { account: 'broken-record', status: 'failed' },
      { account: 'broken-signal', status: 'failed' },
      { account: 'later', status: 'refreshed' },
    ]);
    expect(fetched).toEqual(['/homes/openai-codex:later']);
  });

  // ⛔⭐⭐ 리뷰 must-fix — 상한 관문 «뒤»에 계정 로드·신호 조회가 시간을 쓴다. 그 사이 상한이 지나면
  //   종전엔 그대로 내려가 fetch 를 «시작»했다(waitForFetchOrTimeout 이 타이머보다 먼저 fetch 를 부른다)
  //   ⇒ 상한을 넘겨 «자식을 실제로 띄우고», 분류도 skipped-by-cap 이 아니라 timed-out 으로 거짓말했다.
  test('deadline crossed while loading an account skips it and the rest without fetching', async () => {
    const fetched: string[] = [];
    let tick = 0;
    const result = await refreshCodexQuotaSignals({
      totalTimeoutMs: 50,
      deps: {
        // 1st(루프 관문)=100 → 아직 여유. 이후 로드·조회가 시간을 써서 deadline(150)을 넘긴다.
        now: () => [100, 120, 140, 200, 200, 200][tick++] ?? 200,
        listAccounts: () => [
          { name: 'first', storeKey: 'openai-codex:first' },
          { name: 'second', storeKey: 'openai-codex:second' },
        ],
        loadAccount: (key) => ({ codexHome: `/homes/${key}` }),
        readObservedAt: () => undefined,
        fetch: async (home) => { fetched.push(home); },
      },
    });
    // ⭐ 현재 계정«부터» 나머지 전부가 skipped-by-cap 이고, fetch 는 «한 번도» 안 불린다.
    expect(result.accounts).toEqual([
      { account: 'first', status: 'skipped-by-cap' },
      { account: 'second', status: 'skipped-by-cap' },
    ]);
    expect(fetched).toEqual([]);
  });

  // ⛔⭐ 리뷰 should-fix — 종전엔 목록 조회 실패를 삼켜 «빈 성공»을 냈고, 그러면 호출자가
  //   `quota-refresh: completed` 로 기록해 ***관측이 상위 상태와 모순***됐다.
  test('account listing failure propagates instead of reporting an empty success', async () => {
    const observed: Array<{ event: string }> = [];
    await expect(refreshCodexQuotaSignals({
      deps: {
        listAccounts: () => { throw new Error('store unreadable'); },
        observe: (event) => { observed.push({ event }); },
      },
    })).rejects.toThrow('store unreadable');
    // ⭐ 그래도 «왜» 실패했는지는 관측에 남는다
    expect(observed.map((o) => o.event)).toContain('refresh-failed');
  });

  test('real account-home signals drive fresh versus refreshed results and preserve process.env', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'codex-quota-refresh-'));
    madeDirs.push(stateDir);
    process.env.ELANOUS_STATE_DIR = stateDir;
    const freshHome = join(stateDir, 'fresh-home');
    const missingHome = join(stateDir, 'missing-home');
    writeQuotaSignal(undefined, 12, freshHome);
    const beforeEnv = { ...process.env };
    const fetched: string[] = [];
    const observed: Array<{ event: string; data: Record<string, unknown> }> = [];

    const result = await refreshCodexQuotaSignals({
      deps: {
        listAccounts: () => [
          { name: 'fresh', storeKey: 'openai-codex:fresh' },
          { name: 'missing', storeKey: 'openai-codex:missing' },
        ],
        loadAccount: (key) => ({ codexHome: key.endsWith('fresh') ? freshHome : missingHome }),
        fetch: async (home) => { fetched.push(home); },
        observe: (event, data) => { observed.push({ event, data }); },
      },
    });

    expect(readQuotaSignalObservedAt(Date.now(), freshHome)).toBeNumber();
    expect(result.accounts).toEqual([
      { account: 'fresh', status: 'fresh' },
      { account: 'missing', status: 'refreshed' },
    ]);
    expect(fetched).toEqual([missingHome]);
    expect(observed).toContainEqual({
      event: 'completed',
      data: expect.objectContaining({ total: 2, fresh: 1, refreshed: 1, skipped: 1 }),
    });
    expect(process.env).toEqual(beforeEnv);
  });

  test('total timeout marks every remaining account as skipped-by-cap without fetching', async () => {
    let tick = 0;
    const observed: Array<{ event: string; data: Record<string, unknown> }> = [];
    const result = await refreshCodexQuotaSignals({
      totalTimeoutMs: 40,
      deps: {
        now: () => tick++ === 0 ? 100 : 140,
        listAccounts: () => [
          { name: 'first', storeKey: 'openai-codex:first' },
          { name: 'second', storeKey: 'openai-codex:second' },
        ],
        fetch: async () => { throw new Error('must not fetch after deadline'); },
        observe: (event, data) => { observed.push({ event, data }); },
      },
    });
    // ⭐ 이 둘은 «시도조차 안 했다» ⇒ skipped-by-cap. 「재다 못 잤다」가 아니다.
    expect(result.accounts).toEqual([
      { account: 'first', status: 'skipped-by-cap' },
      { account: 'second', status: 'skipped-by-cap' },
    ]);
    expect(observed).toContainEqual({
      event: 'completed',
      data: expect.objectContaining({ total: 2, 'skipped-by-cap': 2, skipped: 2 }),
    });
  });
});

// ⛔⭐⭐⭐⭐ 2026-08-07 — **기본 계정만 쿼터가 «한 번도» 안 재졌다.**
//   정본 스토어는 기본 계정(`openai-codex`)에 codexHome 을 «안» 싣는다(그 홈은 규칙으로 정해진다).
//   그런데 이 갱신기가 codexHome «만» 봐서 그 계정을 `missing-home` 으로 건너뛰었다.
//   🧩 신호가 영영 안 생기고 → 판정은 「모른다」 → 결정 ④ 때문에 ***100% 여도 회전이 안 선다.***
//   ⛔ 이 시험은 «갱신기»를 실제로 불러 문다 — effectiveCodexHome 을 직접 부르면 변경 «전»에도
//     통과해서 배선 회귀를 못 잡는다(리뷰 must-fix).
describe('기본 계정도 «측정 대상»이다', () => {
  test('⛔ 정본에 codexHome 이 없는 기본 계정을 건너뛰지 «않고» 잰다', async () => {
    const prior = process.env.CODEX_HOME;
    try {
      process.env.CODEX_HOME = '/homes/env-default';
      const fetched: string[] = [];
      const result = await refreshCodexQuotaSignals({
        deps: {
          now: () => 1_000_000,
          listAccounts: () => [
            { name: 'default', storeKey: 'openai-codex' },          // ⛔ 정본에 홈이 «없다»
            { name: 'ghost', storeKey: 'openai-codex:ghost' },      // ⭐ 이름 계정은 여전히 건너뛴다
          ],
          loadAccount: () => undefined,                             // 두 계정 다 저장된 홈이 없다
          readObservedAt: () => undefined,                          // 신호도 없다 ⇒ 재야 한다
          fetch: async (home) => { fetched.push(home); },
        },
      });
      expect(result.accounts).toEqual([
        { account: 'default', status: 'refreshed' },                // ⛔ 종전엔 missing-home 이었다
        { account: 'ghost', status: 'missing-home' },               // ⭐ 이름 계정 동작은 «안» 바뀐다
      ]);
      // ⭐ 그리고 «규칙이 정한 홈»으로 쟀다 — env 가 가리키는 곳이다
      expect(fetched).toEqual(['/homes/env-default']);
    } finally {
      if (prior === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prior;
    }
  });
});
