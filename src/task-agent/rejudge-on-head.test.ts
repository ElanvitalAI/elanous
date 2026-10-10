import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { liveLandArgs, type TaskAgentLiveMove } from './live-moves.js';
import { defaultRequestRegate, overlapEvidencePath, parseRegateResult, REJUDGE_HEAD_CAP, regateResultPath, regateRunArgs, rejudgeCandidates, rejudgeCardOnHead, type RegateRequest } from './rejudge-on-head.js';
import { reviewResultPath } from './review-result-capture.js';
import { readTaskCard, writeTaskCards, type TaskCard } from './task-hand.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const URL = 'https://github.com/o/r/pull/30';
const reviewJson = (head: string, over: Record<string, unknown> = {}) => JSON.stringify({ pr: '30', verdict: 'pass', mustFix: [], shouldFix: [], reviewed: true, reviewRoute: 'api', headCommit: head, ...over });

function fixture(opts: { regates?: TaskCard['regates'] } = {}) {
  const statePath = join(mkdtempSync(join(tmpdir(), 'ta-rejudge-')), 'task-agent-actions.json');
  const pathA = reviewResultPath(statePath, 'ta-rj-1', 30, A);
  // 런 멈춤 때: 머리 A 리뷰 요청 ⊕ 회수(fail · must-fix 2) — #26030 실측 꼴.
  const seed: TaskCard = {
    id: 'ta-rj-1', text: 'feature ask', checklistId: 'CELL-RJ', createdAt: '2026-10-11T00:00:00.000Z', status: 'launched', runId: 'run-rj',
    pr: { number: 30, url: URL },
    reviewRequests: [{ pr: 30, head: A, at: '2026-10-11T00:10:00.000Z', resultPath: pathA }],
    history: [{ at: '2026-10-11T00:20:00.000Z', event: 'live-move-result', kind: 'review', pr: 30, head: A, verdict: 'fail', reviewed: true, mustFix: 2, reviewRoute: 'api', resultPath: pathA, effect: 'review result captured · verdict fail · reviewed true · must-fix 2' }],
    ...(opts.regates ? { regates: opts.regates } : {}),
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
        return { status: 0, stdout: 'merged' };
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
