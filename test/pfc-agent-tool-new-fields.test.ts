// ── PFC-S1 P1: Agent tool new fields + layered resolver ──
//
// Exercises the 5 new fields (run_in_background / name / team_name /
// isolation / mode) and the 2→4-layer resolver swap. Uses a scripted
// fake LLMProvider so no network is needed; `isolation: 'worktree'` is
// covered by a separate scope (see worktree integration notes).

import { describe, test, expect, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dispatchAgent,
  buildAgentTool,
} from '../src/skills/tools/agent';
import {
  invalidateLayeredCache,
  resolveAgentLayered,
} from '../src/agent/definition-registry';
import { globalAgentRegistry } from '../src/agent/registry';
import type { AgentDefinition } from '../src/agent/types';
import type { LLMProvider, LLMStreamEvent } from '../src/llm';

// ── Test helpers ──

function fakeProvider(turns: LLMStreamEvent[][]): LLMProvider {
  let call = 0;
  const p: LLMProvider = {
    name: 'fake',
    defaultModel: 'fake-model',
    available: () => true,
    async *streamChat() {
      const events = turns[call++] ?? [];
      for (const ev of events) yield ev;
    },
    async *chat(messages, opts) {
      for await (const ev of p.streamChat!(messages, opts)) {
        if (ev.type === 'text') yield ev.delta;
      }
    },
  };
  return p;
}

function hangingProvider(): LLMProvider {
  async function hang(opts: { signal?: AbortSignal } | undefined): Promise<never> {
    return new Promise<never>((_resolve, reject) => {
      const sig = opts?.signal;
      const err = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
      if (!sig) return;
      if (sig.aborted) { reject(err()); return; }
      sig.addEventListener('abort', () => reject(err()), { once: true });
    });
  }
  return {
    name: 'hang',
    defaultModel: 'hang',
    available: () => true,
    async *streamChat(_msgs, opts) { await hang(opts); },
    async *chat(_msgs, opts) { await hang(opts); },
  };
}

function stubDef(name = 'explore', over: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    name,
    systemPrompt: `You are ${name}.`,
    ...over,
  };
}

// ── Tool spec ──

describe('Agent tool — schema', () => {
  test('exposes 5 new fields', () => {
    const spec = buildAgentTool();
    const params = spec.parameters as any;
    const props = params.properties as Record<string, unknown>;
    expect(props).toHaveProperty('run_in_background');
    expect(props).toHaveProperty('name');
    expect(props).toHaveProperty('team_name');
    expect(props).toHaveProperty('isolation');
    expect(props).toHaveProperty('mode');
  });

  test('isolation enum supports worktree and explicit cwd', () => {
    const spec = buildAgentTool();
    const props = (spec.parameters as any).properties as Record<string, any>;
    expect(props.isolation.enum).toEqual(['worktree', 'cwd']);
  });

  test('mode enum restricted to plan/auto/default', () => {
    const spec = buildAgentTool();
    const props = (spec.parameters as any).properties as Record<string, any>;
    expect(props.mode.enum).toEqual(['plan', 'auto', 'default']);
  });
});

// ── Foreground spawn with new fields ──

describe('dispatchAgent — foreground new fields', () => {
  beforeEach(() => {
    globalAgentRegistry.clear();
  });

  test('name field becomes task.label (wins over description)', async () => {
    const def = stubDef('explore');
    const provider = fakeProvider([[
      { type: 'text', delta: 'ok' },
    ]]);
    const result = await dispatchAgent(
      {
        description: 'generic desc',
        prompt: 'hello',
        subagent_type: 'explore',
        name: 'bg-explore-1',
      },
      {
        resolveAgentDef: (n) => (n === 'explore' ? def : undefined),
        provider,
      },
    );
    const task = globalAgentRegistry.get(result.taskId);
    expect(task?.label).toBe('bg-explore-1');
  });

  test('team_name lands on task.teamName', async () => {
    const def = stubDef('explore');
    const provider = fakeProvider([[{ type: 'text', delta: 'ok' }]]);
    const result = await dispatchAgent(
      {
        description: 'scout',
        prompt: 'hello',
        subagent_type: 'explore',
        team_name: 'study-team',
      },
      { resolveAgentDef: (n) => (n === 'explore' ? def : undefined), provider },
    );
    const task = globalAgentRegistry.get(result.taskId);
    expect(task?.teamName).toBe('study-team');
  });

  test('mode=plan prepends reminder to systemPrompt', async () => {
    const def = stubDef('explore');
    const provider = fakeProvider([[{ type: 'text', delta: 'ok' }]]);
    const result = await dispatchAgent(
      {
        description: 'scout',
        prompt: 'hello',
        subagent_type: 'explore',
        mode: 'plan',
      },
      { resolveAgentDef: (n) => (n === 'explore' ? def : undefined), provider },
    );
    const task = globalAgentRegistry.get(result.taskId);
    expect(task?.definition.systemPrompt).toContain("'plan' mode");
    expect(task?.definition.systemPrompt).toContain('You are explore.');
  });

  test('mode=auto produces auto reminder', async () => {
    const def = stubDef('executor');
    const provider = fakeProvider([[{ type: 'text', delta: 'ok' }]]);
    const result = await dispatchAgent(
      {
        description: 'exec',
        prompt: 'hello',
        subagent_type: 'executor',
        mode: 'auto',
      },
      { resolveAgentDef: (n) => (n === 'executor' ? def : undefined), provider },
    );
    const task = globalAgentRegistry.get(result.taskId);
    expect(task?.definition.systemPrompt).toContain("'auto' mode");
  });

  test('no mode = no reminder prepended', async () => {
    const def = stubDef('explore');
    const provider = fakeProvider([[{ type: 'text', delta: 'ok' }]]);
    const result = await dispatchAgent(
      { description: 'scout', prompt: 'hello', subagent_type: 'explore' },
      { resolveAgentDef: (n) => (n === 'explore' ? def : undefined), provider },
    );
    const task = globalAgentRegistry.get(result.taskId);
    expect(task?.definition.systemPrompt).not.toContain('<system-reminder>');
  });
});

// ── Background spawn ──

describe('dispatchAgent — run_in_background', () => {
  beforeEach(() => {
    globalAgentRegistry.clear();
  });

  test('returns immediately with taskId + background=true', async () => {
    const def = stubDef('research');
    // Hanging provider so the task never finishes on its own during
    // this test — verifies the dispatcher does NOT wait.
    const provider = hangingProvider();
    const result = await dispatchAgent(
      {
        description: 'long run',
        prompt: 'research X',
        subagent_type: 'research',
        run_in_background: true,
        name: 'bg-research-1',
      },
      { resolveAgentDef: (n) => (n === 'research' ? def : undefined), provider },
    );
    expect(result.background).toBe(true);
    expect(result.taskId).toBeTruthy();
    expect(result.output).toContain('background');
    expect(result.durationMs).toBe(0);
    // Task should be running (or at least registered).
    const task = globalAgentRegistry.get(result.taskId);
    expect(task).toBeDefined();
    expect(task?.background).toBe(true);
    // Cleanup — abort the hanging task so the test process exits.
    globalAgentRegistry.abort(result.taskId);
  });

  test('background abort via registry still flips state', async () => {
    const def = stubDef('explore');
    const provider = hangingProvider();
    const result = await dispatchAgent(
      {
        description: 'aborted-bg',
        prompt: 'x',
        subagent_type: 'explore',
        run_in_background: true,
      },
      { resolveAgentDef: (n) => (n === 'explore' ? def : undefined), provider },
    );
    const task = globalAgentRegistry.get(result.taskId)!;
    globalAgentRegistry.abort(result.taskId);
    // Allow the abort to propagate through the async drain.
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(['aborted', 'error', 'done']).toContain(task.state);
  });

  test('foreground (default) waits for completion', async () => {
    const def = stubDef('explore');
    const provider = fakeProvider([[
      { type: 'text', delta: 'synchronous done' },
    ]]);
    const result = await dispatchAgent(
      { description: 'sync', prompt: 'hello', subagent_type: 'explore' },
      { resolveAgentDef: (n) => (n === 'explore' ? def : undefined), provider },
    );
    expect(result.background).toBeUndefined();
    expect(result.output).toBe('synchronous done');
  });
});

// ── Layered resolver ──

describe('resolveAgentLayered', () => {
  let tmpRoot: string;

  beforeEach(() => {
    invalidateLayeredCache();
    tmpRoot = mkdtempSync(join(tmpdir(), 'pfc-resolver-'));
  });

  test('reads from custom builtin dir', async () => {
    const builtin = join(tmpRoot, 'builtin');
    mkdirSync(builtin, { recursive: true });
    // Write a minimal agent .md into the builtin dir.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(builtin, 'helper.md'),
      `---\nname: helper\ndescription: test\n---\nYou are helper.\n`,
      'utf-8',
    );
    const def = resolveAgentLayered('helper', {
      builtinDir: builtin,
      skipUser: true,
      skipProject: true,
      skipPlugin: true,
      projectRoot: tmpRoot,
    });
    expect(def?.name).toBe('helper');
    expect(def?.source).toBe('builtin');
  });

  test('ships general-purpose with its standard CLI tool allowlist', () => {
    const def = resolveAgentLayered('general-purpose', {
      builtinDir: join(import.meta.dir, '../src/agents'),
      skipUser: true,
      skipProject: true,
      skipPlugin: true,
      projectRoot: tmpRoot,
    });

    expect(def?.name).toBe('general-purpose');
    expect(def?.tools).toEqual(['Bash', 'Read', 'Edit', 'Grep', 'WebFetch']);
  });

  test('project layer overrides builtin', async () => {
    const builtin = join(tmpRoot, 'builtin');
    const projectAgents = join(tmpRoot, 'project', '.elanous', 'agents');
    mkdirSync(builtin, { recursive: true });
    mkdirSync(projectAgents, { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      join(builtin, 'alpha.md'),
      `---\nname: alpha\ndescription: from-builtin\n---\nbuiltin body.\n`,
      'utf-8',
    );
    writeFileSync(
      join(projectAgents, 'alpha.md'),
      `---\nname: alpha\ndescription: from-project\n---\nproject body.\n`,
      'utf-8',
    );
    invalidateLayeredCache();
    const def = resolveAgentLayered('alpha', {
      builtinDir: builtin,
      skipUser: true,
      skipPlugin: true,
      projectRoot: join(tmpRoot, 'project'),
    });
    expect(def?.description).toBe('from-project');
    expect(def?.source).toBe('project');
  });

  test('caches until invalidateLayeredCache', async () => {
    const builtin = join(tmpRoot, 'builtin');
    mkdirSync(builtin, { recursive: true });
    const { writeFileSync, unlinkSync } = await import('node:fs');
    writeFileSync(
      join(builtin, 'cached.md'),
      `---\nname: cached\ndescription: v1\n---\nfirst body.\n`,
      'utf-8',
    );
    const first = resolveAgentLayered('cached', {
      builtinDir: builtin,
      skipUser: true,
      skipProject: true,
      skipPlugin: true,
      projectRoot: tmpRoot,
    });
    expect(first?.description).toBe('v1');
    // Remove the file; without invalidate, cache still serves it.
    unlinkSync(join(builtin, 'cached.md'));
    const second = resolveAgentLayered('cached', {
      builtinDir: builtin,
      skipUser: true,
      skipProject: true,
      skipPlugin: true,
      projectRoot: tmpRoot,
    });
    expect(second?.description).toBe('v1');
    // After invalidate + same lookup, cache re-reads and misses.
    invalidateLayeredCache();
    const third = resolveAgentLayered('cached', {
      builtinDir: builtin,
      skipUser: true,
      skipProject: true,
      skipPlugin: true,
      projectRoot: tmpRoot,
    });
    expect(third).toBeUndefined();
  });

  test('unknown name returns undefined', () => {
    const def = resolveAgentLayered('does-not-exist-zzz', {
      projectRoot: tmpRoot,
      skipBuiltin: true,
      skipUser: true,
      skipProject: true,
      skipPlugin: true,
    });
    expect(def).toBeUndefined();
  });
});

// ── Result shape preservation ──

describe('dispatchAgent — result shape', () => {
  beforeEach(() => {
    globalAgentRegistry.clear();
  });

  test('existing fields (output/agent/maxTurns/taskId) preserved', async () => {
    const def = stubDef('explore');
    const provider = fakeProvider([[{ type: 'text', delta: 'answer' }]]);
    const result = await dispatchAgent(
      { description: 'scout', prompt: 'x', subagent_type: 'explore' },
      { resolveAgentDef: (n) => (n === 'explore' ? def : undefined), provider },
    );
    expect(result.output).toBe('answer');
    expect(result.agent).toBe('explore');
    expect(result.taskId).toBeTruthy();
    expect(result.maxTurns).toBeGreaterThan(0);
  });
});
