// ── skill-tool-shell (RunShell LLM tool) tests ──

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { debug } from '../src/debug/log';
import {
  __resetSessionWorkingDir,
  getSessionCwd,
  initSessionWorkingDir,
} from '../src/session/working-dir';
import { HARNESS_SPACE_ENV } from '../src/harness/harness-space';
import {
  buildRunShellTool,
  dispatchRunShell,
  formatSummary,
} from '../src/skills/tools/shell';
import {
  _resetApprovalCacheForTesting,
} from '../src/shell-primitive/approval-cache';
import {
  setShellApprover,
  setAuditSinkForTesting,
  type ShellApprover,
} from '../src/shell-primitive';

describe('buildRunShellTool', () => {
  test('tool spec shape', () => {
    const spec = buildRunShellTool();
    expect(spec.name).toBe('RunShell');
    expect(spec.parameters.required).toEqual(['command']);
    const props = spec.parameters.properties as Record<string, { type?: string }>;
    expect(props.command?.type).toBe('array');
    expect(props.approval?.type).toBe('string');
    const cwd = props.cwd as { description?: string };
    expect(cwd.description).toBe('Working directory. Defaults to the current session working directory.');
  });
});

describe('dispatchRunShell', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'run-shell-tool-'));
    _resetApprovalCacheForTesting();
    setShellApprover(null);
    setAuditSinkForTesting(() => { /* swallow audit in tests */ });
  });
  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    __resetSessionWorkingDir();
    _resetApprovalCacheForTesting();
    setShellApprover(null);
    setAuditSinkForTesting(null);
  });

  test('runs echo and returns summary + stdout', async () => {
    const res = await dispatchRunShell({ command: ['echo', 'hi'], cwd });
    expect(res.outcome).toBe('exit');
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('hi');
    expect(res.output).toContain('outcome=exit');
    expect(res.output).toContain('exitCode=0');
  });

  test('rejects direct cd without running it or changing the session cwd', async () => {
    initSessionWorkingDir(cwd);
    const before = getSessionCwd();
    const auditEvents: unknown[] = [];
    setAuditSinkForTesting((event) => auditEvents.push(event));
    const res = await dispatchRunShell({ command: ['cd', '/tmp'] });
    expect(res.outcome).toBe('spawn-error');
    expect(res.exitCode).toBeNull();
    expect(res.output).toContain('argv commands');
    expect(res.output).toContain('do not persist');
    expect(res.output).toContain('`cwd`');
    expect(auditEvents).toEqual([]);
    expect(getSessionCwd()).toBe(before);
  });

  test('executes an explicit shell command containing cd without treating it as direct cd', async () => {
    const harnessSpace = process.env[HARNESS_SPACE_ENV];
    delete process.env[HARNESS_SPACE_ENV];
    try {
      const res = await dispatchRunShell({ command: ['bash', '-lc', 'cd .'], cwd });
      expect(res.outcome).toBe('exit');
      expect(res.exitCode).toBe(0);
      expect(res.output).not.toContain('rejected direct `cd`');
    } finally {
      if (harnessSpace === undefined) delete process.env[HARNESS_SPACE_ENV];
      else process.env[HARNESS_SPACE_ENV] = harnessSpace;
    }
  });

  test('uses the session cwd when cwd is omitted', async () => {
    initSessionWorkingDir(cwd);
    const res = await dispatchRunShell({ command: ['pwd'] });
    expect(res.outcome).toBe('exit');
    expect(res.stdout.trim()).toBe(realpathSync(getSessionCwd()));
  });

  test('records rejected and executed cwd audit events without argv or output', async () => {
    const seen: Array<{ category: string; event: string; data?: unknown }> = [];
    const off = debug.registerSink({
      name: 'skill-tool-shell-capture',
      emit: (record) => seen.push({ category: record.category, event: record.event, data: record.data }),
    });
    try {
      await dispatchRunShell({ command: ['cd', '/tmp'] });
      await dispatchRunShell({ command: ['pwd'], cwd });
    } finally {
      off();
    }
    const rejected = seen.find((record) => record.category === 'shell.dispatch' && record.event === 'cd.rejected');
    expect(rejected?.data).toMatchObject({ reason: 'argv-state-does-not-persist' });
    const executed = seen.find((record) => record.category === 'shell.dispatch' && record.event === 'legacy.exit');
    expect(executed?.data).toMatchObject({ cwd, cwdSource: 'argument' });
  });

  test('empty command rejected with a message', async () => {
    await expect(dispatchRunShell({ command: [], cwd })).rejects.toThrow(/non-empty/);
  });

  test('non-string command item rejected', async () => {
    await expect(dispatchRunShell({ command: ['echo', 42 as unknown as string], cwd }))
      .rejects.toThrow(/must be strings/);
  });

  test('invalid approval value rejected', async () => {
    await expect(dispatchRunShell({ command: ['echo', 'x'], cwd, approval: 'maybe' }))
      .rejects.toThrow(/invalid approval/);
  });

  test('passes approval policy through to runtime', async () => {
    const approver: ShellApprover = async () => 'allow-session';
    setShellApprover(approver);
    const r1 = await dispatchRunShell({ command: ['echo', 'x'], cwd, approval: 'first-time' });
    const r2 = await dispatchRunShell({ command: ['echo', 'x'], cwd, approval: 'first-time' });
    expect(r1.outcome).toBe('exit');
    expect(r2.outcome).toBe('exit');
    // approvalKey stable across calls
    expect(r1.approvalKey).toBe(r2.approvalKey);
  });

  test('ctx.signal aborts the underlying runShell', async () => {
    const ctrl = new AbortController();
    const p = dispatchRunShell({ command: ['sleep', '5'], cwd }, { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 40);
    const res = await p;
    expect(res.outcome).toBe('aborted');
  }, 10_000);

  test('timeoutMs propagates', async () => {
    const res = await dispatchRunShell({
      command: ['sleep', '5'], cwd, timeoutMs: 500,
    });
    expect(res.outcome).toBe('timeout');
  }, 10_000);
});

describe('NT-C1b-1 — mode parameter opts into shell-runner dispatch', () => {
  // These tests verify the *routing* only — that dispatchRunShell
  // delegates to shell-runner when mode is set AND deps are installed,
  // and falls back to the legacy shell-primitive path otherwise.
  //
  // Full engine coverage lives in test/shell-runner/*.test.ts.

  test('mode=undefined + deps absent → legacy path (shell-primitive)', async () => {
    const cwd2 = mkdtempSync(join(tmpdir(), 'run-shell-legacy-'));
    try {
      const { resetShellRunnerDeps } = await import('../src/shell-runner/dispatch.js');
      resetShellRunnerDeps();
      const res = await dispatchRunShell({ command: ['echo', 'legacy'], cwd: cwd2 });
      expect(res.outcome).toBe('exit');
      expect(res.stdout).toContain('legacy');
      // Legacy path populates approvalKey as a hash; runner path
      // prefixes with "runner:".
      expect(res.approvalKey.startsWith('runner:')).toBe(false);
    } finally {
      rmSync(cwd2, { recursive: true, force: true });
    }
  });

  test('mode set + deps present → runner path (approvalKey starts with "runner:")', async () => {
    const { setShellRunnerDeps, resetShellRunnerDeps } =
      await import('../src/shell-runner/dispatch.js');
    const { createShellRegistry } = await import('../src/shell-runner/registry.js');
    const { createFileCaptureEngine } = await import('../src/shell-runner/file-engine.js');
    const { EventEmitter } = await import('node:events');
    const { PassThrough } = await import('node:stream');

    // Fake spawn so we don't hit real processes.
    const fakeSpawn: any = () => {
      const ee = new EventEmitter() as any;
      ee.stdout = new PassThrough();
      ee.stderr = new PassThrough();
      ee.stdin = new PassThrough();
      ee.kill = () => true;
      queueMicrotask(() => {
        ee.stdout.write('from-runner\n');
        ee.stdout.end();
        ee.stderr.end();
        ee.emit('exit', 0, null);
      });
      return ee;
    };

    const registry = createShellRegistry();
    const fileEngine = createFileCaptureEngine({ spawnFn: fakeSpawn });
    setShellRunnerDeps({ registry, fileEngine });

    try {
      const res = await dispatchRunShell({
        command: ['echo', 'x'],
        mode: 'inline',
        description: 'test-label',
      });
      expect(res.outcome).toBe('exit');
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('from-runner');
      expect(res.approvalKey.startsWith('runner:')).toBe(true);
      // The handle should have been registered while running — by now
      // it's completed but Registry retains it (no retention policy
      // on the registry layer itself; entries persist until unregister).
      expect(registry.size()).toBeGreaterThanOrEqual(1);
      const bg = await dispatchRunShell({ command: ['echo', 'x'], mode: 'bg' });
      expect(bg.outcome).toBe('exit');
      expect(bg.stdout).toContain('from-runner');
      expect(bg.approvalKey.startsWith('runner:')).toBe(true);
    } finally {
      resetShellRunnerDeps();
    }
  });

  test('invalid mode rejected by parser', async () => {
    await expect(
      dispatchRunShell({ command: ['echo', 'x'], mode: 'nonsense' as any }),
    ).rejects.toThrow(/mode/);
  });

  test('mode set but no deps → silently falls back to legacy', async () => {
    const { resetShellRunnerDeps } = await import('../src/shell-runner/dispatch.js');
    resetShellRunnerDeps();
    const cwd2 = mkdtempSync(join(tmpdir(), 'run-shell-no-deps-'));
    try {
      const res = await dispatchRunShell({
        command: ['echo', 'fallback'],
        mode: 'inline',
        cwd: cwd2,
      });
      expect(res.outcome).toBe('exit');
      // Legacy path, so no "runner:" prefix.
      expect(res.approvalKey.startsWith('runner:')).toBe(false);
    } finally {
      rmSync(cwd2, { recursive: true, force: true });
    }
  });

  test('tool spec advertises only inline and bg shell-runner modes', () => {
    const spec = buildRunShellTool();
    const props = spec.parameters.properties as Record<string, { enum?: string[] }>;
    expect(props.mode!.enum).toEqual(['inline', 'bg']);
    expect(props.description).toBeDefined();
    expect(props).not.toHaveProperty('vw_window_label');
  });

  test('retired runner modes are rejected before dispatch', async () => {
    for (const mode of ['auto', 'modal', 'vw']) {
      await expect(dispatchRunShell({ command: ['echo', 'x'], mode })).rejects.toThrow(`invalid mode value: "${mode}"`);
    }
  });
});

describe('formatSummary', () => {
  test('includes truncated + spawn_error when set', () => {
    expect(formatSummary({
      exitCode: 1, stdout: '', stderr: '', elapsedMs: 10,
      approvalKey: 'k', outcome: 'spawn-error', truncated: false,
      spawnError: 'ENOENT',
    })).toContain('spawn_error="ENOENT"');
    expect(formatSummary({
      exitCode: 0, stdout: '', stderr: '', elapsedMs: 5,
      approvalKey: 'k', outcome: 'exit', truncated: true,
    })).toContain('truncated');
  });

  test('exitCode=null prints as "null"', () => {
    const s = formatSummary({
      exitCode: null, stdout: '', stderr: '', elapsedMs: 1,
      approvalKey: 'k', outcome: 'aborted', truncated: false,
    });
    expect(s).toContain('exitCode=null');
  });
});
