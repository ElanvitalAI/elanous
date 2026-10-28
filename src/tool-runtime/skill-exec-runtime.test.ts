import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { debug } from '../debug/log.js';
import * as harnessSkillExec from '../harness/skill-exec.js';
import { findNativeTool } from '../native-tool-catalog.js';
import { setResearchInvoker } from '../research-bridge/invoke.js';
import * as skillIndex from '../skills/index.js';
import type { SkillIndexEntry } from '../skills/index.js';
import { resetUserConfig, setUserConfigOverlay } from '../user-config.js';
import { _resetToolRuntimeRegistryForTest, dispatchToolByName, getToolRuntime } from './registry.js';
import {
  buildSkillExecTool,
  dispatchSkillExec,
  setSkillExecIndexProvider,
  skillExecRuntime,
} from './skill-exec-runtime.js';
import { registerAllDefaultToolRuntimes } from './index.js';

beforeEach(() => {
  setSkillExecIndexProvider(() => []);
});

afterEach(() => {
  mock.restore();
  setResearchInvoker(null);
  setSkillExecIndexProvider(null);
  setUserConfigOverlay(null);
  resetUserConfig();
  _resetToolRuntimeRegistryForTest();
});

function entry(over: Partial<SkillIndexEntry>): SkillIndexEntry {
  return {
    name: 'x',
    description: 'd',
    triggers: [],
    extractedTriggers: [],
    triggerSource: 'none',
    autoTrigger: false,
    composes: [],
    skillDir: '/x',
    rootDir: '/x',
    ...over,
  };
}

function emptyConfigAllowlist(): void {
  setUserConfigOverlay((cfg) => ({
    ...cfg,
    skillRouter: { ...cfg.skillRouter, harnessExecAllowlist: [] },
  }));
}

function captureSkillExecLogs(): {
  rows: Array<{ category: string; event: string; data: Record<string, unknown> }>;
  restore: () => void;
} {
  const rows: Array<{ category: string; event: string; data: Record<string, unknown> }> = [];
  const original = debug.log;
  (debug as { log: typeof debug.log }).log = ((category: string, event: string, data?: Record<string, unknown>) => {
    if (category === 'tool-runtime.skill-exec') rows.push({ category, event, data: data ?? {} });
  }) as typeof debug.log;
  return {
    rows,
    restore: () => {
      (debug as { log: typeof debug.log }).log = original;
    },
  };
}

const UNDECLARED_REJECT_OUTPUT =
  '자동 실행 대상 아님: undeclared-skill. 대신 skill-hint 경로를 사용하세요. 이 판정을 넓히려면 skillRouter.harnessExecAllowlist와 HARNESS_EXEC_BLOCK_PATTERNS를 검토하세요.';

describe('skill_exec runtime', () => {
  test('rejects a non-allowlisted explicit skill with the policy path', async () => {
    const result = await dispatchSkillExec({ skill: 'not-auto-safe', task: 'do work' });

    expect(result.ok).toBe(false);
    expect(result.output).toContain('자동 실행 대상 아님');
    expect(result.output).toContain('skill-hint');
    expect(result.output).toContain('skillRouter.harnessExecAllowlist');
    expect(result.output).toContain('HARNESS_EXEC_BLOCK_PATTERNS');
  });

  test('executes the explicitly named allowlisted skill through invokeResearch and preserves task text verbatim', async () => {
    let received: { skill: string; task: string } | undefined;
    setResearchInvoker(async (skill, task) => {
      received = { skill, task };
      return { ok: true, output: 'skill output' };
    });

    const result = await dispatchSkillExec({ skill: 'omni-digest', task: '  summarize this  ' });

    expect(received).toEqual({ skill: 'omni-digest', task: '  summarize this  ' });
    expect(result).toMatchObject({ skill: 'omni-digest', ok: true, output: 'skill output' });
  });

  test('returns a large skill result verbatim to the parent tool boundary', async () => {
    const report = Array.from({ length: 500 }, (_, index) => `# Section ${index + 1}\n${'research finding '.repeat(12)}`).join('\n');
    setResearchInvoker(async () => ({ ok: true, output: report }));

    const result = await dispatchSkillExec({ skill: 'omni-digest', task: 'return the full report' });

    expect(result.output).toBe(report);
    expect(result.output.length).toBeGreaterThan(50_000);
  });

  test('a stalled skill returns a timeout tool result and aborts its child', async () => {
    let childSignal: AbortSignal | undefined;
    setResearchInvoker(async (_skill, _task, _progress, signal) => {
      childSignal = signal;
      return new Promise(() => {});
    });
    const result = await dispatchSkillExec(
      { skill: 'omni-digest', task: 'research' }, {}, { timeoutMs: 20 },
    );
    expect(result).toMatchObject({ skill: 'omni-digest', ok: false, error: 'skill-exec-timeout' });
    expect(result.output).toContain('시간');
    expect(childSignal?.aborted).toBe(true);
  });

  test('parent cancellation ends a stalled skill without waiting for the invoker', async () => {
    const parent = new AbortController();
    setResearchInvoker(async () => new Promise(() => {}));
    const pending = dispatchSkillExec(
      { skill: 'omni-digest', task: 'research' }, {}, { signal: parent.signal, timeoutMs: 60_000 },
    );
    parent.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'skill-exec-cancelled' });
  });

  test('a cooperative child abort still reports the parent timeout reason', async () => {
    setResearchInvoker(async (_skill, _task, _progress, signal) => new Promise((resolve) => {
      signal?.addEventListener('abort', () => resolve({ ok: false, output: '', error: 'AbortError' }), { once: true });
    }));
    await expect(dispatchSkillExec({ skill: 'omni-digest', task: 'research' }, {}, { timeoutMs: 20 }))
      .resolves.toMatchObject({ ok: false, error: 'skill-exec-timeout' });
  });

  test('registered runtime passes parent signal into the nested skill', async () => {
    const parent = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    setResearchInvoker(async (_skill, _task, _progress, signal) => {
      receivedSignal = signal;
      return new Promise(() => {});
    });
    const pending = skillExecRuntime.run({ skill: 'omni-digest', task: 'research' }, { surface: 'tui', signal: parent.signal });
    parent.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'skill-exec-cancelled' });
    expect(receivedSignal?.aborted).toBe(true);
  });

  test('already cancelled parent never starts a nested skill', async () => {
    const parent = new AbortController();
    parent.abort();
    let invoked = false;
    setResearchInvoker(async () => { invoked = true; return { ok: true, output: 'unexpected' }; });
    const result = await dispatchSkillExec({ skill: 'omni-digest', task: 'research' }, {}, { signal: parent.signal });
    expect(result).toMatchObject({ ok: false, error: 'skill-exec-cancelled' });
    expect(invoked).toBe(false);
  });

  test('a low-quality research result yields a bounded discovery card without changing failure', async () => {
    setResearchInvoker(async () => ({ ok: false, output: 'No data found for the period premium.' }));
    let gap = '';
    const result = await dispatchSkillExec({ skill: 'omni-digest', task: 'period premium data' }, {
      discoverPlugin: async (request) => { gap = request; return { card: 'Plugin discovery · proposal only' }; },
    });
    expect(gap).toBe('period premium data');
    expect(result.ok).toBe(false);
    expect(result.output).toContain('No data found');
    expect(result.discoveryCard).toBe('Plugin discovery · proposal only');
  });

  test('rejects a whitespace-padded skill name rather than normalizing it', async () => {
    const result = await dispatchSkillExec({ skill: ' omni-digest ', task: 'do work' });

    expect(result).toMatchObject({ skill: ' omni-digest ', ok: false });
    expect(result.output).toContain('자동 실행 대상 아님');
    expect(result.output).toContain('skillRouter.harnessExecAllowlist');
    expect(result.output).toContain('HARNESS_EXEC_BLOCK_PATTERNS');
  });

  test('declares exactly skill and task and is registered for every requested host', () => {
    const spec = buildSkillExecTool();
    expect(spec.name).toBe('skill_exec');
    expect(Object.keys((spec.parameters as { properties: object }).properties)).toEqual(['skill', 'task']);
    expect((spec.parameters as { required: string[] }).required).toEqual(['skill', 'task']);

    const catalog = findNativeTool('skill_exec');
    expect(catalog?.host).toEqual(['skill', 'tui', 'mcp']);
    expect(catalog?.safety).toEqual(['process']);
    expect(catalog?.supportsParallel).toBe(false);
    expect(catalog?.defaultEnabled).toBe(true);
  });

  test('default registration dispatches skill_exec by its catalog name', async () => {
    setResearchInvoker(async () => ({ ok: true, output: 'registered output' }));
    registerAllDefaultToolRuntimes();

    expect(getToolRuntime('skill_exec')?.id).toBe(skillExecRuntime.id);
    await expect(dispatchToolByName('skill_exec', { skill: 'omni-digest', task: 'run' }, { surface: 'mcp' }))
      .resolves.toMatchObject({ skill: 'omni-digest', ok: true, output: 'registered output' });
  });

  test('admits a declared-safe skill from an injected index with an empty config allowlist', async () => {
    emptyConfigAllowlist();
    setSkillExecIndexProvider(() => [
      entry({ name: 'elanous-logs', sideEffects: 'none', cost: 'light' }),
    ]);
    let received: { skill: string; task: string } | undefined;
    setResearchInvoker(async (skill, task) => {
      received = { skill, task };
      return { ok: true, output: 'declared-safe output' };
    });
    const { rows, restore } = captureSkillExecLogs();

    try {
      const result = await dispatchSkillExec({ skill: 'elanous-logs', task: 'show recent errors' });
      expect(received).toEqual({ skill: 'elanous-logs', task: 'show recent errors' });
      expect(result).toMatchObject({ skill: 'elanous-logs', ok: true, output: 'declared-safe output' });
      const decision = rows.find((r) => r.event === 'decision');
      expect(decision?.data).toMatchObject({
        skill: 'elanous-logs',
        admitted: true,
        reason: 'declared-safe',
      });
    } finally {
      restore();
    }
  });

  test('rejects an undeclared skill with the same wording as before', async () => {
    emptyConfigAllowlist();
    setSkillExecIndexProvider(() => [entry({ name: 'undeclared-skill' })]);
    let invoked = false;
    setResearchInvoker(async () => {
      invoked = true;
      return { ok: true, output: 'should not run' };
    });
    const { rows, restore } = captureSkillExecLogs();

    try {
      const result = await dispatchSkillExec({ skill: 'undeclared-skill', task: 'do work' });
      expect(invoked).toBe(false);
      expect(result.ok).toBe(false);
      expect(result.output).toBe(UNDECLARED_REJECT_OUTPUT);
      const decision = rows.find((r) => r.event === 'decision');
      expect(decision?.data).toMatchObject({
        skill: 'undeclared-skill',
        admitted: false,
        reason: 'not-allowlisted',
      });
    } finally {
      restore();
    }
  });

  test('rejects a declared-safe skill whose name matches a block pattern', async () => {
    emptyConfigAllowlist();
    setSkillExecIndexProvider(() => [
      entry({ name: 'declared-consensus', sideEffects: 'none', cost: 'light' }),
    ]);
    let invoked = false;
    setResearchInvoker(async () => {
      invoked = true;
      return { ok: true, output: 'should not run' };
    });
    const { rows, restore } = captureSkillExecLogs();

    try {
      const result = await dispatchSkillExec({ skill: 'declared-consensus', task: 'do work' });
      expect(invoked).toBe(false);
      expect(result.ok).toBe(false);
      expect(result.output).toContain('자동 실행 대상 아님: declared-consensus');
      expect(rows.some((r) => r.event === 'allowlist-reject' && r.data.skill === 'declared-consensus')).toBe(true);
      const decision = rows.find((r) => r.event === 'decision');
      expect(decision?.data).toMatchObject({
        skill: 'declared-consensus',
        admitted: false,
        reason: 'not-allowlisted',
      });
    } finally {
      restore();
    }
  });

  test('falls back to config-only allowlist when the index provider throws', async () => {
    emptyConfigAllowlist();
    setSkillExecIndexProvider(() => {
      throw new Error('index boom');
    });
    const getter = spyOn(skillIndex, 'getSkillIndex').mockImplementation(() => {
      throw new Error('real getter must not run');
    });
    const resolve = spyOn(harnessSkillExec, 'resolveHarnessExecAllowlist');
    let invoked = false;
    setResearchInvoker(async () => {
      invoked = true;
      return { ok: true, output: 'should not run' };
    });
    const { rows, restore } = captureSkillExecLogs();

    try {
      const undeclared = await dispatchSkillExec({ skill: 'undeclared-skill', task: 'do work' });
      expect(invoked).toBe(false);
      expect(undeclared.ok).toBe(false);
      expect(undeclared.output).toBe(UNDECLARED_REJECT_OUTPUT);
      expect(rows.some((r) => r.event === 'index-unavailable')).toBe(true);

      setResearchInvoker(async (skill, task) => {
        invoked = true;
        expect({ skill, task }).toEqual({ skill: 'omni-digest', task: 'builtin still works' });
        return { ok: true, output: 'builtin output' };
      });
      const builtin = await dispatchSkillExec({ skill: 'omni-digest', task: 'builtin still works' });
      expect(builtin).toMatchObject({ skill: 'omni-digest', ok: true, output: 'builtin output' });

      setUserConfigOverlay((cfg) => ({
        ...cfg,
        skillRouter: { ...cfg.skillRouter, harnessExecAllowlist: ['config-only-skill'] },
      }));
      setResearchInvoker(async (skill, task) => {
        expect({ skill, task }).toEqual({ skill: 'config-only-skill', task: 'run config skill' });
        return { ok: true, output: 'config output' };
      });
      const configured = await dispatchSkillExec({ skill: 'config-only-skill', task: 'run config skill' });
      expect(configured).toMatchObject({ skill: 'config-only-skill', ok: true, output: 'config output' });

      expect(getter).toHaveBeenCalledTimes(0);
      expect(resolve.mock.calls.length).toBeGreaterThan(0);
      for (const args of resolve.mock.calls) {
        expect(args[2]).toEqual([]);
      }
    } finally {
      restore();
      getter.mockRestore();
      resolve.mockRestore();
    }
  });

  test('admits a config-allowlisted skill that has no safety declaration', async () => {
    setUserConfigOverlay((cfg) => ({
      ...cfg,
      skillRouter: { ...cfg.skillRouter, harnessExecAllowlist: ['config-only-skill'] },
    }));
    setSkillExecIndexProvider(() => [entry({ name: 'config-only-skill' })]);
    let received: { skill: string; task: string } | undefined;
    setResearchInvoker(async (skill, task) => {
      received = { skill, task };
      return { ok: true, output: 'config output' };
    });
    const { rows, restore } = captureSkillExecLogs();

    try {
      const result = await dispatchSkillExec({ skill: 'config-only-skill', task: 'run config skill' });
      expect(received).toEqual({ skill: 'config-only-skill', task: 'run config skill' });
      expect(result).toMatchObject({ skill: 'config-only-skill', ok: true, output: 'config output' });
      const decision = rows.find((r) => r.event === 'decision');
      expect(decision?.data).toMatchObject({
        skill: 'config-only-skill',
        admitted: true,
        reason: 'config',
      });
    } finally {
      restore();
    }
  });

  test('uses the injected index so a declared-safe skill is admitted only when that index is actually applied', async () => {
    emptyConfigAllowlist();
    let invoked = false;
    setResearchInvoker(async () => {
      invoked = true;
      return { ok: true, output: 'should not run without index' };
    });

    setSkillExecIndexProvider(() => []);
    const withoutIndex = await dispatchSkillExec({ skill: 'elanous-logs', task: 'show recent errors' });
    expect(invoked).toBe(false);
    expect(withoutIndex.ok).toBe(false);
    expect(withoutIndex.output).toContain('자동 실행 대상 아님: elanous-logs');

    setSkillExecIndexProvider(() => [
      entry({ name: 'elanous-logs', sideEffects: 'none', cost: 'light' }),
    ]);
    setResearchInvoker(async (skill, task) => {
      invoked = true;
      expect({ skill, task }).toEqual({ skill: 'elanous-logs', task: 'show recent errors' });
      return { ok: true, output: 'index applied' };
    });
    const withIndex = await dispatchSkillExec({ skill: 'elanous-logs', task: 'show recent errors' });
    expect(withIndex).toMatchObject({ skill: 'elanous-logs', ok: true, output: 'index applied' });
  });
});
