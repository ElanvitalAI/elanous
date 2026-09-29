import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeBackend, codexBackend, runAgentMission } from './driver.js';
import type { ClaudeHeadlessResult } from './claude-headless.js';

const success: ClaudeHeadlessResult = {
  ok: true, reason: 'success', exitCode: 0, result: 'done', subtype: 'success', sessionId: 'session-1',
  isError: false, numTurns: 2, durationMs: 100, durationApiMs: 80, totalCostUsd: 0,
  usage: {}, toolEvents: 1, malformedLines: 0,
};

async function execute(result: ClaudeHeadlessResult, options: { evidence?: 'present' | 'absent'; commit?: boolean; maxRounds?: number; commitResult?: { ok: boolean; out: string } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mission-headless-'));
  mkdirSync(join(dir, 'docs'));
  if (options.evidence !== 'absent') writeFileSync(join(dir, 'docs', 'PLAN-new.md'), 'new');
  const calls: string[] = [];
  let received: { cwd: string; prompt: string; env: NodeJS.ProcessEnv; maxTurns?: number } | undefined;
  try {
    const missionResult = await runAgentMission({
      mission: 'verbatim\nmission', repo: dir, branch: 'fixture', agent: claudeBackend, headless: true,
      evidence: { kind: 'doc', dirRel: 'docs', glob: /^PLAN-new\.md$/ },
      entry: 'external-verbatim', memory: false, commit: options.commit, maxRounds: options.maxRounds,
      screensDir: join(dir, 'screens'),
    }, {
      createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
      recordWorktreeProvenance: () => {},
      checkClaudeSubscription: ({ env }) => {
        calls.push('auth');
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        return { ok: true, reason: 'subscription', authMethod: 'claude.ai', apiProvider: 'firstParty' };
      },
      startPty: (() => { throw new Error('PTY must not start'); }) as never,
      runClaudeHeadless: async (args) => { calls.push('headless'); received = args; return result; },
      checkEvidence: (_path, ev) => {
        calls.push('evidence');
        expect(ev.kind).toBe('doc');
        return options.evidence === 'absent'
          ? { ok: false, path: null, retry: 'missing' }
          : { ok: true, path: join(dir, 'docs', 'PLAN-new.md') };
      },
      commitWorktree: () => { calls.push('commit'); return options.commitResult ?? { ok: true, out: 'committed' }; },
    });
    return { missionResult, calls, received, dir };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('runAgentMission Claude headless execution', () => {
  test('subscription gates headless, stdin prompt is verbatim, evidence passes before commit; no PTY is spawned', async () => {
    const { missionResult, calls, received, dir } = await execute(success);
    expect(calls).toEqual(['auth', 'headless', 'evidence', 'commit']);
    expect(received?.cwd).toBe(dir);
    expect(received?.prompt).toBe('verbatim\nmission');
    expect(received?.maxTurns).toBe(16);
    expect(received?.env.ELANOUS_RUN_ID).toBeTruthy();
    expect(missionResult).toMatchObject({ ok: true, rounds: 2, evidencePath: join(dir, 'docs', 'PLAN-new.md'), committed: true, usedOmniCrawl: false });
    expect(missionResult.ptyId).toBeUndefined();
  });

  test('explicit maxRounds reaches headless CLI as maxTurns', async () => {
    const { received } = await execute(success, { maxRounds: 3, commit: false });
    expect(received?.maxTurns).toBe(3);
  });

  test('failed subscription never reaches headless spawn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mission-headless-denied-'));
    try {
      const result = await runAgentMission({ mission: 'M', repo: dir, branch: 'fixture', agent: claudeBackend,
        headless: true, evidence: { kind: 'doc', dirRel: 'docs', glob: /PLAN/ }, memory: false,
      }, {
        createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
        recordWorktreeProvenance: () => {},
        checkClaudeSubscription: () => ({ ok: false, reason: 'logged-out', authMethod: null, apiProvider: null }),
        runClaudeHeadless: async () => { throw new Error('must not spawn'); },
      });
      expect(result).toMatchObject({ ok: false, committed: false, rounds: 0 });
      expect(result.detail).toContain('claude login');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('headless CLI failures and missing evidence never commit', async () => {
    const failure = await execute({ ...success, ok: false, reason: 'no-result' });
    expect(failure.calls).toEqual(['auth', 'headless']);
    expect(failure.missionResult).toMatchObject({ ok: false, evidencePath: null, committed: false });
    expect(failure.missionResult.detail).toContain('no-result');
    const missing = await execute(success, { evidence: 'absent' });
    expect(missing.calls).toEqual(['auth', 'headless', 'evidence']);
    expect(missing.missionResult).toMatchObject({ ok: false, evidencePath: null, committed: false });
    expect(missing.missionResult.detail).toContain('missing');
  });

  test('requested automatic commit failure does not report mission success', async () => {
    const { calls, missionResult, dir } = await execute(success, { commitResult: { ok: false, out: 'git commit failed' } });
    expect(calls).toEqual(['auth', 'headless', 'evidence', 'commit']);
    expect(missionResult).toMatchObject({ ok: false, committed: false, rounds: 2,
      evidencePath: join(dir, 'docs', 'PLAN-new.md') });
    expect(missionResult.detail).toContain('자동 커밋 실패');
    expect(missionResult.detail).not.toContain('완료(증거 충족)');
  });

  test('--no-commit retains successful evidence without committing', async () => {
    const { calls, missionResult } = await execute(success, { commit: false });
    expect(calls).toEqual(['auth', 'headless', 'evidence']);
    expect(missionResult).toMatchObject({ ok: true, committed: false });
  });

  test('without --headless, Claude retains the PTY mission path after subscription gating', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mission-claude-pty-'));
    let started = 0;
    try {
      const result = await runAgentMission({ mission: 'M', repo: dir, branch: 'fixture', agent: claudeBackend,
        evidence: { kind: 'doc', dirRel: 'docs', glob: /PLAN/ }, memory: false, commit: false,
        screensDir: join(dir, 'screens'),
      }, {
        createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
        recordWorktreeProvenance: () => {},
        checkClaudeSubscription: () => ({ ok: true, reason: 'subscription', authMethod: 'claude.ai', apiProvider: 'firstParty' }),
        runClaudeHeadless: async () => { throw new Error('headless must not start'); },
        startPty: ((opts: { id?: string }) => {
          started++;
          return { id: opts.id!, kind: 'claude', nickname: 'fixture', accessMode: 'auto',
            isAlive: () => false, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'ready',
            renderScreenPng: async () => null, write: () => {}, kill: () => {},
          };
        }) as never,
        resolvePtyWebAddress: (() => ({ webUrl: null, webUrlSource: null })) as never,
        runControlLoop: (async () => ({ termination: { kind: 'success' }, steps: 1 })) as never,
      });
      expect(started).toBe(1);
      expect(result.ptyId).toBeTruthy();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('rejects headless for non-Claude backend before creating a worktree', async () => {
    await expect(runAgentMission({ mission: 'M', branch: 'fixture', agent: codexBackend, headless: true,
      evidence: { kind: 'tsc' },
    }, { createWorktree: (() => { throw new Error('must not create worktree'); }) as never }))
      .rejects.toThrow('--headless 는 --backend claude 전용입니다');
  });
});
