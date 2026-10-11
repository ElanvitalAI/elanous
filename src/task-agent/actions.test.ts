import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerAutopilotCommands } from '../cli/autopilot-cli.js';
import { executeNextAction, failureKey, readDeliveryEvidence, type ActionDeps, type NextAction } from './actions.js';
import { judgeNextMove, LIVE_RETRY_MOVES, retryMoveOf, SAME_MOVE_FAILURE_LIMIT } from './judge.js';
import { resolveTaskAgentLiveMoves } from './live-moves.js';

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
  const cap = fake();
  cap.deps.landingsToday = 5;
  cap.deps.landingDay = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  await executeNextAction({ ...action, kind: 'land' }, cap.deps);
  expect(cap.calls.map(c => c.slice(0, 2))).toEqual([['gh', 'pr'], ['decisions', 'raise']]);
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

