// 컴퓨터 유즈 심 계약 — 실제 browser-action 디스패처가 낸 관측만 읽는다.
import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import {
  browserActionRowsToTrajectory,
  readBrowserActionTrajectory,
} from '../harness/browser-trajectory.js';
import { LogStore } from '../mss/logging/log-store.js';
import { simComputerUse, type ComputerUseScenario } from './computer-use.js';

const scenarios: readonly ComputerUseScenario[] = ['normal', 'capture-stalls', 'capture-fails', 'target-missing'];

async function run(scenario: ComputerUseScenario) {
  return simComputerUse({
    scenario,
    trajectory: [{ target: '#open-panel', coordinates: { x: 41, y: 73 } }],
    captureTimeoutMs: 5,
    runId: 'run-computer-use-test',
    personaId: 'persona-computer-use-test',
  });
}

/**
 * ⛔ 심에는 «진짜 브라우저»가 없다 — 탭 회수는 CDP HTTP 왕복이라 여기서 켜지면 안 된다.
 *    📏 실측 2026-08-28: 안 끄니 걸음마다 127.0.0.1 로 4초씩 기다려 시험이 «타임아웃»했다.
 */
import { readFileSync as readComputerUseSource } from 'node:fs';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

test('the simulation never reaches the network — it keeps the CDP boundary only', () => {
  const source = readComputerUseSource(new URL('./computer-use.ts', import.meta.url).pathname, 'utf8');
  expect(source).toContain('reclaimOpenedTabs: false');
});

describe('simComputerUse — 진짜 performBrowserAction의 관측을 세운다', () => {
  test('네 상황은 기존 결과 필드를 보존하고 디스패처 귀속을 그대로 낸다', async () => {
    const results = await Promise.all(scenarios.map(run));

    // 🪞⛔ 옛 계약: target-missing 은 «관측이 없어» 'not-observed' 였다.
    //    📌 2026-08-28 `#13620` 이 그것을 바꿨다 — ***실패한 조작도 «흔적을 남긴다»***
    //       (실측: 위키백과 거부가 관측에 «한 줄도» 없어서 봇 루틴의 실패가 조용했다).
    //    ⇒ 이제 실패 행이 captureOutcome='not-requested' ⊕ ok:false ⊕ failureReason 을 싣는다.
    expect(results.map(result => result.captureOutcome)).toEqual(['ok', 'timeout', 'error', 'not-requested']);
    expect(results.slice(0, 3).map(result => result.observations[0])).toEqual([
      expect.objectContaining({ target: '#open-panel', coordinates: { x: 41, y: 73 }, attachmentRef: 'ux-sim://capture.png', captureOutcome: 'ok', runId: 'run-computer-use-test', personaId: 'persona-computer-use-test' }),
      expect.objectContaining({ target: '#open-panel', coordinates: { x: 41, y: 73 }, attachmentRef: null, captureOutcome: 'timeout', runId: 'run-computer-use-test', personaId: 'persona-computer-use-test' }),
      expect.objectContaining({ target: '#open-panel', coordinates: { x: 41, y: 73 }, attachmentRef: null, captureOutcome: 'error', runId: 'run-computer-use-test', personaId: 'persona-computer-use-test' }),
    ]);
    expect(results.map(result => result.attribution)).toEqual([
      { status: 'observed', attribution: { kind: 'run', entryPoint: 'src/ux-sim/computer-use.ts' } },
      { status: 'observed', attribution: { kind: 'run', entryPoint: 'src/ux-sim/computer-use.ts' } },
      { status: 'observed', attribution: { kind: 'run', entryPoint: 'src/ux-sim/computer-use.ts' } },
      // 🪞 «넷째»도 이제 관측된다 — 실패한 조작이 흔적을 남기기 때문이다(#13620).
      //    ⭐ 그리고 그것이 이 축의 값이다: ***「무엇을 하려 했나」가 실패에도 남는다.***
      { status: 'observed', attribution: { kind: 'run', entryPoint: 'src/ux-sim/computer-use.ts' } },
    ]);
    for (const result of results.slice(0, 3)) {
      expect(result.attribution.status).toBe('observed');
      if (result.attribution.status === 'observed') {
        expect(result.attribution.attribution).toBe(result.observations[0]?.attribution);
      }
    }
    expect(results[3]?.actions).toEqual([expect.objectContaining({ ok: false, reason: 'execution-failed' })]);
    // 🪞⛔ 옛 계약: 실패면 관측이 «비어» 있었다. 📌 #13620 이 그것을 바꿨다 —
    //    ***「무엇을 하려 했나」가 실패에도 남는다***(좌표·화면은 null 이되 대상·귀속은 있다).
    expect(results[3]?.observations).toHaveLength(1);
    expect(results[3]?.observations[0]).toMatchObject({
      target: '#open-panel',
      coordinates: null,
      attachmentRef: null,
      captureOutcome: 'not-requested',
    });
  });

  test('정상 디스패처 관측에는 좌표·화면참조·captureOutcome·runId·personaId가 그대로 담긴다', async () => {
    const result = await run('normal');

    expect(result.actions).toEqual([expect.objectContaining({ ok: true, target: '#open-panel' })]);
    expect(result.observations).toEqual([{
      target: '#open-panel',
      coordinates: { x: 41, y: 73 },
      attachmentRef: 'ux-sim://capture.png',
      captureOutcome: 'ok',
      runId: 'run-computer-use-test',
      personaId: 'persona-computer-use-test',
      attribution: { kind: 'run', entryPoint: 'src/ux-sim/computer-use.ts' },
    }]);
  });

  test('명시 호출자의 진입점은 심 기본값보다 우선하고 디스패처 귀속을 그대로 통과시킨다', async () => {
    const result = await simComputerUse({
      scenario: 'normal',
      trajectory: [{ target: '#explicit-entry-point', coordinates: { x: 7, y: 9 } }],
      runId: 'run-explicit-entry-point',
      entryPoint: 'test/explicit-computer-use-caller.ts',
    });

    expect(result.attribution).toEqual({
      status: 'observed',
      attribution: { kind: 'run', entryPoint: 'test/explicit-computer-use-caller.ts' },
    });
    if (result.attribution.status !== 'observed') throw new Error('expected dispatcher attribution');
    expect(result.observations[0]?.attribution).toBe(result.attribution.attribution);
  });

  test('영영 오지 않는 캡처는 주입한 시한 안에 timeout 관측으로 끝난다', async () => {
    const started = performance.now();
    const result = await run('capture-stalls');

    expect(result.captureOutcome).toBe('timeout');
    expect(performance.now() - started).toBeLessThan(250);
  });

  test('빈 궤적은 가상 클릭을 만들지 않고 실행 전에 거부한다', async () => {
    await expect(simComputerUse({ scenario: 'normal', trajectory: [] }))
      .rejects.toThrow('computer-use simulation requires at least one trajectory step');
  });

  test('관측 행을 runId로 되읽어 부분 행을 세고 나온 궤적을 그대로 재생한다', async () => {
    const replay = browserActionRowsToTrajectory([
      { category: 'harness.browser-action', event: 'executed', data: JSON.stringify({ runId: 'run-replay', target: '#first', coordinates: { x: 10, y: 20 } }) },
      { category: 'harness.browser-action', event: 'executed', data: JSON.stringify({ runId: 'run-replay', target: '#missing-coordinates' }) },
      { category: 'harness.browser-action', event: 'executed', data: JSON.stringify({ runId: 'run-replay', target: '#second', coordinates: { x: 30, y: 40 } }) },
      { category: 'harness.browser-action', event: 'executed', data: JSON.stringify({ runId: 'another-run', target: '#other', coordinates: { x: 50, y: 60 } }) },
      { category: 'other.category', event: 'ignored', data: '{}' },
    ], 'run-replay');

    expect(replay).toMatchObject({
      runId: 'run-replay',
      status: 'ready',
      observedRows: 4,
      selectedRows: 3,
      trajectory: [
        { target: '#first', coordinates: { x: 10, y: 20 } },
        { target: '#second', coordinates: { x: 30, y: 40 } },
      ],
      discarded: { missingCoordinates: 1, otherRunId: 1, invalidRow: 0, unrelatedEvent: 1 },
    });

    const result = await simComputerUse({ scenario: 'normal', trajectory: replay.trajectory, runId: replay.runId });
    expect(result.actions.map(action => action.target)).toEqual(['#first', '#second']);
    expect(result.observations.map(observation => observation.coordinates)).toEqual([{ x: 10, y: 20 }, { x: 30, y: 40 }]);
  });

  test('형식이 잘못된 관측 행을 세고 0건은 빈 궤적과 구별한다', () => {
    const malformed = browserActionRowsToTrajectory([
      { category: 'harness.browser-action', event: 'executed', data: '{not-json' },
      { category: 'harness.browser-action', event: 'executed', data: JSON.stringify({ runId: 'run-empty', target: '#bad-coordinates', coordinates: { x: 'x', y: 2 } }) },
    ], 'run-empty');
    const empty = browserActionRowsToTrajectory([], 'run-empty');
    const otherRunOnly = browserActionRowsToTrajectory([
      { category: 'harness.browser-action', event: 'executed', data: JSON.stringify({ runId: 'another-run', target: '#other', coordinates: { x: 1, y: 2 } }) },
    ], 'run-empty');

    expect(malformed).toMatchObject({
      status: 'no-replayable-steps',
      observedRows: 2,
      selectedRows: 1,
      trajectory: [],
      discarded: { missingCoordinates: 0, otherRunId: 0, invalidRow: 2, unrelatedEvent: 0 },
    });
    expect(empty).toMatchObject({
      status: 'no-observations',
      observedRows: 0,
      selectedRows: 0,
      trajectory: [],
      discarded: { missingCoordinates: 0, otherRunId: 0, invalidRow: 0, unrelatedEvent: 0 },
    });
    expect(otherRunOnly).toMatchObject({
      status: 'no-observations',
      observedRows: 1,
      selectedRows: 0,
      trajectory: [],
      discarded: { missingCoordinates: 0, otherRunId: 1, invalidRow: 0, unrelatedEvent: 0 },
    });
  });

  test('CLI는 네 국면 모두에서 기본 궤적과 디스패처 귀속을 표시한다', async () => {
    const outputs = await Promise.all(scenarios.map(async scenario => {
      const child = Bun.spawn(['bun', 'scripts/ux-sim.ts', '--computer-use', scenario], {
        cwd: import.meta.dir + '/../..',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { scenario, exitCode, stdout, stderr };
    }));

    for (const { scenario, exitCode, stdout, stderr } of outputs) {
      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain(`컴퓨터 유즈 · ${scenario}`);
      expect(stdout).toContain('귀속(attribution)');
    }
    for (const { stdout } of outputs.slice(0, 3)) {
      expect(stdout).toContain('runId                        ux-sim-cli');
      expect(stdout).toContain('귀속(attribution)            run · src/ux-sim/computer-use.ts');
    }
    // 🪞 같은 이유 — 실패해도 «누가 무엇을 하려 했나»는 남는다(#13620).
    expect(outputs[3]?.stdout).toContain('귀속(attribution)            run · src/ux-sim/computer-use.ts');
    expect(outputs[3]?.stdout).toContain('디스패처 결과                execution-failed');
  });

  test('스토어 읽기 실패를 0건 관측으로 위장하지 않고 원인을 보존한다', () => {
    const replay = readBrowserActionTrajectory('run-read-error', () => {
      throw new Error('observation store unavailable');
    });

    expect(replay).toMatchObject({
      runId: 'run-read-error',
      status: 'read-error',
      error: 'observation store unavailable',
      observedRows: 0,
      selectedRows: 0,
      trajectory: [],
    });
  });

  test('스토어는 대상 runId로 완전 조회하여 1,000개 뒤 행도 재생한다', () => {
    const store = new LogStore(':memory:');
    try {
      store.insertBatch([
        ...Array.from({ length: 1_001 }, (_, index) => ({
          surface: 'test',
          rec: {
            ts: new Date(index).toISOString(),
            category: 'harness.browser-action',
            event: 'executed',
            data: { runId: 'other-run', target: `#other-${index}`, coordinates: { x: index, y: index } },
          },
        })),
        {
          surface: 'test',
          rec: {
            ts: new Date(1_001).toISOString(),
            category: 'harness.browser-action',
            event: 'executed',
            data: { runId: 'run-after-thousand', target: '#after-thousand', coordinates: { x: 1002, y: 1003 } },
          },
        },
      ]);

      const replay = readBrowserActionTrajectory('run-after-thousand', () => store);

      expect(replay).toMatchObject({
        status: 'ready',
        observedRows: 1,
        selectedRows: 1,
        trajectory: [{ target: '#after-thousand', coordinates: { x: 1002, y: 1003 } }],
      });
    } finally {
      store.close();
    }
  });

  test('모든 궤적 단계는 순서대로 실제 디스패처에 전달되고 관측되며 runId null은 보존된다', async () => {
    const result = await simComputerUse({
      scenario: 'normal',
      trajectory: [
        { target: '#first', coordinates: { x: 10, y: 20 } },
        { target: '#second', coordinates: { x: 30, y: 40 } },
      ],
      runId: null,
    });

    expect(result.actions.map(action => action.target)).toEqual(['#first', '#second']);
    expect(result.observations.map(observation => [observation.target, observation.coordinates, observation.runId]))
      .toEqual([['#first', { x: 10, y: 20 }, null], ['#second', { x: 30, y: 40 }, null]]);
  });
});
