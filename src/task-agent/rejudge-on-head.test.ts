import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { landOrderLedgerPath } from './land-order-ledger.js';
import { classifyLandFailure, liveLandArgs, type TaskAgentLiveMove } from './live-moves.js';
import { defaultRequestRegate, overlapEvidencePath, parseRegateResult, REJUDGE_HEAD_CAP, regateResultPath, regateRunArgs, rejudgeCandidates, rejudgeCardOnHead, type RegateRequest } from './rejudge-on-head.js';
import { reviewResultPath } from './review-result-capture.js';
import { readTaskCard, writeTaskCards, type TaskCard } from './task-hand.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const D = 'd'.repeat(40);
const E = 'e'.repeat(40);
const F = 'f'.repeat(40);
const URL = 'https://github.com/o/r/pull/30';
const reviewJson = (head: string, over: Record<string, unknown> = {}) => JSON.stringify({ pr: '30', verdict: 'pass', mustFix: [], shouldFix: [], reviewed: true, reviewRoute: 'api', headCommit: head, ...over });

function fixture(opts: { regates?: TaskCard['regates']; landAttempts?: TaskCard['landAttempts'] } = {}) {
  const statePath = join(mkdtempSync(join(tmpdir(), 'ta-rejudge-')), 'task-agent-actions.json');
  const pathA = reviewResultPath(statePath, 'ta-rj-1', 30, A);
  // 런 멈춤 때: 머리 A 리뷰 요청 ⊕ 회수(fail · must-fix 2) — #26030 실측 꼴.
  const seed: TaskCard = {
    id: 'ta-rj-1', text: 'feature ask', checklistId: 'CELL-RJ', createdAt: '2026-10-11T00:00:00.000Z', status: 'launched', runId: 'run-rj',
    pr: { number: 30, url: URL },
    reviewRequests: [{ pr: 30, head: A, at: '2026-10-11T00:10:00.000Z', resultPath: pathA }],
    history: [{ at: '2026-10-11T00:20:00.000Z', event: 'live-move-result', kind: 'review', pr: 30, head: A, verdict: 'fail', reviewed: true, mustFix: 2, reviewRoute: 'api', resultPath: pathA, effect: 'review result captured · verdict fail · reviewed true · must-fix 2' }],
    ...(opts.regates ? { regates: opts.regates } : {}),
    ...(opts.landAttempts ? { landAttempts: opts.landAttempts } : {}),
  };
  writeTaskCards(statePath, [seed]);
  let head = A;
  let clock = new Date('2026-10-11T01:00:00.000Z');
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const regateRequests: RegateRequest[] = [];
  const reviewRequests: Array<{ pr: number; resultPath?: string }> = [];
  const lands: Array<{ pr: number; head: string; overlapEvidence?: string }> = [];
  let regateOutcome: ((request: RegateRequest) => void) | undefined;
  let reviewOutcome: ((path: string) => void) | undefined;
  // TA-LAND-RETRY-ON-INFRA — land 결과 차례(비면 병합 성공).
  const landOutcomes: Array<{ status: number; stdout: string; stderr?: string }> = [];
  const deps = (moves: TaskAgentLiveMove[] = ['review', 'propose-land']) => ({
    liveMoves: new Set(moves),
    log: (_c: string, event: string, data: Record<string, unknown>) => { logs.push({ event, data }); },
    requestRegate: async (request: RegateRequest) => { regateRequests.push(request); regateOutcome?.(request); },
    live: {
      statePath,
      now: () => clock,
      repoCandidates: () => [{ source: 'host' as const, cwd: '/repo' }],
      prHead: async () => ({ head, state: 'OPEN', url: URL }),
      requestReview: async (pr: number, _intent: string, _cwd?: string, capture?: { resultPath: string }) => {
        reviewRequests.push({ pr, ...(capture ? { resultPath: capture.resultPath } : {}) });
        if (capture && reviewOutcome) { mkdirSync(dirname(capture.resultPath), { recursive: true }); reviewOutcome(capture.resultPath); }
      },
      landPrHead: async () => ({ head, state: 'OPEN', isDraft: false, url: URL }),
      land: async (pr: number, landHead: string, _cwd: string, o?: { overlapEvidence?: string }) => {
        lands.push({ pr, head: landHead, ...(o?.overlapEvidence ? { overlapEvidence: o.overlapEvidence } : {}) });
        return landOutcomes.shift() ?? { status: 0, stdout: 'merged' };
      },
    },
  });
  const writeRegate = (passed: boolean, over: Record<string, unknown> = {}) => (request: RegateRequest) => {
    mkdirSync(dirname(request.resultPath), { recursive: true });
    writeFileSync(request.resultPath, JSON.stringify({ pr: request.pr, head: request.head, passed, status: passed ? 'passed' : 'failed', ...(passed ? { baseCommit: BASE } : {}), failures: passed ? [] : [{ step: 'typecheck', detail: 'error TS1' }], ...over }));
  };
  return {
    statePath, logs, regateRequests, reviewRequests, lands, deps, writeRegate,
    card: () => readTaskCard('ta-rj-1', statePath)!,
    setHead: (value: string) => { head = value; },
    setClock: (iso: string) => { clock = new Date(iso); },
    onRegate: (fn: typeof regateOutcome) => { regateOutcome = fn; },
    onReview: (fn: typeof reviewOutcome) => { reviewOutcome = fn; },
    queueLand: (...next: typeof landOutcomes) => { landOutcomes.push(...next); },
    decisions: () => logs.filter((entry) => entry.event === 'rejudge-on-head').map((entry) => `${entry.data.step}:${entry.data.decision}`),
  };
}

describe('TA-REJUDGE-ON-HEAD — 런 멈춤 뒤 머리가 바뀌면 재게이트·리뷰·land 를 다시 판단한다', () => {
  test('머리 그대로(A) → 재게이트 0 · 리뷰 재요청 0 · land 0', async () => {
    const f = fixture();
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toEqual([]);
    expect(f.reviewRequests).toEqual([]);
    expect(f.lands).toEqual([]);
    expect(f.decisions()).toEqual(['target:head-unchanged']);
  });

  test('머리 A→B → 재게이트 1회 ⊕ 리뷰 재요청 1회 · 같은 머리 다음 틱은 0회', async () => {
    const f = fixture();
    f.setHead(B);
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toEqual([{ card: 'ta-rj-1', pr: 30, head: B, repoRoot: '/repo', resultPath: regateResultPath(f.statePath, 'ta-rj-1', 30, B) }]);
    expect(f.reviewRequests).toEqual([{ pr: 30, resultPath: reviewResultPath(f.statePath, 'ta-rj-1', 30, B) }]);
    expect(f.decisions()).toEqual(['regate:regate-requested', 'review:review-requested']);
    expect(f.card().regates).toEqual([{ pr: 30, head: B, at: '2026-10-11T01:00:00.000Z', resultPath: regateResultPath(f.statePath, 'ta-rj-1', 30, B) }]);
    expect(f.card().history.filter((item) => item.event === 'rejudge-on-head').map((item) => `${item.kind}:${item.effect}`)).toEqual(['regate:regate-requested', 'review:review-requested']);
    expect(f.logs.find((entry) => entry.event === 'rejudge-on-head')?.data).toMatchObject({ card: 'ta-rj-1', pr: 30, fromHead: A, toHead: B, step: 'regate' });
    f.setClock('2026-10-11T01:05:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toHaveLength(1);
    expect(f.reviewRequests).toHaveLength(1);
    expect(f.lands).toEqual([]);
  });

  test('재게이트 fail → 리뷰가 pass ⊕ must-fix 0 이어도 land 0', async () => {
    const f = fixture();
    f.setHead(B);
    f.onRegate(f.writeRegate(false));
    f.onReview((path) => writeFileSync(path, reviewJson(B)));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:10:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.card().regates?.[0]).toMatchObject({ head: B, passed: false, status: 'failed', detail: 'typecheck: error TS1' });
    expect(f.lands).toEqual([]);
    expect(f.decisions()).toContain('land:not-landing');
  });

  test('재게이트 pass ⊕ 리뷰 must-fix 1 → land 0', async () => {
    const f = fixture();
    f.setHead(B);
    f.onRegate(f.writeRegate(true));
    f.onReview((path) => writeFileSync(path, reviewJson(B, { verdict: 'pass', mustFix: ['still broken'] })));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:10:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.card().regates?.[0]).toMatchObject({ passed: true, baseCommit: BASE });
    expect(f.lands).toEqual([]);
    expect(f.card().history.find((item) => item.event === 'rejudge-on-head' && item.kind === 'land')?.detail).toContain('must-fix 1');
  });

  test('재게이트 pass ⊕ 지금 머리 pass ⊕ must-fix 0 → land 한 번 · --overlap-evidence 파일 내용이 맞다', async () => {
    const f = fixture();
    f.setHead(B);
    f.onRegate(f.writeRegate(true));
    f.onReview((path) => writeFileSync(path, reviewJson(B)));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:10:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    const evidence = overlapEvidencePath(f.statePath, 'ta-rj-1', 30, B);
    expect(f.lands).toEqual([{ pr: 30, head: B, overlapEvidence: evidence }]);
    expect(JSON.parse(readFileSync(evidence, 'utf8'))).toEqual({
      pr: 30, head: B, gate: { head: B, baseCommit: BASE, passed: true }, reviewResult: reviewResultPath(f.statePath, 'ta-rj-1', 30, B),
    });
    expect(f.decisions().at(-1)).toBe('land:landed');
    // 다음 틱 — 같은 머리는 다시 land 하지 않는다(executeLiveLand 의 머리 이력).
    f.setClock('2026-10-11T01:20:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands).toHaveLength(1);
  });

  // LAND-ORDER-LEDGER — land 단계 뒤 원장 한 줄(executeLiveLand 직후 append · 같은 pr+head 는 한 줄).
  test('LAND-ORDER-LEDGER — land 단계 뒤 원장 1행(pr·head·cardId·gateBase·리뷰 판정·land 결과 · 관측 appended)', async () => {
    const f = fixture();
    // 머리는 40자 hex sha — 다른 시험과 머리(주기 표시)가 겹치지 않게 새 조합을 쓴다.
    const G = 'a1'.repeat(20);
    f.setHead(G);
    f.onRegate(f.writeRegate(true));
    f.onReview((path) => writeFileSync(path, reviewJson(G)));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:10:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    const rows = readFileSync(landOrderLedgerPath(f.statePath), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows).toEqual([{ pr: 30, head: G, cardId: 'ta-rj-1', gateBase: BASE, reviewVerdict: 'pass', mustFix: 0, landOk: true, landClass: null, at: '2026-10-11T01:10:00.000Z' }]);
    expect(f.logs.filter((entry) => entry.event === 'appended' || entry.event === 'append-failed'))
      .toEqual([{ event: 'appended', data: { pr: 30, head: G } }]);
  });

  // TA-LAND-RETRY-ON-INFRA — #26030 실측 재현(10-11 04:30): 첫 land 가 TA 쪽 인프라 결손으로 죽고 같은 머리 재시도가 막혔다.
  const EXPECTED_HEAD_LOCAL = '✗ expected-head: PR OPEN non-draft, matching local HEAD and clean worktree required';
  // 주기 표시(`rejudge:<card>:<head>`)는 모듈 전역이다 — 시험마다 다른 새 머리를 써서 앞 시험의 착지 주기와 겹치지 않게.
  const readyB = async (f: ReturnType<typeof fixture>, head: string) => {
    f.setHead(head);
    f.onRegate(f.writeRegate(true));
    f.onReview((path) => writeFileSync(path, reviewJson(head)));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:10:00.000Z');
  };

  test('TA-LAND-RETRY-ON-INFRA — infra 로 죽은 land 는 다음 틱에 같은 머리로 한 번 더 · 성공하면 landed', async () => {
    const f = fixture();
    await readyB(f, D);
    f.queueLand({ status: 1, stdout: '', stderr: EXPECTED_HEAD_LOCAL });
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.decisions().at(-1)).toBe('land:land-rejected');
    const rejected = f.logs.filter((entry) => entry.event === 'rejudge-on-head').at(-1)!.data.reason as string;
    expect(rejected).toContain('land-class infra (precondition-local-head-clean-tree) · attempt 1 · retry allowed on this head');
    f.setClock('2026-10-11T01:20:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands.map((entry) => entry.head)).toEqual([D, D]);
    expect(f.decisions().at(-1)).toBe('land:landed');
    expect(f.card().landAttempts?.map((entry) => [entry.ok, entry.class ?? null])).toEqual([[false, 'infra'], [true, null]]);
  });

  test('TA-LAND-RETRY-ON-INFRA — infra 두 번이면 세 번째 틱은 land 0', async () => {
    const f = fixture();
    await readyB(f, E);
    f.queueLand({ status: 1, stdout: '', stderr: EXPECTED_HEAD_LOCAL }, { status: 1, stdout: '', stderr: EXPECTED_HEAD_LOCAL });
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:20:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:30:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands).toHaveLength(2);
    expect(f.decisions().at(-1)).toBe('land:land-rejected');
    expect(f.card().landAttempts?.map((entry) => [entry.ok, entry.class])).toEqual([[false, 'infra'], [false, 'infra']]);
  });

  test('TA-LAND-RETRY-ON-INFRA — judgement 로 거절된 land 는 같은 머리 재시도 0', async () => {
    const f = fixture();
    await readyB(f, F);
    f.queueLand({ status: 1, stdout: '', stderr: '✗ expected-head: overlap merge approval unavailable for the reviewed head' });
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.logs.filter((entry) => entry.event === 'rejudge-on-head').at(-1)!.data.reason).toContain('land-class judgement');
    f.setClock('2026-10-11T01:20:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands).toHaveLength(1);
  });

  test('TA-LAND-RETRY-ON-INFRA — 판단한 머리(A) 그대로여도 그 머리 land 가 infra 로 죽어 재시도가 남았으면 재게이트부터 다시 간다 · judgement 면 head-unchanged', async () => {
    const infra = fixture({ landAttempts: [{ pr: 30, head: A, at: '2026-10-11T00:30:00.000Z', ok: false, detail: EXPECTED_HEAD_LOCAL, class: 'infra', reason: 'precondition-local-head-clean-tree' }] });
    await rejudgeCardOnHead('ta-rj-1', infra.deps());
    expect(infra.decisions()).not.toContain('target:head-unchanged');
    expect(infra.regateRequests.map((request) => request.head)).toEqual([A]);
    const judged = fixture({ landAttempts: [{ pr: 30, head: A, at: '2026-10-11T00:30:00.000Z', ok: false, detail: 'x', class: 'judgement', reason: 'x' }] });
    await rejudgeCardOnHead('ta-rj-1', judged.deps());
    expect(judged.decisions()).toEqual(['target:head-unchanged']);
  });

  // REJUDGE base-stale — `pr land --overlap-evidence` 가 «재게이트 뒤 main 이 PR 파일을 건드리며 움직였다»로 거절하면(#26060),
  //   같은 머리라도 새 base 위에서 재게이트를 한 번 더 청하고, 그 결과 base 로 증거를 다시 써 다음 틱에 land 한다.
  const BASE2 = '0'.repeat(40);
  const STALE_LAND = {
    status: 1, stdout: '',
    stderr: [
      `✗ overlap-evidence: base-stale-overlap: gate ${BASE.slice(0, 12)} ≠ origin/main ${BASE2.slice(0, 12)} · 1/2 window commits touch PR files (${BASE2.slice(0, 12)}): src/x.ts`,
      '✗ expected-head: overlap merge approval unavailable for the reviewed head',
    ].join('\n'),
  };
  const lastReason = (f: ReturnType<typeof fixture>) => f.logs.filter((entry) => entry.event === 'rejudge-on-head').at(-1)!.data.reason as string;

  test('REJUDGE base-stale — classifyLandFailure: base-stale-overlap(⊕ 딸린 expected-head 줄)는 «base-stale» 갈래 · 다른 ✗ 줄이 섞이면 judgement', () => {
    expect(classifyLandFailure(STALE_LAND)).toMatchObject({ class: 'base-stale' });
    expect(classifyLandFailure(STALE_LAND).reason).toStartWith('base-stale-overlap:');
    expect(classifyLandFailure({ ...STALE_LAND, stderr: `${STALE_LAND.stderr}\n✗ typecheck: blocked` }).class).toBe('judgement');
    expect(classifyLandFailure({ status: 1, stdout: '', stderr: '✗ overlap-evidence: base-window-unmeasured: x' }).class).toBe('judgement');
  });

  test('REJUDGE base-stale — land 가 base-stale-overlap 이면 같은 머리 재게이트 1 → 통과 → land 재시도 1(새 base 증거)', async () => {
    const f = fixture();
    const H = '4'.repeat(40);
    await readyB(f, H);
    f.queueLand(STALE_LAND);
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands).toHaveLength(1);
    expect(f.decisions().at(-1)).toBe('land:land-rejected');
    expect(lastReason(f)).toContain('land-class base-stale');
    expect(f.card().landAttempts?.map((entry) => [entry.ok, entry.class])).toEqual([[false, 'base-stale']]);
    expect(f.card().history.filter((item) => item.event === 'land-retry-on-infra').at(-1)).toMatchObject({ kind: 'base-stale', effect: 'awaiting-regate' });
    // 다음 틱 — 새 base 위 재게이트를 한 번 청한다(관측: step regate · reason base-stale-overlap).
    f.onRegate(f.writeRegate(true, { baseCommit: BASE2 }));
    f.setClock('2026-10-11T01:20:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests.map((request) => request.head)).toEqual([H, H]);
    expect(f.regateRequests[1]!.resultPath).not.toBe(f.regateRequests[0]!.resultPath);
    expect(f.lands).toHaveLength(1);
    const regateLog = f.logs.filter((entry) => entry.event === 'rejudge-on-head' && entry.data.step === 'regate').at(-1)!.data;
    expect(regateLog).toMatchObject({ step: 'regate', decision: 'regate-requested', toHead: H });
    expect(regateLog.reason as string).toStartWith('base-stale-overlap');
    expect(f.card().regates?.filter((entry) => entry.head === H).at(-1)).toMatchObject({ staleBase: BASE });
    // 그다음 틱 — 재게이트 통과(base BASE2) → 새 증거로 land 재시도 1.
    f.setClock('2026-10-11T01:30:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands.map((entry) => entry.head)).toEqual([H, H]);
    expect(f.decisions().at(-1)).toBe('land:landed');
    expect(JSON.parse(readFileSync(overlapEvidencePath(f.statePath, 'ta-rj-1', 30, H), 'utf8')).gate).toEqual({ head: H, baseCommit: BASE2, passed: true });
    expect(f.card().landAttempts?.map((entry) => [entry.ok, entry.class ?? null])).toEqual([[false, 'base-stale'], [true, null]]);
    f.setClock('2026-10-11T01:40:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands).toHaveLength(2);
    expect(f.regateRequests).toHaveLength(2);
  });

  test('REJUDGE base-stale — 같은 머리·같은 base 로는 재게이트를 두 번 안 한다(틱 반복 · 결과 base 가 그대로면 land 도 0)', async () => {
    const f = fixture();
    const H = '45'.repeat(20);
    await readyB(f, H);
    f.queueLand(STALE_LAND);
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.onRegate(undefined);
    f.setClock('2026-10-11T01:20:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:25:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toHaveLength(2);
    expect(f.decisions()).toContain('regate:awaiting-regate-result');
    // 재게이트가 «같은» base(BASE)로 돌아왔다 — 새 base 가 아니다: land 0 · 재게이트 0 · 사유 줄.
    f.writeRegate(true, { baseCommit: BASE })(f.regateRequests[1]!);
    f.setClock('2026-10-11T01:30:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:40:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toHaveLength(2);
    expect(f.lands).toHaveLength(1);
    expect(f.decisions().at(-1)).toBe('land:not-landing');
    expect(lastReason(f)).toContain('base-stale-overlap');
  });

  test(`REJUDGE base-stale — 재요청도 상한(${REJUDGE_HEAD_CAP})에 든다 · 넘으면 멈춤 ⊕ 사유`, async () => {
    const H = '46'.repeat(20);
    const f = fixture({
      regates: [
        ...['1', '2'].map((d) => ({ pr: 30, head: d.repeat(40), at: '2026-10-11T00:30:00.000Z', passed: false, status: 'failed' })),
        { pr: 30, head: H, at: '2026-10-11T00:40:00.000Z', passed: true, status: 'passed', baseCommit: BASE },
      ],
      landAttempts: [{ pr: 30, head: H, at: '2026-10-11T00:50:00.000Z', ok: false, detail: STALE_LAND.stderr, class: 'base-stale' as 'judgement', reason: 'base-stale-overlap: gate x' }],
    });
    f.setHead(H);
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toEqual([]);
    expect(f.lands).toEqual([]);
    expect(f.decisions()).toEqual(['regate:cap-reached']);
    expect(lastReason(f)).toContain('base-stale-overlap');
    expect(f.card().history.at(-1)).toMatchObject({ event: 'rejudge-on-head', kind: 'regate', effect: 'cap-reached', head: H });
  });

  test('REJUDGE base-stale — base-advanced-disjoint 로 통과한 land 는 종전대로 landed · 재게이트 재요청 0', async () => {
    const f = fixture();
    const H = '47'.repeat(20);
    await readyB(f, H);
    f.queueLand({ status: 0, stdout: `✓ overlap-evidence: base-advanced-disjoint — gate base ${BASE.slice(0, 12)} ⊂ head ${H.slice(0, 12)}` });
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.decisions().at(-1)).toBe('land:landed');
    f.setClock('2026-10-11T01:20:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toHaveLength(1);
    expect(f.lands).toHaveLength(1);
  });

  test('재게이트 결과에 baseCommit 이 없으면 증거가 불완전 — land 0 · 사유 줄', async () => {
    const f = fixture();
    f.setHead(B);
    f.onRegate((request) => { f.writeRegate(true)(request); writeFileSync(request.resultPath, JSON.stringify({ pr: 30, head: B, passed: true, status: 'passed', failures: [] })); });
    f.onReview((path) => writeFileSync(path, reviewJson(B)));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:10:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands).toEqual([]);
    expect(f.card().history.at(-1)).toMatchObject({ event: 'rejudge-on-head', kind: 'land', effect: 'not-landing' });
    expect(f.card().history.at(-1)!.detail).toContain('regate baseCommit missing');
  });

  test('증거 파일을 못 쓰면 land 0(종전 인자로 부르지 않는다)', async () => {
    const f = fixture();
    writeFileSync(join(dirname(f.statePath), 'overlap-evidence'), 'not a directory');
    f.setHead(B);
    f.onRegate(f.writeRegate(true));
    f.onReview((path) => writeFileSync(path, reviewJson(B)));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:10:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands).toEqual([]);
    expect(f.card().history.at(-1)!.detail).toContain('overlap evidence write failed');
  });

  test('B 재게이트 결과가 나오기 전에 머리가 C 로 바뀌어도 B 결과는 카드에 회수되고 C 는 따로 판단된다', async () => {
    const f = fixture();
    const C = 'd'.repeat(40);
    f.setHead(B);
    f.onRegate(f.writeRegate(true));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setHead(C);
    f.setClock('2026-10-11T01:10:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.card().regates?.map((entry) => [entry.head, entry.passed])).toEqual([[B, true], [C, undefined]]);
    expect(f.regateRequests.map((request) => request.head)).toEqual([B, C]);
    expect(f.decisions()).toContain('regate:regate-passed');
  });

  // TA-LAND-WARN-MUSTFIX0 — 회수 결과의 land 판정은 정본 규칙: verdict ∈ {pass, warn} ⊕ reviewed ⊕ must-fix 숫자 0 ⊕ 그 머리.
  test.each([
    ['warn ⊕ must-fix 0 ⊕ reviewed → land 1', { verdict: 'warn' }, 1, '5'],
    ['warn ⊕ must-fix 1 → land 0', { verdict: 'warn', mustFix: ['x'] }, 0, '6'],
    ['warn ⊕ must-fix unknown → land 0', { verdict: 'warn', mustFix: [1] }, 0, '7'],
    ['pass ⊕ must-fix 0 → land 1 (unchanged)', { verdict: 'pass' }, 1, '8'],
    ['fail → land 0', { verdict: 'fail' }, 0, '9'],
    ['warn ⊕ must-fix 0 but reviewed:false → land 0', { verdict: 'warn', reviewed: false }, 0, 'e'],
  ] as const)('rejudge land: %s', async (_name, over, lands, digit) => {
    // 머리를 사례마다 다르게 — land 의 «주기당 한 번»(모듈 범위 cycle 집합)이 앞 사례의 같은 머리와 겹치지 않게.
    const head = digit.repeat(40);
    const f = fixture();
    f.setHead(head);
    f.onRegate(f.writeRegate(true));
    f.onReview((path) => writeFileSync(path, reviewJson(head, over)));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:10:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.lands).toHaveLength(lands);
    if (lands === 0) expect(f.decisions().at(-1)).toBe('land:not-landing');
  });

  test('propose-land 가 허용 밖이면 재게이트·land 0(리뷰 재요청만)', async () => {
    const f = fixture();
    f.setHead(B);
    await rejudgeCardOnHead('ta-rj-1', f.deps(['review']));
    expect(f.regateRequests).toEqual([]);
    expect(f.reviewRequests).toHaveLength(1);
    expect(f.decisions()).toEqual(['regate:would-regate', 'review:review-requested']);
  });

  test('review 만 허용된 틱에 B 리뷰를 요청한 뒤 propose-land 를 켜면 다음 틱에 B 재게이트가 정확히 한 번', async () => {
    const f = fixture();
    f.setHead(B);
    await rejudgeCardOnHead('ta-rj-1', f.deps(['review']));
    expect(f.reviewRequests).toHaveLength(1);
    f.setClock('2026-10-11T01:05:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T01:06:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests.map((request) => request.head)).toEqual([B]);
    expect(f.reviewRequests).toHaveLength(1);
  });

  test(`재게이트한 머리가 상한(${REJUDGE_HEAD_CAP})에 닿으면 새 머리는 멈춘다 — 재게이트·리뷰 0 · 사유 줄`, async () => {
    const heads = ['1', '2', '3'].map((d) => d.repeat(40));
    const f = fixture({ regates: heads.map((h) => ({ pr: 30, head: h, at: '2026-10-11T00:30:00.000Z', passed: false, status: 'failed' })) });
    f.setHead(B);
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toEqual([]);
    expect(f.reviewRequests).toEqual([]);
    expect(f.decisions()).toEqual(['regate:cap-reached']);
    expect(f.card().history.at(-1)).toMatchObject({ event: 'rejudge-on-head', kind: 'regate', effect: 'cap-reached', head: B });
  });

  test('상한은 잠금 안에서 다시 잰다 — 판단 뒤 다른 틱이 머리를 채웠으면 claim 하지 않는다', async () => {
    const heads = ['1', '2'].map((d) => d.repeat(40));
    const f = fixture({ regates: heads.map((h) => ({ pr: 30, head: h, at: '2026-10-11T00:30:00.000Z', passed: false, status: 'failed' })) });
    f.setHead(B);
    const deps = f.deps();
    // 판단은 2개를 봤지만(카드·regates 스냅숏은 gh 조회 «전»에 읽는다), gh 조회 사이 다른 틱이 세 번째 머리를 claim 했다.
    let ghLookups = 0;
    const prHead = deps.live.prHead;
    deps.live.prHead = async () => {
      ghLookups++;
      writeTaskCards(f.statePath, [{ ...f.card(), regates: [...f.card().regates!, { pr: 30, head: '9'.repeat(40), at: '2026-10-11T00:59:00.000Z' }] }]);
      deps.live.prHead = prHead;
      return prHead();
    };
    await rejudgeCardOnHead('ta-rj-1', deps);
    expect(f.regateRequests).toEqual([]);
    expect(ghLookups).toBe(1);
    expect(f.card().regates).toHaveLength(3);
    expect(f.decisions()).toEqual(['regate:cap-reached']);
    // 잠금 밖 검사(스냅숏 2개)는 통과했고 잠금 안 재검사가 막았다 — 사유가 그 경로를 말한다.
    expect(f.logs.find((entry) => entry.event === 'rejudge-on-head')?.data.reason).toContain('claim-time recheck');
    expect(f.card().history.at(-1)).toMatchObject({ event: 'rejudge-on-head', kind: 'regate', effect: 'cap-reached' });
  });

  test('재게이트 결과가 상한 시간 안에 안 오면 «결과 없음» 실패로 적고 land 0', async () => {
    const f = fixture();
    f.setHead(B);
    f.onReview((path) => writeFileSync(path, reviewJson(B)));
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    f.setClock('2026-10-11T02:31:00.000Z');
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.card().regates?.[0]).toMatchObject({ passed: false, status: 'no-result' });
    expect(f.lands).toEqual([]);
  });

  test('카드 PR 에 URL 이 없으면 gh·재게이트·리뷰 0', async () => {
    const f = fixture();
    writeTaskCards(f.statePath, [{ ...f.card(), pr: 30 }]);
    f.setHead(B);
    await rejudgeCardOnHead('ta-rj-1', f.deps());
    expect(f.regateRequests).toEqual([]);
    expect(f.reviewRequests).toEqual([]);
    expect(f.decisions()).toEqual(['target:pr-url-unknown']);
  });

  test('parseRegateResult — 모양이 틀린 칸(baseCommit 숫자 등)은 결과로 받지 않는다', () => {
    expect(parseRegateResult(JSON.stringify({ pr: 30, head: B, passed: true, baseCommit: 7 }), 30, B)).toBeNull();
    expect(parseRegateResult(JSON.stringify({ pr: 30, head: B, passed: true, failures: [1] }), 30, B)).toBeNull();
    expect(parseRegateResult(JSON.stringify({ pr: 30, head: B, passed: true, baseCommit: BASE }), 30, B)).toMatchObject({ passed: true, baseCommit: BASE });
    expect(parseRegateResult(JSON.stringify({ pr: 31, head: B, passed: true }), 30, B)).toBeNull();
  });

  test('대상 — 묶인 PR 로 TA 리뷰를 요청한 카드만', () => {
    const f = fixture();
    const card = f.card();
    expect(rejudgeCandidates({ [card.id]: card, other: { ...card, id: 'other', reviewRequests: [] } })).toEqual(['ta-rj-1']);
  });

  test('liveLandArgs — 증거가 있으면 --overlap-evidence <file> · 없으면 종전 인자 그대로', () => {
    const base = liveLandArgs('/e/bin/elanous.mjs', '/u', 30, B, '/repo');
    expect(base).toEqual(['/e/bin/elanous.mjs', '--config-dir', '/u', 'pr', 'land', '--cwd', '/repo', '--pr', '30', '--expected-head', B]);
    expect(liveLandArgs('/e/bin/elanous.mjs', '/u', 30, B, '/repo', '/s/overlap-evidence/x.json')).toEqual([...base, '--overlap-evidence', '/s/overlap-evidence/x.json']);
  });

  test('defaultRequestRegate — 같은 우주·진입점의 `tasks regate-run` 을 PR 저장소에서 떼어 띄운다(stdio ignore)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ta-rejudge-spawn-'));
    const seen: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const fakeSpawn = ((command: string, args: string[], options: Record<string, unknown>) => {
      seen.push({ command, args, options });
      return { pid: 7, once: (event: string, listener: () => void) => { if (event === 'spawn') queueMicrotask(listener); return undefined; }, removeListener: () => undefined, unref: () => undefined };
    }) as unknown as import('../cli/tasks-cli.js').DetachedSpawn;
    const request = { card: 'ta-rj-1', pr: 30, head: B, repoRoot: dir, resultPath: join(dir, 'regate-results', 'x.json') };
    await defaultRequestRegate(request, { spawn: fakeSpawn, entry: '/e/bin/elanous.mjs', configDir: '/u' });
    expect(seen).toEqual([{ command: process.execPath, args: regateRunArgs('/e/bin/elanous.mjs', '/u', request), options: { detached: true, stdio: 'ignore', cwd: dir } }]);
    expect(regateRunArgs('/e/bin/elanous.mjs', '/u', request)).toEqual(['/e/bin/elanous.mjs', '--config-dir', '/u', 'tasks', 'regate-run', '--card', 'ta-rj-1', '--pr', '30', '--head', B, '--repo', dir, '--out', request.resultPath]);
  });
});
