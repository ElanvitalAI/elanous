import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { runOrchestratorNode } from './tick.js';
import { enqueuePreparedTask, preparedQueuePath, readPreparedTaskKeys, readPreparedTasks, type PreparedTask } from './ready-queue.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'coord-ready-queue-'));
  roots.push(root);
  return root;
}

const task = (key: string): PreparedTask => ({
  // Source: the test fixture exercises the initial versioned queue contract.
  schemaVersion: 1,
  key,
  priority: 'P1',
  seat: 'MK',
  contract: { title: '운영 문서 갱신', text: '운영 문서 갱신', checklistId: 'DOCS', sourceCardId: 'card-1', sourceRunId: 'run-1' },
  status: 'ready',
  createdAt: '2026-11-11T00:00:00.000Z',
});

describe('coordinator prepared queue contract', () => {
  test('writes one versioned, prioritized task contract per idempotency key', () => {
    const root = fixture();
    expect(enqueuePreparedTask(root, task('orch:card-1:DOCS'))).toBe(true);
    expect(enqueuePreparedTask(root, task('orch:card-1:DOCS'))).toBe(false);
    const rows = readPreparedTasks(root);
    // Source: one idempotency key must leave exactly one queue row.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(task('orch:card-1:DOCS'));
    // Source: one idempotency key must leave exactly one persisted row.
    expect(readFileSync(preparedQueuePath(root), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  test('appends a separate JSONL row when the existing queue has no final newline', () => {
    const root = fixture();
    const path = preparedQueuePath(root);
    mkdirSync(join(root, 'loop', 'orchestrator'), { recursive: true });
    writeFileSync(path, JSON.stringify(task('orch:card-1:DOCS')));

    expect(enqueuePreparedTask(root, task('orch:card-2:TESTS'))).toBe(true);
    expect(readPreparedTasks(root)).toEqual([
      task('orch:card-1:DOCS'),
      task('orch:card-2:TESTS'),
    ]);
    expect(readPreparedTaskKeys(root)).toEqual(new Set(['orch:card-1:DOCS', 'orch:card-2:TESTS']));
  });

  test('coordinator decision persists and remains readable for a later consumer', async () => {
    const root = fixture();
    const runId = 'coord-death';
    const stateDir = join(root, 'loop', 'orchestrator');
    mkdirSync(stateDir, { recursive: true });
    const cell = { id: 'CELL-1', title: '운영 문서 갱신', seat: 'MK', priority: 'P1' as const,
      version: '0.3.10', origin: 'flow1a' as const, cardId: 'card-1' };
    writeFileSync(join(stateDir, `${runId}.json`), JSON.stringify({
      runId, window: '08', mode: 'live', day: '2026-11-11', cards: [], skippedCards: [], cells: [cell],
      placed: 1, delegated: 0, wouldDelegate: 0, reconciled: { reached: 0, progressing: 0, blocked: 0, unknown: 0 },
      steps: [], nodes: { intake: 'ok', split: 'ok', place: 'ok' }, missing: [],
    }));

    const state = await runOrchestratorNode('delegate', { root, runId, mode: 'live', window: '08',
      now: new Date('2026-11-11T00:00:00.000Z'), print: () => {}, observe: () => {},
      handToTaskAgent: 'live', handToTaskAgentCell: 'CELL-1' });
    // Source: the one prepared coordinator assignment is counted once.
    expect(state.delegated).toBe(1);
    expect(existsSync(join(root, 'task-agent-actions.json'))).toBe(false);

    // Source: a later consumer can reconstruct the coordinator decision from the persisted row.
    const decisionBeforeDispatch = readPreparedTasks(root);
    const placed: string[] = [];
    for (const row of decisionBeforeDispatch) placed.push(`${row.priority}:${row.contract.checklistId}:${row.seat}`);
    expect(placed).toEqual(['P1:CELL-1:MK']);

    // Source: re-reading the durable queue preserves the decision for a later consumer attempt.
    const persistedQueue = readFileSync(preparedQueuePath(root), 'utf8');
    expect(readFileSync(preparedQueuePath(root), 'utf8')).toBe(persistedQueue);
    expect(readPreparedTasks(root)).toEqual(decisionBeforeDispatch);
  });

  test('a malformed prepared queue does not block a shadow delegate tick', async () => {
    const root = fixture();
    const runId = 'shadow-no-queue-read';
    const stateDir = join(root, 'loop', 'orchestrator');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(preparedQueuePath(root), 'not-json\n');
    // Source: this fixture begins after place, with only the delegate node pending.
    writeFileSync(join(stateDir, `${runId}.json`), JSON.stringify({
      runId, window: '08', mode: 'shadow', day: '2026-11-11', cards: [], skippedCards: [],
      cells: [{ id: 'CELL-1', title: '문서 검토', seat: 'MK', version: '0.3.10', origin: 'flow1a', cardId: 'card-1' }],
      placed: 1, delegated: 0, wouldDelegate: 0, reconciled: { reached: 0, progressing: 0, blocked: 0, unknown: 0 },
      steps: [], nodes: { intake: 'ok', split: 'ok', place: 'ok' }, missing: [],
    }));
    const state = await runOrchestratorNode('delegate', { root, runId, mode: 'shadow', window: '08',
      now: new Date('2026-11-11T00:00:00.000Z'), print: () => {}, observe: () => {},
      handToTaskAgent: 'off', handToTaskAgentCell: 'CELL-1' });
    expect(state.nodes.delegate).toBe('ok');
  });

  test('an existing prepared key suppresses the regular seat-request consumer when TASK handoff is off', async () => {
    const root = fixture();
    const runId = 'off-but-prepared';
    const stateDir = join(root, 'loop', 'orchestrator');
    mkdirSync(stateDir, { recursive: true });
    enqueuePreparedTask(root, { ...task('orch:card-1:CELL-1'), contract: {
      title: '운영 문서 갱신', text: '운영 문서 갱신', checklistId: 'CELL-1', sourceCardId: 'card-1', sourceRunId: 'old-run',
    } });
    // Source: this fixture begins after place, with only the delegate node pending.
    writeFileSync(join(stateDir, `${runId}.json`), JSON.stringify({
      runId, window: '08', mode: 'live', day: '2026-11-11', cards: [], skippedCards: [],
      cells: [{ id: 'CELL-1', title: '운영 문서 갱신', seat: 'MK', version: '0.3.10', origin: 'flow1a', cardId: 'card-1' }],
      placed: 1, delegated: 0, wouldDelegate: 0, reconciled: { reached: 0, progressing: 0, blocked: 0, unknown: 0 },
      steps: [], nodes: { intake: 'ok', split: 'ok', place: 'ok' }, missing: [],
    }));
    const state = await runOrchestratorNode('delegate', { root, runId, mode: 'live', window: '08',
      now: new Date('2026-11-11T00:00:00.000Z'), print: () => {}, observe: () => {},
      handToTaskAgent: 'off', handToTaskAgentCell: 'CELL-1' });
    expect(state.delegated).toBe(0);
    expect(existsSync(join(root, 'seat-requests', 'requests.jsonl'))).toBe(false);
  });

  test('an unreadable queue blocks a live delegate before it can create a competing seat request', async () => {
    const root = fixture();
    const runId = 'unreadable-queue-live';
    const stateDir = join(root, 'loop', 'orchestrator');
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(preparedQueuePath(root));
    // Source: this fixture begins after place, with only the delegate node pending.
    writeFileSync(join(stateDir, `${runId}.json`), JSON.stringify({
      runId, window: '08', mode: 'live', day: '2026-11-11', cards: [], skippedCards: [],
      cells: [{ id: 'CELL-1', title: '운영 문서 갱신', seat: 'MK', version: '0.3.10', origin: 'flow1a', cardId: 'card-1' }],
      placed: 1, delegated: 0, wouldDelegate: 0, reconciled: { reached: 0, progressing: 0, blocked: 0, unknown: 0 },
      steps: [], nodes: { intake: 'ok', split: 'ok', place: 'ok' }, missing: [],
    }));
    await expect(runOrchestratorNode('delegate', { root, runId, mode: 'live', window: '08',
      now: new Date('2026-11-11T00:00:00.000Z'), print: () => {}, observe: () => {},
      handToTaskAgent: 'off', handToTaskAgentCell: 'CELL-1' })).rejects.toThrow();
    expect(existsSync(join(root, 'seat-requests', 'requests.jsonl'))).toBe(false);
  });

  test('only a genuinely missing queue path is empty; path errors and broken symlinks propagate', () => {
    const missingRoot = fixture();
    // Source: a genuinely missing parent chain means no queue has been created yet.
    expect(readPreparedTaskKeys(missingRoot)).toEqual(new Set());

    const blockedRoot = fixture();
    writeFileSync(join(blockedRoot, 'loop'), 'not a directory');
    // Source: ENOTDIR is an access/path failure, not evidence of an absent queue.
    expect(() => readPreparedTaskKeys(blockedRoot)).toThrow();

    const brokenParentRoot = fixture();
    symlinkSync(join(brokenParentRoot, 'missing-parent-target'), join(brokenParentRoot, 'loop'));
    // Source: a dangling symlink in the queue's parent chain is a read failure, not a missing queue.
    expect(() => readPreparedTaskKeys(brokenParentRoot)).toThrow();
    expect(() => readPreparedTasks(brokenParentRoot)).toThrow();

    const brokenLinkRoot = fixture();
    const linkPath = preparedQueuePath(brokenLinkRoot);
    mkdirSync(join(brokenLinkRoot, 'loop', 'orchestrator'), { recursive: true });
    symlinkSync(join(brokenLinkRoot, 'missing-target'), linkPath);
    // Source: lstat sees the link; failure to read its target must not become an empty queue.
    expect(() => readPreparedTaskKeys(brokenLinkRoot)).toThrow();
    expect(() => readPreparedTasks(brokenLinkRoot)).toThrow();
  });
});
