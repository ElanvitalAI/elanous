// H6 P2 Bundle 2 A2 · local-llm-ssh-pty adapter smoke.
//
// Mirrors test/agent-local-llm-pty-adapter.test.ts structure · here we
// verify the SSH-based factory correctly composes `ssh -t <node> lms
// chat <model>` when the spawn layer supplies extraArgs, plus registry
// registration / brand matching. Session internals (observer attach ·
// VW wiring) are covered by spawn-local-llm-in-vw tests.

import { describe, test, expect, afterEach } from 'bun:test';
import {
  createLocalLlmSshPtyAdapter,
  registerDefaultLocalLlmSshPtyAdapter,
} from '../src/agent/adapters/local-llm-ssh-pty.js';
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
      pid: 7777,
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

describe('createLocalLlmSshPtyAdapter · supports()', () => {
  test('matches local-llm-remote + lll-remote brand with PTY modes', () => {
    const a = createLocalLlmSshPtyAdapter();
    expect(a.id).toBe('local-llm-ssh-pty');
    expect(a.supports({ brand: 'local-llm-remote' })).toBe(true);
    expect(a.supports({ brand: 'lll-remote' })).toBe(true);
    expect(a.supports({ brand: 'local-llm-remote', mode: 'pty-direct' })).toBe(true);
    expect(a.supports({ brand: 'local-llm-remote', mode: 'hybrid' })).toBe(true);
    expect(a.supports({ brand: 'local-llm-remote', mode: 'auto' })).toBe(true);
  });

  test('rejects local-llm (non-remote) and unrelated brands', () => {
    const a = createLocalLlmSshPtyAdapter();
    expect(a.supports({ brand: 'local-llm' })).toBe(false);
    expect(a.supports({ brand: 'lll' })).toBe(false);
    expect(a.supports({ brand: 'codex' })).toBe(false);
    expect(a.supports({ brand: 'claude' })).toBe(false);
    expect(a.supports({ brand: 'local-llm-remote', mode: 'acp' })).toBe(false);
    expect(a.supports({ brand: 'local-llm-remote', mode: 'native-sdk' })).toBe(false);
  });
});

describe('createLocalLlmSshPtyAdapter · launch()', () => {
  test('composes `ssh -t <node> lms chat <model>` from extraArgs', async () => {
    const { captured } = installCapturingPty();
    const a = createLocalLlmSshPtyAdapter();
    // spawn-local-llm-in-vw.ts lays down extraArgs = [nodeId, 'lms',
    // 'chat', modelId]. Factory spec supplies binary 'ssh' and
    // defaultArgs ['-t'], so the final argv composition is:
    //   ssh -t node-b lms chat qwen3-72b
    const session = await a.launch({
      brand: 'local-llm-remote',
      extraArgs: ['node-b', 'lms', 'chat', 'qwen3-72b'],
    });
    expect(session.id).toMatch(/^emb-local-llm-ssh-pty-/);
    expect(session.transports[0]!.kind).toBe('pty');
    expect(session.transports[0]!.label).toBe('local-llm-pty-remote');
    expect(session.state().title).toBe('local-llm-remote [local-llm-ssh-pty]');
    expect(captured).toHaveLength(1);
    expect(captured[0]!.cmd).toBe('ssh');
    expect(captured[0]!.args).toEqual(['-t', 'node-b', 'lms', 'chat', 'qwen3-72b']);
    await session.dispose();
  });

  test('custom binary override · still prepends -t', async () => {
    const { captured } = installCapturingPty();
    const a = createLocalLlmSshPtyAdapter({ binary: '/opt/homebrew/bin/ssh' });
    await a.launch({
      brand: 'lll-remote',
      extraArgs: ['mbp', 'lms', 'chat', 'gpt-oss-20b'],
    });
    expect(captured[0]!.cmd).toBe('/opt/homebrew/bin/ssh');
    expect(captured[0]!.args).toEqual(['-t', 'mbp', 'lms', 'chat', 'gpt-oss-20b']);
  });

  test('opts.defaultArgs append after spec defaultArgs before spec.extraArgs', async () => {
    const { captured } = installCapturingPty();
    const a = createLocalLlmSshPtyAdapter({ defaultArgs: ['-o', 'ServerAliveInterval=60'] });
    await a.launch({
      brand: 'local-llm-remote',
      extraArgs: ['node-b', 'lms', 'chat', 'qwen3-72b'],
    });
    expect(captured[0]!.args).toEqual([
      '-t',
      '-o', 'ServerAliveInterval=60',
      'node-b', 'lms', 'chat', 'qwen3-72b',
    ]);
  });

  test('rejects brand it does not support', async () => {
    installCapturingPty();
    const a = createLocalLlmSshPtyAdapter();
    let err: unknown;
    try {
      await a.launch({ brand: 'local-llm' });
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toMatch(/does not support/);
  });
});

describe('registerDefaultLocalLlmSshPtyAdapter', () => {
  test('pick() routes remote brand to the registered adapter', () => {
    const r = new AdapterRegistry();
    registerDefaultLocalLlmSshPtyAdapter(r);
    const picked = r.pick({ brand: 'local-llm-remote', mode: 'pty-direct' });
    expect(picked?.id).toBe('local-llm-ssh-pty');
    const pickedAlias = r.pick({ brand: 'lll-remote' });
    expect(pickedAlias?.id).toBe('local-llm-ssh-pty');
    const missedLocal = r.pick({ brand: 'local-llm' });
    expect(missedLocal).toBeUndefined();
  });
});
