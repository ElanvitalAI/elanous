import { afterEach, expect, jest, test } from 'bun:test';
import { startClipboardHistory } from './history.js';

let readCount = 0;
let clipboardText: string | null = null;
let busy = false;
let readClipboardOverride: (() => Promise<string | null>) | undefined;
const observed: Array<{ active: boolean; reason: string }> = [];

const dependencies = {
  isClipboardSupported: () => true,
  readClipboardText: async () => {
    readCount += 1;
    if (readClipboardOverride) return readClipboardOverride();
    return clipboardText;
  },
  observe: (_event: 'poll-state', data: { active: boolean; reason: string }) => { observed.push(data); },
};
const histories: Array<ReturnType<typeof startClipboardHistory>> = [];

afterEach(() => {
  for (const history of histories.splice(0)) history.stop();
  jest.clearAllTimers();
  jest.useRealTimers();
  readCount = 0;
  clipboardText = null;
  busy = false;
  readClipboardOverride = undefined;
  observed.length = 0;
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test('backs off at 2m and 10m, then reads immediately when input resumes', async () => {
  jest.useFakeTimers({ now: 0 });
  const history = startClipboardHistory({
    intervalMs: 100,
    idleAfterMs: 200,
    idleIntervalMultiplier: 10,
    longIdleAfterMs: 400,
    longIdleIntervalMultiplier: 60,
  }, dependencies);
  histories.push(history);
  await flushMicrotasks();
  expect(readCount).toBe(1);

  jest.advanceTimersByTime(100);
  await flushMicrotasks();
  expect(readCount).toBe(2);
  jest.advanceTimersByTime(100);
  await flushMicrotasks();
  expect(readCount).toBe(3); // at 200ms idle, next wait is 1000ms

  jest.advanceTimersByTime(999);
  await flushMicrotasks();
  expect(readCount).toBe(3);
  jest.advanceTimersByTime(1);
  await flushMicrotasks();
  expect(readCount).toBe(4); // at 1200ms idle, next wait is 6000ms

  clipboardText = 'clipboard after input';
  history.noteActivity();
  await flushMicrotasks();
  expect(readCount).toBe(5);
  expect(history.entries[0]?.text).toBe('clipboard after input');
  jest.advanceTimersByTime(100);
  await flushMicrotasks();
  expect(readCount).toBe(6); // active cadence restored
});

test('a busy stream keeps the active cadence and restarts the idle grace on completion', async () => {
  jest.useFakeTimers({ now: 0 });
  busy = true;
  const history = startClipboardHistory({
    intervalMs: 100,
    idleAfterMs: 200,
    idleIntervalMultiplier: 10,
    longIdleAfterMs: 400,
    longIdleIntervalMultiplier: 60,
    isBusy: () => busy,
  }, dependencies);
  histories.push(history);
  await flushMicrotasks();
  jest.advanceTimersByTime(100);
  await flushMicrotasks();
  jest.advanceTimersByTime(100);
  await flushMicrotasks();
  expect(readCount).toBe(3);

  busy = false;
  history.noteBusyChange();
  await flushMicrotasks();
  expect(readCount).toBe(4); // transition to idle starts a fresh grace period immediately
  jest.advanceTimersByTime(100);
  await flushMicrotasks();
  expect(readCount).toBe(5);
});

test('a busy transition wakes a deep-idle poller immediately', async () => {
  jest.useFakeTimers({ now: 0 });
  const history = startClipboardHistory({
    intervalMs: 100,
    idleAfterMs: 200,
    idleIntervalMultiplier: 10,
    longIdleAfterMs: 400,
    longIdleIntervalMultiplier: 60,
    isBusy: () => busy,
  }, dependencies);
  histories.push(history);
  await flushMicrotasks();
  jest.advanceTimersByTime(100);
  await flushMicrotasks();
  jest.advanceTimersByTime(100);
  await flushMicrotasks();
  jest.advanceTimersByTime(1_000);
  await flushMicrotasks();
  expect(readCount).toBe(4); // next timer is six seconds away

  busy = true;
  history.noteBusyChange();
  await flushMicrotasks();
  expect(readCount).toBe(5); // busy entry interrupts the deep-idle timer
  jest.advanceTimersByTime(100);
  await flushMicrotasks();
  expect(readCount).toBe(6); // busy work keeps the active cadence
});

test('input activity triggers a fresh read after an older clipboard read completes', async () => {
  jest.useFakeTimers({ now: 0 });
  let resolveFirst: ((text: string | null) => void) | undefined;
  readClipboardOverride = () => readCount === 1
    ? new Promise((resolve) => { resolveFirst = resolve; })
    : Promise.resolve(clipboardText);
  const history = startClipboardHistory({ intervalMs: 100, idleAfterMs: 100 }, dependencies);
  histories.push(history);
  await flushMicrotasks();
  expect(readCount).toBe(1);

  jest.setSystemTime(200);
  clipboardText = 'fresh after activity';
  history.noteActivity();
  expect(readCount).toBe(1); // the older read is still in flight

  resolveFirst?.('stale before activity');
  await flushMicrotasks();
  await flushMicrotasks();

  expect(readCount).toBe(2);
  expect(history.entries[0]?.text).toBe('fresh after activity');
});

test('pokeNow takes a fresh snapshot after an older in-flight read', async () => {
  jest.useFakeTimers({ now: 0 });
  let resolveFirst: ((text: string | null) => void) | undefined;
  readClipboardOverride = () => readCount === 1
    ? new Promise((resolve) => { resolveFirst = resolve; })
    : Promise.resolve(clipboardText);
  const history = startClipboardHistory({ intervalMs: 10_000 }, dependencies);
  histories.push(history);
  await flushMicrotasks();
  expect(readCount).toBe(1);

  clipboardText = 'promoted clipboard value';
  const poke = history.pokeNow();
  resolveFirst?.('stale clipboard value');
  await poke;

  expect(readCount).toBe(2);
  expect(history.entries[0]?.text).toBe('promoted clipboard value');
});

test('pokeNow reuses an already queued activity read and keeps polling scheduled', async () => {
  jest.useFakeTimers({ now: 0 });
  let resolveFirst: ((text: string | null) => void) | undefined;
  readClipboardOverride = () => {
    const valueAtReadStart = clipboardText;
    return readCount === 1
      ? new Promise((resolve) => { resolveFirst = resolve; })
      : Promise.resolve(valueAtReadStart);
  };
  clipboardText = 'before activity';
  const history = startClipboardHistory({ intervalMs: 10_000, idleAfterMs: 100 }, dependencies);
  histories.push(history);
  await flushMicrotasks();
  expect(readCount).toBe(1);

  jest.setSystemTime(200);
  history.noteActivity();
  clipboardText = 'promoted clipboard';
  const poke = history.pokeNow();
  resolveFirst?.('before activity');
  await poke;
  await flushMicrotasks();

  expect(readCount).toBe(2);
  expect(history.entries[0]?.text).toBe('promoted clipboard');
  expect(jest.getTimerCount()).toBe(1);
});

test('pokeNow takes a post-promotion read after an older idle-wake snapshot', async () => {
  jest.useFakeTimers({ now: 0 });
  let resolveWakeRead: ((text: string | null) => void) | undefined;
  readClipboardOverride = () => {
    const valueAtReadStart = clipboardText;
    if (readCount === 2) return new Promise((resolve) => { resolveWakeRead = resolve; });
    return Promise.resolve(valueAtReadStart);
  };
  const history = startClipboardHistory({ intervalMs: 10_000, idleAfterMs: 100 }, dependencies);
  histories.push(history);
  await flushMicrotasks();
  expect(readCount).toBe(1);

  jest.setSystemTime(200);
  history.noteActivity();
  await flushMicrotasks();
  expect(readCount).toBe(2);
  clipboardText = 'promoted after wake snapshot';
  const poke = history.pokeNow();
  resolveWakeRead?.('value captured before promotion');
  await poke;
  await flushMicrotasks();

  expect(readCount).toBe(3);
  expect(history.entries[0]?.text).toBe('promoted after wake snapshot');
  expect(jest.getTimerCount()).toBe(1); // the next poll remains scheduled
});


test('CLASSIC-IDLE-CLIPBOARD: a closed panel (active:false) never reads the clipboard and keeps no timer', async () => {
  jest.useFakeTimers({ now: 0 });
  const history = startClipboardHistory({
    intervalMs: 100,
    idleAfterMs: 200,
    active: false,
    isBusy: () => busy,
  }, dependencies);
  histories.push(history);
  await flushMicrotasks();
  expect(readCount).toBe(0);
  expect(jest.getTimerCount()).toBe(0);

  // Input and busy transitions must not wake a closed panel's poller.
  jest.setSystemTime(1_000);
  history.noteActivity();
  busy = true;
  history.noteBusyChange();
  busy = false;
  history.noteBusyChange();
  jest.advanceTimersByTime(10 * 60_000);
  await flushMicrotasks();
  expect(readCount).toBe(0);
  expect(jest.getTimerCount()).toBe(0);
});

test('CLASSIC-IDLE-CLIPBOARD: opening the panel reads once immediately, then polls; closing stops it', async () => {
  jest.useFakeTimers({ now: 0 });
  clipboardText = 'copied while the panel was closed';
  const history = startClipboardHistory({ intervalMs: 100, idleAfterMs: 10_000, active: false }, dependencies);
  histories.push(history);
  await flushMicrotasks();
  expect(readCount).toBe(0);

  history.setActive(true, 'panel-open');
  await flushMicrotasks();
  expect(readCount).toBe(1);
  expect(history.entries[0]?.text).toBe('copied while the panel was closed');
  jest.advanceTimersByTime(100);
  await flushMicrotasks();
  expect(readCount).toBe(2);
  jest.advanceTimersByTime(100);
  await flushMicrotasks();
  expect(readCount).toBe(3);

  history.setActive(false, 'panel-close');
  expect(jest.getTimerCount()).toBe(0);
  jest.advanceTimersByTime(10 * 60_000);
  await flushMicrotasks();
  expect(readCount).toBe(3);

  // Re-opening is idempotent per state: one immediate read, not two.
  history.setActive(true, 'panel-open');
  history.setActive(true, 'panel-open');
  await flushMicrotasks();
  expect(readCount).toBe(4);
  expect(jest.getTimerCount()).toBe(1);
  expect(observed).toEqual([
    { active: true, reason: 'panel-open' },
    { active: false, reason: 'panel-close' },
    { active: true, reason: 'panel-open' },
  ]);
});

test('CLASSIC-IDLE-CLIPBOARD: closing during an in-flight read leaves no timer behind', async () => {
  jest.useFakeTimers({ now: 0 });
  let resolveRead: ((text: string | null) => void) | undefined;
  readClipboardOverride = () => new Promise((resolve) => { resolveRead = resolve; });
  const history = startClipboardHistory({ intervalMs: 100, active: false }, dependencies);
  histories.push(history);
  history.setActive(true, 'panel-open');
  await flushMicrotasks();
  expect(readCount).toBe(1);
  history.setActive(false, 'panel-close');
  resolveRead?.('late value');
  await flushMicrotasks();
  await flushMicrotasks();
  expect(jest.getTimerCount()).toBe(0);
  jest.advanceTimersByTime(10_000);
  await flushMicrotasks();
  expect(readCount).toBe(1);
});
