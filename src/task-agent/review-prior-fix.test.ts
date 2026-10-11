import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { executeLiveReview, type LiveMoveDeps } from './live-moves.js';
import { parseNumstat, PRIOR_FIX_SCOPE_LINE, PRIOR_RESULT_NOT_RECOVERED, readPriorMustFix } from './review-prior-fix.js';
import { readTaskCard, writeTaskCards, type TaskCard } from './task-hand.js';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const PR = 26030;

function fixture() {
  const statePath = join(mkdtempSync(join(tmpdir(), 'ta-prior-fix-')), 'task-agent-actions.json');
  const card: TaskCard = { id: 'TA-PRIOR-1', text: 'TA-LIVE-LAND-PROOF\n수용기준 본문', createdAt: '2026-10-11T00:00:00.000Z', status: 'launched', history: [] };
  writeTaskCards(statePath, [card]);
  const reviews: Array<{ pr: number; intent: string; resultPath?: string }> = [];
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const diffCalls: Array<{ cwd?: string; from: string; to: string }> = [];
  let head = HEAD_A;
  const deps: LiveMoveDeps = {
    statePath,
    prHead: async () => ({ head, state: 'OPEN' }),
    requestReview: async (pr, intent, _cwd, capture) => { reviews.push({ pr, intent, ...(capture ? { resultPath: capture.resultPath } : {}) }); },
    priorDiff: (cwd, from, to) => { diffCalls.push({ ...(cwd ? { cwd } : {}), from, to }); return parseNumstat('12\t3\tsrc/task-agent/live-moves.ts\n4\t0\tsrc/task-agent/live-moves.test.ts\n'); },
    log: (_c, event, data) => { logs.push({ event, data }); },
  };
  const review = () => executeLiveReview(readTaskCard('TA-PRIOR-1', statePath), PR, { runId: 'run-1', stopReason: 'rejudge-on-head', cwd: '/tmp/wt-prior' }, deps);
  return { statePath, reviews, logs, diffCalls, review, setHead: (next: string) => { head = next; } };
}

const writeResult = (path: string, body: Record<string, unknown>) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `progress line\n${JSON.stringify(body)}\n`);
};

describe('REVIEW-CONVERGE-PRIOR-FIX — TA 재리뷰가 직전 라운드를 싣는다', () => {
  test('첫 리뷰 → 직전 반영분은 종전 문면 바이트 그대로 · 관측 없음', async () => {
    const f = fixture();
    const result = await f.review();
    expect(result.executed).toBe(true);
    expect(f.reviews[0]!.intent).toBe([
      '목표: TA-LIVE-LAND-PROOF',
      '수용기준: 과제 카드 TA-PRIOR-1 원문 —\nTA-LIVE-LAND-PROOF\n수용기준 본문',
      '직전 반영분: 런 run-1 이 rejudge-on-head 로 멈춤 — 수확 가능',
      '의도적 범위 경계: task-agent live review 요청(TA-JUDGE-LIVE-SAFE) — 리뷰만 한다 · 착지·재발사는 이 요청의 결정이 아니다',
    ].join('\n'));
    expect(f.diffCalls).toHaveLength(0);
    expect(f.logs.some((entry) => entry.event === 'review-prior-fix-filled')).toBe(false);
  });

  test('두 번째 리뷰 → 직전 must-fix ⊕ head 범위 ⊕ diff 요약 ⊕ 스코프 경계 줄이 intent 에 실린다 · 관측 한 줄', async () => {
    const f = fixture();
    await f.review();
    writeResult(f.reviews[0]!.resultPath!, { pr: PR, verdict: 'fail', reviewed: true, headCommit: HEAD_A, mustFix: ['한 argv 안 install helper', '경고 문면을 구현 상수와 비교(Goodhart)'] });
    f.setHead(HEAD_B);
    const second = await f.review();
    expect(second.executed).toBe(true);
    const intent = f.reviews[1]!.intent;
    expect(intent).toContain(`직전 리뷰 머리 → 지금 머리: ${HEAD_A.slice(0, 12)} → ${HEAD_B.slice(0, 12)}`);
    expect(intent).toContain('그 사이 바뀐 것: 파일 2개 · +16 −3');
    expect(intent).toContain('src/task-agent/live-moves.ts (+12 −3)');
    expect(intent).toContain('직전 리뷰 must-fix 2건:');
    expect(intent).toContain('1. 한 argv 안 install helper');
    expect(intent).toContain('2. 경고 문면을 구현 상수와 비교(Goodhart)');
    expect(intent).toContain(PRIOR_FIX_SCOPE_LINE);
    // 블록 순서 — 직전 반영분 안에 diff·must-fix, 범위 경계 다음에 스코프 줄.
    expect(intent.indexOf('직전 반영분:')).toBeLessThan(intent.indexOf('직전 리뷰 must-fix'));
    expect(intent.indexOf('의도적 범위 경계:')).toBeLessThan(intent.indexOf(PRIOR_FIX_SCOPE_LINE));
    expect(f.diffCalls).toEqual([{ cwd: '/tmp/wt-prior', from: HEAD_A, to: HEAD_B }]);
    expect(f.logs.filter((entry) => entry.event === 'review-prior-fix-filled').map((entry) => entry.data)).toEqual([
      expect.objectContaining({ card: 'TA-PRIOR-1', pr: PR, fromHead: HEAD_A, toHead: HEAD_B, priorMustFix: 2 }),
    ]);
  });

  test('직전 결과 파일 없음 → 빈 칸이 아니라 «직전 결과 미회수» 표시 · 관측 priorMustFix null', async () => {
    const f = fixture();
    await f.review();
    f.setHead(HEAD_B);
    await f.review();
    const intent = f.reviews[1]!.intent;
    expect(intent).toContain(`직전 리뷰 must-fix: ${PRIOR_RESULT_NOT_RECOVERED} (result file not created)`);
    expect(intent).not.toContain('must-fix: 0건');
    expect(intent).toContain(PRIOR_FIX_SCOPE_LINE);
    expect(f.logs.find((entry) => entry.event === 'review-prior-fix-filled')?.data).toMatchObject({ priorMustFix: null, priorResult: 'not-recovered' });
  });

  test('diff 를 못 재면 «diff 미측정» · 띄우기 오류가 난 직전 요청은 직전 라운드로 안 친다', async () => {
    const f = fixture();
    await f.review();
    // 첫 요청을 오류로 표시 — 리뷰가 안 돌았다.
    const { updateTaskCard } = await import('./task-hand.js');
    updateTaskCard(f.statePath, 'TA-PRIOR-1', (current) => current ? { ...current, reviewRequests: current.reviewRequests!.map((entry) => ({ ...entry, error: 'spawn ENOENT' })) } : undefined);
    f.setHead(HEAD_B);
    await f.review();
    expect(f.reviews[1]!.intent).not.toContain(PRIOR_FIX_SCOPE_LINE);
    const g = fixture();
    await g.review();
    g.setHead(HEAD_B);
    await executeLiveReview(readTaskCard('TA-PRIOR-1', g.statePath), PR, { runId: 'run-1', stopReason: 'rejudge-on-head', cwd: '/tmp/wt-prior' },
      { statePath: g.statePath, prHead: async () => ({ head: HEAD_B, state: 'OPEN' }), priorDiff: () => null, requestReview: async (pr, intent) => { g.reviews.push({ pr, intent }); }, log: () => {} });
    expect(g.reviews[1]!.intent).toContain('그 사이 바뀐 것: diff 미측정');
  });

  test('결과 파일 해석 — 다른 PR · 리뷰 오류 · reviewed:false 는 미회수 · must-fix 0 은 0건', () => {
    const at = (body: unknown) => () => `${JSON.stringify(body)}\n`;
    expect(readPriorMustFix('/x', PR, at({ pr: PR, verdict: 'pass', reviewed: true, mustFix: [] }))).toEqual({ status: 'recovered', items: [] });
    expect(readPriorMustFix('/x', PR, at({ pr: 1, verdict: 'pass', mustFix: [] })).status).toBe('not-recovered');
    expect(readPriorMustFix('/x', PR, at({ pr: PR, error: 'boom' })).status).toBe('not-recovered');
    expect(readPriorMustFix('/x', PR, at({ pr: PR, verdict: 'fail', reviewed: false, mustFix: [] })).status).toBe('not-recovered');
    expect(readPriorMustFix(undefined, PR).status).toBe('not-recovered');
  });
});
