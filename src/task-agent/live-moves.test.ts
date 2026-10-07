import { describe, expect, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SupervisorJobResult, SupervisorStopReason } from '../self-dev/run-supervisor.js';
import { getUserConfig, reloadUserConfig, userConfigPath } from '../user-config.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { defaultPrHead, defaultRequestReview, liveReviewArgs, resolveTaskAgentLiveMoves, TASK_AGENT_LIVE_MOVES_ENV, type TaskAgentLiveMove } from './live-moves.js';
import { recordTaskAgentShadowMove } from './shadow.js';
import { readTaskCard, writeTaskCards, type TaskCard } from './task-hand.js';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
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
    expect(f.logs.every((entry) => entry.event === 'shadow-move' && entry.data.live === false && entry.data.liveExecuted === false)).toBe(true);
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
    expect(f.logs.map((entry) => [entry.event, entry.data.live, entry.data.liveExecuted])).toEqual([['shadow-move', false, false], ['shadow-move', false, false]]);
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
    const out = resolveTaskAgentLiveMoves(['review', 'relaunch', 'decision-card', 3], {}, (_c, event, data) => { warned.push({ event, ...data }); });
    expect([...out.moves]).toEqual(['review']);
    expect(out.ignored).toEqual(['relaunch', 'decision-card', '3']);
    expect(warned).toEqual([expect.objectContaining({ event: 'live-moves-ignored', ignored: ['relaunch', 'decision-card', '3'], source: 'config' })]);
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
    expect(spawned[0]!.options).toMatchObject({ detached: true, stdio: 'ignore', cwd: '/tmp/wt-live' });
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
    expect(written.argv).toEqual(['--config-dir', join(dir, 'universe'), 'self', 'review', '13', '--json', '--intent', 'intent text']);
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
        { args: ['pr', 'view', '5', '--json', 'headRefOid,state'], proxy: 'http://proxy.invalid:1', cwd: '/tmp/wt-5' },
        { args: ['pr', 'view', '5', '--json', 'headRefOid,state'], proxy: undefined, cwd: '/tmp/wt-5' },
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

  test('기본 리뷰 요청 argv — 진입점 · 같은 우주 config-dir · self review <PR> --json --intent', () => {
    expect(liveReviewArgs('/repo/bin/elanous.mjs', '/universe', 9, 'intent')).toEqual(['/repo/bin/elanous.mjs', '--config-dir', '/universe', 'self', 'review', '9', '--json', '--intent', 'intent']);
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
