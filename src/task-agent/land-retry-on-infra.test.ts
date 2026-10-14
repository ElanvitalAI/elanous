/**
 * TA-LAND-RETRY-ON-INFRA — land 실패를 «TA 쪽 인프라 결손»과 «판정 거절»로 가르고, 인프라면 같은 머리에 한 번 더(총 2회).
 * 실물 근거: 2026-10-11 #26030 (카드 ta-20261010-c6b53b) — 첫 land 가 `✗ expected-head: … matching local HEAD and clean worktree
 * required` 로 죽고(호스트에 PR 머리 트리 없음 · #26037 로 수리), 같은 머리 재시도가 `already attempted` 로 막혔다.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyLandFailure, executeLiveLand, LAND_ATTEMPTS_PER_HEAD_ON_INFRA, LAND_INFRA_EXECUTOR_REASONS, LAND_INFRA_OUTPUT_REASONS, landRetryPending } from './live-moves.js';
import { readTaskCard, writeTaskCards, type TaskCard } from './task-hand.js';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const EXPECTED_HEAD_LOCAL = '✗ expected-head: PR OPEN non-draft, matching local HEAD and clean worktree required';
const OVERLAP_REFUSED = '✗ expected-head: overlap merge approval unavailable for the reviewed head';
type LandOutcome = { status: number; stdout: string; stderr?: string };

let fixtures = 0;
function fixture(seed: Partial<TaskCard> = {}) {
  // 주기 표시(`landedCycles`)는 모듈 전역이다 — 시험마다 주기 id 를 갈라 서로 막지 않게.
  const run = `f${++fixtures}`;
  const statePath = join(mkdtempSync(join(tmpdir(), 'ta-land-retry-')), 'task-agent-actions.json');
  writeTaskCards(statePath, [{ id: 'ta-lr-1', text: 'feature ask', createdAt: '2026-10-11T00:00:00.000Z', status: 'launched', history: [], ...seed }]);
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const calls: Array<{ pr: number; head: string }> = [];
  const outcomes: Array<LandOutcome | Error> = [];
  let head = HEAD_A;
  let tick = 0;
  const live = {
    statePath,
    now: () => new Date(Date.parse('2026-10-11T04:30:00.000Z') + (tick++) * 60_000),
    log: (_c: string, event: string, data: Record<string, unknown>) => { logs.push({ event, data }); },
    landPrHead: async () => ({ head, state: 'OPEN', isDraft: false }),
    land: async (pr: number, landHead: string): Promise<LandOutcome> => {
      calls.push({ pr, head: landHead });
      const next = outcomes.shift() ?? { status: 0, stdout: 'merged' };
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const review = () => ({ verdict: 'pass' as const, head, mustFixCount: 0 });
  // 틱마다 새 주기 id 가 아니라 «재판정 틱»처럼 같은 주기 id 를 쓴다 — 주기 표시가 재시도를 막지 않는지도 같이 본다.
  const land = (cycleId = `rejudge:ta-lr-1:${run}:${head}`) => executeLiveLand(readTaskCard('ta-lr-1', statePath)!, 30, { cwd: '/tmp/ta-land-retry-nowhere', cycleId, review: review() }, live);
  return {
    logs, calls, land, live,
    queue: (...next: Array<LandOutcome | Error>) => { outcomes.push(...next); },
    setHead: (next: string) => { head = next; },
    card: () => readTaskCard('ta-lr-1', statePath)!,
    retryEvents: () => logs.filter((entry) => entry.event === 'land-retry-on-infra').map((entry) => entry.data),
  };
}

describe('TA-LAND-RETRY-ON-INFRA — 인프라 실패는 같은 머리에 한 번 더 · 판정 거절은 한 번 끝', () => {
  test('same card/head land claim skips the second concurrent worker with an observable key', async () => {
    const f = fixture();
    const results = await Promise.all([f.land('worker-one'), f.land('worker-two')]);
    expect(results.filter((result) => result.executed)).toHaveLength(1);
    expect(results.find((result) => !result.executed)?.detail).toContain(`land:ta-lr-1:${HEAD_A.slice(0, 12)} claimed — skip`);
    expect(f.calls).toHaveLength(1);
    expect(f.card().landAttempts).toMatchObject([{ pr: 30, head: HEAD_A, ok: true }]);
  });

  test('#26030 재현: infra 실패 1회 → 같은 머리 재시도 허용 → 두 번째도 infra → 더 이상 안 함', async () => {
    const f = fixture();
    f.queue({ status: 1, stdout: '', stderr: EXPECTED_HEAD_LOCAL }, { status: 1, stdout: '', stderr: EXPECTED_HEAD_LOCAL });
    const first = await f.land();
    expect(first).toMatchObject({ executed: true, ok: false, landAttempt: { attempt: 1, class: 'infra', reason: 'precondition-local-head-clean-tree', retryAllowed: true } });
    const second = await f.land();
    expect(second).toMatchObject({ executed: true, ok: false, landAttempt: { attempt: 2, class: 'infra', retryAllowed: false } });
    // 다음 틱(새 프로세스 = 새 주기 표시)에서도 카드 원장이 막는다.
    const third = await f.land('fresh-process-tick');
    expect(third.detail).toContain('already attempted land for #30');
    expect(third.detail).toContain('attempts 2 · last class infra');
    expect(third).toMatchObject({ executed: false, ok: true });
    expect(f.calls).toHaveLength(LAND_ATTEMPTS_PER_HEAD_ON_INFRA);
    expect(f.card().landAttempts?.map((entry) => [entry.ok, entry.class, entry.reason])).toEqual([
      [false, 'infra', 'precondition-local-head-clean-tree'], [false, 'infra', 'precondition-local-head-clean-tree']]);
    // 관측 — 분류(시도마다) ⊕ 재시도 시작 · 카드 history 한 줄씩.
    expect(f.retryEvents()).toEqual([
      { card: 'ta-lr-1', pr: 30, head: HEAD_A, attempt: 1, reason: 'precondition-local-head-clean-tree', class: 'infra', decision: 'retry-allowed' },
      { card: 'ta-lr-1', pr: 30, head: HEAD_A, attempt: 2, reason: 'precondition-local-head-clean-tree', class: 'infra', decision: 'retrying' },
      { card: 'ta-lr-1', pr: 30, head: HEAD_A, attempt: 2, reason: 'precondition-local-head-clean-tree', class: 'infra', decision: 'retry-exhausted' },
    ]);
    expect(f.card().history.filter((item) => item.event === 'land-retry-on-infra').map((item) => `${item.kind}:${item.effect}:${item.detail}`)).toEqual([
      'infra:retry-allowed:attempt 1/2 · precondition-local-head-clean-tree', 'infra:retry-exhausted:attempt 2/2 · precondition-local-head-clean-tree']);
  });

  test('infra 실패 뒤 재시도가 성공하면 그대로 병합으로 끝난다', async () => {
    const f = fixture();
    f.queue({ status: 1, stdout: '', stderr: EXPECTED_HEAD_LOCAL }, { status: 0, stdout: 'merged' });
    await f.land();
    expect(landRetryPending(f.card(), 30, HEAD_A)).toBe(true);
    expect(await f.land()).toMatchObject({ executed: true, ok: true, landAttempt: { attempt: 2 } });
    expect(landRetryPending(f.card(), 30, HEAD_A)).toBe(false);
    expect((await f.land()).executed).toBe(false);
    expect(f.calls).toHaveLength(2);
  });

  test('missing node, bun or tsc during typecheck is infra only with rc127/ENOENT and the exact gate refusal', () => {
    const refusal = '✗ typecheck: scripts/ci-typecheck-changed.ts blocked pr land.';
    for (const runtime of ['node', 'bun', 'tsc']) {
      const output = `env: ${runtime}: No such file or directory\n[tsc-gate] FAIL — tsc 종료코드 127\n${refusal}`;
      expect(classifyLandFailure({ status: 1, stdout: '', stderr: output })).toEqual({ class: 'infra', reason: 'tsc-runtime-missing' });
      expect(classifyLandFailure({ status: 1, stdout: '', stderr: output.replace('127', '2') }).class).toBe('judgement');
      expect(classifyLandFailure({ status: 1, stdout: '', stderr: `${output}\n✗ merge: conflict` }).class).toBe('judgement');
    }
    expect(classifyLandFailure({ status: 1, stdout: '', stderr: `env: node: No such file or directory\n[tsc-gate] tsc 실행 실패 (signal=undefined code=ENOENT status=undefined)\n${refusal}` }))
      .toEqual({ class: 'infra', reason: 'tsc-runtime-missing' });
  });

  test('#26931 legacy judgement from missing node reopens once and records reclassification before retry', async () => {
    const refusal = '✗ typecheck: scripts/ci-typecheck-changed.ts blocked pr land.';
    const detail = `env: node: No such file or directory\n[tsc-gate] FAIL — tsc 종료코드 127\n${refusal}`;
    const f = fixture({ landAttempts: [{ pr: 30, head: HEAD_A, at: '2026-10-11T04:00:00.000Z', ok: false, class: 'judgement', reason: refusal, detail }] });
    expect(landRetryPending(f.card(), 30, HEAD_A)).toBe(true);
    f.queue({ status: 0, stdout: 'merged' });
    expect(await f.land()).toMatchObject({ executed: true, ok: true, landAttempt: { attempt: 2 } });
    expect(f.calls).toHaveLength(1);
    expect(f.retryEvents()).toEqual([expect.objectContaining({ decision: 'legacy-reclassified-retrying', reason: 'tsc-runtime-missing-legacy', attempt: 2 })]);
    expect(landRetryPending(f.card(), 30, HEAD_A)).toBe(false);
  });

  test('a legacy judgement with another refused gate stays closed even when the old detail includes missing node', async () => {
    const refusal = '✗ typecheck: scripts/ci-typecheck-changed.ts blocked pr land.';
    const detail = `env: node: No such file or directory\n[tsc-gate] FAIL — tsc 종료코드 127\n${refusal}\n✗ merge: conflict`;
    const f = fixture({ landAttempts: [{ pr: 30, head: HEAD_A, at: '2026-10-11T04:00:00.000Z', ok: false, class: 'judgement', reason: refusal, detail }] });
    expect(landRetryPending(f.card(), 30, HEAD_A)).toBe(false);
    expect((await f.land()).executed).toBe(false);
    expect(f.calls).toHaveLength(0);
    expect(f.retryEvents()).toHaveLength(0);
  });

  test.each([
    ['겹침 관문 거부', { status: 1, stdout: '✓ branch: feature', stderr: OVERLAP_REFUSED }],
    ['머리 바뀜(병합 직전)', { status: 1, stdout: '', stderr: '✗ expected-head: PR head/state changed before merge' }],
    ['게이트 실패', { status: 1, stdout: '', stderr: '✗ typecheck: scripts/ci-typecheck-changed.ts blocked pr land.' }],
    ['충돌', { status: 1, stdout: '', stderr: '✗ merge: squash merge 미완료 (state: OPEN · mergeable=CONFLICTING)' }],
    ['동결로 병합 연기(✗ 없음)', { status: 1, stdout: '✓ ready: https://x/pull/30 — 동결 · 병합 연기', stderr: '' }],
  ] as const)('judgement 실패(%s) → 같은 머리 재시도 0', async (_name, outcome) => {
    const f = fixture();
    f.queue(outcome);
    const first = await f.land();
    expect(first.landAttempt).toMatchObject({ attempt: 1, class: 'judgement', retryAllowed: false });
    expect((await f.land()).executed).toBe(false);
    expect(f.calls).toHaveLength(1);
    expect(f.retryEvents()).toEqual([expect.objectContaining({ class: 'judgement', decision: 'no-retry', attempt: 1 })]);
  });

  test('목록에 없는 사유 → judgement(fail-closed) · 인프라 줄과 섞여도 judgement', async () => {
    expect(classifyLandFailure({ status: 1, stdout: '', stderr: '✗ brand-new-gate: something we never listed' })).toEqual({ class: 'judgement', reason: '✗ brand-new-gate: something we never listed' });
    expect(classifyLandFailure({ status: 1, stdout: '✗ find: FAILED', stderr: '✗ typecheck: blocked' }).class).toBe('judgement');
    // 비슷한 문면을 넓게 받지 않는다 — 줄 «전체»가 맞아야 한다.
    expect(classifyLandFailure({ status: 1, stdout: '', stderr: `${EXPECTED_HEAD_LOCAL} (and more)` }).class).toBe('judgement');
    const f = fixture();
    f.queue({ status: 1, stdout: '', stderr: '✗ brand-new-gate: something we never listed' });
    await f.land();
    expect((await f.land()).executed).toBe(false);
    expect(f.calls).toHaveLength(1);
  });

  test('머리가 바뀌면 종전대로 새 시도(앞 머리의 판정 거절과 무관)', async () => {
    const f = fixture();
    f.queue({ status: 1, stdout: '', stderr: OVERLAP_REFUSED });
    await f.land();
    f.setHead(HEAD_B);
    expect(await f.land()).toMatchObject({ executed: true, ok: true, landAttempt: { attempt: 1 } });
    expect(f.calls).toEqual([{ pr: 30, head: HEAD_A }, { pr: 30, head: HEAD_B }]);
  });

  test('분류 근거가 없는 옛 시도(class 없음)는 재시도하지 않는다 · 끝나지 않은 시도(ok 없음)도', async () => {
    for (const legacy of [{ ok: false, detail: EXPECTED_HEAD_LOCAL }, {}]) {
      const f = fixture({ landAttempts: [{ pr: 30, head: HEAD_A, at: '2026-10-11T04:00:00.000Z', ...legacy }] });
      expect((await f.land()).executed).toBe(false);
      expect(f.calls).toHaveLength(0);
    }
  });

  test('land 프로세스가 던짐 · 결과 줄 없이 0 아닌 코드로 죽음 → infra', async () => {
    // 실행부 쪽 인프라 사유는 이 둘뿐이다(목록이 곧 계약).
    expect([...LAND_INFRA_EXECUTOR_REASONS]).toEqual(['land-process-error', 'land-no-result-line']);
    expect(classifyLandFailure({ thrown: 'spawn ENOENT' })).toEqual({ class: 'infra', reason: 'land-process-error' });
    expect(classifyLandFailure({ status: 137, stdout: '', stderr: 'Killed: 9' })).toEqual({ class: 'infra', reason: 'land-no-result-line' });
    const f = fixture();
    f.queue(new Error('spawn ENOENT'));
    expect((await f.land()).landAttempt).toMatchObject({ class: 'infra', reason: 'land-process-error', retryAllowed: true });
    expect((await f.land()).executed).toBe(true);
  });

  test('허용 목록 — pr land 의 실제 ✗ 문면마다 infra · 딸린 줄(upsert-ready)과 계속 줄(active-run-files)은 판정에 안 센다', () => {
    const lines: Array<[string, string]> = [
      [EXPECTED_HEAD_LOCAL, 'precondition-local-head-clean-tree'],
      ['✗ branch: PR head branch와 현재 브랜치가 다릅니다.', 'precondition-branch'],
      ['✗ branch: 현재 브랜치를 해석하지 못했습니다.', 'precondition-branch'],
      ['✗ base: 비교 base를 선택하지 못했습니다.', 'base-unresolved'],
      ['✗ granularity: 비교 base를 해석하지 못했습니다.', 'git-read-failed'],
      ['✗ granularity: 로컬 git log 를 읽지 못했습니다.', 'git-read-failed'],
      ['✗ find: FAILED', 'gh-lookup-failed'],
      ['✗ merge: squash merge 결과를 모름 (상태 미확정)', 'gh-merge-state-unknown'],
      ['✗ merge: squash merge 상태 되읽기 실패', 'gh-merge-state-unknown'],
      ['✗ ta-land: merge state unreadable after pr land exit 0', 'gh-merge-state-unreadable'],
    ];
    for (const [line, reason] of lines) expect(classifyLandFailure({ status: 1, stdout: '✓ branch: x', stderr: line })).toEqual({ class: 'infra', reason });
    expect(new Set(lines.map(([, reason]) => reason))).toEqual(new Set(LAND_INFRA_OUTPUT_REASONS.map((entry) => entry.reason)));
    expect(classifyLandFailure({ status: 1, stdout: '✗ find: FAILED', stderr: '✗ upsert-ready: gh: pinned PR is not the branch open PR' })).toEqual({ class: 'infra', reason: 'gh-lookup-failed' });
    // 딸린 줄은 그 사유가 «같이» 있을 때만 — 홀로 나오면 판정 거절.
    expect(classifyLandFailure({ status: 1, stdout: '', stderr: '✗ upsert-ready: gh: pinned PR is not the branch open PR' }).class).toBe('judgement');
    expect(classifyLandFailure({ status: 1, stdout: '', stderr: `✗ active-run-files: 도는 런 조회 실패 (x). 도는 런 없음과 구분해 계속합니다.\n${EXPECTED_HEAD_LOCAL}` })).toEqual({ class: 'infra', reason: 'precondition-local-head-clean-tree' });
    // 0 으로 끝났는데 병합이 아닌 상태를 «읽었다» = 판정.
    expect(classifyLandFailure({ status: 1, stdout: '', stderr: '✗ ta-land: pr land exited 0 but PR is OPEN' }).class).toBe('judgement');
  });
});
