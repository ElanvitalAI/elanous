import { describe, expect, test } from 'bun:test';
import { dispatchPodSelfSend, finishPodFragment, listPodFragmentsForRun, readPodFragment, resolveSelfSendTarget, writePodFragment, type SelfSendTargetDeps } from './self-send-target.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function deps(overrides: Partial<SelfSendTargetDeps> = {}): SelfSendTargetDeps {
  return {
    getPtyManifest: () => null,
    listPtyManifestRows: () => [],
    ...overrides,
  };
}

test('Pod dispatch uses the recorded target, refuses a finished fragment, and leaves local target untouched', () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-dispatch-'));
  const env = { ELANOUS_STATE_DIR: root };
  try {
    expect(dispatchPodSelfSend('local', { stop: true }, () => { throw new Error('local must not exec'); }, env)).toBeNull();
    const record = { spaceId: 'pod-a', context: 'ctx', namespace: 'ns', job: 'job-a', inboxDir: '/tmp/inbox' };
    writePodFragment(record, env);
    expect(readPodFragment('pod-a', env)).toEqual(record);
    let args: readonly string[] = [];
    const result = dispatchPodSelfSend('pod-a', { memo: { version: 1, kind: 'supervisor', urgency: 'normal', body: 'hello' } }, (a) => { args = a; return { status: 0, stdout: '', stderr: '' }; }, env);
    expect(result).toEqual({ job: 'job-a' });
    expect(args).toContain('job/job-a');
    finishPodFragment('pod-a', env);
    expect(readPodFragment('pod-a', env)).toBeNull();
    expect(() => dispatchPodSelfSend('pod-a', { stop: true }, () => { throw new Error('must not exec'); }, env)).toThrow('self send 대상 조각이 이미 끝났다: pod-a');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('listPodFragmentsForRun finds only unfinished records with exact child or parent run IDs', () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-run-target-'));
  const env = { ELANOUS_STATE_DIR: root };
  const base = { context: 'ctx', namespace: 'ns', job: 'job', inboxDir: '/tmp/inbox' };
  const runId = 'run-123';
  try {
    const child = { ...base, spaceId: 'task-child', runId };
    const parent = { ...base, spaceId: 'task-parent', runId: 'run-other', parentRunId: runId };
    writePodFragment(child, env);
    writePodFragment(parent, env);
    writePodFragment({ ...base, spaceId: 'task-other', runId: 'run-1234' }, env);
    writePodFragment({ ...base, spaceId: 'task-finished', runId }, env);
    finishPodFragment('task-finished', env);
    writePodFragment({ ...base, spaceId: 'task-legacy' }, env);
    expect(readPodFragment('task-legacy', env)).toEqual({ ...base, spaceId: 'task-legacy' });
    expect(listPodFragmentsForRun(runId, env).map((record) => record.spaceId).sort()).toEqual(['task-child', 'task-parent']);
    expect(listPodFragmentsForRun('run-1234', env).map((record) => record.spaceId)).toEqual(['task-other']);
    expect(listPodFragmentsForRun('run-missing', env)).toEqual([]);
    expect(listPodFragmentsForRun('run-123/..', env)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

describe('resolveSelfSendTarget', () => {
  test('refuses a TUI self-report with no manifest hint', () => {
    expect(resolveSelfSendTarget('tui:84650', deps())).toEqual({
      kind: 'refuse',
      reason: 'tui-self-report-has-no-inbox-reader',
    });
  });

  test('refuses a TUI self-report with its PID-matched space hint', () => {
    expect(resolveSelfSendTarget('tui:84650', deps({
      listPtyManifestRows: () => [{ id: 'pty_a', spaceId: 'dev-run-x', ptyPid: 84650 }],
    }))).toEqual({
      kind: 'refuse',
      reason: 'tui-self-report-has-no-inbox-reader',
      hint: 'dev-run-x',
    });
  });

  test('resolves a PTY id through its manifest space', () => {
    expect(resolveSelfSendTarget('pty_a', deps({
      getPtyManifest: () => ({ spaceId: 'dev-run-x' }),
    }))).toEqual({
      kind: 'space',
      spaceId: 'dev-run-x',
      via: 'pty',
      ptyId: 'pty_a',
    });
  });

  test('refuses a PTY manifest without a space', () => {
    expect(resolveSelfSendTarget('pty_b', deps({
      getPtyManifest: () => ({ spaceId: '' }),
    }))).toEqual({ kind: 'refuse', reason: 'pty-has-no-space' });
  });

  test('passes through an ordinary space without calling dependencies', () => {
    let calls = 0;
    expect(resolveSelfSendTarget('dev-run-x', deps({
      getPtyManifest: () => { calls += 1; return null; },
      listPtyManifestRows: () => { calls += 1; return []; },
    }))).toEqual({ kind: 'space', spaceId: 'dev-run-x' });
    expect(calls).toBe(0);
  });
});
