// streamLLM 실경로 배선 시험 — 정책 없음(회귀: 동작 불변 · 원장 줄만) · 정책 있음(행→계정 전달 · 신호 기록) · 깨짐(멈춤).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setLiveSpendTestSeam, streamLLM, type LLMProvider } from './llm.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createInMemoryGuardStore } from './oauth/llm-spend-guard.js';
import { readRecentSpendTransitions } from './nexus/llm-spend-policy/ledger.js';
import { appendSpendObservation, readSpendObservations } from './nexus/llm-spend-policy/observations.js';
import { writeStoredSpendPolicy } from './nexus/llm-spend-policy/store.js';
import { signalToObservation } from './oauth/llm-call-live.js';
import { effectiveCodexAccountName } from './oauth/codex-account-override.js';
import { setTestStateRoot } from './nexus/paths.js';
import type { LlmSpendRowState } from './nexus/llm-spend-policy/types.js';

let dir: string;
const T = new Date('2026-11-20T03:00:00.000Z');
const LEASE = '2026-11-20T23:00:00.000Z';

// 열차 gate 환경(전역 가짜 LLM 스위치 · sim universe 등)이 주입 provider 를 건너뛰고 fake 로 응답해 «호출 자체가 안 일어나는» 회귀(#39187 열차 gate introduced 3)를
// 막는다 — 이 시험은 실 provider 계약(주입 provider 가 불린다)을 보므로 주변 가짜 스위치를 걷는다.
const AMBIENT_FAKE_ENV = ['ELANOUS_LLM_MODE', 'ELANOUS_TEST_FAKE_LLM', 'ELANOUS_UX_SIM_RUN_ID', 'ELANOUS_SIM_UNIVERSE', 'ELANOUS_TEST_FAKE_LLM_AS_PROVIDER'] as const;
const savedFakeEnv: Partial<Record<(typeof AMBIENT_FAKE_ENV)[number], string | undefined>> = {};
beforeEach(() => {
  for (const key of AMBIENT_FAKE_ENV) { savedFakeEnv[key] = process.env[key]; delete process.env[key]; }
  dir = join(mkdtempSync(join(tmpdir(), 'llm-live-wire-')), 'llm-spend-policy');
});
afterEach(() => { for (const key of AMBIENT_FAKE_ENV) { if (savedFakeEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedFakeEnv[key]; } __setLiveSpendTestSeam(undefined); setTestStateRoot(null); rmSync(join(dir, '..'), { recursive: true, force: true }); delete process.env.ELANOUS_CODEX_ACCOUNT; });

function leased(pct: Record<string, number>): () => LlmSpendRowState[] {
  return () => ['codex-default', 'codex-team', 'codex-third', 'claude-code-sub'].map((row) => ({
    row, provider: 'openai-codex',
    window: { status: 'measured' as const, usedPct: pct[row] ?? 10, observedAt: T.toISOString() },
    lease: { leaseId: `l-${row}`, expiresAt: LEASE },
  }));
}
function seam(extra: Record<string, unknown> = {}) {
  __setLiveSpendTestSeam({ eligible: true, deps: { policyDir: dir, memory: createInMemoryGuardStore(), now: () => T, observers: [leased({})], ...extra } });
}
async function run(): Promise<{ text: string; seen: (string | undefined)[] }> {
  const seen: (string | undefined)[] = [];
  const text = await streamLLM([{ role: 'user', content: 'hi' }], () => { seen.push(effectiveCodexAccountName()); }, { usageRole: undefined });
  return { text, seen };
}

describe('streamLLM 지출 관문 배선', () => {
  test('회귀: 정책 없음 → 결과·계정 입력이 관문 없는 호출과 동일 · 원장 observe 1줄만', async () => {
    const baseline = await run(); // 시험 우주 기본 = 관문 비대상
    seam();
    const withGate = await run();
    expect(withGate.text).toBe(baseline.text);
    expect(withGate.seen).toEqual(baseline.seen);
    expect(process.env.ELANOUS_CODEX_ACCOUNT).toBeUndefined();
    const ledger = await readRecentSpendTransitions(20, dir);
    expect(ledger.map((l) => [l.action, l.what])).toEqual([['observe', 'pass-through']]);
    expect(await readSpendObservations(dir)).toEqual([]);
  });
  test('정책 없음 → 같은 프로세스에서 여러 번 호출해도 pass-through observe 줄은 1줄(원장 부풀음 0)', async () => {
    seam();
    await run();
    await run();
    await run();
    const ledger = await readRecentSpendTransitions(20, dir);
    expect(ledger.filter((l) => l.what === 'pass-through').length).toBe(1);
  });

  test('정책 있음: codex-default 가 소진되면 codex-team 이 선택돼 호출 범위 계정=team(env 불변)', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } });
    seam({ observers: [leased({ 'codex-default': 100 })] });
    const r = await run();
    expect(r.seen.length).toBeGreaterThan(0);
    expect(new Set(r.seen)).toEqual(new Set(['team']));
    expect(process.env.ELANOUS_CODEX_ACCOUNT).toBeUndefined();
  });

  test('정책 있음 + 임대 없음(observers 빈 상태) → 모든 행 불가 → 멈춤(throw)', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } });
    seam({ observers: [] });
    await expect(run()).rejects.toThrow(/LLM spend guard stop/);
  });

  test('정책 정본이 깨짐(마지막 정상 사본도 없음) → policy-unreadable 멈춤', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'policy.yaml'), 'providers: [unclosed', 'utf8');
    seam();
    await expect(run()).rejects.toThrow(/policy-unreadable/);
    const ledger = await readRecentSpendTransitions(20, dir);
    expect(ledger[0]!.reason).toContain('policy-unreadable');
  });

  test('실제 신호: real 관측(429 소진)이 기본 observer 로 읽혀 그 행을 건너뛴다', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } });
    await appendSpendObservation(signalToObservation({ callId: 'c', at: T.toISOString(), row: 'codex-default', provider: 'openai-codex', signal: { kind: 'usage_limit_reached', resetsAt: '2026-11-20T08:00:00.000Z' } }), dir);
    // 기본 observer(관측 저장소) + 임대 슬롯만 주입 — 창은 저장소 값(codex-default 100%)
    const lease = () => ['codex-default', 'codex-team', 'codex-third', 'claude-code-sub'].map((row): LlmSpendRowState => ({ row, provider: 'openai-codex', lease: { leaseId: `l-${row}`, expiresAt: LEASE } }));
    const { createObservationObserver } = await import('./nexus/llm-spend-policy/observations.js');
    const teamWindow = () => [{ row: 'codex-team', provider: 'openai-codex', window: { status: 'measured' as const, usedPct: 5, observedAt: T.toISOString() } }];
    seam({ observers: [lease, createObservationObserver(dir), teamWindow] });
    const r = await run();
    expect(new Set(r.seen)).toEqual(new Set(['team']));
  });

  test('호출이 429 usage_limit_reached 로 실패하면 settle 이 그 행 창을 소진(real)으로 기록한다', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } });
    seam();
    const failing: LLMProvider = {
      name: 'fail-provider', defaultModel: 'm', available: () => true,
      async *chat() { yield ''; },
      // eslint-disable-next-line require-yield
      async *streamChat() { throw Object.assign(new Error('{"error":{"type":"usage_limit_reached","resets_at":1795200000}}'), { status: 429 }); },
    };
    await expect(streamLLM([{ role: 'user', content: 'hi' }], () => {}, { provider: failing })).rejects.toBeDefined();
    const obs = await readSpendObservations(dir);
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ row: 'codex-default', kind: 'window', source: 'real', usedPct: 100, resetAt: '2026-11-20T18:40:00.000Z', event: 'usage_limit_reached' });
  });

  // ── 수리: 전역 env 변경 금지 · 관문 오류 fail-closed · synthetic 은 실 관문 무시 ──
  function slowProvider(seen: (string | undefined)[], gate: Promise<void>): LLMProvider {
    return {
      name: 'slow-provider', defaultModel: 'm', available: () => true,
      async *chat() { yield ''; },
      async *streamChat() { seen.push(effectiveCodexAccountName()); yield { type: 'text' as const, delta: 'a' }; await gate; seen.push(effectiveCodexAccountName()); yield { type: 'text' as const, delta: 'b' }; },
    };
  }
  async function viaGate(p: LLMProvider): Promise<string> { return streamLLM([{ role: 'user', content: 'hi' }], () => {}, { provider: p }); }
  const tick = () => new Promise<void>((r) => setTimeout(r, 25));

  test('겹친 호출 A(team)·B(default) 가 각자 자기 계정으로 호출되고 process.env 는 전 과정에서 불변(영구 잔존 0)', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } });
    const before = process.env.ELANOUS_CODEX_ACCOUNT;
    let releaseA!: () => void;
    const seenA: (string | undefined)[] = [];
    const seenB: (string | undefined)[] = [];
    seam({ observers: [leased({ 'codex-default': 100 })] }); // A → team
    const a = viaGate(slowProvider(seenA, new Promise<void>((r) => { releaseA = r; })));
    await tick();
    seam({ observers: [leased({})] }); // B → default
    const b = viaGate(slowProvider(seenB, Promise.resolve()));
    await b;
    expect(process.env.ELANOUS_CODEX_ACCOUNT).toBe(before); // A 진행 중 B 가 끝나도 env 불변
    releaseA();
    await a;
    expect(seenA).toEqual(['team', 'team']);
    expect(seenB).toEqual(['default', 'default']);
    expect(process.env.ELANOUS_CODEX_ACCOUNT).toBe(before);
  });
  test('예외 경로에서도 process.env 잔존 0', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } });
    seam({ observers: [leased({ 'codex-default': 100 })] });
    const boom: LLMProvider = { name: 'boom', defaultModel: 'm', available: () => true, async *chat() { yield ''; },
      // eslint-disable-next-line require-yield
      async *streamChat() { throw new Error('boom'); } };
    await expect(viaGate(boom)).rejects.toThrow('boom');
    expect(process.env.ELANOUS_CODEX_ACCOUNT).toBeUndefined();
    expect(effectiveCodexAccountName()).toBeUndefined();
  });

  const throwingMemory = { load: () => { throw new Error('lock-error EAGAIN'); }, save: () => { throw new Error('lock-error EAGAIN'); } } as unknown as ReturnType<typeof createInMemoryGuardStore>;
  test('정책 있음 + gate throw(락 오류 주입) → 멈춤 + 원장 gate-error 줄', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } });
    seam({ memory: throwingMemory });
    await expect(run()).rejects.toThrow(/LLM spend guard stop: gate-error/);
    expect((await readRecentSpendTransitions(20, dir)).some((l) => l.what === 'stop' && l.reason.startsWith('gate-error'))).toBe(true);
  });
  test('정책 있음 + deps 구성 실패(throw) → 멈춤', async () => {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } });
    __setLiveSpendTestSeam({ eligible: true, deps: { policyDir: dir, now: () => T, get observers(): never { throw new Error('deps-fail'); } } });
    await expect(run()).rejects.toThrow(/gate-error/);
  });
  test('정책 없음 + gate throw → 통과(기존 동작 유지)', async () => {
    __setLiveSpendTestSeam({ eligible: true, deps: { policyDir: dir, now: () => T, get observers(): never { throw new Error('deps-fail'); } } });
    const baseline = await (async () => { __setLiveSpendTestSeam(undefined); return run(); })();
    __setLiveSpendTestSeam({ eligible: true, deps: { policyDir: dir, now: () => T, get observers(): never { throw new Error('deps-fail'); } } });
    const r = await run();
    expect(r.text).toBe(baseline.text);
  });

  async function syntheticTeamExhausted() {
    await writeStoredSpendPolicy({ actor: 'test', dir, document: { providers: { 'codex-default': { capPct: 90 } } } });
    await appendSpendObservation({ id: 'syn-1', row: 'codex-default', provider: 'openai-codex', kind: 'window', source: 'synthetic', observedAt: T.toISOString(), usedPct: 100, event: 'usage_limit_reached' }, dir);
    const { createObservationObserver } = await import('./nexus/llm-spend-policy/observations.js');
    const lease = () => ['codex-default', 'codex-team', 'codex-third', 'claude-code-sub'].map((row): LlmSpendRowState => ({ row, provider: 'openai-codex', window: { status: 'measured', usedPct: 10, observedAt: T.toISOString() }, lease: { leaseId: `l-${row}`, expiresAt: LEASE } }));
    return { lease, createObservationObserver };
  }
  test('운영 신원: 저장소의 synthetic 소진 관측이 실 관문 결과에 영향 0(codex-default 그대로)', async () => {
    const { lease } = await syntheticTeamExhausted();
    // 기본 배선 observer(관측 저장소) — 운영 신원(getTestStateRoot 없음)
    const { defaultLiveGateDeps } = await import('./oauth/llm-call-live.js');
    const d = await defaultLiveGateDeps(dir);
    seam({ observers: [lease, ...d.observers] });
    const r = await run();
    expect(new Set(r.seen)).toEqual(new Set(['default']));
  });
  test('시험 우주 신원: 같은 synthetic 관측을 실 관문 observer 가 읽는다(live synthetic 허용 경로)', async () => {
    const { lease } = await syntheticTeamExhausted();
    setTestStateRoot(join(dir, '..', 'test-root'));
    const { defaultLiveGateDeps } = await import('./oauth/llm-call-live.js');
    const d = await defaultLiveGateDeps(dir);
    seam({ observers: [lease, ...d.observers] });
    const r = await run();
    expect(new Set(r.seen)).toEqual(new Set(['team']));
  });
});
