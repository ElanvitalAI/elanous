import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FOLLOW_UP_OP_CARD_REQUIRED,
  collectRemainings,
  followUpCellId,
  followUpChainDepth,
  followUpDraftHash,
  followUpDraftText,
  followUpDraftsPath,
  recordFollowUpOnBlocked,
  recordFollowUpOnMerge,
  remainingPiecesFromPrBody,
  seatForCellOwner,
  type FollowUpDraftRecord,
} from './follow-up-goals.js';

const FEATURE = 'FOLLOWUP-LOOP 남은 조각을 연결골로\n둘째 줄은 초안에 안 들어간다';
const MUST_A = 'must-fix: 리뷰 예산이 남긴 첫 지적';
const MUST_B = 'must-fix: 리뷰 예산이 남긴 둘째 지적';
const SHOULD = 'should-fix: 마지막 리뷰의 비차단 지적';
const PIECE = 'PR 본문 남은 조각 한 줄';

function prBodyWithPiece(piece = PIECE): string {
  return ['## 요약', '- 착지', '', '## 남은 조각', `- ${piece}`, '', '## 다음', '- 다른 절'].join('\n');
}

function memoryStore(seed: FollowUpDraftRecord[] = []) {
  const drafts = [...seed];
  const queued: Array<{ seat: string; say: string; idempotencyKey: string }> = [];
  return {
    drafts,
    queued,
    seams: {
      mode: 'shadow' as 'shadow' | 'live',
      readDrafts: () => drafts,
      appendDraft: (record: FollowUpDraftRecord) => { drafts.push(record); },
      enqueue: async (item: { seat: 'OP' | 'TC' | 'MK' | 'UX'; say: string; idempotencyKey: string }) => { queued.push(item); },
      cellOwner: () => 'TC',
    },
  };
}

describe('FOLLOWUP-LOOP① — leftover findings become one follow-up draft', () => {
  test('two followUpMustFix items and one should-fix write one depth-1 draft quoting all three verbatim', async () => {
    const store = memoryStore();
    const record = await recordFollowUpOnMerge({
      prNumber: 41,
      followUpMustFix: [MUST_A, MUST_B],
      shouldFix: [SHOULD],
      feature: FEATURE,
      cellId: 'FOLLOWUP-LOOP',
    }, store.seams);

    expect(store.drafts).toHaveLength(1);
    expect(record).toMatchObject({
      prNumber: 41,
      cellId: 'FOLLOWUP-LOOP',
      depth: 1,
      kind: 'draft',
      queued: false,
      remainings: [MUST_A, MUST_B, SHOULD],
    });
    expect(record?.draft).toBe(followUpDraftText(FEATURE.split('\n')[0]!, [MUST_A, MUST_B, SHOULD]));
    expect(record?.draft).toContain('origin/main 에서 시작 · 남은 것만');
    expect(record?.draftHash).toBe(followUpDraftHash(record!.draft!));
    expect(store.queued).toHaveLength(0);
  });

  test('the same PR is recorded once', async () => {
    const store = memoryStore();
    const input = { prNumber: 41, followUpMustFix: [MUST_A], feature: FEATURE, cellId: 'FOLLOWUP-LOOP' };
    await recordFollowUpOnMerge(input, store.seams);
    const second = await recordFollowUpOnMerge(input, store.seams);
    expect(second).toBeNull();
    expect(store.drafts).toHaveLength(1);
  });

  test('a chain of depth 3 records «OP 카드 필요» instead of another draft', async () => {
    const prior = [1, 2, 3].map((depth) => ({
      prNumber: depth,
      cellId: 'FOLLOWUP-LOOP',
      depth,
      draftHash: `h${depth}`,
      kind: 'draft' as const,
      originalAskFirstLine: FEATURE.split('\n')[0]!,
      remainings: [`prior ${depth}`],
      queued: false,
    }));
    const store = memoryStore(prior);
    const record = await recordFollowUpOnMerge({
      prNumber: 44,
      shouldFix: [SHOULD],
      feature: FEATURE,
      cellId: 'FOLLOWUP-LOOP',
    }, store.seams);
    expect(record).toMatchObject({ kind: 'op-card-required', depth: 4, note: FOLLOW_UP_OP_CARD_REQUIRED, queued: false });
    expect(record?.draft).toBeUndefined();
    expect(store.queued).toHaveLength(0);
  });

  test('shadow never calls the queue; live calls it once with the cell owner seat', async () => {
    const shadow = memoryStore();
    await recordFollowUpOnMerge({ prNumber: 51, prBody: prBodyWithPiece(), feature: FEATURE, cellId: 'FOLLOWUP-LOOP' }, shadow.seams);
    expect(shadow.queued).toHaveLength(0);

    const live = memoryStore();
    live.seams.mode = 'live';
    live.seams.cellOwner = () => 'MK/rel';
    const record = await recordFollowUpOnMerge({
      prNumber: 52,
      prBody: prBodyWithPiece(),
      feature: FEATURE,
      cellId: 'FOLLOWUP-LOOP',
    }, live.seams);
    expect(live.queued).toHaveLength(1);
    expect(live.queued[0]).toMatchObject({ seat: 'MK', idempotencyKey: 'follow-up:52', say: record?.draft });
    expect(record?.queued).toBe(true);
  });

  test('an unknown owner falls through to OP, the one door', () => {
    expect(seatForCellOwner(undefined)).toBe('OP');
    expect(seatForCellOwner('nobody')).toBe('OP');
    expect(seatForCellOwner('TC')).toBe('TC');
  });

  test('nothing remaining writes no line', async () => {
    const store = memoryStore();
    const record = await recordFollowUpOnMerge({ prNumber: 60, feature: FEATURE, cellId: 'FOLLOWUP-LOOP' }, store.seams);
    expect(record).toBeNull();
    expect(store.drafts).toHaveLength(0);
    expect(store.queued).toHaveLength(0);
  });

  test('a PR body «남은 조각» section is quoted verbatim and stops at the next heading', () => {
    expect(remainingPiecesFromPrBody(prBodyWithPiece())).toEqual([PIECE]);
    expect(collectRemainings({ followUpMustFix: [MUST_A], shouldFix: [SHOULD], prBody: prBodyWithPiece(MUST_A) })).toEqual([MUST_A, SHOULD]);
  });

  test('the default writer appends one jsonl line under the injected state root and never opens the harness queue', async () => {
    const root = mkdtempSync(join(tmpdir(), 'follow-up-drafts-'));
    let enqueued = 0;
    const record = await recordFollowUpOnMerge({
      prNumber: 70,
      followUpMustFix: [MUST_A],
      feature: FEATURE,
      cellId: 'FOLLOWUP-LOOP',
    }, {
      stateRoot: root,
      mode: 'shadow',
      enqueue: () => { enqueued++; },
    });
    const lines = readFileSync(followUpDraftsPath(root), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ prNumber: 70, cellId: 'FOLLOWUP-LOOP', depth: 1, draftHash: record?.draftHash });
    expect(enqueued).toBe(0);
  });

  test('no injected store and no state root writes nothing and never opens the harness queue', async () => {
    let enqueued = 0;
    const record = await recordFollowUpOnMerge({
      prNumber: 90,
      followUpMustFix: [MUST_A],
      shouldFix: [SHOULD],
      feature: FEATURE,
      cellId: 'FOLLOWUP-LOOP',
    }, {
      mode: 'live',
      enqueue: () => { enqueued++; },
    });
    expect(record).toBeNull();
    expect(enqueued).toBe(0);
  });

  test('a writer failure is a debug line and not a thrown merge failure', async () => {
    const logged: Array<{ category: string; event: string }> = [];
    const record = await recordFollowUpOnMerge({
      prNumber: 80,
      followUpMustFix: [MUST_A],
      feature: FEATURE,
      cellId: 'FOLLOWUP-LOOP',
    }, {
      mode: 'shadow',
      appendDraft: () => { throw new Error('ledger down'); },
      log: (category, event) => { logged.push({ category, event }); },
    });
    expect(record).toBeNull();
    expect(logged).toEqual([{ category: 'self-implement.follow-up', event: 'draft-failed' }]);
  });

  test('live enqueue failure still records the draft with queued=false and the reason', async () => {
    const store = memoryStore();
    const logged: string[] = [];
    const record = await recordFollowUpOnMerge({ prNumber: 77, followUpMustFix: [MUST_A], feature: FEATURE, cellId: 'FOLLOWUP-LOOP' }, {
      ...store.seams, mode: 'live', enqueue: async () => { throw new Error('queue journal locked'); },
      log: (_category, event) => { logged.push(event); },
    });
    // 원장 먼저(대기 전) → 실패 사유 한 줄 더.
    expect(store.drafts).toHaveLength(2);
    expect(record).toMatchObject({ prNumber: 77, kind: 'draft', queued: false, seat: 'TC', enqueueError: 'queue journal locked' });
    expect(logged).toContain('enqueue-failed');
  });

  test('a ledger write failure stops before the queue — no follow-up exists outside the ledger', async () => {
    const store = memoryStore();
    const record = await recordFollowUpOnMerge({ prNumber: 78, followUpMustFix: [MUST_A], feature: FEATURE, cellId: 'FOLLOWUP-LOOP' }, {
      ...store.seams, mode: 'live', appendDraft: () => { throw new Error('disk full'); }, log: () => {},
    });
    expect(record).toBeNull();
    expect(store.queued).toHaveLength(0);
  });

  test('two ledger lines of one PR count as one link in the chain depth', () => {
    const row = { prNumber: 5, kind: 'draft' as const };
    expect(followUpChainDepth([row, { ...row }, { prNumber: 6, kind: 'draft' as const }])).toBe(2);
  });

  test('a test process handed the operational state root (defaultSeams) writes nothing and queues nothing', async () => {
    const { elanousStateRoot } = await import('../autopilot/state-paths.js');
    let enqueued = 0;
    const record = await recordFollowUpOnMerge({ prNumber: 79, followUpMustFix: [MUST_A], feature: FEATURE, cellId: 'FOLLOWUP-LOOP' }, {
      mode: 'live', stateRoot: elanousStateRoot(), enqueue: async () => { enqueued++; }, log: () => {},
    });
    expect(process.env.NODE_ENV).toBe('test');
    expect(record).toBeNull();
    expect(enqueued).toBe(0);
  });

  test('no explicit cell id means no record — the first word of the ask is not a cell', async () => {
    const store = memoryStore();
    const record = await recordFollowUpOnMerge({ prNumber: 80, followUpMustFix: [MUST_A], feature: 'Fix the thing' }, { ...store.seams, log: () => {} });
    expect(record).toBeNull();
    expect(store.drafts).toHaveLength(0);
    expect(followUpCellId({ feature: '[MK 자리 · 0.2.16 체크리스트 칸 FOLLOWUP-LOOP · 역할 docs/roles/MK.md] 본문' })).toBe('FOLLOWUP-LOOP');
  });

  test('a failed ledger confirmation after a successful enqueue is logged as its own event', async () => {
    const store = memoryStore();
    const events: string[] = [];
    let writes = 0;
    const record = await recordFollowUpOnMerge({ prNumber: 81, followUpMustFix: [MUST_A], feature: FEATURE, cellId: 'FOLLOWUP-LOOP' }, {
      ...store.seams, mode: 'live', log: (_c, event) => { events.push(event); },
      appendDraft: (row) => { writes++; if (writes === 2) throw new Error('disk full'); store.drafts.push({ ...row }); },
    });
    expect(record).toMatchObject({ queued: true });
    expect(store.queued).toHaveLength(1);
    expect(events).toEqual(['ledger-confirm-failed', 'drafted']);
  });

  test('only the leading seat header names the cell, and one PR is drafted once across cells on disk', async () => {
    expect(followUpCellId({ feature: '골 본문 — 체크리스트 칸 OTHER-CELL 을 참고' })).toBeUndefined();
    expect(followUpCellId({ feature: '[TC 자리 · 0.2.17 체크리스트 칸 GRID-API · 역할 docs/roles/TC.md] 본문 체크리스트 칸 OTHER' })).toBe('GRID-API');
    const root = mkdtempSync(join(tmpdir(), 'follow-up-pr-once-'));
    const first = await recordFollowUpOnMerge({ prNumber: 90, followUpMustFix: [MUST_A], feature: FEATURE, cellId: 'CELL-A' }, { stateRoot: root, mode: 'shadow', log: () => {} });
    const second = await recordFollowUpOnMerge({ prNumber: 90, followUpMustFix: [MUST_A], feature: FEATURE, cellId: 'CELL-B' }, { stateRoot: root, mode: 'shadow', log: () => {} });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(readFileSync(followUpDraftsPath(root), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  test('the seat header on the line after `대상 경로:` names the cell (authoring Pod order)', () => {
    expect(followUpCellId({ feature: '대상 경로: src/a.ts · src/b.ts\n[MK 자리 · 0.2.17 체크리스트 칸 GRID-API · 역할 docs/roles/MK.md] 본문' })).toBe('GRID-API');
    expect(followUpCellId({ feature: '대상 경로: src/a.ts\n본문 — 체크리스트 칸 OTHER 언급\n[MK 자리 · 0.2.17 체크리스트 칸 GRID-API ·]' })).toBeUndefined();
  });

  test('blocked live mode drafts once with trimmed findings but never enqueues', async () => {
    const store = memoryStore();
    const logs: Array<{ event: string; data: unknown }> = [];
    const input = { runId: 'run-a', stage: 'review-blocked' as const, unresolvedMustFix: [' must A ', 'must A'], decompositionPieces: ['piece one', 'piece two', ' '], feature: 'FLEX-FU-ON-FAIL 실패 뒤 후속\n둘째 줄', cellId: 'FLEX-FU-ON-FAIL' };
    const record = await recordFollowUpOnBlocked(input, { ...store.seams, mode: 'live', log: (_c, event, data) => logs.push({ event, data }) });
    expect(store.drafts).toHaveLength(1);
    expect(record).toMatchObject({ ending: 'blocked', runId: 'run-a', prNumber: 0, stage: 'review-blocked', kind: 'draft', depth: 1, queued: false, remainings: ['must A', 'piece one', 'piece two'] });
    expect(record?.draft).toBe(followUpDraftText('FLEX-FU-ON-FAIL 실패 뒤 후속', ['must A', 'piece one', 'piece two']));
    expect(store.queued).toHaveLength(0);
    expect(logs).toEqual([{ event: 'drafted', data: expect.objectContaining({ ending: 'blocked', runId: 'run-a', stage: 'review-blocked', mode: 'live', queued: false, remainingCount: 3 }) }]);
  });

  test('distinct blocked runs do not collide with each other or a merged PR, and depth uses both keys', async () => {
    const store = memoryStore();
    const logs: Array<{ event: string; data: unknown }> = [];
    const seams = { ...store.seams, log: (_c: string, event: string, data?: unknown) => logs.push({ event, data }) };
    const blocked = { runId: 'run-a', stage: 'gate-failed' as const, decompositionPieces: ['piece'], feature: FEATURE, cellId: 'CELL' };
    await recordFollowUpOnBlocked(blocked, seams);
    expect(await recordFollowUpOnBlocked(blocked, seams)).toBeNull();
    const other = await recordFollowUpOnBlocked({ ...blocked, runId: 'run-b' }, seams);
    const merged = await recordFollowUpOnMerge({ prNumber: 9, followUpMustFix: [MUST_A], feature: FEATURE, cellId: 'CELL' }, seams);
    expect(store.drafts).toHaveLength(3);
    expect(other).toMatchObject({ prNumber: 0, depth: 2, runId: 'run-b' });
    expect(merged).toMatchObject({ prNumber: 9, depth: 3 });
    expect(logs.filter(({ event, data }) => event === 'drafted' && (data as { ending?: string }).ending === 'merged')).toHaveLength(1);
    expect(followUpChainDepth(store.drafts)).toBe(3);
  });

  test('blocked default ledger deduplicates by run across cells while preserving PR key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'follow-up-blocked-'));
    const input = { runId: 'run-a', stage: 'gate-failed' as const, unresolvedMustFix: [MUST_A], feature: FEATURE, cellId: 'CELL-A' };
    const seams = { stateRoot: root, mode: 'live' as const, log: () => {} };
    await recordFollowUpOnBlocked(input, seams);
    expect(await recordFollowUpOnBlocked({ ...input, cellId: 'CELL-B' }, seams)).toBeNull();
    await recordFollowUpOnBlocked({ ...input, runId: 'run-b' }, seams);
    await recordFollowUpOnMerge({ prNumber: 0, followUpMustFix: [MUST_A], feature: FEATURE, cellId: 'CELL-A' }, { ...seams, mode: 'shadow' });
    const rows = readFileSync(followUpDraftsPath(root), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as FollowUpDraftRecord);
    expect(rows.map((row) => row.ending === 'blocked' ? `run:${row.runId}` : `pr:${row.prNumber}`)).toEqual(['run:run-a', 'run:run-b', 'pr:0']);
  });

  test('empty blocked and merged findings log their skip; blocked writer failures do not throw', async () => {
    const store = memoryStore();
    const logs: Array<{ event: string; data: unknown }> = [];
    const seams = { ...store.seams, log: (_c: string, event: string, data?: unknown) => logs.push({ event, data }) };
    expect(await recordFollowUpOnBlocked({ runId: 'empty', stage: 'gate-failed', feature: FEATURE, cellId: 'CELL' }, seams)).toBeNull();
    expect(await recordFollowUpOnMerge({ prNumber: 5, feature: FEATURE, cellId: 'CELL' }, seams)).toBeNull();
    expect(logs).toEqual([
      { event: 'draft-skipped-empty', data: { ending: 'blocked', prNumber: 0, runId: 'empty' } },
      { event: 'draft-skipped-empty', data: { ending: 'merged', prNumber: 5 } },
    ]);
    expect(await recordFollowUpOnBlocked({ runId: 'bad', stage: 'gate-failed', feature: FEATURE, cellId: 'CELL', unresolvedMustFix: [MUST_A] }, { ...seams, appendDraft: () => { throw new Error('disk down'); } })).toBeNull();
    expect(logs.at(-1)?.event).toBe('draft-failed');
  });

  test('blocked depth four records an OP card and never queues', async () => {
    const store = memoryStore();
    for (const runId of ['a', 'b', 'c', 'd']) {
      await recordFollowUpOnBlocked({ runId, stage: 'review-blocked', unresolvedMustFix: [MUST_A], feature: FEATURE, cellId: 'CELL' }, { ...store.seams, mode: 'live' });
    }
    expect(store.drafts[3]).toMatchObject({ depth: 4, kind: 'op-card-required', note: FOLLOW_UP_OP_CARD_REQUIRED, queued: false });
    expect(store.queued).toHaveLength(0);
  });
});

