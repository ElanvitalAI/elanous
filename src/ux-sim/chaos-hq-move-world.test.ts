import { expect, test } from 'bun:test';
import { runChaosHqMoveWorld, runChaosHqMoveMatrix, type ChaosHqMoveKind } from './chaos-hq-move-world.js';

const expectedHost = { monkey: 'mshq', gorilla: 'node-b', kong: 'aws1' } as const;
for (const kind of ['monkey', 'gorilla', 'kong'] as const satisfies readonly ChaosHqMoveKind[]) {
  for (const repetition of [1, 2, 3] as const) {
    test(`A36 real hqArbiterCheck ${kind}-${repetition} preserves tasks and one writer`, () => {
      const row = runChaosHqMoveWorld(kind, repetition, { approveKong: () => true });
      expect(row.scenario).toBe(`${kind}-${repetition}`);
      expect(row.selectedHost).toBe(expectedHost[kind]);
      expect(row.lostTasks).toBe(0);
      expect(row.realMachineStops).toBe(0);
      expect(row.runbookDelta).not.toBe('');
      expect(row.events.some(event => event.startsWith('arbiter-entry:'))).toBe(true);
      expect(row.recoveryMs).toBe(kind === 'monkey' ? (repetition + 1) * 15_000 + 1_000
        : (repetition === 2 ? 1_800_000 : 1_200_000) + 1_000);
      expect(row.recoveredAt).toBe(row.faultAt + row.recoveryMs);
      expect(row.tasks.map(task => task.id).sort()).toEqual(['task-01', 'task-02', 'task-03']);
      expect(row.tasks.every(task => task.state === 'done' && task.worker && task.completedAt !== undefined)).toBe(true);
      expect(row.failedPids).not.toEqual([]);
      expect(row.resumedPids.some(pid => row.failedPids.includes(pid))).toBe(false);
      expect(row.events.some(event => event.startsWith('fault-observed:'))).toBe(true);
      if (kind === 'monkey') {
        expect(row.events.some(event => event.startsWith('restart-observed:'))).toBe(true);
        expect(row.events).toContain('old-pid-ack:rejected-after-reassignment');
        expect(row.events.some(event => event.startsWith('replacement-claim:accepted:'))).toBe(true);
      }
      expect(row.manualInterventions).toBe(kind === 'kong' ? 1 : 0);
      if (kind !== 'monkey') {
        expect(row.events.filter(event => event.startsWith('candidate-heartbeat:'))).toHaveLength(2);
        expect(row.generation).toBe(8);
        expect(row.oldHolderFenced).toBe(true);
        if (repetition === 2) expect(row.staleObservationHeld).toBe(true);
        if (repetition === 3) expect(row.events).toContain('returned-workers:task-ack-fenced');
      }
    });
  }
}

test('A36 refuses an undeclared drill variant', () => {
  expect(() => runChaosHqMoveWorld('gorilla', 4 as 1)).toThrow('unknown HQ chaos scenario');
});

test('Kong cannot promote without one explicit virtual HITL approval', () => {
  let taps = 0;
  expect(() => runChaosHqMoveWorld('kong', 1)).toThrow('requires one explicit virtual HITL approval');
  expect(() => runChaosHqMoveWorld('kong', 1, { approveKong: () => { taps++; return false; } }))
    .toThrow('requires one explicit virtual HITL approval');
  expect(taps).toBe(1);
  expect(runChaosHqMoveWorld('kong', 1, { approveKong: () => { taps++; return true; } }).manualInterventions).toBe(1);
  expect(taps).toBe(2);
});


test('Monkey recovery follows observed restart timing and cannot pass a denied restart', () => {
  const early = runChaosHqMoveWorld('monkey', 1, { restartAfterTicks: 1 });
  const late = runChaosHqMoveWorld('monkey', 1, { restartAfterTicks: 5 });
  expect(late.recoveryMs - early.recoveryMs).toBe(4 * 15_000);
  const denied = runChaosHqMoveWorld('monkey', 1, { restartAllowed: false });
  expect(denied.lostTasks).toBe(1);
  expect(denied.recoveredAt).toBeNull();
  expect(denied.tasks.find(task => task.id === 'task-01')?.state).toBe('pending');
  expect(denied.events.some(event => event.startsWith('restart-observed:'))).toBe(false);
  expect(denied.events).toContain('replacement-claim:failed');
  expect(denied.events).not.toContain('old-pid-ack:rejected-after-reassignment');
});

test('independent submitted TASK IDs detect real durable queue loss across all nine cases', () => {
  const rows = runChaosHqMoveMatrix({ approveKong: () => true, dropTask: 'task-01' });
  expect(rows).toHaveLength(9);
  for (const row of rows) {
    expect(row.tasks.some(task => task.id === 'task-01')).toBe(false);
    expect(row.lostTasks).toBe(1);
    expect(row.recoveredAt).toBeNull();
  }
});


test('live replacement whose claim is denied cannot emit successful reassignment or stale-ACK evidence', () => {
  for (const repetition of [1, 2, 3] as const) {
    const row = runChaosHqMoveWorld('monkey', repetition, { replacementClaimAllowed: false });
    expect(row.events.some(event => event.startsWith('restart-observed:'))).toBe(true);
    expect(row.events).toContain('replacement-claim:failed');
    expect(row.events.some(event => event.startsWith('replacement-claim:accepted:'))).toBe(false);
    expect(row.events).not.toContain('old-pid-ack:rejected-after-reassignment');
    expect(row.lostTasks).toBe(1);
    expect(row.recoveredAt).toBeNull();
    expect(row.tasks.find(task => task.id === `task-0${repetition}`)?.state).toBe('pending');
  }
});


for (const kind of ['gorilla', 'kong'] as const) {
  test(`${kind} returned worker has valid PID/assignment and ACK outcome depends on fence alone`, () => {
    const row = runChaosHqMoveWorld(kind, 3, { approveKong: () => true });
    const proof = row.returnedWorkerFenceProof!;
    expect(proof).toBeDefined();
    expect(proof.live).toBe(true);
    expect(proof.caller).toEqual(proof.assignment);
    expect(proof.deniedAck).toBe(false);
    expect(proof.permittedAck).toBe(true);
    expect(proof.stateAfterDenied).toBe('running');
    expect(proof.stateAfterPermitted).toBe('done');
    // The allowed control completes a fork, while the real TASK is resumed by the new holder.
    expect(row.tasks.find(task => task.id === proof.taskId)?.worker?.host).toBe(expectedHost[kind]);
    expect(row.tasks.find(task => task.id === proof.taskId)?.worker?.generation).toBe(row.generation);
    expect(row.lostTasks).toBe(0);
    const unavailable = runChaosHqMoveWorld(kind, 3, { approveKong: () => true, restartAllowed: false });
    expect(unavailable.returnedWorkerFenceProof).toBeUndefined();
    expect(unavailable.events).not.toContain('returned-workers:task-ack-fenced');
    expect(unavailable.events).toContain('returned-workers:fence-proof-unavailable');
  });
}
