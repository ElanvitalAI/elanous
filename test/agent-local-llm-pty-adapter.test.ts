// H6 P2 Bundle 2 A · local-llm-pty adapter smoke.
//
// Factory internals are covered by agent-pty-adapter-factory.test.ts.
// Here we verify brand/mode matching, id, default binary (`lms`) +
// default args (`chat`), custom binary override, and registration
// into an AdapterRegistry. The capturing fake PTY lets us assert the
// full `{cmd, args}` composition that reaches spawnPty.

import { describe, test, expect, afterEach } from 'bun:test';
import { createLocalLlmPtyAdapter, registerDefaultLocalLlmPtyAdapter } from '../src/agent/adapters/local-llm-pty.js';
import { AdapterRegistry } from '../src/agent/adapter-registry.js';
import {
  resetForTesting,
  setPtyAdapterForTesting,
  type StartOpts,
} from '../src/pty-shell/registry.js';

function installCapturingPty(): { captured: StartOpts[] } {
  const captured: StartOpts[] = [];
  setPtyAdapterForTesting((opts) => {
    captured.push(opts);
    return {
      pid: 4242,
      write() {},
      kill() {},
      onData() { return { dispose() {} }; },
      onExit() { return { dispose() {} }; },
    };
  });
  return { captured };
}

afterEach(() => {
  resetForTesting();
  setPtyAdapterForTesting(null);
});

describe('createLocalLlmPtyAdapter · supports()', () => {
  test('matches local-llm + lll brand with PTY modes', () => {
    const a = createLocalLlmPtyAdapter();
    expect(a.id).toBe('local-llm-pty');
    expect(a.supports({ brand: 'local-llm' })).toBe(true);
    expect(a.supports({ brand: 'lll' })).toBe(true);
    expect(a.supports({ brand: 'local-llm', mode: 'pty-direct' })).toBe(true);
    expect(a.supports({ brand: 'local-llm', mode: 'hybrid' })).toBe(true);
    expect(a.supports({ brand: 'local-llm', mode: 'auto' })).toBe(true);
  });

  test('rejects unrelated brands and non-PTY modes', () => {
    const a = createLocalLlmPtyAdapter();
    expect(a.supports({ brand: 'codex' })).toBe(false);
    expect(a.supports({ brand: 'claude' })).toBe(false);
    expect(a.supports({ brand: 'gemini' })).toBe(false);
    expect(a.supports({ brand: 'elanous' })).toBe(false);
    expect(a.supports({ brand: 'local-llm', mode: 'acp' })).toBe(false);
    expect(a.supports({ brand: 'local-llm', mode: 'native-sdk' })).toBe(false);
  });
});

describe('createLocalLlmPtyAdapter · launch()', () => {
  test('launches with default binary "lms" + composes "chat <model>" args', async () => {
    const { captured } = installCapturingPty();
    const a = createLocalLlmPtyAdapter();
    // D17 · spec.extraArgs[0] carries the modelId · spawn-local-llm-in-vw
    // composes this at the call site; adapter just forwards.
    const session = await a.launch({
      brand: 'local-llm',
      extraArgs: ['qwen3.5-35b-a3b'],
    });
    expect(session.id).toMatch(/^emb-local-llm-pty-/);
    expect(session.transports[0]!.kind).toBe('pty');
    expect(session.transports[0]!.label).toBe('local-llm-pty');
    expect(session.state().title).toBe('local-llm [local-llm-pty]');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.cmd).toBe('lms');
    expect(captured[0]!.args).toEqual(['chat', 'qwen3.5-35b-a3b']);
    await session.dispose();
  });

  test('custom binary override · preserves defaultArgs', async () => {
    const { captured } = installCapturingPty();
    const a = createLocalLlmPtyAdapter({ binary: '/opt/lmstudio/bin/lms' });
    await a.launch({
      brand: 'lll',
      extraArgs: ['gpt-oss-20b'],
    });
    expect(captured[0]!.cmd).toBe('/opt/lmstudio/bin/lms');
    expect(captured[0]!.args).toEqual(['chat', 'gpt-oss-20b']);
  });

  test('opts.defaultArgs append after spec.defaultArgs before spec.extraArgs', async () => {
    const { captured } = installCapturingPty();
    const a = createLocalLlmPtyAdapter({ defaultArgs: ['--verbose'] });
    await a.launch({
      brand: 'local-llm',
      extraArgs: ['qwen3.5-35b-a3b'],
    });
    // spec.defaultArgs (['chat']) + opts.defaultArgs (['--verbose']) + spec.extraArgs
    expect(captured[0]!.args).toEqual(['chat', '--verbose', 'qwen3.5-35b-a3b']);
  });

  test('rejects brand it does not support', async () => {
    installCapturingPty();
    const a = createLocalLlmPtyAdapter();
    let err: unknown;
    try {
      await a.launch({ brand: 'codex' });
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toMatch(/does not support/);
  });
});

describe('registerDefaultLocalLlmPtyAdapter', () => {
  test('pick() routes local-llm brand to the registered adapter', () => {
    const r = new AdapterRegistry();
    registerDefaultLocalLlmPtyAdapter(r);
    const picked = r.pick({ brand: 'local-llm', mode: 'pty-direct' });
    expect(picked?.id).toBe('local-llm-pty');
    const pickedLll = r.pick({ brand: 'lll' });
    expect(pickedLll?.id).toBe('local-llm-pty');
    const missed = r.pick({ brand: 'codex' });
    expect(missed).toBeUndefined();
  });
});
