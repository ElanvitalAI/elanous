// HARNESS-RESULT-CONTRACT (0.2.26 · RFC-tui-tool-surface-on-graph-harness §4) — SelfImplement 툴 결과를
// launched / pending / observed-only / failed 네 꼴로 구조화했나를 «문면»으로 문는다.
// 판정 신호: 네 꼴 결과 문면 시험 0 fail.
import { describe, expect, test } from 'bun:test';
import {
  dispatchSelfImplement,
  buildLaunchedToolResult,
  buildObservedOnlyToolResult,
  buildFailedToolResult,
  buildPendingToolResult,
  _setObserveOnlyConfigReaderForTesting,
  type SelfImplementRunner,
} from './self-implement.js';
import type { SelfImplementResult, SelfImplementSeams } from '../../self-implement/orchestrator.js';

const OBSERVED_ONLY_PHRASES = [
  '관측 전용이라 런을 발사하지 않았습니다',
  '코드도 안 바꿨습니다',
  '이 결과를 구현 실패로 읽고 직접 Write/Edit 하지 마세요',
] as const;
const LAUNCHED_PHRASES = [
  '하니스가 맡았습니다',
  '런 ',
  '노드 ',
  '다음 조회: ',
  '이 턴에서 파일을 직접 편집하지 마세요',
] as const;

type DispatchArgs = Parameters<typeof dispatchSelfImplement>[0];
type DispatchCtx = Parameters<typeof dispatchSelfImplement>[1];

function baseCtx(): DispatchCtx {
  // 최소 ctx — signal·서피스 채널 없음(비인터랙티브 no-op ux 로 흘러 기존 dispatch 시험과 같다).
  return { cwd: process.cwd() } as unknown as DispatchCtx;
}

function expectAllPhrases(phrases: readonly string[], text: string): void {
  for (const p of phrases) expect(text).toContain(p);
}

describe('SelfImplement 네 꼴 빌더 — 문면 골격 (HARNESS-RESULT-CONTRACT)', () => {
  test('launched 빌더는 SelfImplementResult 필드를 그대로 보존한다(보존 계약)', () => {
    const result = { ok: true, stage: 'pr-opened', branch: 'feat/x', runId: 'r-123' } as unknown as SelfImplementResult;
    const launched = buildLaunchedToolResult(result);
    expect(launched.kind).toBe('launched');
    expect(launched.ok).toBe(true);
    expect(launched.stage).toBe('pr-opened');
    expect(launched.branch).toBe('feat/x');
    expect(launched.runId).toBe('r-123');
  });

  test('launched 문면 — 런 id·노드·조회 명령·직접 편집 금지를 싣는다', () => {
    const launched = buildLaunchedToolResult({ ok: true, runId: 'r-123' } as unknown as SelfImplementResult);
    expectAllPhrases(LAUNCHED_PHRASES, launched.message);
    expect(launched.message).toContain('r-123');
    expect(launched.message).toContain('eln self run r-123');
  });

  test('공개 launched 빌더도 runId 가 없으면 pending을 반환한다', () => {
    const pending = buildLaunchedToolResult({ ok: true } as unknown as SelfImplementResult);
    expect(pending).toMatchObject({ kind: 'pending', next: 'eln self running-runs', missing: ['runId', 'node'] });
    expect(pending).not.toHaveProperty('runId');
    expect(pending.message).not.toContain('하니스가 맡았습니다');
  });

  test('observed-only 문면 — 발사 안 함·코드 무변·구현 실패 아님을 한 문면으로 말한다', () => {
    const observed = buildObservedOnlyToolResult();
    expect(observed.kind).toBe('observed-only');
    expect(observed.observed).toBe(true);
    expectAllPhrases(OBSERVED_ONLY_PHRASES, observed.message);
    expect(observed.missing).toEqual(['runId', 'node']);
  });

  test('런 ID가 확인되지 않으면 pending으로 남기고 선할당 ID를 내보내지 않는다', () => {
    const pending = buildPendingToolResult({ ok: true, stage: 'pr-opened', runId: '' } as SelfImplementResult);
    expect(pending).toMatchObject({ kind: 'pending', next: 'eln self running-runs', missing: ['runId', 'node'] });
    expect(pending).not.toHaveProperty('runId');
    expect(pending.message).toContain('미관측');
  });

  test('failed 꼴 — 이유와 다음 행동을 싣는다', () => {
    const failed = buildFailedToolResult('SelfImplement: `feature` is required');
    expect(failed.kind).toBe('failed');
    expect(failed.reason).toContain('`feature` is required');
    expect(failed).not.toHaveProperty('remaining');
    expect(failed.message).toContain('다음:');
    expect(failed.message).toContain('이 턴에서 파일을 직접 편집하지 마세요');
  });

});

describe('dispatchSelfImplement 세 출구 — 세 꼴 배선', () => {
  test('observe-only 스위치가 켜지면 observed-only 꼴로 돌아온다(런 미발사)', async () => {
    _setObserveOnlyConfigReaderForTesting(() => true);
    try {
      const observed = (await dispatchSelfImplement(
        { feature: '어떤 기능' } as DispatchArgs,
        baseCtx(),
      )) as { kind: string; observed: boolean; message: string };
      expect(observed.kind).toBe('observed-only');
      expect(observed.observed).toBe(true);
      expectAllPhrases(OBSERVED_ONLY_PHRASES, observed.message);
    } finally {
      _setObserveOnlyConfigReaderForTesting(undefined);
    }
  });

  test('feature 가 비면 failed 꼴로 이유를 돌려온다', async () => {
    _setObserveOnlyConfigReaderForTesting(() => false);
    try {
      const failed = (await dispatchSelfImplement(
        { feature: '   ' } as DispatchArgs,
        baseCtx(),
      )) as { kind: string; reason: string };
      expect(failed.kind).toBe('failed');
      expect(failed.reason).toContain('`feature` is required');
    } finally {
      _setObserveOnlyConfigReaderForTesting(undefined);
    }
  });

  test('성공 경로는 launched 꼴 — run 이 돌려준 결과를 보존하며 문면을 싣는다', async () => {
    _setObserveOnlyConfigReaderForTesting(() => false);
    let runCalls = 0;
    const run: SelfImplementRunner = async (opts) => {
      runCalls++;
      expect(opts.feature).toBe('어떤 기능');
      return { ok: true, stage: 'pr-opened', branch: 'feat/contract', runId: 'run-777' } as unknown as SelfImplementResult;
    };
    try {
      const launched = (await dispatchSelfImplement(
        { feature: '어떤 기능' } as DispatchArgs,
        baseCtx(),
        run,
        async () => ({ path: '/tmp/goal-authored.md' }),
        undefined,
        async () => ({}) as SelfImplementSeams,
      )) as { kind: string; message: string; runId?: unknown; branch?: unknown };
      expect(runCalls).toBe(1);
      expect(launched.kind).toBe('launched');
      expect(launched.runId).toBe('run-777');
      expect(launched.branch).toBe('feat/contract');
      expectAllPhrases(LAUNCHED_PHRASES, launched.message);
      expect(launched.message).toContain('run-777');
    } finally {
      _setObserveOnlyConfigReaderForTesting(undefined);
    }
  });

  test('실제 런 실패는 launched로 포장하지 않고 이유와 조회를 싣는다', async () => {
    _setObserveOnlyConfigReaderForTesting(() => false);
    try {
      const failed = await dispatchSelfImplement(
        { feature: '어떤 기능' }, baseCtx(),
        async () => ({ ok: false, stage: 'gate-failed', detail: 'typecheck failed', runId: 'run-fail', node: 'gate' } as SelfImplementResult),
        async () => ({ path: '/tmp/goal-authored.md' }), undefined, async () => ({}) as SelfImplementSeams,
      ) as { kind: string; reason: string; next: string; runId: string };
      expect(failed.kind).toBe('failed');
      expect(failed.reason).toBe('typecheck failed');
      expect(failed.next).toBe('eln self run run-fail');
      expect(failed.runId).toBe('run-fail');
    } finally {
      _setObserveOnlyConfigReaderForTesting(undefined);
    }
  });

  test('골 저작 예외는 failed로 반환하고 runner를 시작하지 않는다', async () => {
    _setObserveOnlyConfigReaderForTesting(() => false);
    let runCalls = 0;
    try {
      const failed = await dispatchSelfImplement(
        { feature: '저작 실패' }, { ...baseCtx(), userText: '원문 요청' },
        async () => { runCalls += 1; throw new Error('runner must not start'); },
        async () => { throw new Error('goal author unavailable'); },
      );
      expect(failed).toMatchObject({ kind: 'failed', reason: 'goal author unavailable', missing: ['runId', 'node'] });
      expect(failed.message).toContain('다음:');
      expect(runCalls).toBe(0);
    } finally {
      _setObserveOnlyConfigReaderForTesting(undefined);
    }
  });

  test('runner 예외는 failed로 반환하고 원본 이유와 다음 행동을 밝힌다', async () => {
    _setObserveOnlyConfigReaderForTesting(() => false);
    try {
      const failed = await dispatchSelfImplement(
        { feature: '실행 실패' }, baseCtx(),
        async () => { throw new Error('runner unavailable'); },
        undefined, undefined, async () => ({}) as SelfImplementSeams,
      );
      expect(failed).toMatchObject({ kind: 'failed', reason: 'runner unavailable', next: '요청과 실패 이유를 확인한 뒤 다시 요청하세요', missing: ['runId', 'node'] });
      expect(failed.message).toContain('runner unavailable');
    } finally {
      _setObserveOnlyConfigReaderForTesting(undefined);
    }
  });
});
