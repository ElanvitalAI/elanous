import { describe, test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  runShell,
  resolveMode,
  setShellRunnerDeps,
  getShellRunnerDeps,
  resetShellRunnerDeps,
} from '../../src/shell-runner/dispatch.js';
import { createShellRegistry } from '../../src/shell-runner/registry.js';
import { createFileCaptureEngine } from '../../src/shell-runner/file-engine.js';
import type { ShellRunnerDeps } from '../../src/shell-runner/dispatch.js';
import type { TerminalHost } from '../../src/shell-runner/pty-engine.js';
import type {
  BufferMark,
  ShellRequest,
} from '../../src/shell-runner/types.js';

// ── fake child_process.spawn for file engine ────────────────────
function fakeSpawn() {
  return (_cmd: string, _args: readonly string[]) => {
    const ee = new EventEmitter() as any;
    ee.stdout = new PassThrough();
    ee.stderr = new PassThrough();
    ee.stdin = new PassThrough();
    ee.kill = () => true;
    // Auto-resolve with exit 0 on next tick so tests don't hang.
    queueMicrotask(() => {
      ee.stdout.end();
      ee.stderr.end();
      ee.emit('exit', 0, null);
    });
    return ee;
  };
}

// ── fake TerminalHost for pty engine ────────────────────────────
function fakeHost(): TerminalHost & { writes: string[] } {
  const taps = new Set<(c: string) => void>();
  const writes: string[] = [];
  let bytes = 0;
  const mark: BufferMark = { row: 0, col: 0, ts: 0, bytes: 0 };
  return {
    isAlive: true,
    addRawOutputTap(cb) { taps.add(cb); return () => taps.delete(cb); },
    markBufferPosition() { return { ...mark, bytes }; },
    bytesSinceMark(m) { return bytes - m.bytes; },
    sliceFromMark() { return []; },
    renderForLLM() { return ''; },
    write(b) { writes.push(b); bytes += Buffer.byteLength(b, 'utf8'); },
    resize() { /* noop */ },
    writes,
  } as any;
}

describe('resolveMode', () => {
  test('explicit mode is returned verbatim', () => {
    const deps = makeDeps();
    expect(resolveMode('inline', deps)).toBe('inline');
    expect(resolveMode('bg', deps)).toBe('bg');
    expect(resolveMode('modal', deps)).toBe('modal');
    expect(resolveMode('vw', deps)).toBe('vw');
  });

  test('auto + factory present → vw (DEFAULT_SHELL_MODE)', () => {
    const deps = makeDeps({ withFactory: true });
    expect(resolveMode('auto', deps)).toBe('vw');
    expect(resolveMode(undefined, deps)).toBe('vw');
  });

  test('auto + no factory → inline (graceful fallback)', () => {
    const deps = makeDeps({ withFactory: false });
    expect(resolveMode('auto', deps)).toBe('inline');
    expect(resolveMode(undefined, deps)).toBe('inline');
  });
});

describe('runShell', () => {
  test('mode=inline routes to file engine and registers the handle', async () => {
    const deps = makeDeps({ spawnFn: fakeSpawn() });
    const req: ShellRequest = { command: 'echo', mode: 'inline', timeoutMs: 1000 };
    const h = runShell(req, deps);
    expect(h.mode).toBe('inline');
    expect(deps.registry.get(h.id)).toBe(h);
    await h.result;
  });

  test('explicit VW and modal requests without a PTY host fail rather than reporting a headless success', () => {
    const deps = makeDeps({ spawnFn: fakeSpawn() });
    for (const mode of ['vw', 'modal'] as const) {
      expect(() => runShell({ command: 'echo unsafe', mode }, deps)).toThrow(`RunShell(mode:"${mode}") requires an attachable PTY surface`);
    }
    expect(deps.registry.list()).toEqual([]);
  });

  test('mode=vw routes to pty engine when a factory is provided', () => {
    const host = fakeHost();
    const deps = makeDeps({
      withFactory: true,
      factory: () => host,
      spawnFn: fakeSpawn(),
    });
    const req: ShellRequest = {
      command: 'ls',
      mode: 'vw',
      quietIdleMs: 5,
      timeoutMs: 10_000,
    };
    const h = runShell(req, deps);
    expect(h.mode).toBe('vw');
    // Command was injected into the host.
    expect(host.writes[0]).toBe('ls\r');
    h.kill(); // cleanup
  });

  test('mode=vw but factory returns null → falls back to file engine', async () => {
    const deps = makeDeps({
      withFactory: true,
      factory: () => null,
      spawnFn: fakeSpawn(),
    });
    const req: ShellRequest = { command: 'echo', mode: 'vw', timeoutMs: 1000 };
    const h = runShell(req, deps);
    // Mode is preserved (vw) but the engine silently degraded.
    expect(h.mode).toBe('vw');
    await h.result;
  });

  test('attachSurface callback receives the handle + normalized req', () => {
    let seen: { handleMode: string; reqMode?: string } | null = null;
    const deps = makeDeps({
      spawnFn: fakeSpawn(),
      attachSurface: (h, r) => { seen = { handleMode: h.mode, reqMode: r.mode }; },
    });
    runShell({ command: 'x', timeoutMs: 100 }, deps);
    expect(seen?.handleMode).toBe('inline'); // auto → inline (no factory)
    expect(seen?.reqMode).toBe('inline');
  });

  test('attachSurface throws are isolated', () => {
    const deps = makeDeps({
      spawnFn: fakeSpawn(),
      attachSurface: () => { throw new Error('bad'); },
    });
    expect(() => runShell({ command: 'x', timeoutMs: 100 }, deps)).not.toThrow();
  });
});

describe('singleton deps', () => {
  test('set/get/reset cycle', () => {
    resetShellRunnerDeps();
    expect(getShellRunnerDeps()).toBeNull();
    const deps = makeDeps();
    setShellRunnerDeps(deps);
    expect(getShellRunnerDeps()).toBe(deps);
    resetShellRunnerDeps();
    expect(getShellRunnerDeps()).toBeNull();
  });
});

// ── helpers ─────────────────────────────────────────────────────
function makeDeps(opts: {
  withFactory?: boolean;
  factory?: (req: ShellRequest) => TerminalHost | null;
  spawnFn?: any;
  attachSurface?: ShellRunnerDeps['attachSurface'];
} = {}): ShellRunnerDeps {
  const registry = createShellRegistry();
  const fileEngine = createFileCaptureEngine(
    opts.spawnFn ? { spawnFn: opts.spawnFn } : {},
  );
  const deps: ShellRunnerDeps = { registry, fileEngine };
  if (opts.withFactory || opts.factory) {
    deps.ptyHostFactory = opts.factory ?? (() => fakeHost());
  }
  if (opts.attachSurface) deps.attachSurface = opts.attachSurface;
  return deps;
}
