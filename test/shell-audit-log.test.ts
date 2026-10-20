// ── Codex X2 — audit log tests ──

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runShell, setShellApprover,
  setAuditLogRootForTesting, setAuditSinkForTesting,
  type AuditEvent, type ApprovalDecision, type ShellApprover,
} from '../src/shell-primitive';
import {
  _resetApprovalCacheForTesting,
} from '../src/shell-primitive/approval-cache';

function makeAutoApprover(d: ApprovalDecision): ShellApprover {
  return async () => d;
}

describe('shell-primitive audit-log: file sink', () => {
  let cwd: string;
  let auditRoot: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'shell-audit-'));
    auditRoot = mkdtempSync(join(tmpdir(), 'shell-audit-log-'));
    setAuditLogRootForTesting(auditRoot);
    setAuditSinkForTesting(null);
    _resetApprovalCacheForTesting();
    setShellApprover(null);
  });

  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(auditRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    setAuditLogRootForTesting(null);
    setAuditSinkForTesting(null);
    _resetApprovalCacheForTesting();
    setShellApprover(null);
  });

  test('creates shell-YYYY-MM-DD.ndjson under root on first run', async () => {
    await runShell({ command: ['echo', 'audit-1'], cwd });
    const files = readdirSync(auditRoot).filter(f => f.startsWith('shell-'));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^shell-\d{4}-\d{2}-\d{2}\.ndjson$/);
  });

  test('run event carries outcome + exitCode + approvalKey', async () => {
    const res = await runShell({ command: ['echo', 'audit-2'], cwd });
    const files = readdirSync(auditRoot);
    const content = readFileSync(join(auditRoot, files[0]!), 'utf8');
    const lines = content.trim().split('\n').map(l => JSON.parse(l));
    const runEvent = lines.find(l => l.type === 'run');
    expect(runEvent).toBeTruthy();
    expect(runEvent.outcome).toBe('exit');
    expect(runEvent.exitCode).toBe(0);
    expect(runEvent.approvalKey).toBe(res.approvalKey);
  });
});

describe('shell-primitive audit-log: programmatic sink', () => {
  let cwd: string;
  let events: AuditEvent[];

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'shell-audit-sink-'));
    events = [];
    setAuditSinkForTesting(ev => events.push(ev));
    _resetApprovalCacheForTesting();
    setShellApprover(null);
  });

  afterEach(() => {
    try { rmSync(cwd, { recursive: true, force: true }); } catch { /* ignore */ }
    setAuditSinkForTesting(null);
    _resetApprovalCacheForTesting();
    setShellApprover(null);
  });

  test('no approval → only a run event', async () => {
    await runShell({ command: ['echo', 'x'], cwd });
    expect(events.map(e => e.type)).toEqual(['run']);
  });

  test('first-time + allow-session → approval(approver) + run; 2nd call → approval(cache) + run', async () => {
    setShellApprover(makeAutoApprover('allow-session'));
    await runShell({ command: ['echo', 'x'], cwd, approval: 'first-time' });
    await runShell({ command: ['echo', 'x'], cwd, approval: 'first-time' });
    const types = events.map(e => e.type);
    expect(types).toEqual(['approval', 'run', 'approval', 'run']);
    // Sources progress approver → cache.
    const sources = events.filter(e => e.type === 'approval').map(e =>
      (e as { source: string }).source);
    expect(sources).toEqual(['approver', 'cache']);
  });

  test('missing approver → approval(fail-closed) + run(denied)', async () => {
    await runShell({ command: ['echo', 'x'], cwd, approval: 'first-time' });
    expect(events.length).toBe(2);
    const approval = events[0];
    if (approval?.type !== 'approval') throw new Error('expected approval event');
    expect(approval.source).toBe('fail-closed');
    expect(approval.decision).toBe('deny-once');
    const run = events[1];
    if (run?.type !== 'run') throw new Error('expected run event');
    expect(run.outcome).toBe('denied');
  });

  test('run event includes truncated when output exceeds budget', async () => {
    await runShell({
      command: ['bash', '-c', 'printf "%.0s." {1..1000}'],
      cwd,
      maxOutputChars: 50,
    });
    const run = events.find(e => e.type === 'run');
    if (run?.type !== 'run') throw new Error('expected run event');
    expect(run.truncated).toBe(true);
  });

  test('spawn-error still emits a run event', async () => {
    await runShell({ command: ['/nope/definitely-not-a-binary'], cwd });
    const run = events.find(e => e.type === 'run');
    if (run?.type !== 'run') throw new Error('expected run event');
    expect(run.outcome).toBe('spawn-error');
  });

  test('approval: always re-prompts every call, each emits approval+run', async () => {
    setShellApprover(makeAutoApprover('allow-once'));
    await runShell({ command: ['echo', 'x'], cwd, approval: 'always' });
    await runShell({ command: ['echo', 'x'], cwd, approval: 'always' });
    const types = events.map(e => e.type);
    expect(types).toEqual(['approval', 'run', 'approval', 'run']);
    const sources = events.filter(e => e.type === 'approval').map(e =>
      (e as { source: string }).source);
    expect(sources).toEqual(['approver', 'approver']);
  });

  test('audit timestamps are ISO strings', async () => {
    await runShell({ command: ['echo', 'x'], cwd });
    const run = events[0];
    expect(typeof run?.ts).toBe('string');
    expect(new Date(run!.ts).toString()).not.toBe('Invalid Date');
  });

  test('sink errors never escape runShell', async () => {
    setAuditSinkForTesting(() => { throw new Error('sink exploded'); });
    const res = await runShell({ command: ['echo', 'x'], cwd });
    expect(res.outcome).toBe('exit');
  });
});
