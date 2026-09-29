// PLAN §7 P3 — ReAct PTY 제어 루프. 관측→판단→행동 조립·termination. deps 주입(순수·시간무관).
import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { runPtyControlLoop, controlDepsForHandle, type RunSupervisor, type ControlObservation, type ControlDecision } from './pty-control-loop.js';
import { encodeSgrMouse, MAX_PTY_KEY_REPEAT } from '../pty-shell/pty-mouse.js';

// 결정론 brain — 스크립트된 결정 시퀀스.
function scriptedBrain(script: ControlDecision[]): RunSupervisor {
  let i = 0;
  return { decide: () => script[Math.min(i++, script.length - 1)]! };
}

// 화면 시퀀스를 내주는 observe + inject 캡처. sleep=no-op(즉시).
function harness(screens: string[]) {
  let si = 0;
  const injected: string[] = [];
  const steps: ControlObservation[] = [];
  const deps = {
    observe: () => screens[Math.min(si++, screens.length - 1)] ?? '',
    inject: (t: string) => { injected.push(t); return true; },
    sleep: async () => {},
    onStep: (obs: ControlObservation) => steps.push(obs),
  };
  return { deps, injected, steps };
}

describe('runPtyControlLoop', () => {
  test('key dispatch and absent injectMouse are separate from text and reported to brain', async () => {
    const { deps, injected } = harness(['ready']);
    const keys: Array<[string, number | undefined]> = [];
    const seen: Array<string | undefined> = [];
    const brain: RunSupervisor = { decide: (obs) => {
      seen.push(obs.unavailableAction);
      return obs.step === 0 ? { action: 'key', name: 'down', repeat: 2 } : obs.step === 1 ? { action: 'mouse', x: 10, y: 5, kind: 'click' } : { action: 'done', reason: 'ok' };
    } };
    await runPtyControlLoop(brain, { ...deps, injectKey: (name, repeat) => { keys.push([name, repeat]); return true; } }, { maxSteps: 3, pollMs: 0 });
    expect(keys).toEqual([['down', 2]]);
    expect(injected).toEqual([]);
    expect(seen[2]).toContain('injectMouse unavailable');
  });

  test('mouse on emits SGR press/release; off refuses next click with reason', async () => {
    const { deps, injected } = harness([]);
    const obsChunks = ['\x1b[?1000;1006h', '\x1b[?1000l'];
    const seen: Array<string | undefined> = [];
    await runPtyControlLoop({ decide: (obs) => { seen.push(obs.unavailableAction); return { action: 'mouse', kind: 'click', x: 10, y: 5 }; } }, {
      ...deps, observe: () => obsChunks.shift() ?? '',
      injectMouse: (input) => { injected.push(encodeSgrMouse(input)); return true; },
    }, { maxSteps: 3, pollMs: 0 });
    expect(injected).toEqual(['\x1b[<0;10;5M\x1b[<0;10;5m']);
    expect(seen[2]).toContain('mouse mode is off');
  });

  test('real handle routes key/resize through agent ownership and rejects mouse after mode-off', async () => {
    const { startPty, setPtyAdapterForTesting, unregisterPty } = await import('../pty-shell/registry.js');
    const writes: string[] = [];
    const sizes: Array<[number, number]> = [];
    setPtyAdapterForTesting(() => ({
      pid: 9, write: (chars: string) => { writes.push(chars); }, resize: (cols: number, rows: number) => { sizes.push([cols, rows]); }, kill: () => {},
      onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
    }));
    let id: string | undefined;
    try {
      const handle = startPty({ cmd: 'x', accessMode: 'auto', detach: true });
      id = handle.id;
      const wired = controlDepsForHandle(handle);
      handle.appendOutput('\x1b[?1000;1006h');
      expect(wired.injectKey!('down', 2)).toBe(true);
      expect(() => wired.injectKey!('down', MAX_PTY_KEY_REPEAT + 1)).toThrow(`key repeat must be between 1 and ${MAX_PTY_KEY_REPEAT}`);
      expect(() => wired.injectKey!('down', Number.MAX_SAFE_INTEGER)).toThrow(`key repeat must be between 1 and ${MAX_PTY_KEY_REPEAT}`);
      expect(wired.injectMouse!({ kind: 'click', x: 10, y: 5 })).toBe(true);
      expect(wired.resize!(100, 30)).toBe(true);
      expect(writes).toEqual(['\x1b[B\x1b[B', '\x1b[<0;10;5M\x1b[<0;10;5m']);
      expect(sizes).toEqual([[100, 30]]);
      handle.appendOutput('\x1b[?1000l');
      expect(wired.mouseModeEnabled!()).toBe(false);
      expect(() => wired.injectMouse!({ kind: 'click', x: 10, y: 5 })).toThrow('PTY mouse mode is off');
      handle.appendOutput('\x1b[?1000h');
      handle.setAccessMode('write');
      expect(wired.injectMouse!({ kind: 'click', x: 10, y: 5 })).toBe(false);
      expect(wired.injectKey!('enter')).toBe(false);
      expect(wired.resize!(80, 24)).toBe(false);
      handle.appendOutput('\x1b[?1000l');
      expect(wired.injectMouse!({ kind: 'click', x: 10, y: 5 })).toBe(false);
      expect(writes).toHaveLength(2);
      expect(sizes).toHaveLength(1);
    } finally {
      if (id) unregisterPty(id);
      setPtyAdapterForTesting(null);
    }
  }, 20_000);

  test('resize without dependency returns unavailable to the brain', async () => {
    const { deps, injected } = harness(['ready']);
    const seen: Array<string | undefined> = [];
    await runPtyControlLoop({ decide: (obs) => {
      seen.push(obs.unavailableAction);
      return obs.step === 0 ? { action: 'resize', cols: 100, rows: 30 } : { action: 'done', reason: 'ok' };
    } }, deps, { maxSteps: 2, pollMs: 0 });
    expect(seen[1]).toContain('resize unavailable');
    expect(injected).toEqual([]);
  });

  test('takeover prevents key/mouse/resize writes before and after decide', async () => {
    for (const action of [{ action: 'key', name: 'enter' }, { action: 'mouse', kind: 'click', x: 1, y: 1 }, { action: 'resize', cols: 80, rows: 24 }] as const) {
      const writes: string[] = [];
      let owned = true;
      const { deps } = harness(['\x1b[?1000;1006h']);
      const result = await runPtyControlLoop({ decide: () => { owned = false; return action; } }, {
        ...deps, controlStance: () => owned ? 'owned' : 'lost',
        injectKey: () => { writes.push('key'); return true; },
        injectMouse: () => { writes.push('mouse'); return true; },
        resize: () => { writes.push('resize'); return true; },
      }, { maxSteps: 1, pollMs: 0 });
      expect(result.termination.kind).toBe('cancelled');
      expect(writes).toEqual([]);
    }
  });
  test('success — brain 이 done 반환', async () => {
    const { deps } = harness(['❯ ready', 'work', 'done']);
    const brain = scriptedBrain([{ action: 'input', text: 'go\r' }, { action: 'wait' }, { action: 'done', reason: '골 완료' }]);
    const r = await runPtyControlLoop(brain, deps, { maxSteps: 10, pollMs: 0 });
    expect(r.termination).toEqual({ kind: 'success', reason: '골 완료' });
  });

  test('행동 — input 결정이 arbiter inject 로 전달', async () => {
    const { deps, injected } = harness(['❯ ready', '❯ ready', 'done']);
    const brain = scriptedBrain([{ action: 'wait' }, { action: 'input', text: 'hello\r' }, { action: 'done', reason: 'x' }]);
    let at = 0;
    await runPtyControlLoop(brain, {
      ...deps,
      canReceiveInput: true,
      autoAssist: { enabled: true, minRung: 0 },
      isAlive: () => true,
      controlStance: () => 'owned',
      now: () => [0, 15_000][Math.min(at++, 1)]!,
    }, { maxSteps: 10, pollMs: 0 });
    expect(injected).toEqual(['hello\r']);
  });

  test('assist gate — input-capable child delivers exactly once only after every condition is confirmed', async () => {
    const { deps, injected } = harness(['blocked', 'blocked', 'blocked']);
    const outcomes: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'input-outcome') outcomes.push(data ?? {});
    }) as never);
    let at = 0;
    try {
      await runPtyControlLoop(
        scriptedBrain([{ action: 'input', text: 'assist\r' }, { action: 'input', text: 'assist\r' }, { action: 'done', reason: 'done' }]),
        {
          ...deps,
          canReceiveInput: true,
          autoAssist: { enabled: true, minRung: 0 },
          isAlive: () => true,
          controlStance: () => 'owned',
          now: () => [0, 15_000, 15_000][Math.min(at++, 2)]!,
        },
        { maxSteps: 3, pollMs: 0 },
      );
    } finally {
      log.mockRestore();
    }
    expect(injected).toEqual(['assist\r']);
    expect(outcomes).toContainEqual(expect.objectContaining({ applied: true, why: 'input-with-stall-rung-0', canReceiveInput: true }));
  });

  // ⚠️ `disabled` 는 **여기 없다** — 꺼진 게이트는 거부가 아니라 **상담 자체를 안 한다**.
  //   이 표에 `{enabled:false} → 거부` 를 넣으면 CLI 가 기본값을 항상 실어 보내므로
  //   `elanous drive` 의 오랜 input 주입이 통째로 멈추는 회귀를 **계약으로 굳힌다**(리뷰 must-fix).
  //   꺼진 경우의 계약은 바로 아래 테스트가 따로 고정한다.
  test('assist gate — ownership and stall refusals do not inject and are observed', async () => {
    const cases = [
      { name: 'ownership', autoAssist: { enabled: true, minRung: 0 }, stance: 'lost' as const, now: () => 15_000, why: 'ownership-lost' },
      { name: 'stall', autoAssist: { enabled: true, minRung: 0 }, stance: 'owned' as const, now: () => 0, why: 'no-stall-confirmation' },
    ];
    for (const c of cases) {
      const { deps, injected } = harness(['blocked']);
      const outcomes: Record<string, unknown>[] = [];
      const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
        if (event === 'input-outcome') outcomes.push(data ?? {});
      }) as never);
      let stanceChecks = 0;
      const controlStance = (): 'owned' | 'lost' => {
        stanceChecks += 1;
        return c.name === 'ownership' && stanceChecks > 1 ? 'lost' : c.stance === 'lost' ? 'owned' : c.stance;
      };
      try {
        await runPtyControlLoop(
          scriptedBrain([{ action: 'input', text: 'assist\r' }]),
          { ...deps, canReceiveInput: true, autoAssist: c.autoAssist, isAlive: () => true, controlStance, now: c.now },
          { maxSteps: 1, pollMs: 0 },
        );
      } finally {
        log.mockRestore();
      }
      expect(injected, c.name).toEqual([]);
      expect(outcomes, c.name).toContainEqual(expect.objectContaining({ applied: false, why: c.why, canReceiveInput: true }));
    }
  });

  // ⭐ 기본 OFF = **옛 동작**(주입한다). 게이트가 생기기 전 `elanous drive` 는 `input` 을 그냥
  //   넣었고, 꺼진 게이트가 그걸 막으면 "기본 OFF" 가 옛 동작이 아니라 **새 동작**이 된다.
  test.each([
    ['config 가 disabled 로 실려도', { enabled: false, minRung: 0 }],
    ['config 자체가 없어도', undefined],
  ])('기본 OFF: %s input 은 종전처럼 주입된다', async (_label, autoAssist) => {
    const { deps, injected } = harness(['blocked']);
    const outcomes: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_c: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'input-outcome') outcomes.push(data ?? {});
    }) as never);
    try {
      await runPtyControlLoop(
        scriptedBrain([{ action: 'input', text: 'assist\r' }]),
        { ...deps, canReceiveInput: true, isAlive: () => true, controlStance: () => 'owned' as const, now: () => 15_000,
          ...(autoAssist ? { autoAssist } : {}) },
        { maxSteps: 1, pollMs: 0 },
      );
    } finally { log.mockRestore(); }
    expect(injected).toEqual(['assist\r']);
    // 꺼져 있으면 게이트가 상담조차 안 하므로 거부 관측도 없다.
    expect(outcomes.filter((o) => o.applied === false)).toEqual([]);
  });

  // ⚠️ 생존을 확인할 수단이 없으면 **살아있다고 단정하지 않는다.** `?? true` 로 되돌리면
  //   확인도 없이 주입이 통과한다 — 이 테스트가 그 뮤테이션을 잡는다.
  // ⚠️ 값이 아니라 **호출 횟수**를 센다 — 배열을 포화시켜 값만 보면, 관측당 `now()` 를 두 번
  //   부르도록 회귀해도 통과한다(리뷰 should-fix). 한 관측 = 한 시각이 계약이다.
  test('한 관측은 now() 를 한 번만 읽는다', async () => {
    const { deps } = harness(['blocked']);
    let calls = 0;
    await runPtyControlLoop(
      scriptedBrain([{ action: 'wait' }]),
      { ...deps, controlStance: () => 'owned' as const, now: () => { calls += 1; return 1_000; } },
      { maxSteps: 1, pollMs: 0 },
    );
    expect(calls).toBe(1);
  });

  test('assist gate — isAlive 미제공이면 fail-closed(주입 없음)', async () => {
    const { deps, injected } = harness(['blocked']);
    const outcomes: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_c: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'input-outcome') outcomes.push(data ?? {});
    }) as never);
    try {
      await runPtyControlLoop(
        scriptedBrain([{ action: 'input', text: 'assist\r' }]),
        // isAlive 를 **주지 않는다** — 확인 수단 부재.
        { ...deps, canReceiveInput: true, autoAssist: { enabled: true, minRung: 0 },
          controlStance: () => 'owned' as const, now: () => 15_000 },
        { maxSteps: 1, pollMs: 0 },
      );
    } finally { log.mockRestore(); }
    expect(injected).toEqual([]);
    expect(outcomes).toContainEqual(expect.objectContaining({ applied: false, why: 'child-not-alive' }));
  });

  test('cancelled — inject 거부(사람 takeover) → yield', async () => {
    const { steps } = harness(['❯ ready']);
    const deps = {
      observe: () => '❯ ready',
      inject: () => false, // arbiter denied
      sleep: async () => {},
      onStep: (o: ControlObservation) => steps.push(o),
    };
    const brain = scriptedBrain([{ action: 'wait' }, { action: 'input', text: 'go\r' }]);
    let at = 0;
    const r = await runPtyControlLoop(brain, {
      ...deps,
      canReceiveInput: true,
      autoAssist: { enabled: true, minRung: 0 },
      isAlive: () => true,
      controlStance: () => 'owned',
      now: () => [0, 15_000][Math.min(at++, 1)]!,
    }, { maxSteps: 10, pollMs: 0 });
    expect(r.termination).toEqual({ kind: 'cancelled' });
    expect(r.steps).toBe(1);
  });

  test('stuck — 화면 무변화 + brain wait 가 stuckLimit 연속', async () => {
    const { deps } = harness(['same', 'same', 'same', 'same', 'same']);
    const brain = scriptedBrain([{ action: 'wait' }]); // 계속 wait
    const r = await runPtyControlLoop(brain, deps, { maxSteps: 20, stuckLimit: 3, pollMs: 0 });
    expect(r.termination.kind).toBe('stuck');
  });

  test.each([
    ['default limit', undefined, 6],
    ['caller override', 3, 3],
  ])('stuck uses shared intervention at the existing %s iteration and observes its vocabulary', async (_label, stuckLimit, expectedRepeats) => {
    const { deps, steps } = harness(['same']);
    const endings: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'end') endings.push(data ?? {});
    }) as never);
    try {
      const r = await runPtyControlLoop(
        scriptedBrain([{ action: 'wait' }]),
        deps,
        { maxSteps: 20, ...(stuckLimit === undefined ? {} : { stuckLimit }), pollMs: 0 },
      );
      expect(r).toEqual({
        termination: { kind: 'stuck', iteration: expectedRepeats, reason: `화면 무변화 ${expectedRepeats} 연속` },
        steps: expectedRepeats,
      });
      expect(steps).toHaveLength(expectedRepeats + 1);
      expect(steps.map(({ intervention }) => intervention)).toEqual([
        expect.objectContaining({ screenComparison: 'first', sameScreenCount: 1, recommendsStop: false }),
        ...Array.from({ length: expectedRepeats - 1 }, (_unused, index) =>
          expect.objectContaining({ screenComparison: 'same', sameScreenCount: index + 2, recommendsStop: false })),
        expect.objectContaining({ screenComparison: 'same', sameScreenCount: expectedRepeats + 1, recommendsStop: true }),
      ]);
      expect(endings).toContainEqual(expect.objectContaining({
        kind: 'stuck',
        interventionLevel: 'L2',
        interventionControlStance: 'owned',
        interventionNextAction: 'no-progress',
        interventionReason: `same screen observed ${expectedRepeats + 1} times`,
        interventionStop: true,
        supervisionVerdict: 'escalate',
      }));
    } finally {
      log.mockRestore();
    }
  });

  test('no-progress — 판단 자체로 종료하지 않고 기존 대기 경로를 따른다', async () => {
    const { deps } = harness(['a', 'b']);
    const r = await runPtyControlLoop(
      scriptedBrain([{ action: 'no-progress', reason: '화면은 멈췄고 완료 표시는 없다' }]),
      deps,
      { maxSteps: 2, stuckLimit: 10, pollMs: 0 },
    );
    expect(r.termination).toMatchObject({ kind: 'budget' });
  });

  test('child exited — isAlive false + wait 는 stuckLimit/대기 없이 즉시 stuck', async () => {
    const { deps } = harness(['same']);
    let sleeps = 0;
    const r = await runPtyControlLoop(
      scriptedBrain([{ action: 'wait' }]),
      { ...deps, isAlive: () => false, sleep: async () => { sleeps += 1; } },
      { maxSteps: 20, stuckLimit: 3, pollMs: 0 },
    );
    expect(r.termination).toEqual({ kind: 'stuck', iteration: 0, reason: 'child exited' });
    expect(r.steps).toBe(0);
    expect(sleeps).toBe(0);
  });

  test('done 우선 — isAlive false 여도 brain done 은 success', async () => {
    const { deps } = harness(['complete']);
    const r = await runPtyControlLoop(
      scriptedBrain([{ action: 'done', reason: '골 완료' }]),
      { ...deps, isAlive: () => false },
      { maxSteps: 5, pollMs: 0 },
    );
    expect(r.termination).toEqual({ kind: 'success', reason: '골 완료' });
  });

  test('stuck 아님 — 화면이 변하면 카운트 리셋(자식이 일하는 중)', async () => {
    const { deps } = harness(['a', 'b', 'c', 'd', 'done']);
    let n = 0;
    const brain: RunSupervisor = { decide: () => (++n >= 5 ? { action: 'done', reason: 'ok' } : { action: 'wait' }) };
    const r = await runPtyControlLoop(brain, deps, { maxSteps: 20, stuckLimit: 3, pollMs: 0 });
    expect(r.termination.kind).toBe('success'); // 매 스텝 화면 변화 → stuck 안 됨
  });

  test('normal progress — every observation retains a non-stopping intervention', async () => {
    const { deps, steps } = harness(['a', 'b', 'done']);
    const r = await runPtyControlLoop(
      scriptedBrain([{ action: 'wait' }, { action: 'wait' }, { action: 'done', reason: 'ok' }]),
      deps,
      { maxSteps: 5, stuckLimit: 3, pollMs: 0 },
    );
    expect(r.termination).toEqual({ kind: 'success', reason: 'ok' });
    expect(steps.map(({ intervention }) => intervention)).toEqual([
      expect.objectContaining({ screenComparison: 'first', sameScreenCount: 1, recommendsStop: false }),
      expect.objectContaining({ screenComparison: 'changed', sameScreenCount: 1, recommendsStop: false }),
      expect.objectContaining({ screenComparison: 'changed', sameScreenCount: 1, recommendsStop: false }),
    ]);
  });

  test('budget — maxSteps 초과', async () => {
    const { deps } = harness(['x']);
    const brain: RunSupervisor = { decide: (o) => ({ action: 'input', text: `s${o.step}` }) }; // 계속 input(진전)
    const r = await runPtyControlLoop(brain, deps, { maxSteps: 3, pollMs: 0 });
    expect(r.termination).toMatchObject({ kind: 'budget', observed: 3, limit: 3 });
  });

  test('verifyDone ok — done 검증 뒤 success', async () => {
    const { deps } = harness(['complete']);
    const verifyDone = (obs: ControlObservation) => {
      expect(obs.screen).toBe('complete');
      return { ok: true } as const;
    };
    const r = await runPtyControlLoop(scriptedBrain([{ action: 'done', reason: '골 완료' }]), { ...deps, verifyDone }, { maxSteps: 5, pollMs: 0 });
    expect(r.termination).toEqual({ kind: 'success', reason: '골 완료' });
  });

  test('verifyDone reject — retry inject 뒤 다음 done 검증 success', async () => {
    const { deps, injected } = harness(['not done', 'complete']);
    let calls = 0;
    const verifyDone = () => (++calls === 1 ? { ok: false as const, retry: '계속 작업하라\r' } : { ok: true as const });
    const brain = scriptedBrain([{ action: 'done', reason: 'too early' }, { action: 'done', reason: '골 완료' }]);
    const r = await runPtyControlLoop(brain, { ...deps, verifyDone }, { maxSteps: 5, pollMs: 0 });
    expect(injected).toEqual(['계속 작업하라\r']);
    expect(r.termination).toEqual({ kind: 'success', reason: '골 완료' });
    expect(r.steps).toBe(1);
  });

  test('verifyDone reject — retry가 반복되면 budget 소진', async () => {
    const { deps, injected } = harness(['not done']);
    const verifyDone = () => ({ ok: false as const, retry: '계속 작업하라\r' });
    const r = await runPtyControlLoop(scriptedBrain([{ action: 'done', reason: 'too early' }]), { ...deps, verifyDone }, { maxSteps: 2, pollMs: 0 });
    expect(injected).toEqual(['계속 작업하라\r', '계속 작업하라\r']);
    expect(r.termination).toMatchObject({ kind: 'budget', observed: 2, limit: 2 });
  });

  test('verifyDone throw — error termination', async () => {
    const { deps } = harness(['complete']);
    const verifyDone = () => { throw new Error('ground truth unavailable'); };
    const r = await runPtyControlLoop(scriptedBrain([{ action: 'done', reason: '골 완료' }]), { ...deps, verifyDone }, { maxSteps: 5, pollMs: 0 });
    expect(r.termination).toMatchObject({ kind: 'error', message: 'ground truth unavailable' });
  });

  test('error — observe 예외 포착', async () => {
    const deps = { observe: () => { throw new Error('pty dead'); }, inject: () => true, sleep: async () => {} };
    const brain = scriptedBrain([{ action: 'wait' }]);
    const r = await runPtyControlLoop(brain, deps, { maxSteps: 5, pollMs: 0 });
    expect(r.termination).toMatchObject({ kind: 'error' });
  });

  test('관측 — obs 에 #1 분류 상태 동봉', async () => {
    const { deps, steps } = harness(['❯ 1. Yes\n  2. No', 'done']);
    const brain = scriptedBrain([{ action: 'done', reason: 'x' }]);
    await runPtyControlLoop(brain, deps, { maxSteps: 5, pollMs: 0 });
    expect(steps[0]?.state).toBe('blocked'); // region-rule 분류 통합
  });

  test('lost control is observed as abandon while retaining cancelled termination', async () => {
    const observations: Record<string, unknown>[] = [];
    const log = spyOn(debug, 'log').mockImplementation(((_category: string, event: string, data?: Record<string, unknown>) => {
      if (event === 'yield') observations.push(data ?? {});
    }) as never);
    try {
      const r = await runPtyControlLoop(
        scriptedBrain([{ action: 'done', reason: 'must not reach brain' }]),
        { observe: () => 'screen', inject: () => true, sleep: async () => {}, controlStance: () => 'lost' },
        { maxSteps: 3, pollMs: 0 },
      );
      expect(r).toEqual({ termination: { kind: 'cancelled' }, steps: 0 });
      expect(observations).toContainEqual(expect.objectContaining({ stance: 'lost', supervisionVerdict: 'abandon' }));
    } finally {
      log.mockRestore();
    }
  });

  test('hasControl — wait 중 사람 takeover 감지 → cancelled(input 안 기다림·review)', async () => {
    let control = true;
    const deps = {
      observe: () => 'same', // 무변화(원래는 stuck 으로 갈 화면)
      inject: () => true,
      hasControl: () => control,
      sleep: async () => {},
    };
    let n = 0;
    const brain: RunSupervisor = { decide: () => { if (++n === 2) control = false; return { action: 'wait' }; } };
    const r = await runPtyControlLoop(brain, deps, { maxSteps: 20, stuckLimit: 10, pollMs: 0 });
    expect(r.termination).toEqual({ kind: 'cancelled' }); // wait 만 하다가도 takeover 시 즉시 yield
  });

  test('takeover DURING decide — watcher 가 in-flight 감지 → cancelled (review 안전계약)', async () => {
    let control = true;
    const deps = {
      observe: () => 'screen',
      inject: () => true,
      hasControl: () => control,
      sleep: async () => {},
      // ⚠️ watcher 는 **실 타이머**로 돈다(주입 sleep 무관 — 그게 원 설계의 의도다). 그래서 이
      //   테스트는 주입 sleep 을 풀어 watcher 를 앞당길 수 없고, 대신 cadence 를 짧게 줘 실제
      //   watcher 경로를 그대로 태운다. 종전 `releaseWatchSleep` 은 watcher 가 주입 sleep 을
      //   타던 시절의 잔재라 아무 효과가 없었고, 주석의 *"wall-clock timer 없음"* 도 사실과
      //   달랐다(실제로는 250ms 타이머에 의존하고 있었다).
      watchIntervalMs: 1,
    };
    const brain: RunSupervisor = {
      decide: (_o, signal) => new Promise((resolve) => {
        control = false;
        signal?.addEventListener('abort', () => resolve({ action: 'wait' }), { once: true });
      }),
    };
    const r = await runPtyControlLoop(brain, deps, { maxSteps: 5, pollMs: 0 });
    expect(r.termination).toEqual({ kind: 'cancelled' }); // decide 블로킹 중에도 takeover 감지
  });

  test('takeover 직후 250ms 이내 done 반환해도 cancelled (서브-틱 레이스·review)', async () => {
    let control = true;
    const deps = { observe: () => 'screen', inject: () => true, hasControl: () => control, sleep: async () => {} };
    // brain 이 즉시 done 반환하되 그 전에 control 상실(watcher 250ms 틱 前) → post-decide 재검사가 잡아야.
    const brain: RunSupervisor = { decide: async () => { control = false; return { action: 'done', reason: '완료 주장' }; } };
    const r = await runPtyControlLoop(brain, deps, { maxSteps: 5, pollMs: 0 });
    expect(r.termination).toEqual({ kind: 'cancelled' }); // done 을 success 로 확정 안 함
  });

  test('hasControl 예외 → fail-closed cancelled(안전 경계·미확인=중단·review)', async () => {
    const deps = { observe: () => 'x', inject: () => true, sleep: async () => {}, hasControl: () => { throw new Error('deps bug'); } };
    const brain = scriptedBrain([{ action: 'done', reason: 'ok' }]);
    const r = await runPtyControlLoop(brain, deps, { maxSteps: 3, pollMs: 0 });
    expect(r.termination.kind).toBe('cancelled'); // 소유권 확인 불가 → 안전하게 중단(fail-closed·success 불가)
  });

  test('onStep async — capture 완료 뒤에 입력을 주입한다', async () => {
    const order: string[] = [];
    const deps = {
      observe: () => 'screen',
      inject: () => { order.push('inject'); return true; },
      sleep: async () => {},
      onStep: async () => { await Promise.resolve(); order.push('capture'); },
    };
    const brain = scriptedBrain([{ action: 'wait' }, { action: 'input', text: 'go\r' }, { action: 'done', reason: 'ok' }]);
    let at = 0;
    const r = await runPtyControlLoop(brain, {
      ...deps,
      canReceiveInput: true,
      autoAssist: { enabled: true, minRung: 0 },
      isAlive: () => true,
      controlStance: () => 'owned',
      now: () => [0, 15_000][Math.min(at++, 1)]!,
    }, { maxSteps: 3, pollMs: 0 });
    expect(r.termination.kind).toBe('success');
    expect(order).toEqual(['capture', 'capture', 'inject', 'capture']);
  });

  test('error — 콜백(onStep) throw 도 error termination(Promise reject 아님)', async () => {
    const deps = {
      observe: () => 'x', inject: () => true, sleep: async () => {},
      onStep: () => { throw new Error('hook boom'); },
    };
    const brain = scriptedBrain([{ action: 'wait' }]);
    const r = await runPtyControlLoop(brain, deps, { maxSteps: 5, pollMs: 0 });
    expect(r.termination).toMatchObject({ kind: 'error', message: 'hook boom' });
  });
});

// ── 실 registry handle 통합(mock adapter) — controlDepsForHandle 배선 검증 ──
describe('runPtyControlLoop + controlDepsForHandle (registry 통합)', () => {
  test('auto 자식 자율 구동: inject→agent write · takeover→cancelled', async () => {
    process.env.ELANOUS_STATE_DIR ||= '/tmp/p3-ctl-test';
    const { startPty, setPtyAdapterForTesting, requestPtyTakeover, unregisterPty } = await import('../pty-shell/registry.js');
    const writes: string[] = [];
    setPtyAdapterForTesting(() => ({
      pid: 7,
      write: (s: string) => { writes.push(s); },
      kill: () => {}, resize: () => {},
      onData: () => ({ dispose() {} }), onExit: () => ({ dispose() {} }),
    }));
    const ids: string[] = [];
    try {
      // ① 자율 구동 성공 — brain 이 2회 주입 후 done.
      const h = startPty({ cmd: 'x', accessMode: 'auto', transitionPolicy: 'open', detach: true });
      ids.push(h.id);
      let s = 0;
      const brainA: RunSupervisor = { decide: (o) => (o.step === 0 ? { action: 'wait' } : o.step < 3 ? { action: 'input', text: `L${s++}\r` } : { action: 'done', reason: 'ok' }) };
      let at = 0;
      const rA = await runPtyControlLoop(brainA, {
        ...controlDepsForHandle(h),
        canReceiveInput: true,
        autoAssist: { enabled: true, minRung: 0 },
        now: () => [0, 15_000, 30_000, 30_000][Math.min(at++, 3)]!,
      }, { maxSteps: 10, pollMs: 0 });
      expect(rA.termination.kind).toBe('success');
      expect(writes).toEqual(['L0\r', 'L1\r']); // arbiter 통과(auto+agent)

      // ② 사람 takeover 중간 → 다음 스텝 hasControl=false → cancelled.
      const h2 = startPty({ cmd: 'x', accessMode: 'auto', transitionPolicy: 'open', detach: true });
      ids.push(h2.id);
      const brainB: RunSupervisor = { decide: (o) => { if (o.step === 1) requestPtyTakeover(h2.id, 'human'); return { action: 'input', text: 'go\r' }; } };
      const rB = await runPtyControlLoop(brainB, controlDepsForHandle(h2), { maxSteps: 10, pollMs: 0 });
      expect(rB.termination.kind).toBe('cancelled'); // 소유권 상실 감지 → yield
    } finally {
      // 실패해도 adapter seam + handle 정리(후속 테스트 오염 방지·review).
      for (const id of ids) unregisterPty(id);
      setPtyAdapterForTesting(null);
    }
  });

  test('settle — 매 스텝 observe 직전 1회 호출(quiet-gate cadence)', async () => {
    const order: string[] = [];
    const { deps } = harness(['❯ ready', 'done']);
    const observe0 = deps.observe;
    const deps2 = {
      ...deps,
      observe: () => { order.push('observe'); return observe0(); },
      settle: async () => { order.push('settle'); },
    };
    const brain = scriptedBrain([{ action: 'wait' }, { action: 'done', reason: '완료' }]);
    const r = await runPtyControlLoop(brain, deps2, { maxSteps: 5, pollMs: 0 });
    expect(r.termination.kind).toBe('success');
    // 2 스텝(wait→done) 전체 순서를 비교 — settle 이 매 스텝 observe 직전 정확히 1회(추가 호출도 검출·review).
    expect(order).toEqual(['settle', 'observe', 'settle', 'observe']);
  });

  test('settle 미주입 — no-op(기존 cadence 무회귀·settle 삽입 0)', async () => {
    const order: string[] = [];
    const { deps } = harness(['❯ ready', 'done']);
    const observe0 = deps.observe;
    // settle 은 주지 않고 observe 만 래핑 — 미주입 시 순서에 'settle' 이 끼지 않음(observe 만·review).
    const deps2 = { ...deps, observe: () => { order.push('observe'); return observe0(); } };
    const brain = scriptedBrain([{ action: 'wait' }, { action: 'done', reason: '완료' }]);
    const r = await runPtyControlLoop(brain, deps2, { maxSteps: 5, pollMs: 0 });
    expect(r.termination.kind).toBe('success'); // settle 없이도 정상
    expect(order).toEqual(['observe', 'observe']); // settle 삽입 없음 — 기존 cadence 그대로
  });

  test('settle throw — error termination(observe 실패와 동일 정책)', async () => {
    const { deps } = harness(['❯ ready']);
    const deps2 = { ...deps, settle: async () => { throw new Error('settle boom'); } };
    const brain = scriptedBrain([{ action: 'wait' }]);
    const r = await runPtyControlLoop(brain, deps2, { maxSteps: 5, pollMs: 0 });
    expect(r.termination).toEqual({ kind: 'error', message: 'settle boom' });
  });
});

describe('controlDepsForHandle', () => {
  test('inject — canWrite 통과 시 agent write · 거부 시 false(yield)', () => {
    const calls: Array<[string, string]> = [];
    let allowed = true;
    const fakeHandle = {
      renderScreen: async () => 'screen',
      canWrite: (_a?: string) => allowed,
      write: (s: string, a?: string) => calls.push([s, a ?? 'human']),
    } as unknown as Parameters<typeof controlDepsForHandle>[0];
    const deps = controlDepsForHandle(fakeHandle);
    expect(deps.inject('a')).toBe(true);
    expect(calls).toEqual([['a', 'agent']]); // 'agent' 로 write
    allowed = false;
    expect(deps.inject('b')).toBe(false);    // 거부 → yield 신호
    expect(calls.length).toBe(1);            // write 안 함
  });
});
