import { afterAll, beforeEach, expect, test } from 'bun:test';
import { getRecordingStore } from '../capture/recording-store.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';

const previousStateDir = process.env.ELANOUS_STATE_DIR;
const root = mkdtempSync(join(tmpdir(), 'pty-recording-'));
process.env.ELANOUS_STATE_DIR = root;
const { startPty, setPtyAdapterForTesting, resetForTesting, registerPtyControlTarget } = await import('./registry.js');
const { startPtyRecording, stopPtyRecording } = await import('./pty-recording.js');

let output: ((chunk: string) => void) | undefined;
let exit: ((event: { exitCode: number | null }) => void) | undefined;
const events: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
const oldLog = debug.log;

beforeEach(() => {
  resetForTesting();
  setPtyAdapterForTesting(() => ({
    pid: 123, write() {}, kill() {},
    onData(callback) { output = callback; return { dispose() {} }; },
    onExit(callback) { exit = callback; return { dispose() {} }; },
  }));
  events.length = 0;
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data: Record<string, unknown>) => {
    events.push({ category, event, data });
  }) as typeof debug.log;
});

afterAll(() => {
  resetForTesting();
  setPtyAdapterForTesting(null);
  (debug as { log: typeof debug.log }).log = oldLog;
  rmSync(root, { recursive: true, force: true });
  if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previousStateDir;
});

test('local start, two timed raw output events, stop and duplicate rejection', async () => {
  const handle = startPty({ cmd: 'fake', cols: 90, rows: 30 });
  const started = startPtyRecording(handle.id, { cols: handle.cols, rows: handle.rows, title: 'shell' });
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  expect(startPtyRecording(handle.id, { cols: 90, rows: 30 })).toEqual({ ok: false, reason: 'already-recording' });
  expect(existsSync(started.path)).toBe(false);
  output?.('hello');
  await Bun.sleep(20);
  output?.('hello');
  const stopped = stopPtyRecording(handle.id);
  expect(stopped).toMatchObject({ ok: true, path: started.path, bytes: expect.any(Number), durationMs: expect.any(Number) });
  const lines = readFileSync(started.path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(lines[0]).toMatchObject({ version: 2, width: 90, height: 30, title: 'shell' });
  expect(lines.slice(1).map((line) => line.slice(1))).toEqual([['o', 'hello'], ['o', 'hello']]);
  expect(lines[2][0]).toBeGreaterThan(lines[1][0]);
  if (!stopped.ok) throw new Error('stop failed');
  expect(stopped.bytes).toEqual(Buffer.byteLength(readFileSync(started.path, 'utf8'), 'utf8'));
  expect(getRecordingStore().get(started.recordingId)).toMatchObject({ artifactPath: started.path, encoder: 'asciicast', stoppedAt: expect.any(Number) });
  expect(dirname(started.path)).toBe(join(root, 'recordings'));
  expect(events.filter((item) => item.category === 'pty.record').map(({ event, data }) => ({ event, ptyId: data.ptyId, path: data.path, bytes: data.bytes })))
    .toEqual([{ event: 'start', ptyId: handle.id, path: started.path, bytes: 0 }, { event: 'stop', ptyId: handle.id, path: started.path, bytes: stopped.bytes }]);
  expect(events.some((item) => JSON.stringify(item).includes('hello'))).toBe(false);
});

test('foreground TUI stdout uses the owner tap and auto-stops when control target closes', () => {
  const original = process.stdout.write;
  const target = {
    id: 'tui:test', cols: 80, rows: 24, accessMode: 'write' as const, transitionPolicy: 'open' as const,
    setAccessMode: () => true, isAlive: () => true, canWrite: () => true,
    write: () => {}, resize: () => {},
  };
  const unregister = registerPtyControlTarget(target);
  try {
    const started = startPtyRecording(target.id, { cols: 80, rows: 24 });
    if (!started.ok) throw new Error('start failed');
    const writer = process.stdout.write;
    try {
      process.stdout.write = (() => true) as typeof process.stdout.write;
      writer.call(process.stdout, 'hello');
    } finally {
      process.stdout.write = writer;
    }
    unregister();
    expect(process.stdout.write).toBe(original);
    expect(readFileSync(started.path, 'utf8')).toContain('"o","hello"');
    expect(events.filter((item) => item.category === 'pty.record').map((item) => item.event)).toEqual(['start', 'auto-stop']);
  } finally {
    unregister();
    process.stdout.write = original;
  }
});

test('stopping after the state root changes still saves under the original root', () => {
  const handle = startPty({ cmd: 'fake' });
  const started = startPtyRecording(handle.id, { cols: 80, rows: 24 });
  if (!started.ok) throw new Error('start failed');
  const prior = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = join(root, 'other-state');
  try {
    output?.('hello');
    expect(stopPtyRecording(handle.id)).toMatchObject({ ok: true, path: started.path });
    expect(readFileSync(started.path, 'utf8')).toContain('"o","hello"');
  } finally {
    if (prior === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = prior;
  }
});

test('state directory failure does not discard a recording before it can be retried', () => {
  const handle = startPty({ cmd: 'fake' });
  const started = startPtyRecording(handle.id, { cols: 80, rows: 24 });
  if (!started.ok) throw new Error('start failed');
  output?.('hello');
  const directory = dirname(started.path);
  const hidden = `${directory}-temporarily-hidden`;
  renameSync(directory, hidden);
  try {
    mkdirSync(directory);
    mkdirSync(started.path);
    expect(() => stopPtyRecording(handle.id)).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
    renameSync(hidden, directory);
  }
  expect(stopPtyRecording(handle.id)).toMatchObject({ ok: true, path: started.path });
  expect(readFileSync(started.path, 'utf8')).toContain('"o","hello"');
});

test('exit saves a closed cast and emits auto-stop once', () => {
  const handle = startPty({ cmd: 'fake' });
  const started = startPtyRecording(handle.id, { cols: 80, rows: 24 });
  if (!started.ok) throw new Error('start failed');
  output?.('hello');
  exit?.({ exitCode: 0 });
  expect(readFileSync(started.path, 'utf8')).toContain('"o","hello"');
  expect(stopPtyRecording(handle.id)).toEqual({ ok: false, reason: 'not-recording' });
  expect(events.filter((item) => item.category === 'pty.record').map((item) => item.event)).toEqual(['start', 'auto-stop']);
});

test('no recording leaves output and snapshot unchanged and writes no file', () => {
  const recordings = join(root, 'recordings');
  const before = existsSync(recordings) ? readdirSync(recordings).length : 0;
  const handle = startPty({ cmd: 'fake' });
  output?.('hello');
  expect(handle.snapshot()).toBe('hello');
  expect(handle.drainDelta()).toBe('hello');
  expect(stopPtyRecording(handle.id)).toEqual({ ok: false, reason: 'not-recording' });
  expect(existsSync(recordings) ? readdirSync(recordings).length : 0).toBe(before);
  expect(events.filter((item) => item.category === 'pty.record')).toEqual([]);
});

test('a bookkeeping failure after the cast is written still finishes the recording', () => {
  const handle = startPty({ cmd: 'fake', cols: 80, rows: 20 });
  const started = startPtyRecording(handle.id, { cols: 80, rows: 20 });
  if (!started.ok) throw new Error('start failed');
  const store = getRecordingStore();
  const markStopped = store.markStopped;
  (store as { markStopped: typeof markStopped }).markStopped = () => { throw new Error('store down'); };
  try {
    output?.('saved');
    const stopped = stopPtyRecording(handle.id);
    expect(stopped).toMatchObject({ ok: true, path: started.path });
    expect(readFileSync(started.path, 'utf8')).toContain('"o","saved"');
    expect(stopPtyRecording(handle.id)).toEqual({ ok: false, reason: 'not-recording' });
    expect(events.some((e) => e.category === 'pty.record' && e.event === 'mark-stopped-error')).toBe(true);
  } finally {
    (store as { markStopped: typeof markStopped }).markStopped = markStopped;
  }
});

test('a failed save leaves no partial cast and the stop can be retried', () => {
  const handle = startPty({ cmd: 'fake', cols: 80, rows: 20 });
  const started = startPtyRecording(handle.id, { cols: 80, rows: 20 });
  if (!started.ok) throw new Error('start failed');
  output?.('retry-me');
  // Occupy the temp name with a directory so the write fails.
  const temp = `${started.path}.${process.pid}.tmp`;
  mkdirSync(temp, { recursive: true });
  try {
    expect(() => stopPtyRecording(handle.id)).toThrow();
    expect(existsSync(started.path)).toBe(false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  const retried = stopPtyRecording(handle.id);
  expect(retried).toMatchObject({ ok: true, path: started.path });
  expect(readFileSync(started.path, 'utf8')).toContain('"o","retry-me"');
});

test('a failed save on PTY exit is recovered once and never left active', () => {
  const handle = startPty({ cmd: 'fake', cols: 80, rows: 20 });
  const started = startPtyRecording(handle.id, { cols: 80, rows: 20 });
  if (!started.ok) throw new Error('start failed');
  output?.('last-words');
  const temp = `${started.path}.${process.pid}.tmp`;
  mkdirSync(temp, { recursive: true });
  try {
    exit?.({ exitCode: 0 });
    expect(existsSync(`${started.path}.recovered`)).toBe(true);
    expect(readFileSync(`${started.path}.recovered`, 'utf8')).toContain('"o","last-words"');
    expect(stopPtyRecording(handle.id)).toEqual({ ok: false, reason: 'not-recording' });
    expect(events.some((e) => e.category === 'pty.record' && e.event === 'auto-stop-recovered')).toBe(true);
    const row = getRecordingStore().get(started.recordingId);
    expect(row?.stoppedAt).toEqual(expect.any(Number));
    expect(row?.artifactPath).toBe(`${started.path}.recovered`);
    expect(existsSync(`${started.path}.recovered.${process.pid}.tmp`)).toBe(false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
