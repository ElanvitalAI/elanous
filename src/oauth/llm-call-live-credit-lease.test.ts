// 실 관문 CC-1 잔액 관측기 배선 시험(LLM-POLICY-OR-MANAGEMENT-LEASE) — 임대는 «주입» 만(가짜 문자열) · 실 네트워크 0 · 비밀 출력 0.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeStoredSpendPolicy } from '../nexus/llm-spend-policy/store.js';
import { setTestStateRoot } from '../nexus/paths.js';
import { defaultLiveGateDeps, runLiveGate } from './llm-call-live.js';
import type { LlmSpendRowState } from '../nexus/llm-spend-policy/types.js';

let dir: string;
const T = new Date('2026-11-20T03:00:00.000Z');
const FAKE_LEASE = 'fake-mgmt-lease-ZZ9-not-real';
const okFetch = (async () => new Response(JSON.stringify({ data: { total_credits: 100, total_usage: 40 } }), { status: 200 })) as unknown as typeof fetch;
const failFetch = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;

beforeEach(() => { dir = join(mkdtempSync(join(tmpdir(), 'live-credit-lease-')), 'llm-spend-policy'); });
afterEach(() => { setTestStateRoot(null); rmSync(join(dir, '..'), { recursive: true, force: true }); });

const orState = (states: readonly LlmSpendRowState[]): LlmSpendRowState => {
  const or = states.find((s) => s.row === 'openrouter');
  expect(or).toBeDefined();
  return or!;
};

describe('defaultLiveGateDeps — CC-1 잔액 관측기(임대 주입 경계)', () => {
  test('credit 없음(기본) → 관측기 1개(관측 저장소만) — 기존 배선 그대로 · 결정 영향 0', async () => {
    const deps = await defaultLiveGateDeps(dir);
    expect(deps.observers).toHaveLength(1);
  });
  test('credit 있어도 임대 값이 없으면 관측기를 붙이지 않는다(네트워크 0)', async () => {
    const deps = await defaultLiveGateDeps(dir, { credit: { leases: { openrouter: undefined }, fetchImpl: okFetch } });
    expect(deps.observers).toHaveLength(1);
  });
  test('임대 주입 → 관측기 2개째가 openrouter 잔액 60USD(autoTopUp 은 unmeasured not-provided) · 임대 문자열 노출 0', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { openrouter: { kind: 'credit', provider: 'openrouter' } } } });
    const deps = await defaultLiveGateDeps(dir, { credit: { leases: { openrouter: FAKE_LEASE }, fetchImpl: okFetch, now: () => T } });
    expect(deps.observers).toHaveLength(2);
    const states = await deps.observers[1]!();
    const or = orState(states);
    expect(or.balance).toEqual({ status: 'measured', usd: 60, totalCreditsUsd: 100, totalUsageUsd: 40, source: 'openrouter-credits-derived', observedAt: T.toISOString() });
    expect(or.autoTopUp).toEqual({ status: 'unmeasured', reason: 'not-provided' });
    expect(JSON.stringify(states)).not.toContain(FAKE_LEASE);
  });
  test('정책 없는 우주 → 관측 결과 0개(관문은 pass-through)', async () => {
    const deps = await defaultLiveGateDeps(dir, { credit: { leases: { openrouter: FAKE_LEASE }, fetchImpl: okFetch } });
    expect(await deps.observers[1]!()).toEqual([]);
  });
  test('읽기 실패 → 관측기는 예외를 밖으로 내지 않고 unmeasured(request-failed) — fail-open 아님(모름 그대로)', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { openrouter: { kind: 'credit', provider: 'openrouter' } } } });
    const deps = await defaultLiveGateDeps(dir, { credit: { leases: { openrouter: FAKE_LEASE }, fetchImpl: failFetch } });
    const or = orState(await deps.observers[1]!());
    expect(or.balance).toEqual({ status: 'unmeasured', reason: 'request-failed' });
  });
});

describe('runLiveGate — credit 슬롯 통과(임대 없으면 결정 계약 불변)', () => {
  const req = { role: 'authoring', location: 'host', models: ['openrouter/x/y'], estimateUsd: 1 } as const;
  test('회귀: credit 없이 호출하면 기존과 같은 결과(pass-through · 정책 없는 우주)', async () => {
    const r = await runLiveGate(req, { policyDir: dir });
    expect(r.outcome).toBe('pass-through');
  });
  test('credit 을 넘기고 정책 없는 우주 → 여전히 pass-through(관측기가 결과를 바꾸지 않는다)', async () => {
    const r = await runLiveGate(req, { policyDir: dir, credit: { leases: { openrouter: FAKE_LEASE }, fetchImpl: okFetch, now: () => T } });
    expect(r.outcome).toBe('pass-through');
  });
});
