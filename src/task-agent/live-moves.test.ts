import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SupervisorJobResult, SupervisorStopReason } from '../self-dev/run-supervisor.js';
import { getUserConfig, reloadUserConfig, userConfigPath } from '../user-config.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import type { LandWorktree, LandWorktreeFailure, LandWorktreeInput } from './land-worktree.js';
import { decisionRaiseArgs, executeNextAction } from './actions.js';
import { CLOSE_IDLE_HOURS, CLOSE_PROTECTED_LABELS, type DraftCloseView, evaluateDraftClose, executeLiveCloseProposal, defaultPrHead, defaultRequestReview, defaultReviewRepoCandidates, executeLiveDecisionCard, executeLiveLand, executeLiveReview, type LiveDecisionCardContext, liveCloseArgs, liveLandArgs, liveReviewArgs, type PrHeadView, type ReviewRepoCandidate, resolveTaskAgentLiveMoves, TASK_AGENT_LIVE_MOVES_ENV, TASK_AGENT_LIVE_MOVES, type TaskAgentLiveMove } from './live-moves.js';
import { recordTaskAgentShadowMove } from './shadow.js';
import { readTaskCard, shellQuote, writeTaskCards, type TaskCard } from './task-hand.js';
import { captureReviewResults } from './review-result-capture.js';

// GATE-PREEXISTING-ZERO-1 — 이 파일의 시험은 전부 «HQ(비-Pod) 판단부»를 단언한다. 그런데 정식 게이트는 Pod 안에서 돌고
// Pod 는 `ELANOUS_POD_NAME`(⊕ `ELANOUS_RUN_ID`)을 프로세스 env 로 갖는다(pod-command-job.ts). shadow.ts 는 주입 env 가
// 없으면 process.env 를 읽어 그 값을 «원격 자식» 표지로 쓰므로, 게이트에선 카드 묶기 대기(card-binding-pending)로 빠져
// 21건이 깨졌다(0.2.30 HARD #3 preexisting). 제품이 맞다 — 시험이 주변 env 에 기대지 않게 Pod 신원 넷을 매 시험 지우고 되돌린다.
const POD_IDENTITY_ENV = ['ELANOUS_POD_NAME', 'ELANOUS_TASK_CARD_ID', 'ELANOUS_PARENT_RUN_ID', 'ELANOUS_RUN_ID'] as const;
let savedPodIdentityEnv: Array<[string, string | undefined]> = [];
beforeEach(() => {
  savedPodIdentityEnv = POD_IDENTITY_ENV.map((name) => [name, process.env[name]]);
  for (const name of POD_IDENTITY_ENV) delete process.env[name];
});
afterEach(() => {
  for (const [name, value] of savedPodIdentityEnv) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_C = 'c'.repeat(40);
const worktreeCreateFailures = (card: TaskCard) => card.landWorktreeCreateFailures;
const job = (over: Partial<SupervisorJobResult> = {}): SupervisorJobResult =>
  ({ taskId: 'ta-live-1', feature: 'feature ask', status: 'done', ...over }) as SupervisorJobResult;

function fixture() {
  const statePath = join(mkdtempSync(join(tmpdir(), 'ta-live-')), 'task-agent-actions.json');
  const card: TaskCard = { id: 'ta-live-1', text: 'feature ask', checklistId: 'CELL-1', createdAt: '2026-10-07T00:00:00.000Z', status: 'launched', history: [] };
  writeTaskCards(statePath, [card]);
  const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
  const reviews: Array<{ pr: number; intent: string }> = [];
  let head = HEAD_A;
  let commands = 0;
  const deps = (liveMoves?: TaskAgentLiveMove[]) => ({
    readCard: (id: string) => readTaskCard(id, statePath),
    log: (_c: string, event: string, data: Record<string, unknown>) => { logs.push({ event, data }); },
    command: async () => { commands++; return { status: 0, stdout: '' }; },
    ...(liveMoves ? { liveMoves: new Set(liveMoves) } : { liveMoves: new Set<TaskAgentLiveMove>() }),
    live: {
      statePath,
      prHead: async (_pr: number, _cwd?: string): Promise<{ head: string; state: string } | null> => ({ head, state: 'OPEN' }),
      requestReview: async (pr: number, intent: string, _cwd?: string): Promise<void> => { reviews.push({ pr, intent }); },
    },
    // TA-WIRING-CHECK — 병합 PR 배선 관측이 실물 `gh pr diff` 로 나가지 않게(밀폐).
    wiring: { prDiff: () => '', loadLedger: () => null },
  });
  return { statePath, logs, reviews, deps, setHead: (next: string) => { head = next; }, commands: () => commands };
}

const run = (stopReason: SupervisorStopReason, results: SupervisorJobResult[], deps: Parameters<typeof recordTaskAgentShadowMove>[1]) =>
  recordTaskAgentShadowMove({ runId: 'run-live', stopReason, results }, deps);

describe('TA-JUDGE-LIVE-SAFE — 안전한 수만 실제로', () => {
  test('키 없음 → 실행 0 · 반환값은 종전과 같다(반증)', async () => {
    const f = fixture();
    for (const [stop, results] of [
      ['needs-human', [job({ prNumber: 8 })]],
      ['converged', [job({ prNumber: 7, merged: true })]],
      ['no-progress', [job()]],
    ] as Array<[SupervisorStopReason, SupervisorJobResult[]]>) {
      const absent = await run(stop, results, f.deps());
      // 종전 반환 칸 그대로 — liveMove 칸이 생기지 않는다.
      expect(Object.keys(absent).sort()).toEqual(['executorKind', 'executorResult', 'move', 'pr', 'reason', 'runId', 'stopReason', 'variant', 'wouldDo']);
      expect(absent.executorResult === null || absent.executorResult === 'shadow').toBe(true);
    }
    expect(f.reviews).toHaveLength(0);
    // TA-WIRING-CHECK — 병합 PR 은 판단 뒤 wiring-shadow 관측 한 줄을 더 남긴다(move 불변 · 관측 전용).
    expect(f.logs.filter((entry) => entry.event === 'wiring-shadow')).toHaveLength(1);
    expect(f.logs.filter((entry) => entry.event !== 'wiring-shadow').every((entry) => entry.event === 'shadow-move' && entry.data.live === false && entry.data.liveExecuted === false)).toBe(true);
    const card = readTaskCard('ta-live-1', f.statePath)!;
    expect(card.greenProposal).toBeUndefined();
    expect(card.reviewRequests).toBeUndefined();
    expect(f.commands()).toBe(0);
  });

  test('키 없음 — 주입 없이 실제 설정 해석 경로(임시 config-dir · env 없음) → 실행 0 · liveExecuted false', async () => {
    const f = fixture();
    const dir = mkdtempSync(join(tmpdir(), 'ta-live-noconfig-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({}));
    const saved = { env: process.env[TASK_AGENT_LIVE_MOVES_ENV], xdg: process.env.XDG_CONFIG_HOME };
    delete process.env[TASK_AGENT_LIVE_MOVES_ENV];
    delete process.env.XDG_CONFIG_HOME;
    setElanousConfigDir(dir);
    try {
      const { liveMoves: _drop, ...deps } = f.deps();
      expect(userConfigPath()).toBe(join(dir, 'config.json'));
      expect(getUserConfig().taskAgent).toBeUndefined();
      const review = await run('needs-human', [job({ prNumber: 8, worktreePath: '/tmp/wt-8' })], deps);
      const green = await run('converged', [job({ prNumber: 7, merged: true })], deps);
      expect(review.liveMove).toBeUndefined();
      expect(green.liveMove).toBeUndefined();
    } finally {
      resetElanousConfigDir();
      if (saved.env !== undefined) process.env[TASK_AGENT_LIVE_MOVES_ENV] = saved.env;
      if (saved.xdg !== undefined) process.env.XDG_CONFIG_HOME = saved.xdg;
    }
    expect(f.reviews).toHaveLength(0);
    const card = readTaskCard('ta-live-1', f.statePath)!;
    expect(card.greenProposal).toBeUndefined();
    expect(card.reviewRequests).toBeUndefined();
    expect(f.logs.filter((entry) => entry.event !== 'wiring-shadow').map((entry) => [entry.event, entry.data.live, entry.data.liveExecuted])).toEqual([['shadow-move', false, false], ['shadow-move', false, false]]);
  });

  test("['propose-green'] + 병합 근거 → 제안 한 번 · 리뷰는 안 한다 · 체크리스트 명령 0", async () => {
    const f = fixture();
    const merged = [job({ prNumber: 7, merged: true })];
    const first = await run('converged', merged, f.deps(['propose-green']));
    expect(first.move).toBe('propose-green');
    expect(first.liveMove).toMatchObject({ kind: 'propose-green', card: 'ta-live-1', ok: true });
    const card = readTaskCard('ta-live-1', f.statePath)!;
    expect(card.greenProposal).toMatchObject({ checklistId: 'CELL-1', evidence: { 'ta-live-1': '#7' } });
    const second = await run('converged', merged, f.deps(['propose-green']));
    expect(second.liveMove?.detail).toBe('already proposed');
    expect(readTaskCard('ta-live-1', f.statePath)!.greenProposal).toEqual(card.greenProposal);
    const review = await run('needs-human', [job({ prNumber: 8 })], f.deps(['propose-green']));
    expect(review.move).toBe('review');
    expect(review.liveMove).toBeUndefined();
    expect(f.reviews).toHaveLength(0);
    expect(f.commands()).toBe(0);
    expect(f.logs.filter((entry) => entry.event === 'live-move')).toHaveLength(2);
    expect(f.logs.find((entry) => entry.event === 'shadow-move' && entry.data.move === 'review')!.data).toMatchObject({ live: false, card: 'ta-live-1' });
  });

  test('명시적 live 전달 + propose-green → 전달 산출물 경로를 근거로 카드에 제안', async () => {
    const f = fixture();
    const root = mkdtempSync(join(tmpdir(), 'ta-live-deliver-'));
    const worktree = join(root, 'worktree');
    const target = join(root, 'target');
    const { mkdirSync } = await import('node:fs');
    const { execFileSync } = await import('node:child_process');
    mkdirSync(worktree);
    mkdirSync(target);
    execFileSync('git', ['init', '-q', worktree]);
    writeFileSync(join(worktree, 'report.md'), '# 조사\n출처 https://one.example/report https://two.example/report\n## 반대 근거\n다른 해석');
    writeTaskCards(f.statePath, [{ id: 'ta-live-1', text: 'research', checklistId: 'CELL-1', createdAt: '2026-10-07T00:00:00.000Z', status: 'launched', history: [], completion: 'research-report', project: { target } }]);
    const spy = spyOn(debug, 'log').mockImplementation(() => {});
    try {
      const out = await run('converged', [job({ ok: true, worktreePath: worktree })], { ...f.deps(['propose-green']), mode: 'live', command: async () => { throw new Error('commands forbidden'); } });
      expect(out).toMatchObject({ move: 'propose-green', executorResult: 'done' });
      expect(out.liveMove).toMatchObject({ kind: 'propose-green', card: 'ta-live-1', ok: true, executed: true });
    } finally { spy.mockRestore(); }
    expect(readTaskCard('ta-live-1', f.statePath)!.greenProposal?.evidence).toEqual({ 'ta-live-1': join(target, 'elanous-out', 'ta-live-1') });
  });

  test('propose-green 은 근거가 비면 적지 않는다', async () => {
    const f = fixture();
    // 병합 근거 없는 propose-green 은 판단부가 고르지 않는다 — 실행부 함수를 직접 부른다.
    const { executeLiveGreenProposal } = await import('./live-moves.js');
    const out = executeLiveGreenProposal(readTaskCard('ta-live-1', f.statePath), { 'ta-live-1': '  ' }, { statePath: f.statePath, log: () => {} });
    expect(out).toMatchObject({ ok: false, detail: 'no evidence ref — not proposed' });
    expect(readTaskCard('ta-live-1', f.statePath)!.greenProposal).toBeUndefined();
  });

  test("['review'] + 수확 가능 PR → 그 머리에 한 번 · 같은 머리 둘째 틱 0 · 새 머리면 한 번 더", async () => {
    const f = fixture();
    const harvest = [job({ prNumber: 9, harvestable: true, worktreePath: '/tmp/wt-9' })];
    const first = await run('harvestable-awaiting-human', harvest, f.deps(['review']));
    expect(first.move).toBe('review');
    expect(first.executorResult).toBe('shadow');
    expect(first.liveMove).toMatchObject({ kind: 'review', ok: true, executed: true });
    expect(f.reviews).toHaveLength(1);
    expect(f.reviews[0]!.pr).toBe(9);
    expect(f.reviews[0]!.intent).toContain('의도적 범위 경계');
    expect(readTaskCard('ta-live-1', f.statePath)!.reviewRequests).toEqual([expect.objectContaining({ pr: 9, head: HEAD_A })]);
    const second = await run('harvestable-awaiting-human', harvest, f.deps(['review']));
    expect(second.liveMove?.detail).toStartWith('already requested');
    expect(second.liveMove?.executed).toBe(false);
    expect(f.logs.filter((entry) => entry.event === 'shadow-move').map((entry) => entry.data.liveExecuted)).toEqual([true, false]);
    expect(f.reviews).toHaveLength(1);
    f.setHead(HEAD_B);
    await run('harvestable-awaiting-human', harvest, f.deps(['review']));
    expect(f.reviews).toHaveLength(2);
    // A→B→A — 이미 요청한 머리로 돌아와도 다시 요청하지 않는다(머리 이력).
    f.setHead(HEAD_A);
    const back = await run('harvestable-awaiting-human', harvest, f.deps(['review']));
    expect(back.liveMove?.detail).toStartWith('already requested');
    expect(f.reviews).toHaveLength(2);
    expect(readTaskCard('ta-live-1', f.statePath)!.reviewRequests!.map((entry) => entry.head)).toEqual([HEAD_A, HEAD_B]);
    expect(f.commands()).toBe(0);
    const live = f.logs.filter((entry) => entry.event === 'live-move');
    expect(live.map((entry) => entry.data)).toEqual([
      expect.objectContaining({ kind: 'review', card: 'ta-live-1', ok: true, live: true }),
      expect.objectContaining({ kind: 'review', card: 'ta-live-1', ok: true, live: true }),
      expect.objectContaining({ kind: 'review', card: 'ta-live-1', ok: true, live: true }),
      expect.objectContaining({ kind: 'review', card: 'ta-live-1', ok: true, live: true }),
    ]);
  });

  test('리뷰 띄우기 실패 → 카드에 오류 · 같은 머리는 다시 안 띄운다 · PR 이 닫혔으면 안 띄운다', async () => {
    const f = fixture();
    const deps = f.deps(['review']);
    deps.live.requestReview = async () => { throw new Error('spawn ENOENT'); };
    const out = await run('needs-human', [job({ prNumber: 9, worktreePath: '/tmp/wt-9' })], deps);
    expect(out.liveMove).toMatchObject({ ok: false });
    expect(readTaskCard('ta-live-1', f.statePath)!.reviewRequests).toEqual([expect.objectContaining({ head: HEAD_A, error: 'spawn ENOENT' })]);
    const closed = f.deps(['review']);
    closed.live.prHead = async () => ({ head: HEAD_B, state: 'CLOSED' });
    const shut = await run('needs-human', [job({ prNumber: 9, worktreePath: '/tmp/wt-9' })], closed);
    expect(shut.liveMove).toMatchObject({ ok: false, detail: 'PR #9 is CLOSED' });
    expect(f.reviews).toHaveLength(0);
  });

  test('재발사·결정 카드는 어떤 liveMoves 로도 그림자 그대로', async () => {
    const f = fixture();
    for (const [stop, results] of [
      ['no-progress', [job()]],
      ['handed-off-to-salvage', [job({ salvage: 'launched' })]],
      ['provider-exhausted', [job()]],
      ['max-rounds', [job()]],
    ] as Array<[SupervisorStopReason, SupervisorJobResult[]]>) {
      const deps = f.deps(['review', 'propose-green']);
      const out = await run(stop, results, deps);
      expect(out.liveMove).toBeUndefined();
      expect(out.executorResult).toBe('shadow');
    }
    expect(f.reviews).toHaveLength(0);
    expect(f.commands()).toBe(0);
    expect(f.logs.filter((entry) => entry.event === 'live-move')).toHaveLength(0);
    expect(f.logs.every((entry) => entry.data.live === false)).toBe(true);
  });
});

describe('taskAgent.liveMoves 해석 — config > env > 없음 · 모르는 항목은 경고하고 버린다', () => {
  test('모르는 항목 → 경고 · 허용으로 읽지 않는다', () => {
    const warned: Array<Record<string, unknown>> = [];
    const out = resolveTaskAgentLiveMoves(['review', 'relaunch', 'retry-forever', 3], {}, (_c, event, data) => { warned.push({ event, ...data }); });
    expect([...out.moves]).toEqual(['review']);
    expect(out.ignored).toEqual(['relaunch', 'retry-forever', '3']);
    expect(warned).toEqual([expect.objectContaining({ event: 'live-moves-ignored', ignored: ['relaunch', 'retry-forever', '3'], source: 'config' })]);
  });

  test("'decision-card' 는 허용 항목이다 — 설정에서 명시하면 읽힌다", () => {
    const out = resolveTaskAgentLiveMoves(['decision-card'], {}, () => {});
    expect([...out.moves]).toEqual(['decision-card']);
    expect(out.ignored).toEqual([]);
  });

  test('config 가 env 를 이긴다 · config 없으면 env · 둘 다 없으면 빈 집합', () => {
    const silent = () => {};
    expect([...resolveTaskAgentLiveMoves([], { [TASK_AGENT_LIVE_MOVES_ENV]: 'review' }, silent).moves]).toEqual([]);
    expect([...resolveTaskAgentLiveMoves(undefined, { [TASK_AGENT_LIVE_MOVES_ENV]: 'review, propose-green' }, silent).moves]).toEqual(['review', 'propose-green']);
    expect(resolveTaskAgentLiveMoves(undefined, {}, silent)).toEqual({ moves: new Set(), source: 'default', ignored: [] });
  });

  test('user-config 가 taskAgent.liveMoves 를 문자열 배열로 싣는다 · 없으면 칸이 없다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ta-live-config-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ taskAgent: { liveMoves: ['review', 'bogus'] } }));
    expect(reloadUserConfig(path).taskAgent).toEqual({ liveMoves: ['review', 'bogus'] });
    writeFileSync(path, JSON.stringify({}));
    expect(reloadUserConfig(path).taskAgent).toBeUndefined();
  });

  test('taskAgent.repairMaxPerTick 은 0 포함 안전한 정수만 보존한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ta-repair-cap-config-'));
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ taskAgent: { repairMaxPerTick: 0 } }));
    expect(reloadUserConfig(path).taskAgent?.repairMaxPerTick).toBe(0);
    writeFileSync(path, JSON.stringify({ taskAgent: { repairMaxPerTick: 5 } }));
    expect(reloadUserConfig(path).taskAgent?.repairMaxPerTick).toBe(5);
    writeFileSync(path, JSON.stringify({ taskAgent: { repairMaxPerTick: -1 } }));
    expect(reloadUserConfig(path).taskAgent?.repairMaxPerTick).toBeUndefined();
    writeFileSync(path, JSON.stringify({ taskAgent: { repairMaxPerTick: 1.5 } }));
    expect(reloadUserConfig(path).taskAgent?.repairMaxPerTick).toBeUndefined();
  });

  test('실제 설정 로더 → 해석: 숫자 섞인 목록은 review 를 살리고 숫자만 경고 · 설정이 있으면 env 는 안 먹는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ta-live-config-'));
    const path = join(dir, 'config.json');
    const env = { [TASK_AGENT_LIVE_MOVES_ENV]: 'propose-green' };
    const warned: Array<Record<string, unknown>> = [];
    const warn = (_c: string, _e: string, data: Record<string, unknown>) => { warned.push(data); };
    writeFileSync(path, JSON.stringify({ taskAgent: { liveMoves: ['review', 3] } }));
    const mixed = resolveTaskAgentLiveMoves(reloadUserConfig(path).taskAgent?.liveMoves, env, warn);
    expect([...mixed.moves]).toEqual(['review']);
    expect(warned).toEqual([expect.objectContaining({ ignored: ['3'], source: 'config' })]);
    writeFileSync(path, JSON.stringify({ taskAgent: { liveMoves: 'review' } }));
    const scalar = resolveTaskAgentLiveMoves(reloadUserConfig(path).taskAgent?.liveMoves, env, warn);
    expect(scalar).toMatchObject({ source: 'config', ignored: [] });
    expect([...scalar.moves]).toEqual([]);
    writeFileSync(path, JSON.stringify({}));
    expect([...resolveTaskAgentLiveMoves(reloadUserConfig(path).taskAgent?.liveMoves, env, warn).moves]).toEqual(['propose-green']);
  });

  test('기본 리뷰 요청 경로(defaultRequestReview)가 판단부 live review 에서 실제 spawn 을 «한 번» 부른다 — argv·cwd·떼어 띄움', async () => {
    const f = fixture();
    const { EventEmitter } = await import('node:events');
    const spawned: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const fakeSpawn = ((command: string, args: string[], options: Record<string, unknown>) => {
      spawned.push({ command, args, options });
      const child = Object.assign(new EventEmitter(), { pid: 4242, unref: () => {} });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }) as never;
    const deps = f.deps(['review']);
    deps.live.requestReview = (pr: number, intent: string, cwd?: string) => defaultRequestReview(pr, intent, cwd, { spawn: fakeSpawn, entry: '/repo/bin/elanous.mjs', configDir: '/universe' });
    const results = [job({ prNumber: 11, ok: true, worktreePath: '/tmp/wt-live' })];
    await run('needs-human', results, deps);
    await run('needs-human', results, deps);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.command).toBe(process.execPath);
    expect(spawned[0]!.args.slice(0, 8)).toEqual(['/repo/bin/elanous.mjs', '--config-dir', '/universe', 'self', 'review', '11', '--json', '--intent']);
    expect(spawned[0]!.args[8]).toContain('목표: feature ask');
    expect(spawned[0]!.args.slice(9)).toEqual(['--acp', '--acp-backend', 'claude']);
    expect(spawned[0]!.options).toMatchObject({ detached: true, stdio: 'ignore', cwd: '/tmp/wt-live' });
  });

  test('node-b review request uses the remote checkout and leaves JSON stdout in the HQ result file', async () => {
    const { EventEmitter } = await import('node:events');
    const root = mkdtempSync(join(tmpdir(), 'ta-remote-review-'));
    const worker = join(root, 'fake-eln');
    writeFileSync(worker, `#!/bin/sh\nprintf '%s\\n' '{"pr":77,"headCommit":"${HEAD_A}","verdict":"pass","reviewed":true,"mustFix":[]}'\n`);
    chmodSync(worker, 0o755);
    const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
    const fakeSpawn = ((command: string, args: string[], options: Record<string, unknown>) => {
      calls.push({ command, args, options });
      const run = spawnSync('sh', ['-c', args[6]!], { stdio: options.stdio as never, cwd: root });
      expect(run.status).toBe(0);
      const child = Object.assign(new EventEmitter(), { pid: 4242, unref: () => {} });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }) as never;
    try {
      const resultPath = join(root, 'review.json');
      const statePath = join(root, 'task-agent-actions.json');
      writeTaskCards(statePath, [{ id: 'ta-remote-review', text: 'review', createdAt: new Date().toISOString(), status: 'launched',
        pr: { number: 77, url: 'https://github.com/o/r/pull/77' },
        reviewRequests: [{ pr: 77, head: HEAD_A, at: new Date().toISOString(), resultPath }], history: [] }]);
      await defaultRequestReview(77, "review ' quoted", root, {
        spawn: fakeSpawn, remote: { host: 'node-b', cwd: root, elanous: worker, configDir: root }, resultPath,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).toBe('ssh');
      expect(calls[0]!.args.slice(0, 5)).toEqual(['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5']);
      expect(calls[0]!.args[5]).toBe('node-b');
      expect(calls[0]!.args[6]).toContain(`cd ${root} && ${worker} --config-dir ${root} self review 77 --json --intent`);
      expect(calls[0]!.args[6]).toContain('--acp --acp-backend claude');
      expect(calls[0]!.args[6]).not.toContain('--model');
      expect(calls[0]!.options.stdio).toEqual(['ignore', expect.any(Number), 'ignore']);
      expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toMatchObject({ pr: 77, headCommit: HEAD_A, verdict: 'pass' });
      captureReviewResults(statePath, { cardIds: ['ta-remote-review'] });
      expect(readTaskCard('ta-remote-review', statePath)?.history.some((entry) =>
        entry.event === 'live-move-result' && entry.kind === 'review' && entry.verdict === 'pass' && entry.resultPath === resultPath)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('수확 가능 결과가 ok 가 아니어도 리뷰 cwd 는 그 PR 을 낸 결과의 작업 트리', async () => {
    const f = fixture();
    const seen: Array<string | undefined> = [];
    const deps = f.deps(['review']);
    deps.live.prHead = async (_pr: number, cwd?: string) => { seen.push(cwd); return { head: HEAD_A, state: 'OPEN' }; };
    deps.live.requestReview = async (_pr: number, _intent: string, cwd?: string) => { seen.push(cwd); };
    await run('harvestable-awaiting-human', [job({ prNumber: 12, harvestable: true, worktreePath: '/tmp/wt-harvest' })], deps);
    expect(seen).toEqual(['/tmp/wt-harvest', '/tmp/wt-harvest']);
  });

  test('다중 결과 — 리뷰는 그 PR 을 낸 결과의 카드·작업 트리에만 · 그 결과에 작업 트리가 없으면 보류', async () => {
    const f = fixture();
    writeTaskCards(f.statePath, [{ id: 'ta-other', text: 'other ask', createdAt: '2026-10-07T00:00:00.000Z', status: 'launched', history: [] }]);
    const seen: Array<string | undefined> = [];
    const deps = f.deps(['review']);
    deps.live.requestReview = async (_pr: number, _intent: string, cwd?: string) => { seen.push(cwd); };
    // 첫 결과(다른 과제 · ok · 작업 트리)는 PR 이 없다 — PR 21 은 둘째 결과(ta-live-1)가 냈다.
    const results = [
      job({ taskId: 'ta-other', feature: 'other ask', ok: true, worktreePath: '/tmp/wt-other' }),
      job({ prNumber: 21, harvestable: true, worktreePath: '/tmp/wt-21' }),
    ];
    const out = await run('harvestable-awaiting-human', results, deps);
    expect(out.liveMove).toMatchObject({ card: 'ta-live-1', ok: true });
    expect(seen).toEqual(['/tmp/wt-21']);
    expect(readTaskCard('ta-other', f.statePath)!.reviewRequests).toBeUndefined();
    expect(readTaskCard('ta-live-1', f.statePath)!.reviewRequests).toEqual([expect.objectContaining({ pr: 21 })]);
    const noTree = await run('harvestable-awaiting-human', [results[0]!, job({ prNumber: 22, harvestable: true })], deps);
    expect(noTree.liveMove).toMatchObject({ ok: false, detail: 'PR #22 worktree unknown — stays shadow' });
    expect(seen).toHaveLength(1);
  });

  test('다중 결과 — green 제안은 병합 PR 을 낸 결과의 카드에만', async () => {
    const f = fixture();
    writeTaskCards(f.statePath, [{ id: 'ta-other', text: 'other ask', createdAt: '2026-10-07T00:00:00.000Z', status: 'launched', history: [] }]);
    const results = [
      job({ taskId: 'ta-other', feature: 'other ask', ok: true, worktreePath: '/tmp/wt-other', prNumber: 31, merged: true }),
      job({ prNumber: 32, merged: true }),
    ];
    const out = await run('converged', results, f.deps(['propose-green']));
    expect(out.liveMove).toMatchObject({ card: 'ta-other', ok: true });
    expect(readTaskCard('ta-other', f.statePath)!.greenProposal?.evidence).toEqual({ 'ta-other': '#31' });
    expect(readTaskCard('ta-live-1', f.statePath)!.greenProposal).toBeUndefined();
  });

  test('실 자식 프로세스 — 기본 spawner 가 가짜 진입점을 실제로 띄우고 그 자식이 argv 를 남긴다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ta-live-spawn-'));
    const entry = join(dir, 'fake-elanous.mjs');
    const out = join(dir, 'argv.json');
    writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }));`);
    await defaultRequestReview(13, 'intent text', dir, { entry, configDir: join(dir, 'universe') });
    const { existsSync, readFileSync, realpathSync } = await import('node:fs');
    for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
    const written = JSON.parse(readFileSync(out, 'utf8')) as { argv: string[]; cwd: string };
    expect(written.argv).toEqual(['--config-dir', join(dir, 'universe'), 'self', 'review', '13', '--json', '--intent', 'intent text', '--acp', '--acp-backend', 'claude']);
    expect(realpathSync(written.cwd)).toBe(realpathSync(dir));
  });

  test('PR 머리 조회 — 받은 env 먼저 · 실패면 프록시만 뺀 env 로 한 번 더 · 모양이 틀리면 null', async () => {
    const calls: Array<{ args: string[]; proxy: string | undefined; cwd?: string }> = [];
    const saved = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = 'http://proxy.invalid:1';
    try {
      const gh = (args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string }) => {
        calls.push({ args, proxy: options.env.HTTPS_PROXY, ...(options.cwd ? { cwd: options.cwd } : {}) });
        return options.env.HTTPS_PROXY ? { status: 1, stdout: '' } : { status: 0, stdout: JSON.stringify({ headRefOid: HEAD_A, state: 'OPEN' }) };
      };
      expect(await defaultPrHead(5, '/tmp/wt-5', gh)).toEqual({ head: HEAD_A, state: 'OPEN' });
      expect(calls).toEqual([
        { args: ['pr', 'view', '5', '--json', 'headRefOid,headRefName,state,url'], proxy: 'http://proxy.invalid:1', cwd: '/tmp/wt-5' },
        { args: ['pr', 'view', '5', '--json', 'headRefOid,headRefName,state,url'], proxy: undefined, cwd: '/tmp/wt-5' },
      ]);
      expect(await defaultPrHead(5, undefined, () => ({ status: 0, stdout: JSON.stringify({ headRefOid: 'short', state: 'OPEN' }) }))).toBeNull();
      expect(await defaultPrHead(5, undefined, () => ({ status: 1, stdout: '' }))).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = saved;
    }
  });

  test('모르는 항목 경고는 안전하지 않은 수를 판단할 때도 남는다(실제 설정 경로)', async () => {
    const f = fixture();
    const dir = mkdtempSync(join(tmpdir(), 'ta-live-unknown-'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ taskAgent: { liveMoves: ['relaunch'] } }));
    const savedXdg = process.env.XDG_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
    setElanousConfigDir(dir);
    const warned: unknown[] = [];
    const spy = spyOn(debug, 'log').mockImplementation(((category: string, event: string, data: unknown) => { if (event === 'live-moves-ignored') warned.push({ category, data }); }) as never);
    try {
      const { liveMoves: _drop, ...deps } = f.deps();
      const out = await run('no-progress', [job()], deps);
      expect(out.move).toBe('narrow-relaunch');
      expect(out.liveMove).toBeUndefined();
    } finally {
      spy.mockRestore();
      resetElanousConfigDir();
      if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg;
    }
    expect(warned).toEqual([{ category: 'task-agent', data: expect.objectContaining({ ignored: ['relaunch'], source: 'config' }) }]);
    expect(f.logs.at(-1)!.data).toMatchObject({ live: false, liveExecuted: false });
  });

  test('다중 결과 — PR 을 낸 결과의 카드를 못 찾으면 관측 card 는 null(다른 결과의 카드로 대체하지 않는다)', async () => {
    const f = fixture();
    const deps = f.deps(['review']);
    const out = await run('harvestable-awaiting-human', [
      job({ ok: true, worktreePath: '/tmp/wt-own' }),
      job({ taskId: 'unknown-task', feature: 'no card for this', prNumber: 41, harvestable: true, worktreePath: '/tmp/wt-41' }),
    ], deps);
    expect(out.liveMove).toMatchObject({ card: null, ok: false });
    expect(f.logs.find((entry) => entry.event === 'shadow-move')!.data).toMatchObject({ card: null, live: true, liveExecuted: false });
    expect(f.reviews).toHaveLength(0);
  });

  test('기본 리뷰 요청 argv — 진입점 · 같은 우주 config-dir · Claude ACP', () => {
    expect(liveReviewArgs('/repo/bin/elanous.mjs', '/universe', 9, 'intent')).toEqual(['/repo/bin/elanous.mjs', '--config-dir', '/universe', 'self', 'review', '9', '--json', '--intent', 'intent', '--acp', '--acp-backend', 'claude']);
  });
});

describe('TA-LIVE-LAND — pinned PR land only on reviewed current head', () => {
  const reviewed = { verdict: 'pass' as const, head: HEAD_A, mustFixCount: 0 };
  function landFixture() {
    const f = fixture();
    const calls: Array<{ pr: number; head: string; cwd: string }> = [];
    let view = { head: HEAD_A, state: 'OPEN', isDraft: false };
    const live = {
      statePath: f.statePath,
      log: f.deps().log,
      landPrHead: async () => view,
      land: async (pr: number, head: string, cwd: string) => { calls.push({ pr, head, cwd }); return { status: 0, stdout: 'merged' }; },
    };
    const card = () => readTaskCard('ta-live-1', f.statePath)!;
    const ctx = { cwd: '/tmp/land-wt', review: reviewed };
    return { f, calls, live, card, ctx, setView: (next: typeof view) => { view = next; } };
  }

  test('OPEN non-draft + pass for current SHA → exactly one pinned pr land, history and observation', async () => {
    const t = landFixture();
    const wake: string[] = [];
    const live = { ...t.live, advanceLandedPiece: async (pieceId: string) => { wake.push(pieceId); } };
    const first = await executeLiveLand(t.card(), 51, t.ctx, live);
    expect(first).toMatchObject({ kind: 'land', executed: true, ok: true });
    expect(t.calls).toEqual([{ pr: 51, head: HEAD_A, cwd: '/tmp/land-wt' }]);
    expect(t.f.logs.find(entry => entry.event === 'live-move')?.data).toMatchObject({ kind: 'land', executed: true, ok: true, live: true });
    expect(t.card().landAttempts).toEqual([expect.objectContaining({ pr: 51, head: HEAD_A, ok: true, detail: 'merged' })]);
    const second = await executeLiveLand(t.card(), 51, t.ctx, live);
    expect(second).toMatchObject({ executed: false, detail: expect.stringContaining('already attempted') });
    expect(t.calls).toHaveLength(1);
    expect(wake).toEqual(['ta-live-1']);
  });

  test('stale review head, missing pass, draft and closed PR all refuse to land', async () => {
    const t = landFixture();
    expect((await executeLiveLand(t.card(), 51, { ...t.ctx, review: { verdict: 'pass', head: HEAD_B } }, t.live)).detail).toContain('review head mismatch');
    expect((await executeLiveLand(t.card(), 51, { ...t.ctx, review: undefined }, t.live)).detail).toContain('pass missing');
    t.setView({ head: HEAD_A, state: 'OPEN', isDraft: true });
    expect((await executeLiveLand(t.card(), 51, t.ctx, t.live)).detail).toContain('draft');
    t.setView({ head: HEAD_A, state: 'CLOSED', isDraft: false });
    expect((await executeLiveLand(t.card(), 51, t.ctx, t.live)).detail).toContain('CLOSED');
    expect(t.calls).toHaveLength(0);
    expect(t.card().landAttempts).toBeUndefined();
  });

  // TA-CARD-MERGE-RECONCILE — 실패 카드에 묶인 PR 을 사람이 손수 병합하면 생산 land 경로가 그대로 정산한다(실물 git 조상 검증 · updateTaskCard 락).
  test('executeLiveLand settles a hand-merged PR through reconcileHandMergedCard and keeps non-ancestor MERGED refused', async () => {
    const gitEnv: Record<string, string | undefined> = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    delete gitEnv.GIT_CONFIG_COUNT;
    delete gitEnv.GIT_CONFIG_PARAMETERS;
    delete gitEnv.GIT_TEMPLATE_DIR;
    const dir = mkdtempSync(join(tmpdir(), 'ta-hand-merge-live-'));
    const git = (...args: string[]) => {
      const run = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv });
      if (run.status !== 0) throw new Error(`git ${args.join(' ')}: ${String(run.stderr).trim()}`);
      return String(run.stdout).trim();
    };
    const commit = (message: string) => git('-c', 'user.name=ta', '-c', 'user.email=ta@example.invalid', 'commit', '--allow-empty', '-m', message);
    git('init', '-b', 'main');
    commit('base');
    git('checkout', '-b', 'feature');
    commit('feature');
    git('checkout', 'main');
    git('-c', 'user.name=ta', '-c', 'user.email=ta@example.invalid', 'merge', '--no-ff', '-m', 'merge feature', 'feature');
    const mergeCommit = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', 'main');
    const stateDir = mkdtempSync(join(tmpdir(), 'ta-hand-merge-live-state-'));
    const statePath = join(stateDir, 'task-agent-actions.json');
    const url = 'https://github.com/example/repo/pull/79';
    const reason = 'failed/needs-owner — run died';
    const card: TaskCard = { id: 'ta-live-hand', text: 'hand merge', createdAt: '2026-10-13T00:00:00Z', status: 'failed',
      history: [{ event: 'judge', detail: reason, at: '2026-10-13T00:00:00Z' }],
      pr: { number: 79, url }, taLand: true, landAttempts: [{ pr: 79, head: HEAD_A, at: '2026-10-13T00:00:00Z' }] };
    writeTaskCards(statePath, [card]);
    const deps = {
      statePath,
      log: () => {},
      landPrHead: async () => ({ head: HEAD_A, state: 'MERGED', isDraft: false, url }),
      handMergePr: async () => ({ state: 'MERGED', url, baseRefName: 'main', mergedAt: '2026-10-14T00:00:00Z', mergeCommit }),
    };
    try {
      const out = await executeLiveLand(card, 79, { cwd: dir }, deps);
      expect(out).toMatchObject({ kind: 'land', card: 'ta-live-hand', ok: true, executed: true });
      expect(out.detail).toContain('landed-by-hand');
      const settled = readTaskCard('ta-live-hand', statePath)!;
      expect(settled.status).toBe('landed-by-hand');
      expect(settled.history.at(-1)?.event).toBe('hand-move');
      expect(settled.history[0]).toMatchObject({ event: 'judge', detail: reason });
      expect(settled.prTerminal).toMatchObject({ pr: 79, head: mergeCommit, state: 'MERGED' });
      const offMainUrl = 'https://github.com/example/repo/pull/80';
      const offMain: TaskCard = { ...card, id: 'ta-live-hand-2', pr: { number: 80, url: offMainUrl },
        landAttempts: [{ pr: 80, head: HEAD_A, at: '2026-10-13T00:00:00Z' }] };
      writeTaskCards(statePath, [offMain]);
      const refused = await executeLiveLand(offMain, 80, { cwd: dir }, { ...deps,
        handMergePr: async () => ({ state: 'MERGED', url: offMainUrl, baseRefName: 'main', mergedAt: '2026-10-14T00:00:00Z', mergeCommit: HEAD_B }) });
      expect(refused).toMatchObject({ kind: 'land', card: 'ta-live-hand-2', ok: false, executed: false });
      expect(refused.detail).toContain('MERGED');
      expect(readTaskCard('ta-live-hand-2', statePath)?.status).toBe('failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  // TA-LAND-MUSTFIX-ZERO — pass ⊕ must-fix 1 → land 안 함 · must-fix 수 모름 → land 안 함(fail-closed) · 둘 다 관측에 사유를 남긴다.
  test('pass with must-fix or with an unknown must-fix count never lands and leaves the reason in observation', async () => {
    const t = landFixture();
    const withMustFix = await executeLiveLand(t.card(), 51, { ...t.ctx, review: { ...reviewed, mustFixCount: 1 } as typeof t.ctx.review }, t.live);
    expect(withMustFix).toMatchObject({ kind: 'land', executed: false, ok: false, detail: expect.stringContaining('review-warn-with-must-fix') });
    const unknown = await executeLiveLand(t.card(), 51, { ...t.ctx, review: { verdict: 'pass', head: HEAD_A } }, t.live);
    expect(unknown).toMatchObject({ kind: 'land', executed: false, ok: false, detail: expect.stringContaining('review-must-fix-unknown') });
    const moves = t.f.logs.filter(entry => entry.event === 'live-move').map(entry => entry.data);
    expect(moves).toEqual([expect.objectContaining({ kind: 'land', executed: false, detail: expect.stringContaining('review-warn-with-must-fix') }),
      expect.objectContaining({ kind: 'land', executed: false, detail: expect.stringContaining('review-must-fix-unknown') })]);
    expect(t.calls).toHaveLength(0);
    expect(t.card().landAttempts).toBeUndefined();
  });

  // TA-LAND-WARN-MUSTFIX0 — 정본 규칙 «warn ⊕ must-fix 0 = 통과»: land 관문은 pass/warn 을 같은 줄로 본다(must-fix 0 · 수 모름 거부는 그대로).
  test.each([
    ['warn ⊕ must-fix 0 → land', { verdict: 'warn', mustFixCount: 0 }, 1, null],
    ['warn ⊕ must-fix 1 → no land', { verdict: 'warn', mustFixCount: 1 }, 0, 'review-warn-with-must-fix'],
    ['warn ⊕ must-fix unknown → no land', { verdict: 'warn' }, 0, 'review-must-fix-unknown'],
    ['pass ⊕ must-fix 0 → land (unchanged)', { verdict: 'pass', mustFixCount: 0 }, 1, null],
    ['fail → no land', { verdict: 'fail', mustFixCount: 0 }, 0, 'pass missing'],
    ['warn ⊕ must-fix 0 ⊕ reviewed:false → no land', { verdict: 'warn', mustFixCount: 0, reviewed: false }, 0, 'not reviewed'],
    ['warn ⊕ must-fix 0 ⊕ reviewed:true → land', { verdict: 'warn', mustFixCount: 0, reviewed: true }, 1, null],
  ] as const)('executeLiveLand: %s', async (_name, review, lands, reason) => {
    const t = landFixture();
    const out = await executeLiveLand(t.card(), 51, { ...t.ctx, review: { head: HEAD_A, ...review } as typeof t.ctx.review }, t.live);
    expect(t.calls).toHaveLength(lands);
    expect(out.executed).toBe(lands === 1);
    if (reason) expect(out.detail).toContain(reason);
  });

  // TA-LAND-WORKTREE — cwd HEAD ≠ PR 머리(Pod 런 PR · 호스트 checkout)면 PR 머리 임시 워크트리에서 land 하고 걷는다.
  function worktreeSeam(t: ReturnType<typeof landFixture>, opts: { local: string | null; branch?: string; fail?: string }) {
    const events: string[] = [];
    const created: Array<Record<string, unknown>> = [];
    const live = {
      ...t.live,
      landPrHead: async () => ({ head: HEAD_A, state: 'OPEN', isDraft: false, branch: 'feature/pod' }),
      landWorktree: {
        localHead: (cwd: string) => { events.push(`head:${cwd}`); return opts.local; },
        localBranch: () => opts.branch ?? 'feature/pod',
        create: async (input: LandWorktreeInput): Promise<LandWorktree | LandWorktreeFailure> => {
          created.push(input as unknown as Record<string, unknown>);
          if (opts.fail) return { reason: opts.fail, created: false, removed: null };
          events.push('create');
          return { cwd: '/state/land-worktrees/x', created: true, cleanup: () => { events.push('cleanup'); return { removed: true }; } };
        },
      },
    };
    return { events, created, live };
  }

  test('cwd HEAD ≠ PR head → temp worktree on the PR head → land runs there → worktree removed', async () => {
    const t = landFixture();
    const w = worktreeSeam(t, { local: HEAD_B });
    const out = await executeLiveLand(t.card(), 51, t.ctx, w.live);
    expect(out).toMatchObject({ kind: 'land', executed: true, ok: true });
    expect(w.created).toEqual([{ card: 'ta-live-1', pr: 51, head: HEAD_A, branch: 'feature/pod', repoCwd: '/tmp/land-wt', statePath: t.f.statePath }]);
    expect(t.calls).toEqual([{ pr: 51, head: HEAD_A, cwd: '/state/land-worktrees/x' }]);
    expect(w.events).toEqual(['head:/tmp/land-wt', 'create', 'cleanup']);
    expect(t.f.logs.filter(entry => entry.event === 'land-worktree').map(entry => [entry.data.created, entry.data.removed])).toEqual([[true, false], [true, true]]);
  });

  test('queue acceptance retains the exact-head worktree for the train; refusal records the reason and removes it', async () => {
    const accepted = landFixture();
    const first = worktreeSeam(accepted, { local: HEAD_B });
    const queued = await executeLiveLand(accepted.card(), 51, { ...accepted.ctx, reviewResultPath: '/state/review-results/ta-51-a.json' }, {
      ...first.live, landQueueConfig: { command: '/ops/land-enqueue.sh', remote: 'node-c' },
      queueLanding: async (input) => ({ status: 0, stdout: `OK #${input.pr} queued ${input.cwd}` }),
    });
    expect(queued).toMatchObject({ executed: true, ok: true, queued: true });
    expect(first.events).toEqual(['head:/tmp/land-wt', 'create']);
    expect(accepted.card().landAttempts).toEqual([expect.objectContaining({ pr: 51, head: HEAD_A, ok: true })]);

    const refused = landFixture();
    const second = worktreeSeam(refused, { local: HEAD_B });
    const failed = await executeLiveLand(refused.card(), 51, { ...refused.ctx, reviewResultPath: '/state/review-results/ta-51-a.json' }, {
      ...second.live, landQueueConfig: { command: '/ops/land-enqueue.sh', remote: 'node-c' },
      queueLanding: async () => ({ status: 1, stdout: 'REFUSE review-fail-newer' }),
    });
    expect(failed).toMatchObject({ executed: true, ok: false, detail: expect.stringContaining('REFUSE review-fail-newer') });
    expect(second.events).toEqual(['head:/tmp/land-wt', 'create', 'cleanup']);
    expect(refused.card().landAttempts).toEqual([expect.objectContaining({ pr: 51, head: HEAD_A, ok: false })]);
  });

  test('invalid queue config refuses before a worktree or land attempt exists', async () => {
    const t = landFixture();
    const out = await executeLiveLand(t.card(), 51, t.ctx, {
      ...t.live, landQueueConfig: { command: '', remote: '' },
      landWorktree: { localHead: () => { throw new Error('must not inspect worktree'); } },
    });
    expect(out).toMatchObject({ executed: false, ok: false, detail: expect.stringContaining('land queue command/remote invalid') });
    expect(t.card().landAttempts).toBeUndefined();
  });

  test('supervisor propose-land carries the captured review path into the queue adapter', async () => {
    const t = landFixture();
    const reviewResultPath = join(t.f.statePath, '..', 'review-51.json');
    writeFileSync(reviewResultPath, JSON.stringify({ pr: 51, headCommit: HEAD_A, verdict: 'pass', mustFix: [], reviewed: true }));
    writeTaskCards(t.f.statePath, [{ ...t.card(), reviewRequests: [{ pr: 51, head: HEAD_A, at: new Date().toISOString(), resultPath: reviewResultPath }] }]);
    const queued: string[] = [];
    const out = await recordTaskAgentShadowMove({
      runId: 'queue-supervisor-1', stopReason: 'needs-human',
      results: [job({ prNumber: 51, harvestable: true, worktreePath: '/tmp/land-wt' })], selfReview: reviewed,
    }, { ...t.f.deps(['propose-land']), live: {
      ...t.live, landQueueConfig: { command: '/ops/land-enqueue.sh', remote: 'node-c' },
      queueLanding: async (input) => { queued.push(input.reviewResult); return { status: 0, stdout: 'OK #51 head=aaaaaaaaaaaa' }; },
    } });
    expect(out.liveMove).toMatchObject({ kind: 'land', executed: true, ok: true, queued: true });
    expect(queued).toEqual([reviewResultPath]);
  });

  test('a clean registered PR branch owner is used for land and never cleaned up', async () => {
    const t = landFixture();
    const w = worktreeSeam(t, { local: HEAD_B });
    let cleanupCalled = false;
    const out = await executeLiveLand(t.card(), 51, t.ctx, {
      ...w.live, landWorktree: { ...w.live.landWorktree, create: async () => ({ cwd: '/owner/pr-branch', created: false, cleanup: () => { cleanupCalled = true; return { removed: false, reason: 'borrowed owner — left untouched' }; } }) },
    });
    expect(out).toMatchObject({ executed: true, ok: true });
    expect(t.calls).toEqual([{ pr: 51, head: HEAD_A, cwd: '/owner/pr-branch' }]);
    expect(cleanupCalled).toBe(true);
    expect(t.f.logs.filter(entry => entry.event === 'land-worktree').map(entry => [entry.data.created, entry.data.removed])).toEqual([[false, false], [false, false]]);
  });

  test('cwd at reviewed SHA on another branch borrows the verified PR branch owner', async () => {
    const t = landFixture();
    const w = worktreeSeam(t, { local: HEAD_A, branch: 'host/main' });
    const out = await executeLiveLand(t.card(), 51, t.ctx, {
      ...w.live, landWorktree: { ...w.live.landWorktree, create: async () => ({ cwd: '/owner/pr-branch', created: false, cleanup: () => ({ removed: false, reason: 'borrowed owner — left untouched' }) }) },
    });
    expect(out).toMatchObject({ executed: true, ok: true });
    expect(t.calls).toEqual([{ pr: 51, head: HEAD_A, cwd: '/owner/pr-branch' }]);
    expect(w.created).toEqual([]);
    expect(t.f.logs.filter(entry => entry.event === 'land-worktree').map(entry => entry.data.created)).toEqual([false, false]);
  });

  test('occupied dirty branch refuses land and emits owner path in worktree-conflict observation', async () => {
    const t = landFixture();
    const w = worktreeSeam(t, { local: HEAD_B });
    const out = await executeLiveLand(t.card(), 51, t.ctx, {
      ...w.live, landWorktree: { ...w.live.landWorktree, create: async () => ({ reason: 'worktree-conflict: owner dirty', created: false, removed: null, kind: 'worktree-conflict', ownerPath: '/owner/pr-branch' }) },
    });
    expect(out).toMatchObject({ executed: false, ok: false });
    expect(t.calls).toEqual([]);
    expect(t.f.logs.find(entry => entry.event === 'worktree-conflict')?.data).toMatchObject({ card: 'ta-live-1', pr: 51, head: HEAD_A, branch: 'feature/pod', ownerPath: '/owner/pr-branch' });
  });

  test('cwd HEAD = PR head (local run worktree) → no worktree, land in cwd as before', async () => {
    const t = landFixture();
    const w = worktreeSeam(t, { local: HEAD_A });
    await executeLiveLand(t.card(), 51, t.ctx, w.live);
    expect(w.created).toEqual([]);
    expect(t.calls).toEqual([{ pr: 51, head: HEAD_A, cwd: '/tmp/land-wt' }]);
    expect(t.f.logs.some(entry => entry.event === 'land-worktree')).toBe(false);
  });

  test('a relative overlap-evidence path is pinned to the original cwd when landing from the temp worktree', async () => {
    const t = landFixture();
    const w = worktreeSeam(t, { local: HEAD_B });
    const seen: Array<string | undefined> = [];
    await executeLiveLand(t.card(), 51, { ...t.ctx, overlapEvidence: 'evidence/x.json' },
      { ...w.live, land: async (_pr: number, _head: string, _cwd: string, o?: { overlapEvidence?: string }) => { seen.push(o?.overlapEvidence); return { status: 0, stdout: 'merged' }; } });
    expect(seen).toEqual(['/tmp/land-wt/evidence/x.json']);
    // 같은 cwd(로컬 런)면 종전 그대로 넘긴다.
    const t2 = landFixture();
    const same = worktreeSeam(t2, { local: HEAD_A });
    const seen2: Array<string | undefined> = [];
    await executeLiveLand(t2.card(), 51, { ...t2.ctx, overlapEvidence: 'evidence/x.json' },
      { ...same.live, land: async (_pr: number, _head: string, _cwd: string, o?: { overlapEvidence?: string }) => { seen2.push(o?.overlapEvidence); return { status: 0, stdout: 'merged' }; } });
    expect(seen2).toEqual(['evidence/x.json']);
  });

  test('cwd HEAD unreadable → no worktree, land in cwd as before', async () => {
    const t = landFixture();
    const w = worktreeSeam(t, { local: null });
    await executeLiveLand(t.card(), 51, t.ctx, w.live);
    expect(w.created).toEqual([]);
    expect(t.calls).toEqual([{ pr: 51, head: HEAD_A, cwd: '/tmp/land-wt' }]);
  });

  test('worktree creation fails → land 0 · reason · the head attempt is released for the next tick', async () => {
    const t = landFixture();
    const w = worktreeSeam(t, { local: HEAD_B, fail: 'local branch feature/pod exists at 1234 (not the PR head)' });
    const out = await executeLiveLand(t.card(), 51, { ...t.ctx, cycleId: 'wt-fail-cycle' }, w.live);
    expect(out).toMatchObject({ kind: 'land', executed: false, ok: false, detail: expect.stringContaining('land worktree unavailable: local branch feature/pod') });
    expect(t.calls).toEqual([]);
    expect(t.card().landAttempts ?? []).toEqual([]);
    expect(t.f.logs.find(entry => entry.event === 'land-worktree')?.data).toMatchObject({ created: false, removed: null, reason: expect.stringContaining('local branch') });
    // 다음 틱(같은 주기 id)은 다시 시도할 수 있다.
    const retry = worktreeSeam(t, { local: HEAD_A });
    expect(await executeLiveLand(t.card(), 51, { ...t.ctx, cycleId: 'wt-fail-cycle' }, retry.live)).toMatchObject({ executed: true, ok: true });
  });

  test('recordTaskAgentShadowMove reaches executeLiveLand: three create failures cap the next tick and log once', async () => {
    const t = landFixture();
    const configDir = mkdtempSync(join(tmpdir(), 'ta-land-create-cap-default-'));
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({}));
    setElanousConfigDir(configDir);
    try {
      const createCalls: LandWorktreeInput[] = [];
      const live = {
        ...t.live,
        landWorktree: {
          localHead: () => HEAD_B,
          create: async (input: LandWorktreeInput): Promise<LandWorktree | LandWorktreeFailure> => {
            createCalls.push(input);
            return { reason: `create failed ${createCalls.length}`, created: false, removed: null };
          },
        },
      };
      const throughDispatcher = (runId: string) => recordTaskAgentShadowMove({
        runId, stopReason: 'needs-human', results: [job({ prNumber: 51, harvestable: true, worktreePath: '/tmp/land-wt' })], selfReview: reviewed,
      }, { ...t.f.deps(['propose-land']), live });
      let third: Awaited<ReturnType<typeof throughDispatcher>> | undefined;
      for (let tick = 1; tick <= 3; tick++) third = await throughDispatcher(`create-cap-${tick}`);
      expect(createCalls).toHaveLength(3);
      expect(t.calls).toHaveLength(0);
      expect(third?.liveMove?.detail).toBe('land worktree create capped (3/3): create failed 3');
      expect(worktreeCreateFailures(t.card())).toHaveLength(3);

      const fourth = await throughDispatcher('create-cap-4');
      expect(fourth.liveMove?.detail).toBe('land worktree create capped (3/3): create failed 3');
      expect(createCalls).toHaveLength(3);
      expect(t.calls).toHaveLength(0);
      expect(t.f.logs.filter(entry => entry.event === 'land-worktree-create-capped')).toEqual([
        expect.objectContaining({ data: { card: 'ta-live-1', pr: 51, head: HEAD_A, failures: 3, cap: 3, reason: 'create failed 3' } }),
      ]);
    } finally { resetElanousConfigDir(); }
  });

  test('successful worktree creation clears the same PR failure count', async () => {
    const t = landFixture();
    // 개발자 실제 설정(tasks.landWorktreeCreateCap)에 흔들리지 않게 빈 설정 디렉터리로 고정한다(기본 상한 3).
    const configDir = mkdtempSync(join(tmpdir(), 'ta-land-create-cap-iso-'));
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({}));
    setElanousConfigDir(configDir);
    try {
      let createCalls = 0;
      const live = {
        ...t.live,
        landWorktree: {
          localHead: () => HEAD_B,
          create: async (): Promise<LandWorktree | LandWorktreeFailure> => {
            createCalls++;
            if (createCalls === 1) return { reason: 'first create failed', created: false, removed: null };
            return { cwd: '/state/land-worktrees/success', created: true, cleanup: () => ({ removed: true }) };
          },
        },
        land: async () => ({ status: 0, stdout: 'merged' }),
      };
      await executeLiveLand(t.card(), 51, { ...t.ctx, cycleId: 'create-reset-1' }, live);
      expect(worktreeCreateFailures(t.card())).toHaveLength(1);
      expect((await executeLiveLand(t.card(), 51, { ...t.ctx, cycleId: 'create-reset-2' }, live)).ok).toBe(true);
      expect(createCalls).toBe(2);
      expect(worktreeCreateFailures(t.card())).toBeUndefined();
    } finally { resetElanousConfigDir(); }
  });

  test('a new PR head starts a fresh worktree-create retry count', async () => {
    const t = landFixture();
    // 개발자 실제 설정(tasks.landWorktreeCreateCap)에 흔들리지 않게 빈 설정 디렉터리로 고정한다(기본 상한 3).
    const configDir = mkdtempSync(join(tmpdir(), 'ta-land-create-cap-iso-'));
    writeFileSync(join(configDir, 'config.json'), JSON.stringify({}));
    setElanousConfigDir(configDir);
    try {
      const createCalls: LandWorktreeInput[] = [];
      const live = {
        ...t.live,
        landWorktree: {
          localHead: () => HEAD_C,
          create: async (input: LandWorktreeInput): Promise<LandWorktree | LandWorktreeFailure> => {
            createCalls.push(input);
            if (input.head === HEAD_A) return { reason: 'old head create failed', created: false, removed: null };
            return { cwd: '/state/land-worktrees/new-head', created: true, cleanup: () => ({ removed: true }) };
          },
        },
        land: async () => ({ status: 0, stdout: 'merged' }),
      };
      for (let tick = 1; tick <= 3; tick++) {
        await executeLiveLand(t.card(), 51, { ...t.ctx, cycleId: `old-head-${tick}` }, live);
      }
      expect(worktreeCreateFailures(t.card())).toHaveLength(3);
      t.setView({ head: HEAD_B, state: 'OPEN', isDraft: false });
      const retried = await executeLiveLand(t.card(), 51, { ...t.ctx, review: { ...reviewed, head: HEAD_B }, cycleId: 'new-head' }, live);
      expect(retried).toMatchObject({ executed: true, ok: true });
      expect(createCalls.filter(input => input.head === HEAD_B)).toHaveLength(1);
      expect(worktreeCreateFailures(t.card())).toBeUndefined();
    } finally { resetElanousConfigDir(); }
  });

  test('land fails in the temp worktree → still removed', async () => {
    const t = landFixture();
    const w = worktreeSeam(t, { local: HEAD_B });
    const out = await executeLiveLand(t.card(), 51, t.ctx, { ...w.live, land: async () => ({ status: 1, stdout: '', stderr: '✗ gate' }) });
    expect(out).toMatchObject({ executed: true, ok: false, detail: '✗ gate' });
    expect(w.events).toEqual(['head:/tmp/land-wt', 'create', 'cleanup']);
  });

  test('child review must-fix count rides the job result: a pass carrying must-fix is refused at the land gate', async () => {
    const { singleRunAsJobResult } = await import('../self-implement/self-implement-cli.js');
    const { parseSelfImplementJson } = await import('../task-orchestrator/surfaces/self-implement.js');
    const t = landFixture();
    const base = { runId: 'ta-live-1', ok: true, stage: 'pr-opened', prNumber: 51, worktreePath: '/tmp/land-wt', checkedHeadCommit: HEAD_A, reviewedHeadCommit: HEAD_A,
      review: { verdict: 'pass', reviewed: true, mustFix: ['still broken'], shouldFix: [], summary: 'pass with must-fix' } };
    const result = singleRunAsJobResult('feature ask', base as unknown as Parameters<typeof singleRunAsJobResult>[1]);
    expect(result.selfReview).toEqual({ verdict: 'pass', head: HEAD_A, mustFixCount: 1 });
    expect(parseSelfImplementJson(JSON.stringify(base))?.selfReview).toEqual({ verdict: 'pass', head: HEAD_A, mustFixCount: 1 });
    // 목록 없는 자식 JSON = «모름» — 수를 싣지 않는다(«0» 으로 메우지 않는다).
    expect(parseSelfImplementJson(JSON.stringify({ ...base, review: { verdict: 'pass', reviewed: true } }))?.selfReview).toEqual({ verdict: 'pass', head: HEAD_A });
    // 문자열 아닌 원소가 섞인 목록도 «모름» — actions.ts 와 같은 판정.
    expect(parseSelfImplementJson(JSON.stringify({ ...base, review: { ...base.review, mustFix: [null] } }))?.selfReview).toEqual({ verdict: 'pass', head: HEAD_A });
    expect(singleRunAsJobResult('feature ask', { ...base, review: { ...base.review, mustFix: [null] } } as unknown as Parameters<typeof singleRunAsJobResult>[1]).selfReview).toEqual({ verdict: 'pass', head: HEAD_A });
    const move = await recordTaskAgentShadowMove({ runId: 'mustfix-wired', stopReason: 'needs-human', results: [{ ...result, taskId: 'ta-live-1' }], selfReview: result.selfReview },
      { ...t.f.deps(['propose-land']), live: t.live });
    expect(move.liveMove?.detail).toContain('review-warn-with-must-fix');
    expect(t.calls).toHaveLength(0);
  });

  test('run PR URL must match the freshly observed PR identity', async () => {
    const t = landFixture();
    expect((await executeLiveLand(t.card(), 51, { ...t.ctx, produced: { prUrl: 'https://github.com/owner/repo/pull/51' } }, t.live)).detail).toContain('URL mismatches');
    expect(t.calls).toHaveLength(0);
  });

  test('missing card, PR or verified repository never invokes landing', async () => {
    const t = landFixture();
    expect((await executeLiveLand(undefined, 51, t.ctx, t.live)).detail).toContain('no task card');
    expect((await executeLiveLand(t.card(), undefined, t.ctx, t.live)).detail).toContain('no PR');
    expect((await executeLiveLand(t.card(), 51, { review: reviewed }, { ...t.live, repoCandidates: () => [] })).detail).toContain('worktree unknown');
    expect(t.calls).toHaveLength(0);
  });

  test('one judgement cycle cannot land a second PR even when its review and head pass', async () => {
    const t = landFixture();
    const ctx = { ...t.ctx, cycleId: 'unique-land-cycle-51' };
    expect((await executeLiveLand(t.card(), 51, ctx, t.live)).executed).toBe(true);
    expect((await executeLiveLand(t.card(), 52, ctx, t.live)).detail).toContain('already landed');
    expect(t.calls).toHaveLength(1);
    expect(t.card().landAttempts).toHaveLength(1);
  });

  test('run id prevents a second landing when no separate judgement cycle is supplied', async () => {
    const t = landFixture();
    expect((await executeLiveLand(t.card(), 51, { ...t.ctx, runId: 'land-cycle-from-run' }, t.live)).executed).toBe(true);
    expect((await executeLiveLand(t.card(), 52, { ...t.ctx, runId: 'land-cycle-from-run' }, t.live)).executed).toBe(false);
    expect(t.calls).toHaveLength(1);
  });

  test('explicit judgement cycle blocks a second PR', async () => {
    const t = landFixture();
    expect((await executeLiveLand(t.card(), 51, { ...t.ctx, cycleId: 'one-cycle-2026-10-08' }, t.live)).executed).toBe(true);
    expect((await executeLiveLand(t.card(), 52, { ...t.ctx, cycleId: 'one-cycle-2026-10-08' }, t.live)).executed).toBe(false);
    expect(t.calls).toHaveLength(1);
  });

  test('failed invocation records last 300 chars and is not retried for this PR/head', async () => {
    const t = landFixture();
    // TA-LAND-RETRY-ON-INFRA — 관문 줄(✓)이 있는 판정 실패(목록 밖)라야 «한 번 끝»이다 · 결과 줄 없는 죽음은 인프라(land-retry-on-infra.test.ts).
    t.live.land = async () => ({ status: 1, stdout: '✓ branch: feature', stderr: 'e'.repeat(350) });
    const out = await executeLiveLand(t.card(), 51, t.ctx, t.live);
    expect(out).toMatchObject({ ok: false, executed: true, detail: 'e'.repeat(300) });
    expect(t.card().landAttempts?.[0]).toMatchObject({ ok: false, detail: 'e'.repeat(300) });
    expect((await executeLiveLand(t.card(), 51, t.ctx, t.live)).executed).toBe(false);
  });

  test('judgement stays shadow without propose-land config; with it binds the right PR/card and reviewed SHA', async () => {
    const t = landFixture();
    const results = [job({ prNumber: 51, worktreePath: '/tmp/land-wt', harvestable: true })];
    const shadow = await recordTaskAgentShadowMove({ runId: 'land-shadow', stopReason: 'needs-human', results, selfReview: reviewed },
      { ...t.f.deps(), liveMoves: new Set(), live: t.live });
    expect(shadow).toMatchObject({ move: 'propose-land', executorResult: 'shadow' });
    expect(shadow.liveMove).toBeUndefined();
    expect(t.calls).toHaveLength(0);
    const landed = await recordTaskAgentShadowMove({ runId: 'land-live', stopReason: 'needs-human', results, selfReview: reviewed },
      { ...t.f.deps(), liveMoves: new Set<TaskAgentLiveMove>(['propose-land']), live: t.live });
    expect(landed.liveMove).toMatchObject({ kind: 'land', card: 'ta-live-1', executed: true });
    expect(t.calls).toEqual([{ pr: 51, head: HEAD_A, cwd: '/tmp/land-wt' }]);
  });

  test('child review verdict and checked head reach supervisor stop and live land without direct review injection', async () => {
    const { singleRunAsJobResult } = await import('../self-implement/self-implement-cli.js');
    const { superviseRun } = await import('../self-dev/run-supervisor.js');
    const { parseSelfImplementJson } = await import('../task-orchestrator/surfaces/self-implement.js');
    const t = landFixture();
    const base = { runId: 'ta-live-1', ok: true, stage: 'pr-opened', node: 'open-pr', outcome: { kind: 'completed' },
      prNumber: 51, worktreePath: '/tmp/land-wt', checkedHeadCommit: HEAD_A, reviewedHeadCommit: HEAD_A,
      review: { verdict: 'pass', reviewed: true, mustFix: [], shouldFix: [], summary: 'review passed' } };
    const result = singleRunAsJobResult('feature ask', base as unknown as Parameters<typeof singleRunAsJobResult>[1]);
    expect(result.selfReview).toEqual({ verdict: 'pass', head: HEAD_A, mustFixCount: 0 });
    await superviseRun({ initial: [{ ...result, harvestable: true, branch: 'feature' }],
      rerun: async () => { throw new Error('unexpected relaunch'); },
      sweepPendingMerges: async () => ({ pending: 0, merged: 0 }),
      taskAgentShadow: input => recordTaskAgentShadowMove(input,
        { ...t.f.deps(['propose-land']), live: t.live }) });
    expect(t.calls).toEqual([{ pr: 51, head: HEAD_A, cwd: '/tmp/land-wt' }]);
    expect(t.f.logs.find(entry => entry.event === 'live-move')?.data).toMatchObject({ kind: 'land', executed: true });
    expect(t.card().landAttempts).toHaveLength(1);
    const unreviewed = singleRunAsJobResult('feature ask', { ...base, review: { ...base.review, reviewed: false } } as unknown as Parameters<typeof singleRunAsJobResult>[1]);
    expect(unreviewed.selfReview).toBeUndefined();
    const noHead = singleRunAsJobResult('feature ask', { ...base, reviewedHeadCommit: undefined } as unknown as Parameters<typeof singleRunAsJobResult>[1]);
    expect(noHead.selfReview).toBeUndefined();
    expect(parseSelfImplementJson(JSON.stringify(base))?.selfReview).toEqual({ verdict: 'pass', head: HEAD_A, mustFixCount: 0 });
    expect(parseSelfImplementJson(JSON.stringify({ ...base, reviewedHeadCommit: undefined }))?.selfReview).toBeUndefined();
    const parsed = parseSelfImplementJson(JSON.stringify(base))!;
    const { orchestrateSelfDev } = await import('../self-dev/orchestrate.js');
    const jobs = await orchestrateSelfDev({ goals: [{ id: 'ta-live-1', feature: 'feature ask', openPr: true }],
      spawn: input => ({ address: input.spaceId, done: Promise.resolve({ exitCode: 0, output: '', disposition: { ...parsed, branch: 'feature', harvestable: true } }) }) });
    expect(jobs[0]?.selfReview).toEqual({ verdict: 'pass', head: HEAD_A, mustFixCount: 0 });
    const stale = singleRunAsJobResult('feature ask', { ...base, reviewedHeadCommit: HEAD_B } as unknown as Parameters<typeof singleRunAsJobResult>[1]);
    const staleMove = await recordTaskAgentShadowMove({ runId: 'stale-wired', stopReason: 'needs-human', results: [{ ...stale, taskId: 'ta-live-1' }], selfReview: stale.selfReview },
      { ...t.f.deps(['propose-land']), live: t.live });
    expect(staleMove.liveMove?.detail).toContain('review head mismatch');
    expect(t.calls).toHaveLength(1);
  });

  test('config recognizes propose-land, while absent config keeps no live moves', () => {
    const enabled = resolveTaskAgentLiveMoves(['propose-land'], {});
    expect([...enabled.moves]).toEqual(['propose-land']);
    expect(enabled.ignored).toEqual([]);
    expect(resolveTaskAgentLiveMoves(undefined, {}).moves.has('propose-land')).toBe(false);
  });

  test('a second reviewed SHA on the same PR is a new one-time attempt', async () => {
    const t = landFixture();
    expect((await executeLiveLand(t.card(), 51, t.ctx, t.live)).executed).toBe(true);
    t.setView({ head: HEAD_B, state: 'OPEN', isDraft: false });
    expect((await executeLiveLand(t.card(), 51, { ...t.ctx, review: { verdict: 'pass', head: HEAD_B, mustFixCount: 0 } as typeof t.ctx.review }, t.live)).executed).toBe(true);
    expect(t.calls.map(call => call.head)).toEqual([HEAD_A, HEAD_B]);
  });

  test('merge operation rechecks pinned head at the side-effect boundary', async () => {
    const { makePrManager } = await import('../autopilot/pr-manager.js');
    const calls: string[][] = [];
    let head = HEAD_A;
    const manager = makePrManager((command, args) => {
      calls.push([command, ...args]);
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') return { ok: true, out: JSON.stringify({ headRefOid: head, state: 'OPEN', isDraft: false }) };
      return { ok: true, out: '' };
    });
    head = HEAD_B;
    expect(manager.mergePrOutcome('https://github.com/owner/repo/pull/51', HEAD_A, '/tmp/land-wt')).toMatchObject({ ok: false, kind: 'state-read-failed' });
    expect(calls.some(args => args[0] === 'gh' && args[1] === 'pr' && args[2] === 'merge')).toBe(false);
  });

  test('post-merge branch lookup and failed-merge state probes use the pinned repository cwd', async () => {
    const { makePrManager } = await import('../autopilot/pr-manager.js');
    const calls: Array<{ args: readonly string[]; cwd?: string }> = [];
    const manager = makePrManager((command, args, opts) => {
      if (command !== 'gh') return { ok: false, out: '' };
      calls.push({ args, cwd: opts?.cwd });
      if (args.includes('headRefOid,state,isDraft')) return { ok: true, out: JSON.stringify({ headRefOid: HEAD_A, state: 'OPEN', isDraft: false }) };
      if (args.includes('headRefName,headRepository')) return { ok: true, out: JSON.stringify({ headRefName: 'feature', headRepository: { nameWithOwner: 'owner/repo' } }) };
      if (args.includes('state')) return { ok: true, out: JSON.stringify({ state: 'MERGED' }) };
      if (args.includes('merge')) return { ok: false, out: 'timeout' };
      return { ok: true, out: '' };
    });
    expect(manager.mergePrOutcome('https://github.com/owner/repo/pull/51', HEAD_A, '/tmp/land-wt').ok).toBe(true);
    expect(calls.filter(call => call.args[0] === 'pr' && call.args[1] === 'view').map(call => call.cwd)).toEqual(['/tmp/land-wt', '/tmp/land-wt', '/tmp/land-wt']);
    expect(calls.find(call => call.args[0] === 'api')?.cwd).toBe('/tmp/land-wt');
  });

  test('merge command uses GitHub match-head-commit when pinned', async () => {
    const { makePrManager } = await import('../autopilot/pr-manager.js');
    const commands: string[][] = [];
    const manager = makePrManager((command, args) => {
      commands.push([command, ...args]);
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') return { ok: true, out: JSON.stringify({ headRefOid: HEAD_A, state: 'OPEN', isDraft: false }) };
      return { ok: true, out: '' };
    });
    expect(manager.mergePrOutcome('https://github.com/owner/repo/pull/51', HEAD_A, '/tmp/land-wt').ok).toBe(true);
    expect(commands).toContainEqual(['gh', 'pr', 'merge', '51', '--squash', '--match-head-commit', HEAD_A]);
  });

  test('failed pinned merge is not retried against a changed head', async () => {
    const { makePrManager } = await import('../autopilot/pr-manager.js');
    let mergeCalls = 0;
    const manager = makePrManager((command, args) => {
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view' && args.includes('headRefOid,state,isDraft'))
        return { ok: true, out: JSON.stringify({ headRefOid: HEAD_A, state: 'OPEN', isDraft: false }) };
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'view') return { ok: true, out: JSON.stringify({ state: 'OPEN' }) };
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'merge') { mergeCalls++; return { ok: false, out: 'head changed' }; }
      return { ok: false, out: '' };
    });
    expect(manager.mergePrOutcome('https://github.com/owner/repo/pull/51', HEAD_A).ok).toBe(false);
    expect(mergeCalls).toBe(1);
  });

  test('missing self-review input remains shadow even when propose-land is configured', async () => {
    const t = landFixture();
    const result = await recordTaskAgentShadowMove({ runId: 'missing-review', stopReason: 'needs-human', results: [job({ prNumber: 51, worktreePath: '/tmp/land-wt' })] },
      { ...t.f.deps(), liveMoves: new Set<TaskAgentLiveMove>(['propose-land']), live: t.live });
    expect(result.move).toBe('review');
    expect(result.liveMove).toBeUndefined();
    expect(t.calls).toHaveLength(0);
  });

  test('pr land rejects invalid or unpaired head pins before any command', async () => {
    const { runPrLand } = await import('../cli/pr-cli.js');
    const seen: string[] = [];
    const deps = { run: () => { throw new Error('should not run git/gh'); }, out: { log: () => {}, error: (message: string) => { seen.push(message); } } };
    expect(await runPrLand({ pr: '51' }, deps)).toBe(1);
    expect(await runPrLand({ expectedHead: HEAD_A }, deps)).toBe(1);
    expect(await runPrLand({ pr: '51', expectedHead: HEAD_A, hold: true }, deps)).toBe(1);
    expect(seen).toHaveLength(3);
    expect(seen.every(message => message.includes('expected-head'))).toBe(true);
  });

  test('pinned CLI rejects a changed remote head before any landing side effect', async () => {
    const { runPrLand } = await import('../cli/pr-cli.js');
    const commands: Array<[string, readonly string[]]> = [];
    const run = (command: string, args: readonly string[]) => {
      commands.push([command, args]);
      if (command === 'gh') return { ok: true, out: JSON.stringify({ headRefOid: HEAD_B, headRefName: 'feature', state: 'OPEN', isDraft: false, url: 'https://github.com/owner/repo/pull/51' }) };
      return { ok: true, out: HEAD_A };
    };
    const errors: string[] = [];
    expect(await runPrLand({ pr: '51', expectedHead: HEAD_A, cwd: '/tmp/never' },
      { run, out: { log: () => {}, error: message => { errors.push(message); } } })).toBe(1);
    expect(errors[0]).toContain('expected-head');
    expect(commands.some(([command, args]) => command === 'gh' && args.includes('merge'))).toBe(false);
  });

  test('CLI argv pins PR and SHA without bypassing landing gates', () => {
    expect(liveLandArgs('/repo/bin/elanous.mjs', '/universe', 51, HEAD_A, '/repo')).toEqual([
      '/repo/bin/elanous.mjs', '--config-dir', '/universe', 'pr', 'land', '--cwd', '/repo', '--pr', '51', '--expected-head', HEAD_A,
    ]);
  });
});

test('ORCH-LIVE-1008: the default live review entry is the elanous CLI, not the script that started this process', async () => {
  const { ELANOUS_CLI_ENTRY } = await import('../cli/tasks-cli.js');
  const started = process.argv[1];
  const seen: string[][] = [];
  const fakeSpawn = ((command: string, args: string[]) => {
    seen.push([command, ...args]);
    const handlers: Record<string, () => void> = {};
    setTimeout(() => handlers.spawn?.(), 0);
    return { pid: 1, once: (event: string, fn: () => void) => { handlers[event] = fn; }, removeListener: () => undefined, unref: () => undefined };
  }) as unknown as import('../cli/tasks-cli.js').DetachedSpawn;
  try {
    process.argv[1] = '/somewhere/src/loops/orchestrator/tick.ts';
    await defaultRequestReview(7, 'intent', undefined, { spawn: fakeSpawn, configDir: '/universe' });
    expect(seen[0]?.[1]).toBe(ELANOUS_CLI_ENTRY);
  } finally { process.argv[1] = started; }
});

describe('TA-LIVE-REVIEW-POD — 작업 트리 없는 런(Pod)의 live review 는 «런이 낸 PR 머리»가 확인되는 저장소에서만', () => {
  const PR_URL = 'https://github.com/owner/repo/pull/24738';
  const BRANCH = 'self-impl/goalid-pod-r1';
  function podFixture(view: (cwd?: string) => PrHeadView | null, candidates: ReviewRepoCandidate[]) {
    const f = fixture();
    const { EventEmitter } = require('node:events') as typeof import('node:events');
    const spawned: Array<{ args: string[]; options: Record<string, unknown> }> = [];
    const fakeSpawn = ((_command: string, args: string[], options: Record<string, unknown>) => {
      spawned.push({ args, options });
      const child = Object.assign(new EventEmitter(), { pid: 4343, unref: () => {} });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    }) as never;
    const viewed: Array<string | undefined> = [];
    const deps = f.deps(['review']);
    const live = {
      ...deps.live,
      prHead: async (_pr: number, cwd?: string) => { viewed.push(cwd); return view(cwd); },
      requestReview: (pr: number, intent: string, cwd?: string) => defaultRequestReview(pr, intent, cwd, { spawn: fakeSpawn, entry: '/repo/bin/elanous.mjs', configDir: '/universe' }),
      repoCandidates: () => candidates,
    };
    return { f, spawned, viewed, deps: { ...deps, live } };
  }
  const liveMoveLog = (f: ReturnType<typeof fixture>) => f.logs.find((entry) => entry.event === 'live-move')!.data;

  test('Pod 런(작업 트리 없음) · 저장소 PR 머리 sha 가 런의 머리와 같다 → 리뷰를 그 저장소 cwd 에서 실제로 띄운다', async () => {
    const t = podFixture(() => ({ head: HEAD_A, state: 'OPEN', branch: BRANCH, url: PR_URL }), [{ source: 'harness.defaultRepo', cwd: '/tmp/repo-default' }]);
    const out = await run('needs-human', [job({ prNumber: 24738, checkedHeadCommit: HEAD_A, branch: BRANCH, prUrl: PR_URL })], t.deps);
    expect(out.liveMove).toMatchObject({ kind: 'review', executed: true, ok: true, reviewRepo: { resolved: true, source: 'harness.defaultRepo', cwd: '/tmp/repo-default', proof: 'head-sha' } });
    expect(t.spawned).toHaveLength(1);
    expect(t.spawned[0]!.args.slice(0, 6)).toEqual(['/repo/bin/elanous.mjs', '--config-dir', '/universe', 'self', 'review', '24738']);
    expect(t.spawned[0]!.options).toMatchObject({ cwd: '/tmp/repo-default', detached: true });
    expect(readTaskCard('ta-live-1', t.f.statePath)!.reviewRequests).toEqual([expect.objectContaining({ pr: 24738, head: HEAD_A })]);
    expect(t.f.logs.find((entry) => entry.event === 'shadow-move')!.data).toMatchObject({ live: true, liveExecuted: true, liveOk: true });
  });

  test('런이 sha 를 안 남겼으면 런의 브랜치로 확인한다 · 첫 후보가 어긋나면 다음 후보(카드 대상 → 기본 저장소)', async () => {
    const t = podFixture((cwd) => cwd === '/tmp/card-target'
      ? { head: HEAD_B, state: 'OPEN', branch: 'someone-else', url: PR_URL }
      : { head: HEAD_B, state: 'OPEN', branch: BRANCH, url: PR_URL },
    [{ source: 'card.project', cwd: '/tmp/card-target' }, { source: 'harness.defaultRepo', cwd: '/tmp/repo-default' }]);
    const out = await run('harvestable-awaiting-human', [job({ prNumber: 24738, harvestable: true, branch: BRANCH, prUrl: PR_URL })], t.deps);
    expect(out.liveMove).toMatchObject({ executed: true, reviewRepo: { resolved: true, source: 'harness.defaultRepo', proof: 'branch' } });
    expect(t.viewed).toEqual(['/tmp/card-target', '/tmp/repo-default']);
    expect(t.spawned.map((entry) => entry.options.cwd)).toEqual(['/tmp/repo-default']);
  });

  test('머리 불일치 · 브랜치 불일치 · 다른 저장소 URL · 읽기 실패 · 후보 없음 · 런 머리 없음 → 그림자 그대로 · 이유 한 줄 관측', async () => {
    const cases: Array<[string, (cwd?: string) => PrHeadView | null, ReviewRepoCandidate[], Partial<SupervisorJobResult>, string]> = [
      ['head mismatch', () => ({ head: HEAD_B, state: 'OPEN', branch: BRANCH, url: PR_URL }), [{ source: 'host', cwd: '/tmp/h' }], { checkedHeadCommit: HEAD_A, branch: BRANCH }, `host: head ${HEAD_B.slice(0, 12)} ≠ run ${HEAD_A.slice(0, 12)}`],
      ['branch mismatch', () => ({ head: HEAD_B, state: 'OPEN', branch: 'other', url: PR_URL }), [{ source: 'host', cwd: '/tmp/h' }], { branch: BRANCH, prUrl: PR_URL }, `host: branch other ≠ run ${BRANCH}`],
      ['other repository', () => ({ head: HEAD_A, state: 'OPEN', branch: BRANCH, url: 'https://github.com/else/where/pull/24738' }), [{ source: 'host', cwd: '/tmp/h' }], { checkedHeadCommit: HEAD_A, prUrl: PR_URL }, 'host: PR url https://github.com/else/where/pull/24738 ≠ run'],
      ['unreadable', () => null, [{ source: 'card.project', cwd: '/tmp/c' }], { checkedHeadCommit: HEAD_A }, 'card.project: PR #24738 unreadable'],
      ['no candidates', () => ({ head: HEAD_A, state: 'OPEN' }), [], { checkedHeadCommit: HEAD_A }, 'no target repository'],
      ['no produced head', () => ({ head: HEAD_A, state: 'OPEN' }), [{ source: 'host', cwd: '/tmp/h' }], {}, 'run result carries no PR head or branch'],
      ['branch only, run url missing', () => ({ head: HEAD_B, state: 'OPEN', branch: BRANCH, url: PR_URL }), [{ source: 'host', cwd: '/tmp/h' }], { branch: BRANCH }, 'branch matches but PR url unconfirmed (run none'],
      ['branch only, repo url missing', () => ({ head: HEAD_B, state: 'OPEN', branch: BRANCH }), [{ source: 'host', cwd: '/tmp/h' }], { branch: BRANCH, prUrl: PR_URL }, 'repo none)'],
      ['empty recorded head (no branch fallback)', () => ({ head: HEAD_A, state: 'OPEN', branch: BRANCH, url: PR_URL }), [{ source: 'host', cwd: '/tmp/h' }], { checkedHeadCommit: '', branch: BRANCH, prUrl: PR_URL }, 'is not a full commit sha'],
      ['malformed recorded head (no branch fallback)', () => ({ head: HEAD_A, state: 'OPEN', branch: BRANCH, url: PR_URL }), [{ source: 'host', cwd: '/tmp/h' }], { checkedHeadCommit: 'abc123', branch: BRANCH }, 'is not a full commit sha'],
    ];
    for (const [name, view, candidates, over, reason] of cases) {
      const t = podFixture(view, candidates);
      const out = await run('needs-human', [job({ prNumber: 24738, ...over })], t.deps);
      expect({ name, liveMove: out.liveMove }).toMatchObject({ name, liveMove: { executed: false, ok: false, detail: 'PR #24738 worktree unknown — stays shadow', reviewRepo: { resolved: false } } });
      expect(out.liveMove!.reviewRepo!.reason).toContain(reason);
      expect(liveMoveLog(t.f)).toMatchObject({ executed: false, reviewRepo: { resolved: false, reason: expect.stringContaining(reason) } });
      expect(t.spawned).toHaveLength(0);
      expect(readTaskCard('ta-live-1', t.f.statePath)!.reviewRequests).toBeUndefined();
    }
  });

  test('기본 후보 배선 — 후보를 주입하지 않으면 실제 호스트 checkout 뿌리에서 PR 을 확인하고 그 cwd 로 띄운다', async () => {
    const { findGitDir } = await import('../git-fs/locate.js');
    const hostRoot = findGitDir(process.cwd())!.root;
    const t = podFixture((cwd) => cwd === hostRoot ? { head: HEAD_A, state: 'OPEN', branch: BRANCH, url: PR_URL } : null, []);
    const { repoCandidates: _drop, ...live } = t.deps.live;
    const out = await run('needs-human', [job({ prNumber: 24738, checkedHeadCommit: HEAD_A, prUrl: PR_URL })], { ...t.deps, live });
    expect(t.viewed).toContain(hostRoot);
    expect(out.liveMove).toMatchObject({ executed: true, reviewRepo: { resolved: true, cwd: hostRoot } });
    expect(t.spawned.map((entry) => entry.options.cwd)).toEqual([hostRoot]);
  });

  test('호출자가 런 근거(produced)를 안 넘기면 «미제공»으로 적고 그림자 — PR 을 조회하지 않는다', async () => {
    const t = podFixture(() => ({ head: HEAD_A, state: 'OPEN', branch: BRANCH, url: PR_URL }), [{ source: 'host', cwd: '/tmp/h' }]);
    const card = readTaskCard('ta-live-1', t.f.statePath)!;
    const out = await executeLiveReview(card, 24738, { runId: 'run-x', stopReason: 'needs-human' }, { ...t.deps.live, log: t.deps.log });
    expect(out).toMatchObject({ executed: false, ok: false, detail: 'PR #24738 worktree unknown — stays shadow', reviewRepo: { resolved: false, reason: 'caller passed no run evidence (produced) — head/branch not checked' } });
    expect(liveMoveLog(t.f)).toMatchObject({ reviewRepo: { reason: expect.stringContaining('caller passed no run evidence') } });
    expect(t.viewed).toEqual([]);
    expect(t.spawned).toHaveLength(0);
  });

  test('작업 트리가 있으면 종전 그대로 — 후보 저장소를 보지 않는다', async () => {
    const t = podFixture(() => ({ head: HEAD_A, state: 'OPEN' }), [{ source: 'host', cwd: '/tmp/never' }]);
    const out = await run('needs-human', [job({ prNumber: 30, worktreePath: '/tmp/wt-30', branch: BRANCH })], t.deps);
    expect(out.liveMove).toMatchObject({ executed: true });
    expect(out.liveMove!.reviewRepo).toBeUndefined();
    expect(t.viewed).toEqual(['/tmp/wt-30']);
  });

  test('기본 후보 — 카드 대상 → harness.defaultRepo → 호스트 checkout · 없는 디렉터리·중복·상대 경로는 뺀다', () => {
    const a = mkdtempSync(join(tmpdir(), 'ta-pod-a-'));
    const b = mkdtempSync(join(tmpdir(), 'ta-pod-b-'));
    const card: TaskCard = { id: 'c', text: 't', createdAt: '', status: 'launched', history: [], project: { target: a } };
    expect(defaultReviewRepoCandidates(card, { defaultRepo: () => b, hostRoot: () => a })).toEqual([
      { source: 'card.project', cwd: a }, { source: 'harness.defaultRepo', cwd: b },
    ]);
    expect(defaultReviewRepoCandidates({ ...card, project: { target: join(a, 'missing') } }, { defaultRepo: () => 'relative/path', hostRoot: () => b })).toEqual([
      { source: 'host', cwd: b },
    ]);
    expect(defaultReviewRepoCandidates({ ...card, project: { target: 'relative/target' } }, { defaultRepo: () => `${b}/./`, hostRoot: () => undefined })).toEqual([
      { source: 'harness.defaultRepo', cwd: b },
    ]);
  });

  test('PR 머리 조회는 브랜치·URL 도 싣는다', async () => {
    const gh = () => ({ status: 0, stdout: JSON.stringify({ headRefOid: HEAD_A, headRefName: BRANCH, state: 'OPEN', url: PR_URL }) });
    expect(await defaultPrHead(24738, '/tmp/x', gh)).toEqual({ head: HEAD_A, state: 'OPEN', branch: BRANCH, url: PR_URL });
  });
});

describe('TA-LIVE-DECISION — 막힌 과제를 근거 붙은 결정 카드로', () => {
  const ctx = (evidence: LiveDecisionCardContext['evidence'], over: Partial<LiveDecisionCardContext> = {}): LiveDecisionCardContext =>
    ({ runId: 'run-live', stopReason: 'no-progress', reason: 'blocked twice on the same screen', pr: 9, evidence, ...over });
  const harness = () => {
    const f = fixture();
    const raised: string[][] = [];
    let status = 0;
    const deps = { statePath: f.statePath, log: () => {}, raiseDecision: async (args: string[]) => { raised.push(args); return { status, stdout: '', stderr: status ? 'ledger locked' : '' }; } };
    return { f, raised, deps, fail: () => { status = 1; }, heal: () => { status = 0; }, card: () => readTaskCard('ta-live-1', f.statePath)! };
  };
  const refOf = (args: string[]) => JSON.parse(args[args.indexOf('--ref') + 1]!) as Record<string, unknown>;

  test('근거 없는 카드 0 — 서명·화면·must-fix 가 모두 비면 올리지 않고 카드 기록도 안 남긴다', async () => {
    const t = harness();
    for (const evidence of [{}, { signature: '   ' }, { screen: '' }, { mustFix: [] }, { mustFix: ['  ', ''] }, { signature: ' ', screen: ' ', mustFix: [' '] }]) {
      const out = await executeLiveDecisionCard(t.card(), ctx(evidence), t.deps);
      expect(out).toMatchObject({ kind: 'decision-card', ok: false, executed: false, detail: 'no evidence (signature · screen · must-fix) — no card raised' });
    }
    expect(t.raised).toHaveLength(0);
    expect(t.card().history).toEqual([]);
  });

  test('근거 하나만 있어도 올린다 — 카드 --ref 에 그 근거와 근거 칸 이름이 실린다', async () => {
    const t = harness();
    const out = await executeLiveDecisionCard(t.card(), ctx({ signature: 'sig-abc' }), t.deps);
    expect(out).toMatchObject({ kind: 'decision-card', ok: true, executed: true, card: 'ta-live-1' });
    expect(t.raised).toHaveLength(1);
    const args = t.raised[0]!;
    expect(args.slice(0, 2)).toEqual(['decisions', 'raise']);
    expect(args[args.indexOf('--title') + 1]).toBe('ta-live-1: blocked twice on the same screen');
    expect(args[args.indexOf('--category') + 1]).toBe('other');
    expect(refOf(args)).toMatchObject({ card: 'ta-live-1', runId: 'run-live', pr: 9, grounds: ['signature'], signature: 'sig-abc', mustFix: [], selected: 'decision-card' });
    expect(refOf(args)).not.toHaveProperty('screen');
    const rows = t.card().history.filter((entry) => entry.event === 'live-move' && entry.kind === 'decision-card');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ executed: true, ok: true, executorResult: 'live', runId: 'run-live', pr: 9 });
    expect(rows[0]!.detail).toContain('decision card raised (signature)');
  });

  test('서명·화면·must-fix 셋이 다 실린다 — 화면은 꼬리만 · 서명은 머리만 자른다', async () => {
    const t = harness();
    const screen = `${'x'.repeat(2000)}TAIL`;
    await executeLiveDecisionCard(t.card(), ctx({ signature: `S${'s'.repeat(400)}`, screen, mustFix: [' fix one ', '', 'fix two'] }), t.deps);
    const ref = refOf(t.raised[0]!);
    expect(ref.grounds).toEqual(['signature', 'screen', 'must-fix']);
    expect(ref.mustFix).toEqual(['fix one', 'fix two']);
    expect((ref.signature as string).length).toBe(300);
    expect((ref.screen as string).length).toBe(1500);
    expect((ref.screen as string).endsWith('TAIL')).toBe(true);
  });

  test('같은 근거 둘째 틱 0 · 근거가 바뀌면 새 카드', async () => {
    const t = harness();
    await executeLiveDecisionCard(t.card(), ctx({ mustFix: ['a'] }), t.deps);
    const again = await executeLiveDecisionCard(t.card(), ctx({ mustFix: ['a'] }), t.deps);
    expect(again).toMatchObject({ ok: true, executed: false });
    expect(again.detail).toMatch(/^already raised for fp:[0-9a-f]{12}$/);
    expect(t.raised).toHaveLength(1);
    await executeLiveDecisionCard(t.card(), ctx({ mustFix: ['b'] }), t.deps);
    expect(t.raised).toHaveLength(2);
    expect(t.card().history.filter((entry) => entry.kind === 'decision-card')).toHaveLength(2);
  });

  test('올리기 실패 → 카드 기록을 걷어 다음 틱이 다시 시도한다', async () => {
    const t = harness();
    t.fail();
    const failed = await executeLiveDecisionCard(t.card(), ctx({ screen: 'stuck' }), t.deps);
    expect(failed).toMatchObject({ ok: false, executed: false });
    expect(failed.detail).toBe('decisions raise failed: ledger locked');
    expect(t.card().history).toEqual([]);
    t.heal();
    const retried = await executeLiveDecisionCard(t.card(), ctx({ screen: 'stuck' }), t.deps);
    expect(retried).toMatchObject({ ok: true, executed: true });
    expect(t.raised).toHaveLength(2);
  });

  test('위험 표지는 종전 실행부와 같은 범주로 간다(돈 → money) · 카드·원장 없음은 올리지 않는다', async () => {
    const t = harness();
    await executeLiveDecisionCard(t.card(), ctx({ signature: 's' }, { risk: 'money' }), t.deps);
    expect(t.raised[0]![t.raised[0]!.indexOf('--category') + 1]).toBe('money');
    expect(await executeLiveDecisionCard(undefined, ctx({ signature: 's' }), t.deps)).toMatchObject({ ok: false, executed: false, card: null });
    const ghost = { ...t.card(), id: 'ta-ghost' };
    expect(await executeLiveDecisionCard(ghost, ctx({ signature: 's' }), t.deps)).toMatchObject({ ok: false, executed: false, detail: 'task card not in state file' });
    expect(t.raised).toHaveLength(1);
  });

describe('TA-PROPOSE-CLOSE-MOVE — draft 정리: 근거가 모두 참일 때만 닫기 명령', () => {
  const draft = (over: Partial<DraftCloseView>): DraftCloseView => ({ pr: 61, readable: true, isDraft: true, ...over });
  /** 가짜 gh 우주 — closeDraft 주입으로 닫기만 기록한다(propose 모드는 기록 0). */
  function closeFixture() {
    const f = fixture();
    const closed: Array<{ command: string; args: string[] }> = [];
    const deps = {
      statePath: f.statePath,
      log: () => {},
      closeDraft: async (pr: number, comment: string) => { closed.push({ command: 'gh', args: liveCloseArgs(pr, comment) }); },
    };
    return { f, closed, deps, card: () => readTaskCard('ta-live-1', f.statePath)! };
  }
  /** draft 넷 — close-a 참 · close-b 참 · 보호 라벨 · 주인 미상(48h+ 지만 확인 없음). */
  const drafts = (): readonly DraftCloseView[] => [
    draft({ pr: 61, landedElsewhere: true }),
    draft({ pr: 62, newerDraftInSameCell: true }),
    draft({ pr: 63, labels: [...CLOSE_PROTECTED_LABELS].slice(0, 1) }),
    draft({ pr: 64, idleHours: CLOSE_IDLE_HOURS + 24 }),
  ];

  test("어휘 — 'propose-close' 는 설정·env 허용 항목이다", () => {
    expect(TASK_AGENT_LIVE_MOVES).toContain('propose-close');
    expect([...resolveTaskAgentLiveMoves(['propose-close'], {}, () => {}).moves]).toEqual(['propose-close']);
  });

  test('propose 모드 1회 → 닫기 둘(원문)·보류 둘 · 가짜 gh 기록 0 · 카드 기록 0', async () => {
    const t = closeFixture();
    const out = await executeLiveCloseProposal(t.card(), drafts(), { ...t.deps, mode: 'propose' });
    expect(out).toMatchObject({ kind: 'propose-close', card: 'ta-live-1', ok: true, executed: false });
    expect(out.proposals.filter((p) => p.close).map((p) => p.pr)).toEqual([61, 62]);
    expect(out.proposals.filter((p) => !p.close).map((p) => p.heldBy)).toEqual(['protected-label', 'no-grounds']);
    // 닫기 명령 원문 — gh pr close <pr> --comment <근거 코멘트>.
    const closeA = out.proposals.find((p) => p.pr === 61)!;
    const closeB = out.proposals.find((p) => p.pr === 62)!;
    expect(closeA.command).toBe(`gh pr close 61 --comment ${shellQuote(closeA.comment)}`);
    expect(closeA.comment).toContain('close-a(착지/대체)=true');
    expect(closeA.comment).toContain('close-b(같은 칸 새 draft)=false');
    expect(closeA.comment).toContain('close-c(48h+ 무커밋=false, 주인 확인=false)');
    expect(closeB.comment).toContain('close-b(같은 칸 새 draft)=true');
    // 근거 코멘트에 조건별 참/거짓 — 주인 미상(64)은 48h+ 만 참.
    const held = out.proposals.find((p) => p.pr === 64)!;
    expect(held.comment).toContain('close-c(48h+ 무커밋=true, 주인 확인=false)');
    expect(t.closed).toHaveLength(0);
    expect(t.card().history).toEqual([]);
  });

  test('live 모드 1회 → 가짜 gh 에 close 둘만 기록 · 보류 둘은 기록 없음 · 카드 history 두 줄', async () => {
    const t = closeFixture();
    const out = await executeLiveCloseProposal(t.card(), drafts(), { ...t.deps, mode: 'live' });
    expect(out).toMatchObject({ kind: 'propose-close', card: 'ta-live-1', ok: true, executed: true });
    expect(t.closed.map((entry) => entry.args[2])).toEqual(['61', '62']);
    expect(t.closed.every((entry) => entry.args[0] === 'pr' && entry.args[1] === 'close' && entry.args[3] === '--comment')).toBe(true);
    const rows = t.card().history.filter((entry) => entry.event === 'live-move' && entry.kind === 'propose-close');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.pr)).toEqual([61, 62]);
    expect(rows.every((row) => row.executed === true && row.ok === true && row.executorResult === 'live')).toBe(true);
    expect([{ ...rows[0]!, executed: false }, ...rows.slice(1)]
      .every((row) => row.executed === true && row.ok === true && row.executorResult === 'live')).toBe(false);
  });

  test('보호 라벨·running·못 읽음·draft 아님은 근거가 참이어도 닫지 않는다(live 모드)', async () => {
    const t = closeFixture();
    const out = await executeLiveCloseProposal(t.card(), [
      draft({ pr: 71, labels: ['do-not-close'], landedElsewhere: true }),
      draft({ pr: 72, running: true, landedElsewhere: true }),
      draft({ pr: 73, readable: false, landedElsewhere: true }),
      draft({ pr: 74, isDraft: false, landedElsewhere: true }),
    ], { ...t.deps, mode: 'live' });
    expect(out.proposals.map((p) => [p.pr, p.close, p.heldBy])).toEqual([
      [71, false, 'protected-label'],
      [72, false, 'running'],
      [73, false, 'unreadable'],
      [74, false, 'not-a-draft'],
    ]);
    expect(out).toMatchObject({ ok: true, executed: false });
    expect(t.closed).toHaveLength(0);
    expect(t.card().history).toEqual([]);
  });

  test('close-c 는 48h+ 무커밋 ⊕ 주인 확인이 모두 참일 때만 닫는다', async () => {
    const t = closeFixture();
    const out = await executeLiveCloseProposal(t.card(), [
      draft({ pr: 81, idleHours: CLOSE_IDLE_HOURS - 1, ownerConfirmed: true }),
      draft({ pr: 82, idleHours: CLOSE_IDLE_HOURS + 1 }),
      draft({ pr: 83, idleHours: CLOSE_IDLE_HOURS + 1, ownerConfirmed: true }),
    ], { ...t.deps, mode: 'live' });
    expect(out.proposals.map((p) => [p.pr, p.close, p.grounds.idle48h, p.grounds.ownerConfirmed])).toEqual([
      [81, false, false, true],
      [82, false, true, false],
      [83, true, true, true],
    ]);
    expect(out.proposals.find((p) => p.pr === 81)!.heldBy).toBe('no-grounds');
    expect(t.closed.map((entry) => entry.args[2])).toEqual(['83']);
  });

  test('evaluateDraftClose — 닫기 판단은 순수함수 · 48h 경계는 포함', () => {
    expect(evaluateDraftClose(draft({ idleHours: CLOSE_IDLE_HOURS, ownerConfirmed: true })).close).toBe(true);
    expect(evaluateDraftClose(draft({})).heldBy).toBe('no-grounds');
    expect(CLOSE_PROTECTED_LABELS).toContain('protected');
  });

  test('카드 없음 → 그림자 · 판단은 하되 가짜 gh 기록 0', async () => {
    const t = closeFixture();
    const out = await executeLiveCloseProposal(undefined, drafts(), { ...t.deps, mode: 'live' });
    expect(out).toMatchObject({ kind: 'propose-close', ok: false, executed: false, card: null });
    expect(out.proposals.map((p) => p.close)).toEqual([true, true, false, false]);
    expect(t.closed).toHaveLength(0);
  });

  test('live 닫기 실패 → ok false · 사유에 PR · 성공 줄은 그대로', async () => {
    const t = closeFixture();
    const deps = { ...t.deps, closeDraft: async (pr: number, comment: string) => {
      if (pr === 62) throw new Error('gh pr close 403');
      t.closed.push({ command: 'gh', args: liveCloseArgs(pr, comment) });
    } };
    const out = await executeLiveCloseProposal(t.card(), drafts(), { ...deps, mode: 'live' });
    expect(out).toMatchObject({ ok: false, executed: true });
    expect(out.detail).toContain('#62');
    expect(out.detail).toContain('403');
    expect(t.closed.map((entry) => entry.args[2])).toEqual(['61']);
    const rows = t.card().history.filter((entry) => entry.kind === 'propose-close');
    expect(rows.map((row) => row.pr)).toEqual([61, 62]);
    expect(rows.find((row) => row.pr === 61)!.ok).toBe(true);
    expect(rows.find((row) => row.pr === 62)!.ok).toBe(false);
  });
});

test('보존 — 종전 실행부의 decision 카드 인자와 --ref 만 빼고 같다', async () => {
    const t = harness();
    const sent: string[][] = [];
    await executeNextAction({ kind: 'decision', taskId: 'ta-live-1', rationale: 'blocked twice on the same screen', pr: 9, runId: 'run-live', original: 'x', checklistId: '' },
      { mode: 'live', command: async (args) => { sent.push(args); return { status: 0, stdout: '' }; }, observe: () => {} });
    await executeLiveDecisionCard(t.card(), ctx({ signature: 'sig' }), t.deps);
    const strip = (args: string[]) => args.map((arg, at) => args[at - 1] === '--ref' ? '<ref>' : arg);
    expect(strip(t.raised[0]!)).toEqual(strip(sent[0]!));
    expect(sent[0]).toEqual(decisionRaiseArgs({ taskId: 'ta-live-1', reason: 'blocked twice on the same screen', evidence: sent[0]![sent[0]!.indexOf('--ref') + 1]! }));
  });
});

describe('TA-REVIEW-PASS — 카드 없는 runId 의 단일 카드 멱등 결속(생산 진입점)', () => {
  test('TA-REVIEW-PASS: 카드 없는 runId 의 리뷰 판단 시, 고유한 런 소유(동일 runId 재판정)를 먼저 검증한 뒤 단일 잠금/멱등 쓰기로 새 카드를 생성한다', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'ta-review-pass-')), 'task-agent-actions.json');
    const logs: Array<{ event: string; data: Record<string, unknown> }> = [];
    const deps = { statePath, env: {}, log: (_c: string, event: string, data: Record<string, unknown>) => { logs.push({ event, data }); }, prFiles: async () => ['src/x.ts'] } as const;
    const input = { runId: 'run-review-create', stopReason: 'needs-human' as const,
      results: [job({ taskId: 'unknown-task', feature: 'review feature ask', ok: true, worktreePath: '/tmp/wt-review', prNumber: 26801 })] };
    const first = await recordTaskAgentShadowMove(input, deps);
    expect(first.move).toBe('review');
    const state = () => JSON.parse(readFileSync(statePath, 'utf8')) as { tasks: Record<string, TaskCard> };
    const firstIds = Object.keys(state().tasks);
    expect(firstIds).toHaveLength(1);
    const cardId = firstIds[0]!;
    expect(state().tasks[cardId]!.runId).toBe('run-review-create');
    expect(state().tasks[cardId]!.status).toBe('launched');
    // 같은 판정을 두 번째로 넣는다 — 카드는 1건으로 재사용되고 중복 생성이 없다.
    const second = await recordTaskAgentShadowMove(input, deps);
    expect(second.move).toBe('review');
    expect(Object.keys(state().tasks)).toEqual([cardId]);
    expect(state().tasks[cardId]!.runId).toBe('run-review-create');
    expect(logs.filter((entry) => entry.event === 'card-create-for-run-deferred')).toHaveLength(0);
  });
});
