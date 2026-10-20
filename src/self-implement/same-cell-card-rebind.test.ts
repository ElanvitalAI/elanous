import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultSeams } from './seams.js';
import { readTaskCard, taskAgentStatePath, writeTaskCards } from '../task-agent/task-hand.js';
import type { PrManager } from '../autopilot/pr-manager.js';

test('a newly created conflicting draft rebinds the TA card while old draft cleanup remains a follow-up', async () => {
  const root = mkdtempSync(join(tmpdir(), 'same-cell-card-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  const previousCard = process.env.ELANOUS_TASK_CARD_ID;
  try {
    process.env.ELANOUS_STATE_DIR = root;
    process.env.ELANOUS_TASK_CARD_ID = 'ta-same-cell';
    const path = taskAgentStatePath();
    writeTaskCards(path, [{ id: 'ta-same-cell', text: 'build', createdAt: new Date().toISOString(),
      status: 'launched', history: [], pr: { number: 7, url: 'https://github.com/o/r/pull/7' } }]);
    const prManager = { upsertPr: () => ({ ok: true as const, url: 'https://github.com/o/r/pull/8',
      reused: false, supersededPr: 7 }) } as unknown as PrManager;
    const opened = await defaultSeams({ prManager }).openPr({ title: 'new', body: '칸: X', head: 'new-branch', cwd: root, draft: true });
    expect(opened).toEqual({ url: 'https://github.com/o/r/pull/8', number: 8 });
    expect(readTaskCard('ta-same-cell', path)).toMatchObject({ pr: { number: 8, url: opened.url },
      history: [{ event: 'same-cell-pr-rebound', pr: 8, detail: expect.stringContaining('정리 후속') }] });
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    if (previousCard === undefined) delete process.env.ELANOUS_TASK_CARD_ID;
    else process.env.ELANOUS_TASK_CARD_ID = previousCard;
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing or differently bound TA card fails with the recoverable new draft URL', async () => {
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
    await expect(openPr(input)).rejects.toThrow('https://github.com/o/r/pull/8');
    process.env.ELANOUS_TASK_CARD_ID = 'ta-conflict';
    const path = taskAgentStatePath();
    writeTaskCards(path, [{ id: 'ta-conflict', text: 'another run', createdAt: new Date().toISOString(),
      status: 'launched', history: [], pr: { number: 99, url: 'https://github.com/o/r/pull/99' } }]);
    await expect(openPr(input)).rejects.toThrow('카드 재결속 실패');
    expect(readTaskCard('ta-conflict', path)?.pr).toEqual({ number: 99, url: 'https://github.com/o/r/pull/99' });
    delete process.env.ELANOUS_TASK_CARD_ID;
    await expect(openPr(input)).rejects.toThrow('카드 ID 없음');
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    if (previousCard === undefined) delete process.env.ELANOUS_TASK_CARD_ID;
    else process.env.ELANOUS_TASK_CARD_ID = previousCard;
    rmSync(root, { recursive: true, force: true });
  }
});
