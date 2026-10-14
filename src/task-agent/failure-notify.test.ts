import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { registerTasksCommands } from '../cli/tasks-cli.js';
import { defaultMsgStorePath, openMsgStore } from '../msg/msg-store.js';
import type { RunLedgerEntry } from '../self-implement/run-ledger.js';
import { refreshCardRunBinding, type CardRunEvidenceDeps } from './card-evidence.js';
import { remoteLedgerMirrorDir } from './parent-host.js';
import { handTask, readTaskCard, updateTaskCard } from './task-hand.js';

const child = 'run-0199ffff-bbbb-7ccc-8ddd-eeeeeeeeeeee';
const at = '2026-10-13T06:00:00.000Z';
const reason = '2라운드 연속 제자리 — 원인 원문';
const log = '$HOME/.elanous/remote-parents/parent.log';

function row(runId: string, event: string, data: Record<string, unknown> = {}): RunLedgerEntry {
  return { runId, timestamp: at, event, data };
}

async function fixture() {
  const path = join(mkdtempSync(join(tmpdir(), 'ta-failure-notify-')), 'cards.json');
  const { card } = await handTask({ text: 'ship it', seat: 'MK', live: true, statePath: path,
    launcher: (_args, _cwd, context) => ({ runId: context!.runId, parentHost: { host: 'node-b', pid: 718, log } }) });
  return { path, card: readTaskCard(card.id, path)! };
}

function evidence(runId: string, path: string, extras: { parent?: RunLedgerEntry[]; child?: RunLedgerEntry[] | null; readError?: boolean; alive?: boolean; parentSalvage?: boolean } = {}): CardRunEvidenceDeps {
  const parent = extras.parent ?? [row(runId, 'pod-child-run', { childRunId: child }), row(runId, 'stop', { tail: [`[supervisor] 정지(no-progress) — ${reason}`] })];
  return { incidentStorePath: join(dirname(path), 'msg', 'messages.db'), loadLedger: (id) => {
    if (extras.readError && id === child) throw new Error('EACCES');
    return id === runId ? parent : id === child ? (extras.child === undefined ? [row(child, 'run-status', { runStatus: 'failed' })] : extras.child) : null;
  }, podFinishes: () => [], ssh: () => ({ status: extras.alive ? 0 : 1, stdout: extras.alive ? `ELANOUS_RUN_ID=${runId}` : '', stderr: '' }),
  runExit: () => undefined, dispatchPod: () => false, launchBound: () => false };
}

test('remote terminal no-progress fails the card and sends one durable incident with raw reason and log path', async () => {
  const { path, card } = await fixture();
  const deps = evidence(card.runId!, path);
  await refreshCardRunBinding(card.id, path, deps);
  await refreshCardRunBinding(card.id, path, deps);
  const failed = readTaskCard(card.id, path)!;
  expect(failed.status).toBe('failed');
  expect(failed.history.filter((item) => item.event === 'failed')).toHaveLength(1);
  expect(failed.history.at(-1)?.detail).toBe(`failed/needs-owner — no-progress — ${reason}`);
  const store = openMsgStore(join(dirname(path), 'msg', 'messages.db'));
  try {
    const messages = store.list('MK');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ from: 'TC', to: 'MK', kind: 'incident' });
    expect(messages[0]!.body).toContain(`사유: no-progress — ${reason}`);
    expect(messages[0]!.body).toContain(`원격 로그: ${log}`);
  } finally { store.close(); }
});

test('manual goal evidence survives remote terminal failure and sends one incident', async () => {
  const { path, card } = await fixture();
  updateTaskCard(path, card.id, (current) => current && ({ ...current, goalId: 'goal-manual', refSource: 'manual' }));
  const deps = evidence(card.runId!, path);
  await refreshCardRunBinding(card.id, path, deps);
  await refreshCardRunBinding(card.id, path, deps);
  const failed = readTaskCard(card.id, path)!;
  expect(failed.status).toBe('failed');
  expect(failed.goalId).toBe('goal-manual');
  expect(failed.refSource).toBe('manual');
  expect(failed.pr).toBeUndefined();
  expect(failed.history.filter((item) => item.event === 'failed')).toHaveLength(1);
  const store = openMsgStore(join(dirname(path), 'msg', 'messages.db'));
  try { expect(store.list('MK')).toHaveLength(1); }
  finally { store.close(); }
});

test('a failed incident-store write is retried on the next refresh', async () => {
  const { path, card } = await fixture();
  const deps = evidence(card.runId!, path);
  await refreshCardRunBinding(card.id, path, { ...deps, incidentStorePath: dirname(path) });
  expect(readTaskCard(card.id, path)?.status).toBe('failed');
  const storePath = join(dirname(path), 'msg', 'messages.db');
  const empty = openMsgStore(storePath);
  try { expect(empty.list('MK')).toHaveLength(0); }
  finally { empty.close(); }
  await refreshCardRunBinding(card.id, path, deps);
  await refreshCardRunBinding(card.id, path, deps);
  const store = openMsgStore(storePath);
  try { expect(store.list('MK')).toHaveLength(1); }
  finally { store.close(); }
});

test('remote terminal needs-human without PR or salvage branch sends its actual one-line reason', async () => {
  const { path, card } = await fixture();
  const parent = [row(card.runId!, 'pod-child-run', { childRunId: child }),
    row(card.runId!, 'stop', { tail: ['[supervisor] 정지(needs-human) — 테스트 실패 · 사람 판단 필요'] })];
  await refreshCardRunBinding(card.id, path, evidence(card.runId!, path, { parent }));
  expect(readTaskCard(card.id, path)?.history.at(-1)?.detail).toBe('failed/needs-owner — needs-human — 테스트 실패 · 사람 판단 필요');
  const store = openMsgStore(join(dirname(path), 'msg', 'messages.db'));
  try { expect(store.list('MK')[0]?.body).toContain('사유: needs-human — 테스트 실패 · 사람 판단 필요'); }
  finally { store.close(); }
});

test('a parent that stops before launching any child is still a terminal failure', async () => {
  const { path, card } = await fixture();
  const parent = [row(card.runId!, 'stop', { tail: ['[supervisor] 정지(needs-human) — 자식 발사 전 막힘'] })];
  await refreshCardRunBinding(card.id, path, evidence(card.runId!, path, { parent }));
  expect(readTaskCard(card.id, path)?.status).toBe('failed');
});

test('a supervisor stop after running status is terminal when the parent PID is dead', async () => {
  const { path, card } = await fixture();
  const parent = [row(card.runId!, 'run-status', { runStatus: 'running' }),
    row(card.runId!, 'stop', { tail: [`[supervisor] 정지(no-progress) — ${reason}`] })];
  await refreshCardRunBinding(card.id, path, evidence(card.runId!, path, { parent }));
  expect(readTaskCard(card.id, path)?.status).toBe('failed');
  const store = openMsgStore(join(dirname(path), 'msg', 'messages.db'));
  try { expect(store.list('MK')).toHaveLength(1); }
  finally { store.close(); }
});

test('a new execution event after an old stop keeps the parent outcome unknown', async () => {
  for (const later of [row('placeholder', 'start'), row('placeholder', 'run-status', { runStatus: 'running' }),
    row('placeholder', 'pod-child-run', { childRunId: child })]) {
    const { path, card } = await fixture();
    const parent = [row(card.runId!, 'stop', { tail: [`[supervisor] 정지(no-progress) — ${reason}`] }),
      { ...later, runId: card.runId! }];
    await refreshCardRunBinding(card.id, path, evidence(card.runId!, path, { parent }));
    expect(readTaskCard(card.id, path)?.status).toBe('launched');
    const store = openMsgStore(join(dirname(path), 'msg', 'messages.db'));
    try { expect(store.list('MK')).toHaveLength(0); }
    finally { store.close(); }
  }
});

test('a stopped parent waits for its active child to reach terminal status', async () => {
  const { path, card } = await fixture();
  const active = evidence(card.runId!, path, { child: [row(child, 'run-status', { runStatus: 'running' })] });
  await refreshCardRunBinding(card.id, path, active);
  expect(readTaskCard(card.id, path)?.status).toBe('launched');
  const storePath = join(dirname(path), 'msg', 'messages.db');
  const pending = openMsgStore(storePath);
  try { expect(pending.list('MK')).toHaveLength(0); }
  finally { pending.close(); }
  const terminal = evidence(card.runId!, path, { child: [row(child, 'run-status', { runStatus: 'failed' })] });
  await refreshCardRunBinding(card.id, path, terminal);
  await refreshCardRunBinding(card.id, path, terminal);
  expect(readTaskCard(card.id, path)?.status).toBe('failed');
  const notified = openMsgStore(storePath);
  try { expect(notified.list('MK')).toHaveLength(1); }
  finally { notified.close(); }
});

test('malformed parent child references remain unknown instead of becoming no-child failures', async () => {
  for (const childRunId of [undefined, 42, 'bad-child-id', 'same-parent']) {
    const { path, card } = await fixture();
    const ref = childRunId === 'same-parent' ? card.runId : childRunId;
    const parent = [row(card.runId!, 'pod-child-run', ref === undefined ? {} : { childRunId: ref }),
      row(card.runId!, 'stop', { tail: [`[supervisor] 정지(no-progress) — ${reason}`] })];
    await refreshCardRunBinding(card.id, path, evidence(card.runId!, path, { parent }));
    expect(readTaskCard(card.id, path)?.status).toBe('launched');
    const store = openMsgStore(join(dirname(path), 'msg', 'messages.db'));
    try { expect(store.list('MK')).toHaveLength(0); }
    finally { store.close(); }
  }
});

test('a terminal child with salvage only in parent or child stop text remains harvestable', async () => {
  for (const salvage of ['ELANOUS_POD_SALVAGE=feature/work', '수확할 브랜치:experiment/work']) {
    const { path, card } = await fixture();
    const parent = [row(card.runId!, 'pod-child-run', { childRunId: child }),
      row(card.runId!, 'stop', { tail: [`[supervisor] 정지(no-progress) — ${reason}`, salvage] })];
    await refreshCardRunBinding(card.id, path, evidence(card.runId!, path, { parent }));
    expect(readTaskCard(card.id, path)?.status).toBe('launched');
    const store = openMsgStore(join(dirname(path), 'msg', 'messages.db'));
    try { expect(store.list('MK')).toHaveLength(0); }
    finally { store.close(); }
  }
  const { path, card } = await fixture();
  const childRows = [row(child, 'stop', { tail: ['ELANOUS_POD_SALVAGE=feature/child'] }),
    row(child, 'run-status', { runStatus: 'failed' })];
  await refreshCardRunBinding(card.id, path, evidence(card.runId!, path, { child: childRows }));
  expect(readTaskCard(card.id, path)?.status).toBe('launched');
  const store = openMsgStore(join(dirname(path), 'msg', 'messages.db'));
  try { expect(store.list('MK')).toHaveLength(0); }
  finally { store.close(); }
});

test('a terminal stop without a raw supervisor reason stays pending and sends no incident', async () => {
  for (const suffix of ['', '  ']) {
    const { path, card } = await fixture();
    const parent = [row(card.runId!, 'stop', { tail: [`[supervisor] 정지(needs-human) — ${suffix}`] })];
    await refreshCardRunBinding(card.id, path, evidence(card.runId!, path, { parent }));
    expect(readTaskCard(card.id, path)?.status).toBe('launched');
    const store = openMsgStore(join(dirname(path), 'msg', 'messages.db'));
    try { expect(store.list('MK')).toHaveLength(0); }
    finally { store.close(); }
  }
});

test('a previously failed same run still receives its terminal supervisor incident once', async () => {
  const { path, card } = await fixture();
  updateTaskCard(path, card.id, (current) => current && ({ ...current, status: 'failed',
    history: [...current.history, { at, event: 'failed', detail: 'failed/needs-relaunch — old exit', runId: current.runId }] }));
  const deps = evidence(card.runId!, path);
  await refreshCardRunBinding(card.id, path, deps);
  await refreshCardRunBinding(card.id, path, deps);
  const store = openMsgStore(join(dirname(path), 'msg', 'messages.db'));
  try { expect(store.list('MK')).toHaveLength(1); }
  finally { store.close(); }
});

test('tasks show refreshes a stale remote mirror and writes one incident to the default mailbox', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-failure-show-'));
  const previousRoot = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    const path = join(root, 'task-agent-actions.json');
    const { card } = await handTask({ text: 'ship it', seat: 'MK', live: true, statePath: path,
      launcher: (_args, _cwd, context) => ({ runId: context!.runId, parentHost: { host: 'node-b', pid: 718, log } }) });
    const runId = card.runId!;
    const parent = [row(runId, 'pod-child-run', { childRunId: child }), row(runId, 'stop', { tail: [`[supervisor] 정지(no-progress) — ${reason}`] })];
    const mirror = remoteLedgerMirrorDir(root, 'node-b');
    mkdirSync(mirror, { recursive: true });
    writeFileSync(join(mirror, `${runId}.jsonl`), `${JSON.stringify(parent[0])}\n`); // old HQ mirror has no stop
    writeFileSync(join(mirror, `${child}.jsonl`), `${JSON.stringify(row(child, 'start'))}\n`);
    const ssh: NonNullable<CardRunEvidenceDeps['ssh']> = (_host, script) => {
      if (script.startsWith('ps eww')) return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: script.includes(`${child}.jsonl`) ? `${JSON.stringify(row(child, 'run-status', { runStatus: 'failed' }))}\n` : parent.map((entry) => JSON.stringify(entry)).join('\n') + '\n', stderr: '' };
    };
    const command = new Command().name('elanous').exitOverride();
    registerTasksCommands(command, { registerSink: async () => true, taskStatePath: path,
      cardRunEvidence: { ssh, podFinishes: () => [], runExit: () => undefined, dispatchPod: () => false, launchBound: () => false }, output: () => {} });
    await command.parseAsync(['node', 'elanous', 'tasks', 'show', card.id]);
    await command.parseAsync(['node', 'elanous', 'tasks', 'show', card.id]);
    expect(readTaskCard(card.id, path)?.status).toBe('failed');
    const store = openMsgStore(defaultMsgStorePath());
    try { expect(store.list('MK')).toHaveLength(1); }
    finally { store.close(); }
  } finally {
    if (previousRoot === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousRoot;
  }
});

test('tasks show reads a late remote child PR before judging a stale local child mirror', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-failure-late-pr-'));
  const previousRoot = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    const path = join(root, 'task-agent-actions.json');
    const { card } = await handTask({ text: 'ship it', seat: 'MK', live: true, statePath: path,
      launcher: (_args, _cwd, context) => ({ runId: context!.runId, parentHost: { host: 'node-b', pid: 718, log } }) });
    const runId = card.runId!;
    const parent = [row(runId, 'pod-child-run', { childRunId: child }), row(runId, 'stop', { tail: [`[supervisor] 정지(no-progress) — ${reason}`] })];
    const mirror = remoteLedgerMirrorDir(root, 'node-b');
    mkdirSync(mirror, { recursive: true });
    writeFileSync(join(mirror, `${runId}.jsonl`), parent.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    // Without a fresh SSH read, this terminal local mirror would make the parent look like a failure.
    writeFileSync(join(mirror, `${child}.jsonl`), `${JSON.stringify(row(child, 'run-status', { runStatus: 'completed' }))}\n`);
    const remoteChild = [row(child, 'start'), row(child, 'pr-opened', { number: 27104, url: 'https://github.com/o/r/pull/27104' }),
      row(child, 'run-status', { runStatus: 'completed' })];
    const ssh: NonNullable<CardRunEvidenceDeps['ssh']> = (_host, script) => {
      if (script.startsWith('ps eww')) return { status: 1, stdout: '', stderr: '' };
      return { status: 0, stdout: script.includes(`${child}.jsonl`)
        ? remoteChild.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
        : parent.map((entry) => JSON.stringify(entry)).join('\n') + '\n', stderr: '' };
    };
    const command = new Command().name('elanous').exitOverride();
    registerTasksCommands(command, { registerSink: async () => true, taskStatePath: path,
      cardRunEvidence: { ssh, podFinishes: () => [], runExit: () => undefined, dispatchPod: () => false, launchBound: () => false }, output: () => {} });
    await command.parseAsync(['node', 'elanous', 'tasks', 'show', card.id]);
    expect(readTaskCard(card.id, path)?.status).toBe('launched');
    const store = openMsgStore(defaultMsgStorePath());
    try { expect(store.list('MK')).toHaveLength(0); }
    finally { store.close(); }
  } finally {
    if (previousRoot === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousRoot;
  }
});

test('an SSH refresh failure cannot judge a stale terminal HQ mirror', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ta-failure-stale-ssh-'));
  const previousRoot = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    const path = join(root, 'task-agent-actions.json');
    const { card } = await handTask({ text: 'ship it', seat: 'MK', live: true, statePath: path,
      launcher: (_args, _cwd, context) => ({ runId: context!.runId, parentHost: { host: 'node-b', pid: 718, log } }) });
    const mirror = remoteLedgerMirrorDir(root, 'node-b');
    mkdirSync(mirror, { recursive: true });
    writeFileSync(join(mirror, `${card.runId}.jsonl`), [
      row(card.runId!, 'pod-child-run', { childRunId: child }),
      row(card.runId!, 'stop', { tail: [`[supervisor] 정지(no-progress) — ${reason}`] }),
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    writeFileSync(join(mirror, `${child}.jsonl`), `${JSON.stringify(row(child, 'run-status', { runStatus: 'failed' }))}\n`);
    const deps: CardRunEvidenceDeps = { incidentStorePath: join(root, 'msg', 'messages.db'),
      ssh: () => ({ status: 255, stdout: '', stderr: 'transport unavailable' }),
      podFinishes: () => [], runExit: () => undefined, dispatchPod: () => false, launchBound: () => false };
    await refreshCardRunBinding(card.id, path, deps);
    expect(readTaskCard(card.id, path)?.status).toBe('launched');
    const store = openMsgStore(deps.incidentStorePath!);
    try { expect(store.list('MK')).toHaveLength(0); }
    finally { store.close(); }
  } finally {
    if (previousRoot === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousRoot;
  }
});

test('remote needs-human is terminal too; active parent, missing child ledger, PR and salvage keep the card launched', async () => {
  const cases = [
    { alive: true },
    { child: null },
    { child: [row(child, 'pr-opened', { number: 9, url: 'https://github.com/o/r/pull/9' })] },
    { child: [row(child, 'salvaged', { salvageBranch: 'salvage/work' })] },
    { child: [row(child, 'stop', { salvageBranch: 'salvage/from-stop' })] },
    { parentSalvage: true },
    { readError: true },
  ];
  for (const extra of cases) {
    const { path, card } = await fixture();
    const parent = [row(card.runId!, 'pod-child-run', { childRunId: child }),
      row(card.runId!, 'stop', { tail: ['[supervisor] 정지(needs-human) — 실제 이유'],
        ...(extra.parentSalvage ? { salvageBranch: 'salvage/from-parent' } : {}) })];
    const deps = evidence(card.runId!, path, { ...extra, parent });
    await refreshCardRunBinding(card.id, path, deps);
    expect(readTaskCard(card.id, path)?.status).toBe('launched');
    const store = openMsgStore(join(dirname(path), 'msg', 'messages.db'));
    try { expect(store.list('MK')).toHaveLength(0); }
    finally { store.close(); }
  }
});
