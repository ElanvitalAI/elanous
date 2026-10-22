import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSeams } from './seams.js';
import { readTaskCard, taskAgentStatePath, writeTaskCards } from '../task-agent/task-hand.js';
import type { PrManager, UpsertPrInput } from '../autopilot/pr-manager.js';

test('a newly created conflicting draft rebinds the TA card while old draft cleanup remains a follow-up', async () => {
  const root = mkdtempSync(join(tmpdir(), 'same-cell-card-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  const previousCard = process.env.ELANOUS_TASK_CARD_ID;
  const previousRun = process.env.ELANOUS_RUN_ID;
  try {
    process.env.ELANOUS_STATE_DIR = root;
    process.env.ELANOUS_TASK_CARD_ID = 'ta-same-cell';
    process.env.ELANOUS_RUN_ID = 'run-a1b2c3d4-1111-2222-3333-444444444444';
    const path = taskAgentStatePath();
    writeTaskCards(path, [{ id: 'ta-same-cell', text: 'build', createdAt: new Date().toISOString(),
      status: 'launched', history: [], pr: { number: 7, url: 'https://github.com/o/r/pull/7' } }]);
    let passedRunId: string | undefined;
    const prManager = { upsertPr: (input: UpsertPrInput) => { passedRunId = input.runId; return { ok: true as const, url: 'https://github.com/o/r/pull/8',
      reused: false, supersededPr: 7 }; } } as unknown as PrManager;
    const opened = await defaultSeams({ prManager }).openPr({ title: 'new', body: '칸: X', head: 'new-branch', cwd: root, draft: true });
    expect(opened).toMatchObject({ url: 'https://github.com/o/r/pull/8', number: 8,
      rebind: { outcome: 'rebound', reason: 'rebound', cardId: 'ta-same-cell', oldPr: 7, newPr: 8 } });
    expect(passedRunId).toBe(process.env.ELANOUS_RUN_ID);
    expect(readTaskCard('ta-same-cell', path)).toMatchObject({ pr: { number: 8, url: opened.url },
      history: [{ event: 'same-cell-pr-rebound', pr: 8, detail: expect.stringContaining('정리 후속') }] });
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    if (previousCard === undefined) delete process.env.ELANOUS_TASK_CARD_ID;
    else process.env.ELANOUS_TASK_CARD_ID = previousCard;
    if (previousRun === undefined) delete process.env.ELANOUS_RUN_ID;
    else process.env.ELANOUS_RUN_ID = previousRun;
    rmSync(root, { recursive: true, force: true });
  }
});

test('an absent card store or card defers rebind, while a differently bound card still fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'same-cell-card-reject-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  const previousCard = process.env.ELANOUS_TASK_CARD_ID;
  const prManager = { upsertPr: () => ({ ok: true as const, url: 'https://github.com/o/r/pull/8',
    reused: false, supersededPr: 7 }) } as unknown as PrManager;
  try {
    process.env.ELANOUS_STATE_DIR = root;
    process.env.ELANOUS_TASK_CARD_ID = 'ta-missing';
    const openPr = defaultSeams({ prManager }).openPr;
    const input = { title: 'new', body: '칸: X', head: 'new-branch', cwd: root, draft: true };
    await expect(openPr(input)).resolves.toMatchObject({ number: 8,
      rebind: { outcome: 'deferred', reason: 'card-store-absent', cardId: 'ta-missing', oldPr: 7, newPr: 8 } });
    const path = taskAgentStatePath();
    writeTaskCards(path, []);
    await expect(openPr(input)).resolves.toMatchObject({ number: 8,
      rebind: { outcome: 'deferred', reason: 'card-missing', cardId: 'ta-missing' } });
    process.env.ELANOUS_TASK_CARD_ID = 'ta-conflict';
    writeTaskCards(path, [{ id: 'ta-conflict', text: 'another run', createdAt: new Date().toISOString(),
      status: 'launched', history: [], pr: { number: 99, url: 'https://github.com/o/r/pull/99' } }]);
    await expect(openPr(input)).rejects.toThrow('카드 재결속 실패');
    expect(readTaskCard('ta-conflict', path)?.pr).toEqual({ number: 99, url: 'https://github.com/o/r/pull/99' });
    delete process.env.ELANOUS_TASK_CARD_ID;
    await expect(openPr(input)).resolves.toMatchObject({ number: 8,
      rebind: { outcome: 'deferred', reason: 'card-id-absent', cardId: null } });
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    if (previousCard === undefined) delete process.env.ELANOUS_TASK_CARD_ID;
    else process.env.ELANOUS_TASK_CARD_ID = previousCard;
    rmSync(root, { recursive: true, force: true });
  }
});
