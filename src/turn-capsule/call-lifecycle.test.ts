import { expect, test } from 'bun:test';
import { waitOrDetach, type CapsuleCallOutcome } from './call-lifecycle.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test('fast completion and failure return their original result without a completion event', async () => {
  const events: unknown[] = [];
  const common = { capsuleId: 'c1', syncCapMs: 100, deadlineMs: 200, onDone: (value: unknown) => { events.push(value); }, onDeliveryError: () => {} };
  expect(await waitOrDetach({ ...common, operation: Promise.resolve('result') })).toEqual({ state: 'completed', outcome: { status: 'ok', value: 'result' } });
  expect(await waitOrDetach({ ...common, operation: Promise.reject('error') })).toEqual({ state: 'completed', outcome: { status: 'failed', error: 'error' } });
  expect(events).toEqual([]);
});

test('one in-flight operation detaches and reports its result once with correlated events', async () => {
  let finish!: (value: string) => void;
  const done: CapsuleCallOutcome<string>[] = [];
  const logs: unknown[] = [];
  const operation = new Promise<string>((resolve) => { finish = resolve; });
  const started = await waitOrDetach({ capsuleId: 'c2', operation, syncCapMs: 0, deadlineMs: 200,
    onDone: (outcome) => { done.push(outcome); }, onDeliveryError: () => {}, log: (name, data) => { logs.push([name, data]); } });
  expect(started).toEqual({ state: 'started', capsuleId: 'c2' });
  finish('finished');
  await sleep(5);
  expect(done).toEqual([{ status: 'ok', value: 'finished' }]);
  expect(logs).toEqual([['turn-life:capsule-detached', { capsuleId: 'c2' }], ['turn-life:capsule-completed', { capsuleId: 'c2' }]]);
});

test('deadline cancels once and ignores a later operation result', async () => {
  let finish!: (value: string) => void;
  let cancellations = 0;
  const done: CapsuleCallOutcome<string>[] = [];
  const operation = new Promise<string>((resolve) => { finish = resolve; });
  expect(await waitOrDetach({ capsuleId: 'c3', operation, syncCapMs: 0, deadlineMs: 15,
    onDone: (outcome) => { done.push(outcome); }, onTimeout: () => { cancellations++; }, onDeliveryError: () => {} })).toEqual({ state: 'started', capsuleId: 'c3' });
  await sleep(30); finish('late'); await sleep(5);
  expect(cancellations).toBe(1);
  expect(done).toEqual([{ status: 'timeout' }]);
});

test('delivery failure is reported to recovery without causing an unhandled rejection', async () => {
  let finish!: (value: string) => void;
  const errors: unknown[] = [];
  const operation = new Promise<string>((resolve) => { finish = resolve; });
  await waitOrDetach({ capsuleId: 'c4', operation, syncCapMs: 0, deadlineMs: 200,
    onDone: async () => { throw Error('delivery'); }, onDeliveryError: (error, outcome) => { errors.push([(error as Error).message, outcome]); } });
  finish('payload'); await sleep(5);
  expect(errors).toEqual([['delivery', { status: 'ok', value: 'payload' }]]);
});

test('deadline before detachment returns timeout without a background delivery', async () => {
  let cancelled = 0;
  const delivered: unknown[] = [];
  const result = await waitOrDetach({ capsuleId: 'c5', operation: new Promise<string>(() => {}), syncCapMs: 100, deadlineMs: 10,
    onDone: (outcome) => { delivered.push(outcome); }, onTimeout: () => { cancelled++; }, onDeliveryError: () => {} });
  expect(result).toEqual({ state: 'completed', outcome: { status: 'timeout' } });
  expect(cancelled).toBe(1);
  expect(delivered).toEqual([]);
});

test('invalid limits reject synchronously instead of scheduling an unbounded call', () => {
  const base = { capsuleId: 'c6', operation: Promise.resolve('x'), syncCapMs: 1, deadlineMs: 2, onDone: () => {}, onDeliveryError: () => {} };
  expect(() => waitOrDetach({ ...base, syncCapMs: -1 })).toThrow(RangeError);
  expect(() => waitOrDetach({ ...base, deadlineMs: Infinity })).toThrow(RangeError);
  expect(() => waitOrDetach({ ...base, capsuleId: '' })).toThrow(RangeError);
});
