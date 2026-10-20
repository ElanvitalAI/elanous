// ── Codex X1 — ephemeral shell primitive tests ──

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runShell, setShellApprover, commandKey,
  type ApprovalDecision, type ShellApprover, type ShellRequest,
} from '../src/shell-primitive';
import {
  _resetApprovalCacheForTesting, _snapshotApprovalCacheForTesting,
  getCachedDecision, rememberDecision,
} from '../src/shell-primitive/approval-cache';

describe('shell-primitive: runShell (no approval)', () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'shell-prim-')); });
  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    _resetApprovalCacheForTesting();
    setShellApprover(null);
  });

  test('echoes stdout and reports exit=0', async () => {
    const res = await runShell({ command: ['echo', 'hello'], cwd });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('hello');
    expect(res.outcome).toBe('exit');
    expect(res.truncated).toBe(false);
  });

  test('approvalKey depends on cwd + argv', () => {
    const a = commandKey({ command: ['ls'], cwd: '/tmp/a' });
    const b = commandKey({ command: ['ls'], cwd: '/tmp/b' });
    const c = commandKey({ command: ['ls', '-la'], cwd: '/tmp/a' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  test('non-zero exit surfaced without any [exit N] prefix mangling', async () => {
    const res = await runShell({ command: ['sh', '-c', 'exit 5'], cwd });
    expect(res.exitCode).toBe(5);
    expect(res.outcome).toBe('exit');
    expect(res.stdout).toBe('');
  });

  test('empty command → spawn-error without crashing', async () => {
    const res = await runShell({ command: [], cwd });
    expect(res.outcome).toBe('spawn-error');
    expect(res.spawnError).toContain('empty command');
  });

  test('missing binary → spawn-error', async () => {
    const res = await runShell({ command: ['/nope/does-not-exist'], cwd });
    expect(res.outcome).toBe('spawn-error');
    expect(res.spawnError ?? '').not.toBe('');
  });

  test('timeoutMs kills long-running command → outcome=timeout', async () => {
    const res = await runShell({ command: ['sleep', '5'], cwd, timeoutMs: 1_500 });
    expect(res.outcome).toBe('timeout');
    expect(res.exitCode).not.toBe(0);
    expect(res.elapsedMs).toBeGreaterThanOrEqual(1_400);
  }, 10_000);

  test('outer signal aborts the child', async () => {
    const ctrl = new AbortController();
    const p = runShell({ command: ['sleep', '5'], cwd, signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 50);
    const res = await p;
    expect(res.outcome).toBe('aborted');
  }, 10_000);

  test('maxOutputChars truncates and sets truncated=true', async () => {
    // 1000 chars of "a" → capped at 50 on stdout.
    const res = await runShell({
      command: ['bash', '-c', 'printf "%.0s." {1..1000}'],
      cwd,
      maxOutputChars: 50,
    });
    expect(res.stdout.length).toBe(50);
    expect(res.truncated).toBe(true);
  });

  test('custom env merges with process.env', async () => {
    const res = await runShell({
      command: ['sh', '-c', 'echo $ELANOUS_TEST_VAR'],
      cwd,
      env: { ELANOUS_TEST_VAR: 'ok-42' },
    });
    expect(res.stdout).toContain('ok-42');
  });
});

describe('shell-primitive: approval cache', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'shell-approve-'));
    _resetApprovalCacheForTesting();
    setShellApprover(null);
  });
  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    _resetApprovalCacheForTesting();
    setShellApprover(null);
  });

  function countingApprover(decision: ApprovalDecision): { approver: ShellApprover; calls: number } {
    const state = { calls: 0 };
    const approver: ShellApprover = async () => { state.calls++; return decision; };
    return Object.assign(approver, {}), { approver, get calls() { return state.calls; } };
  }

  test('approval: none → never consults the approver', async () => {
    const { approver } = countingApprover('deny-session');
    setShellApprover(approver);
    const res = await runShell({ command: ['echo', 'x'], cwd });
    expect(res.outcome).toBe('exit');
  });

  test('approval: first-time + allow-session caches and skips prompt next time', async () => {
    const c = countingApprover('allow-session');
    setShellApprover(c.approver);
    const req: ShellRequest = { command: ['echo', 'x'], cwd, approval: 'first-time' };
    const r1 = await runShell(req);
    const r2 = await runShell(req);
    expect(r1.outcome).toBe('exit');
    expect(r2.outcome).toBe('exit');
    expect(c.calls).toBe(1);
    const snap = _snapshotApprovalCacheForTesting();
    expect(snap[r1.approvalKey]).toBe('allow-session');
  });

  test('approval: first-time + deny-session caches and continues denying', async () => {
    const c = countingApprover('deny-session');
    setShellApprover(c.approver);
    const req: ShellRequest = { command: ['echo', 'x'], cwd, approval: 'first-time' };
    const r1 = await runShell(req);
    const r2 = await runShell(req);
    expect(r1.outcome).toBe('denied');
    expect(r2.outcome).toBe('denied');
    expect(c.calls).toBe(1);
  });

  test('approval: always re-prompts every call (no caching)', async () => {
    const c = countingApprover('allow-once');
    setShellApprover(c.approver);
    const req: ShellRequest = { command: ['echo', 'x'], cwd, approval: 'always' };
    await runShell(req);
    await runShell(req);
    await runShell(req);
    expect(c.calls).toBe(3);
    // -once decisions are NOT cached.
    expect(_snapshotApprovalCacheForTesting()).toEqual({});
  });

  test('approval policy with no approver wired → fail-closed (denied)', async () => {
    setShellApprover(null);
    const res = await runShell({ command: ['echo', 'x'], cwd, approval: 'first-time' });
    expect(res.outcome).toBe('denied');
  });

  test('manual rememberDecision + getCachedDecision round-trip', () => {
    rememberDecision('key-1', 'allow-session');
    rememberDecision('key-2', 'allow-once'); // not persisted
    expect(getCachedDecision('key-1')).toBe('allow-session');
    expect(getCachedDecision('key-2')).toBeUndefined();
  });
});

describe('shell-primitive: custom binary (sh -c)', () => {
  let cwd: string;
  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'shell-bin-')); });
  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    _resetApprovalCacheForTesting();
  });

  test('absolute path binary runs', async () => {
    const script = join(cwd, 'say-hi');
    writeFileSync(script, '#!/bin/sh\necho hi-from-script\n');
    chmodSync(script, 0o755);
    const res = await runShell({ command: [script], cwd });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('hi-from-script');
  });
});
