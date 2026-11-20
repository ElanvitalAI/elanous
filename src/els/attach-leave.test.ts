import { afterEach, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { guardLeave, realProcess, type LeaveProcess } from './attach-leave.js';
import { LEAVE_VIEW } from './attach-view.js';

// ELS-MOUSE-RELEASE (JUD FU on #39232): LEAVE_VIEW is written exactly once — normal finish, signal, uncaught exception, or any mix.
const fakeProcess = () => {
  const emitter = new EventEmitter();
  const exits: number[] = [];
  const proc: LeaveProcess = {
    on: (event, listener) => emitter.on(event, listener as (...args: unknown[]) => void),
    off: (event, listener) => emitter.off(event, listener as (...args: unknown[]) => void),
    exit: (code) => { exits.push(code ?? 0); emitter.emit('exit', code ?? 0); },   // the real process.exit() ends in the 'exit' event
  };
  return { emitter, exits, proc };
};
const guarded = () => {
  const fake = fakeProcess();
  const wire: string[] = [];
  const guard = guardLeave({ proc: fake.proc, write: (text) => { wire.push(text); }, bytes: LEAVE_VIEW });
  return { ...fake, wire, guard };
};

const restore: (() => void)[] = [];
afterEach(() => { for (const undo of restore.splice(0)) undo(); });

test('normal finish: leave() writes LEAVE_VIEW once; calling it again or the later process exit writes nothing more', () => {
  const g = guarded();
  g.guard.leave();
  g.guard.leave();
  g.emitter.emit('exit', 0);
  expect(g.wire).toEqual([LEAVE_VIEW]);
  expect(g.emitter.eventNames()).toEqual([]);                      // the guard took its listeners off
}, 10_000);

test('uncaught exception (the process ends in its exit event): LEAVE_VIEW is written once', () => {
  const g = guarded();
  g.emitter.emit('exit', 1);
  g.emitter.emit('exit', 1);
  expect(g.wire).toEqual([LEAVE_VIEW]);
}, 10_000);

test('SIGHUP / SIGTERM / SIGINT: LEAVE_VIEW once, then the process exits 128+n; a second signal or the exit event adds nothing', () => {
  for (const [signal, code] of [['SIGHUP', 129], ['SIGINT', 130], ['SIGTERM', 143]] as const) {
    const g = guarded();
    g.emitter.emit(signal);
    g.emitter.emit('SIGHUP');
    expect(g.wire).toEqual([LEAVE_VIEW]);
    expect(g.exits).toEqual([code]);
  }
}, 10_000);

test('a finish followed by a signal (or a signal followed by a finish) is still one write', () => {
  const a = guarded();
  a.guard.leave();
  a.emitter.emit('SIGHUP');
  expect(a.wire).toEqual([LEAVE_VIEW]);
  const b = guarded();
  b.emitter.emit('SIGHUP');
  b.guard.leave();
  expect(b.wire).toEqual([LEAVE_VIEW]);
}, 10_000);

test('on the real process: a SIGHUP delivered to its listeners writes once and exits 129 (exit stubbed); no listener is left behind', () => {
  const before = ['SIGHUP', 'SIGINT', 'SIGTERM', 'exit'].map((name) => process.listenerCount(name));
  const exits: number[] = [];
  const wire: string[] = [];
  const guard = guardLeave({ proc: { ...realProcess, exit: (code) => { exits.push(code ?? 0); } }, write: (t) => { wire.push(t); }, bytes: LEAVE_VIEW });
  restore.push(() => guard.leave());
  process.emit('SIGHUP');
  process.emit('SIGHUP');
  expect(wire).toEqual([LEAVE_VIEW]);
  expect(exits).toEqual([129]);
  expect(['SIGHUP', 'SIGINT', 'SIGTERM', 'exit'].map((name) => process.listenerCount(name))).toEqual(before);
}, 10_000);
