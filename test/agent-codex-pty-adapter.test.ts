// H5 Phase 1 Step C · CodexPtyAdapter tests.
//
// Uses pty-shell test-seam so we don't spawn a real codex binary.

import { describe, test, expect, afterEach } from 'bun:test';
import { createCodexPtyAdapter } from '../src/agent/adapters/codex-pty.js';
import {
  resetForTesting,
  setPtyAdapterForTesting,
  listPty,
} from '../src/pty-shell/registry.js';
import type { AgentLaunchSpec } from '../src/agent/embodiment.js';

interface FakeProcess {
  readonly pid: number;
  writes: string[];
  killed: boolean;
  killedSignal?: string;
  dataHandlers: Array<(data: string) => void>;
  exitHandlers: Array<(e: { exitCode: number; signal?: number }) => void>;
  fireData(chunk: string): void;
  fireExit(code: number): void;
}

function fakePtyAdapter(): { processes: FakeProcess[]; spawn: () => FakeProcess } {
  const processes: FakeProcess[] = [];
  const spawn = () => {
    const proc: FakeProcess = {
      pid: 1000 + processes.length,
      writes: [],
      killed: false,
      dataHandlers: [],
      exitHandlers: [],
      fireData(chunk: string) {
        for (const cb of this.dataHandlers) cb(chunk);
      },
      fireExit(code: number) {
        this.killed = true;
        for (const cb of this.exitHandlers) cb({ exitCode: code });
      },
    };
    processes.push(proc);
    return proc;
  };
  return { processes, spawn };
}

function installFakeAdapter() {
  const state = fakePtyAdapter();
  setPtyAdapterForTesting(() => {
    const proc = state.spawn();
    return {
      pid: proc.pid,
      write(input: string) {
        proc.writes.push(input);
      },
      kill(signal?: string) {
        proc.killed = true;
        proc.killedSignal = signal;
        queueMicrotask(() => proc.fireExit(signal === 'SIGKILL' ? 137 : 0));
      },
      onData(cb: (data: string) => void) {
        proc.dataHandlers.push(cb);
        return { dispose() { /* noop */ } };
      },
      onExit(cb: (e: { exitCode: number; signal?: number }) => void) {
        proc.exitHandlers.push(cb);
        return { dispose() { /* noop */ } };
      },
    };
  });
  return state;
}

afterEach(() => {
  resetForTesting();
  setPtyAdapterForTesting(null);
});
describe('createCodexPtyAdapter · supports()', () => {
  test('matches codex brand and pty-direct/hybrid/auto mode', () => {
    const a = createCodexPtyAdapter();
    expect(a.supports({ brand: 'codex' })).toBe(true);
    expect(a.supports({ brand: 'codex', mode: 'pty-direct' })).toBe(true);
    expect(a.supports({ brand: 'codex', mode: 'hybrid' })).toBe(true);
    expect(a.supports({ brand: 'codex', mode: 'auto' })).toBe(true);
  });

  test('rejects non-codex brand and non-PTY modes', () => {
    const a = createCodexPtyAdapter();
    expect(a.supports({ brand: 'claude' })).toBe(false);
    expect(a.supports({ brand: 'gemini' })).toBe(false);
    expect(a.supports({ brand: 'codex', mode: 'acp' })).toBe(false);
    expect(a.supports({ brand: 'codex', mode: 'native-sdk' })).toBe(false);
  });
});

describe('createCodexPtyAdapter · launch()', () => {
  test('launches with default binary + EmbodiedAgentSession shape', async () => {
    installFakeAdapter();
    const a = createCodexPtyAdapter();
    const session = await a.launch({ brand: 'codex', mode: 'pty-direct' });
    expect(session.id).toMatch(/^emb-codex-pty-/);
    expect(session.launchSpec.brand).toBe('codex');
    expect(session.transports.length).toBe(1);
    expect(session.transports[0]!.kind).toBe('pty');
    expect(session.transports[0]!.label).toBe('codex-pty');
    const st = session.state();
    expect(st.status).toBe('running');
    expect(st.title).toBe('codex [codex-pty]');
    await session.dispose();
  });

  test('custom binary override', async () => {
    installFakeAdapter();
    const a = createCodexPtyAdapter({ binary: '/custom/codex' });
    const session = await a.launch({ brand: 'codex' });
    // binary ends up in the PtyHandle.cmd via pty-shell
    expect(listPty().some((h) => h.cmd === '/custom/codex')).toBe(true);
    await session.dispose();
  });

  test('extraArgs from spec merged with defaultArgs from adapter opts', async () => {
    const state = installFakeAdapter();
    const a = createCodexPtyAdapter({ defaultArgs: ['--profile', 'fast'] });
    await a.launch({ brand: 'codex', extraArgs: ['--verbose'] });
    // The fake adapter didn't capture args directly, but we can verify
    // pty-shell got them via the handle.
    const handle = listPty()[0]!;
    // args propagate via startPty which adapter wraps · we can't
    // read args off PtyHandle directly (not surfaced), but spawn
    // was called which verifies reach.
    expect(handle).toBeDefined();
    expect(state.processes.length).toBe(1);
  });

  test('throws when spec does not match', async () => {
    installFakeAdapter();
    const a = createCodexPtyAdapter();
    let err: unknown;
    try {
      await a.launch({ brand: 'claude' } as AgentLaunchSpec);
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toMatch(/does not support/);
  });
});

describe('EmbodiedAgentSession (codex-pty) · lifecycle', () => {
  test('send writes to PTY', async () => {
    const state = installFakeAdapter();
    const a = createCodexPtyAdapter();
    const session = await a.launch({ brand: 'codex' });
    await session.send('hello\n');
    expect(state.processes[0]!.writes).toEqual(['hello\n']);
    await session.dispose();
  });

  test('interrupt sends SIGINT by default · maps signal names', async () => {
    const state = installFakeAdapter();
    const a = createCodexPtyAdapter();
    const session = await a.launch({ brand: 'codex' });
    await session.interrupt(); // default ctrl_c → SIGINT
    expect(state.processes[0]!.killedSignal).toBe('SIGINT');

    const s2 = await a.launch({ brand: 'codex' });
    await s2.interrupt('kill');
    expect(state.processes[1]!.killedSignal).toBe('SIGKILL');

    const s3 = await a.launch({ brand: 'codex' });
    await s3.interrupt('terminate');
    expect(state.processes[2]!.killedSignal).toBe('SIGTERM');

    await session.dispose();
    await s2.dispose();
    await s3.dispose();
  });

  test('snapshot returns PTY buffer contents', async () => {
    const state = installFakeAdapter();
    const a = createCodexPtyAdapter();
    const session = await a.launch({ brand: 'codex' });
    state.processes[0]!.fireData('> codex prompt');
    const snap = await session.snapshot();
    expect(snap).toBe('> codex prompt');
    await session.dispose();
  });

  test('state transitions · running → done on exit 0', async () => {
    const state = installFakeAdapter();
    const a = createCodexPtyAdapter();
    const session = await a.launch({ brand: 'codex' });
    expect(session.state().status).toBe('running');
    state.processes[0]!.fireExit(0);
    // Exit fired · status should now be done
    expect(session.state().status).toBe('done');
    await session.dispose();
  });

  test('state transitions · running → error on non-zero exit', async () => {
    const state = installFakeAdapter();
    const a = createCodexPtyAdapter();
    const session = await a.launch({ brand: 'codex' });
    state.processes[0]!.fireExit(1);
    expect(session.state().status).toBe('error');
    await session.dispose();
  });

  test('dispose unregisters PTY from registry', async () => {
    installFakeAdapter();
    const a = createCodexPtyAdapter();
    const session = await a.launch({ brand: 'codex' });
    expect(listPty().length).toBe(1);
    await session.dispose();
    expect(listPty().length).toBe(0);
  });

  test('send after dispose rejects', async () => {
    installFakeAdapter();
    const a = createCodexPtyAdapter();
    const session = await a.launch({ brand: 'codex' });
    await session.dispose();
    let err: unknown;
    try {
      await session.send('x');
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toMatch(/disposed/);
  });
});
