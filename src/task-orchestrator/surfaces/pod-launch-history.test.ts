import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendRunLedgerEntry, runLedgerDir } from '../../self-implement/run-ledger.js';
import { packageVersion } from '../../version/code-revision.js';
import type { UserConfig } from '../../user-config.js';
import { podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';
import { POD_LAUNCH_FINISHED_EVENT, POD_LAUNCH_STARTED_EVENT, readPodLaunchHistory } from './pod-launch-history.js';

const CREDS = () => ({ elanousAuth: '{"m":1}', codexAuth: '{"c":1}', ghToken: 'gho_x' });
const REQUESTED = Date.parse('2026-10-22T05:06:07.000Z');

/** Fake kubectl: records every call and answers the Job verdict, the container exit and the logs. No real cluster. */
function fakeKubectl(condition: 'Complete' | 'Failed', exitCode: number, logs: string) {
  const calls: Array<{ args: string; input?: string }> = [];
  const k: Kubectl = (args, input) => {
    calls.push({ args: args.join(' '), ...(input ? { input } : {}) });
    if (args.includes('current-context')) return { status: 0, stdout: 'test-context\n', stderr: '' };
    if (args.includes('pods') && args.some((a) => a.includes('status.containerStatuses') || a.includes('.terminated.exitCode'))) {
      return { status: 0, stdout: `2026-10-22T05:10:00Z\t${exitCode === 0 ? 'Completed' : 'Error'}\t${exitCode}\n`, stderr: '' };
    }
    if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (args.some((a) => a.includes('conditions[?(@.type=="Failed")].reason'))) return { status: 0, stdout: condition === 'Failed' ? 'BackoffLimitExceeded' : '', stderr: '' };
    if (args.includes('get') && args.includes('job')) return { status: 0, stdout: condition, stderr: '' };
    if (args.includes('logs')) return { status: 0, stdout: logs, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { k, calls };
}

async function launch(root: string, parentRunId: string, condition: 'Complete' | 'Failed', exitCode: number, extraEnv: Record<string, string> = {}) {
  const { k, calls } = fakeKubectl(condition, exitCode, condition === 'Complete' ? '{"ok":true,"stage":"complete"}\n' : '{"ok":false,"stage":"error","error":"boom"}\n');
  const result = await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS, now: () => REQUESTED,
    imageCommit: 'abcdef0123456789abcdef0123456789abcdef01',
    budgetSnapshot: () => undefined, fallbackConfig: () => ({ llm: {} }) as UserConfig, openGatewayConfig: () => ({ llm: {} }) as UserConfig,
    lookupOpenPrByBranch: () => ({ status: 'not-found', reason: 'test-fixture' }),
    env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: parentRunId, ELANOUS_POD_OWNER_KIND: 'seat', ELANOUS_POD_OWNER_ID: 'MK',
      ELANOUS_TASK_CARD_ID: 'card-7', ELANOUS_POD_SLOT_ID: 'POD-LAUNCH-PROVENANCE', ELANOUS_HARNESS_ENTRANCE: 'cli-harness-say', ...extraEnv } })(
    { feature: 'Implement provenance history\nsecond line', spaceId: `prov-${condition.toLowerCase()}` }).done;
  const job = calls.filter((call) => call.args.endsWith('apply -f -')).map((call) => JSON.parse(call.input!)).find((m) => m.kind === 'Job');
  return { result, job };
}

describe('POD-LAUNCH-PROVENANCE · si-task Job carries the provenance set on three layers', () => {
  test('labels ⊕ annotations ⊕ child env hold ★6 ⊕ character·entrance·cell·version·commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-si-provenance-'));
    try {
      const { result, job } = await launch(root, 'run-si-provenance-parent', 'Complete', 0);
      expect(result.exitCode).toBe(0);
      const labels = job.metadata.labels as Record<string, string>;
      const template = job.spec.template.metadata as { labels: Record<string, string>; annotations: Record<string, string> };
      const annotations = job.metadata.annotations as Record<string, string>;
      const env = job.spec.template.spec.containers[0].env as Array<{ name: string; value: string }>;
      const runEnv = env.find((entry) => entry.name === 'ELANOUS_RUN_ID')!.value;
      const expected: Record<string, string> = {
        'actor-kind': 'seat', actor: 'MK', kind: 'si-task', run: runEnv, phase: 'impl',
        'requested-at': '2026-10-22T05:06:07.000Z', character: 'ta-child', entrance: 'harness-say',
        cell: 'POD-LAUNCH-PROVENANCE', version: packageVersion(), commit: 'abcdef0123456789abcdef0123456789abcdef01',
        parent: 'run-si-provenance-parent',
      };
      for (const [key, value] of Object.entries(expected)) {
        expect(annotations[`elanous.ai/${key}`]).toBe(value);
        expect(template.annotations[`elanous.ai/${key}`]).toBe(value);
        expect(env).toContainEqual({ name: `ELANOUS_POD_${key.toUpperCase().replaceAll('-', '_')}`, value });
        expect(labels[`elanous.ai/${key}`]).toBeDefined();
        expect(template.labels[`elanous.ai/${key}`]).toBe(labels[`elanous.ai/${key}`]);
      }
      expect(labels['elanous.ai/actor']).toBe('mk');
      expect(labels['elanous.ai/run']).toBe(runEnv.slice(0, 8));
      expect(labels['elanous.ai/commit']).toBe('abcdef01');
      expect(annotations['elanous.ai/reason']).toContain('card-7');
      // ELANOUS_POD_POOL is read as pool config inside the child — the si-task set never carries it.
      expect(env.some((entry) => entry.name === 'ELANOUS_POD_POOL')).toBe(false);
      // existing labels survive next to the new set
      expect(labels['elanous.task-card']).toBe('card-7');
      expect(annotations['elanous.dev/attempt']).toBe('1');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('POD-LAUNCH-PROVENANCE · fail-closed', () => {
  test('a secret in an identity field refuses the si-task Job before kubectl apply', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-si-refuse-'));
    try {
      const secretCell = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
      const { k, calls } = fakeKubectl('Complete', 0, '');
      const result = await podSelfImplementSpawn({ kubectl: k, sleep: async () => {}, credentials: CREDS,
        budgetSnapshot: () => undefined, fallbackConfig: () => ({ llm: {} }) as UserConfig, openGatewayConfig: () => ({ llm: {} }) as UserConfig,
        lookupOpenPrByBranch: () => ({ status: 'not-found', reason: 'test-fixture' }),
        env: { ELANOUS_STATE_DIR: root, ELANOUS_RUN_ID: 'run-si-refuse', ELANOUS_POD_SLOT_ID: secretCell } })({ feature: 'x', spaceId: 'prov-refuse' }).done;
      expect(result.exitCode).toBe(1);
      expect(result.error?.code).toBe('pod-provenance');
      expect(calls.some((call) => call.args.endsWith('apply -f -') && JSON.parse(call.input!).kind === 'Job')).toBe(false);
      expect(calls.some((call) => call.args.includes('delete') && call.args.includes('secret'))).toBe(true);
      expect(JSON.stringify(result)).not.toContain(secretCell);
      expect(readPodLaunchHistory('run-si-refuse', runLedgerDir(root))).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('POD-LAUNCH-PROVENANCE · append-only started/finished history', () => {
  test('a completed Job leaves one started and one finished row, read back by runId', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-si-history-'));
    try {
      const { job } = await launch(root, 'run-si-history-ok', 'Complete', 0);
      const history = readPodLaunchHistory('run-si-history-ok', runLedgerDir(root));
      expect(history).toHaveLength(1);
      const [record] = history;
      expect(record!.job).toBe(job.metadata.name);
      expect(record!.startedAt).toEqual(expect.any(String));
      expect(record!.provenance).toMatchObject({ 'actor-kind': 'seat', actor: 'MK', kind: 'si-task', phase: 'impl',
        'requested-at': '2026-10-22T05:06:07.000Z', entrance: 'harness-say', cell: 'POD-LAUNCH-PROVENANCE' });
      // The Complete path does not read the container code; it stays unknown (null), never a filled-in 0.
      expect(record!.finished).toMatchObject({ phase: 'complete', exitCode: null, reason: 'complete' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('a failed Job records phase · exitCode · reason on its finished row', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-si-history-fail-'));
    try {
      await launch(root, 'run-si-history-fail', 'Failed', 2);
      const [record] = readPodLaunchHistory('run-si-history-fail', runLedgerDir(root));
      expect(record!.provenance.actor).toBe('MK');
      expect(record!.finished).toMatchObject({ phase: 'failed', exitCode: 2, reason: 'BackoffLimitExceeded' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('reader pairs rows per job·run, keeps order, and shows a finished row without a start as startedAt=null', () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-si-history-read-'));
    const dir = runLedgerDir(root);
    try {
      const runId = 'run-si-history-read';
      const row = (event: string, data: Record<string, unknown>, timestamp: string) => appendRunLedgerEntry({ runId, event, data, timestamp }, dir);
      row(POD_LAUNCH_STARTED_EVENT, { job: 'j1', run: 'run-a', attempt: 1, provenance: { actor: 'MK', reason: 'first' } }, '2026-10-22T01:00:00.000Z');
      row('pod-job-image', { job: 'j1' }, '2026-10-22T01:00:01.000Z');
      row(POD_LAUNCH_FINISHED_EVENT, { job: 'j1', run: 'run-a', phase: 'failed', exitCode: 137, reason: 'OOMKilled' }, '2026-10-22T01:10:00.000Z');
      row(POD_LAUNCH_STARTED_EVENT, { job: 'j1', run: 'run-b', attempt: 2, provenance: { actor: 'MK', reason: 'oom retry' } }, '2026-10-22T01:11:00.000Z');
      row(POD_LAUNCH_FINISHED_EVENT, { job: 'j2', run: 'run-c', phase: 'complete', exitCode: 0, reason: 'complete' }, '2026-10-22T01:20:00.000Z');
      const history = readPodLaunchHistory(runId, dir);
      expect(history.map((r) => [r.job, r.run, r.attempt, r.startedAt, r.finished?.phase ?? null])).toEqual([
        ['j1', 'run-a', 1, '2026-10-22T01:00:00.000Z', 'failed'],
        ['j1', 'run-b', 2, '2026-10-22T01:11:00.000Z', null],
        ['j2', 'run-c', null, null, 'complete'],
      ]);
      expect(history[0]!.finished).toEqual({ at: '2026-10-22T01:10:00.000Z', phase: 'failed', exitCode: 137, reason: 'OOMKilled' });
      expect(history[0]!.provenance).toEqual({ actor: 'MK', reason: 'first' });
      expect(readPodLaunchHistory('run-si-history-absent', dir)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
