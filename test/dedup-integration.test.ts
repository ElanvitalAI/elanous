// ── End-to-end dedup tests ──
//
// Verify that when a SessionCache is threaded through dispatchRead
// and dispatchAgent, a second identical call returns the stub
// (short, reference-only) rather than re-transporting the full body
// or re-spawning the sub-agent.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatchRead } from '../src/skills/tools/read';
import { dispatchAgent } from '../src/skills/tools/agent';
import { SessionCache } from '../src/session/cache';
import { globalAgentRegistry } from '../src/agent/registry';
import type { LLMProvider } from '../src/llm';
import type { AgentDefinition } from '../src/agent/types';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'elanous-dedup-'));
}

describe('dispatchRead + SessionCache', () => {
  test('first Read returns full body, second identical Read returns stub', async () => {
    const dir = tmp();
    try {
      const p = join(dir, 'sample.txt');
      writeFileSync(p, 'hello\nworld\n');
      const cache = new SessionCache();

      const first = await dispatchRead({ file_path: p }, { sessionCache: cache });
      expect(first.output).toContain('hello');
      expect(first.output).toContain('world');
      expect(first.linesRead).toBe(2);

      const second = await dispatchRead({ file_path: p }, { sessionCache: cache });
      expect(second.output).toContain('DUPLICATE CALL');
      expect(second.output).not.toContain('hello');
      expect(second.output).not.toContain('world');
      expect(second.linesRead).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('different offset bypasses dedup', async () => {
    const dir = tmp();
    try {
      const p = join(dir, 'multi.txt');
      writeFileSync(p, 'a\nb\nc\nd\n');
      const cache = new SessionCache();

      await dispatchRead({ file_path: p, offset: 1, limit: 2 }, { sessionCache: cache });
      const second = await dispatchRead({ file_path: p, offset: 3, limit: 2 }, { sessionCache: cache });
      expect(second.output).not.toContain('DUPLICATE CALL');
      expect(second.output).toContain('c');
      expect(second.output).toContain('d');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('without sessionCache, repeat Read is unaffected', async () => {
    const dir = tmp();
    try {
      const p = join(dir, 'x.txt');
      writeFileSync(p, 'data\n');
      const a = await dispatchRead({ file_path: p });
      const b = await dispatchRead({ file_path: p });
      expect(a.output).toContain('data');
      expect(b.output).toContain('data');
      expect(b.output).not.toContain('DUPLICATE CALL');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('dispatchAgent + SessionCache', () => {
  let previousLlmMode: string | undefined;
  beforeEach(() => {
    globalAgentRegistry.clear();
    previousLlmMode = process.env.ELANOUS_LLM_MODE;
    process.env.ELANOUS_LLM_MODE = 'real'; // Honor the explicitly injected provider in Bun's test environment.
  });
  afterEach(() => {
    if (previousLlmMode === undefined) delete process.env.ELANOUS_LLM_MODE;
    else process.env.ELANOUS_LLM_MODE = previousLlmMode;
  });

  const def: AgentDefinition = {
    name: 'general-purpose',
    systemPrompt: 'be terse',
  };

  function fakeProvider(): LLMProvider {
    const p: LLMProvider = {
      name: 'f',
      defaultModel: 'm',
      available: () => true,
      async *streamChat() {
        yield { type: 'text', delta: 'done' };
      },
      async *chat() { yield 'done'; },
    };
    return p;
  }

  test('first Agent spawn runs; identical second call returns stub', async () => {
    const cache = new SessionCache();
    const first = await dispatchAgent(
      { description: 'analyze samsung', prompt: 'collect facts' },
      { provider: fakeProvider(), resolveAgentDef: () => def, sessionCache: cache },
    );
    expect(first.output).toBe('done');
    expect(first.taskId).not.toBe('dedup');

    const second = await dispatchAgent(
      { description: 'analyze samsung', prompt: 'collect facts' },
      { provider: fakeProvider(), resolveAgentDef: () => def, sessionCache: cache },
    );
    expect(second.output).toContain('DUPLICATE CALL');
    expect(second.taskId).toBe('dedup');
    expect(second.durationMs).toBe(0);
  });

  test('different prompt bypasses dedup even if description matches', async () => {
    const cache = new SessionCache();
    await dispatchAgent(
      { description: 'analyze', prompt: 'prompt A' },
      { provider: fakeProvider(), resolveAgentDef: () => def, sessionCache: cache },
    );
    const second = await dispatchAgent(
      { description: 'analyze', prompt: 'prompt B — totally different work' },
      { provider: fakeProvider(), resolveAgentDef: () => def, sessionCache: cache },
    );
    expect(second.output).toBe('done');
    expect(second.taskId).not.toBe('dedup');
  });

  test('without sessionCache, repeat Agent spawns normally', async () => {
    const a = await dispatchAgent(
      { description: 'x', prompt: 'p' },
      { provider: fakeProvider(), resolveAgentDef: () => def },
    );
    const b = await dispatchAgent(
      { description: 'x', prompt: 'p' },
      { provider: fakeProvider(), resolveAgentDef: () => def },
    );
    expect(a.output).toBe('done');
    expect(b.output).toBe('done');
    expect(b.taskId).not.toBe('dedup');
  });
});
