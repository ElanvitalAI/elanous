import { describe, expect, test } from 'bun:test';

import { bootDashboardShellRunner } from '../src/dashboard/shell-runner-boot.js';

type Rollup = { running: number; backgrounded: number };
type Handle = { id: string };

describe('bootDashboardShellRunner', () => {
  test('wires file capture, rollup updates, and registry lifecycle without PTY hosts', () => {
    const rollups: Rollup[] = [];
    const tracked: Handle[] = [];
    const forgotten: string[] = [];
    const wiredRegistries: unknown[] = [];
    const registry = { kind: 'registry' };
    const fileEngine = { kind: 'file-engine' };
    let onUpdate: ((rollup: Rollup) => void) | undefined;
    let onRegister: ((handle: Handle) => void) | undefined;
    let onUnregister: ((id: string) => void) | undefined;
    let installed: { registry: unknown; fileEngine?: unknown; ptyHostFactory?: unknown } | undefined;

    bootDashboardShellRunner<Handle>({
      createBackgroundSurface: (deps) => {
        onUpdate = deps.onUpdate;
        return {
          track: (handle) => { tracked.push(handle); },
          forget: (id) => { forgotten.push(id); },
        };
      },
      initShellRegistry: (deps) => {
        onRegister = deps.onRegister;
        onUnregister = deps.onUnregister;
        return registry;
      },
      wireShellRunnerSurface: ({ shellRegistry }) => { wiredRegistries.push(shellRegistry); },
      createFileCaptureEngine: () => fileEngine,
      setShellRunnerDeps: (deps) => { installed = deps; },
      setLatestShellRollup: (rollup) => { rollups.push(rollup); },
    });

    onUpdate?.({ running: 2, backgrounded: 1 });
    onRegister?.({ id: 'h1' });
    onUnregister?.('h1');
    expect(rollups).toEqual([{ running: 2, backgrounded: 1 }]);
    expect(tracked).toEqual([{ id: 'h1' }]);
    expect(forgotten).toEqual(['h1']);
    expect(wiredRegistries).toEqual([registry]);
    expect(installed).toEqual({ registry, fileEngine });
    expect(installed).not.toHaveProperty('ptyHostFactory');
  });

  test('surface wiring failure does not interrupt file capture boot', () => {
    let installed: unknown;
    bootDashboardShellRunner({
      createBackgroundSurface: () => ({ track() {}, forget() {} }),
      initShellRegistry: () => ({}),
      wireShellRunnerSurface: () => { throw new Error('surface unavailable'); },
      createFileCaptureEngine: () => 'file-engine',
      setShellRunnerDeps: (deps) => { installed = deps; },
      setLatestShellRollup: () => {},
    });
    expect(installed).toEqual({ registry: {}, fileEngine: 'file-engine' });
  });
});
