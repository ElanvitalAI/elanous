import { describe, expect, spyOn, test } from 'bun:test';
import { globalDualRoleManager } from '../acp/dual-role-manager.js';
import { ClaudeSubscriptionNotAllowedError } from '../policy/claude-subscription-guard.js';
import {
  acpPlanThenExecuteRuntime,
  acpSessionCreateRuntime,
  acpSessionResumeRuntime,
  acpSessionSendRuntime,
  acpSessionSpawnSubRuntime,
  acpSessionStartBackgroundRuntime,
} from './acp-session-runtime.js';

describe('ACP session subscription boundary', () => {
  test('external-agent claude returns a tool error before starting a connection; owner claude starts one', async () => {
    const manager = globalDualRoleManager();
    const start = spyOn(manager, 'clientSessionCreate').mockImplementation(async (opts) => ({
      id: 'acp-cli:claude:fake', backendId: opts.backendId, backendSessionId: 'fake',
      cwd: opts.cwd ?? '.', createdAt: 1, lastSeenAt: 1, chainDepth: 0,
    }) as never);
    try {
      const args = { brand: 'claude' };
      const external = { surface: 'tui' as const, requestOrigin: 'external-agent' as const };
      const toolResult = await acpSessionCreateRuntime.run(args, external).catch((error: Error) => ({ error: error.message }));
      expect(toolResult).toEqual({ error: expect.stringContaining('소유자의 Claude 구독') });
      expect(start).toHaveBeenCalledTimes(0);
      const ownerResult = await acpSessionCreateRuntime.run(args, { surface: 'tui' });
      expect(ownerResult.backendId).toBe('claude');
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      start.mockRestore();
    }
  });

  test('external-agent non-Claude backend still opens', async () => {
    const manager = globalDualRoleManager();
    const start = spyOn(manager, 'clientSessionCreate').mockImplementation(async (opts) => ({
      id: 'acp-cli:gemini:fake', backendId: opts.backendId, backendSessionId: 'fake',
      cwd: opts.cwd ?? '.', createdAt: 1, lastSeenAt: 1, chainDepth: 0,
    }) as never);
    try {
      const result = await acpSessionCreateRuntime.run({ brand: 'gemini' }, {
        surface: 'tui', requestOrigin: 'external-agent',
      });
      expect(result.backendId).toBe('gemini');
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      start.mockRestore();
    }
  });

  test('subagent, background, and execute phase cannot bypass the create guard', async () => {
    const ctx = { surface: 'tui' as const, requestOrigin: 'external-agent' as const };
    await expect(acpSessionSendRuntime.run({
      sessionId: 'acp-cli:claude:existing', message: 'hello',
    }, ctx)).rejects.toBeInstanceOf(ClaudeSubscriptionNotAllowedError);
    await expect(acpSessionResumeRuntime.run({
      sessionId: 'acp-cli:claude:existing',
    }, ctx)).rejects.toBeInstanceOf(ClaudeSubscriptionNotAllowedError);
    await expect(acpSessionSpawnSubRuntime.run({
      parentSessionId: 'parent', brand: 'claude', initialMessage: 'hello',
    }, ctx)).rejects.toBeInstanceOf(ClaudeSubscriptionNotAllowedError);
    await expect(acpSessionStartBackgroundRuntime.run({
      brand: 'claude', initialMessage: 'hello',
    }, ctx)).rejects.toBeInstanceOf(ClaudeSubscriptionNotAllowedError);
    await expect(acpPlanThenExecuteRuntime.run({
      parentSessionId: 'parent', brand: 'gemini', executeBrand: 'claude',
      planPrompt: 'plan', executePrompt: 'execute',
    }, ctx)).rejects.toBeInstanceOf(ClaudeSubscriptionNotAllowedError);
  });
});
