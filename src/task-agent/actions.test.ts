import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAutopilotCommands } from '../cli/autopilot-cli.js';
import * as actions from './actions.js';
import { buildEntranceRefusalDenominator, executeEntranceTick, executeNextAction, failureKey, readDeliveryEvidence, type ActionDeps, type GreenSweepProbe, type NextAction } from './actions.js';
import { readTaskCard, writeTaskCards, type TaskCard } from './task-hand.js';
import type { ChecklistItem } from '../release-loop/checklist.js';
import { judgeNextMove, LIVE_RETRY_MOVES, retryMoveOf, SAME_MOVE_FAILURE_LIMIT } from './judge.js';
import { executeLiveReview, resolveTaskAgentLiveMoves } from './live-moves.js';
import { recordTaskAgentShadowMove } from './shadow.js';
import { rejudgeCandidates, rejudgeCardOnHead } from './rejudge-on-head.js';
import type { SupervisorJobResult } from '../self-dev/run-supervisor.js';

test('entrance refusal denominator counts prototype-like reasons as ordinary keys', () => {
  const result = buildEntranceRefusalDenominator([
    { taskId: 'ta-1', kind: 'review', refusal: 'constructor' },
    { taskId: 'ta-2', kind: 'review', refusal: '__proto__' },
    { taskId: 'ta-3', kind: 'review', refusal: '__proto__' },
  ]);
  expect(result).toEqual({ reviewed: 3, allowed: 0, refused: 3, reasons: { constructor: 1, ['__proto__']: 2 } });
  expect(Object.prototype.hasOwnProperty.call(result.reasons, '__proto__')).toBe(true);
});

test('entrance denominator uses a dedicated event while actions keep the legacy event', async () => {
  const action: NextAction = { kind: 'review', taskId: 'ta-1', rationale: 'ready', pr: 7, runId: 'run-1', original: 'ask', checklistId: 'TA' };
  const observations: Array<{ event: string; data: { kind: string; reviewed?: number; refused?: number } }> = [];
  const deps: ActionDeps = { mode: 'shadow', command: async () => { throw new Error('shadow must not launch'); },
    observe: (event, data) => { observations.push({ event, data }); } };
  await expect(executeEntranceTick([
    { action },
    { action: { ...action, taskId: 'ta-2' }, refusal: 'constructor' },
  ], deps)).resolves.toEqual(['shadow']);
  expect(observations).toEqual([
    { event: 'task-agent.action', data: expect.objectContaining({ taskId: 'ta-1', kind: 'review' }) },
    { event: 'task-agent.entrance-denominator', data: expect.objectContaining({ kind: 'entrance-tick', reviewed: 2, refused: 1 }) },
  ]);
});

test('deliver live copies and checks evidence then proposes green without PR; shadow copies nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'action-deliver-'));
  const worktreePath = join(root, 'worktree');
  const projectTarget = join(root, 'project');
  mkdirSync(worktreePath);
  writeFileSync(join(worktreePath, 'report.md'), '# 조사\n출처 https://one.example/a https://two.example/b\n## 반대 근거\n반론');
  const delivery = { kind: 'research-report' as const, worktreePath, projectTarget, files: ['report.md'] };
  const action: NextAction = { kind: 'deliver', taskId: 'ta-1', rationale: 'deliver', pr: 0, runId: 'run-1', original: 'ask', checklistId: '', delivery };
  const events: Array<{ result: string; reason: string }> = [];
  const deps: ActionDeps = { mode: 'shadow', observe: (_event, data) => { events.push(data); }, command: async () => { throw new Error('must not run'); } };
  expect(await executeNextAction(action, deps)).toBe('shadow');
  const output = join(projectTarget, 'elanous-out', 'ta-1', 'report.md');
  expect(existsSync(output)).toBe(false);
  expect(events[0]!.reason).toContain(join(projectTarget, 'elanous-out', 'ta-1'));
  deps.mode = 'live';
  expect(await executeNextAction(action, deps)).toBe('done');
  expect(existsSync(output)).toBe(true);
  expect(readFileSync(output, 'utf8')).toContain('반대 근거');
  expect(events.at(-1)!.reason).toContain('propose-green');
  writeFileSync(join(worktreePath, 'report.md'), '출처 1개');
  expect(readDeliveryEvidence('research-report', worktreePath, [join(worktreePath, 'report.md')])).toMatchObject({ ok: false, reason: expect.stringContaining('출처') });
  expect(await executeNextAction(action, deps)).toBe('waiting');
  expect(events.at(-1)!.reason).toContain('wait:');
});

const INPUT = 'a'.repeat(40);
const LANDED = 'b'.repeat(40);
const action: NextAction = { kind: 'review', taskId: 'TASK', rationale: 'ready', pr: 42, runId: 'run-1', original: 'verbatim ask', checklistId: 'TASK-AGENT', cwd: '/isolated/worktree' };
function fake(review = { verdict: 'pass', mustFix: [] as string[], reviewed: true }, labels: string[] = []) {
  const calls: string[][] = [];
  const events: unknown[] = [];
  const deps: ActionDeps = {
    mode: 'live',
    observe: (_event, data) => { events.push(data); },
    command: async args => {
      calls.push(args);
      return { status: 0, stdout: args[0] === 'self' ? JSON.stringify(review) : args[0] === 'gh' ? JSON.stringify(args.includes('labels') ? { labels: labels.map(name => ({ name })) } : { state: 'MERGED', mergeCommit: { oid: LANDED } }) : '' };
    },
  };
  return { calls, events, deps };
}
test('registered autopilot action entry invokes executor in default shadow mode', async () => {
  // 격리된 설정 폴더 — 사용자 설정(taskAgent.mode=live)이 이 시험을 실물 실행으로 바꾸지 않게.
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { setElanousConfigDir, resetElanousConfigDir } = await import('../elanous-config-dir.js');
  const isolated = mkdtempSync(join(tmpdir(), 'task-agent-cli-'));
  setElanousConfigDir(isolated);
  process.env.ELANOUS_STATE_DIR = isolated;
  const program = new Command();
  const surfaces: string[] = [];
  registerAutopilotCommands(program, { registerSink: async (surface) => { surfaces.push(surface); return true; } });
  const output: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((text: string) => { output.push(text); return true; }) as typeof process.stdout.write;
  try {
    await program.parseAsync(['autopilot', 'task-agent-action', JSON.stringify(action)], { from: 'user' });
    expect(output).toContain('shadow\n');
    // 독립 프로세스 관측 — task-agent 싱크를 실행 전에 등록한다(실 logs.db 대신 주입).
    expect(surfaces).toEqual(['task-agent']);
  } finally { process.stdout.write = original; resetElanousConfigDir(); delete process.env.ELANOUS_STATE_DIR; }
});
test('TA-REVIEW-SKIP-HARVEST: absent or mismatched signal preserves review', async () => {
  for (const harvestState of [
    undefined,
    { pr: 43, source: 'owner-worktree-commit' as const, head: INPUT },
    { pr: 42, source: 'owner-worktree-commit' as const, head: 'not-a-commit' },
  ]) {
    const unproven = fake();
    expect(await executeNextAction({ ...action, harvestState }, unproven.deps)).toBe('done');
    expect(unproven.calls[0]?.slice(0, 2)).toEqual(['self', 'review']);
    expect(unproven.events.some(e => (e as { result: string }).result === 'skipped')).toBe(false);
  }
});

test('TA-REVIEW-SKIP-HARVEST: producer signal reaches review consumer and card history', async () => {
  expect(typeof actions.ownerWorktreeHarvestState).toBe('function');
  const cwd = mkdtempSync(join(tmpdir(), 'ta-harvest-owner-'));
  const prHead = 'c'.repeat(40);
  const gitCalls: string[][] = [];
  const git = (path: string, args: string[]) => (gitCalls.push(args), { status: 0,
    stdout: args[0] === 'branch' ? 'harvest/one\n' : args[0] === 'rev-parse' ? INPUT + '\n'
      : args[0] === 'worktree' ? `worktree ${path}\nHEAD ${INPUT}\nbranch refs/heads/harvest/one\n` : '' });
  const f = fake();
  const signal = actions.ownerWorktreeHarvestState({ pr: 42, cwd, head: prHead, branch: 'harvest/one', state: 'OPEN' }, git);
  const candidate = { ...action, cwd, harvestState: signal };
  f.deps.harvestGit = git;
  const command = f.deps.command;
  f.deps.command = async args => args.includes('state,headRefOid,headRefName')
    ? (f.calls.push(args), { status: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: prHead, headRefName: 'harvest/one' }) }) : command(args);
  expect(await executeNextAction(candidate, f.deps)).toBe('waiting');
  expect(candidate.history).toContain('review skipped: owner-worktree-commit');
  expect(gitCalls.map(c => c[0])).toEqual(['branch', 'rev-parse', 'worktree', 'merge-base', 'branch', 'rev-parse', 'worktree', 'merge-base']);
  expect(candidate.harvestState).toEqual({ pr: 42, source: 'owner-worktree-commit', head: INPUT });
  expect(f.calls.map(c => c.slice(0, 2))).toEqual([['gh', 'pr']]);
  expect(f.events.at(-1)).toMatchObject({ kind: 'review', result: 'waiting', reason: expect.stringContaining('next: wait') });

  const stale = fake();
  stale.deps.harvestGit = git;
  const staleCommand = stale.deps.command;
  stale.deps.command = async args => args.includes('state,headRefOid,headRefName')
    ? (stale.calls.push(args), { status: 0, stdout: JSON.stringify({ state: 'OPEN', headRefOid: INPUT, headRefName: 'harvest/one' }) }) : staleCommand(args);
  expect(await executeNextAction({ ...action, cwd, harvestState: signal }, stale.deps)).toBe('done');
  expect(stale.calls.map(c => c.slice(0, 2)).slice(0, 2)).toEqual([['gh', 'pr'], ['self', 'review']]);

  const notAncestor = fake();
  const refused = actions.ownerWorktreeHarvestState({ pr: 42, cwd, head: prHead, branch: 'harvest/one', state: 'OPEN' },
    (path, args) => args[0] === 'merge-base' ? { status: 1, stdout: '' } : git(path, args));
  expect(refused).toBeUndefined();
  expect(actions.ownerWorktreeHarvestState({ pr: 42, cwd, head: prHead, branch: 'harvest/one', state: 'MERGED' }, git)).toBeUndefined();
  expect(actions.ownerWorktreeHarvestState({ pr: 42, cwd, head: INPUT, branch: 'harvest/one', state: 'OPEN' }, git)).toBeUndefined();
  expect(actions.ownerWorktreeHarvestState({ pr: 42, cwd, head: prHead, branch: 'other-branch', state: 'OPEN' }, git)).toBeUndefined();
  expect(actions.ownerWorktreeHarvestState({ pr: 42, cwd, head: prHead, branch: 'harvest/one', state: 'OPEN' },
    (path, args) => args[0] === 'worktree' ? { status: 0, stdout: `worktree ${path}\nHEAD ${INPUT}\nbranch refs/heads/other-branch\n` } : git(path, args))).toBeUndefined();
  expect(await executeNextAction({ ...action, cwd, harvestState: refused }, notAncestor.deps)).toBe('done');
  expect(notAncestor.calls[0]?.slice(0, 2)).toEqual(['self', 'review']);
});

test('TA-REVIEW-SKIP-HARVEST: registered owner worktree commit is produced by real git', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ta-harvest-git-'));
  const git = (...args: string[]) => {
    const out = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env,
      GIT_AUTHOR_NAME: 'TA test', GIT_AUTHOR_EMAIL: 'ta@example.invalid',
      GIT_COMMITTER_NAME: 'TA test', GIT_COMMITTER_EMAIL: 'ta@example.invalid' } });
    expect(out.status).toBe(0);
    return out.stdout.trim();
  };
  git('init', '-b', 'harvest/one');
  writeFileSync(join(cwd, 'artifact.txt'), 'first\n');
  git('add', 'artifact.txt');
  git('commit', '-m', 'PR head');
  const prHead = git('rev-parse', 'HEAD');
  writeFileSync(join(cwd, 'artifact.txt'), 'second\n');
  git('add', 'artifact.txt');
  git('commit', '-m', 'owner worktree commit');
  const owner = git('rev-parse', 'HEAD');
  expect(actions.ownerWorktreeHarvestState({ pr: 42, cwd, head: prHead, branch: 'harvest/one', state: 'OPEN' })).toEqual({
    pr: 42, head: owner, source: 'owner-worktree-commit',
  });
  expect(actions.ownerWorktreeHarvestState({ pr: 42, cwd, head: owner, branch: 'harvest/one', state: 'OPEN' })).toBeUndefined();
  const path = join(cwd, 'cards.json');
  const url = 'https://github.com/example/project/pull/42';
  const card: TaskCard = { id: 'ta-real-git', text: 'fixture', status: 'launched', createdAt: '2026-10-23T00:00:00Z',
    history: [], pr: { number: 42, url }, runId: 'run-real-git' };
  writeTaskCards(path, [card]);
  let reviews = 0;
  const outcome = await executeLiveReview(card, 42, { runId: card.runId!, stopReason: 'harvestable-awaiting-human', cwd }, {
    statePath: path, prHead: async () => ({ head: prHead, branch: 'harvest/one', state: 'OPEN', url }),
    requestReview: async () => { reviews++; },
  });
  expect(outcome).toMatchObject({ executed: false, detail: expect.stringContaining('next: wait for harvest') });
  expect(reviews).toBe(0);
  expect(readTaskCard(card.id, path)?.history).toContainEqual(expect.objectContaining({ event: 'review-skipped-harvest',
    head: owner, effect: 'wait' }));
});

test('TA-REVIEW-SKIP-HARVEST: live review consumes owner signal, records card history and waits for harvest', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ta-live-harvest-'));
  const path = join(cwd, 'card.json');
  const card: TaskCard = { id: 'ta-harvest', text: 'original', createdAt: '2026-10-23T00:00:00Z', status: 'launched', history: [], pr: { number: 42, url: 'https://github.com/example/project/pull/42' }, runId: 'run-1' };
  writeTaskCards(path, [card]);
  let requests = 0;
  const local = INPUT;
  const remote = 'c'.repeat(40);
  const deps = {
    statePath: path,
    prHead: async () => ({ state: 'OPEN', head: remote, branch: 'harvest/one', url: 'https://github.com/example/project/pull/42' }),
    harvestGit: (dir: string, args: string[]) => ({ status: 0,
      stdout: args[0] === 'branch' ? 'harvest/one\n' : args[0] === 'rev-parse' ? `${local}\n`
        : args[0] === 'worktree' ? `worktree ${dir}\nHEAD ${local}\nbranch refs/heads/harvest/one\n` : '' }),
    requestReview: async () => { requests++; },
  };
  const next = await executeLiveReview(card, 42, { runId: 'run-1', stopReason: 'harvestable-awaiting-human', cwd }, deps);
  expect(next).toMatchObject({ kind: 'review', executed: false, ok: true, detail: expect.stringContaining('next: wait for harvest') });
  expect(requests).toBe(0);
  expect(readTaskCard(card.id, path)?.history).toMatchObject([{ event: 'review-skipped-harvest', pr: 42, head: local, effect: 'wait' }]);
  expect(readTaskCard(card.id, path)?.reviewRequests).toBeUndefined();
  expect((await executeLiveReview(card, 42, { runId: 'run-1', stopReason: 'harvestable-awaiting-human', cwd }, deps)).executed).toBe(false);
  expect(readTaskCard(card.id, path)?.history).toHaveLength(1);

  writeTaskCards(path, [{ ...readTaskCard(card.id, path)!, runId: 'run-2' }]);
  expect((await executeLiveReview(card, 42, { runId: 'run-2', stopReason: 'harvestable-awaiting-human', cwd }, deps)).executed).toBe(false);
  expect(readTaskCard(card.id, path)?.history.filter(entry => entry.event === 'review-skipped-harvest' && entry.runId === 'run-2')).toHaveLength(1);
  expect(rejudgeCandidates({ [card.id]: readTaskCard(card.id, path)! })).toEqual([card.id]);
  expect(requests).toBe(0);

  deps.prHead = async () => ({ state: 'OPEN', head: local, branch: 'harvest/one', url: 'https://github.com/example/project/pull/42' });
  expect((await executeLiveReview(card, 42, { runId: 'run-1', stopReason: 'harvestable-awaiting-human', cwd }, deps)).executed).toBe(true);
  expect(requests).toBe(1);
  expect(readTaskCard(card.id, path)?.reviewRequests).toContainEqual(expect.objectContaining({ pr: 42, head: local }));
  deps.prHead = async () => ({ state: 'OPEN', head: remote, branch: 'harvest/one', url: 'https://github.com/example/project/pull/42' });

  deps.harvestGit = (dir, args) => ({ status: args[0] === 'merge-base' ? 1 : 0,
    stdout: args[0] === 'branch' ? 'harvest/one\n' : args[0] === 'rev-parse' ? `${local}\n`
      : args[0] === 'worktree' ? `worktree ${dir}\nHEAD ${local}\nbranch refs/heads/harvest/one\n` : '' });
  expect((await executeLiveReview(card, 42, { runId: 'run-1', stopReason: 'harvestable-awaiting-human', cwd }, deps)).executed).toBe(true);
  expect(requests).toBe(2);

  const other = { ...card, id: 'ta-other', pr: 43 };
  writeTaskCards(path, [other]);
  deps.harvestGit = (dir, args) => ({ status: 0,
    stdout: args[0] === 'branch' ? 'harvest/one\n' : args[0] === 'rev-parse' ? `${local}\n`
      : args[0] === 'worktree' ? `worktree ${dir}\nHEAD ${local}\nbranch refs/heads/harvest/one\n` : '' });
  expect((await executeLiveReview(other, 42, { runId: 'run-1', stopReason: 'harvestable-awaiting-human', cwd }, deps)).executed).toBe(true);
  expect(requests).toBe(3);
  expect(readTaskCard(other.id, path)?.history).toHaveLength(0);

  const wrongUrl = { ...card, id: 'ta-wrong-url', pr: { number: 42, url: 'https://github.com/other/project/pull/42' } };
  writeTaskCards(path, [wrongUrl]);
  expect((await executeLiveReview(wrongUrl, 42, { runId: 'run-1', stopReason: 'harvestable-awaiting-human', cwd }, deps)).executed).toBe(true);
  expect(requests).toBe(4);
  expect(readTaskCard(wrongUrl.id, path)?.history).toHaveLength(0);

  const noUrl = { ...card, id: 'ta-no-url', pr: 42 };
  writeTaskCards(path, [noUrl]);
  expect((await executeLiveReview(noUrl, 42, { runId: 'run-1', stopReason: 'harvestable-awaiting-human', cwd }, deps)).executed).toBe(true);
  expect(requests).toBe(5);
  expect(readTaskCard(noUrl.id, path)?.history).toHaveLength(0);

  const noRun = { ...card, id: 'ta-no-run', runId: undefined };
  writeTaskCards(path, [noRun]);
  expect((await executeLiveReview(noRun, 42, { runId: null, stopReason: 'harvestable-awaiting-human', cwd }, deps)).executed).toBe(true);
  expect(requests).toBe(6);
  expect(readTaskCard(noRun.id, path)?.history).toHaveLength(0);
});

test('TA-REVIEW-SKIP-HARVEST: supervisor live round records skip, history and next wait for bound PR', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ta-supervisor-harvest-'));
  const statePath = join(cwd, 'cards.json');
  const card: TaskCard = { id: 'ta-live', text: 'feature ask', createdAt: '2026-10-23T00:00:00Z', status: 'launched',
    history: [], pr: { number: 42, url: 'https://github.com/example/project/pull/42' }, runId: 'run-live' };
  writeTaskCards(statePath, [card]);
  const result = { taskId: card.id, feature: card.text, status: 'done', ok: true,
    worktreePath: cwd, prNumber: 42 } as SupervisorJobResult;
  let requests = 0;
  const move = await recordTaskAgentShadowMove({ runId: 'run-live', stopReason: 'needs-human', results: [result] }, {
    env: {}, statePath, log: () => {}, liveMoves: new Set(['review']), prFiles: async () => ['src/task-agent/actions.ts'],
    live: { statePath, prHead: async () => ({ state: 'OPEN', head: 'c'.repeat(40), branch: 'harvest/one', url: 'https://github.com/example/project/pull/42' }),
      harvestGit: (dir, args) => ({ status: 0,
        stdout: args[0] === 'branch' ? 'harvest/one\n' : args[0] === 'rev-parse' ? `${INPUT}\n`
          : args[0] === 'worktree' ? `worktree ${dir}\nHEAD ${INPUT}\nbranch refs/heads/harvest/one\n` : '' }),
      requestReview: async () => { requests++; } },
  });
  const recorded = readTaskCard(card.id, statePath);
  if (process.env.TA_HARVEST_EVIDENCE === '1') console.info('TA_HARVEST_LIVE_ROUND ' + JSON.stringify({ move, card: recorded, requests }));
  expect(move).toMatchObject({ move: 'review', liveMove: { kind: 'review', executed: false, ok: true, detail: expect.stringContaining('next: wait for harvest') } });
  expect(requests).toBe(0);
  expect(recorded?.history).toContainEqual(expect.objectContaining({ event: 'review-skipped-harvest', pr: 42, head: INPUT, effect: 'wait' }));
  expect(recorded?.reviewRequests).toBeUndefined();
});

test('TA-REVIEW-SKIP-HARVEST: rejudge waits for owner commit then reviews exact PR head', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ta-rejudge-harvest-'));
  const path = join(cwd, 'cards.json');
  const url = 'https://github.com/example/project/pull/42';
  const card: TaskCard = { id: 'ta-rejudge', text: 'feature ask', createdAt: '2026-10-23T00:00:00Z', status: 'launched',
    pr: { number: 42, url }, runId: 'run-1', history: [{ at: '2026-10-23T00:00:00Z', event: 'review-skipped-harvest',
      pr: 42, head: INPUT, runId: 'run-1', effect: 'wait' }] };
  writeTaskCards(path, [card]);
  expect(rejudgeCandidates({ [card.id]: card })).toEqual([card.id]);
  expect(rejudgeCandidates({ other: { ...card, id: 'other', history: [] } })).toEqual([]);
  let head = 'c'.repeat(40);
  let reviews = 0, regates = 0;
  const deps = { liveMoves: new Set(['review' as const]), prFiles: async () => ['src/task-agent/actions.ts'],
    ownerHarvestAncestor: () => false,
    requestRegate: async () => { regates++; },
    live: { statePath: path, repoCandidates: () => [{ source: 'host' as const, cwd }],
      prHead: async () => ({ state: 'OPEN', head, branch: 'harvest/one', url }),
      requestReview: async () => { reviews++; } }, log: () => {} };
  expect((await rejudgeCardOnHead(card.id, deps)).at(-1)).toMatchObject({ step: 'review', decision: 'awaiting-harvest' });
  expect((await rejudgeCardOnHead(card.id, deps)).at(-1)).toMatchObject({ step: 'review', decision: 'awaiting-harvest' });
  expect([reviews, regates]).toEqual([0, 0]);
  expect(readTaskCard(card.id, path)?.reviewRequests).toBeUndefined();
  head = INPUT;
  expect((await rejudgeCardOnHead(card.id, deps)).at(-1)).toMatchObject({ step: 'review', decision: 'review-requested' });
  expect(reviews).toBe(1);
  expect(readTaskCard(card.id, path)?.reviewRequests).toContainEqual(expect.objectContaining({ pr: 42, head: INPUT }));
  expect(readTaskCard(card.id, path)?.history).toContainEqual(expect.objectContaining({ event: 'review-harvest-reached', head: INPUT }));
  await rejudgeCardOnHead(card.id, deps);
  expect(reviews).toBe(1);
  expect(readTaskCard(card.id, path)?.history.filter(item => item.event === 'review-harvest-reached')).toHaveLength(1);
  expect(rejudgeCandidates({ wrong: { ...card, id: 'wrong', history: [{ ...card.history[0]!, runId: 'another-run' }] } })).toEqual([]);

  const awaitingReview: TaskCard = { ...card, id: 'ta-awaiting-review', history: [...card.history, {
    at: '2026-10-23T00:00:01Z', event: 'review-harvest-reached', pr: 42, head: INPUT, runId: 'run-1',
  }] };
  writeTaskCards(path, [awaitingReview]);
  expect(rejudgeCandidates({ [awaitingReview.id]: awaitingReview })).toEqual([awaitingReview.id]);
  const disabled = { ...deps, liveMoves: new Set<'review'>() };
  expect((await rejudgeCardOnHead(awaitingReview.id, disabled)).at(-1)).toMatchObject({ step: 'review', decision: 'would-review' });
  expect(reviews).toBe(1);
  expect(rejudgeCandidates({ [awaitingReview.id]: readTaskCard(awaitingReview.id, path)! })).toEqual([awaitingReview.id]);
  expect((await rejudgeCardOnHead(awaitingReview.id, deps)).at(-1)).toMatchObject({ step: 'review', decision: 'review-requested' });
  expect(reviews).toBe(2);
  expect(rejudgeCandidates({ [awaitingReview.id]: readTaskCard(awaitingReview.id, path)! })).toEqual([awaitingReview.id]);

  const oldReview = { ...card, id: 'ta-old-review', reviewRequests: [{ pr: 42, head: 'd'.repeat(40), at: '2026-10-23T00:00:00Z' }] };
  writeTaskCards(path, [oldReview]);
  expect(readTaskCard(oldReview.id, path)).toMatchObject({ history: [{ event: 'review-skipped-harvest', head: INPUT }], reviewRequests: [{ head: 'd'.repeat(40) }] });
  expect(readTaskCard(oldReview.id, path)?.history.map(item => item.event)).toEqual(['review-skipped-harvest']);
  head = 'c'.repeat(40);
  expect((await rejudgeCardOnHead(oldReview.id, deps)).at(-1)).toMatchObject({ step: 'review', decision: 'awaiting-harvest' });
  expect(reviews).toBe(2);
  head = 'e'.repeat(40);
  expect((await rejudgeCardOnHead(oldReview.id, { ...deps, ownerHarvestAncestor: (_cwd: string, owner: string, newer: string) => owner === INPUT && newer === head })).at(-1))
    .toMatchObject({ step: 'review', decision: 'review-requested' });
  expect(readTaskCard(oldReview.id, path)?.history).toContainEqual(expect.objectContaining({ event: 'review-harvest-reached', head }));
  expect(reviews).toBe(3);
  expect((await rejudgeCardOnHead(oldReview.id, { ...deps, ownerHarvestAncestor: () => false })).at(-1)?.decision).not.toBe('awaiting-harvest');
  expect(readTaskCard(oldReview.id, path)?.history.filter(item => item.event === 'review-harvest-reached')).toHaveLength(1);
  expect(reviews).toBe(3);
});

test('TA-REVIEW-SKIP-HARVEST: review request rechecks owner ancestry after PR head changes', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ta-harvest-race-'));
  const path = join(cwd, 'cards.json');
  const url = 'https://github.com/example/project/pull/42';
  const other = 'f'.repeat(40);
  const card: TaskCard = { id: 'ta-race', text: 'feature ask', createdAt: '2026-10-23T00:00:00Z', status: 'launched',
    pr: { number: 42, url }, runId: 'run-1', history: [
      { at: '2026-10-23T00:00:00Z', event: 'review-skipped-harvest', pr: 42, head: INPUT, runId: 'run-1', effect: 'wait' },
      { at: '2026-10-23T00:00:01Z', event: 'review-harvest-reached', pr: 42, head: INPUT, runId: 'run-1' },
    ] };
  writeTaskCards(path, [card]);
  let reads = 0, reviews = 0;
  const deps = { liveMoves: new Set(['review' as const]), prFiles: async () => ['src/task-agent/actions.ts'],
    ownerHarvestAncestor: () => false,
    live: { statePath: path, repoCandidates: () => [{ source: 'host' as const, cwd }],
      prHead: async () => ({ state: 'OPEN', head: ++reads === 1 ? INPUT : other, branch: 'harvest/one', url }),
      requestReview: async () => { reviews++; } }, log: () => {} };
  const result = await rejudgeCardOnHead(card.id, deps);
  expect(result.at(-1)).toMatchObject({ step: 'review', decision: 'awaiting-harvest' });
  expect(reads).toBeGreaterThan(1);
  expect(reviews).toBe(0);
  expect(readTaskCard(card.id, path)?.reviewRequests).toBeUndefined();
  expect((await rejudgeCardOnHead(card.id, deps)).at(-1)).toMatchObject({ step: 'review', decision: 'awaiting-harvest' });
  expect(reviews).toBe(0);

  reads = 0;
  writeTaskCards(path, [{ ...card, id: 'ta-race-at-executor' }]);
  const executorDeps = { ...deps, live: { ...deps.live,
    prHead: async () => ({ state: 'OPEN', head: ++reads < 3 ? INPUT : other, branch: 'harvest/one', url }) } };
  expect((await rejudgeCardOnHead('ta-race-at-executor', executorDeps)).at(-1)).toMatchObject({ step: 'review', decision: 'awaiting-harvest' });
  expect(reads).toBeGreaterThanOrEqual(3);
  expect(reviews).toBe(0);
  expect(readTaskCard('ta-race-at-executor', path)?.reviewRequests).toBeUndefined();
});

test('TA-REVIEW-SKIP-HARVEST: descendant reach history is idempotent without a successful review', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ta-harvest-descendant-'));
  const path = join(cwd, 'cards.json');
  const url = 'https://github.com/example/project/pull/42';
  const descendant = 'e'.repeat(40);
  const card: TaskCard = { id: 'ta-descendant', text: 'feature ask', createdAt: '2026-10-23T00:00:00Z', status: 'launched',
    pr: { number: 42, url }, runId: 'run-1', history: [{ at: '2026-10-23T00:00:00Z', event: 'review-skipped-harvest',
      pr: 42, head: INPUT, runId: 'run-1', effect: 'wait' }] };
  writeTaskCards(path, [card]);
  let requests = 0;
  const live = { statePath: path, repoCandidates: () => [{ source: 'host' as const, cwd }],
    prHead: async () => ({ state: 'OPEN', head: descendant, branch: 'harvest/one', url }),
    harvestGit: () => ({ status: 0, stdout: '' }),
    requestReview: async () => { requests++; throw new Error('unavailable'); } };
  const deps = { liveMoves: new Set<'review'>(), prFiles: async () => ['src/task-agent/actions.ts'],
    ownerHarvestAncestor: () => true, live, log: () => {} };
  for (let tick = 0; tick < 3; tick++) {
    expect((await rejudgeCardOnHead(card.id, deps)).at(-1)).toMatchObject({ step: 'review', decision: 'would-review' });
    expect(readTaskCard(card.id, path)?.history.filter(item => item.event === 'review-harvest-reached')).toHaveLength(1);
  }
  deps.liveMoves.add('review');
  expect((await rejudgeCardOnHead(card.id, deps)).at(-1)).toMatchObject({ step: 'review', decision: 'review-request-failed' });
  expect(readTaskCard(card.id, path)?.history.filter(item => item.event === 'review-harvest-reached')).toHaveLength(1);
  expect((await rejudgeCardOnHead(card.id, deps)).at(-1)?.decision).not.toBe('review-requested');
  expect(readTaskCard(card.id, path)?.history.filter(item => item.event === 'review-harvest-reached')).toHaveLength(1);
  expect(requests).toBe(1);
});

test('pass reviews then lands then greens with actual merged SHA, not input SHA', async () => {
  const f = fake();
  await executeNextAction(action, f.deps);
  expect(f.calls.map(c => c.slice(0, 2))).toEqual([['self', 'review'], ['gh', 'pr'], ['pr', 'land'], ['gh', 'pr'], ['release', 'checklist']]);
  expect(f.calls[2]).toEqual(['pr', 'land', '--cwd', '/isolated/worktree']);
  expect(f.calls[4]).toContain(`42·${LANDED}`);
  expect(f.calls[4]).not.toContain(`42·${INPUT}`);
  expect(f.events).toHaveLength(3);
});
test('a verdict without reviewed true never lands', async () => {
  const f = fake();
  f.deps.command = async args => { f.calls.push(args); return { status: 0, stdout: JSON.stringify({ verdict: 'pass', mustFix: [] }) }; };
  await executeNextAction(action, f.deps);
  expect(f.calls.map(c => c[0])).toEqual(['self']);
});
// TA-LAND-MUSTFIX-ZERO — «pass ⊕ must-fix» 와 «must-fix 모름» 은 land 로 가지 않고 카드로 간다(관측 사유 포함).
test('pass with must-fix raises a card and never lands (review-warn-with-must-fix)', async () => {
  const f = fake({ verdict: 'pass', mustFix: ['still broken'], reviewed: true });
  expect(await executeNextAction(action, f.deps)).toBe('decision');
  expect(f.calls.map(c => c.slice(0, 2))).toEqual([['self', 'review'], ['decisions', 'raise']]);
  expect(f.calls.some(c => c[0] === 'pr')).toBe(false);
  expect(f.events.at(-1)).toMatchObject({ kind: 'review', result: 'decision', reason: expect.stringContaining('review-warn-with-must-fix') });
});
test('pass without a must-fix list raises a card and never lands (review-must-fix-unknown)', async () => {
  const f = fake();
  f.deps.command = async args => { f.calls.push(args); return { status: 0, stdout: args[0] === 'self' ? JSON.stringify({ verdict: 'pass', reviewed: true }) : '' }; };
  expect(await executeNextAction(action, f.deps)).toBe('decision');
  expect(f.calls.map(c => c.slice(0, 2))).toEqual([['self', 'review'], ['decisions', 'raise']]);
  expect(f.events.at(-1)).toMatchObject({ result: 'decision', reason: expect.stringContaining('review-must-fix-unknown') });
  const garbled = fake({ verdict: 'pass', mustFix: [null] as unknown as string[], reviewed: true });
  expect(await executeNextAction(action, garbled.deps)).toBe('decision');
  expect(garbled.events.at(-1)).toMatchObject({ reason: expect.stringContaining('review-must-fix-unknown') });
});
test('fail retries without rewriting original and includes must-fix and prior run', async () => {
  const f = fake({ verdict: 'fail', mustFix: ['fix this'], reviewed: true });
  await executeNextAction(action, f.deps);
  expect(f.calls[1]?.slice(0, 2)).toEqual(['harness', 'say']);
  expect(f.calls[1]?.[2]).toStartWith('verbatim ask');
  expect(f.calls[1]?.[2]).toContain('fix this');
  expect(f.calls[1]?.[2]).toContain('run-1');
});
test('release-path and landing cap raise cards without landing', async () => {
  const release = fake(undefined, ['elanous:release-path']);
  await executeNextAction({ ...action, kind: 'land' }, release.deps);
  expect(release.calls.map(c => c.slice(0, 2))).toEqual([['gh', 'pr'], ['decisions', 'raise']]);
  const both = fake(undefined, ['elanous:keep', 'elanous:release-path']);
  expect(await executeNextAction({ ...action, kind: 'land' }, both.deps)).toBe('decision');
  expect(both.calls.map(c => c.slice(0, 2))).toEqual([['gh', 'pr'], ['decisions', 'raise']]);
  expect(both.events.at(-1)).toMatchObject({ kind: 'land', result: 'decision', reason: 'release-path' });
  const cap = fake();
  cap.deps.landingsToday = 5;
  cap.deps.landingDay = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  await executeNextAction({ ...action, kind: 'land' }, cap.deps);
  expect(cap.calls.map(c => c.slice(0, 2))).toEqual([['gh', 'pr'], ['decisions', 'raise']]);
});
test('keep-only PR raises a grounded decision before any land or landing-slot reservation', async () => {
  const f = fake(undefined, ['elanous:keep']);
  let reserved = 0;
  f.deps.reserveLanding = () => { reserved++; return true; };
  expect(await executeNextAction({ ...action, kind: 'land' }, f.deps)).toBe('decision');
  expect(f.calls.map(c => c.slice(0, 2))).toEqual([['gh', 'pr'], ['decisions', 'raise']]);
  expect(f.calls.some(c => c[0] === 'pr' && c[1] === 'land')).toBe(false);
  expect(reserved).toBe(0);
  const raise = f.calls[1]!;
  expect(raise[raise.indexOf('--c') + 1]).toBe('elanous:keep');
  expect(JSON.parse(raise[raise.indexOf('--ref') + 1]!)).toMatchObject({ pr: 42, selected: 'land', reason: 'elanous:keep' });
  expect(f.events.at(-1)).toMatchObject({ kind: 'land', result: 'decision', reason: 'elanous:keep' });
});
test('repeated successful landings count toward daily cap', async () => {
  const f = fake();
  for (let i = 0; i < 6; i++) await executeNextAction({ ...action, kind: 'land' }, f.deps);
  expect(f.calls.filter(c => c[0] === 'pr')).toHaveLength(5);
  expect(f.calls.filter(c => c[0] === 'decisions')).toHaveLength(1);
});
test('a new KST day resets the landing count and persists the new bucket', async () => {
  const f = fake();
  const saved: Array<{ day?: string; count?: number }> = [];
  f.deps.landingDay = '2000-01-01';
  f.deps.landingsToday = 5;
  f.deps.saveState = () => saved.push({ day: f.deps.landingDay, count: f.deps.landingsToday });
  await executeNextAction({ ...action, kind: 'land' }, f.deps);
  expect(f.calls.some(c => c[0] === 'pr' && c[1] === 'land')).toBe(true);
  // 착지는 병합 확인 뒤에만 센다 — 새 날의 첫 저장이 곧 «그날 1건»이다(옛 날 5건은 남지 않는다).
  expect(saved[0]).toEqual({ day: new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }), count: 1 });
});
test('a caller cannot mark a stale supplied SHA green without landing', async () => {
  const f = fake();
  await executeNextAction({ ...action, kind: 'green' }, f.deps);
  expect(f.calls.map(c => c[0])).toEqual(['decisions']);
});
test('missing landing worktree does not attempt to land', async () => {
  const f = fake();
  await executeNextAction({ ...action, kind: 'land', cwd: undefined }, f.deps);
  expect(f.calls.map(c => c[0])).toEqual(['decisions']);
});
test('missing labels fail closed', async () => {
  const f = fake();
  f.deps.command = async args => { f.calls.push(args); return { status: 1, stdout: '' }; };
  await executeNextAction({ ...action, kind: 'land' }, f.deps);
  expect(f.calls.map(c => c[0])).toEqual(['gh', 'decisions']);
});
test('unverified landing never greens', async () => {
  const f = fake();
  f.deps.command = async args => { f.calls.push(args); return { status: 0, stdout: args.includes('labels') ? '{"labels":[]}' : '{"state":"OPEN"}' }; };
  await executeNextAction({ ...action, kind: 'land' }, f.deps);
  expect(f.calls.map(c => c[0])).toEqual(['gh', 'pr', 'gh', 'decisions']);
});
test('two failures of the same task and action halt the third attempt', async () => {
  const f = fake();
  f.deps.failureCounts = {};
  f.deps.command = async args => {
    f.calls.push(args);
    return { status: args[0] === 'self' ? 1 : 0, stdout: '' };
  };
  for (let i = 0; i < 3; i++) await executeNextAction(action, f.deps);
  expect(f.calls.map(c => c[0])).toEqual(['self', 'self', 'decisions']);
});
test('shadow, repeated failure and risk gates', async () => {
  const f = fake();
  f.deps.mode = undefined;
  await executeNextAction(action, f.deps);
  expect(f.calls).toHaveLength(0);
  expect(f.events).toHaveLength(1);
  f.deps.mode = 'live';
  f.deps.failures = 2;
  await executeNextAction(action, f.deps);
  expect(f.calls[0]?.slice(0, 2)).toEqual(['decisions', 'raise']);
  f.deps.failures = 0;
  await executeNextAction({ ...action, risk: 'security' }, f.deps);
  expect(f.calls[1]?.slice(0, 2)).toEqual(['decisions', 'raise']);
});

test('a landing that is not confirmed merged does not count and returns the reserved slot', async () => {
  const f = fake();
  let reserved = 0, released = 0;
  f.deps.reserveLanding = () => { reserved++; return true; };
  f.deps.releaseLanding = () => { released++; };
  const base = f.deps.command;
  f.deps.command = async args => args[0] === 'gh' && args.includes('state,mergeCommit') ? { status: 0, stdout: JSON.stringify({ state: 'OPEN' }) } : base(args);
  await executeNextAction({ ...action, kind: 'land' }, f.deps);
  expect([reserved, released]).toEqual([1, 1]);
  expect(f.events.some((e) => (e as { result: string }).result === 'done')).toBe(false);
});

test('a checklist failure after landing is counted as a land failure', async () => {
  const f = fake();
  f.deps.failureCounts = {};
  const base = f.deps.command;
  f.deps.command = async args => args[0] === 'release' ? { status: 1, stdout: '', stderr: 'locked' } : base(args);
  expect(await executeNextAction({ ...action, kind: 'land' }, f.deps)).toBe('failed');
  expect(f.deps.failureCounts[JSON.stringify(['TASK', 'land'])]).toBe(1);
});

test('the daily limit is checked through the reservation when one is given', async () => {
  const f = fake();
  f.deps.reserveLanding = () => false;
  expect(await executeNextAction({ ...action, kind: 'land' }, f.deps)).toBe('decision');
  expect(f.calls.some(c => c[0] === 'pr')).toBe(false);
});

test('failures from two processes add up through incrementFailure (no stale overwrite)', async () => {
  const disk: Record<string, number> = { [JSON.stringify(['TASK', 'retry'])]: 1 };
  const f = fake();
  f.deps.incrementFailure = (key) => { disk[key] = (disk[key] ?? 0) + 1; return disk[key]!; };
  const base = f.deps.command;
  f.deps.command = async args => args[0] === 'harness' ? { status: 1, stdout: '', stderr: 'boom' } : base(args);
  expect(await executeNextAction({ ...action, kind: 'retry', mustFix: ['fix it'] }, f.deps)).toBe('failed');
  expect(disk[JSON.stringify(['TASK', 'retry'])]).toBe(2);
  expect(await executeNextAction({ ...action, kind: 'retry', mustFix: ['fix it'] }, { ...f.deps, failureCounts: { [JSON.stringify(['TASK', 'retry'])]: 2 } })).toBe('decision');
});

test('TA-LIVE-RETRY: bare relaunch and the narrow variant are one move — the cap sees their failures together', async () => {
  const f = fake();
  const counts = { [JSON.stringify(['TASK', 'retry'])]: 1, [JSON.stringify(['TASK', 'retry', 'narrow'])]: 1 };
  let launched = 0;
  const base = f.deps.command;
  f.deps.command = async args => { if (args[0] === 'harness') launched++; return base(args); };
  expect(await executeNextAction({ ...action, kind: 'retry', variant: 'narrow' }, { ...f.deps, failureCounts: { ...counts } })).toBe('decision');
  expect(await executeNextAction({ ...action, kind: 'retry', mustFix: ['fix it'] }, { ...f.deps, failureCounts: { ...counts } })).toBe('decision');
  expect(launched).toBe(0);
  expect(await executeNextAction({ ...action, kind: 'retry', variant: 'salvage', salvageBranch: 'salvage/x' }, { ...f.deps, failureCounts: { ...counts } })).not.toBe('decision');
});

test('an unreadable merge state keeps the reserved slot (it may have merged)', async () => {
  const f = fake();
  let released = 0;
  f.deps.reserveLanding = () => true;
  f.deps.releaseLanding = () => { released++; };
  const base = f.deps.command;
  f.deps.command = async args => args[0] === 'gh' && args.includes('state,mergeCommit') ? { status: 1, stdout: '', stderr: 'rate limited' } : base(args);
  await executeNextAction({ ...action, kind: 'land' }, f.deps);
  expect(released).toBe(0);
});

// TA-LIVE-RETRY — 사다리 R4: 재발사 계열 넷을 실행부 허용 목록에 올린다 · 같은 수 2회 상한 · 회당 1건 · 부하 관문.
const VARIANT_OF = { 'narrow-relaunch': 'narrow', 'wait-retry': 'wait', 'salvage-relaunch': 'salvage', alternative: 'alternative' } as const;
const retry = (variant: NextAction['variant'], over: Partial<NextAction> = {}): NextAction => ({ ...action, kind: 'retry', ...(variant ? { variant } : {}), ...over });
const harnessCalls = (calls: string[][]) => calls.filter(c => c[0] === 'harness');

test('R4 live: the four retry moves are vocabulary of taskAgent.liveMoves', () => {
  const resolved = resolveTaskAgentLiveMoves([...LIVE_RETRY_MOVES, 'review', 'relaunch'], {}, () => {});
  const expected: string[] = [...LIVE_RETRY_MOVES, 'review'];
  const moves: string[] = [...resolved.moves];
  expect(moves.sort()).toEqual(expected.sort());
  expect(resolved.ignored).toEqual(['relaunch']);
  expect(LIVE_RETRY_MOVES.map(move => retryMoveOf(VARIANT_OF[move]))).toEqual([...LIVE_RETRY_MOVES]);
  expect(retryMoveOf(undefined)).toBe('narrow-relaunch');
});

test('R4 live: allow-listed narrow · salvage · alternative launch once each, wait only leaves a marker', async () => {
  for (const [variant, hint] of [['narrow', 'Narrow relaunch'], ['salvage', 'Salvage relaunch'], ['alternative', 'Alternative approach']] as const) {
    const f = fake();
    f.deps.liveMoves = new Set(LIVE_RETRY_MOVES);
    expect(await executeNextAction(retry(variant), f.deps)).toBe('done');
    expect(harnessCalls(f.calls)).toHaveLength(1);
    expect(f.calls[0]![2]).toContain(hint);
  }
  const f = fake();
  f.deps.liveMoves = new Set(LIVE_RETRY_MOVES);
  expect(await executeNextAction(retry('wait'), f.deps)).toBe('waiting');
  expect(f.calls).toHaveLength(0);
});

test('R4 live: a retry move missing from the allow-list stays shadow without any command', async () => {
  const f = fake();
  f.deps.liveMoves = new Set(['review', 'narrow-relaunch']);
  expect(await executeNextAction(retry('salvage'), f.deps)).toBe('shadow');
  expect(await executeNextAction(retry('wait'), f.deps)).toBe('shadow');
  expect(await executeNextAction(retry('alternative'), f.deps)).toBe('shadow');
  expect(f.calls).toHaveLength(0);
  expect(f.events.at(-1)).toMatchObject({ result: 'shadow', reason: expect.stringContaining('alternative not in live allow-list') });
  expect(await executeNextAction(retry('narrow'), f.deps)).toBe('done');
});

test('R4 live: without an allow-list or gates the retry path is unchanged', async () => {
  const f = fake();
  expect(await executeNextAction(retry('salvage'), f.deps)).toBe('done');
  expect(await executeNextAction(retry('salvage'), f.deps)).toBe('done');
  expect(harnessCalls(f.calls)).toHaveLength(2);
});

test('R4 live: one relaunch per cycle — the second retry of the same cycle is shadow', async () => {
  const f = fake();
  f.deps.liveMoves = new Set(LIVE_RETRY_MOVES);
  f.deps.retryLaunches = { count: 0 };
  expect(await executeNextAction(retry('narrow'), f.deps)).toBe('done');
  expect(await executeNextAction(retry('alternative', { taskId: 'OTHER' }), f.deps)).toBe('shadow');
  expect(await executeNextAction(retry('wait'), f.deps)).toBe('waiting');
  expect(harnessCalls(f.calls)).toHaveLength(1);
  expect(f.events.some(e => (e as { reason: string }).reason.includes('one relaunch per cycle'))).toBe(true);
  expect(f.deps.retryLaunches.count).toBe(1);
  f.deps.retryLaunches = { count: 0 };
  expect(await executeNextAction(retry('narrow', { taskId: 'OTHER' }), f.deps)).toBe('done');
});

test('R4 live: a failed launch still uses the cycle slot', async () => {
  const f = fake();
  f.deps.retryLaunches = { count: 0 };
  f.deps.command = async args => { f.calls.push(args); return { status: 1, stdout: '', stderr: 'boom' }; };
  expect(await executeNextAction(retry('narrow'), f.deps)).toBe('failed');
  expect(await executeNextAction(retry('salvage'), f.deps)).toBe('shadow');
  expect(harnessCalls(f.calls)).toHaveLength(1);
});

test('R4 live: load gate — at or above loadMax (or unreadable) stays shadow, below launches, wait is not gated', async () => {
  const gate = (load: number | null) => ({ loadMax: 100, load1: () => load });
  for (const load of [100, 250, null, Number.NaN]) {
    const f = fake();
    f.deps.loadGate = gate(load);
    expect(await executeNextAction(retry('narrow'), f.deps)).toBe('shadow');
    expect(f.calls).toHaveLength(0);
    expect(f.events.at(-1)).toMatchObject({ reason: expect.stringContaining('load gate') });
    expect(await executeNextAction(retry('wait'), f.deps)).toBe('waiting');
  }
  const open = fake();
  open.deps.loadGate = gate(99.9);
  expect(await executeNextAction(retry('narrow'), open.deps)).toBe('done');
  expect(harnessCalls(open.calls)).toHaveLength(1);
});

test('R4 live: a shadowed retry does not use the cycle slot', async () => {
  const f = fake();
  f.deps.retryLaunches = { count: 0 };
  f.deps.loadGate = { loadMax: 10, load1: () => 50 };
  expect(await executeNextAction(retry('narrow'), f.deps)).toBe('shadow');
  expect(f.deps.retryLaunches.count).toBe(0);
});

test('R4 live: same task and same move never launches a third time (judge ⊕ executor share the counts)', async () => {
  const f = fake();
  f.deps.liveMoves = new Set(LIVE_RETRY_MOVES);
  f.deps.failureCounts = {};
  f.deps.command = async args => { f.calls.push(args); return { status: args[0] === 'harness' ? 1 : 0, stdout: '', stderr: 'boom' }; };
  const launchedBy: Record<string, number> = {};
  for (let tick = 0; tick < 8; tick++) {
    const failures = Object.fromEntries(LIVE_RETRY_MOVES.map(move =>
      [move, f.deps.failureCounts![failureKey({ taskId: 'TASK', kind: 'retry', variant: VARIANT_OF[move] })] ?? 0]));
    const judged = judgeNextMove({ stopReason: 'no-progress', failures });
    f.deps.retryLaunches = { count: 0 };
    const before = harnessCalls(f.calls).length;
    await executeNextAction({ ...action, kind: judged.executorKind!, ...(judged.executorVariant ? { variant: judged.executorVariant } : {}) }, f.deps);
    if (harnessCalls(f.calls).length > before) launchedBy[judged.move] = (launchedBy[judged.move] ?? 0) + 1;
  }
  expect(launchedBy).toEqual({ 'narrow-relaunch': SAME_MOVE_FAILURE_LIMIT, alternative: 1 });
  expect(f.calls.filter(c => c[0] === 'decisions').length).toBeGreaterThan(0);
});

test('R4 live: the executor itself refuses the move once it failed SAME_MOVE_FAILURE_LIMIT times', async () => {
  const f = fake();
  f.deps.liveMoves = new Set(LIVE_RETRY_MOVES);
  f.deps.failureCounts = { [failureKey({ taskId: 'TASK', kind: 'retry', variant: 'salvage' })]: SAME_MOVE_FAILURE_LIMIT };
  expect(await executeNextAction(retry('salvage'), f.deps)).toBe('decision');
  expect(harnessCalls(f.calls)).toHaveLength(0);
});

// GREEN-FROM-LEDGER-FU — green live 쓰기 소비자는 green-sweep 순수 판정(greenSweepCandidates/decideGreenSweep)의
// dry-run 결정을 소비한다. green-sweep 모듈은 쓰기 0 — `release checklist set --status green` 쓰기는 이 소비자만 한다.
// 원문 대조 ③(칸 원문 재독)은 cellEvidence 가 실제 일치를 확인했을 때만 'cell ok' 로 남는다 —
// 미제공·재독 불가는 자기 자신(item.evidence)과의 공전 대조를 하지 않고 unknown 으로 쓰기를 거부한다(거짓 green 방지).
test('GREEN-FROM-LEDGER-FU: consumer writes green only on positive decideGreenSweep + matching OP 원문; false-green blocked otherwise', async () => {
  // 소비자 유닛은 «동적 import»로 받는다 — 구현이 없는 base 에서도 이 시험 파일은 모듈 로드 오류가 아니라
  // export 부재 «단언 실패»로 레드를 목격한다(changed-test-evidence red witness).
  const actionsModule = await import('./actions.js');
  expect(typeof actionsModule.consumeGreenSweepForGreenWrite).toBe('function');
  const { consumeGreenSweepForGreenWrite } = actionsModule;
  const mergeSha = 'c'.repeat(40);
  const cell: ChecklistItem = { id: 'CELL-GREEN', title: '셀 제목', status: 'yellow', updatedAt: '2026-10-23T00:00:00.000Z', updatedBy: 'test' };
  const cards: TaskCard[] = [{ id: 'TASK-20261023-01', text: '과제', checklistId: 'CELL-GREEN', checklistVersion: '0.2.36', createdAt: '2026-10-23T00:00:00.000Z', status: 'done', history: [], pr: 4242 }];
  const evidenceLine = `GREEN-FROM-LEDGER: PR #4242 merged ${mergeSha} · green · bound-card-merged`;
  const baseProbe = { pr: async () => ({ number: 4242, state: 'MERGED', mergeSha }), ancestor: async () => true, hold: async () => false, repositoryMatches: async () => true };

  // (a) 판정 green ⊕ 원문 일치(칸 원문 재독도 판정이 본 것과 같다) — fake command runner 가 release checklist green 쓰기를 1회 관측한다.
  const f = fake();
  const accepted = await consumeGreenSweepForGreenWrite({
    deps: f.deps, item: cell, version: '0.2.36', cards,
    probe: { ...baseProbe, cellEvidence: async () => '' }, writeLive: true,
  });
  expect(accepted).toEqual({ cell: 'CELL-GREEN', pr: 4242, written: true, verdict: 'green', reason: evidenceLine });
  expect(f.calls).toEqual([['release', 'checklist', 'set', 'CELL-GREEN', '--status', 'green', '--evidence', evidenceLine]]);
  expect(f.events.at(-1)).toMatchObject({ taskId: 'CELL-GREEN', kind: 'green', result: 'done' });

  // (b) decideGreenSweep 거부(pr 관측 불가) — 쓰기 0 · 칸 재독도 일어나지 않는다(재독은 쓰기 직전 green 판정에만 한다).
  const refused = fake();
  const rejected = await consumeGreenSweepForGreenWrite({
    deps: refused.deps, item: cell, version: '0.2.36', cards,
    probe: { ...baseProbe, pr: async () => null, cellEvidence: async () => { throw new Error('cell re-read must not run for refused verdicts'); } },
  });
  expect(rejected).toMatchObject({ cell: 'CELL-GREEN', pr: 4242, written: false, verdict: 'skip' });
  expect(rejected.reason).toContain('pr-unreadable');
  expect(refused.calls).toHaveLength(0);
  expect(refused.events.at(-1)).toMatchObject({ kind: 'green', result: 'refused' });

  // (c) 원문 대조 불일치(칸 원문이 판정 뒤 바뀜) — green 판정이어도 쓰기 0 · 이유는 'cell mismatch' 로만 남는다.
  const stale = fake();
  const mismatched = await consumeGreenSweepForGreenWrite({
    deps: stale.deps, item: cell, version: '0.2.36', cards,
    probe: { ...baseProbe, cellEvidence: async () => '판정 뒤 바뀐 칸 원문' },
  });
  expect(mismatched).toMatchObject({ cell: 'CELL-GREEN', pr: 4242, written: false, verdict: 'evidence-mismatch' });
  expect(mismatched.reason).toContain('cell mismatch');
  expect(mismatched.reason).not.toContain('cell ok');
  expect(stale.calls).toHaveLength(0);
  expect(stale.events.at(-1)).toMatchObject({ kind: 'green', result: 'refused', reason: expect.stringContaining('원문 대조 불일치') });

  // (d) cellEvidence 미제공(타입은 필수 — JS 호출부가 런타임에 안 싣은 구멍) — 자기 자신(item.evidence)과
  //     대조하는 공전 경로를 만들지 않는다: ③ 칸은 unknown(unprovided) 상태로 남고 'cell ok' 를 주장하지 않으며 쓰기는 0.
  const unprovided = fake();
  const unprobed = await consumeGreenSweepForGreenWrite({
    deps: unprovided.deps, item: cell, version: '0.2.36', cards,
    probe: baseProbe as unknown as GreenSweepProbe,
  });
  expect(unprobed).toMatchObject({ cell: 'CELL-GREEN', pr: 4242, written: false, verdict: 'evidence-unknown' });
  expect(unprobed.reason).toContain('cell unprovided');
  expect(unprobed.reason).not.toContain('cell ok');
  expect(unprovided.calls).toHaveLength(0);
  expect(unprovided.events.at(-1)).toMatchObject({ kind: 'green', result: 'refused' });

  // (e) 칸 원문 재독 불가(cellEvidence 가 undefined 를 돌려줌) — 'cell unreadable' 로 unknown 상태를
  //     명시적으로 보존해 쓰기를 거부한다(모름을 일치로 꾸미지 않는다).
  const unreadable = fake();
  const reread = await consumeGreenSweepForGreenWrite({
    deps: unreadable.deps, item: cell, version: '0.2.36', cards,
    probe: { ...baseProbe, cellEvidence: async () => undefined },
  });
  expect(reread).toMatchObject({ cell: 'CELL-GREEN', pr: 4242, written: false, verdict: 'evidence-unknown' });
  expect(reread.reason).toContain('cell unreadable');
  expect(reread.reason).not.toContain('cell ok');
  expect(unreadable.calls).toHaveLength(0);
});

// GREEN-FROM-LEDGER-FU 배선(shard 2 · #30534 shard 1 이후) — 생산 진입점 executeNextAction 의 kind=green 경로가
// 소비자를 지나 OP 원문 대조 후 checklist green 쓰기를 «1회»만 하고, 거부·mismatch·unknown 입력에는 쓰기 «0회»
// ⊕ 칸 상태 불변을 fake command runner 로 관측한다. 문맥(deps.greenSweep)이 없으면 종전 그대로 검증 안내 카드.
test('GREEN-FROM-LEDGER-FU wiring: executeNextAction green — 원문 대조 일치 시 쓰기 1회, 거부·mismatch·unknown 시 0회', async () => {
  const mergeSha = 'c'.repeat(40);
  const cell: ChecklistItem = { id: 'CELL-GREEN', title: '셀 제목', status: 'yellow', updatedAt: '2026-10-23T00:00:00.000Z', updatedBy: 'test' };
  const cards: TaskCard[] = [{ id: 'TASK-20261023-01', text: '과제', checklistId: 'CELL-GREEN', checklistVersion: '0.2.36', createdAt: '2026-10-23T00:00:00.000Z', status: 'done', history: [], pr: 4242 }];
  const evidenceLine = `GREEN-FROM-LEDGER: PR #4242 merged ${mergeSha} · green · bound-card-merged`;
  const greenAction: NextAction = { ...action, kind: 'green', pr: 4242, checklistId: 'CELL-GREEN' };
  const probe = (cellEvidence: (cell: string) => Promise<string | undefined>) => ({
    pr: async () => ({ number: 4242, state: 'MERGED', mergeSha }),
    ancestor: async () => true,
    hold: async () => false,
    repositoryMatches: async () => true,
    cellEvidence,
  });
  const writeCalls = (f: ReturnType<typeof fake>) => f.calls.filter(c => c[0] === 'release' && c[1] === 'checklist');

  // (a) 판정 green ⊕ 원문 대조 일치 — 생산 진입점을 지나 checklist green 쓰기를 «1회»(카드 없음).
  const f = fake();
  f.deps.greenSweep = { probe: probe(async () => ''), item: cell, version: '0.2.36', cards };
  f.deps.greenWriteLive = true;
  expect(await executeNextAction(greenAction, f.deps)).toBe('done');
  expect(writeCalls(f)).toEqual([['release', 'checklist', 'set', 'CELL-GREEN', '--status', 'green', '--evidence', evidenceLine]]);
  expect(f.calls.some(c => c[0] === 'decisions')).toBe(false);
  expect(f.events).toEqual([
    { taskId: 'CELL-GREEN', kind: 'green', result: 'done', reason: evidenceLine },
    { taskId: 'TASK', kind: 'green', result: 'done', reason: evidenceLine },
  ]);

  // (b) 판정 거부(pr 관측 불가) — 쓰기 0회 · 명령 0회 · 칸 상태 불변(fail-closed).
  const refused = fake();
  refused.deps.greenSweep = { probe: { ...probe(async () => ''), pr: async () => null }, item: cell, version: '0.2.36', cards };
  refused.deps.greenWriteLive = true;
  expect(await executeNextAction(greenAction, refused.deps)).toBe('refused');
  expect(refused.calls).toHaveLength(0);
  expect(refused.events.at(-1)).toMatchObject({ taskId: 'TASK', kind: 'green', result: 'refused', reason: expect.stringContaining('pr-unreadable') });
  // The object assertion checks the fixture only; the zero command count above is the write-prevention evidence.
  expect(cell.status).toBe('yellow');

  // (c) 원문 대조 불일치(칸 원문이 판정 뒤 바뀜) — green 판정이어도 쓰기 0회 · 칸 상태 불변.
  const stale = fake();
  stale.deps.greenSweep = { probe: probe(async () => '판정 뒤 바뀐 칸 원문'), item: cell, version: '0.2.36', cards };
  stale.deps.greenWriteLive = true;
  expect(await executeNextAction(greenAction, stale.deps)).toBe('refused');
  expect(stale.calls).toHaveLength(0);
  expect(stale.events.at(-1)).toMatchObject({ taskId: 'TASK', kind: 'green', result: 'refused', reason: expect.stringContaining('원문 대조 불일치') });
  expect(cell.status).toBe('yellow');

  // (d) 칸 원문 unknown(재독 불가) — 모름을 일치로 꾸미지 않고 쓰기 0회.
  const unreadable = fake();
  unreadable.deps.greenSweep = { probe: probe(async () => undefined), item: cell, version: '0.2.36', cards };
  unreadable.deps.greenWriteLive = true;
  expect(await executeNextAction(greenAction, unreadable.deps)).toBe('refused');
  expect(unreadable.calls).toHaveLength(0);
  expect(unreadable.events.at(-1)).toMatchObject({ result: 'refused', reason: expect.stringContaining('원문 대조 불가') });

  // (e) 쓰기 명령 실패 — 명령 1회 시도 후 written false → 과제·green 실패로 센다(두 번이면 다음엔 카드).
  const broken = fake();
  broken.deps.failureCounts = {};
  broken.deps.greenSweep = { probe: probe(async () => ''), item: cell, version: '0.2.36', cards };
  broken.deps.greenWriteLive = true;
  const base = broken.deps.command;
  broken.deps.command = async args => {
    if (args[0] !== 'release') return base(args);
    broken.calls.push(args);
    return { status: 1, stdout: '', stderr: 'locked' };
  };
  expect(await executeNextAction(greenAction, broken.deps)).toBe('failed');
  expect(writeCalls(broken)).toHaveLength(1);
  expect(broken.deps.failureCounts[JSON.stringify(['TASK', 'green'])]).toBe(1);
  expect(broken.events.map((event) => (event as { result?: string }).result)).toEqual(['failed', 'failed']);

  // (f) 문맥 없는 green — 종전 그대로 검증 안내 카드(기존 검증 동작 유지 · 쓰기 0회).
  const unbound = fake();
  expect(await executeNextAction(greenAction, unbound.deps)).toBe('decision');
  expect(unbound.calls.map(c => c[0])).toEqual(['decisions']);
  expect(writeCalls(unbound)).toHaveLength(0);

  // (g) shadow도 green 판정을 관측하되 실제 checklist 쓰기는 하지 않는다.
  const shadow = fake();
  shadow.deps.mode = 'shadow';
  shadow.deps.greenSweep = { probe: probe(async () => ''), item: cell, version: '0.2.36', cards };
  expect(await executeNextAction(greenAction, shadow.deps)).toBe('would-green');
  expect(shadow.calls).toHaveLength(0);
  expect(shadow.events.at(-1)).toMatchObject({ taskId: 'TASK', kind: 'green', result: 'would-green', reason: expect.stringContaining('live write disabled') });
});

