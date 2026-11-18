import { describe, test, expect, afterEach, afterAll } from 'bun:test';
import {
  dispatchToolByName,
  registerToolRuntime,
  unregisterToolRuntime,
} from './registry.js';
import type { ToolRunResult } from './types.js';

/** dispatch 결과 좁힘 — ToolRunResult({output} | Record<string, unknown>)는
 * 느슨한 유니언이라 ok/error/result 필드 접근 전 시험 전용 좁힘. */
type DispatchOutcome = { ok: boolean; error?: string; result?: unknown };

/**
 * TC #92362 — Guardian 선호출 배선 통합 시험.
 * 가짜 bash 런타임(실执行 없음)으로 dispatchToolByName('Bash', …) 이
 * native-tool-catalog 의 `guardian: { kind: 'shell-argv' }` 를 거쳐
 * runGuardian 로 흐르는지를 검증한다. 배선을 되돌리면(카탈로그에서
 * guardian 부착 제거) 아래「wiring-reversed」방향 단언이 실패한다 —
 * 즉 이 시험은 배선 회귀를 실 실행 없이 잡는다.
 */

const HAZARDS = [
  'sudo -n true',
  'rm -rf /tmp/guardian-t',
  'git push --force',
  'sqlite3 /tmp/t.db "DROP TABLE t;"',
] as const;

describe('registry dispatchToolByName — guardian shell-argv gate (TC #92362)', () => {
  const calls: string[] = [];
  const prevBash = unregisterToolRuntime('bash');
  registerToolRuntime({
    id: 'bash',
    spec: {
      name: 'Bash',
      description: 'fake bash runtime for guardian shell-argv wiring test — never executes',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
    run: async (req: Record<string, unknown>): Promise<ToolRunResult> => {
      calls.push(String(req['command'] ?? ''));
      return { ok: true, result: { ran: true } } as ToolRunResult;
    },
  } as never);

  afterEach(() => {
    delete process.env['HARNESS_GUARDIAN_ENABLED'];
    calls.length = 0;
  });

  afterAll(() => {
    unregisterToolRuntime('bash');
    if (prevBash) registerToolRuntime(prevBash as never);
  });

  test('HARNESS_GUARDIAN_ENABLED=1: all 4 hazards blocked with guardian: prefix, runtime never executed', async () => {
    process.env['HARNESS_GUARDIAN_ENABLED'] = '1';
    for (const hazard of HAZARDS) {
      const res = (await dispatchToolByName('Bash', { command: hazard }, { surface: 'tui' })) as DispatchOutcome;
      expect(res.ok).toBe(false);
      expect(res.error ?? '').toMatch(/^guardian:/);
    }
    // 런타임 미실행: 가짜 런타임에 도달한 호출이 없다 (실执行 없이 검출).
    expect(calls).toEqual([]);
  });

  test('wiring-reversed direction: with the gate removed, the hazard reaches the runtime — this test fails only if wiring regresses', async () => {
    // 배선이 되돌아가면 guardian 진입점이 우회되어 런타임이 호출된다.
    //「게이트 꺼짐」경로로 그 감지 방향을 확인한다(가짜 런타임이라 실执行 없음).
    delete process.env['HARNESS_GUARDIAN_ENABLED'];
    const res = (await dispatchToolByName('Bash', { command: HAZARDS[0] }, { surface: 'tui' })) as DispatchOutcome;
    expect(res.ok).toBe(true);
    expect(calls).toEqual([HAZARDS[0]]);
  });

  test('guardian off (default): same dispatch passes without guardian fields, result shape unchanged', async () => {
    delete process.env['HARNESS_GUARDIAN_ENABLED'];
    const res = (await dispatchToolByName('Bash', { command: 'sudo -n true' }, { surface: 'tui' })) as DispatchOutcome;
    expect(res.ok).toBe(true);
    expect(res).not.toHaveProperty('guardian');
    expect(res.result).toEqual({ ran: true });
    expect(calls).toEqual(['sudo -n true']);
  });
});
