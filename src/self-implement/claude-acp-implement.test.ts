import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AcpAgent, type AcpAgentOpts } from '../acp/client.js';
import { getProviderForConfig } from '../llm.js';
import { defaultSeams } from './seams.js';
import { CLAUDE_ACP_IMPLEMENT_CAP_DEFAULT, claudeAcpImplementCap, isClaudeAcpChild, runClaudeAcpImplement } from './claude-acp-implement.js';

// CLAUDE-IMPL-LANE (10-11) — `--child-llm-provider claude-acp` must run the subscription ACP implementer and never
//   the Anthropic API provider. The first harness attempt (#26277) built the implementer with no production caller,
//   so the child resolved claude-acp to anthropic(API key). These tests bite the real lane path.

const BILLING_ENV = {
  PATH: '/bin', NODE_ENV: 'test',
  ANTHROPIC_API_KEY: 'sk-ant-should-never-reach-the-child',
  ANTHROPIC_AUTH_TOKEN: 'token-should-never-reach-the-child',
};
const STATUS_JSON = (used: number) => JSON.stringify({
  currentAccount: 'a1',
  accounts: [{ name: 'a1', type: 'oauth', status: 'active', disabled: false, quota: { unified5h: used / 100, unified7d: used / 100 } }],
});

/** teamclaude stub: subscribed oauth account at `used`% and a proxy base URL. */
function teamclaude(used: number, opts: { proxy?: boolean } = {}) {
  return {
    runStatus: (_command: string, args: string[]) => (args[0] === 'env'
      ? { status: opts.proxy === false ? 1 : 0, stdout: opts.proxy === false ? '' : 'export ANTHROPIC_BASE_URL=http://localhost:3456\n' }
      : args.includes('--json') ? { status: 0, stdout: STATUS_JSON(used) } : { status: 1, stdout: '' }),
  };
}

function fakeAgent(seen: { opts?: AcpAgentOpts }) {
  return (opts: AcpAgentOpts) => {
    seen.opts = opts;
    const agent = Object.create(AcpAgent.prototype) as AcpAgent;
    Object.assign(agent, {
      start: async () => {}, newSession: async () => 'session-1', selectSessionModel: async () => {},
      prompt: async () => ({ stopReason: 'end_turn' }), cancel: async () => {}, stop: async () => {},
    });
    return agent;
  };
}

describe('claude-acp implement lane', () => {
  test('a subscribed account under the cap runs the ACP implementer at the worktree with billing keys removed', async () => {
    const seen: { opts?: AcpAgentOpts } = {};
    const outcome = await runClaudeAcpImplement({
      cwd: '/tmp/run-worktree', prompt: 'implement', env: BILLING_ENV,
      availabilityDeps: teamclaude(40), createAgent: fakeAgent(seen),
    });
    expect(outcome.kind).toBe('ran');
    expect(seen.opts?.cwd).toBe('/tmp/run-worktree');
    expect(seen.opts?.backendSpec?.command).toBe('claude-agent-acp');
    expect(seen.opts?.env?.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.opts?.env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(seen.opts?.env?.ANTHROPIC_BASE_URL).toBe('http://localhost:3456');
  });

  test('usage at or over the cap refuses without spawning any agent', async () => {
    const seen: { opts?: AcpAgentOpts } = {};
    const outcome = await runClaudeAcpImplement({
      cwd: '/tmp/run-worktree', prompt: 'implement', env: BILLING_ENV,
      availabilityDeps: teamclaude(CLAUDE_ACP_IMPLEMENT_CAP_DEFAULT), createAgent: fakeAgent(seen),
    });
    expect(outcome.kind).toBe('refused');
    expect(seen.opts).toBeUndefined();
  });

  test('a failed subscription probe or a missing proxy refuses (fail-closed)', async () => {
    for (const deps of [
      { runStatus: () => ({ status: 1, stdout: '' }) },
      teamclaude(10, { proxy: false }),
    ]) {
      const seen: { opts?: AcpAgentOpts } = {};
      const outcome = await runClaudeAcpImplement({ cwd: '/tmp/w', prompt: 'p', env: BILLING_ENV, availabilityDeps: deps, createAgent: fakeAgent(seen) });
      expect(outcome.kind).toBe('refused');
      expect(seen.opts).toBeUndefined();
    }
  });

  test('the cap defaults to 85 and an invalid override never raises it', () => {
    expect(claudeAcpImplementCap({})).toBe(85);
    expect(claudeAcpImplementCap({ ELANOUS_CLAUDE_ACP_CAP: '70' })).toBe(70);
    expect(claudeAcpImplementCap({ ELANOUS_CLAUDE_ACP_CAP: '150' })).toBe(85);
    expect(claudeAcpImplementCap({ ELANOUS_CLAUDE_ACP_CAP: 'x' })).toBe(85);
  });

  test('claude-acp never resolves to an LLM provider (no Anthropic API fallback)', () => {
    expect(() => getProviderForConfig({ llm: { provider: 'claude-acp', model: 'claude-opus-5-5' } } as never))
      .toThrow(/claude-acp/);
  });
});

describe('implement seam routes claude-acp to the subscription lane', () => {
  test('a claude-acp child never reaches the PTY child (getProvider path)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-claude-acp-'));
    let ptyCalls = 0;
    let laneCalls = 0;
    try {
      const seams = defaultSeams({
        ptyAvailable: () => true,
        runHeadlessGoalLoopPty: async () => { ptyCalls++; return { ok: true, reachedCompletion: true, transcript: '', toolCalls: 0, timedOut: false, exitReason: 'child-exit', exitCode: 0, ptyId: 'pty' }; },
        runClaudeAcpImplement: async () => { laneCalls++; return { kind: 'refused', reason: 'Claude subscription usage unavailable or at harness cap (85%)' }; },
      });
      const result = await seams.implement({ cwd, feature: 'x', runId: 'run-claude-acp', childLlm: { provider: 'claude-acp', model: 'claude-opus-5-5', source: 'flag' } as never });
      expect(laneCalls).toBe(1);
      expect(ptyCalls).toBe(0);
      expect(result.ok).toBe(false);
      expect(result.summary).toContain('claude-acp 구현 레인 거부');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('other providers still go through the PTY child unchanged', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'seam-other-'));
    let ptyCalls = 0;
    let laneCalls = 0;
    try {
      const seams = defaultSeams({
        ptyAvailable: () => true,
        runHeadlessGoalLoopPty: async () => { ptyCalls++; return { ok: true, reachedCompletion: true, transcript: '', toolCalls: 0, timedOut: false, exitReason: 'child-exit', exitCode: 0, ptyId: 'pty' }; },
        runClaudeAcpImplement: async () => { laneCalls++; return { kind: 'refused', reason: 'n/a' }; },
      });
      await seams.implement({ cwd, feature: 'x', runId: 'run-other', childLlm: { provider: 'openrouter', model: 'z-ai/glm-5.3', source: 'flag' } as never });
      expect(ptyCalls).toBe(1);
      expect(laneCalls).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('isClaudeAcpChild only matches claude-acp', () => {
    expect(isClaudeAcpChild({ provider: 'claude-acp' })).toBe(true);
    expect(isClaudeAcpChild({ provider: ' Claude-ACP ' })).toBe(true);
    expect(isClaudeAcpChild({ provider: 'anthropic' })).toBe(false);
    expect(isClaudeAcpChild(undefined)).toBe(false);
  });
});

