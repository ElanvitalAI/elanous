/**
 * TUI-HERDR-STATUS-STALE (0.2.36 · 10-22 n8n 실물) — herdr 가 1.9h 동안 쉬던 classic TUI 를 `working` 으로 보였다.
 * 원인: turn 신고 하나가 timeout(herdr 가 바빠 2s 초과 · prod `pty.herdr report-failed {stderrHead:"timeout"}` 16:27Z)
 * 이면 신고기가 «영영» 꺼져 턴 끝 idle 이 안 나갔다. 수리: timeout 은 끄지 않고 마지막 상태를 다시 신고한다.
 * 장치: 진짜 신고기 ⊕ 진짜 녹음기(reportTuiTurn — classic·next 공용) ⊕ fake-herdr(reportFault).
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  createHerdrAgentReporter,
  herdrJsonError,
  HERDR_TURN_RETRY_MAX,
  type HerdrRunOpts,
  type HerdrRunResult,
  type HerdrSeqStore,
} from './herdr-agent-report.js';
import { reportTuiTurn, resetTuiRunStateForTesting, startTuiRunStateRecorder } from './tui-run-state.js';
import { createFakeHerdr, type FakeHerdr, type FakeHerdrReportFault } from '../ux-sim/fake-herdr.js';

const env = { HERDR_ENV: '1', HERDR_PANE_ID: 'w1:n8n' };

function memorySeqStore(): HerdrSeqStore {
  let v: number | undefined;
  return { read: () => v, write: (n) => { v = n; } };
}

/** fake-herdr → 신고기 러너(비동기 = herdr 자식 프로세스 · 동기 = 종료 경로). */
function runnerOf(herdr: FakeHerdr) {
  const toResult = (r: { code: number | null; stdout: string; stderr: string; timedOut?: boolean }): HerdrRunResult =>
    r.code === 0 && !herdrJsonError(r.stdout) ? { ok: true } : { ok: false, stderr: r.stderr || r.stdout, ...(r.timedOut ? { timedOut: true } : {}) };
  return (argv: string[], opts: HerdrRunOpts): HerdrRunResult | Promise<HerdrRunResult> =>
    opts.sync ? toResult(herdr.runSync(argv)) : herdr.run(argv, opts.timeoutMs).then(toResult);
}

/** 재신고 타이머를 손으로 돌린다. */
function manualSchedule() {
  const due: Array<() => void> = [];
  return { schedule: (fn: () => void) => { due.push(fn); }, runAll: () => { for (const fn of due.splice(0)) fn(); }, size: () => due.length };
}

const flush = () => new Promise((r) => setTimeout(r, 5));
const stateOf = (herdr: FakeHerdr) => herdr.reportedAgents().map((a) => a.state);

function setup(fault: (argv: readonly string[], i: number) => FakeHerdrReportFault | undefined) {
  const herdr = createFakeHerdr({ panes: [], reportFault: fault });
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const clock = manualSchedule();
  let t = 1_000;
  const reporter = createHerdrAgentReporter({
    env, run: runnerOf(herdr), log: (event, data) => events.push({ event, data }),
    seqStore: memorySeqStore(), sessionId: 'n8n', now: () => t++, schedule: clock.schedule,
  })!;
  const stop = startTuiRunStateRecorder('tui:n8n', { herdr: reporter, writeTurn: () => true, writeBuild: () => true, signals: null, log: () => {} });
  return { herdr, events, clock, stop };
}

const stateArg = (argv: readonly string[]) => argv[argv.indexOf('--state') + 1];

afterEach(() => resetTuiRunStateForTesting());

describe('TUI-HERDR-STATUS-STALE', () => {
  test('재현(10-22 n8n): 턴 시작 working 신고가 herdr 엔 닿았는데 답이 timeout → 턴 끝 idle 이 herdr 에 닿는다', async () => {
    // index 0 = start(idle 등록) · 1 = 턴 시작 working (적용됐지만 timeout — 사고 모양)
    const s = setup((argv, i) => (i === 1 && stateArg(argv) === 'working' ? 'applied-then-timeout' : undefined));
    await flush();
    reportTuiTurn('busy');
    await flush();
    expect(stateOf(s.herdr)).toEqual(['working']);
    reportTuiTurn('idle'); // 턴 끝 — 옛 코드는 여기서 신고기가 꺼져 있어 아무것도 안 보냈다(herdr = working 고정)
    await flush();
    expect(stateOf(s.herdr)).toEqual(['idle']);
    expect(s.events.some((e) => e.event === 'report-failed')).toBe(false);
    s.stop();
  });

  test('턴 끝 idle 신고 자체가 timeout(미적용) → 잠시 뒤 다시 신고해 herdr 가 idle 이 된다', async () => {
    // 턴 끝 idle(등록 idle 은 --agent-session-id 를 단다 — 그건 빼고) 한 번만 timeout.
    let idleTimeouts = 1;
    const s = setup((argv) => (stateArg(argv) === 'idle' && !argv.includes('--agent-session-id') && idleTimeouts-- > 0 ? 'timeout' : undefined));
    await flush();
    reportTuiTurn('busy');
    await flush();
    reportTuiTurn('idle');
    await flush();
    expect(stateOf(s.herdr)).toEqual(['working']); // timeout — 아직 안 닿음
    expect(s.events.find((e) => e.event === 'report-timeout-retry')?.data).toMatchObject({ state: 'idle', attempt: 1 });
    s.clock.runAll();
    await flush();
    expect(stateOf(s.herdr)).toEqual(['idle']);
    s.stop();
  });

  test('재신고는 더 새 턴이 오면 그만 · 상한을 넘으면 report-gave-up 을 남기고 다음 턴 신고는 그대로 간다', async () => {
    let failIdle = true;
    const s = setup((argv) => (failIdle && stateArg(argv) === 'idle' && !argv.includes('--agent-session-id') ? 'timeout' : undefined));
    await flush();
    reportTuiTurn('busy'); await flush();
    reportTuiTurn('idle'); await flush();
    // 더 새 턴(busy)이 먼저 오면 앞 idle 재신고는 버린다.
    reportTuiTurn('busy'); await flush();
    s.clock.runAll(); await flush();
    expect(stateOf(s.herdr)).toEqual(['working']);
    // idle 이 계속 timeout — 상한까지 다시 신고하고 포기를 남긴다.
    reportTuiTurn('idle'); await flush();
    for (let i = 0; i < HERDR_TURN_RETRY_MAX + 1; i++) { s.clock.runAll(); await flush(); }
    expect(s.events.filter((e) => e.event === 'report-gave-up')).toHaveLength(1);
    expect(s.clock.size()).toBe(0);
    // 신고기는 켜져 있다 — herdr 가 회복하면 다음 턴 신고가 닿는다.
    failIdle = false;
    reportTuiTurn('busy'); await flush();
    reportTuiTurn('idle'); await flush();
    expect(stateOf(s.herdr)).toEqual(['idle']);
    s.stop();
  });

  test('timeout 이 아닌 실패(오류 봉투·rc≠0)는 예전처럼 신고기를 끈다', async () => {
    const herdr = createFakeHerdr({ panes: [] });
    const events: string[] = [];
    let calls = 0;
    const run = (argv: string[], opts: HerdrRunOpts): HerdrRunResult | Promise<HerdrRunResult> => {
      if (argv[1] === 'report-agent' && stateArg(argv) === 'working') { calls += 1; return Promise.resolve({ ok: false, stderr: 'pane_not_found: gone' }); }
      return runnerOf(herdr)(argv, opts);
    };
    const reporter = createHerdrAgentReporter({ env, run, log: (e) => events.push(e), seqStore: memorySeqStore(), sessionId: 'x', schedule: () => { throw new Error('no retry'); } })!;
    reporter.start(); await flush();
    reporter.turn('busy'); await flush();
    reporter.turn('idle'); reporter.turn('busy'); await flush();
    expect(events).toEqual(['report-failed']);
    expect(calls).toBe(1);
  });
});
