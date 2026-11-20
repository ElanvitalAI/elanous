import { expect, test } from 'bun:test';
import { createNextTuiQueue } from './core/queue.js';
import { createEventWatch } from './event-watch.js';
import { startEventWatchRunner } from './event-watch-runner.js';

const quietQueue = () => createNextTuiQueue({ log: () => {} });
const START = 1_000;
const DEADLINE = START + 60_000;

test('감시 줄은 event-watch notice 가 되고 빈 줄·같은 줄은 큐를 안 채운다', () => {
  const queue = quietQueue();
  const watch = createEventWatch(queue, { command: 'tail -f build.log', deadlineMs: DEADLINE });
  expect(watch.pushLine('  \n', START).kind).toBe('blank');
  const queued = watch.pushLine('build failed: tsc\n', START);
  expect(queued).toEqual({ kind: 'queued', text: 'build failed: tsc' });
  expect(watch.pushLine('build failed: tsc', START).kind).toBe('duplicate');
  expect(queue.count).toBe(1);
  const head = queue.dequeue();
  expect(head.kind).toBe('submit');
  if (head.kind === 'submit') {
    expect(head.itemKind).toBe('notice');
    expect(head.source).toBe('event-watch');
  }
});

test('시한을 넘긴 줄은 만료 알림 한 줄만 넣고 그 뒤는 멈춘다', () => {
  const queue = quietQueue();
  const watch = createEventWatch(queue, { command: 'tail -f build.log', deadlineMs: DEADLINE });
  expect(watch.pushLine('still going', DEADLINE - 1).kind).toBe('queued');
  expect(watch.pushLine('too late', DEADLINE).kind).toBe('expired');
  expect(watch.pushLine('after', DEADLINE + 1).kind).toBe('stopped');
  expect(watch.ended(0, DEADLINE + 1).kind).toBe('stopped');
  const texts = queue.items.map((item) => item.text);
  expect(texts).toEqual(['still going', '감시 만료: tail -f build.log — 시한']);
});

test('종료와 읽기 실패는 각자 알림 한 줄이고 그 뒤 줄은 버린다', () => {
  const ended = quietQueue();
  const endWatch = createEventWatch(ended, { command: 'deploy.sh', deadlineMs: null });
  expect(endWatch.ended(1, START)).toEqual({ kind: 'queued', text: '감시 종료: deploy.sh — 종료 코드 1' });
  expect(endWatch.pushLine('late line', START).kind).toBe('stopped');

  const failed = quietQueue();
  const failWatch = createEventWatch(failed, { command: 'deploy.sh', deadlineMs: null });
  expect(failWatch.readFailed('ENOENT', START).kind).toBe('queued');
  expect(failed.items[0]?.text).toBe('감시 읽기 실패: deploy.sh — ENOENT');
  const longCommand = 'c'.repeat(200);
  const longReason = `${'R'.repeat(210)}TAIL-GONE`;
  const longEnded = quietQueue();
  const longEnd = createEventWatch(longEnded, { command: longCommand, deadlineMs: null });
  const endedLine = longEnd.ended(1, START);
  expect(endedLine.kind).toBe('queued');
  if (endedLine.kind === 'queued') {
    expect(endedLine.text.length).toBe(200);
    expect(endedLine.text.endsWith(' — 종료 코드 1')).toBe(true);
  }
  const longFailed = quietQueue();
  const longFail = createEventWatch(longFailed, { command: longCommand, deadlineMs: null });
  const failedLine = longFail.readFailed(longReason, START);
  expect(failedLine.kind).toBe('queued');
  if (failedLine.kind === 'queued') {
    expect(failedLine.text.length).toBe(200);
    expect(failedLine.text.endsWith('…')).toBe(true);
    expect(failedLine.text.includes('TAIL-GONE')).toBe(false);
    expect(failedLine.text.includes(longReason.slice(0, 40))).toBe(true);
  }
  expect(failWatch.readFailed('EIO', START).kind).toBe('stopped');
});

test('출력이 없어도 시한 틱은 만료 알림 한 줄을 넣고 큐 깨움을 한 번 부른다', () => {
  const queue = quietQueue();
  const wakes: string[] = [];
  const runner = startEventWatchRunner(queue, {
    command: 'sleep 999',
    deadlineMs: DEADLINE,
    onQueued: () => { wakes.push('wake'); },
  });
  expect(runner.tick(DEADLINE - 1)).toBe(false);
  expect(queue.count).toBe(0);
  expect(runner.tick(DEADLINE)).toBe(true);
  expect(runner.tick(DEADLINE + 5_000)).toBe(false);
  expect(wakes).toEqual(['wake']);
  expect(queue.items.map((item) => item.text)).toEqual(['감시 만료: sleep 999 — 시한']);
  expect(queue.items[0]?.source).toBe('event-watch');
});

test('덩어리 경계에서 잘린 줄은 흐름별로 이어 붙여 notice 하나가 된다', () => {
  const queue = quietQueue();
  const wakes: string[] = [];
  const runner = startEventWatchRunner(queue, {
    command: 'echo split',
    deadlineMs: null,
    onQueued: () => { wakes.push('wake'); },
  });
  runner.feed('stdout', 'hel', START);
  runner.feed('stderr', 'err-only\n', START);
  runner.feed('stdout', 'lo\n', START);
  runner.close('stdout', START);
  expect(wakes).toEqual(['wake', 'wake']);
  expect(queue.items.map((item) => item.text)).toEqual(['err-only', 'hello']);
});

test('감시 줄이 큐에 들어가면 실제 큐 깨움 콜백이 돈다', () => {
  const queue = quietQueue();
  let woke = 0;
  const runner = startEventWatchRunner(queue, {
    command: 'echo hi',
    deadlineMs: null,
    onQueued: () => { woke += 1; },
  });
  expect(runner.pushLine('hi', START)).toBe(true);
  expect(runner.pushLine('', START)).toBe(false);
  expect(woke).toBe(1);
  expect(queue.count).toBe(1);
});

test('만료되면 틱을 지우고 셸 프로세스 그룹을 끊는다', async () => {
  const { attachEventWatchProcess } = await import('./event-watch-runner.js');
  const queue = quietQueue();
  const runner = startEventWatchRunner(queue, {
    command: 'sleep-group',
    deadlineMs: START + 1_000,
    onQueued: () => {},
  });
  const signals: Array<string | number | undefined> = [];
  const groups: number[] = [];
  const realKill = process.kill.bind(process);
  process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
    // fake pid 4242: a group SIGTERM lands, then the existence probe (signal 0) reports ESRCH = gone.
    if (pid < 0) {
      if (signal === 0) throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
      groups.push(-pid); signals.push(signal); return true;
    }
    return realKill(pid, signal);
  }) as typeof process.kill;
  try {
    const proc = attachEventWatchProcess(runner, 'sleep 30 && sleep 30', {
      deadlineMs: START + 1_000,
      now: () => START + 2_000,
      spawnImpl: () => ({
        pid: 4242,
        kill() { return true; },
        stdout: null,
        stderr: null,
        on() { return this; },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(runner.stopped).toBe(true);
    expect(groups).toContain(4242);
    expect(signals).toEqual(['SIGTERM']);
    proc.stop();
    expect(groups.filter((pid) => pid === 4242)).toEqual([4242]);
  } finally {
    process.kill = realKill;
  }
});

test('멈춘 감시는 줄을 받지 않고, 사람 입력은 감시 알림보다 먼저 나간다', () => {
  const queue = quietQueue();
  const watch = createEventWatch(queue, { command: 'tail -f build.log', deadlineMs: null });
  watch.pushLine('first', START);
  watch.stop();
  expect(watch.pushLine('second', START).kind).toBe('stopped');
  queue.enqueue('사람 입력');
  const head = queue.dequeue();
  if (head.kind === 'submit') expect(head.text).toBe('사람 입력');
});
