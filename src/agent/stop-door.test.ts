import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { judgeStop } from './stop-door.js';
import { dispatchAgentStop } from './agent-stop-tool.js';
import { AgentRegistry } from './registry.js';
import { runShell } from '../shell-runner/dispatch.js';
import { dispatchShellKill } from '../skills/tools/shell-runner.js';
import { stopDetachedShellCapsule, stopDetachedShellCapsuleOutcome } from '../turn-capsule/shell-capsule.js';

setDefaultTimeout(10000);
// STOP-DOOR-ONE — literals are independent of the product constants.
describe('judgeStop (pure verdict)', () => {
  test('live target owned by the requester may be stopped', () => {
    expect(judgeStop({ kind: 'agent', id: 'a1', exists: true, ended: false, owner: 's1', requester: 's1', reason: 'user' }))
      .toEqual({ kind: 'agent', id: 'a1', stopped: true, alreadyEnded: false, reason: 'user' });
  });
  test('already ended is not stopped and not refused', () => {
    expect(judgeStop({ kind: 'shell', id: 'x', exists: true, ended: true }))
      .toEqual({ kind: 'shell', id: 'x', stopped: false, alreadyEnded: true });
  });
  test('unknown id is refused not-found', () => {
    expect(judgeStop({ kind: 'task', id: 'nope', exists: false, ended: false }).refused).toBe('not-found');
  });
  test('empty id is refused missing-id', () => {
    expect(judgeStop({ kind: 'task', id: '', exists: true, ended: false }).refused).toBe('missing-id');
  });
  test("another session's target is refused not-owner and never stopped", () => {
    const v = judgeStop({ kind: 'agent', id: 'a1', exists: true, ended: false, owner: 's1', requester: 's2' });
    expect(v.refused).toBe('not-owner');
    expect(v.stopped).toBe(false);
  });
  test('owner known but requester unknown fails closed', () => {
    const v = judgeStop({ kind: 'agent', id: 'a1', exists: true, ended: false, owner: 's1' });
    expect(v.refused).toBe('requester-unknown');
    expect(v.stopped).toBe(false);
  });
  test('refusal wins over alreadyEnded (no state leak to a stranger)', () => {
    const v = judgeStop({ kind: 'agent', id: 'a1', exists: true, ended: true, owner: 's1', requester: 's2' });
    expect(v.refused).toBe('not-owner');
    expect(v.alreadyEnded).toBe(false);
  });
});

describe('the four doors answer the same shape for the same boundary', () => {
  test('unknown id: AgentStop · ShellKill · capsule all refuse not-found', async () => {
    const a = await dispatchAgentStop({ taskId: 'ghost' }, { registry: new AgentRegistry() });
    const s = await dispatchShellKill({ id: 'ghost' }, { get: () => undefined } as never);
    const c = stopDetachedShellCapsuleOutcome('ghost');
    for (const v of [a.stop, s.stop, c]) {
      expect(v?.stopped).toBe(false);
      expect(v?.refused).toBe('not-found');
    }
    expect(stopDetachedShellCapsule('ghost')).toBe(false);
  });
  test('ended shell handle is not signalled again and reads alreadyEnded', async () => {
    let kills = 0;
    const handle = { id: 'sh1', status: 'completed', kill: () => { kills += 1; } };
    const r = await dispatchShellKill({ id: 'sh1' }, { get: () => handle } as never);
    expect(kills).toBe(0);
    expect(r.stop).toMatchObject({ stopped: false, alreadyEnded: true });
  });
  test('live shell handle is signalled once and reads stopped', async () => {
    let kills = 0;
    const handle = { id: 'sh2', status: 'running', kill: () => { kills += 1; } };
    const r = await dispatchShellKill({ id: 'sh2' }, { get: () => handle } as never);
    expect(kills).toBe(1);
    expect(r.stop).toMatchObject({ stopped: true, alreadyEnded: false });
  });
});

test('AgentStop rejects a foreign session before any registry abort', async () => {
  const registry = new AgentRegistry();
  const task = { state: 'running', parentSessionId: 'other-session' } as NonNullable<ReturnType<AgentRegistry['get']>>;
  registry.get = () => task;
  let aborts = 0;
  registry.abort = () => { aborts += 1; return true; };
  registry.abortCascade = () => { aborts += 1; return { self: true, descendants: 1 }; };

  for (const cascade of [false, true]) {
    const deps = { registry, requester: 'requesting-session' };
    const result = await dispatchAgentStop({ taskId: 'foreign-task', cascade }, deps);
    expect(result.stop).toMatchObject({ stopped: false, refused: 'not-owner' });
  }
  expect(aborts).toBe(0);
});

test('ShellKill returns structured failure when the handle throws', async () => {
  let kills = 0;
  const handle = { id: 'throwing', status: 'running', kill() { kills += 1; throw new Error('fixture failure'); } };
  const result = await dispatchShellKill({ id: handle.id }, { get: () => handle } as never);
  expect(kills).toBe(1);
  expect(result.stop).toMatchObject({ stopped: false, alreadyEnded: false, failed: 'signal-failed' });
});

test('ShellKill checks the session stamped at launch before contacting the handle', async () => {
  let kills = 0;
  const handle = { id: 'owned-shell', status: 'running', kill: () => { kills += 1; } };
  const registry = { register() {}, get: () => handle } as never;
  runShell({ command: ['fixture'], mode: 'bg' }, {
    registry, fileEngine: { run: () => handle } as never,
  }, { ownerSessionId: 'owner' });

  expect((await dispatchShellKill({ id: handle.id }, registry, 'other')).stop)
    .toMatchObject({ stopped: false, refused: 'not-owner' });
  expect((await dispatchShellKill({ id: handle.id }, registry)).stop)
    .toMatchObject({ stopped: false, refused: 'requester-unknown' });
  expect(kills).toBe(0);
  expect((await dispatchShellKill({ id: handle.id }, registry, 'owner')).stop?.stopped).toBe(true);
  expect(kills).toBe(1);
});
