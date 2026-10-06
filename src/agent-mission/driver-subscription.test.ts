import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asideBackend, claudeBackend, codexBackend, geminiBackend, grokBackend, runAgentMission, type AgentBackend } from './driver.js';
import { debug } from '../debug/log.js';
import type { PtyHandle } from '../pty-shell/registry.js';
import type { ClaudeSubscriptionStatus } from './claude-subscription.js';

const evidence = { kind: 'doc' as const, dirRel: 'docs', glob: /^not-created\.md$/ };

async function probe(backend: AgentBackend, status: ClaudeSubscriptionStatus) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-mission-claude-auth-'));
  const events: Array<{ category: string; event: string; data: unknown }> = [];
  const originalLog = debug.log;
  const oldApiKey = process.env.ANTHROPIC_API_KEY;
  const oldFoundry = process.env.CLAUDE_CODE_USE_FOUNDRY;
  process.env.ANTHROPIC_API_KEY = 'test-secret';
  process.env.CLAUDE_CODE_USE_FOUNDRY = '1';
  let checked = 0;
  let created = 0;
  let recorded = 0;
  let spawned = 0;
  let spawnEnv: Record<string, string> | undefined;
  debug.log = ((category: string, event: string, data: unknown) => {
    events.push({ category, event, data });
  }) as typeof debug.log;
  try {
    const result = await runAgentMission({ mission: 'done', repo: dir, branch: 'fixture', agent: backend,
      evidence, memory: false, commit: false, screensDir: join(dir, 'screens'),
    }, {
      createWorktree: (() => { created++; return { path: dir, branch: 'fixture', base: 'HEAD' }; }) as never,
      recordWorktreeProvenance: () => { recorded++; },
      checkClaudeSubscription: ({ env }) => {
        checked++;
        expect(created).toBe(0);
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
        expect(env.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined();
        return status;
      },
      startPty: ((opts) => {
        spawned++;
        spawnEnv = opts.env;
        return { id: opts.id, kind: backend.name, nickname: 'fixture', accessMode: 'auto',
          isAlive: () => false, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'ready',
          renderScreenPng: async () => null, write: () => {}, kill: () => {},
        } as unknown as PtyHandle;
      }),
      resolvePtyWebAddress: (() => ({ webUrl: null, webUrlSource: null })) as never,
      runControlLoop: (async () => ({ termination: { kind: 'success' }, steps: 1 })) as never,
    });
    return { result, events, checked, created, recorded, spawned, spawnEnv };
  } finally {
    debug.log = originalLog;
    if (oldApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = oldApiKey;
    if (oldFoundry === undefined) delete process.env.CLAUDE_CODE_USE_FOUNDRY;
    else process.env.CLAUDE_CODE_USE_FOUNDRY = oldFoundry;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('runAgentMission Claude subscription gate', () => {
  test.each([
    { reason: 'logged-out' as const, authMethod: null, apiProvider: null, action: 'claude login' },
    { reason: 'api-key' as const, authMethod: 'api_key', apiProvider: 'firstParty', action: 'claude login' },
    { reason: 'timeout' as const, authMethod: null, apiProvider: null, action: 'claude auth status --json' },
    { reason: 'auth-status-failed' as const, authMethod: null, apiProvider: null, action: 'claude auth status --json' },
  ])('rejects $reason before creating a worktree or spawning, with actionable detail and only allowed status fields logged', async ({ reason, authMethod, apiProvider, action }) => {
    const status = { ok: false, reason, authMethod, apiProvider };
    const { result, events, checked, created, recorded, spawned } = await probe(claudeBackend, status);
    expect(checked).toBe(1);
    expect(created).toBe(0);
    expect(recorded).toBe(0);
    expect(spawned).toBe(0);
    expect(result).toMatchObject({ ok: false, worktree: '', branch: 'fixture', rounds: 0, evidencePath: null, committed: false, usedOmniCrawl: false });
    expect(result.detail).toContain(action);
    expect(result.detail).toContain(reason);
    expect(events.filter(({ category }) => category === 'agent-mission.claude-subscription')).toEqual([
      { category: 'agent-mission.claude-subscription', event: 'status', data: status },
    ]);
  });

  test('Claude PTY caller passes strict MCP args while the fake child is alive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mcp-pty-'));
    let alive = true;
    let configPath = '';
    try {
      await runAgentMission({ mission: 'done', repo: dir, branch: 'fixture', agent: claudeBackend,
        evidence, memory: false, commit: false, screensDir: join(dir, 'screens'),
      }, {
        createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
        recordWorktreeProvenance: () => {},
        checkClaudeSubscription: () => ({ ok: true, reason: 'subscription', authMethod: 'claude.ai', apiProvider: 'firstParty' }),
        startPty: ((opts) => {
          const args = opts.args ?? [];
          expect(args).toContain('--strict-mcp-config');
          configPath = args[args.indexOf('--mcp-config') + 1]!;
          expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ mcpServers: {} });
          return { id: opts.id, kind: 'claude', nickname: 'fixture', accessMode: 'auto',
            isAlive: () => alive, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'ready',
            renderScreenPng: async () => null, write: () => {}, kill: () => { alive = false; },
          } as unknown as PtyHandle;
        }),
        resolvePtyWebAddress: (() => ({ webUrl: null, webUrlSource: null })) as never,
        runControlLoop: (async () => { alive = false; return { termination: { kind: 'success' }, steps: 1 }; }) as never,
      });
      expect(configPath).toBeTruthy();
      expect(existsSync(configPath)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('an explicit depth-0 allow from the caller keeps Claude argv without MCP restriction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mcp-allow-'));
    let args: string[] = [];
    const previousDepth = process.env.ELANOUS_NESTED_DEPTH;
    delete process.env.ELANOUS_NESTED_DEPTH;
    try {
      await runAgentMission({ mission: 'done', repo: dir, branch: 'fixture', agent: claudeBackend, nestedElanousAllow: true,
        evidence, memory: false, commit: false, screensDir: join(dir, 'screens'),
      }, {
        createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
        recordWorktreeProvenance: () => {},
        checkClaudeSubscription: () => ({ ok: true, reason: 'subscription', authMethod: 'claude.ai', apiProvider: 'firstParty' }),
        startPty: ((opts) => {
          args = [...(opts.args ?? [])];
          return { id: opts.id, kind: 'claude', nickname: 'fixture', accessMode: 'auto',
            isAlive: () => false, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'ready',
            renderScreenPng: async () => null, write: () => {}, kill: () => {},
          } as unknown as PtyHandle;
        }),
        resolvePtyWebAddress: (() => ({ webUrl: null, webUrlSource: null })) as never,
        runControlLoop: (async () => ({ termination: { kind: 'success' }, steps: 1 })) as never,
      });
      expect(args.length).toBeGreaterThan(0);
      expect(args).not.toContain('--strict-mcp-config');
      expect(args).not.toContain('--mcp-config');
    } finally {
      if (previousDepth === undefined) delete process.env.ELANOUS_NESTED_DEPTH; else process.env.ELANOUS_NESTED_DEPTH = previousDepth;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an aborted mission removes the Claude MCP config even while the PTY is still alive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-mcp-abort-'));
    const controller = new AbortController();
    let configPath = '';
    try {
      await runAgentMission({ mission: 'done', repo: dir, branch: 'fixture', agent: claudeBackend,
        evidence, memory: false, commit: false, screensDir: join(dir, 'screens'), signal: controller.signal,
      }, {
        createWorktree: (() => ({ path: dir, branch: 'fixture', base: 'HEAD' })) as never,
        recordWorktreeProvenance: () => {},
        checkClaudeSubscription: () => ({ ok: true, reason: 'subscription', authMethod: 'claude.ai', apiProvider: 'firstParty' }),
        terminateProcessTree: (async () => []) as never,
        startPty: ((opts) => {
          const args = opts.args ?? [];
          configPath = args[args.indexOf('--mcp-config') + 1]!;
          // kill() is ignored: the child stays alive through the abort.
          return { id: opts.id, kind: 'claude', nickname: 'fixture', accessMode: 'auto',
            isAlive: () => true, canWrite: () => true, drainDelta: () => '', renderScreen: async () => 'ready',
            renderScreenPng: async () => null, write: () => {}, kill: () => {},
          } as unknown as PtyHandle;
        }),
        resolvePtyWebAddress: (() => ({ webUrl: null, webUrlSource: null })) as never,
        runControlLoop: (async () => {
          expect(existsSync(configPath)).toBe(true);
          controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { termination: { kind: 'success' }, steps: 1 };
        }) as never,
      }).then(
        (result) => { expect(result.ok).toBe(false); },
        (error: unknown) => { expect(String(error)).toContain('MISSION_ABORTED'); },
      );
      expect(configPath).toBeTruthy();
      expect(existsSync(configPath)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('subscription passes the gate and spawns with billing routes removed', async () => {
    const status = { ok: true, reason: 'subscription' as const, authMethod: 'claude.ai', apiProvider: 'firstParty' };
    const { events, result, checked, created, recorded, spawned, spawnEnv } = await probe(claudeBackend, status);
    expect(checked).toBe(1);
    expect(created).toBe(1);
    expect(recorded).toBe(1);
    expect(spawned).toBe(1);
    expect(result.worktree).toBeTruthy();
    expect(result.ptyId).toBeTruthy();
    expect(spawnEnv?.CLAUDE_CODE_USE_FOUNDRY).toBeUndefined();
    expect(spawnEnv?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(events.filter(({ category }) => category === 'agent-mission.claude-subscription')).toEqual([
      { category: 'agent-mission.claude-subscription', event: 'status', data: status },
    ]);
  });

  test.each([codexBackend, geminiBackend, grokBackend, asideBackend])('$name is not gated by Claude authentication', async (backend) => {
    const { checked, created, recorded, spawned } = await probe(backend, { ok: false, reason: 'logged-out', authMethod: null, apiProvider: null });
    expect(checked).toBe(0);
    expect(created).toBe(1);
    expect(recorded).toBe(1);
    expect(spawned).toBe(1);
  });
});
