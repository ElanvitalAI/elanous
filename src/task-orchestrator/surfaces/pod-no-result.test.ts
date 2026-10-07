import { expect, test } from 'bun:test';
import { podNoResultDiagnostic } from './pod-artifact-return.js';
import { podJobManifest, podJobName, podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { runLedgerDir, runLedgerPath } from '../../self-implement/run-ledger.js';
import { debug } from '../../debug/log.js';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Pod child keeps the canonical substrate marker for review preservation', () => {
  const manifest = podJobManifest({ name: 'review-failure', namespace: 'elanous-test', image: 'test', repoUrl: 'test', args: [], passEnv: [], deadlineSeconds: 60 }) as { spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value: string }> }> } } } };
  expect(manifest.spec.template.spec.containers[0]!.env).toContainEqual({ name: 'ELANOUS_SUBSTRATE', value: 'pod' });
});

test('exit 1 without a terminal line retains last ledger stage, round and verbatim must-fix', () => {
  const ledger = [
    { event: 'reviewed', data: { round: 3, verdict: 'fail', mustFix: 1, findingIds: ['MF-1'] } },
    { event: 'pod-ledger-incomplete', data: { reason: 'no terminal' } },
  ].map((entry) => JSON.stringify(entry)).join('\n');
  expect(podNoResultDiagnostic(ledger)).toBe('child terminal result missing; last ledger stage=reviewed; round=3; mustFix=1 ["MF-1"]');
  expect(podNoResultDiagnostic('')).toBeNull();
  expect(podNoResultDiagnostic(`${JSON.stringify({ event: 'reviewed', data: { round: 3, mustFix: 1, findingIds: ['MF-1'] } })}\n${JSON.stringify({ event: 'pr-opening', data: {} })}`))
    .toBe('child terminal result missing; last ledger stage=pr-opening; round=3; mustFix=1 ["MF-1"]');
});

test('failed Pod exit without a result classifies from the returned ledger instead of a silent error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-terminal-diagnostic-'));
  let childRunId = '';
  const previous = process.cwd();
  const finished: Record<string, unknown>[] = [];
  const diagnostics: Record<string, unknown>[] = [];
  const off = debug.registerSink({ name: 'pod-terminal-ledger-context', emit: (record) => {
    if (record.category !== 'self-implement.pod') return;
    if (record.event === 'job-finished') finished.push(record.data as Record<string, unknown>);
    if (record.event === 'no-result-ledger-diagnostic') diagnostics.push(record.data as Record<string, unknown>);
  } });
  const kubectl: Kubectl = (args, input) => {
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
    if (args.includes('apply') && input) {
      const manifest = JSON.parse(input);
      if (manifest.kind === 'Job') childRunId = manifest.spec.template.spec.containers[0].env.find((entry: { name: string }) => entry.name === 'ELANOUS_RUN_ID').value;
    }
    if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
    if (args.some((arg) => arg.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: '', stderr: '' };
    if (args.includes('get') && args.includes('pods')) return { status: 0, stdout: '2026-10-05T00:45:29Z\tError\t1\n', stderr: '' };
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Failed', stderr: '' };
    if (args.includes('logs')) {
      const ledger = JSON.stringify({ runId: childRunId, event: 'reviewed', data: { round: 3, mustFix: 1, findingIds: ['MF-1'] } }) + '\n';
      return { status: 0, stdout: `ELANOUS_RUN_LEDGER ${childRunId} 1/1 ${gzipSync(ledger).toString('base64')}\nchild exit 1 without terminal JSON\n`, stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    execFileSync('git', ['init', '-q', root]);
    writeFileSync(join(root, 'GOAL.md'), '# Goal\n');
    process.chdir(root);
    const result = await podSelfImplementSpawn({ kubectl, credentials: () => ({ elanousAuth: '{"m":1}', codexAuth: '{"c":1}', ghToken: 'gho_x' }), env: { ELANOUS_STATE_DIR: root, ELANOUS_POD_GOAL_DOC: 'GOAL.md' } })({ feature: 'x', spaceId: 'terminal-diagnostic' }).done;
    expect(result.exitCode).toBe(1);
    expect(result.disposition).toBeUndefined();
    expect(result.error?.message).toContain('failed (container=Error/1)');
    expect(result.error?.message).toContain('last ledger stage=reviewed; round=3; mustFix=1 ["MF-1"]');
    expect(result.error?.message).toContain('childError=no-result-line');
    expect(finished).toEqual([expect.objectContaining({ childError: 'no-result-line' })]);
    expect(diagnostics).toEqual([expect.objectContaining({ childRunId, diagnostic: expect.stringContaining('round=3; mustFix=1 ["MF-1"]') })]);
    expect(readFileSync(join(root, 'GOAL.md'), 'utf8')).toContain('stage: aborted\n  outcome: abandoned\n  ok: false');
  } finally { off(); process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
});

// POD-NORESULT: Jobs run with backoffLimit 0, so a child exit 1 is always «BackoffLimitExceeded» — it still gets the ledger diagnostic.
test('BackoffLimitExceeded keeps pod-job-failed and adds the no-result ledger diagnostic when the child exited 1', async () => {
  const kubectl: Kubectl = (args) => {
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
    if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
    if (args.some((arg) => arg.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: 'BackoffLimitExceeded', stderr: '' };
    if (args.includes('get') && args.includes('pods')) return { status: 0, stdout: '2026-10-05T00:45:29Z\tError\t1\n', stderr: '' };
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Failed', stderr: '' };
    if (args.includes('logs')) return { status: 0, stdout: 'child exit 1 without terminal JSON', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = await podSelfImplementSpawn({ kubectl, credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'gh' }), env: {} })({ feature: 'x', spaceId: 'backoff-no-result-preserved' }).done;
  expect(result.exitCode).toBe(1);
  expect(result.error).toEqual({ code: 'pod-job-failed', message: `Job ${podJobName('backoff-no-result-preserved')} failed (BackoffLimitExceeded, container=Error/1) — childError=no-result-line · reason=사유 못 읽음: 로그에 읽을 수 있는 오류 줄 없음 · child terminal result missing; last ledger stage=unknown; round=unknown; mustFix=unknown` });
});

test('a failed App push retries next poll with a newly verified token; human Job retains its token', async () => {
  const start = Date.now();
  let clock = start;
  let polls = 0;
  let minted = 0;
  let fallbackPushes = 0;
  const pushed: string[] = [];
  const kubectl: Kubectl = (args, input) => {
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
    if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
    if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: ++polls > 3 ? 'Complete' : '', stderr: '' };
    if (args.includes('exec') && args.includes('--with-token')) return { status: 1, stdout: '', stderr: '' };
    if (args.includes('exec') && args.includes('bun')) {
      pushed.push(input ?? '');
      return { status: ++fallbackPushes === 1 ? 1 : 0, stdout: '', stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = await podSelfImplementSpawn({
    kubectl, credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'human-token' }), env: {}, now: () => clock,
    sleep: async () => { clock += 60_000; },
    githubInstallation: () => ({ token: `app-${++minted}`, expiresAt: start + (minted === 1 ? 11 : 60) * 60_000 }),
    githubRepositories: async () => ['ElanvitalAI/elanous'],
  })({ feature: 'x', spaceId: 'fresh-verified-token' }).done;
  expect(result.exitCode).toBe(0);
  expect(minted).toBe(3);
  expect(pushed).toEqual(['app-2\n', 'app-3\n']);
  let humanSecret: Record<string, string> | undefined;
  let humanJob: Record<string, unknown> | undefined;
  const human: Kubectl = (args, input) => {
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
    if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
    if (args.includes('apply') && input) {
      const manifest = JSON.parse(input);
      if (manifest.kind === 'Secret') humanSecret = manifest.stringData;
      if (manifest.kind === 'Job') humanJob = manifest;
    }
    if (args.includes('exec')) throw new Error('human-token Job must not receive App push');
    if (args.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Complete', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  await podSelfImplementSpawn({ kubectl: human, credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'human-token' }), env: {}, githubInstallation: () => null })({ feature: 'x', spaceId: 'human-token-preserved' }).done;
  expect(humanSecret?.['gh-token']).toBe('human-token');
  const child = (humanJob as { spec: { template: { spec: { containers: Array<{ env: Array<{ name: string; value?: string }> }> } } } }).spec.template.spec.containers[0]!;
  expect(child.env).toContainEqual({ name: 'ELANOUS_SUBSTRATE', value: 'pod' });
  expect(child.env.some((entry) => entry.name === 'ELANOUS_POD_REVIEW_BLOCKED_DRAFT')).toBe(false);
});

test('failed Pod without a child ledger keeps one incomplete marker and one host goal record', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pod-no-ledger-preserved-'));
  const previous = process.cwd();
  let child = '';
  const kubectl: Kubectl = (args, input) => {
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context', stderr: '' };
    if (args.includes('apply') && input) {
      const manifest = JSON.parse(input);
      if (manifest.kind === 'Job') child = manifest.spec.template.spec.containers[0].env.find((entry: { name: string }) => entry.name === 'ELANOUS_RUN_ID').value;
    }
    if (args.some((arg) => arg.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: '' };
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: 'Failed', stderr: '' };
    if (args.includes('logs')) return { status: 0, stdout: 'pod crashed before a result', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  try {
    execFileSync('git', ['init', '-q', root]);
    writeFileSync(join(root, 'GOAL.md'), '# Goal\n');
    process.chdir(root);
    const result = await podSelfImplementSpawn({ kubectl, credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'gh' }), env: { ELANOUS_POD_GOAL_DOC: 'GOAL.md', ELANOUS_STATE_DIR: root } })({ feature: 'x', spaceId: 'no-child-ledger' }).done;
    expect(result.error?.message).toContain('childError=no-result-line');
    expect(result.error?.message).not.toContain('last ledger stage=pod-ledger-incomplete');
    expect(existsSync(runLedgerPath(child, runLedgerDir(root)))).toBe(true);
    const entries = readFileSync(runLedgerPath(child, runLedgerDir(root)), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ event: 'pod-ledger-incomplete', data: { reason: 'child-ledger-missing' } });
    const goal = readFileSync(join(root, 'GOAL.md'), 'utf8');
    expect(goal.match(/- runId:/g)).toHaveLength(1);
    expect(goal).toContain(`- runId: ${child}\n  stage: aborted\n  outcome: pod-no-result\n  ok: false`);
  } finally { process.chdir(previous); rmSync(root, { recursive: true, force: true }); }
});
