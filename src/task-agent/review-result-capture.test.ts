import { describe, expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { debug } from '../debug/log.js';
import type { DetachedSpawn } from '../cli/tasks-cli.js';
import type { SupervisorJobResult } from '../self-dev/run-supervisor.js';
import { LIVE_REVIEW_EFFECT_PENDING } from './live-move-history.js';
import { defaultRequestReview, type TaskAgentLiveMove } from './live-moves.js';
import { regateResultPath } from './rejudge-on-head.js';
import { capturedSelfReview, captureReviewResults, parseReviewResultOutput, rejudgeCompletedTaskReview, REVIEW_RESULT_MISSING_EFFECT, REVIEW_RESULT_UNREADABLE_EFFECT, reviewResultPath, TA_REVIEW_COMPLETION_CARD_ENV, TA_REVIEW_COMPLETION_RESULT_ENV, TA_REVIEW_COMPLETION_STATE_ENV } from './review-result-capture.js';
import { recordTaskAgentShadowMove } from './shadow.js';
import { nextMoveFor, readTaskCard, writeTaskCards, type TaskCard } from './task-hand.js';
import { repairReviewDigest } from './repair-review.js';

const HEAD = 'b'.repeat(40);
const job = (over: Partial<SupervisorJobResult> = {}): SupervisorJobResult =>
  ({ taskId: 'ta-rr-1', feature: 'feature ask', status: 'done', prNumber: 21, worktreePath: '/tmp/wt-21', ...over }) as SupervisorJobResult;
const reviewJson = (over: Record<string, unknown> = {}) => JSON.stringify({
  pr: '21', model: 'm', verdict: 'pass', mustFix: [], shouldFix: ['nit'], reviewed: true, reviewRoute: 'api', headCommit: HEAD, ...over,
});

function fixture() {
  const statePath = join(mkdtempSync(join(tmpdir(), 'ta-review-result-')), 'task-agent-actions.json');
  const seed: TaskCard = { id: 'ta-rr-1', text: 'feature ask', checklistId: 'CELL-R', createdAt: '2026-10-10T00:00:00.000Z', status: 'launched',
    pr: { number: 21, url: 'https://github.com/o/r/pull/21' },
    history: [{ at: '2026-10-10T00:00:00.000Z', event: 'run-bound', detail: 'run-x', runId: 'run-x' }] };
  writeTaskCards(statePath, [seed]);
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const lands: Array<{ pr: number; head: string }> = [];
  let clock = new Date('2026-10-10T12:00:00.000Z');
  /** 자식 흉내 — 받은 resultPath 에 무엇을 쓸지(없으면 안 쓴다 = 자식 사망). */
  let child: ((resultPath: string) => void) | undefined;
  const requested: Array<{ pr: number; resultPath?: string }> = [];
  const deps = (moves: TaskAgentLiveMove[]) => ({
    readCard: (id: string) => readTaskCard(id, statePath),
    log: (_c: string, event: string, data: Record<string, unknown>) => { logs.push({ event, data }); },
    liveMoves: new Set(moves),
    live: {
      statePath,
      now: () => clock,
      prHead: async () => ({ head: HEAD, state: 'OPEN' }),
      requestReview: async (pr: number, _intent: string, _cwd?: string, capture?: { resultPath: string }) => {
        requested.push({ pr, ...(capture ? { resultPath: capture.resultPath } : {}) });
        // 실물(defaultRequestReview)은 디렉터리를 만들고 stdout 을 그 파일로 연다 — 흉내도 같은 순서로.
        if (capture && child) { mkdirSync(dirname(capture.resultPath), { recursive: true }); child(capture.resultPath); }
      },
      landPrHead: async () => ({ head: HEAD, state: 'OPEN', isDraft: false }),
      land: async (pr: number, head: string) => { lands.push({ pr, head }); return { status: 0, stdout: 'merged' }; },
    },
    // TA-WIRING-CHECK — 병합 PR 배선 관측이 실물 `gh pr diff` 로 나가지 않게(밀폐).
    wiring: { prDiff: () => '', loadLedger: () => null },
  });
  const card = () => readTaskCard('ta-rr-1', statePath)!;
  const lines = (event: string) => card().history.filter((item) => item.event === event);
  return {
    statePath, logs, lands, requested, deps, card, lines,
    setChild: (fn: ((resultPath: string) => void) | undefined) => { child = fn; },
    setClock: (iso: string) => { clock = new Date(iso); },
  };
}

describe('TA-REVIEW-RESULT-CAPTURE — 떼어 띄운 self review 결과를 파일로 받아 카드로 되돌린다', () => {
  test('detached review completion harvests only its bound TA land card and rejudges once', async () => {
    const f = fixture();
    const resultPath = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true, reviewRequests: [{ pr: 21, head: HEAD, at: '2026-10-10T12:00:00.000Z', resultPath }] }]);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, `${reviewJson()}\n`);
    const env = { [TA_REVIEW_COMPLETION_CARD_ENV]: 'ta-rr-1', [TA_REVIEW_COMPLETION_STATE_ENV]: f.statePath, [TA_REVIEW_COMPLETION_RESULT_ENV]: resultPath };
    const calls: string[] = [];
    expect(await rejudgeCompletedTaskReview(env, async (id, statePath) => { calls.push(`${id}:${statePath}`); return [{ decision: 'would-land', pr: 21, toHead: HEAD }]; })).toBe(true);
    expect(calls).toEqual([`ta-rr-1:${f.statePath}`]);
    expect(f.lines('live-move-result')).toHaveLength(1);
    expect(await rejudgeCompletedTaskReview(env, async () => { calls.push('duplicate'); })).toBe(false);
    expect(calls).toHaveLength(1);
    expect(await rejudgeCompletedTaskReview({ ...env, [TA_REVIEW_COMPLETION_RESULT_ENV]: `${resultPath}.other` }, async () => { calls.push('wrong'); })).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test('review completion still rejudges once when another reader harvested the result first', async () => {
    const f = fixture();
    const resultPath = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true, reviewRequests: [{ pr: 21, head: HEAD, at: '2026-10-10T12:00:00.000Z', resultPath }] }]);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, `${reviewJson()}\n`);
    expect(captureReviewResults(f.statePath, { cardIds: ['ta-rr-1'] }).map((item) => item.status)).toEqual(['captured']);
    const env = { [TA_REVIEW_COMPLETION_CARD_ENV]: 'ta-rr-1', [TA_REVIEW_COMPLETION_STATE_ENV]: f.statePath, [TA_REVIEW_COMPLETION_RESULT_ENV]: resultPath };
    let calls = 0;
    expect(await rejudgeCompletedTaskReview(env, async () => { calls++; return [{ decision: 'would-land', pr: 21, toHead: HEAD }]; })).toBe(true);
    expect(await rejudgeCompletedTaskReview(env, async () => { calls++; })).toBe(false);
    expect(calls).toBe(1);
  });

  test('review completion cannot mark old head after rejudge moved to a newer head', async () => {
    const f = fixture();
    const resultPath = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true, reviewRequests: [{ pr: 21, head: HEAD, at: '2026-10-10T12:00:00.000Z', resultPath }] }]);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, reviewJson());
    const env = { [TA_REVIEW_COMPLETION_CARD_ENV]: 'ta-rr-1', [TA_REVIEW_COMPLETION_STATE_ENV]: f.statePath, [TA_REVIEW_COMPLETION_RESULT_ENV]: resultPath };
    let calls = 0;
    await expect(rejudgeCompletedTaskReview(env, async () => {
      calls++;
      return [{ decision: 'would-regate', pr: 21, toHead: 'c'.repeat(40) }];
    })).rejects.toThrow('head does not match');
    expect(calls).toBe(2);
    expect(f.card().history.some((item) => item.event === 'async-result-rejudge')).toBe(false);
  });

  test('bound review completion records land as a shadow decision with zero live calls', async () => {
    const f = fixture();
    const resultPath = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
    const regatePath = regateResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
    mkdirSync(dirname(resultPath), { recursive: true });
    mkdirSync(dirname(regatePath), { recursive: true });
    writeFileSync(resultPath, reviewJson());
    writeFileSync(regatePath, JSON.stringify({ pr: 21, head: HEAD, passed: true, status: 'passed', baseCommit: 'c'.repeat(40), failures: [] }));
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true,
      reviewRequests: [{ pr: 21, head: HEAD, at: '2026-10-10T12:00:00.000Z', resultPath }],
      regates: [{ pr: 21, head: HEAD, at: '2026-10-10T12:01:00.000Z', resultPath: regatePath }] }]);
    const env = { [TA_REVIEW_COMPLETION_CARD_ENV]: 'ta-rr-1', [TA_REVIEW_COMPLETION_STATE_ENV]: f.statePath, [TA_REVIEW_COMPLETION_RESULT_ENV]: resultPath };
    const live: string[] = [];
    const shadow: Array<Record<string, unknown>> = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => {
      if (event === 'rejudge-shadow' && data && typeof data === 'object') shadow.push(data as Record<string, unknown>);
    });
    try {
      expect(await rejudgeCompletedTaskReview(env, undefined, { liveMoves: new Set(['review', 'propose-land']), live: {
        statePath: f.statePath, repoCandidates: () => [{ source: 'host', cwd: dirname(f.statePath) }],
        prHead: async () => ({ head: HEAD, state: 'OPEN', branch: 'feature', url: 'https://github.com/o/r/pull/21' }),
        requestReview: async () => { live.push('review'); },
        land: async () => { live.push('land'); return { status: 0, stdout: 'merged' }; },
      }, requestRegate: async () => { live.push('regate'); } })).toBe(true);
      expect(shadow).toMatchObject([{ card: 'ta-rr-1', head12: HEAD.slice(0, 12), decision: 'land' }]);
      expect(live).toEqual([]);
      expect(f.card().landAttempts).toBeUndefined();
    } finally { log.mockRestore(); }
  });

  test('review completion does not mark success after the card is rebound during rejudge', async () => {
    const f = fixture();
    const resultPath = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true,
      reviewRequests: [{ pr: 21, head: HEAD, at: '2026-10-10T12:00:00.000Z', resultPath }] }]);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, reviewJson());
    const env = { [TA_REVIEW_COMPLETION_CARD_ENV]: 'ta-rr-1', [TA_REVIEW_COMPLETION_STATE_ENV]: f.statePath, [TA_REVIEW_COMPLETION_RESULT_ENV]: resultPath };
    expect(await rejudgeCompletedTaskReview(env, async () => {
      writeTaskCards(f.statePath, [{ ...f.card(), pr: { number: 22, url: 'https://github.com/o/r/pull/22' } }]);
      return [{ decision: 'would-land', pr: 21, toHead: HEAD }];
    })).toBe(true);
    expect(f.card().history.some((item) => item.event === 'async-result-rejudge')).toBe(false);
  });

  test('review completion releases its claim after a rejudge exception', async () => {
    const f = fixture();
    const resultPath = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true, reviewRequests: [{ pr: 21, head: HEAD, at: '2026-10-10T12:00:00.000Z', resultPath }] }]);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, `${reviewJson()}\n`);
    const env = { [TA_REVIEW_COMPLETION_CARD_ENV]: 'ta-rr-1', [TA_REVIEW_COMPLETION_STATE_ENV]: f.statePath, [TA_REVIEW_COMPLETION_RESULT_ENV]: resultPath };
    let calls = 0;
    expect(await rejudgeCompletedTaskReview(env, async () => {
      expect(f.card().history.some((item) => item.event === 'async-result-rejudge')).toBe(false);
      if (++calls === 1) throw new Error('transient');
      return [{ decision: 'would-land', pr: 21, toHead: HEAD }];
    })).toBe(true);
    expect(calls).toBe(2);
    expect(await rejudgeCompletedTaskReview(env, async () => { calls++; })).toBe(false);
    expect(f.card().history.some((item) => item.event === 'async-result-rejudge' && item.effect === 'completion callback succeeded')).toBe(true);
  });

  test('missing or unreadable review result never records a completed rejudge', async () => {
    for (const unreadable of [false, true]) {
      const f = fixture();
      const resultPath = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
      writeTaskCards(f.statePath, [{ ...f.card(), taLand: true,
        reviewRequests: [{ pr: 21, head: HEAD, at: '2026-10-10T12:00:00.000Z', resultPath }] }]);
      if (unreadable) { mkdirSync(dirname(resultPath), { recursive: true }); mkdirSync(resultPath); }
      const env = { [TA_REVIEW_COMPLETION_CARD_ENV]: 'ta-rr-1', [TA_REVIEW_COMPLETION_STATE_ENV]: f.statePath, [TA_REVIEW_COMPLETION_RESULT_ENV]: resultPath };
      let calls = 0;
      expect(await rejudgeCompletedTaskReview(env, async () => { calls++; })).toBe(false);
      expect(calls).toBe(0);
      expect(f.card().history.some((item) => item.event === 'async-result-rejudge')).toBe(false);
    }
  });

  test('review completion rejects a captured event with the wrong PR or malformed SHA', async () => {
    for (const event of [{ pr: 22, head: HEAD }, { pr: 21, head: 'bad-head' }]) {
      const f = fixture();
      const resultPath = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
      writeTaskCards(f.statePath, [{ ...f.card(), taLand: true,
        reviewRequests: [{ pr: 21, head: HEAD, at: '2026-10-10T12:00:00.000Z', resultPath }],
        history: [...f.card().history, { at: '2026-10-10T12:01:00.000Z', event: 'live-move-result', kind: 'review', resultPath,
          pr: event.pr, head: event.head, reviewed: true, effect: 'review result captured' }] }]);
      const env = { [TA_REVIEW_COMPLETION_CARD_ENV]: 'ta-rr-1', [TA_REVIEW_COMPLETION_STATE_ENV]: f.statePath, [TA_REVIEW_COMPLETION_RESULT_ENV]: resultPath };
      let calls = 0;
      expect(await rejudgeCompletedTaskReview(env, async () => { calls++; })).toBe(false);
      expect(calls).toBe(0);
      expect(f.card().history.some((item) => item.event === 'async-result-rejudge')).toBe(false);
    }
  });

  test('unbound review completion input does not harvest a different pending result', async () => {
    const f = fixture();
    const resultPath = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true,
      reviewRequests: [{ pr: 21, head: HEAD, at: '2026-10-10T12:00:00.000Z', resultPath }] }]);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, reviewJson());
    const env = { [TA_REVIEW_COMPLETION_CARD_ENV]: 'ta-rr-1', [TA_REVIEW_COMPLETION_STATE_ENV]: f.statePath,
      [TA_REVIEW_COMPLETION_RESULT_ENV]: `${resultPath}.unbound` };
    expect(await rejudgeCompletedTaskReview(env)).toBe(false);
    expect(f.card().history.some((item) => item.event === 'live-move-result')).toBe(false);
  });

  test('review completion does not mark a returned failed rejudge as success', async () => {
    const f = fixture();
    const resultPath = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, reviewJson());
    writeTaskCards(f.statePath, [{ ...f.card(), taLand: true,
      reviewRequests: [{ pr: 21, head: HEAD, at: '2026-10-10T12:00:00.000Z', resultPath }] }]);
    const env = { [TA_REVIEW_COMPLETION_CARD_ENV]: 'ta-rr-1', [TA_REVIEW_COMPLETION_STATE_ENV]: f.statePath, [TA_REVIEW_COMPLETION_RESULT_ENV]: resultPath };
    let calls = 0;
    await expect(rejudgeCompletedTaskReview(env, async () => { calls++; return [{ decision: 'land-rejected' }]; })).rejects.toThrow('land-rejected');
    expect(calls).toBe(2);
    await expect(rejudgeCompletedTaskReview(env, async () => { calls++; return [{ ok: false }]; })).rejects.toThrow('ok:false');
    expect(calls).toBe(4);
    expect(f.card().history.some((item) => item.event === 'async-result-rejudge')).toBe(false);
  });

  test('review completion does not mark an empty or missing rejudge decision as success', async () => {
    for (const result of [undefined, []]) {
      const f = fixture();
      const resultPath = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
      mkdirSync(dirname(resultPath), { recursive: true });
      writeFileSync(resultPath, reviewJson());
      writeTaskCards(f.statePath, [{ ...f.card(), taLand: true,
        reviewRequests: [{ pr: 21, head: HEAD, at: '2026-10-10T12:00:00.000Z', resultPath }] }]);
      const env = { [TA_REVIEW_COMPLETION_CARD_ENV]: 'ta-rr-1', [TA_REVIEW_COMPLETION_STATE_ENV]: f.statePath, [TA_REVIEW_COMPLETION_RESULT_ENV]: resultPath };
      await expect(rejudgeCompletedTaskReview(env, async () => result)).rejects.toThrow('no decision');
      expect(f.card().history.some((item) => item.event === 'async-result-rejudge')).toBe(false);
    }
  });

  test('review completion rejects a result after the card PR was rebound', async () => {
    const f = fixture();
    const resultPath = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
    mkdirSync(dirname(resultPath), { recursive: true });
    writeFileSync(resultPath, reviewJson());
    writeTaskCards(f.statePath, [{ ...f.card(), pr: { number: 22, url: 'https://github.com/o/r/pull/22' }, taLand: true,
      reviewRequests: [{ pr: 21, head: HEAD, at: '2026-10-10T12:00:00.000Z', resultPath }] }]);
    const env = { [TA_REVIEW_COMPLETION_CARD_ENV]: 'ta-rr-1', [TA_REVIEW_COMPLETION_STATE_ENV]: f.statePath, [TA_REVIEW_COMPLETION_RESULT_ENV]: resultPath };
    const decisions: string[] = [];
    const log = spyOn(debug, 'log').mockImplementation((_category, event, data) => {
      if (event === 'rejudge-on-head' && data && typeof data === 'object' && 'decision' in data) decisions.push(String(data.decision));
    });
    try {
      expect(await rejudgeCompletedTaskReview(env)).toBe(false);
      expect(decisions).toEqual([]);
      expect(f.card().history.some((item) => item.event === 'async-result-rejudge')).toBe(false);
    } finally { log.mockRestore(); }
  });

  test('parseReviewResultOutput — 섞인 stdout 에서 마지막 JSON 객체 줄 · 못 읽으면 null', () => {
    expect(parseReviewResultOutput(`  → [self-review] noise\n${reviewJson({ mustFix: ['a', 'b'], verdict: 'warn' })}\n`)).toEqual({
      pr: 21, verdict: 'warn', reviewed: true, mustFix: 2, reviewRoute: 'api', head: HEAD, error: null,
    });
    expect(parseReviewResultOutput('{"pr":"21","verd')).toBeNull();
    // 결과 모양이 아닌 JSON 줄(중간 로그 · pr 없는 객체)은 결과로 확정하지 않는다 — 자식이 아직 도는 중일 수 있다.
    expect(parseReviewResultOutput('{"event":"progress","pr":"21"}\n{"level":"info","msg":"x"}')).toBeNull();
    // 오류 결과({pr, error})는 결과다 — 그대로 옮긴다.
    expect(parseReviewResultOutput(JSON.stringify({ pr: '21', error: 'gh failed' }))).toMatchObject({ pr: 21, verdict: null, error: 'gh failed' });
    expect(parseReviewResultOutput('')).toBeNull();
    // must-fix 목록이 아니면 «0» 이 아니라 «모름»(null) · 짧은 머리는 싣지 않는다.
    expect(parseReviewResultOutput(JSON.stringify({ pr: 21, verdict: 'pass', reviewed: true, mustFix: 'x', headCommit: 'abc', error: 'odd' }))).toMatchObject({ mustFix: null, head: null });
  });

  test('PR-LAND-MUSTFIX-NONE — 저장된 mustFix 의 «(없음 — …)» 표지 줄은 리뷰 출력과 같은 판정으로 0 · 진짜 지적은 1 · 빈 배열 0', () => {
    const none = '(없음 — 수용기준 충족: 관문 파서가 리뷰 출력과 같은 판정을 쓴다)';
    expect(parseReviewResultOutput(reviewJson({ mustFix: [none] }))?.mustFix).toBe(0);
    expect(parseReviewResultOutput(reviewJson({ mustFix: ['none'] }))?.mustFix).toBe(0);
    expect(parseReviewResultOutput(reviewJson({ mustFix: ['src/x.ts: 새 export 가 호출부에서 안 불린다'] }))?.mustFix).toBe(1);
    expect(parseReviewResultOutput(reviewJson({ mustFix: [none, 'src/x.ts: 실제 블로커'] }))?.mustFix).toBe(1);
    // 머리가 결함 서술이면 표지가 아니다 — 지적으로 남긴다.
    expect(parseReviewResultOutput(reviewJson({ mustFix: ['(없음 — 하지만 X 가 깨진다)'] }))?.mustFix).toBe(1);
    expect(parseReviewResultOutput(reviewJson({ mustFix: [] }))?.mustFix).toBe(0);
  });

  test('defaultRequestReview — resultPath 가 오면 stdout 만 그 파일로(stdin·stderr 버림 · 떼어 띄움 유지) · 디렉터리를 만든다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ta-review-spawn-'));
    const resultPath = join(dir, 'review-results', 'card-21-bbbbbbbbbbbb.json');
    const seen: Array<{ args: string[]; options: Record<string, unknown> }> = [];
    const fakeSpawn: DetachedSpawn = (_command, args, options) => {
      seen.push({ args, options: options as unknown as Record<string, unknown> });
      return { pid: 4242, once: (event: string, listener: () => void) => { if (event === 'spawn') queueMicrotask(listener); return undefined; }, removeListener: () => undefined, unref: () => undefined } as unknown as ReturnType<DetachedSpawn>;
    };
    await defaultRequestReview(21, 'intent', dir, { spawn: fakeSpawn, entry: '/repo/bin/elanous.mjs', configDir: '/universe', resultPath });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.options.detached).toBe(true);
    const stdio = seen[0]!.options.stdio as unknown[];
    expect(stdio[0]).toBe('ignore');
    expect(typeof stdio[1]).toBe('number');
    expect(stdio[2]).toBe('ignore');
    expect(seen[0]!.args).toContain('--json');
    expect(existsSync(resultPath)).toBe(true);
    // resultPath 가 없으면 종전과 같다(stdio ignore).
    await defaultRequestReview(21, 'intent', dir, { spawn: fakeSpawn, entry: '/repo/bin/elanous.mjs', configDir: '/universe' });
    expect(seen[1]!.options.stdio).toBe('ignore');
  });

  test('review live-move → 결과 파일 생김 → 다음 틱에 결과 줄 ⊕ review-result-captured · 그 결과(pass·must-fix 0)가 land 입력이 된다', async () => {
    const f = fixture();
    f.setChild((path) => writeFileSync(path, `noise line\n${reviewJson()}\n`));
    const first = await recordTaskAgentShadowMove({ runId: 'run-rr', stopReason: 'needs-human', results: [job()] }, f.deps(['review', 'propose-land']));
    const expectedPath = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
    expect(expectedPath).toBe(join(dirname(f.statePath), 'review-results', `ta-rr-1-21-${HEAD.slice(0, 12)}.json`));
    expect(first.move).toBe('review');
    expect(first.liveMove).toMatchObject({ kind: 'review', executed: true, resultPath: expectedPath });
    expect(f.requested).toEqual([{ pr: 21, resultPath: expectedPath }]);
    expect(f.card().reviewRequests).toEqual([{ pr: 21, head: HEAD, at: '2026-10-10T12:00:00.000Z', resultPath: expectedPath }]);
    expect(f.lines('live-move')).toEqual([expect.objectContaining({ kind: 'review', executed: true, resultPath: expectedPath, effect: LIVE_REVIEW_EFFECT_PENDING })]);
    // 같은 틱에는 회수하지 않는다(판단 «전»에 회수) — 결과 줄은 아직 없다.
    expect(f.lines('live-move-result')).toEqual([]);

    f.setClock('2026-10-10T12:05:00.000Z');
    const second = await recordTaskAgentShadowMove({ runId: 'run-rr', stopReason: 'needs-human', results: [job()] }, f.deps(['review', 'propose-land']));
    expect(f.lines('live-move-result')).toEqual([{
      at: '2026-10-10T12:05:00.000Z', event: 'live-move-result', kind: 'review', pr: 21, head: HEAD,
      verdict: 'pass', reviewed: true, mustFix: 0, reviewRoute: 'api', resultPath: expectedPath,
      reviewSha256: repairReviewDigest(readFileSync(expectedPath, 'utf8')),
      effect: 'review result captured · verdict pass · reviewed true · must-fix 0',
    }]);
    expect(f.logs.filter((entry) => entry.event === 'review-result-captured').map((entry) => entry.data)).toEqual([{
      card: 'ta-rr-1', pr: 21, requestedHead: HEAD, head: HEAD, verdict: 'pass', reviewed: true, mustFix: 0, reviewRoute: 'api', resultPath: expectedPath,
    }]);
    // 회수한 결과가 판단부 입력(review=pass)·land 관문 입력(head·mustFixCount)으로 간다 — land 판정 로직은 그대로.
    expect(second.move).toBe('propose-land');
    expect(second.liveMove).toMatchObject({ kind: 'land', executed: true, ok: true });
    expect(f.lands).toEqual([{ pr: 21, head: HEAD }]);
    expect(f.logs.find((entry) => entry.event === 'shadow-move' && entry.data.reviewSource === 'captured-review-result')).toBeDefined();
    // 세 번째 틱 — 이미 회수했으면 줄을 더하지 않는다.
    f.setClock('2026-10-10T12:10:00.000Z');
    await recordTaskAgentShadowMove({ runId: 'run-rr', stopReason: 'needs-human', results: [job()] }, f.deps(['review']));
    expect(f.lines('live-move-result')).toHaveLength(1);
  });

  test('머리가 바뀌면(A→B) 회수한 A 의 pass 를 입력으로 쓰지 않는다 — B 리뷰를 새로 요청한다', async () => {
    const f = fixture();
    const HEAD_B = 'e'.repeat(40);
    let current = HEAD;
    f.setChild((path) => writeFileSync(path, reviewJson()));
    const deps = (moves: TaskAgentLiveMove[]) => { const d = f.deps(moves); return { ...d, live: { ...d.live, prHead: async () => ({ head: current, state: 'OPEN' }), landPrHead: async () => ({ head: current, state: 'OPEN', isDraft: false }) } }; };
    await recordTaskAgentShadowMove({ runId: 'run-rr-ab', stopReason: 'needs-human', results: [job()] }, deps(['review', 'propose-land']));
    current = HEAD_B;
    f.setClock('2026-10-10T12:05:00.000Z');
    const second = await recordTaskAgentShadowMove({ runId: 'run-rr-ab', stopReason: 'needs-human', results: [job()] }, deps(['review', 'propose-land']));
    expect(f.lines('live-move-result')).toEqual([expect.objectContaining({ head: HEAD, verdict: 'pass' })]);
    expect(second.move).toBe('review');
    expect(second.liveMove).toMatchObject({ kind: 'review', executed: true });
    expect(f.requested.map((entry) => entry.resultPath)).toEqual([reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD), reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD_B)]);
    expect(f.lands).toEqual([]);
    expect(f.logs.some((entry) => entry.event === 'shadow-move' && entry.data.reviewSource === 'captured-review-result')).toBe(false);
  });

  test('여러 머리 결과가 역순으로 회수돼도 지금 머리(B)의 pass 를 고른다', () => {
    const f = fixture();
    const HEAD_B = 'e'.repeat(40);
    const pathA = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
    const pathB = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD_B);
    writeTaskCards(f.statePath, [{ ...f.card(), reviewRequests: [
      { pr: 21, head: HEAD, at: '2026-10-10T11:00:00.000Z', resultPath: pathA },
      { pr: 21, head: HEAD_B, at: '2026-10-10T11:10:00.000Z', resultPath: pathB },
    ] }]);
    const files: Record<string, string> = { [pathB]: reviewJson({ headCommit: HEAD_B }) };
    const readFile = (path: string) => { const text = files[path]; if (text === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return text; };
    captureReviewResults(f.statePath, { now: () => new Date('2026-10-10T11:20:00.000Z'), readFile, log: () => {} });
    files[pathA] = reviewJson({ verdict: 'fail', mustFix: ['old'] });
    captureReviewResults(f.statePath, { now: () => new Date('2026-10-10T11:30:00.000Z'), readFile, log: () => {} });
    expect(f.lines('live-move-result').map((line) => line.head)).toEqual([HEAD_B, HEAD]);
    expect(capturedSelfReview(f.card(), 21, HEAD_B)).toEqual({ verdict: 'pass', head: HEAD_B, mustFixCount: 0 });
    expect(capturedSelfReview(f.card(), 21, HEAD)).toBeUndefined();
  });

  test('오류가 섞인 결과(error ⊕ pass)는 pass 후보가 아니다', () => {
    const f = fixture();
    const resultPath = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
    writeTaskCards(f.statePath, [{ ...f.card(), reviewRequests: [{ pr: 21, head: HEAD, at: '2026-10-10T12:00:00.000Z', resultPath }] }]);
    captureReviewResults(f.statePath, { now: () => new Date('2026-10-10T12:10:00.000Z'), readFile: () => reviewJson({ error: 'ACP 리뷰 실행 실패' }), log: () => {} });
    expect(f.lines('live-move-result')).toEqual([expect.objectContaining({ verdict: 'pass', detail: 'ACP 리뷰 실행 실패' })]);
    expect(capturedSelfReview(f.card(), 21, HEAD)).toBeUndefined();
  });

  test('Pod 런(작업 트리 없음)은 런이 낸 머리로 맞춰 본다 — 다르면 쓰지 않는다', async () => {
    const f = fixture();
    const resultPath = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
    writeTaskCards(f.statePath, [{ ...f.card(), reviewRequests: [{ pr: 21, head: HEAD, at: '2026-10-10T11:00:00.000Z', resultPath }] }]);
    const readFile = () => reviewJson();
    captureReviewResults(f.statePath, { now: () => new Date('2026-10-10T11:30:00.000Z'), readFile, log: () => {} });
    const moved = await recordTaskAgentShadowMove({ runId: 'run-rr-pod', stopReason: 'needs-human', results: [job({ worktreePath: undefined, checkedHeadCommit: 'f'.repeat(40) })] }, f.deps(['propose-land']));
    expect(moved.move).toBe('review');
    const same = await recordTaskAgentShadowMove({ runId: 'run-rr-pod', stopReason: 'needs-human', results: [job({ worktreePath: undefined, checkedHeadCommit: HEAD })] }, f.deps([]));
    expect(same.move).toBe('propose-land');
  });

  test('must-fix 가 있는 pass · fail 결과는 줄로 남지만 land 로 넘기지 않는다(관문이 거부 · 판단부 입력은 pass 만)', async () => {
    const f = fixture();
    f.setChild((path) => writeFileSync(path, reviewJson({ verdict: 'fail', mustFix: ['broken'] })));
    await recordTaskAgentShadowMove({ runId: 'run-rr-f', stopReason: 'needs-human', results: [job()] }, f.deps(['review', 'propose-land']));
    f.setClock('2026-10-10T12:05:00.000Z');
    const second = await recordTaskAgentShadowMove({ runId: 'run-rr-f', stopReason: 'needs-human', results: [job()] }, f.deps(['review', 'propose-land']));
    expect(f.lines('live-move-result')).toEqual([expect.objectContaining({ verdict: 'fail', mustFix: 1 })]);
    expect(capturedSelfReview(f.card(), 21, HEAD)).toBeUndefined();
    expect(second.move).toBe('review');
    expect(f.lands).toEqual([]);
  });

  test('결과 파일 없음(자식 사망) → 대기 상한 안엔 줄 없음 · 지난 뒤 «no result» 줄 ⊕ review-result-missing · 지어내지 않는다', async () => {
    const f = fixture();
    f.setChild(undefined);
    await recordTaskAgentShadowMove({ runId: 'run-rr-m', stopReason: 'needs-human', results: [job()] }, f.deps(['review']));
    const resultPath = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
    f.setClock('2026-10-10T12:30:00.000Z');
    const pending = captureReviewResults(f.statePath, { now: () => new Date('2026-10-10T12:30:00.000Z'), log: () => {} });
    expect(pending).toEqual([{ card: 'ta-rr-1', pr: 21, resultPath, status: 'pending' }]);
    expect(f.lines('live-move-result')).toEqual([]);
    f.setClock('2026-10-10T13:31:00.000Z');
    const later = await recordTaskAgentShadowMove({ runId: 'run-rr-m', stopReason: 'needs-human', results: [job()] }, f.deps(['review']));
    expect(f.lines('live-move-result')).toEqual([{
      at: '2026-10-10T13:31:00.000Z', event: 'live-move-result', kind: 'review', pr: 21, head: HEAD, resultPath,
      effect: REVIEW_RESULT_MISSING_EFFECT, detail: 'result file not created after 91m (requested 2026-10-10T12:00:00.000Z)',
    }]);
    expect(f.logs.filter((entry) => entry.event === 'review-result-missing').map((entry) => entry.data)).toEqual([{
      card: 'ta-rr-1', pr: 21, head: HEAD, resultPath, waitedMs: 91 * 60_000, reason: 'result file not created after 91m (requested 2026-10-10T12:00:00.000Z)',
    }]);
    // «결과 없음»은 판단부 입력이 아니다 — 종전처럼 review 수(같은 머리는 다시 안 띄운다).
    expect(later.move).toBe('review');
    expect(later.liveMove).toMatchObject({ executed: false, ok: true });
    // 실패 사유(«마지막 칸») 판정에서 결과 줄은 빠진다.
    expect(nextMoveFor({ ...f.card(), status: 'failed' }).reason).toBe('run-x');
  });

  test('쓰다 만 출력(JSON 줄 없음)도 상한 전엔 «아직» · 지난 뒤엔 사유를 적는다', () => {
    const f = fixture();
    const resultPath = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
    writeTaskCards(f.statePath, [{ ...f.card(), reviewRequests: [{ pr: 21, head: HEAD, at: '2026-10-10T12:00:00.000Z', resultPath }] }]);
    const out = captureReviewResults(f.statePath, { now: () => new Date('2026-10-10T14:00:00.000Z'), readFile: () => '{"pr":"21","verd', log: () => {} });
    expect(out).toEqual([expect.objectContaining({ status: 'missing' })]);
    expect(f.lines('live-move-result')[0]!.detail).toBe('output has no JSON result line after 120m (requested 2026-10-10T12:00:00.000Z)');
  });

  test('결과 파일이 있는데 못 읽으면(EACCES) «결과 없음»이 아니라 «읽기 실패»로 가른다', () => {
    const f = fixture();
    const resultPath = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
    writeTaskCards(f.statePath, [{ ...f.card(), reviewRequests: [{ pr: 21, head: HEAD, at: '2026-10-10T12:00:00.000Z', resultPath }] }]);
    const readFile = () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); };
    captureReviewResults(f.statePath, { now: () => new Date('2026-10-10T14:00:00.000Z'), readFile, log: () => {} });
    expect(f.lines('live-move-result')).toEqual([expect.objectContaining({ effect: REVIEW_RESULT_UNREADABLE_EFFECT, detail: 'EACCES: permission denied after 120m (requested 2026-10-10T12:00:00.000Z)' })]);
  });

  test('다른 PR 의 결과는 확정하지 않는다 — 상한 전엔 «아직» · 지난 뒤엔 불일치 사유로 «no result»', () => {
    const f = fixture();
    const resultPath = reviewResultPath(f.statePath, 'ta-rr-1', 21, HEAD);
    writeTaskCards(f.statePath, [{ ...f.card(), reviewRequests: [{ pr: 21, head: HEAD, at: '2026-10-10T12:00:00.000Z', resultPath }] }]);
    const early = captureReviewResults(f.statePath, { now: () => new Date('2026-10-10T12:10:00.000Z'), readFile: () => reviewJson({ pr: '22' }), log: () => {} });
    expect(early).toEqual([expect.objectContaining({ status: 'pending' })]);
    const late = captureReviewResults(f.statePath, { now: () => new Date('2026-10-10T14:00:00.000Z'), readFile: () => reviewJson({ pr: '22' }), log: () => {} });
    expect(late).toEqual([expect.objectContaining({ status: 'missing' })]);
    expect(f.lines('live-move-result')).toEqual([expect.objectContaining({ effect: REVIEW_RESULT_MISSING_EFFECT, detail: 'result PR 22 does not match requested #21 after 120m (requested 2026-10-10T12:00:00.000Z)' })]);
    expect(f.lines('live-move-result')[0]!.verdict).toBeUndefined();
    expect(capturedSelfReview(f.card(), 21, HEAD)).toBeUndefined();
  });

  test('불변식 — 결과 경로 없는 카드(옛 요청 · 띄우기 실패)는 회수하지 않는다 · 상태 파일·시계를 안 건드린다', () => {
    const f = fixture();
    writeTaskCards(f.statePath, [{ ...f.card(), reviewRequests: [
      { pr: 21, head: HEAD, at: '2026-10-10T01:00:00.000Z' },
      { pr: 21, head: 'c'.repeat(40), at: '2026-10-10T01:00:00.000Z', error: 'ENOENT', resultPath: '/nope/x.json' },
    ] }]);
    const before = readFileSync(f.statePath, 'utf8');
    const mtime = statSync(f.statePath).mtimeMs;
    let clockCalls = 0;
    const out = captureReviewResults(f.statePath, { now: () => { clockCalls++; return new Date('2026-10-11T00:00:00.000Z'); }, log: () => { throw new Error('no observation expected'); } });
    expect(out).toEqual([]);
    expect(clockCalls).toBe(0);
    expect(readFileSync(f.statePath, 'utf8')).toBe(before);
    expect(statSync(f.statePath).mtimeMs).toBe(mtime);
  });

  test('불변식 — 다른 수(propose-green)는 회수와 무관하게 종전 줄 그대로', async () => {
    const f = fixture();
    await recordTaskAgentShadowMove({ runId: 'run-rr-g', stopReason: 'converged', results: [job({ merged: true, worktreePath: undefined })] }, f.deps(['propose-green']));
    expect(f.lines('live-move')).toEqual([{
      at: '2026-10-10T12:00:00.000Z', event: 'live-move', kind: 'propose-green', executed: true, ok: true, executorResult: 'live',
      detail: 'green proposed (#21) · checklist untouched', runId: 'run-rr-g', pr: 21, effect: 'green proposed · checklist CELL-R (checklist untouched)',
    }]);
    expect(f.lines('live-move-result')).toEqual([]);
  });
});

test('TA-REVIEW-RESULT-CAPTURE — 결과 파일을 못 열면(디렉터리 자리에 파일) 리뷰는 종전처럼 stdio ignore 로 띄운다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ta-review-spawn-blocked-'));
  writeFileSync(join(dir, 'review-results'), 'not a directory');
  const seen: unknown[] = [];
  const fakeSpawn: DetachedSpawn = (_command, _args, options) => {
    seen.push((options as unknown as { stdio: unknown }).stdio);
    return { pid: 1, once: (event: string, listener: () => void) => { if (event === 'spawn') queueMicrotask(listener); return undefined; }, removeListener: () => undefined, unref: () => undefined } as unknown as ReturnType<DetachedSpawn>;
  };
  await defaultRequestReview(21, 'intent', dir, { spawn: fakeSpawn, entry: '/repo/bin/elanous.mjs', configDir: '/universe', resultPath: join(dir, 'review-results', 'x.json') });
  expect(seen).toEqual(['ignore']);
});
