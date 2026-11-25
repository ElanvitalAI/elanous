// TUI-LONG-PASTE-SPIN — loop watchdog: in-loop degrade/recover on fake timers, off-loop hard-stall judgement and the
// real worker writing its diagnostic. Expectations are independent literals.
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoopWatchdog, judgeHardStall, planStallRestartArgv, stallRestartEnv, startLoopWatchdogWorker } from './loop-watchdog.js';

function harness() {
  let clock = 0;
  let tick: (() => void) | null = null;
  const logs: Array<{ event: string } & Record<string, unknown>> = [];
  let degrades = 0;
  let recovers = 0;
  const dog = createLoopWatchdog({
    log: (category, event, data) => { expect(category).toBe('tui.loop-stall'); logs.push({ event, ...data }); },
    now: () => clock,
    setIntervalFn: (fn) => { tick = fn; return {}; },
    clearIntervalFn: () => { tick = null; },
    onDegrade: () => { degrades += 1; },
    onRecover: () => { recovers += 1; },
  });
  /** Advance the clock by `ms` and fire one heartbeat (a heartbeat late by ms − 1000). */
  const beat = (ms: number) => { clock += ms; tick?.(); };
  return { dog, logs, beat, get degrades() { return degrades; }, get recovers() { return recovers; } };
}

describe('in-loop watchdog', () => {
  test('two stalled samples log but do not degrade; the third degrades once', () => {
    const h = harness();
    h.dog.phase('render:history');
    h.beat(7_000);
    h.beat(7_000);
    expect(h.dog.degraded()).toBe(false);
    h.beat(7_000);
    expect(h.dog.degraded()).toBe(true);
    expect(h.degrades).toBe(1);
    expect(h.logs.map((l) => l.event)).toEqual(['stall', 'stall', 'stall', 'degraded']);
    expect(h.logs[3]).toEqual({ event: 'degraded', ms: 6000, phase: 'render:history', consecutive: 3 });
    h.beat(7_000);
    expect(h.degrades).toBe(1);
  });

  test('a healthy sample in between resets the run', () => {
    const h = harness();
    h.beat(7_000); h.beat(7_000); h.beat(1_000); h.beat(7_000); h.beat(7_000);
    expect(h.dog.degraded()).toBe(false);
  });

  test('exactly 5 s late is not a stall; 5.001 s is', () => {
    const h = harness();
    h.beat(6_000); h.beat(6_000); h.beat(6_000);
    expect(h.logs.length).toBe(0);
    h.beat(6_001);
    expect(h.logs[0]).toEqual({ event: 'stall', ms: 5001, phase: 'boot', consecutive: 1, degraded: false });
  });

  test('frame reports count in-band (a loop that never yields still degrades)', () => {
    const h = harness();
    h.dog.phase('render');
    h.dog.frame(11_000); h.dog.frame(12_000); h.dog.frame(13_000);
    expect(h.dog.degraded()).toBe(true);
    expect(h.logs.at(-1)).toEqual({ event: 'degraded', ms: 13000, phase: 'render', consecutive: 3 });
    h.dog.frame(40);
    expect(h.logs.length).toBe(4);
  });

  test('recovers after 30 s without a stalled sample, not before', () => {
    const h = harness();
    h.beat(7_000); h.beat(7_000); h.beat(7_000);
    for (let i = 0; i < 29; i += 1) h.beat(1_000);
    expect(h.dog.degraded()).toBe(true);
    h.beat(1_000);
    expect(h.dog.degraded()).toBe(false);
    expect(h.recovers).toBe(1);
    expect(h.logs.at(-1)).toEqual({ event: 'recovered', quietMs: 30000 });
  });
});

describe('off-loop judgement and restart plan', () => {
  test('hard stall at 30 s since the last beat', () => {
    // 출처: #40060 hard-stall edge — 29,999 ms is not a stall, 30,000 ms is (LOOP_HARD_STALL_MS)
    expect(judgeHardStall({ wallNow: 1_000_000 + 29_999, base: 1_000_000, beat: 0, limitMs: 30_000 })).toEqual({ stalled: false, stalledMs: 29999 });
    // 출처: #40060 hard-stall edge — beat at 10 s, now 40 s → exactly the 30 s limit
    expect(judgeHardStall({ wallNow: 1_000_000 + 40_000, base: 1_000_000, beat: 10_000, limitMs: 30_000 })).toEqual({ stalled: true, stalledMs: 30000 });
  });

  test('restart argv drops an earlier resume/continue and resumes the session on screen', () => {
    expect(planStallRestartArgv({ execPath: '/b/bun', scriptPath: '/e/elanous.mjs', args: ['--tui', 'next', '--resume', 'old-id', '--name', 'op', '--continue'], sessionId: 'new-id' }))
      .toEqual(['/b/bun', '/e/elanous.mjs', '--tui', 'next', '--name', 'op', '--resume', 'new-id']);
    expect(planStallRestartArgv({ execPath: '/b/bun', scriptPath: '/e/elanous.mjs', args: ['--resume=x'], sessionId: 's' }))
      .toEqual(['/b/bun', '/e/elanous.mjs', '--resume', 's']);
  });

  test('generation cap: 3 restarts inside a minute, then diagnostic only', () => {
    expect(stallRestartEnv({}, 5_000_000).allowed).toBe(true);
    expect(stallRestartEnv({}, 5_000_000).env.ELANOUS_TUI_RESTART_GEN).toBe('1');
    expect(stallRestartEnv({ ELANOUS_TUI_RESTART_GEN: '2', ELANOUS_TUI_RESTART_AT: '4990000' }, 5_000_000).allowed).toBe(true);
    expect(stallRestartEnv({ ELANOUS_TUI_RESTART_GEN: '3', ELANOUS_TUI_RESTART_AT: '4990000' }, 5_000_000).allowed).toBe(false);
    expect(stallRestartEnv({ ELANOUS_TUI_RESTART_GEN: '3', ELANOUS_TUI_RESTART_AT: '4000000' }, 5_000_000)).toMatchObject({ allowed: true, env: { ELANOUS_TUI_RESTART_GEN: '1', ELANOUS_TUI_RESTART_REASON: 'loop-stall' } });
  });
});

test('worker: a loop that stops beating gets one diagnostic file (not armed → no restart)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-stall-'));
  try {
    // 출처: #40060 a short limit keeps the real-worker test fast (production limit is 30 s)
    const handle = await startLoopWatchdogWorker({ diagDir: dir, limitMs: 300, checkMs: 50 });
    expect(handle).not.toBeNull();
    const seen: Array<Record<string, unknown>> = [];
    handle!.onDiagnostic((d) => seen.push(d));
    // Nobody beats: shared[beat] stays 0 → stalled once 300 ms pass.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !existsSync(join(dir, 'loop-stall.jsonl'))) await Bun.sleep(50);
    const lines = readFileSync(join(dir, 'loop-stall.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.length).toBe(1);
    expect(lines[0]).toMatchObject({ event: 'tui.loop-stall', kind: 'hard', restart: 'not-armed', phase: 'idle', pid: process.pid });
    expect(readdirSync(dir).filter((f) => f.startsWith('loop-stall-')).length).toBe(1);
    handle!.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('worker: an armed hard stall execs the restart argv in place (same pid)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-stall-exec-'));
  try {
    const module = join(import.meta.dir, 'loop-watchdog.ts');
    // The child arms the watcher with a restart plan, then wedges its main thread for good.
    const child = [
      `const { startLoopWatchdogWorker } = await import(${JSON.stringify(module)});`,
      // 출처: #40060 a short limit keeps the exec test fast (production limit is 30 s)
      `const h = await startLoopWatchdogWorker({ diagDir: ${JSON.stringify(dir)}, limitMs: 300, checkMs: 50 });`,
      `h.setRestart({ sessionId: 'sess-1', argv: [process.execPath, '-e', 'console.log("REEXEC-OK pid=" + process.pid + " gen=" + process.env.ELANOUS_TUI_RESTART_GEN)'] });`,
      'h.arm(true);',
      'console.log("WEDGED pid=" + process.pid);',
      'await Bun.sleep(100);',
      'for (;;) {}',
    ].join('\n');
    const proc = Bun.spawn([process.execPath, '-e', child], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ELANOUS_TUI_RESTART_GEN: '' } });
    const killer = setTimeout(() => proc.kill(9), 15_000);
    const text = await new Response(proc.stdout).text();
    clearTimeout(killer);
    await proc.exited;
    const wedged = /WEDGED pid=(\d+)/.exec(text)?.[1];
    expect(wedged).toBeDefined();
    expect(text).toContain(`REEXEC-OK pid=${wedged} gen=1`);
    const lines = readFileSync(join(dir, 'loop-stall.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ kind: 'hard', restart: 'exec-resume', sessionId: 'sess-1' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
