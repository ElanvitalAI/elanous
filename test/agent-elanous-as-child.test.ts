// H5 Phase 3 · elanous-as-child adapter tests.
//
// Uses a synthetic spawn factory so tests never fork a real elanous
// process. The factory returns a minimal ChildProcess duck-type that
// exposes the methods the adapter actually touches: pid, kill,
// on('exit'), stdin.write + end.

import { describe, test, expect, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  createElanousAsChildAdapter,
  _resetElanousAsChildSessionSeqForTesting,
  ELANOUS_AGENT_DEPTH_ENV,
  ELANOUS_AGENT_DEPTH_CAP_ENV,
} from '../src/agent/adapters/elanous-as-child.js';

interface FakeChild {
  pid: number;
  killed: boolean;
  killSignal?: string;
  argv: readonly string[];
  cwd?: string;
  env: Record<string, string>;
  writes: string[];
  stdinEnded: boolean;
  emitExit(code: number | null, signal?: NodeJS.Signals | null): void;
  handle: ChildProcess;
}

function makeFakeSpawn() {
  const children: FakeChild[] = [];
  const spawn = (
    bin: string,
    args: readonly string[],
    opts: { env: Record<string, string>; cwd?: string },
  ): ChildProcess => {
    const emitter = new EventEmitter() as EventEmitter & Partial<ChildProcess>;
    const writes: string[] = [];
    let stdinEnded = false;
    const stdin = {
      destroyed: false,
      write(data: string) { writes.push(data); return true; },
      end() { stdinEnded = true; },
    };
    const fake: FakeChild = {
      pid: 10000 + children.length,
      killed: false,
      argv: [bin, ...args],
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env: opts.env,
      writes,
      stdinEnded: false,
      emitExit(code, signal) {
        this.stdinEnded = stdinEnded;
        emitter.emit('exit', code ?? null, signal ?? null);
      },
      handle: emitter as unknown as ChildProcess,
    };
    // Install process-specific fields on the emitter so it duck-types
    // as ChildProcess for the adapter's purposes.
    (emitter as unknown as { pid: number }).pid = fake.pid;
    (emitter as unknown as { killed: boolean }).killed = false;
    (emitter as unknown as { stdin: typeof stdin }).stdin = stdin;
    (emitter as unknown as { kill: (sig?: NodeJS.Signals) => boolean }).kill = (sig) => {
      fake.killed = true;
      if (sig) fake.killSignal = sig;
      (emitter as unknown as { killed: boolean }).killed = true;
      return true;
    };
    children.push(fake);
    return fake.handle;
  };
  return { spawn, children };
}

afterEach(() => {
  _resetElanousAsChildSessionSeqForTesting();
  delete process.env[ELANOUS_AGENT_DEPTH_ENV];
  delete process.env[ELANOUS_AGENT_DEPTH_CAP_ENV];
});

describe('createElanousAsChildAdapter · supports()', () => {
  test('matches elanous + elanous-child brand · acp/hybrid/auto modes', () => {
    const a = createElanousAsChildAdapter();
    expect(a.id).toBe('elanous-as-child');
    expect(a.supports({ brand: 'elanous' })).toBe(true);
    expect(a.supports({ brand: 'elanous-child' })).toBe(true);
    expect(a.supports({ brand: 'elanous', mode: 'acp' })).toBe(true);
    expect(a.supports({ brand: 'elanous', mode: 'hybrid' })).toBe(true);
    expect(a.supports({ brand: 'elanous', mode: 'auto' })).toBe(true);
  });

  test('rejects codex/claude/gemini and pty-direct mode', () => {
    const a = createElanousAsChildAdapter();
    expect(a.supports({ brand: 'codex' })).toBe(false);
    expect(a.supports({ brand: 'claude' })).toBe(false);
    expect(a.supports({ brand: 'gemini' })).toBe(false);
    expect(a.supports({ brand: 'elanous', mode: 'pty-direct' })).toBe(false);
    expect(a.supports({ brand: 'elanous', mode: 'native-sdk' })).toBe(false);
  });
});

describe('createElanousAsChildAdapter · launch()', () => {
  test('spawns "elanous --acp-server" with default binary', async () => {
    const { spawn, children } = makeFakeSpawn();
    const a = createElanousAsChildAdapter({ _spawnFactory: spawn });
    const session = await a.launch({ brand: 'elanous' });
    expect(children).toHaveLength(1);
    expect(children[0]!.argv).toEqual(['elanous', '--acp-server']);
    expect(session.id).toMatch(/^emb-elanous-as-child-/);
    expect(session.transports[0]!.kind).toBe('acp');
    expect(session.transports[0]!.label).toBe('elanous-as-child');
    expect(session.state().status).toBe('running');
    await session.dispose();
  });

  test('custom binary + extraArgs', async () => {
    const { spawn, children } = makeFakeSpawn();
    const a = createElanousAsChildAdapter({
      _spawnFactory: spawn,
      elanousBinary: '/custom/elanous',
      extraArgs: ['--verbose'],
    });
    await a.launch({ brand: 'elanous', extraArgs: ['--debug'] });
    expect(children[0]!.argv).toEqual(['/custom/elanous', '--acp-server', '--verbose', '--debug']);
  });

  test('cwd + env propagate', async () => {
    const { spawn, children } = makeFakeSpawn();
    const a = createElanousAsChildAdapter({ _spawnFactory: spawn });
    await a.launch({ brand: 'elanous', cwd: '/tmp/workspace', env: { FOO: 'bar' } });
    expect(children[0]!.cwd).toBe('/tmp/workspace');
    expect(children[0]!.env['FOO']).toBe('bar');
  });

  test('rejects unsupported brand', async () => {
    const { spawn } = makeFakeSpawn();
    const a = createElanousAsChildAdapter({ _spawnFactory: spawn });
    let err: unknown;
    try { await a.launch({ brand: 'codex' }); } catch (e) { err = e; }
    expect((err as Error).message).toMatch(/does not support/);
  });
});

describe('recursion depth cap', () => {
  test('depth bumps in child env · default cap=3 · first spawn has depth=1', async () => {
    const { spawn, children } = makeFakeSpawn();
    const a = createElanousAsChildAdapter({ _spawnFactory: spawn });
    await a.launch({ brand: 'elanous' });
    expect(children[0]!.env[ELANOUS_AGENT_DEPTH_ENV]).toBe('1');
    expect(children[0]!.env[ELANOUS_AGENT_DEPTH_CAP_ENV]).toBe('3');
  });

  test('refuses to spawn when cap reached', async () => {
    const { spawn, children } = makeFakeSpawn();
    const a = createElanousAsChildAdapter({ _spawnFactory: spawn });
    // Simulate we're already at depth 3 via env propagation
    let err: unknown;
    try {
      await a.launch({ brand: 'elanous', env: { [ELANOUS_AGENT_DEPTH_ENV]: '3', [ELANOUS_AGENT_DEPTH_CAP_ENV]: '3' } });
    } catch (e) { err = e; }
    expect((err as Error).message).toMatch(/recursion depth cap/);
    expect(children).toHaveLength(0);
  });

  test('opts.depthCap override respected', async () => {
    const { spawn, children } = makeFakeSpawn();
    const a = createElanousAsChildAdapter({ _spawnFactory: spawn, depthCap: 5 });
    await a.launch({ brand: 'elanous' });
    expect(children[0]!.env[ELANOUS_AGENT_DEPTH_CAP_ENV]).toBe('5');
  });

  test('env-level cap beats opts.depthCap', async () => {
    const { spawn, children } = makeFakeSpawn();
    const a = createElanousAsChildAdapter({ _spawnFactory: spawn, depthCap: 10 });
    await a.launch({ brand: 'elanous', env: { [ELANOUS_AGENT_DEPTH_CAP_ENV]: '2' } });
    expect(children[0]!.env[ELANOUS_AGENT_DEPTH_CAP_ENV]).toBe('2');
  });

  test('chained recursion · depth increments', async () => {
    const { spawn, children } = makeFakeSpawn();
    const a = createElanousAsChildAdapter({ _spawnFactory: spawn });
    await a.launch({ brand: 'elanous' });
    // Simulate: inherit first child's env (depth=1) and launch again
    await a.launch({
      brand: 'elanous',
      env: { [ELANOUS_AGENT_DEPTH_ENV]: '1', [ELANOUS_AGENT_DEPTH_CAP_ENV]: '3' },
    });
    expect(children[0]!.env[ELANOUS_AGENT_DEPTH_ENV]).toBe('1');
    expect(children[1]!.env[ELANOUS_AGENT_DEPTH_ENV]).toBe('2');
  });
});

describe('session lifecycle', () => {
  test('send writes to stdin with trailing newline', async () => {
    const { spawn, children } = makeFakeSpawn();
    const a = createElanousAsChildAdapter({ _spawnFactory: spawn });
    const session = await a.launch({ brand: 'elanous' });
    await session.send('hello');
    await session.send('bye\n');
    expect(children[0]!.writes).toEqual(['hello\n', 'bye\n']);
    await session.dispose();
  });

  test('interrupt maps signals', async () => {
    const { spawn, children } = makeFakeSpawn();
    const a = createElanousAsChildAdapter({ _spawnFactory: spawn });
    const s1 = await a.launch({ brand: 'elanous' });
    await s1.interrupt(); // default SIGINT
    expect(children[0]!.killSignal).toBe('SIGINT');
    const s2 = await a.launch({ brand: 'elanous' });
    await s2.interrupt('kill');
    expect(children[1]!.killSignal).toBe('SIGKILL');
    const s3 = await a.launch({ brand: 'elanous' });
    await s3.interrupt('terminate');
    expect(children[2]!.killSignal).toBe('SIGTERM');
  });

  test('state: running → done on exit 0', async () => {
    const { spawn, children } = makeFakeSpawn();
    const a = createElanousAsChildAdapter({ _spawnFactory: spawn });
    const session = await a.launch({ brand: 'elanous' });
    expect(session.state().status).toBe('running');
    children[0]!.emitExit(0);
    expect(session.state().status).toBe('done');
  });

  test('state: running → error on non-zero exit', async () => {
    const { spawn, children } = makeFakeSpawn();
    const a = createElanousAsChildAdapter({ _spawnFactory: spawn });
    const session = await a.launch({ brand: 'elanous' });
    children[0]!.emitExit(1);
    expect(session.state().status).toBe('error');
  });

  test('dispose kills child + closes stdin', async () => {
    const { spawn, children } = makeFakeSpawn();
    const a = createElanousAsChildAdapter({ _spawnFactory: spawn });
    const session = await a.launch({ brand: 'elanous' });
    await session.dispose();
    expect(children[0]!.killed).toBe(true);
    expect(children[0]!.killSignal).toBe('SIGTERM');
  });

  test('send after dispose rejects', async () => {
    const { spawn } = makeFakeSpawn();
    const a = createElanousAsChildAdapter({ _spawnFactory: spawn });
    const session = await a.launch({ brand: 'elanous' });
    await session.dispose();
    let err: unknown;
    try { await session.send('x'); } catch (e) { err = e; }
    expect((err as Error).message).toMatch(/disposed/);
  });

  test('snapshot returns structured one-liner (not a terminal buffer)', async () => {
    const { spawn } = makeFakeSpawn();
    const a = createElanousAsChildAdapter({ _spawnFactory: spawn });
    const session = await a.launch({ brand: 'elanous' });
    const snap = await session.snapshot();
    expect(snap).toContain('elanous-as-child');
    expect(snap).toContain('pid=');
    expect(snap).toContain('status=');
  });
});
