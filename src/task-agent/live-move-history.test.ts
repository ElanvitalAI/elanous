import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SupervisorJobResult } from '../self-dev/run-supervisor.js';
import { LIVE_MOVE_EFFECT_UNKNOWN, LIVE_REVIEW_EFFECT_PENDING, LIVE_REVIEW_EFFECT_REQUESTED, liveMoveEffect, liveMoveHistoryEntry, recordLiveMoveHistory } from './live-move-history.js';
import type { TaskAgentLiveMove } from './live-moves.js';
import { recordTaskAgentShadowMove } from './shadow.js';
import { nextMoveFor, readTaskCard, writeTaskCards, type TaskCard } from './task-hand.js';

const HEAD_A = 'a'.repeat(40);
const job = (over: Partial<SupervisorJobResult> = {}): SupervisorJobResult =>
  ({ taskId: 'ta-hist-1', feature: 'feature ask', status: 'done', ...over }) as SupervisorJobResult;

function fixture() {
  const statePath = join(mkdtempSync(join(tmpdir(), 'ta-live-history-')), 'task-agent-actions.json');
  const seed: TaskCard = { id: 'ta-hist-1', text: 'feature ask', checklistId: 'CELL-H', createdAt: '2026-10-10T00:00:00.000Z', status: 'launched',
    history: [{ at: '2026-10-10T00:00:00.000Z', event: 'run-bound', detail: 'run-x', runId: 'run-x' }] };
  writeTaskCards(statePath, [seed]);
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const reviews: number[] = [];
  const lands: number[] = [];
  const deps = (moves: TaskAgentLiveMove[], over: Record<string, unknown> = {}) => ({
    readCard: (id: string) => readTaskCard(id, statePath),
    log: (_c: string, event: string, data: Record<string, unknown>) => { logs.push({ event, data }); },
    liveMoves: new Set(moves),
    live: {
      statePath,
      now: () => new Date('2026-10-10T12:00:00.000Z'),
      prHead: async () => ({ head: HEAD_A, state: 'OPEN' }),
      requestReview: async (pr: number) => { reviews.push(pr); },
      landPrHead: async () => ({ head: HEAD_A, state: 'OPEN', isDraft: false }),
      land: async (pr: number) => { lands.push(pr); return { status: 0, stdout: 'merged' }; },
      ...over,
    },
  });
  const card = () => readTaskCard('ta-hist-1', statePath)!;
  const liveLines = () => card().history.filter((item) => item.event === 'live-move');
  return { statePath, logs, reviews, lands, deps, card, liveLines };
}

describe('TA-LIVE-MOVE-CARD-HISTORY — live-move 마다 카드 history 한 줄', () => {
  test('live review → 한 줄(필드 · head · 요청만 했다는 효과) · 기존 history 무변경 · 반환·관측 동일', async () => {
    const f = fixture();
    const out = await recordTaskAgentShadowMove({ runId: 'run-hist-review', stopReason: 'needs-human', results: [job({ prNumber: 9, worktreePath: '/tmp/wt-9' })] }, f.deps(['review']));
    expect(out.liveMove).toMatchObject({ kind: 'review', executed: true, ok: true });
    expect(f.reviews).toEqual([9]);
    expect(f.card().history[0]).toEqual({ at: '2026-10-10T00:00:00.000Z', event: 'run-bound', detail: 'run-x', runId: 'run-x' });
    expect(f.liveLines()).toEqual([{
      at: '2026-10-10T12:00:00.000Z', event: 'live-move', kind: 'review', executed: true, ok: true, executorResult: 'live',
      detail: `review requested for #9 head ${HEAD_A.slice(0, 12)}`, runId: 'run-hist-review', pr: 9, head: HEAD_A,
      // TA-REVIEW-RESULT-CAPTURE — 실행한 review 줄은 결과 파일 경로 ⊕ «결과 대기» 효과를 싣는다.
      resultPath: join(dirname(f.statePath), 'review-results', `ta-hist-1-9-${HEAD_A.slice(0, 12)}.json`), effect: LIVE_REVIEW_EFFECT_PENDING,
    }]);
    // 관측은 종전 그대로(live-move ⊕ shadow-move) — 기록 성공은 새 사건을 내지 않는다.
    expect(f.logs.map((entry) => entry.event)).toEqual(['live-move', 'shadow-move']);
    // 같은 머리 재요청 → 실행 0 · 줄은 «실행 안 됨»으로 하나 더(효과 none).
    await recordTaskAgentShadowMove({ runId: 'run-hist-review', stopReason: 'needs-human', results: [job({ prNumber: 9, worktreePath: '/tmp/wt-9' })] }, f.deps(['review']));
    expect(f.reviews).toEqual([9]);
    expect(f.liveLines().at(-1)).toMatchObject({ kind: 'review', executed: false, ok: true, executorResult: 'live', effect: 'none — not executed' });
    expect(f.liveLines().at(-1)!.head).toBeUndefined();
  });

  test('live land → 한 줄(head · 병합 효과 · sha 는 모른다고 적는다)', async () => {
    const f = fixture();
    const out = await recordTaskAgentShadowMove({ runId: 'run-hist-land', stopReason: 'needs-human', selfReview: { verdict: 'pass', head: HEAD_A, mustFixCount: 0 },
      results: [job({ prNumber: 51, worktreePath: '/tmp/land-wt', harvestable: true })] }, f.deps(['propose-land']));
    expect(out.liveMove).toMatchObject({ kind: 'land', executed: true, ok: true });
    expect(f.lands).toEqual([51]);
    expect(f.liveLines()).toEqual([expect.objectContaining({
      event: 'live-move', kind: 'propose-land', executed: true, ok: true, executorResult: 'live', pr: 51, runId: 'run-hist-land', detail: 'merged',
      effect: 'land reported ok by the executor (merge state not re-checked here) · merge sha not reported',
    })]);
    // land 결과는 머리를 싣지 않는다 — 귀속 근거가 없으니 head 칸이 없다.
    expect('head' in f.liveLines()[0]!).toBe(false);
  });

  test('shadow(허용 안 된 수) → 한 줄(executed false · executorResult shadow · 판단 사유) · 실행 0', async () => {
    const f = fixture();
    const out = await recordTaskAgentShadowMove({ runId: 'run-hist-shadow', stopReason: 'needs-human', results: [job({ prNumber: 8, worktreePath: '/tmp/wt-8' })] }, f.deps([]));
    expect(out.liveMove).toBeUndefined();
    expect(f.reviews).toEqual([]);
    const [line] = f.liveLines();
    expect(line).toMatchObject({ event: 'live-move', kind: 'review', executed: false, executorResult: 'shadow', pr: 8, runId: 'run-hist-shadow', effect: 'none — shadow (not executed)' });
    // 실행 결과가 없으면 ok 는 미상 — 칸 자체가 없다(참으로 기본값을 주지 않는다).
    expect('ok' in line!).toBe(false);
    expect(line!.detail).toBe(out.wouldDo ?? out.reason);
  });

  test('live propose-green → 칸 id 를 효과로', async () => {
    const f = fixture();
    await recordTaskAgentShadowMove({ runId: 'run-hist-green', stopReason: 'converged', results: [job({ prNumber: 7, merged: true })] }, f.deps(['propose-green']));
    expect(f.liveLines()).toEqual([expect.objectContaining({ kind: 'propose-green', executed: true, executorResult: 'live', effect: 'green proposed · checklist CELL-H (checklist untouched)' })]);
  });

  test('쓰기 실패(상태 파일 손상) → live-move 결과·실행 불변 ⊕ live-move-history-failed 관측', async () => {
    const good = fixture();
    const expected = await recordTaskAgentShadowMove({ runId: 'run-hist-fail-a', stopReason: 'needs-human', results: [job({ prNumber: 9, worktreePath: '/tmp/wt-9' })] }, good.deps(['review']));
    const f = fixture();
    const card = f.card();
    // 카드는 읽혔고 리뷰 요청까지는 적힌 «뒤»에 원장이 깨진다 — 기록만 실패해야 한다.
    const deps = f.deps(['review'], {
      requestReview: async (pr: number) => { f.reviews.push(pr); writeFileSync(f.statePath, '{not json'); },
    });
    const out = await recordTaskAgentShadowMove({ runId: 'run-hist-fail-b', stopReason: 'needs-human', results: [job({ prNumber: 9, worktreePath: '/tmp/wt-9' })] },
      { ...deps, readCard: () => card });
    // 결과 파일 경로는 픽스처(상태 파일 디렉터리)마다 다르다 — 그 칸만 각자의 경로로 맞춰 본다.
    expect(out.liveMove).toEqual({ ...expected.liveMove!, resultPath: join(dirname(f.statePath), 'review-results', `ta-hist-1-9-${HEAD_A.slice(0, 12)}.json`) });
    expect(f.reviews).toEqual([9]);
    const failed = f.logs.find((entry) => entry.event === 'live-move-history-failed');
    expect(failed?.data).toMatchObject({ card: 'ta-hist-1', kind: 'review', executorResult: 'live', executed: true });
    expect(String(failed?.data.reason)).toContain('task-agent');
  });

  test('기록 준비 중 예외(시각 생성 실패) → live-move 반환 불변 ⊕ 실패 사유 관측', async () => {
    const good = fixture();
    const expected = await recordTaskAgentShadowMove({ runId: 'run-hist-prep-a', stopReason: 'needs-human', results: [job({ prNumber: 9, worktreePath: '/tmp/wt-9' })] }, good.deps(['review']));
    const f = fixture();
    const deps = f.deps(['review']);
    let calls = 0;
    // 실행부의 시각 호출은 통과시키고, 기록 쪽 시각 호출(마지막)만 던진다.
    const now = () => { calls++; if (calls > 1) throw new Error('clock broken'); return new Date('2026-10-10T12:00:00.000Z'); };
    const out = await recordTaskAgentShadowMove({ runId: 'run-hist-prep-b', stopReason: 'needs-human', results: [job({ prNumber: 9, worktreePath: '/tmp/wt-9' })] },
      { ...deps, live: { ...deps.live, now } });
    expect(out).toEqual({ ...expected, runId: 'run-hist-prep-b', liveMove: { ...expected.liveMove!, resultPath: join(dirname(f.statePath), 'review-results', `ta-hist-1-9-${HEAD_A.slice(0, 12)}.json`) } });
    expect(f.reviews).toEqual([9]);
    expect(f.logs.find((entry) => entry.event === 'live-move-history-failed')?.data).toMatchObject({ card: 'ta-hist-1', kind: 'review', executorResult: 'live', executed: true, reason: 'record preparation failed: clock broken' });
    expect(f.liveLines()).toEqual([]);
  });

  test('카드가 원장에 없음 → 쓰지 않고 관측 · 던지지 않는다', () => {
    const f = fixture();
    const logs: string[] = [];
    const outcome = recordLiveMoveHistory(f.statePath, 'ta-missing', { at: 'T', kind: 'review', executorResult: 'shadow', shadowDetail: 'x' }, (_c, e) => { logs.push(e); });
    expect(outcome).toEqual({ written: false, reason: 'task card not in state file' });
    expect(logs).toEqual(['live-move-history-failed']);
  });

  test('head — 이번 수가 새로 적은 기록이 정확히 하나일 때만 · 겹치거나 before 모르면 싣지 않는다', () => {
    const f = fixture();
    const result = { kind: 'review' as const, card: 'ta-hist-1', ok: true, executed: true, detail: `review requested for #9 head ${HEAD_A.slice(0, 12)}` };
    const base = { at: 'T', kind: 'review' as const, executorResult: 'live' as const, result, pr: 9 };
    const other = { pr: 9, head: 'b'.repeat(40), at: 't0' };
    const mine = { pr: 9, head: HEAD_A, at: 't1' };
    const card = { ...f.card(), reviewRequests: [other, mine] };
    expect(liveMoveHistoryEntry(card, { ...base, before: { reviewRequests: [other] } }).head).toBe(HEAD_A);
    // 겹친 수 — 이번 수 동안 같은 PR 기록이 둘 생겼다 → 어느 것인지 모른다.
    expect(liveMoveHistoryEntry(card, { ...base, before: { reviewRequests: [] } }).head).toBeUndefined();
    // 수 전 카드를 모르면 «마지막 칸»으로 추정하지 않는다.
    expect(liveMoveHistoryEntry(card, base).head).toBeUndefined();
    // 실행 안 함 → 없다.
    expect(liveMoveHistoryEntry(card, { ...base, result: { ...result, executed: false }, before: { reviewRequests: [other] } }).head).toBeUndefined();
    // 새 기록이 하나여도 결과와 귀속이 안 맞으면(남의 머리) 싣지 않는다.
    expect(liveMoveHistoryEntry({ ...card, reviewRequests: [other, { pr: 9, head: 'd'.repeat(40), at: 't2' }] }, { ...base, before: { reviewRequests: [other] } }).head).toBeUndefined();
    // land — 결과가 머리를 싣지 않아 호출별 귀속 근거가 없다 → 기록이 하나·결과가 같아도 싣지 않는다.
    const landResult = { kind: 'land' as const, card: 'ta-hist-1', ok: true, executed: true, detail: 'merged' };
    const landBase = { at: 'T', kind: 'propose-land' as const, executorResult: 'live' as const, result: landResult, pr: 9, before: { landAttempts: [] } };
    expect(liveMoveHistoryEntry({ ...card, landAttempts: [{ pr: 9, head: HEAD_A, at: 't1', ok: true, detail: 'merged' }] }, landBase).head).toBeUndefined();
    expect(liveMoveHistoryEntry({ ...card, landAttempts: [{ pr: 9, head: HEAD_A, at: 't1' }] }, landBase).head).toBeUndefined();
  });

  test('기록할 수 없는 경로(카드 없음 · 주입 리더에 원장 경로 없음)도 관측을 남긴다 · 판단은 그대로', async () => {
    const f = fixture();
    const noCard = await recordTaskAgentShadowMove({ runId: 'run-hist-nocard', stopReason: 'needs-human', results: [job({ taskId: 'nobody', feature: 'no card', prNumber: 8, worktreePath: '/tmp/wt-8' })] },
      { ...f.deps([]), readCard: () => undefined });
    expect(noCard.move).toBe('review');
    const { live: _live, ...noPath } = f.deps([]);
    await recordTaskAgentShadowMove({ runId: 'run-hist-nopath', stopReason: 'needs-human', results: [job({ prNumber: 8, worktreePath: '/tmp/wt-8' })] }, noPath);
    expect(f.logs.filter((entry) => entry.event === 'live-move-history-failed').map((entry) => entry.data)).toEqual([
      expect.objectContaining({ card: null, kind: 'review', executorResult: 'shadow', reason: 'no task card bound to this move' }),
      expect.objectContaining({ card: 'ta-hist-1', kind: 'review', reason: 'card ledger unknown (injected readCard without live.statePath)' }),
    ]);
    expect(f.liveLines()).toEqual([]);
  });

  test('효과 — 모르면 unknown(지어내지 않는다)', () => {
    expect(liveMoveEffect({ executorResult: 'live', result: { kind: 'land', card: 'c', ok: false, executed: true, detail: 'exit 1' } })).toBe(LIVE_MOVE_EFFECT_UNKNOWN);
    // live 인데 결과가 없으면(타입 밖 입력) 미실행·shadow 로 단정하지 않는다.
    expect(liveMoveEffect({ executorResult: 'live' } as never)).toBe(LIVE_MOVE_EFFECT_UNKNOWN);
    expect(liveMoveEffect({ executorResult: 'live', result: { kind: 'review', card: 'c', ok: false, executed: true, detail: '?' } })).toBe(LIVE_MOVE_EFFECT_UNKNOWN);
  });

  test('failed 카드의 다음 수 사유는 live-move 줄이 뒤에 와도 실패 사유 그대로', () => {
    const card: TaskCard = { id: 'ta-f', text: 't', createdAt: '', status: 'failed', history: [
      { at: '1', event: 'failed', detail: 'failed/needs-owner — exit 1' },
      { at: '2', event: 'live-move', kind: 'review', executed: false, executorResult: 'shadow', detail: 'judged', effect: 'none — shadow (not executed)' },
    ] };
    expect(nextMoveFor(card).reason).toBe('failed/needs-owner — exit 1');
  });
});
