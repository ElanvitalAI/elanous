import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { collectGraphEvents, formatApprovalMessage, notifyGraphEvents as notifyGraphEventsRaw, setGraphNotifyFlockForTest, type GraphNotifyOptions } from './graph-notify.js';
import type { GraphRunState } from './runner.js';
import { DecisionLedger } from '../decisions/decision-ledger.js';

// Approval events now raise decision cards; the real ledger resolves versions from git (seconds per card), so tests pin it.
function notifyGraphEvents(options: GraphNotifyOptions) {
  const ledger = options.approvalCard?.ledger ?? (options.root
    ? new DecisionLedger({ stateDir: options.root, resolveVersion: () => ({ released: null, dev: null, codename: null }) })
    : undefined);
  return notifyGraphEventsRaw({ ...options, ...(ledger ? { approvalCard: { ledger } } : {}) });
}

const roots: string[] = [];
afterEach(() => { setGraphNotifyFlockForTest(undefined); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): { root: string; graphsDir: string; statePath: string; state: GraphRunState; ledgerPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'graph-notify-'));
  roots.push(root);
  const graphsDir = join(root, 'graphs');
  const runDir = join(root, 'graph-runs', 'notice');
  mkdirSync(graphsDir);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(graphsDir, 'notice.yaml'), `graph_id: notice
nodes:
  - { node_id: hidden, notify: false }
  - { node_id: announce, notify: { on: success } }
  - { node_id: gate, notify: true }
`);
  const statePath = join(runDir, 'run-1.json');
  const state: GraphRunState = {
    graphId: 'notice', runId: 'run-1', status: 'awaiting-approval', path: ['hidden', 'announce', 'gate'],
    nodes: [
      { nodeId: 'hidden', ok: true, exit: 0, executed: true },
      { nodeId: 'announce', ok: true, exit: 0, executed: true },
    ],
    pending: { nodeId: 'gate', message: 'Publish now?', since: '2026-01-01T00:00:00Z' },
    executed: 2, dryRun: false, statePath,
  };
  writeFileSync(statePath, JSON.stringify(state));
  return { root, graphsDir, statePath, state, ledgerPath: join(root, 'graph-runs', 'notifications.jsonl') };
}

test('collects opted-in node and pending approval from persisted runs without changing state', () => {
  const { root, graphsDir, statePath, ledgerPath } = fixture();
  const before = readFileSync(statePath, 'utf8');
  const events = collectGraphEvents({ root, graphsDir });
  expect(events).toHaveLength(2);
  expect(events.map(({ nodeId, kind }) => [nodeId, kind])).toEqual([['announce', 'node'], ['gate', 'approval']]);
  expect(events[1]?.message).toContain('Publish now?');
  expect(readFileSync(statePath, 'utf8')).toBe(before);
  expect(existsSync(ledgerPath)).toBe(false);
});

test('the registered CLI previews graph notifications from persisted runs without sending or writing a ledger', () => {
  const { root, statePath, ledgerPath } = fixture();
  const before = readFileSync(statePath, 'utf8');
  const repo = resolve(import.meta.dir, '../..');
  const proc = Bun.spawnSync(['bun', join(repo, 'bin/elanous.mjs'), `--test=${root}`, 'graph', 'notify', '--dry-run'], {
    cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ELANOUS_STATE_DIR: root },
  });
  expect(new TextDecoder().decode(proc.stderr)).toBe('');
  expect(proc.exitCode).toBe(0);
  expect(new TextDecoder().decode(proc.stdout)).toContain('pending graph notifications: 2');
  expect(existsSync(ledgerPath)).toBe(false);
  expect(readFileSync(statePath, 'utf8')).toBe(before);
}, 30000);

test('the registered CLI invokes the non-preview notifier and skips ledger-recorded events', () => {
  const { root, graphsDir, statePath, ledgerPath } = fixture();
  const before = readFileSync(statePath, 'utf8');
  const events = collectGraphEvents({ root, graphsDir });
  const ledger = events.map((event) => JSON.stringify({ id: event.id })).join('\n') + '\n';
  writeFileSync(ledgerPath, ledger);
  const repo = resolve(import.meta.dir, '../..');
  const proc = Bun.spawnSync(['bun', join(repo, 'bin/elanous.mjs'), `--test=${root}`, 'graph', 'notify'], {
    cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ELANOUS_STATE_DIR: root },
  });
  expect(proc.exitCode).toBe(0);
  expect(new TextDecoder().decode(proc.stdout)).toContain('sent graph notifications: 0');
  expect(readFileSync(ledgerPath, 'utf8')).toBe(ledger);
  expect(readFileSync(statePath, 'utf8')).toBe(before);
}, 30000);

test('unconfigured approvals notify by default and nodes remain opt-in', () => {
  const { root, graphsDir, statePath, state } = fixture();
  writeFileSync(join(graphsDir, 'notice.yaml'), `graph_id: notice\nnodes:\n  - { node_id: hidden }\n  - { node_id: announce, notify: { on: failure } }\n  - { node_id: gate }\n`);
  expect(collectGraphEvents({ root, graphsDir }).map((event) => [event.nodeId, event.kind])).toEqual([['gate', 'approval']]);
  state.nodes[1]!.ok = false;
  writeFileSync(statePath, JSON.stringify(state));
  expect(collectGraphEvents({ root, graphsDir }).map((event) => [event.nodeId, event.kind, event.status])).toEqual([
    ['announce', 'node', 'fail'], ['gate', 'approval', undefined],
  ]);
});

test('approval message contains both decision commands and exact identity and prompt', () => {
  expect(formatApprovalMessage({ graphId: 'notice', runId: 'run-1', nodeId: 'gate', message: 'Publish now?' })).toBe(
    'Graph notice / run run-1 — approval required at gate\nPublish now?\nApprove: elanous graph approve notice run-1\nReject: elanous graph approve notice run-1 --reject');
});

test('sends each fresh event once, appends one JSONL record after each successful send and never rewrites run state', async () => {
  const { root, graphsDir, statePath, ledgerPath } = fixture();
  const before = readFileSync(statePath, 'utf8');
  const delivered: string[] = [];
  const opts = { root, graphsDir, send: (message: string) => { delivered.push(message); } };
  expect(await notifyGraphEvents(opts)).toHaveLength(2);
  expect(delivered).toHaveLength(2);
  const lines = readFileSync(ledgerPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  expect(lines).toHaveLength(2);
  expect(lines.map((line) => line.kind)).toEqual(['node', 'approval']);
  expect(await notifyGraphEvents(opts)).toEqual([]);
  expect(delivered).toHaveLength(2);
  expect(readFileSync(statePath, 'utf8')).toBe(before);
});

test('notify raises an approval card exactly once across ticks while retaining text notification', async () => {
  const { root, graphsDir, statePath, ledgerPath } = fixture();
  const ledger = new DecisionLedger({ stateDir: root, resolveVersion: () => ({ released: '0.2.9', dev: '0.2.10', codename: null }) });
  const delivered: string[] = [];
  const opts = { root, graphsDir, approvalCard: { ledger }, send: (message: string) => { delivered.push(message); } };
  await notifyGraphEvents(opts);
  await notifyGraphEvents(opts);
  expect(ledger.list({ status: 'all' })).toHaveLength(1);
  expect(ledger.list()[0]?.refs).toEqual(['graph-approval:notice:run-1:gate:1']);
  expect(delivered.filter(message => message.includes('Approve: elanous graph approve'))).toHaveLength(1);
  expect(readFileSync(statePath, 'utf8')).toContain('awaiting-approval');
  expect(readFileSync(ledgerPath, 'utf8').trim().split('\n')).toHaveLength(2);
});

test('notify applies a decided card once even after its text has already been sent', async () => {
  const { root, graphsDir, statePath } = fixture();
  const ledger = new DecisionLedger({ stateDir: root, resolveVersion: () => ({ released: '0.2.9', dev: '0.2.10', codename: null }) });
  const opts = { root, graphsDir, approvalCard: { ledger }, send: () => {} };
  await notifyGraphEvents(opts);
  ledger.decide(ledger.list()[0]!.id, 'a', { kind: 'human' });
  expect(await notifyGraphEvents(opts)).toEqual([]);
  expect(JSON.parse(readFileSync(`${statePath}.3.decision.json`, 'utf8'))).toMatchObject({ decision: 'approved', decidedBy: 'owner:human' });
});

test('card ledger write failure does not suppress the text notification', async () => {
  const { root, graphsDir } = fixture();
  const delivered: string[] = [];
  const ledger = { list: () => [], raise: () => { throw new Error('ledger unavailable'); } } as unknown as DecisionLedger;
  const events = await notifyGraphEvents({ root, graphsDir, approvalCard: { ledger }, send: message => { delivered.push(message); } });
  expect(events).toHaveLength(2);
  expect(delivered.filter(message => message.includes('Approve: elanous graph approve'))).toHaveLength(1);
});

test('failure leaves failed and subsequent events unsent; retry sends only unrecorded events', async () => {
  const { root, graphsDir, statePath, ledgerPath } = fixture();
  const before = readFileSync(statePath, 'utf8');
  let calls = 0;
  await expect(notifyGraphEvents({ root, graphsDir, send: () => {
    if (++calls === 2) throw new Error('delivery failed');
  } })).rejects.toThrow('delivery failed');
  expect(readFileSync(ledgerPath, 'utf8').trim().split('\n')).toHaveLength(1);
  expect(readFileSync(statePath, 'utf8')).toBe(before);
  const retried: string[] = [];
  expect(await notifyGraphEvents({ root, graphsDir, send: (_message, event) => { retried.push(event.nodeId); } })).toHaveLength(1);
  expect(retried).toEqual(['gate']);
  expect(readFileSync(ledgerPath, 'utf8').trim().split('\n')).toHaveLength(2);
  expect(readFileSync(statePath, 'utf8')).toBe(before);
});

test('an async delivery rejection never records the failed event and a later call retries it', async () => {
  const { root, graphsDir, statePath, ledgerPath } = fixture();
  const before = readFileSync(statePath, 'utf8');
  await expect(notifyGraphEvents({ root, graphsDir, send: async () => {
    throw new Error('offline');
  } })).rejects.toThrow('offline');
  expect(existsSync(ledgerPath)).toBe(false);
  expect(readFileSync(statePath, 'utf8')).toBe(before);
  const delivered: string[] = [];
  expect(await notifyGraphEvents({ root, graphsDir, send: async (_message, event) => {
    delivered.push(event.nodeId);
  } })).toHaveLength(2);
  expect(delivered).toEqual(['announce', 'gate']);
  expect(readFileSync(ledgerPath, 'utf8').trim().split('\n')).toHaveLength(2);
  expect(readFileSync(statePath, 'utf8')).toBe(before);
});

test('the ledger is appended only after delivery resolves successfully', async () => {
  const { root, graphsDir, ledgerPath } = fixture();
  const seen: Array<[string, boolean]> = [];
  await notifyGraphEvents({ root, graphsDir, send: async (_message, event) => {
    seen.push([event.nodeId, existsSync(ledgerPath)]);
    if (event.nodeId === 'gate') {
      expect(readFileSync(ledgerPath, 'utf8').trim().split('\n')).toHaveLength(1);
    }
  } });
  expect(seen).toEqual([['announce', false], ['gate', true]]);
  expect(readFileSync(ledgerPath, 'utf8').trim().split('\n')).toHaveLength(2);
});

test('dry run previews absent events but does not call sender or create a ledger', async () => {
  const { root, graphsDir, ledgerPath } = fixture();
  expect(await notifyGraphEvents({ root, graphsDir, dryRun: true, send: () => { throw new Error('sent'); } })).toHaveLength(2);
  expect(existsSync(ledgerPath)).toBe(false);
});

test('a decision claim suppresses approval even when the run JSON still says undecided', () => {
  const { root, graphsDir, statePath, state } = fixture();
  writeFileSync(`${statePath}.${state.path.length}.decision.json`, JSON.stringify({ nodeId: 'gate', decision: 'approved' }));
  expect(collectGraphEvents({ root, graphsDir }).map((event) => event.kind)).toEqual(['node']);
});

test('visit number distinguishes repeat node results; a decided approval is not emitted', () => {
  const { root, graphsDir, statePath, state } = fixture();
  state.status = 'done';
  state.path = ['announce', 'announce', 'gate'];
  state.nodes = [
    { nodeId: 'announce', ok: false, exit: 1, executed: true },
    { nodeId: 'announce', ok: true, exit: 0, executed: true },
  ];
  state.pending!.decision = 'approved';
  writeFileSync(statePath, JSON.stringify(state));
  expect(collectGraphEvents({ root, graphsDir }).map((event) => [event.nodeId, event.visit, event.kind])).toEqual([['announce', 2, 'node']]);
});

test('simultaneous cold-start invocations agree on one lock before sending', async () => {
  const { root, graphsDir, ledgerPath } = fixture();
  setGraphNotifyFlockForTest(undefined);
  let delivered = 0;
  const send = async () => { delivered++; await Bun.sleep(10); };
  const results = await Promise.allSettled([
    notifyGraphEvents({ root, graphsDir, send }),
    notifyGraphEvents({ root, graphsDir, send }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled').map((result) => result.value.length)).toEqual([2]);
  expect(results.filter((result) => result.status === 'rejected').map((result) => String(result.reason))).toEqual([
    expect.stringContaining('graph notification is already running'),
  ]);
  expect(delivered).toBe(2);
  expect(readFileSync(ledgerPath, 'utf8').trim().split('\n')).toHaveLength(2);
});

test('concurrent invocations cannot send an unrecorded event twice', async () => {
  const { root, graphsDir, ledgerPath } = fixture();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const sent: string[] = [];
  const first = notifyGraphEvents({ root, graphsDir, send: async (_message, event) => {
    sent.push(event.nodeId);
    if (sent.length === 1) { entered(); await held; }
  } });
  await started;
  try {
    await expect(notifyGraphEvents({ root, graphsDir, send: () => { throw new Error('duplicate'); } })).rejects.toThrow('graph notification is already running');
  } finally { release(); }
  expect(await first).toHaveLength(2);
  expect(sent).toEqual(['announce', 'gate']);
  expect(readFileSync(ledgerPath, 'utf8').trim().split('\n')).toHaveLength(2);
});

test('simultaneous recovery of a lock left by an exited process sends each event once', async () => {
  const { root, graphsDir, ledgerPath } = fixture();
  const lock = `${ledgerPath}.flock`;
  const oldLock = `${ledgerPath}.lock`;
  mkdirSync(oldLock);
  writeFileSync(join(oldLock, 'owner.json'), JSON.stringify({ pid: 99999999, token: 'abandoned' }));
  writeFileSync(lock, 'abandoned owner');
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const sent: string[] = [];
  const send = async (_message: string, event: { nodeId: string }) => {
    sent.push(event.nodeId);
    if (sent.length === 1) { entered(); await held; }
  };
  const first = notifyGraphEvents({ root, graphsDir, send });
  await started;
  try {
    await expect(notifyGraphEvents({ root, graphsDir, send })).rejects.toThrow('graph notification is already running');
    expect(readFileSync(lock, 'utf8')).toBe('abandoned owner');
  } finally { release(); }
  expect(await first).toHaveLength(2);
  expect(await notifyGraphEvents({ root, graphsDir, send })).toEqual([]);
  expect(sent).toEqual(['announce', 'gate']);
  expect(readFileSync(ledgerPath, 'utf8').trim().split('\n')).toHaveLength(2);
  expect(existsSync(lock)).toBe(true);
  expect(existsSync(join(oldLock, 'owner.json'))).toBe(true);
});

test('invalid JSONL ledger fails closed instead of re-sending anything', async () => {
  const { root, graphsDir, ledgerPath } = fixture();
  writeFileSync(ledgerPath, '{broken}\n');
  await expect(notifyGraphEvents({ root, graphsDir, send: () => { throw new Error('sent'); } })).rejects.toThrow();
});

test('without flock (Windows, musl) an exclusive owner file serializes senders and is removed afterwards', async () => {
  const { root, graphsDir, ledgerPath } = fixture();
  setGraphNotifyFlockForTest(null);
  const owner = `${ledgerPath}.owner`;
  writeFileSync(owner, '999');
  await expect(notifyGraphEvents({ root, graphsDir, send: () => {} })).rejects.toThrow(owner);
  rmSync(owner);
  const sent: string[] = [];
  const events = await notifyGraphEvents({ root, graphsDir, send: (_message, event) => { sent.push(event.nodeId); } });
  expect(sent).toEqual(events.map((event) => event.nodeId));
  expect(sent.length).toBeGreaterThan(0);
  expect(existsSync(owner)).toBe(false);
  expect(await notifyGraphEvents({ root, graphsDir, send: () => { throw new Error('resent'); } })).toEqual([]);
});

test('the CLI start path never loads bun:ffi — graph-notify has no top-level FFI import and graph-cli imports it lazily', () => {
  const notify = readFileSync(join(import.meta.dir, 'graph-notify.ts'), 'utf8');
  const cli = readFileSync(join(import.meta.dir, 'graph-cli.ts'), 'utf8');
  expect(notify).not.toMatch(/^import[^\n]*'bun:ffi'/m);
  expect(notify).not.toMatch(/^const \w+ = dlopen\(/m);
  expect(cli).not.toMatch(/^import[^\n]*'\.\/graph-notify\.js'/m);
});
