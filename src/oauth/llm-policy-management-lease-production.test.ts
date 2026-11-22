// #17 LLM-POLICY-OR-MANAGEMENT-LEASE — production 배선 RED(먼저) : 금고 static lease 사본이 있으면
// `eln llm policy` 조회(관측기)와 실 관문(runLiveGate)이 잔액을 «measured» 로 관측하는가 · 값(키)은 출력 0.
// 임대 파일은 이 시험이 직접 짓는다(포맷 elanous-static-lease-copy/v1 · 값 0600 사본 · 메타) — 실 네트워크 0(fetch 주입).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTestStateRoot } from '../nexus/paths.js';
import { resetEffectiveInstanceRoot } from '../instance/resolve.js';
import { resolveStaticLeaseCopy } from '../secret/static-lease-consumer.js';
import { leaseRoots, leaseRootsFromResolution, managementLeasesForSpend } from './llm-call-live-lease-source.js';
import { writeStoredSpendPolicy } from '../nexus/llm-spend-policy/store.js';
import { runLlmPolicyView } from '../cli/llm-policy-cli.js';
import { defaultLiveGateDeps, runLiveGate } from './llm-call-live.js';

const LEASE_VALUE = 'sk-or-v1-fake-management-lease-ZZ9-not-real';

let home: string;

function writeLeaseUniverse(root: string, cacheName = 'openrouter_api_key'): void {
  const copies = join(root, 'secrets-lease', 'copies');
  const meta = join(root, 'secrets-lease', 'meta');
  mkdirSync(copies, { recursive: true, mode: 0o700 });
  mkdirSync(meta, { recursive: true, mode: 0o700 });
  const copyPath = join(copies, cacheName);
  writeFileSync(copyPath, `${LEASE_VALUE}\n`, { mode: 0o600 });
  chmodSync(copyPath, 0o600);
  writeFileSync(join(meta, `${cacheName}.json`), `${JSON.stringify({
    format: 'elanous-static-lease-copy/v1', leaseId: 'sl-test-lease-1', kind: 'static', id: 'openrouter',
    cacheName, target: root, issuedAt: '2026-11-22T05:00:00.000Z', expiresAt: '2030-01-01T00:00:00.000Z', copyPath,
  })}\n`, { mode: 0o600 });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'lease-prod-'));
  process.env.ELANOUS_INSTANCE_ROOT = home;
  process.env.ELANOUS_KEY_CACHE_DIR = join(home, 'cache');
  mkdirSync(join(home, 'cache'), { recursive: true });
});
afterEach(() => {
  delete process.env.ELANOUS_INSTANCE_ROOT;
  delete process.env.ELANOUS_KEY_CACHE_DIR;
  setTestStateRoot(null);
  rmSync(home, { recursive: true, force: true });
});

describe('LLM-POLICY-OR-MANAGEMENT-LEASE — production 임대 배선', () => {
  test('금고 임대 사본이 살아 있으면 관리 임대 문자열이 조달된다(값은 문자열 그대로 · 미출력)', async () => {
    writeLeaseUniverse(home);
    const { resolve } = await import('node:path');
    const got = resolveStaticLeaseCopy('openrouter_api_key', {
      roots: [home],
      cacheFilePath: resolve(join(home, 'cache', 'openrouter_api_key')),
    });
    // 규칙 11(REVIEW-2): 기대값은 가짜 임대 입력(writeLeaseUniverse)과 독립된 리터럴로 검증한다.
    expect(got?.value).toBe('sk-or-v1-fake-management-lease-ZZ9-not-real');
    expect(got?.lease.leaseId).toBe('sl-test-lease-1');
  });

  test('없으면 null — 임대 없는 우주는 조달 0(missing-management-lease)', async () => {
    const { resolve } = await import('node:path');
    const got = resolveStaticLeaseCopy('openrouter_api_key', {
      roots: [home],
      cacheFilePath: resolve(join(home, 'cache', 'openrouter_api_key')),
    });
    expect(got).toBeNull();
  });
});

describe('LLM-POLICY-OR-MANAGEMENT-LEASE — production 관측기·관문 배선(RED: 아직 조달기 부재)', () => {
  test('managementLeasesForSpend() — 임대 우주면 { openrouter: <값> } · 없으면 {} (값 미출력)', async () => {
    writeLeaseUniverse(home);
    const withLease = managementLeasesForSpend();
    // 규칙 11(REVIEW-2): 기대값은 가짜 임대 입력과 독립된 리터럴로 검증한다.
    expect(withLease.openrouter).toBe('sk-or-v1-fake-management-lease-ZZ9-not-real');
    delete process.env.ELANOUS_INSTANCE_ROOT;
    process.env.ELANOUS_INSTANCE_ROOT = join(home, 'empty-universe');
    mkdirSync(process.env.ELANOUS_INSTANCE_ROOT, { recursive: true });
    expect(managementLeasesForSpend().openrouter).toBeUndefined();  });

  test('runLlmPolicyView 가 임대 우주에서 openrouter 잔액 measured(가짜 fetch) · 키 값 본문 0', async () => {
    writeLeaseUniverse(home);
    const policyDir = join(home, 'llm-spend-policy');
    mkdirSync(policyDir, { recursive: true });
    await writeStoredSpendPolicy({ actor: 'test', dir: policyDir, document: { rows: { openrouter: { kind: 'credit', provider: 'openrouter' } } } } as never);
    setTestStateRoot(home);
    const lines: string[] = [];
    const okFetch = (async () => new Response(JSON.stringify({ data: { total_credits: 100, total_usage: 40 } }), { status: 200 })) as unknown as typeof fetch;
    // ⛔ production 경계: credit 주입 없이(사용자가 치는 그대로) 돌려도 임대에서 조달돼야 measured 가 찍힌다.
    // fetch 주입은 계약 필드(credit.fetchImpl)로 — 사용자가 치는 경로(lease 조달)는 그대로 둔다.
    await runLlmPolicyView({ out: (l: string) => lines.push(l), credit: { fetchImpl: okFetch } } as never);
    const text = lines.join('\n');
    // 잔액은 openrouter 행 기준으로 정확히 임다 — 다른 행의 창/지출 unmeasured(주입 없음)는 정상 출력이다.
    expect(text).not.toContain('잔액 unmeasured');           // openrouter 잔액이 measured 여야(임대 조달 증명)
    expect(text).toContain('잔액 60USD');                     // 가짜 fetch 100−40=60 반영
    expect(text).not.toContain(LEASE_VALUE);
  });
});

// JUD #39513 mustFix — 격리 경계: ELANOUS_INSTANCE_ROOT 로 지정한 격리 우주에 임대가 없으면
// 조달을 종료한다(운영 루트 폴백 금지). 별도 운영 루트(fakeHome/.elanous)에 합성 임대를 두고
// 루트 후보 해석과 두 진입점(조회 runLlmPolicyView · 실 관문 runLiveGate)에서
// 운영 임대 미선택·외부 호출 0 을 잰다.
describe('격리 경계 — 격리 우주에 임대 없으면 운영 임대 폴백 금지(JUD #39513)', () => {
  let fakeHome: string;
  let realHome: string | undefined;

  beforeEach(() => {
    realHome = process.env.HOME;
    fakeHome = mkdtempSync(join(tmpdir(), 'lease-prodhome-'));
    process.env.HOME = fakeHome;                       // os.homedir() 가 볼 HOME
    writeLeaseUniverse(join(fakeHome, '.elanous'));    // «운영 루트»에 합성 임대(살아 있음)
  });
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  test('루트 후보 — 격리 우주(ELANOUS_INSTANCE_ROOT)가 지정되면 운영 루트는 후보에 없다', () => {
    const roots = leaseRoots();
    const prodLike = roots.filter((r) => r.includes('.elanous') && !r.startsWith(home));
    expect(prodLike).toEqual([]);                      // .elanous 운영 루트가 남아 있으면 누출(RED)
    expect(roots[0]).toBe(home);                       // 격리 우주 최우선
  });

  test('조달기 — 격리 우주(임대 없음)는 운영 임대를 선택하지 않는다', () => {
    // home(beforeEach) 은 임대 없는 격리 우주 · fakeHome/.elanous 는 임대 있는 운영 루트.
    const got = managementLeasesForSpend();
    expect(got.openrouter).toBeUndefined();            // 운영 임대 폴백이 있으면 LEASE_VALUE 가 새어 나온다(RED)
    expect(JSON.stringify(got)).not.toContain(LEASE_VALUE);
  });

  test('조회 진입점 runLlmPolicyView — 격리 우주는 잔액 unmeasured · 외부 호출 0 · 키 값 본문 0', async () => {
    const policyDir = join(home, 'llm-spend-policy');
    mkdirSync(policyDir, { recursive: true });
    await writeStoredSpendPolicy({ actor: 'test', dir: policyDir, document: { rows: { openrouter: { kind: 'credit', provider: 'openrouter' } } } } as never);
    setTestStateRoot(home);
    let fetchCalls = 0;
    const countingFetch = (async () => { fetchCalls += 1; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    const lines: string[] = [];
    await runLlmPolicyView({ out: (l: string) => lines.push(l), credit: { fetchImpl: countingFetch } } as never);
    const text = lines.join('\n');
    expect(text).toContain('unmeasured');              // openrouter 행이 measured 면 운영 임대가 샌 것이다(RED)
    expect(fetchCalls).toBe(0);                        // 외부 호출 0
    expect(text).not.toContain(LEASE_VALUE);
  });

  test('실 관문 runLiveGate — 격리 우주는 잔액 관측기 부착 0(전역 fetch 0회)', async () => {
    const policyDir = join(home, 'llm-spend-policy');
    mkdirSync(policyDir, { recursive: true });
    await writeStoredSpendPolicy({ actor: 'test', dir: policyDir, document: { rows: { openrouter: { kind: 'credit', provider: 'openrouter' } } } } as never);
    setTestStateRoot(home);
    // 관측기 부착 여부 — 운영 임대가 샌다면 잔액 관측기가 2개째로 붙는다.
    const deps = await defaultLiveGateDeps(policyDir);
    expect(deps.observers).toHaveLength(1);            // 잔액 관측기 부착 = 운영 임대 누출(RED)
    // 실 관문 종단 — 전역 fetch 를 세는 것으로 외부 호출 0 을 증명(credit 미주입 = 사용자가 치는 경로).
    const origFetch = globalThis.fetch;
    let globalFetchCalls = 0;
    globalThis.fetch = (async () => { globalFetchCalls += 1; return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    try {
      await runLiveGate({ role: 'authoring', location: 'host', models: ['openrouter/x/y'], estimateUsd: 1 }, { policyDir });
    } finally { globalThis.fetch = origFetch; }
    expect(globalFetchCalls).toBe(0);                  // 운영 임대 폴백이 있으면 잔액 관측이 fetch 를 친다(RED)
  });

  // JUD #39513 mustFix 1(r2·jud-39513-2b76efc26065) — ELANOUS_INSTANCE_ROOT 명시 경로만이 아니라
  // ELANOUS_STATE_DIR 스탬프·config override 가 고른 실효 격리 루트에서도 운영 루트 폴백이 없어야 한다.
  test('루트 후보 — ELANOUS_STATE_DIR 실효 격리 루트는 운영 루트를 뒤에 붙이지 않는다(mustFix 1·r2)', () => {
    const prevExplicit = process.env.ELANOUS_INSTANCE_ROOT;
    delete process.env.ELANOUS_INSTANCE_ROOT;
    const isolated = join(home, 'state-isolated');
    mkdirSync(isolated, { recursive: true });
    const prev = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = isolated;
    resetEffectiveInstanceRoot();
    try {
      const roots = leaseRoots();
      const prodLike = roots.filter((r) => r.includes('.elanous') && !r.startsWith(home));
      expect(prodLike).toEqual([]);                    // 운영 루트(fakeHome/.elanous)가 후보에 남으면 누출(RED)
      expect(roots[0]).toBe(isolated);                 // 스탬프 실효 격리 루트 최우선
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = prev;
      if (prevExplicit === undefined) delete process.env.ELANOUS_INSTANCE_ROOT; else process.env.ELANOUS_INSTANCE_ROOT = prevExplicit;
      resetEffectiveInstanceRoot();
    }
  });

  test('조달기 — ELANOUS_STATE_DIR 실효 격리 루트(임대 없음)도 운영 임대를 선택하지 않는다(mustFix 1·r2)', () => {
    const prevExplicit = process.env.ELANOUS_INSTANCE_ROOT;
    delete process.env.ELANOUS_INSTANCE_ROOT;
    const isolated = join(home, 'state-isolated-2');
    mkdirSync(isolated, { recursive: true });
    const prev = process.env.ELANOUS_STATE_DIR;
    process.env.ELANOUS_STATE_DIR = isolated;
    resetEffectiveInstanceRoot();
    try {
      const got = managementLeasesForSpend();
      expect(got.openrouter).toBeUndefined();          // 운영 임대 폴백이 있으면 LEASE_VALUE 가 샌다(RED)
      expect(JSON.stringify(got)).not.toContain(LEASE_VALUE);
    } finally {
      if (prev === undefined) delete process.env.ELANOUS_STATE_DIR; else process.env.ELANOUS_STATE_DIR = prev;
      if (prevExplicit === undefined) delete process.env.ELANOUS_INSTANCE_ROOT; else process.env.ELANOUS_INSTANCE_ROOT = prevExplicit;
      resetEffectiveInstanceRoot();
    }
  });

  // OP #131601(홀드 필수 1 뒤끝) — 실효 우주 해석이 안 되면(부팅 초기 등) 운영 폴백 없이
  // 빈 결과로 조달을 종료한다(fail-closed). 순수 함수로 계약을 고정한다.
  test('루트 후보 — 실효 우주 미확정은 빈 결과(운영 폴백 0 · fail-closed)', () => {
    const prodRoot = join(fakeHome, '.elanous');
    expect(leaseRootsFromResolution(undefined, prodRoot)).toEqual([]);                    // 실효 미확정 = 폴백 없음
    const isolated = join(home, 'unresolved-isolated');
    expect(leaseRootsFromResolution(isolated, prodRoot)).toEqual([isolated]);            // 격리 실효 = 그 우주만
    expect(leaseRootsFromResolution(prodRoot, prodRoot)).toEqual([prodRoot]);             // 운영 우주 = 운영 루트만
  });
});
