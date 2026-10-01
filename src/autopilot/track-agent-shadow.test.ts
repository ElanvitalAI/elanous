import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideShadowTrackAction, launchTrackAgentShadow, shadowLedgerPath, type ShadowOptions } from './track-agent-shadow.js';
import { decideTrackAction, executeTrackAction } from './track-agent.js';

const input = { missionId: 'apm_test', taskId: 'task:test', title: '티저 제작', prompt: '영상 티저', track: 'T' };
const at = (date: string): (() => Date) => () => new Date(date);

function withLedger(run: (options: ShadowOptions) => Promise<void>): Promise<void> {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'track-shadow-'));
  return run({ ledgerDir, now: at('2026-10-01T14:59:00Z'), maxDecisionsPerDay: 2 })
    .finally(() => rmSync(ledgerDir, { recursive: true, force: true }));
}

const entries = (options: ShadowOptions) => readFileSync(shadowLedgerPath(options), 'utf8').trim().split('\n').map((row) => JSON.parse(row));

describe('track agent shadow ledger', () => {
  test('KST date keys the JSONL ledger and a new KST day gets its own quota', () => withLedger(async (options) => {
    expect(shadowLedgerPath(options)).toEndWith('2026-10-01.jsonl');
    expect(shadowLedgerPath({ ...options, now: at('2026-10-01T15:00:00Z') })).toEndWith('2026-10-02.jsonl');
    let calls = 0;
    const decide = () => { calls++; return { action: 'say' as const }; };
    await decideShadowTrackAction(input, decide, options);
    await decideShadowTrackAction(input, decide, options);
    expect(await decideShadowTrackAction(input, decide, options)).toEqual({ action: 'hold', reason: '일일 판정 상한' });
    expect(calls).toBe(2);
    expect(entries(options).map((entry) => entry.event)).toEqual(['decision-started', 'decision', 'decision-started', 'decision']);
    await decideShadowTrackAction(input, decide, { ...options, now: at('2026-10-01T15:00:00Z') });
    expect(calls).toBe(3);
  }));

  test('zero daily quota holds without invoking the decision callback', () => withLedger(async (options) => {
    let called = false;
    const decision = await decideShadowTrackAction(input, () => { called = true; return { action: 'say' }; },
      { ...options, maxDecisionsPerDay: 0 });
    expect(decision).toEqual({ action: 'hold', reason: '일일 판정 상한' });
    expect(called).toBe(false);
  }));

  test('production decision path enforces cap before session and agent callback', () => withLedger(async (options) => {
    let calls = 0;
    let sessions = 0;
    const deps = { shadow: true, shadowOptions: { ...options, maxDecisionsPerDay: 1 },
      session: () => { sessions++; return 'sess_test'; },
      run: async () => { calls++; return { stdout: JSON.stringify({ reply: '{"action":"say"}' }) }; } };
    expect((await decideTrackAction(input, deps)).action).toBe('say');
    expect(await decideTrackAction(input, deps)).toEqual({ action: 'hold', reason: '일일 판정 상한' });
    expect(calls).toBe(1);
    expect(sessions).toBe(1);
    expect(entries(options).map((entry) => entry.event)).toEqual(['decision-started', 'decision']);
  }));

  test('production execution path applies ordinary gates then runs shadow orchestrate', () => withLedger(async (options) => {
    const argv: string[][] = [];
    const deps = { shadow: true, shadowOptions: { ...options, orchestrate: async (args: string[]) => {
      argv.push(args);
      return { stdout: JSON.stringify([{ status: 'done', worktreePath: '/tmp/shadow-worktree' }]) };
    } }, checkBudget: async () => true, launch: async () => { throw new Error('normal launch must not run'); } };
    expect(await executeTrackAction({ action: 'say' }, input, deps)).toEqual({ status: 'launched', detail: '/tmp/shadow-worktree' });
    expect(argv).toHaveLength(1);
    expect(argv[0]).not.toContain('--auto-merge');
    expect(entries(options).at(-1)).toMatchObject({ event: 'orchestrate', workdir: '/tmp/shadow-worktree' });
    expect((await executeTrackAction({ action: 'say' }, { ...input, prompt: 'deploy the site' }, deps)).status).toBe('held');
    expect((await executeTrackAction({ action: 'say' }, input, { ...deps, checkBudget: async () => false })).status).toBe('held');
    expect(argv).toHaveLength(1);
  }));

  test('reservation counts before a pending callback finishes', () => withLedger(async (options) => {
    const one = { ...options, maxDecisionsPerDay: 1 };
    let finish!: (value: { action: 'say' }) => void;
    const pending = new Promise<{ action: 'say' }>((resolve) => { finish = resolve; });
    const first = decideShadowTrackAction(input, () => pending, one);
    let called = false;
    expect(await decideShadowTrackAction(input, () => { called = true; return { action: 'say' }; }, one))
      .toMatchObject({ action: 'hold' });
    expect(called).toBe(false);
    finish({ action: 'say' });
    expect((await first).action).toBe('say');
  }));

  test('unreadable or corrupt ledger holds without a callback', () => withLedger(async (options) => {
    writeFileSync(shadowLedgerPath(options), 'not-json\n');
    let called = false;
    const decision = await decideShadowTrackAction(input, () => { called = true; return { action: 'say' }; }, options);
    expect(decision.action).toBe('hold');
    expect(called).toBe(false);
  }));

  test('contested ledger reservation holds before invoking the callback', () => withLedger(async (options) => {
    mkdirSync(`${shadowLedgerPath(options)}.lock`);
    let called = false;
    const decision = await decideShadowTrackAction(input, () => { called = true; return { action: 'say' }; }, options);
    expect(decision.action).toBe('hold');
    expect(called).toBe(false);
  }));

  test('unavailable ledger blocks orchestrate before any work can start', () => withLedger(async (options) => {
    for (const blockedPath of ['parent', 'ledger'] as const) {
      const ledgerDir = join(options.ledgerDir!, blockedPath);
      if (blockedPath === 'parent') writeFileSync(ledgerDir, 'not a directory');
      else {
        mkdirSync(ledgerDir);
        mkdirSync(shadowLedgerPath({ ...options, ledgerDir }));
      }
      let calls = 0;
      const result = await launchTrackAgentShadow(input, { ...options, ledgerDir, orchestrate: async () => {
        calls++;
        return { stdout: JSON.stringify([{ status: 'done', worktreePath: '/tmp/unrecorded' }]) };
      } });
      expect(result).toEqual({ status: 'failed', detail: 'shadow 원장 기록 실패' });
      expect(calls).toBe(0);
    }
  }));

  test('eligible work invokes self orchestrate with no auto merge and records observed workdir', () => withLedger(async (options) => {
    let argv: string[] = [];
    const result = await launchTrackAgentShadow(input, { ...options, orchestrate: async (args) => {
      expect(entries(options).map((entry) => entry.event)).toEqual(['orchestrate-started']);
      argv = args;
      return { stdout: JSON.stringify([{ status: 'done', worktreePath: '/tmp/shadow-worktree' }]) };
    } });
    expect(argv.slice(0, 3)).toEqual(['self', 'orchestrate', '--json']);
    expect(argv.join(' ')).not.toContain('--auto-merge');
    expect(argv.at(-1)).toContain(input.prompt);
    expect(result).toEqual({ status: 'launched', detail: '/tmp/shadow-worktree' });
    expect(entries(options).map((entry) => entry.event)).toEqual(['orchestrate-started', 'orchestrate']);
    expect(entries(options).at(-1)).toMatchObject({ event: 'orchestrate', status: 'launched', workdir: '/tmp/shadow-worktree', taskId: input.taskId });
  }));

  test('all orchestrate results must succeed and every workdir remains in the ledger', () => withLedger(async (options) => {
    const stdout = JSON.stringify({ results: [
      { status: 'done', worktreePath: '/tmp/first-worktree' },
      { status: 'failed', workdir: '/tmp/second-worktree' },
    ] });
    const result = await launchTrackAgentShadow(input, { ...options, orchestrate: async () => ({ stdout }) });
    expect(result.status).toBe('failed');
    expect(entries(options).at(-1)).toMatchObject({
      event: 'orchestrate', status: 'failed', workdir: '/tmp/first-worktree',
      workdirs: ['/tmp/first-worktree', '/tmp/second-worktree'],
    });
    const success = await launchTrackAgentShadow(input, { ...options, orchestrate: async () => ({ stdout: JSON.stringify([
      { status: 'done', worktreePath: '/tmp/first-worktree' },
      { status: 'done', workdir: '/tmp/second-worktree' },
    ]) }) });
    expect(success).toEqual({ status: 'launched', detail: '/tmp/first-worktree, /tmp/second-worktree' });
    expect(entries(options).at(-1)).toMatchObject({
      status: 'launched', workdirs: ['/tmp/first-worktree', '/tmp/second-worktree'],
    });
  }));

  test('missing workdir in one result remains distinct from later observed workdir', () => withLedger(async (options) => {
    const result = await launchTrackAgentShadow(input, { ...options,
      orchestrate: async () => ({ stdout: JSON.stringify([
        { status: 'done' }, { status: 'done', worktreePath: '/tmp/later-worktree' },
      ]) }),
    });
    expect(result.status).toBe('failed');
    expect(entries(options).at(-1)).toMatchObject({
      status: 'failed', workdir: null, workdirs: [null, '/tmp/later-worktree'],
    });
  }));

  test('nonzero multi-result output preserves all observed workdirs and never claims launch', () => withLedger(async (options) => {
    const result = await launchTrackAgentShadow(input, { ...options, orchestrate: async () => {
      throw Object.assign(new Error('exit 1'), { stdout: JSON.stringify([
        { status: 'done', worktreePath: '/tmp/first-worktree' },
        { status: 'failed', worktreePath: '/tmp/second-worktree' },
      ]) });
    } });
    expect(result.status).toBe('failed');
    expect(entries(options).at(-1)).toMatchObject({
      status: 'failed', workdirs: ['/tmp/first-worktree', '/tmp/second-worktree'],
    });
  }));

  test('a failed orchestrate attempt records unknown workdir rather than inventing one', () => withLedger(async (options) => {
    const result = await launchTrackAgentShadow(input, { ...options, orchestrate: async () => { throw new Error('offline'); } });
    expect(result.status).toBe('failed');
    expect(entries(options).at(-1)).toMatchObject({ event: 'orchestrate', status: 'failed', workdir: null });
  }));

  test('an incomplete result does not claim launch success even if it reports a workdir', () => withLedger(async (options) => {
    const result = await launchTrackAgentShadow(input, { ...options,
      orchestrate: async () => ({ stdout: JSON.stringify([{ status: 'failed', worktreePath: '/tmp/failed-shadow' }]) }),
    });
    expect(result.status).toBe('failed');
    expect(entries(options).at(-1)).toMatchObject({ status: 'failed', workdir: '/tmp/failed-shadow' });
  }));

  test('nonzero subprocess exit still records the workdir from JSON stdout', () => withLedger(async (options) => {
    const result = await launchTrackAgentShadow(input, { ...options,
      orchestrate: async () => { throw Object.assign(new Error('exit 1'), {
        stdout: JSON.stringify([{ status: 'failed', worktreePath: '/tmp/failed-run' }]),
      }); },
    });
    expect(result.status).toBe('failed');
    expect(entries(options).at(-1)).toMatchObject({ status: 'failed', workdir: '/tmp/failed-run' });
  }));

  test('completed result without an observed workdir stays failed, not invented', () => withLedger(async (options) => {
    const result = await launchTrackAgentShadow(input, { ...options,
      orchestrate: async () => ({ stdout: JSON.stringify([{ status: 'done' }]) }),
    });
    expect(result.status).toBe('failed');
    expect(entries(options).at(-1)).toMatchObject({ status: 'failed', workdir: null });
  }));
});
