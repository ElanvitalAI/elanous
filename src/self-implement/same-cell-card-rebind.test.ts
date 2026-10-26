import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { defaultSeams } from './seams.js';
import { readTaskCard, taskAgentStatePath, writeTaskCards } from '../task-agent/task-hand.js';
import type { PrManager, UpsertPrInput } from '../autopilot/pr-manager.js';

type HostMissingEvent = { event: string; data: Record<string, unknown>; level?: string };

/** 생산 진입점 defaultSeams({prManager}).openPr 가 실제로 흘리는 경고 관측만 잡는다(소스 문자열 검사 아님). */
function captureHostMissingEvents(sink: HostMissingEvent[]): { mockRestore(): void } {
  const log = spyOn(debug, 'log');
  log.mockImplementation(((category: string, event: string, data?: Record<string, unknown>, options?: { level?: string }) => {
    if (category === 'self-implement.same-cell' && event === 'rebind-missing-on-host') {
      sink.push({ event, data: data ?? {}, level: options?.level });
    }
  }) as never);
  return log;
}

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

test('SAMECELL-HOST-FAILCLOSED: 호스트(카드 저장소 있음) card-missing · card-id-absent 는 경고로 분리되고 Pod 는 deferred 로 남는다', async () => {
  const root = mkdtempSync(join(tmpdir(), 'same-cell-card-reject-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  const previousCard = process.env.ELANOUS_TASK_CARD_ID;
  const hostMissing: HostMissingEvent[] = [];
  const logSpy = captureHostMissingEvents(hostMissing);
  const prManager = { upsertPr: () => ({ ok: true as const, url: 'https://github.com/o/r/pull/8',
    reused: false, supersededPr: 7 }) } as unknown as PrManager;
  try {
    process.env.ELANOUS_STATE_DIR = root;
    process.env.ELANOUS_TASK_CARD_ID = 'ta-missing';
    const openPr = defaultSeams({ prManager }).openPr;
    const input = { title: 'new', body: '칸: X', head: 'new-branch', cwd: root, draft: true };

    // Pod 무대 — 카드 저장소 자체가 없다: deferred 는 그대로(보존) · 호스트 경고 0.
    await expect(openPr(input)).resolves.toMatchObject({ number: 8,
      rebind: { outcome: 'deferred', reason: 'card-store-absent', cardId: 'ta-missing', oldPr: 7, newPr: 8 } });
    expect(hostMissing).toHaveLength(0);
    // Pod 무대 — 카드 id 도 없다: 역시 deferred 그대로(보존) · 호스트 경고 0.
    delete process.env.ELANOUS_TASK_CARD_ID;
    await expect(openPr(input)).resolves.toMatchObject({ number: 8,
      rebind: { outcome: 'deferred', reason: 'card-id-absent', cardId: null } });
    expect(hostMissing).toHaveLength(0);

    // 호스트 무대 — 저장소는 있는데 카드가 없다: 조용한 성공이 아니라 경고 이벤트 1.
    process.env.ELANOUS_TASK_CARD_ID = 'ta-missing';
    const path = taskAgentStatePath();
    writeTaskCards(path, []);
    await expect(openPr(input)).resolves.toMatchObject({ number: 8,
      rebind: { outcome: 'deferred', reason: 'card-missing', cardId: 'ta-missing' } });
    expect(hostMissing).toHaveLength(1);
    expect(hostMissing[0]).toMatchObject({ event: 'rebind-missing-on-host', level: 'warn',
      data: { reason: 'card-missing', cardId: 'ta-missing', oldPr: 7, newPr: 8 } });

    // 다른 PR 에 묶인 카드는 지금처럼 실패한다(보존) · 경고는 늘지 않는다.
    process.env.ELANOUS_TASK_CARD_ID = 'ta-conflict';
    writeTaskCards(path, [{ id: 'ta-conflict', text: 'another run', createdAt: new Date().toISOString(),
      status: 'launched', history: [], pr: { number: 99, url: 'https://github.com/o/r/pull/99' } }]);
    await expect(openPr(input)).rejects.toThrow('카드 재결속 실패');
    expect(readTaskCard('ta-conflict', path)?.pr).toEqual({ number: 99, url: 'https://github.com/o/r/pull/99' });
    expect(hostMissing).toHaveLength(1);

    // 호스트 무대 — 카드 id 가 비어 있다: 저장소가 있으니 이것도 경고로 분리(Pod 였다면 위처럼 deferred).
    delete process.env.ELANOUS_TASK_CARD_ID;
    await expect(openPr(input)).resolves.toMatchObject({ number: 8,
      rebind: { outcome: 'deferred', reason: 'card-id-absent', cardId: null } });
    expect(hostMissing).toHaveLength(2);
    expect(hostMissing[1]).toMatchObject({ event: 'rebind-missing-on-host', level: 'warn',
      data: { reason: 'card-id-absent', cardId: null } });
  } finally {
    logSpy.mockRestore();
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    if (previousCard === undefined) delete process.env.ELANOUS_TASK_CARD_ID;
    else process.env.ELANOUS_TASK_CARD_ID = previousCard;
    rmSync(root, { recursive: true, force: true });
  }
});
