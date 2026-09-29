import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { findNativeTool } from '../native-tool-catalog.js';
import { _resetToolRuntimeRegistryForTest, getToolRuntime, registerAllDefaultToolRuntimes } from './index.js';
import {
  buildElanousHoldTool,
  buildPtyControlTool,
  dispatchElanousHold,
  dispatchPtyControl,
  setElanousControlDepsForTest,
} from './elanous-control-runtimes.js';

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
  _resetToolRuntimeRegistryForTest();
});

function inject(overrides: Parameters<typeof setElanousControlDepsForTest>[0]): void {
  restores.push(setElanousControlDepsForTest(overrides));
}

class TestStream extends EventEmitter {
  destroyed = false;
  unrefCalls = 0;
  destroy(): this { this.destroyed = true; return this; }
  unref(): this { this.unrefCalls++; return this; }
}

type TestChild = Pick<ChildProcess, 'pid' | 'unref' | 'once' | 'kill'> & { stdout: TestStream; stderr: TestStream };
function heldChild(event: 'spawn' | 'error', error?: Error): TestChild {
  const events = new EventEmitter();
  return {
    pid: 731,
    stdout: new TestStream(),
    stderr: new TestStream(),
    unref: () => {},
    kill: () => true,
    once: (name: string, callback: (...args: any[]) => void) => {
      if (name === event) queueMicrotask(() => callback(error));
      else events.once(name, callback);
      return undefined as never;
    },
  };
}

function spawnedChild(): TestChild & { emitExit(code: number | null, signal?: string): void; endStreams(): void } {
  const child = heldChild('spawn') as TestChild & { emitExit(code: number | null, signal?: string): void; endStreams(): void };
  const events = new EventEmitter();
  child.once = (name: string, callback: (...args: any[]) => void) => {
    if (name === 'spawn') queueMicrotask(() => callback());
    else events.once(name, callback);
    return undefined as never;
  };
  child.emitExit = (code: number | null, signal?: string) => events.emit('exit', code, signal);
  child.endStreams = () => {
    child.stdout.emit('end');
    child.stderr.emit('end');
  };
  return child;
}

describe('ElanousHold runtime', () => {
  test('registers both runtimes through the default tool-runtime boot path', () => {
    registerAllDefaultToolRuntimes();
    expect(getToolRuntime('elanous_hold')?.spec.name).toBe('ElanousHold');
    expect(getToolRuntime('pty_control')?.spec.name).toBe('PtyControl');
    for (const name of ['ElanousHold', 'PtyControl']) {
      const entry = findNativeTool(name);
      expect(entry?.host).toEqual(['skill', 'tui', 'mcp']);
      expect(entry?.safety).toEqual(['process']);
    }
  });

  test('returns the held PTY from piped output using the default worktree argv', async () => {
    const calls: Array<{ command: string; args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: unknown } }> = [];
    let unrefCalls = 0;
    const child = spawnedChild();
    child.unref = () => { unrefCalls++; };
    inject({
      spawn: (command, args, options) => {
        calls.push({ command, args, options });
        setTimeout(() => child.stdout.emit('data', '[dev] base=test\n⛭ held pty_abcd1234\n'), 0);
        return child;
      },
    });
    const original = process.env.ELANOUS_CONTROL_TEST_ENV;
    process.env.ELANOUS_CONTROL_TEST_ENV = 'inherited';
    try {
      const result = await dispatchElanousHold({});
      expect(result).toEqual({ output: `ElanousHold held ptyId=pty_abcd1234 pid=731 cwd=${process.cwd()}`, ptyId: 'pty_abcd1234', pid: 731, cwd: process.cwd() });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ command: 'bun', args: [expect.stringMatching(/\/bin\/elanous\.mjs$/), '--config-dir', effectiveInstanceRoot(), 'dev', '--elanous', '--hold', '--ready-timeout-ms', '90000', '--worktree'], options: { cwd: process.cwd(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] } });
      expect(calls[0]!.args).not.toContain('--cwd');
      expect(calls[0]!.options.env.ELANOUS_CONTROL_TEST_ENV).toBe('inherited');
      expect(calls[0]!.options.env).not.toBe(process.env);
      expect(unrefCalls).toBe(1);
      expect(child.stdout.destroyed).toBeTrue();
      expect(child.stderr.destroyed).toBeTrue();
      expect(child.stdout.unrefCalls).toBe(1);
      expect(child.stderr.unrefCalls).toBe(1);
      const holdParameters = buildElanousHoldTool().parameters as { required?: unknown; properties?: { worktree?: unknown } };
      expect(holdParameters.required).toBeUndefined();
      expect(holdParameters.properties?.worktree).toMatchObject({ default: true });
    } finally {
      if (original === undefined) delete process.env.ELANOUS_CONTROL_TEST_ENV;
      else process.env.ELANOUS_CONTROL_TEST_ENV = original;
    }
  });

  test('passes an explicit timeout to the child readiness deadline', async () => {
    const child = spawnedChild();
    let args: string[] = [];
    inject({ spawn: (_command, receivedArgs) => {
      args = receivedArgs;
      setTimeout(() => child.stdout.emit('data', '⛭ held pty_180abcd\n'), 0);
      return child;
    } });

    await expect(dispatchElanousHold({ timeoutMs: 180_000 })).resolves.toMatchObject({ ptyId: 'pty_180abcd' });
    expect(args).toContain('--ready-timeout-ms');
    expect(args[args.indexOf('--ready-timeout-ms') + 1]).toBe('180000');
  });

  test('pins mismatched config override and state environment to the resolved root', async () => {
    const child = spawnedChild();
    const rootA = mkdtempSync(join(tmpdir(), 'elanous-hold-config-'));
    const rootB = mkdtempSync(join(tmpdir(), 'elanous-hold-state-'));
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    let args: string[] = [];
    let env: NodeJS.ProcessEnv | undefined;
    setElanousConfigDir(rootA);
    process.env.ELANOUS_STATE_DIR = rootB;
    inject({ spawn: (_command, receivedArgs, options) => {
      args = receivedArgs;
      env = options.env;
      setTimeout(() => child.stdout.emit('data', '⛭ held pty_deadbeef\n'), 0);
      return child;
    } });
    try {
      const result = await dispatchElanousHold({ worktree: false, cwd: '/tmp/x' });
      expect(result.ptyId).toBe('pty_deadbeef');
      expect(args).toEqual([expect.stringMatching(/\/bin\/elanous\.mjs$/), '--config-dir', rootA, 'dev', '--elanous', '--hold', '--ready-timeout-ms', '90000', '--cwd', '/tmp/x']);
      expect(env?.ELANOUS_STATE_DIR).toBe(rootA);
      expect(debug.events(10_000).some((event) => event.category === 'tool-runtime.elanous-control'
        && event.event === 'hold'
        && (event.data as { ptyId?: string; instanceRoot?: string }).ptyId === 'pty_deadbeef'
        && (event.data as { ptyId?: string; instanceRoot?: string }).instanceRoot === rootA)).toBe(true);
    } finally {
      resetElanousConfigDir();
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
      rmSync(rootA, { recursive: true, force: true });
      rmSync(rootB, { recursive: true, force: true });
    }
  });

  test('uses the environment root for argv and child state when no config override exists', async () => {
    const child = spawnedChild();
    const root = mkdtempSync(join(tmpdir(), 'elanous-hold-state-'));
    const previousStateDir = process.env.ELANOUS_STATE_DIR;
    let args: string[] = [];
    let env: NodeJS.ProcessEnv | undefined;
    resetElanousConfigDir();
    process.env.ELANOUS_STATE_DIR = root;
    inject({ spawn: (_command, receivedArgs, options) => {
      args = receivedArgs;
      env = options.env;
      setTimeout(() => child.stdout.emit('data', '⛭ held pty_cafe1234\n'), 0);
      return child;
    } });
    try {
      const result = await dispatchElanousHold({ worktree: false, cwd: '/tmp/x' });
      expect(result.ptyId).toBe('pty_cafe1234');
      expect(args).toEqual([expect.stringMatching(/\/bin\/elanous\.mjs$/), '--config-dir', root, 'dev', '--elanous', '--hold', '--ready-timeout-ms', '90000', '--cwd', '/tmp/x']);
      expect(env?.ELANOUS_STATE_DIR).toBe(root);
      expect(args.slice(-2)).toEqual(['--cwd', '/tmp/x']);
      expect(args).not.toContain('--worktree');
    } finally {
      resetElanousConfigDir();
      if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
      else process.env.ELANOUS_STATE_DIR = previousStateDir;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('checks only cwd against the harness boundary and normalizes string worktree values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'elanous-hold-boundary-'));
    const boundary = join(root, 'boundary');
    const outside = join(root, 'outside');
    mkdirSync(boundary, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const prior = {
      space: process.env.ELANOUS_HARNESS_SPACE,
      spaceId: process.env.ELANOUS_HARNESS_SPACE_ID,
      boundary: process.env.ELANOUS_HARNESS_BOUNDARY,
    };
    process.env.ELANOUS_HARNESS_SPACE = 'dev-hold';
    process.env.ELANOUS_HARNESS_SPACE_ID = 'dev-run-x';
    process.env.ELANOUS_HARNESS_BOUNDARY = boundary;
    const calls: string[][] = [];
    inject({ spawn: (_command, args) => {
      calls.push(args);
      const child = spawnedChild();
      setTimeout(() => child.stdout.emit('data', '⛭ held pty_abcd1234\n'), 0);
      return child;
    } });
    try {
      const inside = await dispatchElanousHold({ worktree: true, cwd: boundary });
      expect(inside.ptyId).toBe('pty_abcd1234');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('--worktree');

      const refused = await dispatchElanousHold({ worktree: false, cwd: outside });
      expect(refused.output).toBe(`ElanousHold refused: cwd ${outside} is outside the harness boundary ${realpathSync(boundary)}`);
      expect(calls).toHaveLength(1);

      const stringWorktree = await dispatchElanousHold({ worktree: 'true', cwd: boundary });
      expect(stringWorktree.ptyId).toBe('pty_abcd1234');
      expect(calls[1]).toContain('--worktree');

      const stringCwd = await dispatchElanousHold({ worktree: 'false', cwd: boundary });
      expect(stringCwd.ptyId).toBe('pty_abcd1234');
      expect(calls[2].slice(-2)).toEqual(['--cwd', boundary]);
    } finally {
      if (prior.space === undefined) delete process.env.ELANOUS_HARNESS_SPACE; else process.env.ELANOUS_HARNESS_SPACE = prior.space;
      if (prior.spaceId === undefined) delete process.env.ELANOUS_HARNESS_SPACE_ID; else process.env.ELANOUS_HARNESS_SPACE_ID = prior.spaceId;
      if (prior.boundary === undefined) delete process.env.ELANOUS_HARNESS_BOUNDARY; else process.env.ELANOUS_HARNESS_BOUNDARY = prior.boundary;
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('spawns without boundary checking when no harness space is present', async () => {
    const prior = process.env.ELANOUS_HARNESS_SPACE;
    delete process.env.ELANOUS_HARNESS_SPACE;
    let spawned = false;
    inject({ spawn: () => {
      spawned = true;
      const child = spawnedChild();
      setTimeout(() => child.stdout.emit('data', '⛭ held pty_abcd1234\n'), 0);
      return child;
    } });
    try {
      const result = await dispatchElanousHold({ worktree: true });
      expect(result.ptyId).toBe('pty_abcd1234');
      expect(spawned).toBeTrue();
    } finally {
      if (prior === undefined) delete process.env.ELANOUS_HARNESS_SPACE; else process.env.ELANOUS_HARNESS_SPACE = prior;
    }
  });

  test('returns timeout diagnostics and SIGTERM-cleans a child without a held line', async () => {
    const child = spawnedChild();
    const signals: Array<string | undefined> = [];
    child.kill = (signal?: NodeJS.Signals | number) => { signals.push(signal as string | undefined); return true; };
    inject({ spawn: () => {
      setTimeout(() => child.stderr.emit('data', 'oops'), 0);
      return child;
    } });
    const result = await dispatchElanousHold({ timeoutMs: 50 });
    expect(result.ptyId).toBeNull();
    expect(result.output).toStartWith('ElanousHold failed:');
    expect(result.output).toContain('exit=running');
    expect(result.output).toContain('oops');
    expect(signals).toEqual(['SIGTERM']);
  }, 12_000);

  test('preserves a child readiness-timeout diagnostic after observed-owner-scale initialization and stream drain', async () => {
    const child = spawnedChild();
    const childDeadlineMs = 50;
    const initializationDelayMs = 8_698;
    inject({ spawn: (_command, args) => {
      expect(args.slice(args.indexOf('--ready-timeout-ms'), args.indexOf('--ready-timeout-ms') + 2)).toEqual(['--ready-timeout-ms', String(childDeadlineMs)]);
      setTimeout(() => {
        child.stderr.emit('data', `hold-wait-timeout after ${childDeadlineMs}ms\n`);
        child.emitExit(1);
        setTimeout(() => child.endStreams(), 25);
      }, initializationDelayMs + childDeadlineMs);
      return child;
    } });

    const result = await dispatchElanousHold({ timeoutMs: childDeadlineMs });
    expect(result.ptyId).toBeNull();
    expect(result.output).toContain('exit=1');
    expect(result.output).toContain(`hold-wait-timeout after ${childDeadlineMs}ms`);
  }, 12_000);

  test('returns early-exit diagnostics when child exits before emitting a held line', async () => {
    const child = spawnedChild();
    inject({ spawn: () => {
      setTimeout(() => {
        child.stdout.emit('data', 'before exit\n');
        child.emitExit(1);
        child.endStreams();
      }, 0);
      return child;
    } });
    const result = await dispatchElanousHold({ timeoutMs: 100 });
    expect(result.ptyId).toBeNull();
    expect(result.output).toContain('exit=1');
    expect(result.output).toContain('before exit');
  });

  test('preserves stderr from a real child that immediately exits 1', async () => {
    inject({ spawn: () => spawn(process.execPath, ['-e', "process.stderr.write('real-child-diagnostic\\n'); process.exit(1)"] , { stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as TestChild });
    const result = await dispatchElanousHold({ timeoutMs: 1_000 });
    expect(result.ptyId).toBeNull();
    expect(result.output).toContain('exit=1');
    expect(result.output).toContain('real-child-diagnostic');
  });

  test('drains stderr written after exit before returning early-exit diagnostics', async () => {
    const child = spawnedChild();
    inject({ spawn: () => {
      setTimeout(() => {
        child.emitExit(1);
        child.stderr.emit('data', 'late stderr');
        child.endStreams();
      }, 0);
      return child;
    } });
    const result = await dispatchElanousHold({ timeoutMs: 100 });
    expect(result.ptyId).toBeNull();
    expect(result.output).toContain('exit=1');
    expect(result.output).toContain('late stderr');
  });

  test.each(['stdout', 'stderr'] as const)('returns failure and SIGTERM-cleans a %s stream error', async (streamName) => {
    const child = spawnedChild();
    const signals: Array<string | undefined> = [];
    child.kill = (signal?: NodeJS.Signals | number) => { signals.push(signal as string | undefined); return true; };
    inject({ spawn: () => {
      setTimeout(() => child[streamName].emit('error', new Error(`${streamName} failed`)), 0);
      return child;
    } });
    const result = await dispatchElanousHold({ timeoutMs: 100 });
    expect(result.ptyId).toBeNull();
    expect(result.output).toContain('exit=running');
    expect(signals).toEqual(['SIGTERM']);
  });

  test('parses only stdout with stream-local UTF-8 decoding across chunks', async () => {
    const child = spawnedChild();
    inject({ spawn: () => {
      setTimeout(() => {
        child.stderr.emit('data', '⛭ held pty_bad');
        child.stdout.emit('data', Buffer.from('⛭ held pty_cafe1234\n').subarray(0, 2));
        child.stdout.emit('data', Buffer.from('⛭ held pty_cafe1234\n').subarray(2));
      }, 0);
      return child;
    } });
    const result = await dispatchElanousHold({ timeoutMs: 100 });
    expect(result.ptyId).toBe('pty_cafe1234');
  });

  test('keeps five bounded diagnostic lines including an unterminated final line', async () => {
    const child = spawnedChild();
    inject({ spawn: () => {
      setTimeout(() => {
        child.stderr.emit('data', 'one\ntwo\nthree\nfour\nfive\nsix\noops');
        child.emitExit(1);
        child.endStreams();
      }, 0);
      return child;
    } });
    const result = await dispatchElanousHold({ timeoutMs: 100 });
    expect(result.output).toContain('exit=1');
    expect(result.output).toContain('three | four | five | six | oops');
    expect(result.output).not.toContain('one | two');
  });

  test('keeps the five most recent cross-stream diagnostic lines when an older stream has an unterminated remainder', async () => {
    const child = spawnedChild();
    inject({ spawn: () => {
      setTimeout(() => {
        child.stdout.emit('data', 'old-stdout-remainder');
        child.stderr.emit('data', 'new-one\nnew-two\nnew-three\nnew-four\nnew-five\n');
        child.emitExit(1);
        child.endStreams();
      }, 0);
      return child;
    } });
    const result = await dispatchElanousHold({ timeoutMs: 100 });
    expect(result.output).toContain('new-one | new-two | new-three | new-four | new-five');
    expect(result.output).not.toContain('old-stdout-remainder');
  });

  test('fails on child exit even if an inherited pipe later emits a held line', async () => {
    const child = spawnedChild();
    const signals: Array<string | undefined> = [];
    child.kill = (signal?: NodeJS.Signals | number) => { signals.push(signal as string | undefined); return true; };
    inject({ spawn: () => {
      setTimeout(() => {
        child.emitExit(null, 'SIGKILL');
        child.stdout.emit('data', '⛭ held pty_afterexit\n');
      }, 0);
      return child;
    } });
    const result = await dispatchElanousHold({ timeoutMs: 100 });
    expect(result.ptyId).toBeNull();
    expect(result.output).toContain('exit=signal=SIGKILL');
    expect(signals).toEqual([]);
  }, 12_000);

  test('reports exited rather than timeout when an inherited pipe remains open', async () => {
    const child = spawnedChild();
    inject({ spawn: () => {
      setTimeout(() => child.emitExit(1), 0);
      return child;
    } });
    const result = await dispatchElanousHold({ timeoutMs: 50 });
    expect(result.ptyId).toBeNull();
    expect(result.output).toContain('exit=1');
  }, 12_000);

  test('bounds an unterminated diagnostic line while preserving its tail', async () => {
    const child = spawnedChild();
    const marker = 'tail-marker';
    inject({ spawn: () => {
      setTimeout(() => child.stderr.emit('data', `${'x'.repeat(20_000)}${marker}`), 0);
      return child;
    } });
    const result = await dispatchElanousHold({ timeoutMs: 50 });
    expect(result.output).toContain(marker);
    expect(result.output.length).toBeLessThan(9_000);
  }, 12_000);

  test('rejects an asynchronous spawn error instead of reporting a false success', async () => {
    inject({ spawn: () => heldChild('error', new Error('bun not found')) });
    await expect(dispatchElanousHold({ cwd: '.' })).rejects.toThrow('ElanousHold spawn failed: bun not found');
  });

  test('validates cwd before spawn', async () => {
    await expect(dispatchElanousHold({ cwd: '' })).rejects.toThrow("'cwd' must be a non-empty string");
  });
});

describe('PtyControl runtime', () => {
  test('validates action payloads/defaults and delegates the normalized request', async () => {
    const calls: unknown[][] = [];
    inject({ requestPtyControl: async (...args) => { calls.push(args); return { status: 'success', screen: 'ready' }; } });
    const output = await dispatchPtyControl({ ptyId: 'pty-1', action: 'resize', cols: 120, rows: 40 });
    expect(output.output).toBe('PtyControl ptyId=pty-1 action=resize status=success');
    expect(output.result).toEqual({ status: 'success', screen: 'ready' });
    expect(calls).toEqual([['pty-1', 'resize', { cols: 120, rows: 40 }, { actor: 'human', timeoutMs: 2000 }]]);
    await expect(dispatchPtyControl({ ptyId: 'pty-1', action: 'input-text' })).rejects.toThrow("'text' must be a non-empty string");
    await expect(dispatchPtyControl({ ptyId: 'pty-1', action: 'resize', cols: 0, rows: 4 })).rejects.toThrow("'cols' must be a positive integer");
    await expect(dispatchPtyControl({ ptyId: 'pty-1', action: 'nope' })).rejects.toThrow("'action' must be one of");
    await expect(dispatchPtyControl({ ptyId: 'pty-1', action: 'snapshot', ansi: 'true' })).rejects.toThrow("'ansi' must be a boolean");
    const tool = buildPtyControlTool();
    const { properties } = tool.parameters;
    if (!properties || typeof properties !== 'object' || !('text' in properties)) {
      throw new Error('PtyControl tool must declare a text property');
    }
    const textProperty = properties.text;
    expect(tool.parameters.required).toEqual(['ptyId', 'action']);
    expect(textProperty).toEqual(expect.objectContaining({ description: expect.any(String) }));
    if (!textProperty || typeof textProperty !== 'object' || !('description' in textProperty) || typeof textProperty.description !== 'string') {
      throw new Error('PtyControl text property must describe input semantics');
    }
    expect(textProperty.description).toContain('literal text');
    expect(textProperty.description).toContain('key name');
  });

  test('input-mouse sends structured coordinates to owner and rejects invalid coordinates', async () => {
    const calls: unknown[][] = [];
    inject({ requestPtyControl: async (...args) => { calls.push(args); return { status: 'denied', reason: 'PTY mouse mode is off' }; } });
    const response = await dispatchPtyControl({ ptyId: 'pty-1', action: 'input-mouse', x: 10, y: 5, kind: 'click', actor: 'agent' });
    expect(response.result).toEqual({ status: 'denied', reason: 'PTY mouse mode is off' });
    expect(response.output).toContain('reason=PTY mouse mode is off');
    expect(calls).toEqual([['pty-1', 'input-mouse', { x: 10, y: 5, kind: 'click', button: 'left' }, { actor: 'agent', timeoutMs: 2000 }]]);
    await expect(dispatchPtyControl({ ptyId: 'pty-1', action: 'input-mouse', x: 0, y: 5, kind: 'click' })).rejects.toThrow("'x' must be a positive integer");
  });

  test('resolves input-key names to PTY control bytes while input-text remains literal', async () => {
    const calls: unknown[][] = [];
    inject({ requestPtyControl: async (...args) => { calls.push(args); return { status: 'success' }; } });
    await dispatchPtyControl({ ptyId: 'pty-1', action: 'input-key', text: 'enter' });
    await dispatchPtyControl({ ptyId: 'pty-1', action: 'input-key', text: 'ctrl+c' });
    await dispatchPtyControl({ ptyId: 'pty-1', action: 'input-key', text: 'ESC' });
    await dispatchPtyControl({ ptyId: 'pty-1', action: 'input-text', text: 'enter' });
    expect(calls.map(([, action, payload]) => [action, payload])).toEqual([
      ['input-key', { chars: '\r' }],
      ['input-key', { chars: '\x03' }],
      ['input-key', { chars: '\x1b' }],
      ['input-text', { chars: 'enter' }],
    ]);
  });

  test('preserves whitespace-only input text but rejects invalid key names without a request', async () => {
    const calls: unknown[][] = [];
    inject({ requestPtyControl: async (...args) => { calls.push(args); return { status: 'success' }; } });
    const inputs = [' ', '\t', '\n', ' \t\n '];
    for (const text of inputs) await dispatchPtyControl({ ptyId: 'pty-1', action: 'input-text', text });
    expect(calls.map(([, action, payload]) => [action, payload])).toEqual(inputs.map((text) => ['input-text', { chars: text }]));
    await expect(dispatchPtyControl({ ptyId: 'pty-1', action: 'input-key', text: 'notakey' })).rejects.toThrow('unknown PTY special key: notakey; available names:');
    await expect(dispatchPtyControl({ ptyId: 'pty-1', action: 'input-key', text: ' \t\n ' })).rejects.toThrow('unknown PTY special key:  \t\n ; available names:');
    expect(calls).toHaveLength(inputs.length);
    await expect(dispatchPtyControl({ ptyId: ' \t\n ', action: 'capabilities' })).rejects.toThrow("'ptyId' must be a non-empty string");
    await expect(dispatchPtyControl({ ptyId: 1, action: 'capabilities' })).rejects.toThrow("'ptyId' must be a non-empty string");
    await expect(dispatchPtyControl({ ptyId: 'pty-1', action: 'input-text', text: '' })).rejects.toThrow("'text' must be a non-empty string");
  });

  test('rejects concurrent test dependency injection instead of silently replacing it', () => {
    const restore = setElanousControlDepsForTest({});
    restores.push(restore);
    expect(() => setElanousControlDepsForTest({})).toThrow('already injected');
  });

  test('restores only its own injection and is idempotent', async () => {
    const first = setElanousControlDepsForTest({ requestPtyControl: async () => ({ status: 'success', reason: 'first' }) });
    first();
    const second = setElanousControlDepsForTest({ requestPtyControl: async () => ({ status: 'success', reason: 'second' }) });
    restores.push(second);
    first();
    const result = await dispatchPtyControl({ ptyId: 'pty-1', action: 'capabilities' });
    expect(result.result).toEqual({ status: 'success', reason: 'second' });
    second();
    second();
  });
});
