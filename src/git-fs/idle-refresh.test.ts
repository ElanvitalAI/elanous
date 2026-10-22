import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GIT_POLL_IDLE_PAUSE_MS, createIdleGitPoll, dashboardIdleMs, gitDirtyRefreshIntervalMs } from './idle-refresh.js';
import { refreshDirtyAsync as refreshGitDirtyAsync, refreshGitSnapshotAsync } from './index.js';
import { withFakeBins } from '../ux-sim/fake-bin.js';
import { withSimClock } from '../ux-sim/fake-clock.js';
import { selfAmbientKeepWarmIntervalMs } from '../agent/self-ambient-cache.js';

describe('git dirty refresh cadence', () => {
  test('keeps the active cadence until two idle minutes, then backs off to one minute', () => {
    expect(gitDirtyRefreshIntervalMs(0)).toBe(5_000);
    expect(gitDirtyRefreshIntervalMs(119_999)).toBe(5_000);
    expect(gitDirtyRefreshIntervalMs(120_000)).toBe(60_000);
    expect(gitDirtyRefreshIntervalMs(10 * 60_000)).toBe(60_000);
  });

  test('a ten-minute stream with no new input remains active until the stream ends', () => {
    const tenMinutes = 10 * 60_000;
    const duringStream = dashboardIdleMs(tenMinutes, 0, true);
    expect(duringStream).toBe(0);
    expect(gitDirtyRefreshIntervalMs(duringStream)).toBe(5_000);
    expect(selfAmbientKeepWarmIntervalMs(duringStream)).toBe(25_000);
    expect(dashboardIdleMs(tenMinutes, 0, false)).toBe(tenMinutes);
    expect(gitDirtyRefreshIntervalMs(dashboardIdleMs(tenMinutes, 0, false))).toBe(60_000);
    expect(selfAmbientKeepWarmIntervalMs(dashboardIdleMs(tenMinutes, 0, false))).toBe(8 * 60_000);
  });
});

// CLASSIC-IDLE-GIT-POLL — 대표 10-21 «classic 백그라운드가 너무 무겁다»: 5분 무입력 classic 이 git 자식 63개를
// 띄웠다(OPC tui-idle-classic-vs-next.md). 대기(입력 없이 2분)에는 git 폴링·데우기를 멈추고, 입력이 오면
// 한 번 데운 뒤 재개한다. 데우기는 입력 경로 밖(미룬 콜백)에서 — TUI-TYPING-LAG 회귀 금지.
describe('CLASSIC-IDLE-GIT-POLL — idle pause ⊕ warm-on-input', () => {
  test('fake-clock: five idle minutes stop git polling after two; input warms once, deferred, then polling resumes', async () => {
    await withSimClock(1_000_000, async (clock) => {
      let lastInputAt = clock.now();
      const polls: number[] = [];
      let warms = 0;
      const states: Array<{ active: boolean; reason: string }> = [];
      const poll = createIdleGitPoll({
        idleMs: () => dashboardIdleMs(clock.now(), lastInputAt, false),
        poll: () => { polls.push(clock.now()); },
        warm: () => { warms += 1; },
        log: (data) => { states.push(data); },
      });
      const timer = setInterval(() => poll.tick(), 5_000);
      try {
        clock.tick(5 * 60_000);
        expect(polls.length).toBeGreaterThan(0);
        // Every poll after the first two minutes is gone: the idle stretch spawns nothing.
        expect(polls.filter((at) => at - 1_000_000 >= GIT_POLL_IDLE_PAUSE_MS)).toEqual([]);
        expect(poll.isActive()).toBe(false);
        expect(states).toEqual([{ active: false, reason: 'idle' }]);
        expect(warms).toBe(0);

        lastInputAt = clock.now();
        poll.noteActivity('input');
        // The key path only flips a flag — the warm runs after the key has been handled.
        expect(warms).toBe(0);
        clock.tick(0);
        expect(warms).toBe(1);
        expect(states.at(-1)).toEqual({ active: true, reason: 'input' });
        // Further keys while active do not warm again.
        poll.noteActivity('input');
        clock.tick(0);
        expect(warms).toBe(1);
        const before = polls.length;
        clock.tick(30_000);
        expect(polls.length - before).toBe(6);
        expect(warms).toBe(1);
      } finally {
        clearInterval(timer);
      }
    });
  });

  test('activity that arrives without a key (a stream, an edit) resumes on the next tick with one warm', () => {
    let idle = 10 * 60_000;
    let polls = 0;
    let warms = 0;
    const states: Array<{ active: boolean; reason: string }> = [];
    const poll = createIdleGitPoll({ idleMs: () => idle, poll: () => { polls += 1; }, warm: () => { warms += 1; }, log: (d) => { states.push(d); } });
    poll.tick();
    expect(polls).toBe(0);
    idle = 0;
    poll.tick();
    expect(warms).toBe(1);
    expect(polls).toBe(1);
    expect(states).toEqual([{ active: false, reason: 'idle' }, { active: true, reason: 'activity' }]);
  });

  test('fake-bin git: an idle poller spawns zero git children; the first key returns at once and a background warm follows', async () => {
    const realGit = Bun.which('git');
    if (!realGit) throw new Error('git is required to create the fixture repo');
    const repo = mkdtempSync(join(tmpdir(), 'idle-git-poll-'));
    try {
      execFileSync(realGit, ['init', '-q', '-b', 'main', repo]);
      // A slow fake git: if anything on the key path waited for it, the key would take a second.
      await withFakeBins({ git: { sleepSeconds: 1 } }, async (fakeBins) => {
        let idle = 3 * 60_000;
        const gitPass = (): void => {
          void refreshGitDirtyAsync(repo, { minIntervalMs: 0 });
          void refreshGitSnapshotAsync(repo, { ifOlderThanMs: 30_000 });
        };
        const poll = createIdleGitPoll({ idleMs: () => idle, poll: gitPass, warm: gitPass, log: () => {} });
        // Five idle minutes of 5s ticks.
        for (let i = 0; i < 60; i += 1) poll.tick();
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(fakeBins.calls()).toEqual([]);

        idle = 0;
        const startedAt = performance.now();
        poll.noteActivity('input');
        const keyPathMs = performance.now() - startedAt;
        expect(keyPathMs).toBeLessThan(50);
        expect(fakeBins.calls()).toEqual([]);
        const calls = await fakeBins.waitForCalls(1, 5_000);
        expect(calls.every((call) => call.name === 'git')).toBe(true);
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 20_000);
});
