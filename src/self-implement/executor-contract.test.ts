import { describe, expect, test } from 'bun:test';
import { EXECUTOR_BACKENDS, execSurfaceId, buildExecutorPtyRef, type ExecutorBackend, type ExecutorPtyRef } from './executor-contract.js';

describe('executor-contract — G9 P3a 통일 계약 SSOT', () => {
  // 실 drift 방지는 컴파일 가드(_AgentBackendsAreExecutorBackends·모듈). 이 테스트는 배열 SSOT 회귀 스냅샷.
  test('EXECUTOR_BACKENDS = elanous-chat + all registered agent CLIs (regression snapshot)', () => {
    expect([...EXECUTOR_BACKENDS]).toEqual(['elanous-chat', 'codex', 'claude', 'gemini', 'grok', 'aside', 'openclaw', 'hermes']);
  });

  test('execSurfaceId = exec:${ptyId} 규약(Q1·룩업 없는 결정적 상관)', () => {
    expect(execSurfaceId('codex_a1b2c3d4')).toBe('exec:codex_a1b2c3d4');
    expect(execSurfaceId('goal_ff00')).toBe('exec:goal_ff00');
  });

  test('ExecutorPtyRef 형태 — 필수(ptyId/surfaceId/backend/runId) + 선택(space/session/instance)', () => {
    const ref: ExecutorPtyRef = {
      ptyId: 'codex_a1b2c3d4',
      surfaceId: execSurfaceId('codex_a1b2c3d4'),
      backend: 'codex' satisfies ExecutorBackend,
      runId: 'run-x',
    };
    expect(ref.surfaceId).toBe('exec:codex_a1b2c3d4');
    // 선택 필드 부재 허용(부분 채움 계약).
    expect(ref.spaceId).toBeUndefined();
  });

  test('buildExecutorPtyRef — surfaceId 불변식 보장 + 선택 필드 부재 시 생략', () => {
    const full = buildExecutorPtyRef({ ptyId: 'goal_ff00', backend: 'elanous-chat', runId: 'run-1', spaceId: 'sp-1', sessionId: 's-1', instance: 'inst-a' });
    expect(full).toEqual({ ptyId: 'goal_ff00', surfaceId: 'exec:goal_ff00', backend: 'elanous-chat', runId: 'run-1', spaceId: 'sp-1', sessionId: 's-1', instance: 'inst-a' });

    const minimal = buildExecutorPtyRef({ ptyId: 'codex_11', backend: 'codex', runId: 'run-2' });
    expect(minimal).toEqual({ ptyId: 'codex_11', surfaceId: 'exec:codex_11', backend: 'codex', runId: 'run-2' });
    expect('spaceId' in minimal).toBe(false); // 부재 필드는 키 자체 생략(부분 채움).
  });
});
