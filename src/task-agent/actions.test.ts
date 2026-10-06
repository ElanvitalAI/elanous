import { expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerAutopilotCommands } from '../cli/autopilot-cli.js';
import { executeNextAction, type ActionDeps, type NextAction } from './actions.js';

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
  registerAutopilotCommands(program);
  const output: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((text: string) => { output.push(text); return true; }) as typeof process.stdout.write;
  try {
    await program.parseAsync(['autopilot', 'task-agent-action', JSON.stringify(action)], { from: 'user' });
    expect(output).toContain('shadow\n');
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

