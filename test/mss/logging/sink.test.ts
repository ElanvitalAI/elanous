// ── LogSink tests (MSS M2.2 Phase A1) ──
//
// Covers the three extracted sinks (RingSink, MirrorSink, FileSink) as
// standalone units. Integration with the DebugLog façade + registerSink
// extension point is exercised by `test/debug-log.test.ts` and the
// M2.2 Phase A2 `StderrSink` tests.

import { setDefaultTimeout, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FileSink, MirrorSink, RingSink, type LogSink } from '../../../src/mss/logging/sink.js';
import type { LogRecord } from '../../../src/mss/logging/record.js';

// Real Bun/CLI subprocesses can exceed Bun's 5 s test default under gate-pod load (spawn limit plus headroom).
setDefaultTimeout(60_000);

function mkRec(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    ts: new Date().toISOString(),
    category: 'test',
    event: 'ev',
    ...overrides,
  };
}

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), 'mss-sink-'));
}

describe('RingSink', () => {
  test('emit populates in insertion order; events() returns copy', () => {
    const r = new RingSink(10);
    r.emit(mkRec({ event: 'one' }));
    r.emit(mkRec({ event: 'two' }));
    const evs = r.events();
    expect(evs.map(e => e.event)).toEqual(['one', 'two']);
    // mutation of returned array must not affect internal state
    evs.push(mkRec({ event: 'three' }));
    expect(r.length).toBe(2);
  });

  test('capacity clamps to 1 when zero or negative is passed', () => {
    expect(new RingSink(0).capacity).toBe(1);
    expect(new RingSink(-5).capacity).toBe(1);
  });

  test('exceeding capacity drops oldest events', () => {
    const r = new RingSink(3);
    for (let i = 0; i < 5; i++) r.emit(mkRec({ event: `e-${i}` }));
    expect(r.length).toBe(3);
    expect(r.events().map(e => e.event)).toEqual(['e-2', 'e-3', 'e-4']);
  });

  test('events(n) returns last N oldest-first; n >= length returns all', () => {
    const r = new RingSink(10);
    for (let i = 0; i < 5; i++) r.emit(mkRec({ event: `e-${i}` }));
    expect(r.events(2).map(e => e.event)).toEqual(['e-3', 'e-4']);
    expect(r.events(100).length).toBe(5);
  });

  test('clear() empties the buffer', () => {
    const r = new RingSink(5);
    r.emit(mkRec());
    r.emit(mkRec());
    r.clear();
    expect(r.length).toBe(0);
    expect(r.events()).toEqual([]);
  });
});

describe('MirrorSink', () => {
  test('emit is a no-op when no hook is registered', () => {
    const m = new MirrorSink((r) => `${r.category}:${r.event}`);
    expect(m.hasHook()).toBe(false);
    // no throw
    m.emit(mkRec());
  });

  test('emit dispatches formatted line to registered hook', () => {
    const lines: string[] = [];
    const m = new MirrorSink((r) => `${r.category}|${r.event}`);
    m.setHook((line) => lines.push(line));
    m.emit(mkRec({ category: 'cat', event: 'hi' }));
    expect(lines).toEqual(['cat|hi']);
  });

  test('hook throwing is absorbed silently', () => {
    const m = new MirrorSink((r) => r.event);
    m.setHook(() => { throw new Error('boom'); });
    expect(() => m.emit(mkRec())).not.toThrow();
  });

  test('setHook(null) clears the hook', () => {
    const lines: string[] = [];
    const m = new MirrorSink((r) => r.event);
    m.setHook((l) => lines.push(l));
    m.setHook(null);
    m.emit(mkRec({ event: 'dropped' }));
    expect(lines).toEqual([]);
    expect(m.hasHook()).toBe(false);
  });
});

describe('FileSink · emit + flush', () => {
  test('emit + flush writes a JSONL line to disk', () => {
    const dir = mkTmp();
    try {
      const file = join(dir, 'sink.log');
      const fs = new FileSink({
        logDir: dir,
        filePath: file,
        installExitHandlers: false,
      });
      fs.emit(mkRec({ category: 'llm', event: 'req' }));
      fs.flush();
      const contents = readFileSync(file, 'utf8');
      expect(contents.endsWith('\n')).toBe(true);
      const parsed = JSON.parse(contents.trim());
      expect(parsed.category).toBe('llm');
      expect(parsed.event).toBe('req');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('batch size threshold detaches buffer via setImmediate', async () => {
    const dir = mkTmp();
    try {
      const file = join(dir, 'sink.log');
      const fs = new FileSink({
        logDir: dir,
        filePath: file,
        flushBatchSize: 3,
        flushBatchBytes: 1_000_000, // don't trigger bytes path
        installExitHandlers: false,
      });
      for (let i = 0; i < 3; i++) fs.emit(mkRec({ event: `e-${i}` }));
      // Detach writes on setImmediate — allow one macrotask to flush.
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      const lines = readFileSync(file, 'utf8').trim().split('\n');
      expect(lines.length).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('bytesWritten tracks cumulative write size', () => {
    const dir = mkTmp();
    try {
      const file = join(dir, 'sink.log');
      const fs = new FileSink({
        logDir: dir,
        filePath: file,
        installExitHandlers: false,
      });
      fs.emit(mkRec({ event: 'one' }));
      fs.flush();
      const afterFirst = fs.bytesWritten();
      expect(afterFirst).toBeGreaterThan(0);
      fs.emit(mkRec({ event: 'two' }));
      fs.flush();
      expect(fs.bytesWritten()).toBeGreaterThan(afterFirst);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('setEnabled(false) flushes pending writes before disabling', () => {
    const dir = mkTmp();
    try {
      const file = join(dir, 'sink.log');
      const fs = new FileSink({
        logDir: dir,
        filePath: file,
        installExitHandlers: false,
      });
      fs.emit(mkRec({ event: 'pre-disable' }));
      fs.setEnabled(false);
      // Pending write must have flushed in the setEnabled path.
      expect(readFileSync(file, 'utf8')).toContain('pre-disable');
      // Subsequent emits are dropped.
      fs.emit(mkRec({ event: 'post-disable' }));
      fs.flush();
      expect(readFileSync(file, 'utf8')).not.toContain('post-disable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('FileSink · clear + rotation', () => {
  test('clear truncates the active file and drops pending writes', () => {
    const dir = mkTmp();
    try {
      const file = join(dir, 'sink.log');
      const fs = new FileSink({
        logDir: dir,
        filePath: file,
        installExitHandlers: false,
      });
      fs.emit(mkRec({ event: 'will-be-dropped' }));
      fs.flush();
      fs.clear();
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe('');
      expect(fs.bytesWritten()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('rotation renames active file to <base>.1.log when threshold hit', () => {
    const dir = mkTmp();
    try {
      const file = join(dir, 'sink.log');
      const fs = new FileSink({
        logDir: dir,
        filePath: file,
        maxFileBytes: 50,
        installExitHandlers: false,
      });
      // Each JSONL line is ~60+ bytes so one flush trips rotation.
      fs.emit(mkRec({ event: 'a'.repeat(40) }));
      fs.flush();
      // After rotation, original path is free for a new file and the
      // rotated copy sits at <base>.1.log.
      expect(existsSync(join(dir, 'sink.1.log'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('FileSink · readFile fallback', () => {
  test('readFile returns "" when disabled + file missing', () => {
    const dir = mkTmp();
    try {
      const file = join(dir, 'sink.log');
      const fs = new FileSink({
        logDir: dir,
        filePath: file,
        installExitHandlers: false,
      }, /* enabled */ false);
      expect(fs.readFile()).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('readFile returns disk contents after flush', () => {
    const dir = mkTmp();
    try {
      const file = join(dir, 'sink.log');
      const fs = new FileSink({
        logDir: dir,
        filePath: file,
        installExitHandlers: false,
      });
      fs.emit(mkRec({ event: 'visible' }));
      const out = fs.readFile(); // auto-flushes
      expect(out).toContain('visible');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('FileSink · exit-signal handlers', () => {
  const sinkSrc = join(import.meta.dir, '../../../src/mss/logging/sink.ts');

  async function pollUntil(pred: () => boolean, ms: number, label: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < ms) {
      if (pred()) return;
      await Bun.sleep(15);
    }
    throw new Error(`timeout waiting for ${label}`);
  }

  function writeChildScript(dir: string): string {
    const path = join(dir, 'signal-child.ts');
    const body = [
      "import { writeFileSync } from 'fs';",
      `import { FileSink } from ${JSON.stringify(sinkSrc)};`,
      '',
      'const logDir = process.env.SINK_LOG_DIR!;',
      'const filePath = process.env.SINK_LOG_FILE!;',
      'const markerPath = process.env.SINK_MARKER_PATH!;',
      'const readyPath = process.env.SINK_READY_PATH!;',
      'const mode = process.env.SINK_MODE!;',
      'const signal = process.env.SINK_SIGNAL as NodeJS.Signals;',
      "const lastEvent = process.env.SINK_LAST_EVENT ?? 'last-line';",
      '',
      'const rec = (event: string) => ({',
      '  ts: new Date().toISOString(),',
      "  category: 'test',",
      '  event,',
      '});',
      '',
      'const preexisting = process.listeners(signal).slice();',
      'const before = preexisting.length;',
      'const sink = new FileSink({ logDir, filePath, installExitHandlers: true });',
      "sink.emit(rec('install'));",
      "if (mode === 'double') {",
      "  sink.emit(rec('second'));",
      '  const after = process.listeners(signal).length;',
      '  writeFileSync(markerPath, JSON.stringify({ before, after, delta: after - before }));',
      '  process.exit(0);',
      '}',
      '// Drop runtime-preinstalled listeners so this child is either',
      '// FileSink-only (mode=none) or FileSink + our marker handler (mode=other).',
      'for (const listener of preexisting) {',
      '  process.removeListener(signal, listener as (...args: unknown[]) => void);',
      '}',
      'sink.emit(rec(lastEvent));',
      "if (mode === 'other') {",
      '  process.on(signal, () => {',
      "    writeFileSync(markerPath, 'call\\n', { flag: 'a' });",
      '  });',
      '}',
      "writeFileSync(readyPath, 'ready');",
      'setInterval(() => {}, 1 << 30);',
      '',
    ].join('\n');
    writeFileSync(path, body);
    return path;
  }

  async function spawnSinkChild(opts: {
    dir: string;
    signal: 'SIGINT' | 'SIGTERM';
    mode: 'other' | 'none' | 'double';
    lastEvent?: string;
  }): Promise<{
    proc: ReturnType<typeof Bun.spawn>;
    logFile: string;
    markerPath: string;
    readyPath: string;
  }> {
    const logFile = join(opts.dir, 'sink.log');
    const markerPath = join(opts.dir, 'marker.txt');
    const readyPath = join(opts.dir, 'ready.txt');
    const childPath = writeChildScript(opts.dir);
    const proc = Bun.spawn(['bun', childPath], {
      cwd: opts.dir,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        SINK_LOG_DIR: opts.dir,
        SINK_LOG_FILE: logFile,
        SINK_MARKER_PATH: markerPath,
        SINK_READY_PATH: readyPath,
        SINK_MODE: opts.mode,
        SINK_SIGNAL: opts.signal,
        SINK_LAST_EVENT: opts.lastEvent ?? 'last-line',
      },
    });
    return { proc, logFile, markerPath, readyPath };
  }

  function defaultSignalExit(signal: 'SIGINT' | 'SIGTERM', code: number | null, got: string | null): boolean {
    if (got === signal) return true;
    // 128 + signo: SIGINT=2 → 130, SIGTERM=15 → 143
    if (signal === 'SIGINT' && code === 130) return true;
    if (signal === 'SIGTERM' && code === 143) return true;
    return false;
  }

  test('SIGINT handler flushes then other SIGINT listeners still run', async () => {
    const dir = mkTmp();
    try {
      const { proc, logFile, markerPath, readyPath } = await spawnSinkChild({
        dir,
        signal: 'SIGINT',
        mode: 'other',
        lastEvent: 'last-line',
      });
      try {
        await pollUntil(() => existsSync(readyPath), 5_000, 'child ready');
        proc.kill('SIGINT');
        await pollUntil(() => existsSync(markerPath), 5_000, 'other-handler marker');
        await pollUntil(() => existsSync(logFile) && readFileSync(logFile, 'utf8').includes('last-line'), 5_000, 'flushed last log');
        // Settle so a re-raised signal would record a second call if it fired.
        await Bun.sleep(300);
        expect(readFileSync(markerPath, 'utf8').trim().split('\n')).toEqual(['call']);
        expect(readFileSync(logFile, 'utf8')).toContain('last-line');
      } finally {
        proc.kill('SIGKILL');
        await proc.exited;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  test('SIGTERM handler flushes then other SIGTERM listeners still run', async () => {
    const dir = mkTmp();
    try {
      const { proc, logFile, markerPath, readyPath } = await spawnSinkChild({
        dir,
        signal: 'SIGTERM',
        mode: 'other',
        lastEvent: 'term-last',
      });
      try {
        await pollUntil(() => existsSync(readyPath), 5_000, 'child ready');
        proc.kill('SIGTERM');
        await pollUntil(() => existsSync(markerPath), 5_000, 'other-handler marker');
        await pollUntil(() => existsSync(logFile) && readFileSync(logFile, 'utf8').includes('term-last'), 5_000, 'flushed last log');
        await Bun.sleep(300);
        expect(readFileSync(markerPath, 'utf8').trim().split('\n')).toEqual(['call']);
        expect(readFileSync(logFile, 'utf8')).toContain('term-last');
      } finally {
        proc.kill('SIGKILL');
        await proc.exited;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  test('with no other handlers, SIGINT still re-signals the process after flush', async () => {
    const dir = mkTmp();
    try {
      const { proc, logFile, readyPath } = await spawnSinkChild({
        dir,
        signal: 'SIGINT',
        mode: 'none',
        lastEvent: 'solo-flush',
      });
      await pollUntil(() => existsSync(readyPath), 5_000, 'child ready');
      proc.kill('SIGINT');
      const code = await proc.exited;
      await pollUntil(() => existsSync(logFile) && readFileSync(logFile, 'utf8').includes('solo-flush'), 5_000, 'flushed last log');
      expect(readFileSync(logFile, 'utf8')).toContain('solo-flush');
      expect(defaultSignalExit('SIGINT', proc.exitCode ?? code, proc.signalCode)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  test('with no other handlers, SIGTERM still re-signals the process after flush', async () => {
    const dir = mkTmp();
    try {
      const { proc, logFile, readyPath } = await spawnSinkChild({
        dir,
        signal: 'SIGTERM',
        mode: 'none',
        lastEvent: 'solo-term',
      });
      await pollUntil(() => existsSync(readyPath), 5_000, 'child ready');
      proc.kill('SIGTERM');
      const code = await proc.exited;
      await pollUntil(() => existsSync(logFile) && readFileSync(logFile, 'utf8').includes('solo-term'), 5_000, 'flushed last log');
      expect(readFileSync(logFile, 'utf8')).toContain('solo-term');
      expect(defaultSignalExit('SIGTERM', proc.exitCode ?? code, proc.signalCode)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);

  test('installing the same sink twice adds only one SIGINT listener', async () => {
    const dir = mkTmp();
    try {
      const { proc, markerPath } = await spawnSinkChild({
        dir,
        signal: 'SIGINT',
        mode: 'double',
      });
      const code = await proc.exited;
      expect(code).toBe(0);
      const report = JSON.parse(readFileSync(markerPath, 'utf8')) as { delta: number };
      expect(report.delta).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('LogSink interface shape', () => {
  test('all three built-in sinks satisfy the narrow contract', () => {
    const ring: LogSink = new RingSink(1);
    const mirror: LogSink = new MirrorSink((r) => r.event);
    const dir = mkTmp();
    try {
      const file: LogSink = new FileSink({
        logDir: dir,
        filePath: join(dir, 'x.log'),
        installExitHandlers: false,
      });
      // name getter + emit method are required
      expect(ring.name).toBe('ring');
      expect(mirror.name).toBe('mirror');
      expect(file.name).toBe('file');
      ring.emit(mkRec());
      mirror.emit(mkRec());
      file.emit(mkRec());
      file.flush?.();
      ring.clear?.();
      file.clear?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
