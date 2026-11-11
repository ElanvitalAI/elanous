import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResourceLedger } from '../../src/control-plane/ledger.js';
import { activeReleaseCloudDeadline, decideGraphApproval, realRunBash, runGraph } from '../../src/graph-runner/runner.js';
import type { WorkflowDeps } from '../../src/workflow-runtime/types.js';
import { freshMonthlySpendSnapshot, inputFromReleaseContext, processIsAlive, runCloudElasticToolNode } from './cloud-elastic-node.js';

const now = Date.parse('2026-11-06T00:00:00Z');
const request = { id: 'request-1', event: 'gate-host-outage', purpose: 'gate', provider: 'gcp', hostType: 'n2-highmem-8', host: 'gcp1', expectedHours: 2, hourlyCostKrw: 120_000 };
const cutoffNodeOutput = () => ({ exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', version: '9.9.9', commit: 'a'.repeat(40),
  cutoff: { sha: 'a'.repeat(40) }, candidatePath: 'fixture:cloud-elastic' }), stderr: '' });
const joinNode = (value: typeof request, deps: Parameters<typeof runCloudElasticToolNode>[2] = {}) =>
  runCloudElasticToolNode('join', { ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify(value) }, { initialMonthlySpendKrw: 0,
    trustedHourlyRateKrw: (candidate) => candidate.hourlyCostKrw, ...deps, approvalVerified: true });

describe('release-loop cloud elastic recipe node', () => {
  // Source: .rules/30-harness/testing-gates.md — remote ownership expires only after same-namespace death proof.
  test('remote owner liveness is released only by a same-namespace death proof', () => {
    const owner = { joinInFlight: true, joinOwnerHost: 'remote-owner', joinOwnerPid: 42,
      joinOwnerPidNamespace: 'pid:[123]', joinOwnerExpiresAt: 0 };
    expect(processIsAlive(owner, 'join', (_host, _pid, namespace) => namespace === 'pid:[123]' ? false : undefined)).toBe(false);
    expect(processIsAlive(owner, 'join', () => true)).toBe(true);
    expect(processIsAlive(owner, 'join', () => undefined)).toBe(true);
    expect(processIsAlive({ ...owner, joinOwnerPidNamespace: undefined }, 'join', () => false)).toBe(true);
    expect(processIsAlive({ joinInFlight: true }, 'join', () => false)).toBe(true);
  });

  test('does not reuse a completed cloud lease deadline on a later gate retry', () => {
    const deadlineAt = now + 60_000;
    expect(activeReleaseCloudDeadline([
      { nodeId: 'cloud-join', ok: true, output: JSON.stringify({ deadlineAt }) },
      { nodeId: 'gate', ok: false },
      { nodeId: 'cloud-leave-ok', ok: true },
    ])).toBeUndefined();
    expect(activeReleaseCloudDeadline([
      { nodeId: 'cloud-join', ok: true, output: JSON.stringify({ deadlineAt }) },
      { nodeId: 'cloud-leave-fail', ok: false },
    ])).toBe(deadlineAt);
  });
  // Source: .rules/30-harness/testing-gates.md — spend snapshot freshness bounds keep approval decisions current.
  test('monthly spend baseline requires a nonnegative, nonfuture snapshot no older than 24 hours', () => {
    const measuredAt = new Date(now).toISOString();
    const snapshot = { spendKrw: 12_000, measuredAt };
    expect(freshMonthlySpendSnapshot(snapshot, now)).toEqual(snapshot);
    expect(freshMonthlySpendSnapshot({ ...snapshot, spendKrw: -1 }, now)).toBeUndefined();
    expect(freshMonthlySpendSnapshot({ ...snapshot, measuredAt: new Date(now + 1).toISOString() }, now)).toBeUndefined();
    expect(freshMonthlySpendSnapshot({ ...snapshot, measuredAt: new Date(now - 24 * 60 * 60_000 - 1).toISOString() }, now)).toBeUndefined();
    expect(freshMonthlySpendSnapshot({ ...snapshot, measuredAt: '2026-10-31T23:55:00.000Z' }, Date.parse('2026-11-01T00:05:00.000Z'))).toBeUndefined();
  });

  // Source: .rules/30-harness/testing-gates.md — completed leave cost predating the snapshot must not be charged twice.
  test('does not add leave costs already included in the measured monthly spend snapshot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-snapshot-delta-'));
    try {
      const ledger = new ResourceLedger(root);
      const leaveAt = now - 5_000;
      ledger.register({ id: 'release-loop-cloud-elastic:old-leave', kind: 'universe', machine: 'nexus',
        name: 'release-loop.cloud-elastic/leave', owner: 'RLA', attrs: { id: 'already-counted', type: 'leave',
          eventType: 'leave', recordType: 'release-loop-cloud-elastic-event', costKrw: 2_500_000 },
        observedAt: leaveAt, ttlMs: 90 * 24 * 60 * 60_000 }, 'RLA');
      const result = await joinNode({ ...request, hourlyCostKrw: 1_250_000, expectedHours: 2 }, {
        ledger, now: () => now, initialMonthlySpendKrw: 2_500_000, monthlySpendMeasuredAt: leaveAt + 1,
        runHandTool: async (operation) => ({ exitCode: operation === 'join' ? 0 : 0 }),
      });
      expect(result.outcome).toBe('ok');
      expect(result.summary).toContain('joined');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('approves, budget-checks, joins through the hand tool, and leaves with a Nexus cost event', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-node-'));
    try {
      const ledger = new ResourceLedger(root); const calls: string[] = [];
      let current = now;
      const join = await joinNode(request, { ledger, now: () => current, runHandTool: async (op, host) => { calls.push(`${op}:${host}`); return { exitCode: 0 }; } });
      current += 30 * 60_000;
      const leave = await runCloudElasticToolNode('leave', { ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify(request) }, {
        ledger, now: () => current, runHandTool: async (op, host) => { calls.push(`${op}:${host}`); return { exitCode: 0 }; },
      });
      expect(join).toMatchObject({ outcome: 'ok' });
      expect(leave).toMatchObject({ outcome: 'ok' });
      expect(calls).toEqual(['join:gcp1', 'leave:gcp1']);
      const events = ledger.list({ kind: 'universe' }).filter((row) => row.attrs.recordType === 'release-loop-cloud-elastic-event');
      expect(events.map((row) => row.attrs.eventType)).toEqual(['request', 'start', 'join', 'leave']);
      expect(events.at(-1)?.attrs.costKrw).toBe(60_000);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('requires OP approval and rejects a monthly over-cap request without running a hand tool', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-deny-'));
    try {
      const ledger = new ResourceLedger(root); let calls = 0;
      const runHandTool = async () => { calls++; return { exitCode: 0 }; };
      const denied = await runCloudElasticToolNode('join', { ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify(request) }, { ledger, now: () => now, runHandTool });
      expect(denied.outcome).toBe('fail');
      expect(denied.summary).toContain('measured monthly cloud spend is unavailable');
      const forged = await runCloudElasticToolNode('join', { ELANOUS_CLOUD_APPROVED: '1', ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify(request) }, { ledger, now: () => now, runHandTool });
      expect(forged.summary).toContain('measured monthly cloud spend is unavailable');
      const overCap = await joinNode({ ...request, expectedHours: 50 },
        { ledger, now: () => now, runHandTool, monthlyCapKrw: 5_000_000, initialMonthlySpendKrw: 1 });
      expect(overCap.outcome).toBe('fail');
      expect(calls).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a host with a starting session cannot accept a second request, even with a different request ID', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-host-occupied-'));
    try {
      const ledger = new ResourceLedger(root);
      ledger.register({ id: 'release-loop-cloud-elastic:session:already-starting', kind: 'universe', machine: request.host,
        name: 'release-loop.cloud-elastic/session', owner: 'RLA', attrs: { requestId: 'already-starting', host: request.host,
          status: 'starting', hourlyCostKrw: request.hourlyCostKrw, startAt: now, reservedKrw: 10 }, observedAt: now, ttlMs: Number.MAX_SAFE_INTEGER }, 'RLA');
      let calls = 0;
      const result = await joinNode({ ...request, id: 'different-id' }, { ledger, now: () => now, runHandTool: async () => { calls++; return { exitCode: 0 }; } });
      expect(result.outcome).toBe('fail');
      expect(result.summary).toContain('already has active request already-starting');
      expect(calls).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a duplicate request from another graph run cannot clean up the first run\'s active VM', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-run-owner-'));
    try {
      const ledger = new ResourceLedger(root); const calls: string[] = [];
      const runHandTool = async (op: 'join' | 'leave', host: string) => { calls.push(`${op}:${host}`); return { exitCode: 0 }; };
      const first = await runCloudElasticToolNode('join', {
        ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify(request), ELANOUS_CLOUD_GRAPH_RUN_ID: 'first-run',
      }, { ledger, now: () => now, initialMonthlySpendKrw: 0, approvalVerified: true,
        trustedHourlyRateKrw: (candidate) => candidate.hourlyCostKrw, runHandTool });
      const duplicate = await runCloudElasticToolNode('join', {
        ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify(request), ELANOUS_CLOUD_GRAPH_RUN_ID: 'second-run',
      }, { ledger, now: () => now + 1, initialMonthlySpendKrw: 0, approvalVerified: true,
        trustedHourlyRateKrw: (candidate) => candidate.hourlyCostKrw, runHandTool });
      const unsafeCleanup = await runCloudElasticToolNode('leave', {
        ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify(request), ELANOUS_CLOUD_GRAPH_RUN_ID: 'second-run',
      }, { ledger, now: () => now + 2, runHandTool });
      const session = ledger.list({ kind: 'universe' }).find(row => row.id === 'release-loop-cloud-elastic:session:request-1');
      expect(first.outcome).toBe('ok');
      expect(duplicate.outcome).toBe('fail');
      expect(unsafeCleanup.summary).toContain('belongs to another graph run');
      expect(session?.attrs).toMatchObject({ status: 'joined', graphRunId: 'first-run' });
      expect(calls).toEqual(['join:gcp1']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a starting session left by process death can be explicitly cleaned up', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-starting-cleanup-'));
    try {
      const ledger = new ResourceLedger(root); const calls: string[] = [];
      ledger.register({ id: 'release-loop-cloud-elastic:session:request-1', kind: 'universe', machine: request.host,
        name: 'release-loop.cloud-elastic/session', owner: 'RLA', attrs: { requestId: request.id, host: request.host,
          provider: request.provider, status: 'starting', joinInFlight: true, joinToken: 'dead-join-token',
          joinOwnerHost: hostname(), joinOwnerPid: Number.MAX_SAFE_INTEGER,
          hourlyCostKrw: request.hourlyCostKrw, startAt: now,
          reservedKrw: request.expectedHours * request.hourlyCostKrw }, observedAt: now, ttlMs: Number.MAX_SAFE_INTEGER }, 'RLA');
      const result = await runCloudElasticToolNode('leave', { ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify(request) }, {
        ledger, now: () => now + 60_000, runHandTool: async (op, host) => { calls.push(`${op}:${host}`); return { exitCode: 0 }; },
      });
      expect(result.outcome).toBe('ok');
      expect(calls).toEqual([`leave:${request.host}`]);
      expect(ledger.list({ kind: 'universe' }).find(row => row.id === 'release-loop-cloud-elastic:session:request-1')?.attrs.status).toBe('left');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Source: .rules/30-harness/testing-gates.md — failed stop keeps the live join owner until its own compensation completes.
  test('a failed early leave preserves the active join owner for its later compensation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-early-leave-fail-'));
    try {
      const ledger = new ResourceLedger(root); const calls: string[] = []; const joinToken = 'live-join-token';
      ledger.register({ id: 'release-loop-cloud-elastic:session:request-1', kind: 'universe', machine: request.host,
        name: 'release-loop.cloud-elastic/session', owner: 'RLA', attrs: { requestId: request.id, host: request.host,
          provider: request.provider, hourlyCostKrw: request.hourlyCostKrw, startAt: now, status: 'starting',
          joinInFlight: true, joinToken, joinOwnerHost: hostname(), joinOwnerPid: process.pid,
          reservedKrw: request.expectedHours * request.hourlyCostKrw }, observedAt: now, ttlMs: Number.MAX_SAFE_INTEGER }, 'RLA');
      const earlyLeave = await runCloudElasticToolNode('leave', { ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify(request) }, {
        ledger, now: () => now + 1_000, runHandTool: async operation => { calls.push(operation); return { exitCode: 1, stderr: 'still starting' }; },
      });
      const pending = ledger.list({ kind: 'universe' }).find(row => row.id === 'release-loop-cloud-elastic:session:request-1');
      expect(earlyLeave.outcome).toBe('fail');
      expect(pending?.attrs).toMatchObject({ status: 'orphaned', joinInFlight: true, joinToken, joinOwnerPid: process.pid });
      const compensation = await runCloudElasticToolNode('leave', { ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify(request) }, {
        ledger, now: () => now + 2_000, authorizedJoinToken: joinToken,
        runHandTool: async operation => { calls.push(operation); return { exitCode: 0 }; },
      });
      const stopped = ledger.list({ kind: 'universe' }).find(row => row.id === 'release-loop-cloud-elastic:session:request-1');
      expect(compensation.outcome).toBe('ok');
      expect(stopped?.attrs.status).toBe('left');
      expect(calls).toEqual(['leave', 'leave']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('all graph cleanup outcomes allow leave and stop the owned VM', async () => {
    for (const nodeId of ['cloud-leave-ok', 'cloud-leave-fail', 'cloud-leave-error', 'cloud-leave-join-fail']) {
      const root = mkdtempSync(join(tmpdir(), `cloud-elastic-${nodeId}-`));
      try {
        const ledger = new ResourceLedger(root); const calls: string[] = [];
        ledger.register({ id: `release-loop-cloud-elastic:session:${request.id}`, kind: 'universe', machine: request.host,
          name: 'release-loop.cloud-elastic/session', owner: 'RLA', attrs: { requestId: request.id, host: request.host,
            provider: request.provider, hourlyCostKrw: request.hourlyCostKrw, status: 'joined', startAt: now,
            graphRunId: 'run-1', reservedKrw: request.expectedHours * request.hourlyCostKrw }, observedAt: now, ttlMs: Number.MAX_SAFE_INTEGER }, 'RLA');
        const context = { graphId: 'release-loop', runId: 'run-1', nodeId, input: { version: '9.9.9', previousVersion: '0.2.3', cloudElastic: { request } }, outputs: {} };
        const input = inputFromReleaseContext('leave', { ELANOUS_GRAPH_CONTEXT: JSON.stringify(context) });
        const result = await runCloudElasticToolNode('leave', { ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify(input.request), ELANOUS_CLOUD_GRAPH_RUN_ID: input.runId }, {
          ledger, now: () => now + 60_000, runHandTool: async (operation, host) => { calls.push(`${operation}:${host}`); return { exitCode: 0 }; },
        });
        expect(input.nodeId).toBe(nodeId);
        expect(result.outcome).toBe('ok');
        expect(calls).toEqual([`leave:${request.host}`]);
      } finally { rmSync(root, { recursive: true, force: true }); }
    }
  });

  test('refuses a request whose stated price is below the trusted rate before provisioning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-rate-mismatch-'));
    try {
      const ledger = new ResourceLedger(root); let calls = 0;
      const result = await runCloudElasticToolNode('join', { ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify({ ...request, hourlyCostKrw: 1 }) }, {
        ledger, initialMonthlySpendKrw: 0, approvalVerified: true, trustedHourlyRateKrw: () => request.hourlyCostKrw,
        runHandTool: async () => { calls++; return { exitCode: 0 }; },
      });
      expect(result.outcome).toBe('fail');
      expect(result.summary).toContain('trusted host/provider/hostType rate');
      expect(calls).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('reserves the approved estimate before starting a VM so a concurrent request cannot overbook the cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-reserve-'));
    try {
      const ledger = new ResourceLedger(root); let calls = 0;
      const runHandTool = async () => { calls++; return { exitCode: 0 }; };
      const first = await joinNode({ ...request, hourlyCostKrw: 2_400_000, expectedHours: 2 }, { ledger, now: () => now, runHandTool });
      const second = await joinNode({ ...request, id: 'request-2', host: 'gcp2' }, { ledger, now: () => now, runHandTool });
      expect(first.outcome).toBe('ok');
      expect(second.outcome).toBe('fail');
      expect(second.summary).toContain('monthly cap');
      expect(calls).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('atomically reserves a concurrent request before either provider operation returns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-race-'));
    try {
      const firstLedger = new ResourceLedger(root); const secondLedger = new ResourceLedger(root);
      let started!: () => void; const joined = new Promise<void>(resolve => { started = resolve; });
      let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; });
      const requestA = { ...request, id: 'race-a', hourlyCostKrw: 2_000_000, expectedHours: 2 };
      const requestB = { ...request, id: 'race-b', host: 'gcp2', hourlyCostKrw: 1_000_000, expectedHours: 2 };
      const first = joinNode(requestA, { ledger: firstLedger, now: () => now, runHandTool: async () => { started(); await hold; return { exitCode: 0 }; } });
      await joined;
      const second = await joinNode(requestB, { ledger: secondLedger, now: () => now, runHandTool: async () => ({ exitCode: 0 }) });
      release(); await first;
      expect(second.outcome).toBe('fail');
      expect(second.summary).toContain('monthly cap');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Source: .rules/30-harness/testing-gates.md — a late provider join must not overwrite a completed stop transition.
  test('a leave racing a starting join remains stopped when the late join succeeds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-late-join-'));
    try {
      const ledger = new ResourceLedger(root);
      let signalJoin!: () => void; const joinEntered = new Promise<void>(resolve => { signalJoin = resolve; });
      let finishJoin!: () => void; const joinHold = new Promise<void>(resolve => { finishJoin = resolve; });
      const calls: string[] = [];
      const runJoin = joinNode(request, { ledger, now: () => now, runHandTool: async (operation) => {
        calls.push(operation); signalJoin(); await joinHold; return { exitCode: 0 };
      } });
      await joinEntered;
      const leave = await runCloudElasticToolNode('leave', { ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify(request),
        ELANOUS_CLOUD_GRAPH_RUN_ID: undefined }, { ledger, now: () => now + 1_000,
        runHandTool: async (operation) => { calls.push(operation); return { exitCode: 0 }; } });
      finishJoin();
      const join = await runJoin;
      const session = ledger.list({ kind: 'universe' }).find(row => row.id === 'release-loop-cloud-elastic:session:request-1');
      expect(leave.outcome).toBe('ok');
      expect(join.outcome).toBe('fail');
      expect(session?.attrs.status).toBe('left');
      expect(calls).toEqual(['join', 'leave', 'leave']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Source: .rules/30-harness/testing-gates.md — failed compensation after a late join must retain orphan liability.
  // Source: .rules/30-harness/testing-gates.md - an early leave must retain host occupancy until the join settles.
  test('a successful leave cannot free a host while its join is still pending', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-pending-leave-host-'));
    try {
      const ledger = new ResourceLedger(root);
      let signalJoin!: () => void; const joinEntered = new Promise<void>(resolve => { signalJoin = resolve; });
      let finishJoin!: () => void; const joinHold = new Promise<void>(resolve => { finishJoin = resolve; });
      let signalLeave!: () => void; const leaveEntered = new Promise<void>(resolve => { signalLeave = resolve; });
      let finishLeave!: () => void; const leaveHold = new Promise<void>(resolve => { finishLeave = resolve; });
      const calls: string[] = [];
      const runJoin = joinNode(request, { ledger, now: () => now, runHandTool: async operation => {
        calls.push(operation);
        if (operation === 'join') { signalJoin(); await joinHold; return { exitCode: 0 }; }
        return { exitCode: 0 };
      } });
      await joinEntered;
      const runLeave = runCloudElasticToolNode('leave', { ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify(request) }, {
        ledger, now: () => now + 1_000, runHandTool: async operation => {
          calls.push(operation); signalLeave(); await leaveHold; return { exitCode: 0 };
        },
      });
      await leaveEntered;
      const blockedDuringLeave = await joinNode({ ...request, id: 'request-during-leave' }, { ledger, now: () => now + 2_000,
        runHandTool: async () => { throw new Error('occupied host must not be reused'); } });
      finishLeave();
      await runLeave;
      const blockedAfterEarlyLeave = await joinNode({ ...request, id: 'request-after-early-leave' }, { ledger, now: () => now + 3_000,
        runHandTool: async () => { throw new Error('pending join still owns host'); } });
      finishJoin();
      const lateJoin = await runJoin;
      const session = ledger.list({ kind: 'universe' }).find(row => row.id === 'release-loop-cloud-elastic:session:request-1');
      expect(blockedDuringLeave.summary).toContain('already has active request request-1 (stopping)');
      expect(blockedAfterEarlyLeave.summary).toContain('already has active request request-1 (stopping)');
      expect(lateJoin.outcome).toBe('fail');
      expect(session?.attrs.status).toBe('left');
      expect(calls).toEqual(['join', 'leave', 'leave']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Source: .rules/30-harness/testing-gates.md — an interrupted cloud stop keeps a durable owner until it settles.
  test('serializes concurrent leave calls so a late stop cannot affect a later host allocation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-concurrent-leave-'));
    try {
      const ledger = new ResourceLedger(root); const calls: string[] = [];
      ledger.register({ id: 'release-loop-cloud-elastic:session:request-1', kind: 'universe', machine: request.host,
        name: 'release-loop.cloud-elastic/session', owner: 'RLA', attrs: { requestId: request.id, host: request.host,
          provider: request.provider, hourlyCostKrw: request.hourlyCostKrw, startAt: now, status: 'joined',
          graphRunId: 'run-1', reservedKrw: request.expectedHours * request.hourlyCostKrw }, observedAt: now,
        ttlMs: Number.MAX_SAFE_INTEGER }, 'RLA');
      let signalLeave!: () => void; const leaveEntered = new Promise<void>(resolve => { signalLeave = resolve; });
      let finishLeave!: () => void; const leaveHold = new Promise<void>(resolve => { finishLeave = resolve; });
      const firstLeave = runCloudElasticToolNode('leave', { ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify(request),
        ELANOUS_CLOUD_GRAPH_RUN_ID: 'run-1' }, { ledger, now: () => now + 1_000,
        runHandTool: async operation => { calls.push(operation); signalLeave(); await leaveHold; return { exitCode: 0 }; } });
      await leaveEntered;
      const secondLeave = await runCloudElasticToolNode('leave', { ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify(request),
        ELANOUS_CLOUD_GRAPH_RUN_ID: 'run-1' }, { ledger, now: () => now + 2_000,
        runHandTool: async operation => { calls.push(operation); return { exitCode: 0 }; } });
      expect(secondLeave.outcome).toBe('fail');
      expect(secondLeave.summary).toContain('another leave operation owns this session');
      expect(calls).toEqual(['leave']);
      finishLeave();
      const firstResult = await firstLeave;
      const session = ledger.list({ kind: 'universe' }).find(row => row.id === 'release-loop-cloud-elastic:session:request-1');
      expect(firstResult.outcome).toBe('ok');
      expect(session?.attrs.status).toBe('left');
      expect(calls).toEqual(['leave']);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // Source: .rules/30-harness/testing-gates.md - failed compensation must restore liability over a racing left receipt.
  test('failed join cleanup restores orphan liability after a concurrent left receipt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-failed-cleanup-left-race-'));
    try {
      const ledger = new ResourceLedger(root);
      const result = await joinNode(request, { ledger, now: () => now, runHandTool: async operation => {
        if (operation === 'join') {
          ledger.register({ id: 'release-loop-cloud-elastic:session:request-1', kind: 'universe', machine: request.host,
            name: 'release-loop.cloud-elastic/session', owner: 'RLA',
            attrs: { type: 'release-loop-cloud-elastic-session', requestId: request.id, host: request.host,
              provider: request.provider, hourlyCostKrw: request.hourlyCostKrw, startAt: now, status: 'left', reservedKrw: 0 },
            observedAt: now + 500, ttlMs: Number.MAX_SAFE_INTEGER }, 'RLA');
          return { exitCode: 1, stderr: 'join timed out' };
        }
        return { exitCode: 1, stderr: 'compensating leave failed' };
      } });
      const session = ledger.list({ kind: 'universe' }).find(row => row.id === 'release-loop-cloud-elastic:session:request-1');
      expect(result.outcome).toBe('fail');
      expect(session?.attrs.status).toBe('orphaned');
      expect(session?.attrs.reservedKrw).toBe(request.expectedHours * request.hourlyCostKrw);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a late join whose compensating leave fails restores orphan liability after an earlier left receipt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-late-join-orphan-'));
    try {
      const ledger = new ResourceLedger(root);
      let signalJoin!: () => void; const joinEntered = new Promise<void>(resolve => { signalJoin = resolve; });
      let finishJoin!: () => void; const joinHold = new Promise<void>(resolve => { finishJoin = resolve; });
      const calls: string[] = [];
      const runJoin = joinNode(request, { ledger, now: () => now, runHandTool: async operation => {
        calls.push(operation);
        if (operation === 'join') { signalJoin(); await joinHold; return { exitCode: 0 }; }
        return { exitCode: 1, stderr: 'compensation leave failed' };
      } });
      await joinEntered;
      const leave = await runCloudElasticToolNode('leave', { ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify(request) }, {
        ledger, now: () => now + 1_000, runHandTool: async operation => { calls.push(operation); return { exitCode: 0 }; },
      });
      finishJoin();
      const join = await runJoin;
      const session = ledger.list({ kind: 'universe' }).find(row => row.id === 'release-loop-cloud-elastic:session:request-1');
      expect(leave.outcome).toBe('ok');
      expect(join.outcome).toBe('fail');
      expect(session?.attrs.status).toBe('orphaned');
      expect(session?.attrs.reservedKrw).toBe(request.expectedHours * request.hourlyCostKrw);
      expect(calls).toEqual(['join', 'leave', 'leave']);
      const retry = await joinNode({ ...request, id: 'retry-same-host' }, { ledger, now: () => now + 2_000,
        runHandTool: async () => { throw new Error('orphaned host must not be reused'); } });
      expect(retry.outcome).toBe('fail');
      expect(retry.summary).toContain('already has active request request-1 (orphaned)');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('an active reservation from the prior month still counts against the new month cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-month-boundary-'));
    try {
      const ledger = new ResourceLedger(root); const beforeMonth = Date.parse('2026-10-31T23:30:00Z'); const afterMonth = Date.parse('2026-11-01T00:05:00Z');
      const active = await joinNode({ ...request, hourlyCostKrw: 2_400_000, expectedHours: 2 }, { ledger, now: () => beforeMonth, runHandTool: async () => ({ exitCode: 0 }) });
      const next = await joinNode({ ...request, id: 'next-month', host: 'gcp2', hourlyCostKrw: 300_000, expectedHours: 2 }, { ledger, now: () => afterMonth, runHandTool: async () => ({ exitCode: 0 }) });
      expect(active.outcome).toBe('ok');
      expect(next.outcome).toBe('fail');
      expect(next.summary).toContain('monthly cap');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('leave failures record an orphan and join failures attempt safe leave', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-orphan-'));
    try {
      const ledger = new ResourceLedger(root); let calls: string[] = [];
      await joinNode(request, { ledger, now: () => now, runHandTool: async (op) => { calls.push(op); return { exitCode: op === 'join' ? 1 : 0 }; } });
      expect(calls).toEqual(['join', 'leave']);
      calls = [];
      await joinNode({ ...request, id: 'request-2' }, { ledger, now: () => now, runHandTool: async (op) => { calls.push(op); return { exitCode: 0 }; } });
      const result = await runCloudElasticToolNode('leave', { ELANOUS_CLOUD_REQUEST_JSON: JSON.stringify({ ...request, id: 'request-2' }) }, {
        ledger, now: () => now + 60_000, runHandTool: async () => ({ exitCode: 1, stderr: 'drain timeout' }),
      });
      expect(result.outcome).toBe('fail');
      expect(ledger.list({ kind: 'universe' }).some((row) => row.attrs.eventType === 'orphan' && row.attrs.id === 'request-2')).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a Nexus join-event write failure stops the joined VM before failing the recipe node', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-sink-cleanup-'));
    try {
      const ledger = new ResourceLedger(root); const calls: string[] = [];
      const register = ledger.register.bind(ledger);
      ledger.register = (record, owner) => {
        if (record.name === 'release-loop.cloud-elastic/join') throw new Error('Nexus unavailable');
        return register(record, owner);
      };
      const result = await joinNode(request, { ledger, now: () => now, runHandTool: async (op, host) => { calls.push(`${op}:${host}`); return { exitCode: 0 }; } });
      expect(result.outcome).toBe('fail');
      expect(calls).toEqual(['join:gcp1', 'leave:gcp1']);
      const session = ledger.list({ kind: 'universe' }).find((row) => row.id === 'release-loop-cloud-elastic:session:request-1');
      expect(session?.attrs).toMatchObject({ status: 'left', reservedKrw: 0 });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('the production release graph executes join before gate work and leave after it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cloud-elastic-graph-'));
    const previous = { path: process.env.PATH, state: process.env.ELANOUS_STATE_DIR, calls: process.env.ELANOUS_FAKE_CLOUD_LOG,
      rateTable: process.env.ELANOUS_CLOUD_RATE_TABLE, hostMap: process.env.ELANOUS_CLOUD_HOST_MAP };
    try {
      const stateDir = root; const ledger = new ResourceLedger(stateDir);
      const callsFile = join(root, 'cloud-calls.log'); const fakeBin = join(root, 'bin');
      const rateTable = join(root, 'cloud-rates.tsv'); const hostMap = join(root, 'cloud-vm-map.tsv');
      writeFileSync(rateTable, 'vm\tn2-highmem-8\tasia-northeast3\tlinux\t120\thour\ttest-fixture\t2026-11-10\nfx\tUSDKRW\t-\t-\t1000\tKRW\ttest-fixture\t2026-11-10\n');
      writeFileSync(hostMap, 'gcp1\tgcp\tfixture\tasia-northeast3-a\tn2-highmem-8\tlinux\t-\n');
      const requestInput = { request, monthlySpendSnapshot: { spendKrw: 0, measuredAt: new Date().toISOString() } };
      mkdirSync(fakeBin, { recursive: true });
      const fakeZsh = join(fakeBin, 'zsh');
      writeFileSync(fakeZsh, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ELANOUS_FAKE_CLOUD_LOG"\nexit 0\n'); chmodSync(fakeZsh, 0o755);
      process.env.PATH = `${fakeBin}:${previous.path ?? ''}`; process.env.ELANOUS_STATE_DIR = stateDir; process.env.ELANOUS_FAKE_CLOUD_LOG = callsFile;
      process.env.ELANOUS_CLOUD_RATE_TABLE = rateTable; process.env.ELANOUS_CLOUD_HOST_MAP = hostMap;
      let current = now;
      const graphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
      const firstDeps = { root, runBash: async (_body: string, options: Parameters<WorkflowDeps['runBash']>[1]) => {
          const context = JSON.parse(readFileSync(options!.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { graphId?: string; nodeId: string; executionId?: string };
          if (context.graphId === 'pod-reuse-prep' && context.nodeId === 'pending') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'legacy', verdict: 'legacy', reason: 'prep-body-pending', receiptPath: '' }), stderr: '' };
        if (context.nodeId === 'cutoff') return cutoffNodeOutput();
          if (context.nodeId === 'gate-cutover-switch') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'audit', verdict: 'pass', summary: 'audit route' }), stderr: '' };
          if (context.nodeId === 'gate') {
            current += 30 * 60_000;
            // Source: .rules/30-harness/testing-gates.md — cloud join lease is capped by the gate recipe timeout.
            expect(options!.timeoutMs).toBeGreaterThan(0);
            // Source: .rules/30-harness/testing-gates.md — cloud join lease is capped by the gate recipe timeout.
            expect(options!.timeoutMs).toBeLessThanOrEqual(4 * 60 * 60_000);
            return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', verdict: 'pass', summary: 'gate', executionId: context.executionId }), stderr: '' };
          }
          if (context.nodeId === 'cloud-approval-check' || context.nodeId === 'cloud-join' || context.nodeId === 'cloud-leave-ok' || context.nodeId === 'cloud-leave-fail') {
            const operation = context.nodeId === 'cloud-approval-check' ? 'approval-check' : context.nodeId === 'cloud-join' ? 'join' : 'leave';
            // Source: .rules/30-harness/testing-gates.md — child CLI outlives its bounded hand-tool call.
            const child = spawnSync('bun', [`scripts/release-loop/cloud-elastic-node.ts`, operation], {
              cwd: process.cwd(), env: options!.env as NodeJS.ProcessEnv, encoding: 'utf8',
              // Source: .rules/30-harness/testing-gates.md — child CLI starts under the outer graph test budget.
              timeout: 150_000,
            });
            if (child.status !== 0) throw new Error(`cloud CLI failed status=${child.status} error=${child.error?.message ?? ''} stderr=${child.stderr} stdout=${child.stdout}`);
            if (context.nodeId === 'cloud-join' || context.nodeId === 'cloud-leave-ok') {
              const result = JSON.parse(child.stdout.trim()) as { outcome: string; summary: string };
              expect(result.outcome).toBe('ok');
              if (context.nodeId === 'cloud-join') expect(result.summary).toContain('joined gcp1');
              else expect(result.summary).toContain('stopped gcp1');
            }
            return { exitCode: child.status ?? 1, stdout: child.stdout, stderr: child.stderr };
          }
          return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', verdict: 'pass', summary: context.nodeId }), stderr: '' };
        } };
      let state = await runGraph(graphPath, {
        input: { version: '9.9.9', previousVersion: '0.2.3', cutSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', candidatePath: 'fixture:cloud-elastic', cloudElastic: requestInput },
        deps: firstDeps, pinChildUniverse: true,
      });
      expect(state.status).toBe('awaiting-approval');
      decideGraphApproval(state.graphId, state.runId, 'approved', 'OP', root);
      state = await runGraph(graphPath, { resumeRunId: state.runId, deps: firstDeps, pinChildUniverse: true });
      expect(state.status).toBe('done');
      expect(state.path).toContain('cloud-leave-ok');
      const calls = readFileSync(callsFile, 'utf8').trim().split('\n');
      expect(calls[0]).toContain('cloud-join.sh gcp1');
      expect(calls[1]).toContain('cloud-leave.sh gcp1 --wait-min 30');
      const eventRows = ledger.list({ kind: 'universe' }).filter((row) => row.attrs.recordType === 'release-loop-cloud-elastic-event');
      expect(eventRows.map((row) => row.attrs.eventType)).toEqual(['request', 'start', 'join', 'leave']);
      const failureRequest = { ...request, id: 'gate-fail-request' };
      const failureDeps = { root, runBash: async (_body: string, options: Parameters<WorkflowDeps['runBash']>[1]) => {
          const context = JSON.parse(readFileSync(options!.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { graphId?: string; nodeId: string; executionId?: string };
          if (context.graphId === 'pod-reuse-prep' && context.nodeId === 'pending') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'legacy', verdict: 'legacy', reason: 'prep-body-pending', receiptPath: '' }), stderr: '' };
        if (context.nodeId === 'cutoff') return cutoffNodeOutput();
          if (context.nodeId === 'gate') return { exitCode: 1, stdout: JSON.stringify({ outcome: 'fail', verdict: 'fail', summary: 'injected gate failure', executionId: context.executionId }), stderr: '' };
          if (context.nodeId === 'cloud-approval-check' || context.nodeId === 'cloud-join' || context.nodeId === 'cloud-leave-ok' || context.nodeId === 'cloud-leave-fail') {
            const operation = context.nodeId === 'cloud-approval-check' ? 'approval-check' : context.nodeId === 'cloud-join' ? 'join' : 'leave';
            const child = spawnSync('bun', ['scripts/release-loop/cloud-elastic-node.ts', operation], {
              cwd: process.cwd(), env: options!.env as NodeJS.ProcessEnv, encoding: 'utf8',
              // Source: .rules/30-harness/testing-gates.md — child CLI starts under the outer graph test budget.
              timeout: 150_000,
            });
            if (child.status !== 0) return { exitCode: child.status ?? 1, stdout: child.stdout, stderr: child.stderr };
            return { exitCode: 0, stdout: child.stdout, stderr: child.stderr };
          }
          return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', verdict: 'pass', summary: _body }), stderr: '' };
        } };
      let failed = await runGraph(graphPath, {
        input: { version: '9.9.9', previousVersion: '0.2.3', cutSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', candidatePath: 'fixture:cloud-elastic-fail', cloudElastic: { request: failureRequest,
          monthlySpendSnapshot: { spendKrw: 0, measuredAt: new Date().toISOString() } } },
        deps: failureDeps, pinChildUniverse: true,
      });
      expect(failed.status).toBe('awaiting-approval');
      decideGraphApproval(failed.graphId, failed.runId, 'approved', 'OP', root);
      failed = await runGraph(graphPath, { resumeRunId: failed.runId, deps: failureDeps, pinChildUniverse: true });
      expect(failed.status).toBe('failed');
      expect(failed.path).toContain('cloud-leave-fail');
      expect(readFileSync(callsFile, 'utf8').trim().split('\n')).toHaveLength(4);
      expect(ledger.list({ kind: 'universe' }).filter((row) => row.attrs.recordType === 'release-loop-cloud-elastic-event').map((row) => row.attrs.eventType))
        .toEqual(['request', 'start', 'join', 'leave', 'request', 'start', 'join', 'leave']);

      const deadlineRequest = { ...request, id: 'gate-deadline-request', expectedHours: 1.25 + 500 / 3_600_000 };
      let gateAborted = false;
      let gateElapsedMs = 0;
      const executeGate = realRunBash(() => true);
      const deadlineDeps = { root, runBash: async (_body: string, options: Parameters<WorkflowDeps['runBash']>[1]) => {
          const context = JSON.parse(readFileSync(options!.env!.ELANOUS_GRAPH_CONTEXT!, 'utf8')) as { graphId?: string; nodeId: string; executionId: string };
          if (context.graphId === 'pod-reuse-prep' && context.nodeId === 'pending') return { exitCode: 0, stdout: JSON.stringify({ outcome: 'legacy', verdict: 'legacy', reason: 'prep-body-pending', receiptPath: '' }), stderr: '' };
        if (context.nodeId === 'cutoff') return cutoffNodeOutput();
          if (context.nodeId === 'gate') {
            // Source: .rules/30-harness/testing-gates.md — fixture leaves at most 500 ms before cleanup.
            expect(options!.timeoutMs).toBeGreaterThan(0);
            // Source: .rules/30-harness/testing-gates.md — fixture leaves at most 500 ms before cleanup.
            expect(options!.timeoutMs).toBeLessThanOrEqual(500);
            const startedAt = Date.now();
            try {
              // Source: .rules/30-harness/testing-gates.md — realRunBash enforces the graph timeout against a noisy child.
              const gateCommand = 'printf "gate-start\\n" >> "$ELANOUS_FAKE_CLOUD_LOG"; while :; do printf "gate-tick\\n" >> "$ELANOUS_FAKE_CLOUD_LOG"; printf "gate-tick\\n"; sleep 0.02; done';
              return await executeGate(gateCommand, options!);
            } finally {
              gateElapsedMs = Date.now() - startedAt;
              gateAborted = gateElapsedMs >= (options!.timeoutMs ?? 0);
            }
          }
          if (context.nodeId === 'cloud-approval-check' || context.nodeId === 'cloud-join' || context.nodeId === 'cloud-leave-ok' || context.nodeId === 'cloud-leave-fail') {
            const operation = context.nodeId === 'cloud-approval-check' ? 'approval-check' : context.nodeId === 'cloud-join' ? 'join' : 'leave';
            // Source: .rules/30-harness/testing-gates.md — child CLI outlives its bounded hand-tool call.
            const child = spawnSync('bun', ['scripts/release-loop/cloud-elastic-node.ts', operation], {
              cwd: process.cwd(), env: options!.env as NodeJS.ProcessEnv, encoding: 'utf8',
              // Source: .rules/30-harness/testing-gates.md — child CLI starts under the outer graph test budget.
              timeout: 150_000,
            });
            if (child.status !== 0) return { exitCode: child.status ?? 1, stdout: child.stdout, stderr: child.stderr };
            return { exitCode: 0, stdout: child.stdout, stderr: child.stderr };
          }
          return { exitCode: 0, stdout: JSON.stringify({ outcome: 'ok', verdict: 'pass', summary: context.nodeId }), stderr: '' };
        } };
      let deadlineRun = await runGraph(graphPath, {
        input: { version: '9.9.9', previousVersion: '0.2.3', cutSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', candidatePath: 'fixture:cloud-elastic-deadline', cloudElastic: { request: deadlineRequest,
          monthlySpendSnapshot: { spendKrw: 0, measuredAt: new Date().toISOString() } } },
        deps: deadlineDeps, pinChildUniverse: true,
      });
      expect(deadlineRun.status).toBe('awaiting-approval');
      decideGraphApproval(deadlineRun.graphId, deadlineRun.runId, 'approved', 'OP', root);
      deadlineRun = await runGraph(graphPath, { resumeRunId: deadlineRun.runId, deps: deadlineDeps, pinChildUniverse: true });
      expect(deadlineRun.status).toBe('failed');
      expect(deadlineRun.path).toContain('cloud-leave-fail');
      expect(gateAborted).toBe(true);
      expect(readFileSync(callsFile, 'utf8')).toContain('gate-tick');
      // Source: .rules/30-harness/testing-gates.md — bounds the real child timeout fixture.
      expect(gateElapsedMs).toBeLessThan(3_000);
      expect(ledger.list({ kind: 'universe' }).find((row) => row.id === 'release-loop-cloud-elastic:session:gate-deadline-request')?.attrs.status).toBe('left');
    } finally {
      if (process.env.PATH !== undefined) process.env.PATH = previous.path; else delete process.env.PATH;
      if (previous.state !== undefined) process.env.ELANOUS_STATE_DIR = previous.state; else delete process.env.ELANOUS_STATE_DIR;
      if (previous.calls !== undefined) process.env.ELANOUS_FAKE_CLOUD_LOG = previous.calls; else delete process.env.ELANOUS_FAKE_CLOUD_LOG;
      if (previous.rateTable !== undefined) process.env.ELANOUS_CLOUD_RATE_TABLE = previous.rateTable; else delete process.env.ELANOUS_CLOUD_RATE_TABLE;
      if (previous.hostMap !== undefined) process.env.ELANOUS_CLOUD_HOST_MAP = previous.hostMap; else delete process.env.ELANOUS_CLOUD_HOST_MAP;
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
