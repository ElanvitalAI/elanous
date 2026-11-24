import { expect, test } from 'bun:test';
import { changeCloudMachine, idleStopEligible, type CloudEvent, type CloudLifecycleDeps, type CloudMachine, type CloudState } from './cloud-lifecycle.js';

test('fake VM start, repair and idle stop record authorized transitions and protect members', async () => {
  let state: CloudState = 'stopped';
  const events: CloudEvent[] = [];
  const deps: CloudLifecycleDeps = {
    now: () => 2_000_000, authorize: async () => true,
    audit: async e => { events.push(e); },
    execute: async (_host, action) => { if (action === 'start') state = 'running'; if (action === 'stop') state = 'stopped'; },
    probe: async () => state, withHostLock: async (_id, work) => work(),
  };
  const vm: CloudMachine = { id: 'fake-vm', state: 'stopped', protected: false, lastBusyAt: 0 };
  const running = await changeCloudMachine(vm, 'start', 'RES', 'capacity', 0.5, deps);
  expect(running.state).toBe('running');
  await changeCloudMachine(running, 'repair', 'RES', 'synthetic health failure', 0.5, deps);
  expect(idleStopEligible(running, deps.now(), true)).toBe(true);
  expect(idleStopEligible(running, deps.now(), false)).toBe(false);
  const stopped = await changeCloudMachine(running, 'stop', 'RES', 'idle', 0.5, deps);
  expect(stopped.state).toBe('stopped');
  expect(events.map(e => `${e.action}:${e.phase}`)).toEqual(['start:requested', 'start:confirmed', 'repair:requested', 'repair:confirmed', 'stop:requested', 'stop:confirmed']);
  await expect(changeCloudMachine({ ...running, protected: true }, 'stop', 'RES', 'idle', null, deps)).rejects.toThrow('protected');
});

test('failed authorization or audit never dispatches a provider action', async () => {
  let calls = 0;
  const host: CloudMachine = { id: 'fake', state: 'stopped', protected: false, lastBusyAt: null };
  const deps: CloudLifecycleDeps = { now: () => 1, authorize: async () => false, audit: async () => { throw new Error('audit unavailable'); },
    execute: async () => { calls++; }, probe: async () => 'stopped', withHostLock: async (_id, work) => work() };
  await expect(changeCloudMachine(host, 'start', 'RES', 'capacity', null, deps)).rejects.toThrow('not authorized');
  deps.authorize = async () => true;
  await expect(changeCloudMachine(host, 'start', 'RES', 'capacity', null, deps)).rejects.toThrow('audit unavailable');
  expect(calls).toBe(0);
  expect(idleStopEligible({ ...host, state: 'running' }, 2_000_000, true)).toBe(false);
});
