import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiagnosticBridge, type DiagnosticSink } from './diagnostic-sink.js';

describe('diagnostic sink bootstrap bridge', () => {
  test('delivers buffered and direct events with either logger/bridge import order', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'diagnostic-bridge-order-'));
    try {
      const script = `
        const order = process.argv[1];
        let debug;
        let flushes = 0;
        if (order === 'logger-first') {
          debug = await import('./src/debug/log.ts');
          const flush = debug.debug.flush.bind(debug.debug);
          debug.debug.flush = () => { flushes++; flush(); };
        }
        const bridge = await import('./src/mss/logging/diagnostic-sink.ts');
        if (order === 'bridge-first') {
          const register = globalThis.__elanous_mss_diagnostic_register__;
          globalThis.__elanous_mss_diagnostic_register__ = (sink) => register({
            log: (...args) => sink.log(...args),
            flush: () => { flushes++; sink.flush(); },
          });
        }
        bridge.logDiagnostic('test.bridge', 'queued-marker');
        if (order === 'bridge-first') debug = await import('./src/debug/log.ts');
        bridge.logDiagnostic('test.bridge', 'direct-marker');
        bridge.flushDiagnostics();
        if (order === 'bridge-first' && flushes !== 1) process.exit(4);
        if (order === 'logger-first' && flushes !== 1) process.exit(5);
        const events = debug.debug.events(100).map((event) => event.event);
        if (!events.includes('queued-marker') || !events.includes('direct-marker')) process.exit(2);
      `;
      for (const order of ['bridge-first', 'logger-first']) {
        const result = spawnSync(process.execPath, ['-e', script, order], {
          cwd: process.cwd(), encoding: 'utf8',
          env: { ...process.env, ELANOUS_STATE_DIR: stateDir, MSS_STDERR_SINK: 'true' },
        });
        expect(result.status, result.stderr || result.stdout).toBe(0);
        expect(result.stderr).toContain('queued-marker');
        expect(result.stderr).toContain('direct-marker');
      }
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('persists the fatal diagnostic before the safety net exits the process', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'diagnostic-bridge-fatal-'));
    try {
      const script = `
        const root = process.env.IMP2_SOURCE_ROOT;
        const { installLogSafetyNet } = await import('file://' + root + '/src/mss/logging/log-safety-net.ts');
        installLogSafetyNet({ componentRoot: 'test.fatal' });
        setImmediate(() => { throw new Error('fatal-marker'); });
        await new Promise(() => {});
      `;
      const result = spawnSync(process.execPath, ['-e', script], {
        cwd: stateDir, encoding: 'utf8',
        env: { ...process.env, IMP2_SOURCE_ROOT: process.cwd() },
      });
      expect(result.status, result.stderr || result.stdout).toBe(1);
      const logDir = join(stateDir, '.elanous', 'debug');
      const files = readdirSync(logDir).filter((file) => file.startsWith('debug-') && file.endsWith('.log'));
      expect(files.length).toBeGreaterThan(0);
      expect(files.some((file) => readFileSync(join(logDir, file), 'utf8').includes('fatal-marker'))).toBe(true);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  test('buffers diagnostics and flushes them in order when the logger registers', () => {
    const calls: unknown[][] = [];
    const sink: DiagnosticSink = {
      log: (...args) => { calls.push(['log', ...args]); },
      flush: () => { calls.push(['flush']); },
    };
    const { logDiagnostic, flushDiagnostics, registerDiagnosticSink } = createDiagnosticBridge();

    logDiagnostic('store.sqlite', 'busy-lost', { waitedMs: 100 });
    flushDiagnostics();
    expect(calls).toEqual([]);

    const unregister = registerDiagnosticSink(sink);
    expect(calls).toEqual([
      ['log', 'store.sqlite', 'busy-lost', { waitedMs: 100 }, undefined],
      ['flush'],
    ]);

    logDiagnostic('store.sqlite', 'busy-recovered', { attempts: 2 });
    flushDiagnostics();
    expect(calls.slice(2)).toEqual([
      ['log', 'store.sqlite', 'busy-recovered', { attempts: 2 }, undefined],
      ['flush'],
    ]);
    unregister();
  });

  test('queues diagnostics emitted while buffered calls are being drained', () => {
    const calls: string[] = [];
    const { logDiagnostic, registerDiagnosticSink } = createDiagnosticBridge();
    logDiagnostic('boot', 'first');
    const unregister = registerDiagnosticSink({
      log: (_category, event) => {
        calls.push(event);
        if (event === 'first') logDiagnostic('boot', 'second');
      },
      flush: () => calls.push('flush'),
    });
    expect(calls).toEqual(['first', 'second']);
    unregister();
  });

  test('keeps the first diagnostic ahead of reentrant bootstrap diagnostics', () => {
    const calls: string[] = [];
    let bridge!: ReturnType<typeof createDiagnosticBridge>;
    bridge = createDiagnosticBridge(() => {
      bridge.logDiagnostic('boot', 'reentrant');
      bridge.registerDiagnosticSink({
        log: (_category, event) => calls.push(event),
        flush: () => calls.push('flush'),
      });
    }, true);

    bridge.logDiagnostic('boot', 'first');
    expect(calls).toEqual(['first', 'reentrant']);
  });

  test('bootstraps a missing logger before a fatal flush drains queued diagnostics', () => {
    const calls: string[] = [];
    let bridge!: ReturnType<typeof createDiagnosticBridge>;
    bridge = createDiagnosticBridge(() => {
      calls.push('bootstrap');
      bridge.registerDiagnosticSink({
        log: (_category, event) => calls.push(event),
        flush: () => calls.push('sink-flush'),
      });
    });

    bridge.logDiagnostic('fatal', 'uncaught');
    bridge.flushDiagnostics();
    expect(calls).toEqual(['bootstrap', 'uncaught', 'sink-flush']);
  });
});
