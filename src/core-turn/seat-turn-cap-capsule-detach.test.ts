/**
 * CAPSULE-A2 완료선 (OP 19:2x · TC #89120) — 스위치 없이(R3) 자리 턴 상한은 진행 중 Bash 를 «끊지» 않고 캡슐로 떼어 낸다:
 * 턴은 max_turns 로 닫히고(→ 기존 seat-cap-resume-notice 의 [CHECKPOINT] 이어 가기) Bash 는 살아 끝까지 돌며 capsule-done 1.
 * 짝 off 시험 = seat-turn-cap-inflight-tool.test.ts «Bash(sleep 20)가 상한 틱 뒤 5초 안에 끊긴다» (같은 하니스 꼴).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreTurnContext, CoreTurnResult } from './types.js';
import { runGoalLoop, type GoalLoopOptions } from './run-goal-loop.js';
import { isSeatTurnCapAbort, SEAT_TURN_CAP_DEFAULTS, SeatTurnCapAbort } from './seat-turn-cap.js';
import { TaskNotificationQueue } from '../agent/task-notification.js';
import { buildReplTools } from '../repl/index.js';
import { dispatchBashCapsule } from '../skills/tools/index.js';
import { runShell, setShellApprover } from '../shell-primitive/runtime.js';
import { _resetApprovalCacheForTesting, commandKey, getCachedDecision } from '../shell-primitive/approval-cache.js';
import type { ApprovalDecision } from '../shell-primitive/types.js';
import type { CapsuleEvent } from '../turn-capsule/contract.js';
import { installShellCapsuleSink, listDetachedShellCapsules, runShellCapsule, shellCapsulePolicy, type ShellCapsuleCall } from '../turn-capsule/shell-capsule.js';

const SEAT = { seat: 'QSEAT', ...SEAT_TURN_CAP_DEFAULTS, maxWallMs: 900_000 }; // 출처: #38571 (seat-turn-cap-inflight-tool.test.ts 와 같은 운영 15분 상한)
// R3: the old switch names change nothing — the test sets them «off» to prove it, then restores.
const savedSwitches = { mode: process.env.ELANOUS_TURN_CAPSULE_MODE, stages: process.env.ELANOUS_TURN_CAPSULE_STAGES };
afterEach(() => {
  if (savedSwitches.mode === undefined) delete process.env.ELANOUS_TURN_CAPSULE_MODE; else process.env.ELANOUS_TURN_CAPSULE_MODE = savedSwitches.mode;
  if (savedSwitches.stages === undefined) delete process.env.ELANOUS_TURN_CAPSULE_STAGES; else process.env.ELANOUS_TURN_CAPSULE_STAGES = savedSwitches.stages;
});

function harness() {
  let clock = 1_000_000;
  const timers: Array<{ at: number; callback: () => void; disposed: boolean }> = [];
  const schedule: NonNullable<GoalLoopOptions['scheduleSeatWallCap']> = (callback, delayMs) => {
    const timer = { at: clock + delayMs, callback, disposed: false };
    timers.push(timer);
    return { dispose: () => { timer.disposed = true; } };
  };
  const advance = (ms: number) => {
    clock += ms;
    for (;;) {
      const due = timers.filter((t) => !t.disposed && t.at <= clock).sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      due.disposed = true;
      due.callback();
    }
  };
  return { schedule, advance, now: () => clock };
}

describe('CAPSULE-A2 — 자리 턴 상한은 Bash 를 캡슐로 떼어 낸다 (스위치 없음)', () => {
  test('on: 상한 틱 뒤 턴은 max_turns 로 닫히고 Bash 는 살아 끝나며 capsule-done 사건 1', async () => {
    process.env.ELANOUS_TURN_CAPSULE_MODE = 'off';
    process.env.ELANOUS_TURN_CAPSULE_STAGES = 'none';
    const h = harness();
    const q = new TaskNotificationQueue(mkdtempSync(join(tmpdir(), 'a2-cap-')));
    const frames: CapsuleEvent[] = [];
    const sink = installShellCapsuleSink('seat-cap-capsule', (event) => frames.push(event));
    let started!: () => void;
    const onStarted = new Promise<void>((r) => { started = r; });
    const humanTurn = new AbortController();
    const tools = buildReplTools({
      getSignal: () => humanTurn.signal,
      dispatchBash: (args, options) => { started(); return dispatchBashCapsule(args, options, { queue: q, log: () => {} }); },
    });
    let toolResult: unknown;
    const t0 = Date.now();
    const result = await runGoalLoop({
      sessionId: 'seat-cap-capsule', messages: [{ role: 'user', content: '긴 셸' }], tools: [],
      dispatchTool: (n, a, c) => (tools.dispatch as (n: string, a: Record<string, unknown>, c: unknown) => Promise<unknown>)(n, a, c),
      signal: new AbortController().signal,
    } as CoreTurnContext, {
      changedFiles: () => [], controlSpaceId: null, intentStallProvider: null,
      attachLifecycleBridge: () => () => {}, startLivenessHeartbeat: () => () => {},
      now: h.now, seatTurnCap: SEAT, scheduleSeatWallCap: h.schedule,
      runTurn: async (turnCtx): Promise<CoreTurnResult> => {
        const call = turnCtx.dispatchTool('Bash', { command: 'sleep 2; echo survived-the-cap' }, { callId: 'b1', signal: turnCtx.signal } as never);
        await onStarted;
        h.advance(SEAT.maxWallMs + 1);
        toolResult = await call;
        return { stopReason: turnCtx.signal.aborted ? 'aborted' : 'end_turn', finalText: '(셸 캡슐)' };
      },
    });
    expect(Date.now() - t0).toBeLessThan(1_500); // 출처: #38598 (sleep 2 보다 먼저 — 턴이 셸을 기다리지 않았다)
    expect(result).toMatchObject({ stopReason: 'max_turns' });
    expect(String((toolResult as { output?: unknown }).output)).toMatch(/^\[capsule shell shell-[0-9a-z]+-\d+ started\]/);
    expect(q.size).toBe(0);
    for (let i = 0; i < 80 && q.size === 0; i++) await Bun.sleep(50);
    sink.dispose();
    const [note] = q.drain();
    expect([note?.agentName, note?.state, note?.output.trim()]).toEqual(['Bash', 'done', 'survived-the-cap']);
    expect(frames.filter((f) => f.type === 'capsule-done').map((f) => f.type === 'capsule-done' && f.status)).toEqual(['ok']);
  }, 30_000);

  test('사람의 Esc 는 지금처럼 셸을 멈춘다(상한 이유만 분리)', async () => {
    const sink = installShellCapsuleSink('seat-cap-esc', () => {});
    const turn = new AbortController();
    let inner: AbortSignal | undefined;
    const pending = runShellCapsule({
      tool: 'Bash', command: 'sleep 600', turnSignal: turn.signal,
      start: (signal) => { inner = signal; return new Promise<string>((resolve) => signal!.addEventListener('abort', () => resolve('stopped'))); },
      describe: () => ({ status: 'cancelled', output: '' }), started: () => 'started',
    }, { policy: { decide: () => ({ mode: 'sync', syncCapMs: 10_000, reason: 'capsule-sync-cap' }) }, log: () => {},
      setTimer: () => 1, clearTimer: () => {} });
    turn.abort(new Error('esc'));
    expect(await pending).toBe('stopped');
    expect(inner!.aborted).toBe(true);
    const capTurn = new AbortController();
    const detached = runShellCapsule({
      tool: 'Bash', command: 'sleep 600', turnSignal: capTurn.signal,
      start: () => new Promise<string>(() => {}), describe: () => ({ status: 'ok', output: '' }), started: (id) => `started ${id}`,
    }, { policy: { decide: () => ({ mode: 'sync', syncCapMs: 10_000, reason: 'capsule-sync-cap' }) }, log: () => {},
      queue: new TaskNotificationQueue(mkdtempSync(join(tmpdir(), 'a2-cap-'))), setTimer: () => 1, clearTimer: () => {} });
    capTurn.abort(new SeatTurnCapAbort('wall'));
    expect(await detached).toMatch(/^started shell-/);
    sink.dispose();
  });

  test('정책: 스위치 없음 — 기본 10s · turn.syncCapMs 가 상한 조절 · 0 = 분리 안 함', () => {
    const shell = { tool: 'Bash', kind: 'shell' } as const;
    expect(shellCapsulePolicy(undefined, () => ({ capsuleMode: false, capsuleStages: { A2: false } })).decide(shell)).toEqual({ mode: 'sync', syncCapMs: 10000, reason: 'capsule-sync-cap' });
    expect(shellCapsulePolicy(undefined, () => ({ syncCapMs: 3000 })).decide(shell)).toEqual({ mode: 'sync', syncCapMs: 3000, reason: 'capsule-sync-cap' });
    expect(shellCapsulePolicy(undefined, () => ({ syncCapMs: 0 })).decide(shell)).toEqual({ mode: 'sync', syncCapMs: Infinity, reason: 'sync-cap-zero' });
  });
});

describe('unit — 시작 전 상한: 승인 대기는 취소 · 실행 0 · 분리 없음 (JUD #39435 must)', () => {
  // clockFromSpawn(RunShell)만 승인 대기를 시작 뒤로 미룬다 — Bash 의 start 호출 자체가 시작이다.
  // 계약: 시작 확인(spawned) 뒤의 상한만 분리한다. 시작 전 상한은 대기 작업·승인을 취소한다(실행 0).
  const mkCall = (
    command: string, turnSignal: AbortSignal,
    start: ShellCapsuleCall<{ output: string }>['start'],
  ): ShellCapsuleCall<{ output: string }> => ({
    tool: 'RunShell', command, turnSignal, clockFromSpawn: true, start,
    describe: (result) => ({ status: 'ok', output: result.output }),
    started: (capsuleId) => ({ output: `started ${capsuleId}` }),
  });

  test('호출보다 먼저 닿은 상한은 시작조차 하지 않는다 — 승인 0 · 실행 0 · 분리 없음', async () => {
    const frames: CapsuleEvent[] = [];
    const sink = installShellCapsuleSink('a2-pre-launch', (event) => frames.push(event));
    let approvals = 0; let executions = 0;
    const cap = new AbortController();
    cap.abort(new SeatTurnCapAbort('wall'));
    const call = mkCall('sleep 20; echo a2-pre-launch', cap.signal, async (signal) => {
      approvals += 1;
      await new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
      executions += 1;
      return { output: 'ran-past-the-cap' };
    });
    const before = listDetachedShellCapsules().length;
    let threw: unknown;
    try { await runShellCapsule(call, { policy: { decide: () => ({ mode: 'sync', syncCapMs: 10_000, reason: 'capsule-sync-cap' }) }, log: () => {} }); } catch (error) { threw = error; }
    expect(isSeatTurnCapAbort(threw)).toBe(true);
    expect(approvals).toBe(0);
    expect(executions).toBe(0);
    expect(listDetachedShellCapsules().length).toBe(before);
    expect(frames).toEqual([]);
    sink.dispose();
  });

  test('승인 대기 중에 닿은 상한도 시작 전과 같다 — 실행 0 · 분리 없음', async () => {
    const frames: CapsuleEvent[] = [];
    const sink = installShellCapsuleSink('a2-mid-approval', (event) => frames.push(event));
    let approvals = 0; let executions = 0;
    const cap = new AbortController();
    const call = mkCall('sleep 20; echo a2-mid-approval', cap.signal, async (signal) => {
      approvals += 1;
      await new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
      executions += 1;
      return { output: 'ran-past-the-cap' };
    });
    const before = listDetachedShellCapsules().length;
    const pending = runShellCapsule(call, { policy: { decide: () => ({ mode: 'sync', syncCapMs: 10_000, reason: 'capsule-sync-cap' }) }, log: () => {} });
    await Bun.sleep(20); // 승인 대기에 들어간 뒤
    cap.abort(new SeatTurnCapAbort('wall'));
    let threw: unknown;
    try { await pending; } catch (error) { threw = error; }
    expect(isSeatTurnCapAbort(threw)).toBe(true);
    expect(approvals).toBe(1);
    expect(executions).toBe(0);
    expect(listDetachedShellCapsules().length).toBe(before);
    expect(frames).toEqual([]);
    sink.dispose();
  });

  test('이미 실행 중(spawned 확인 뒤)이면 상한은 분리한다 — 기존 동작 보존', async () => {
    // #38713 계약: 싱크 없는 호출은 인라인(레지스트리·프레임 없음) — 이 보존 시험의 분리·레지스트리 기대치는
    // 세션 싱크 위에서만 성립한다. RED 시절 통과는 (a)(b) 실패로 흘러든 누출 싱크에 매달린 것이었다(fix 후 dispose 됨).
    const frames: CapsuleEvent[] = [];
    const sink = installShellCapsuleSink('a2-running-detach', (event) => frames.push(event));
    let executions = 0; let spawnedCalls = 0;
    const cap = new AbortController();
    const call = mkCall('sleep 20; echo a2-running-detach', cap.signal, async (_signal, spawned) => {
      spawnedCalls += 1;
      spawned();
      executions += 1;
      await Bun.sleep(120);
      return { output: 'ran-to-completion' };
    });
    const pending = runShellCapsule(call, { policy: { decide: () => ({ mode: 'sync', syncCapMs: 10_000, reason: 'capsule-sync-cap' }) }, log: () => {} });
    await Bun.sleep(20);
    cap.abort(new SeatTurnCapAbort('wall'));
    const result = await pending;
    expect(String((result as { output?: unknown }).output)).toMatch(/^started shell-/);
    expect([executions, spawnedCalls]).toEqual([1, 1]);
    expect(listDetachedShellCapsules().some((c) => c.preview.includes('a2-running-detach'))).toBe(true);
    expect(frames.map((frame) => frame.type)).toEqual(['capsule-progress']); // 세션 싱크 회선 — 분리 프레임 1
    sink.dispose();
  });
});

describe('unit — OP #121854: 상한 뒤 늦은 allow·hit↔abort 경쟁 (실 RunShell 배선)', () => {
  afterEach(() => {
    setShellApprover(null);
    _resetApprovalCacheForTesting();
  });

  test('① 실 배선: 상한(abort) signal 위에 늦게 도착한 allow-session — 실행(spawn) 0 · 캐시 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'a2-late-allow-'));
    const marker = join(dir, 'ran-marker');
    const key = commandKey({ command: ['touch', marker], cwd: dir });
    const cap = new AbortController();
    cap.abort(new SeatTurnCapAbort('wall')); // 상한 — 늦은 allow 보다 먼저 발화
    let approverSignal: AbortSignal | undefined;
    let spawnReports = 0;
    let allowLate!: (decision: ApprovalDecision) => void;
    setShellApprover((request) => {
      approverSignal = request.signal; // OP: approver 에게 abort signal 전달
      return new Promise<ApprovalDecision>((resolve) => { allowLate = resolve; });
    });
    const pending = runShell({
      command: ['touch', marker], cwd: dir, approval: 'always',
      signal: cap.signal, timeoutMs: 5_000,
      onSpawn: () => { spawnReports += 1; },
    });
    await Bun.sleep(20); // 승인 대기 중 확인
    allowLate('allow-session'); // 늦은 allow — 상한(abort) 뒤에 도착
    const result = await pending;
    expect(approverSignal).toBe(cap.signal); // approver signal 전달
    expect(spawnReports).toBe(0); // 실행(spawn) 0 — onSpawn 은 spawn 확인 뒤에만 온다
    expect(existsSync(marker)).toBe(false); // 실 프로세스 부수효과 0
    expect(getCachedDecision(key)).toBeUndefined(); // allow-session 캐시(rememberDecision) 0
    expect(result.outcome).toBe('aborted');
    expect(result.exitCode).toBeNull();
  }, 10_000);

  test('② hit↔abort 미세작업 경쟁: 상한 히트 뒤 늦은 spawned 보고 — launched=false · 상한 재투척', async () => {
    const frames: CapsuleEvent[] = [];
    const sink = installShellCapsuleSink('a2-hit-abort-race', (event) => frames.push(event));
    let spawnReports = 0;
    const cap = new AbortController();
    let allowSpawn: (() => void) | undefined;
    const call: ShellCapsuleCall<{ output: string }> = {
      tool: 'RunShell', command: 'sleep 20; echo a2-hit-abort-race', turnSignal: cap.signal, clockFromSpawn: true,
      start: async (signal, spawned) => {
        await new Promise<void>((resolve) => { allowSpawn = resolve; }); // 승인 대기
        spawned(); // 늦은 allow — 상한 히트와 같은 미세작업 변두리에서 도착
        spawnReports += 1;
        await new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
        return { output: 'ran-past-the-cap' };
      },
      describe: (result) => ({ status: 'ok', output: result.output }),
      started: (capsuleId) => ({ output: `started ${capsuleId}` }),
    };
    const before = listDetachedShellCapsules().length;
    const pending = runShellCapsule(call, {
      policy: { decide: () => ({ mode: 'sync', syncCapMs: 10_000, reason: 'capsule-sync-cap' }) },
      log: () => {}, setTimer: () => 1, clearTimer: () => {},
    });
    await Bun.sleep(20); // 승인 대기에 들어간 뒤
    allowSpawn?.(); // 늦은 allow — 미세작업 대기열에 먼저 들어간다
    cap.abort(new SeatTurnCapAbort('wall')); // 상한 — hit('turn-cap') 이 그 뒤
    let threw: unknown;
    try { await pending; } catch (error) { threw = error; }
    expect(isSeatTurnCapAbort(threw)).toBe(true); // 상한 이유 재투척 — 분리 아님
    expect(spawnReports).toBe(1); // 경쟁은 실제로 벌어졌다 — 보고는 늦게 도착했고 aborted 가 이긴다
    expect(listDetachedShellCapsules().length).toBe(before); // 유령 캡슐 0
    expect(frames).toEqual([]); // 분리 프레임 0
    sink.dispose();
  }, 10_000);
});

describe('unit — JUD #122421 r10: pre-launch 상한은 하위(승인/시작) signal을 핸들러 안에서 동기 취소한다', () => {
  // 계약: 시작 전 상한의 취소 전달은 Promise.race 재개 뒤가 아니라 cap 핸들러 안에서 동기적으로 일어난다 —
  // 대기 중 승인 continuation이 살아있는 signal을 관찰하고 진행하는 경쟁을 없앤다. 이미 시작한 프로세스는 분리 유지.
  test('① 상한과 allow가 같은 tick: 승인 continuation은 살아있는 signal을 관찰하지 못한다 — 실행 0', async () => {
    const frames: CapsuleEvent[] = [];
    const sink = installShellCapsuleSink('r10-same-tick', (event) => frames.push(event));
    let allow!: () => void;
    const approval = new Promise<void>((resolve) => { allow = resolve; });
    let runs = 0;
    let innerSignal: AbortSignal | undefined;
    const cap = new AbortController();
    const call: ShellCapsuleCall<{ output: string }> = {
      tool: 'RunShell', command: 'sleep 20; echo r10-same-tick', turnSignal: cap.signal, clockFromSpawn: true,
      start: async (signal, spawned) => {
        innerSignal = signal;
        await approval;                       // 승인 대기 — allow가 상한과 같은 tick에 도착한다
        spawned();                            // 시작 보고 — capped면 무시된다
        await Promise.resolve();              // 미세작업 경계: 실 spawn 실행 지점 (실 배선의 승인 continuation)
        if (signal?.aborted) throw signal.reason; // 살아있는 signal 관찰 지점
        runs += 1;
        return { output: 'ran-past-the-cap' };
      },
      describe: (result) => ({ status: 'ok', output: result.output }),
      started: (capsuleId) => ({ output: `started ${capsuleId}` }),
    };
    const before = listDetachedShellCapsules().length;
    const pending = runShellCapsule(call, {
      policy: { decide: () => ({ mode: 'sync', syncCapMs: 10_000, reason: 'capsule-sync-cap' }) },
      log: () => {}, setTimer: () => 1, clearTimer: () => {},
    });
    await Bun.sleep(20);                        // 승인 대기 진입 확인
    cap.abort(new SeatTurnCapAbort('wall'));   // 상한 먼저
    allow();                                    // allow가 같은 tick 뒤에 도착
    let threw: unknown;
    try { await pending; } catch (error) { threw = error; }
    expect(isSeatTurnCapAbort(threw)).toBe(true);  // 상한이 이긴다 — 실행 승인은 취소
    expect(runs).toBe(0);                           // 실행 0 — 살아있는 signal 관찰 금지
    expect(listDetachedShellCapsules().length).toBe(before); // 유령 캡슐 0
    expect(frames).toEqual([]);                     // 분리 프레임 0
    sink.dispose();
  }, 10_000);

  test('② 시작 확인(spawned) 뒤 같은 tick 상한: 분리·실행 유지 — detach semantics 보존', async () => {
    const frames: CapsuleEvent[] = [];
    const sink = installShellCapsuleSink('r10-post-launch', (event) => frames.push(event));
    let runs = 0;
    let innerSignal: AbortSignal | undefined;
    const cap = new AbortController();
    const call: ShellCapsuleCall<{ output: string }> = {
      tool: 'RunShell', command: 'sleep 20; echo r10-post-launch', turnSignal: cap.signal, clockFromSpawn: true,
      start: async (signal, spawned) => {
        innerSignal = signal;
        spawned();                            // 시작 확인 — 상한보다 먼저
        runs += 1;
        await Bun.sleep(80);
        return { output: 'ran-to-completion' };
      },
      describe: (result) => ({ status: 'ok', output: result.output }),
      started: (capsuleId) => ({ output: `started ${capsuleId}` }),
    };
    const pending = runShellCapsule(call, {
      policy: { decide: () => ({ mode: 'sync', syncCapMs: 10_000, reason: 'capsule-sync-cap' }) },
      log: () => {}, setTimer: () => 1, clearTimer: () => {},
    });
    await Bun.sleep(20);                        // spawned 확인 뒤
    cap.abort(new SeatTurnCapAbort('wall'));   // 시작 뒤 상한 → 분리
    const result = await pending;
    expect(String((result as { output?: unknown }).output)).toMatch(/^started shell-/); // 분리 결과
    expect(runs).toBe(1);                           // 실행은 그대로
    expect(innerSignal?.aborted).toBe(false);       // 분리된 프로세스의 signal은 취소되지 않는다
    await Bun.sleep(120);                            // 실행 완료 대기 — settle 은 완료된 캡슐을 치운다(B1: capsule-done 프레임)
    expect(listDetachedShellCapsules().some((c) => c.preview.includes('r10-post-launch'))).toBe(false); // 완료 치움 — 레지스트리는 실행 중 캡슐만
    expect(frames.map((f) => f.type)).toEqual(['capsule-progress', 'capsule-done']);
    sink.dispose();
  }, 10_000);
});
