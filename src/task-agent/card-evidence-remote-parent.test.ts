import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { refreshCardRunBinding, type CardRunEvidenceDeps } from './card-evidence.js';
import { remoteParentAlive, type SshRunner } from './parent-host.js';
import { handTask, readTaskCard, updateTaskCard } from './task-hand.js';
import type { RunLedgerEntry } from '../self-implement/run-ledger.js';

const RUN = 'run-0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const CHILD = 'run-0199ffff-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const START = '2026-10-07T01:00:00.000Z';
const LATE = '2026-10-07T01:11:00.000Z';
const FAILURE = 'failed/needs-relaunch — card-run-bound 뒤 10분 동안 Pod 발사 근거 없음';
const parentHost = { host: 'node-b', pid: 18175, runId: RUN };
const sshResult = (stdout: string, status: number | null = 0, stderr = ''): SshRunner => () => ({ stdout, status, stderr });

function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'ta-remote-parent-')), 'cards.json');
  return handTask({ text: 'ship it', live: true, statePath: path, now: () => new Date(START),
    launcher: (_args, _cwd, context) => ({ runId: context!.runId, parentHost: { host: 'node-b', pid: 18175 } }) })
    .then(({ card }) => ({ path, id: card.id, runId: readTaskCard(card.id, path)!.runId! }));
}

function deps(runId: string, ssh: SshRunner, host: RunLedgerEntry[] | null = null): CardRunEvidenceDeps {
  return { ssh, loadLedger: (id) => id === runId ? host : null, podFinishes: () => [], now: () => new Date(LATE),
    dispatchPod: () => false, launchBound: () => false, runExit: () => undefined };
}

function ledger(runId: string, event: string, timestamp = LATE, data: Record<string, unknown> = {}): RunLedgerEntry {
  return { runId, event, timestamp, data };
}

test('remoteParentAlive: one SSH ps with 10s timeout; matching runId prevents PID reuse', () => {
  const calls: Array<[string, string, number]> = [];
  const ssh: SshRunner = (host, script, timeout) => { calls.push([host, script, timeout]); return { status: 0, stdout: `bun elanous harness say ELANOUS_RUN_ID=${RUN}`, stderr: '' }; };
  expect(remoteParentAlive(parentHost, ssh)).toBe('alive');
  expect(calls).toEqual([['node-b', 'ps eww -p 18175 -o command=', 10_000]]);
  expect(remoteParentAlive(parentHost, sshResult('bun harness say run-other1234'))).toBe('dead');
  expect(remoteParentAlive(parentHost, sshResult(`${RUN}-different`))).toBe('dead');
  expect(remoteParentAlive(parentHost, sshResult(''))).toBe('dead');
  expect(remoteParentAlive(parentHost, sshResult('', 1))).toBe('dead');
});

test('selected node-c parent is the only host probed by the card evidence path', async () => {
  const { path, id, runId } = await fixture();
  updateTaskCard(path, id, (card) => card && ({ ...card, parentHost: { host: 'node-c', pid: 918 } }));
  const hosts: string[] = [];
  await refreshCardRunBinding(id, path, deps(runId, (host) => {
    hosts.push(host);
    return { status: 0, stdout: `bun elanous ELANOUS_RUN_ID=${runId}`, stderr: '' };
  }));
  expect(hosts).toEqual(['node-c']);
  expect(readTaskCard(id, path)?.status).toBe('launched');
});

test('remoteParentAlive: SSH failure, timeout and untrusted ps result are unknown', () => {
  expect(remoteParentAlive(parentHost, sshResult('', 255, 'ssh unavailable'))).toBe('unknown');
  expect(remoteParentAlive(parentHost, sshResult('', null, 'ETIMEDOUT'))).toBe('unknown');
  expect(remoteParentAlive(parentHost, () => { throw new Error('timeout'); })).toBe('unknown');
  expect(remoteParentAlive({ ...parentHost, pid: undefined }, sshResult(''))).toBe('unknown');
});

test('remote card at 11 minutes: alive and unknown keep launched and log state once; dead fails once', async () => {
  for (const [state, ssh] of [
    ['alive', (runId: string) => sshResult(`bun elanous ELANOUS_RUN_ID=${runId}`)],
    ['unknown', (_runId: string) => sshResult('', 255, 'connection lost')],
    ['dead', (_runId: string) => sshResult('')],
  ] as const) {
    const { path, id, runId } = await fixture();
    let calls = 0;
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const original = debug.log;
    (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
      if (category === 'task-agent') logs.push({ event, data: data ?? {} });
    }) as typeof debug.log;
    try {
      await refreshCardRunBinding(id, path, deps(runId, (host, script, timeout) => { calls++; return ssh(runId)(host, script, timeout); }));
      expect(calls).toBe(1);
      expect(readTaskCard(id, path)?.status).toBe(state === 'dead' ? 'failed' : 'launched');
      expect(logs.filter(({ event }) => event === 'card-remote-parent-alive')).toEqual(state === 'dead' ? [] : [{ event: 'card-remote-parent-alive', data: { card: id, runId, host: 'node-b', pid: 18175, state } }]);
      if (state === 'dead') expect(readTaskCard(id, path)?.history.at(-1)).toMatchObject({ event: 'failed', detail: FAILURE });
    } finally { (debug as { log: typeof debug.log }).log = original; }
  }
});

test('late same-run pod-child-run revives only the timeout failure once and records history/log', async () => {
  const { path, id, runId } = await fixture();
  await refreshCardRunBinding(id, path, deps(runId, sshResult('')));
  expect(readTaskCard(id, path)?.history.at(-1)?.detail).toBe(FAILURE);
  const logs: string[] = [];
  const original = debug.log;
  (debug as { log: typeof debug.log }).log = ((category: string, event: string) => { if (category === 'task-agent') logs.push(event); }) as typeof debug.log;
  try {
    const late = deps(runId, sshResult(''), [ledger(runId, 'pod-child-run', '2026-10-07T01:12:00.000Z', { childRunId: CHILD })]);
    await refreshCardRunBinding(id, path, late);
    expect(readTaskCard(id, path)?.status).toBe('launched');
    expect(readTaskCard(id, path)?.history.at(-1)).toMatchObject({ event: 'revived', detail: 'late launch evidence', runId });
    expect(logs.filter((event) => event === 'card-revived')).toHaveLength(1);
    await refreshCardRunBinding(id, path, late);
    expect(readTaskCard(id, path)?.history.filter((item) => item.event === 'revived')).toHaveLength(1);
  } finally { (debug as { log: typeof debug.log }).log = original; }
});

test('revival also accepts late dispatch or same-run PR, not old, other-run or unreadable evidence', async () => {
  for (const source of ['dispatch', 'pr'] as const) {
    const { path, id, runId } = await fixture();
    await refreshCardRunBinding(id, path, deps(runId, sshResult('')));
    const options = deps(runId, sshResult(''), source === 'pr' ? [ledger(runId, 'pr-opened', '2026-10-07T01:12:00.000Z', { number: 77 })] : null);
    if (source === 'dispatch') options.dispatchPod = (id, since) => id === runId && Date.parse(since) > Date.parse(LATE);
    await refreshCardRunBinding(id, path, options);
    expect(readTaskCard(id, path)?.status).toBe('launched');
  }
  for (const host of [[ledger(RUN, 'pod-child-run', START, { childRunId: CHILD })], [ledger('run-other1234', 'pod-child-run', '2026-10-07T01:12:00.000Z', { childRunId: CHILD })]]) {
    const { path, id, runId } = await fixture();
    await refreshCardRunBinding(id, path, deps(runId, sshResult('')));
    await refreshCardRunBinding(id, path, deps(runId, sshResult(''), host));
    expect(readTaskCard(id, path)?.status).toBe('failed');
  }
  const { path, id, runId } = await fixture();
  await refreshCardRunBinding(id, path, deps(runId, sshResult('')));
  await refreshCardRunBinding(id, path, { ...deps(runId, sshResult('')), loadLedger: () => { throw new Error('EACCES'); }, dispatchPod: () => false });
  expect(readTaskCard(id, path)?.status).toBe('failed');
});

test('other failure and manual card do not revive even with later same-run launch evidence', async () => {
  for (const change of ['reason', 'manual'] as const) {
    const { path, id, runId } = await fixture();
    await refreshCardRunBinding(id, path, deps(runId, sshResult('')));
    updateTaskCard(path, id, (card) => card && ({ ...card, ...(change === 'manual' ? { refSource: 'manual' as const } : {}),
      history: card.history.map((item) => item.event === 'failed' && change === 'reason' ? { ...item, detail: 'failed/needs-owner — exit 1' } : item) }));
    await refreshCardRunBinding(id, path, deps(runId, sshResult(''), [ledger(runId, 'pod-child-run', '2026-10-07T01:12:00.000Z', { childRunId: CHILD })]));
    expect(readTaskCard(id, path)?.status).toBe('failed');
    expect(readTaskCard(id, path)?.history.some((item) => item.event === 'revived')).toBe(false);
  }
});

test('late job-finished PR (host logs, no ledger pr-opened) revives the timeout failure', async () => {
  const { path, id, runId } = await fixture();
  await refreshCardRunBinding(id, path, deps(runId, sshResult('')));
  expect(readTaskCard(id, path)?.status).toBe('failed');
  const url = 'https://github.com/o/r/pull/88';
  const options = { ...deps(runId, sshResult(''), [ledger(runId, 'pod-child-run', START, { childRunId: CHILD })]),
    podFinishes: (ids: readonly string[]) => ids.includes(CHILD) ? [{ childRunId: CHILD, prUrl: url, state: 'succeeded' }] : [] };
  await refreshCardRunBinding(id, path, options);
  expect(readTaskCard(id, path)?.status).toBe('launched');
  expect(readTaskCard(id, path)?.history.filter((item) => item.event === 'revived')).toHaveLength(1);
});

test('timeout-failed card that already has PR and goal bound still gets the revival check', async () => {
  const { path, id, runId } = await fixture();
  await refreshCardRunBinding(id, path, deps(runId, sshResult('')));
  updateTaskCard(path, id, (card) => card && ({ ...card, pr: { number: 91 }, goalId: 'abcdef0123456789' }));
  await refreshCardRunBinding(id, path, deps(runId, sshResult(''), [ledger(runId, 'pod-child-run', '2026-10-07T01:12:00.000Z', { childRunId: CHILD })]));
  expect(readTaskCard(id, path)?.status).toBe('launched');
  expect(readTaskCard(id, path)?.history.at(-1)).toMatchObject({ event: 'revived', detail: 'late launch evidence', runId });
});
