import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { appendRunLedgerEntry, runLedgerDir, runLedgerPath } from '../../self-implement/run-ledger.js';
import { podJobName, podSelfImplementSpawn, type Kubectl } from './self-implement-pod.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureFailedPodJobs } from './pod-ledger-events.js';

const placement = { host: 'node-b', context: 'k3d-elanous-pool', namespace: 'elanous-test' };
const jobs = ['si-incident', 'si-pool-node-b'];

function stage(rows: Array<{ event: string; data: Record<string, unknown> }>) {
  const dir = mkdtempSync(join(tmpdir(), 'pod-autopsy-'));
  const ledger = join(dir, 'incident.jsonl');
  writeFileSync(ledger, rows.map(row => JSON.stringify({ runId: 'incident', ...row })).join('\n') + '\n');
  const calls: Array<{ host: string; args: string[] }> = [];
  const kubectl = (host: string, args: readonly string[]) => {
    calls.push({ host, args: [...args] });
    if (host !== placement.host || args[0] !== '--context' || args[1] !== placement.context || args[2] !== '-n' || args[3] !== placement.namespace) return { status: 1, stdout: '', stderr: 'wrong placement' };
    const job = args[5] === 'pods' ? args[7]?.replace('job-name=', '') : args[4] === 'logs' ? args[5]?.replace(/^pod\//, '').replace(/-pod$/, '') : args[6];
    if (!jobs.includes(job ?? '')) return { status: 1, stdout: '', stderr: 'Error from server (NotFound): jobs not found' };
    if (args[4] === 'get' && args[5] === 'job') return { status: 0, stdout: JSON.stringify({ metadata: { name: job, uid: `uid-${job}` }, status: { conditions: [{ type: 'Failed' }] } }), stderr: '' };
    if (args[4] === 'get' && args[5] === 'pods') return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: `${job}-pod`, ownerReferences: [{ uid: `uid-${job}` }] } }] }), stderr: '' };
    if (args[4] === 'logs') return { status: 0, stdout: `${job} log`, stderr: '' };
    return { status: 1, stdout: '', stderr: 'unsupported' };
  };
  const record = (event: string, data: Record<string, unknown>) => writeFileSync(ledger, JSON.stringify({ runId: 'incident', event, data, timestamp: new Date(1000).toISOString() }) + '\n', { flag: 'a' });
  return { dir, ledger, calls, kubectl, record, rows: () => readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event: string; data: Record<string, unknown> }) };
}

const entered = (job: string, extra: Record<string, unknown> = {}) => ({ event: 'pod-job-applied', data: { job, childRunId: `run-${job}`, jobUid: `uid-${job}`, ...placement, ...extra } });

describe('AUTOPSY-FAILURE-IMMEDIATE-CAPTURE', () => {
  test('mbp incident와 pool-node-b 두 Job을 ledger placement에서 수집하고 기존 증거를 보존한다', () => {
    const s = stage([{ event: 'incident', data: { host: 'mbp' } }, ...jobs.map(job => entered(job))]);
    expect(s.rows()[0]?.data).toMatchObject({ host: 'mbp' });
    for (const job of jobs) captureFailedPodJobs({ runId: 'incident', job, ledgerPath: s.ledger, artifactDir: s.dir, kubectl: s.kubectl, record: s.record, now: () => 1000 });
    const results = s.rows().filter(row => row.event === 'pod-failure-capture');
    expect(results).toHaveLength(2);
    expect(results.map(row => row.data.outcome)).toEqual(['collected', 'collected']);
    for (const row of results) {
      expect(row.data).toMatchObject({ runId: 'incident', ...placement, capturedAt: new Date(1000).toISOString() });
      expect(readFileSync(String(row.data.jobEvidence), 'utf8')).toContain(String(row.data.job));
      expect(readFileSync(String(row.data.podEvidence), 'utf8')).toContain(String(row.data.job));
      expect(readFileSync(String(row.data.logEvidence), 'utf8')).toContain(String(row.data.job));
      expect(row.data.childRunId).toBe(`run-${row.data.job}`);
    }
    expect(s.calls).toHaveLength(6);
    expect(s.calls.every(call => call.host === 'node-b' && call.args[1] === placement.context && call.args[3] === placement.namespace)).toBe(true);
    const firstEvidence = String(results[0]!.data.jobEvidence);
    expect(readFileSync(firstEvidence, 'utf8')).toContain(jobs[0]!);
    captureFailedPodJobs({ runId: 'incident', job: jobs[0]!, ledgerPath: s.ledger, artifactDir: s.dir, kubectl: s.kubectl, record: s.record, now: () => 2000 });
    expect(readFileSync(firstEvidence, 'utf8')).toContain(jobs[0]!);
    expect(s.calls).toHaveLength(6);
    expect(s.rows().filter(row => row.event === 'pod-failure-capture')).toHaveLength(2);
  });

  test('collected 원장 뒤 증거 파일이 사라지면 다시 수집해 유실을 복구한다', () => {
    const job = jobs[0]!;
    const s = stage([entered(job)]);
    const input = { runId: 'incident', job, ledgerPath: s.ledger, artifactDir: s.dir, kubectl: s.kubectl, record: s.record };
    captureFailedPodJobs(input);
    const first = s.rows().at(-1)?.data;
    expect(first?.outcome).toBe('collected');
    rmSync(String(first?.logEvidence));

    captureFailedPodJobs(input);
    const captures = s.rows().filter(row => row.event === 'pod-failure-capture');
    expect(captures).toHaveLength(2);
    expect(captures[1]?.data).toMatchObject({ outcome: 'collected', reason: 'job-failed' });
    expect(readFileSync(String(captures[1]?.data.logEvidence), 'utf8')).toBe(`${job} log`);
    expect(s.calls).toHaveLength(6);
  });

  test('서로 다른 placement와 불완전 placement는 kubectl 없이 fail-closed', () => {
    for (const rows of [[entered(jobs[0]!), entered(jobs[0]!, { host: 'mbp' })], [entered(jobs[0]!, { context: '' })]]) {
      const s = stage(rows);
      captureFailedPodJobs({ runId: 'incident', job: jobs[0]!, ledgerPath: s.ledger, artifactDir: s.dir, kubectl: s.kubectl, record: s.record, now: () => 1000 });
      expect(s.calls).toHaveLength(0);
      expect(s.rows().at(-1)?.data).toMatchObject({ outcome: 'failed', reason: rows.length === 2 ? 'placement-conflict' : 'placement-incomplete' });
    }
  });

  test('같은 Job의 childRunId 누락·불명확한 귀속은 다른 유효 행이 있어도 조회 없이 거부한다', () => {
    const job = jobs[0]!;
    for (const extra of [{ childRunId: undefined }, { childRunId: 'other-run', host: 'mbp' }]) {
      const s = stage([entered(job), entered(job, extra)]);
      captureFailedPodJobs({ runId: 'incident', job, childRunId: `run-${job}`, ledgerPath: s.ledger, artifactDir: s.dir, kubectl: s.kubectl, record: s.record });
      expect(s.calls).toHaveLength(0);
      expect(s.rows().at(-1)?.data).toMatchObject({ outcome: 'failed', reason: extra.childRunId ? 'placement-conflict' : 'placement-incomplete' });
    }
  });

  test('Pod 조회 실패 후 Job 상태가 달라져도 이전 Job 증거를 보존하고 나머지를 회수한다', () => {
    const job = jobs[0]!;
    const s = stage([entered(job)]);
    let first = true;
    const changingKubectl = (host: string, args: readonly string[]) => {
      if (args[5] === 'job' && !first) return { status: 0, stdout: JSON.stringify({ metadata: { name: job, uid: `uid-${job}` }, status: { conditions: [{ type: 'Failed', reason: 'Updated' }] } }), stderr: '' };
      if (args[5] === 'pods' && first) return { status: 1, stdout: '', stderr: 'temporarily unavailable' };
      return s.kubectl(host, args);
    };
    const input = { runId: 'incident', job, childRunId: `run-${job}`, ledgerPath: s.ledger, artifactDir: s.dir, kubectl: changingKubectl, record: s.record };
    captureFailedPodJobs(input);
    const failure = s.rows().at(-1)?.data;
    expect(failure).toMatchObject({ outcome: 'failed', reason: 'pods-read-failed' });
    const original = readFileSync(String(failure?.jobEvidence), 'utf8');
    first = false;
    captureFailedPodJobs(input);
    const result = s.rows().at(-1)?.data;
    expect(result).toMatchObject({ outcome: 'collected', jobEvidence: failure?.jobEvidence, ...placement });
    expect(readFileSync(String(result?.jobEvidence), 'utf8')).toBe(original);
    expect(readFileSync(String(result?.podEvidence), 'utf8')).toContain(`${job}-pod`);
    expect(readFileSync(String(result?.logEvidence), 'utf8')).toBe(`${job} log`);
  });

  test('같은 Job명의 다음 childRunId는 별도 증거로 수집한다', () => {
    const job = jobs[0]!;
    const s = stage([entered(job)]);
    captureFailedPodJobs({ runId: 'incident', job, childRunId: `run-${job}`, ledgerPath: s.ledger, artifactDir: s.dir, kubectl: s.kubectl, record: s.record, now: () => 1000 });
    s.record('pod-job-applied', { ...entered(job, { childRunId: 'retry-run' }).data });
    captureFailedPodJobs({ runId: 'incident', job, childRunId: 'retry-run', ledgerPath: s.ledger, artifactDir: s.dir, kubectl: s.kubectl, record: s.record, now: () => 2000 });
    const results = s.rows().filter(row => row.event === 'pod-failure-capture');
    expect(results.map(row => row.data.outcome)).toEqual(['collected', 'collected']);
    expect(results.map(row => row.data.childRunId)).toEqual([`run-${job}`, 'retry-run']);
    expect(results[0]?.data.jobEvidence).not.toBe(results[1]?.data.jobEvidence);
    expect(s.calls).toHaveLength(6);
  });

  test('이미 수집된 증거는 다른 bytes로 덮지 않고 실패를 기록한다', () => {
    const s = stage([entered(jobs[0]!)]);
    const evidenceDir = join(s.dir, 'pod-failure-capture', 'incident', jobs[0]!, `run-${jobs[0]}`);
    mkdirSync(evidenceDir, { recursive: true });
    const path = join(evidenceDir, 'job.json');
    writeFileSync(path, 'existing evidence');
    captureFailedPodJobs({ runId: 'incident', job: jobs[0]!, ledgerPath: s.ledger, artifactDir: s.dir, kubectl: s.kubectl, record: s.record, now: () => 1000 });
    expect(readFileSync(path, 'utf8')).toBe('existing evidence');
    expect(s.rows().at(-1)?.data).toMatchObject({ outcome: 'failed', reason: 'capture-error' });
  });

  test('다른 Job 응답은 증거 성공으로 기록하지 않는다', () => {
    const s = stage([entered(jobs[0]!)]);
    const wrongJob = (host: string, args: readonly string[]) => {
      s.calls.push({ host, args: [...args] });
      return { status: 0, stdout: JSON.stringify({ metadata: { name: jobs[1], uid: 'foreign-uid' } }), stderr: '' };
    };
    captureFailedPodJobs({ runId: 'incident', job: jobs[0]!, ledgerPath: s.ledger, artifactDir: s.dir, kubectl: wrongJob, record: s.record });
    expect(s.rows().at(-1)?.data).toMatchObject({ outcome: 'failed', reason: 'job-identity-mismatch' });
    expect(s.calls).toHaveLength(1);
  });

  test('같은 이름으로 재생성된 다른 Job UID는 현재 실행의 증거로 수집하지 않는다', () => {
    const job = jobs[0]!;
    const s = stage([entered(job, { jobUid: 'uid-original' })]);
    captureFailedPodJobs({ runId: 'incident', job, ledgerPath: s.ledger, artifactDir: s.dir, kubectl: s.kubectl, record: s.record });
    expect(s.rows().at(-1)?.data).toMatchObject({ outcome: 'failed', reason: 'job-identity-mismatch', jobUid: 'uid-original' });
    expect(s.calls).toHaveLength(1);
    expect(s.rows().filter(row => row.event === 'pod-failure-capture' && row.data.outcome === 'collected')).toHaveLength(0);
  });

  test('Job UID가 ledger에 없거나 같은 child 실행에서 상충하면 조회 없이 fail-closed', () => {
    const job = jobs[0]!;
    for (const [rows, reason] of [
      [[entered(job, { jobUid: undefined })], 'placement-incomplete'],
      [[entered(job), entered(job, { jobUid: 'uid-other' })], 'placement-conflict'],
    ] as const) {
      const s = stage([...rows]);
      captureFailedPodJobs({ runId: 'incident', job, ledgerPath: s.ledger, artifactDir: s.dir, kubectl: s.kubectl, record: s.record });
      expect(s.calls).toHaveLength(0);
      expect(s.rows().at(-1)?.data).toMatchObject({ outcome: 'failed', reason });
    }
  });

  test('재시도 Pod가 둘이어도 확인된 Job과 Pod 응답은 보존하고 로그 모호성을 기록한다', () => {
    const job = jobs[0]!;
    const s = stage([entered(job, { jobUid: `uid-${job}` })]);
    const retryPods = (host: string, args: readonly string[]) => {
      if (args[5] === 'pods') return { status: 0, stdout: JSON.stringify({ items: [
        { metadata: { name: `${job}-pod`, ownerReferences: [{ uid: `uid-${job}` }] } },
        { metadata: { name: `${job}-retry`, ownerReferences: [{ uid: `uid-${job}` }] } },
      ] }), stderr: '' };
      return s.kubectl(host, args);
    };
    captureFailedPodJobs({ runId: 'incident', job, ledgerPath: s.ledger, artifactDir: s.dir, kubectl: retryPods, record: s.record });
    const result = s.rows().at(-1)?.data;
    expect(result).toMatchObject({ outcome: 'failed', reason: 'pod-ambiguous', jobUid: `uid-${job}`, ...placement });
    expect(readFileSync(String(result?.jobEvidence), 'utf8')).toContain(`uid-${job}`);
    expect(readFileSync(String(result?.podEvidence), 'utf8')).toContain(`${job}-retry`);
    expect(result?.logEvidence).toBeUndefined();
  });

  test('TTL 뒤 Job NotFound는 소멸로 기록하고 성공하지 않는다', () => {
    const s = stage([entered(jobs[0]!)]);
    const notFound = (_host: string, args: readonly string[]) => { s.calls.push({ host: placement.host, args: [...args] }); return { status: 1, stdout: '', stderr: 'Error from server (NotFound): jobs not found' }; };
    captureFailedPodJobs({ runId: 'incident', job: jobs[0]!, ledgerPath: s.ledger, artifactDir: s.dir, kubectl: notFound, record: s.record, now: () => 1_801_000 });
    expect(s.rows().at(-1)?.data).toMatchObject({ outcome: 'vanished', reason: 'job-not-found', job: jobs[0] });
  });

  test('podSelfImplementSpawn의 Failed Job 두 건은 mbp가 아닌 ledger host에서 수집한다', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pod-autopsy-entry-'));
    const runId = 'incident';
    const spaces = ['incident', 'pool-node-b'];
    const jobNames = spaces.map(podJobName);
    const reads: Array<{ host: string; args: readonly string[] }> = [];
    const pool = { tryAcquire: () => ({ context: placement.context, sshHost: 'node-b', capacity: 2, k3dCluster: 'elanous-pool' }), release: () => {}, snapshot: () => ({}) };
    const kubectl: Kubectl = (args) => {
      const text = args.join(' ');
      if (text.includes('jsonpath={.metadata.uid}')) return { status: 0, stdout: '12345678-1234-1234-1234-123456789abc Running', stderr: '' };
      if (text.includes('get job') && text.endsWith('-o json')) return { status: 0, stdout: JSON.stringify({ metadata: { annotations: {} }, spec: { template: { spec: { containers: [{ name: 'child', resources: { limits: { memory: '16Gi' } }, env: [{ name: 'ELANOUS_RUN_ID', value: 'run-child' }] }] } } } }), stderr: '' };
      if (text.includes('jsonpath={.status.conditions[*].type}')) return { status: 0, stdout: 'Failed', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    };
    const failureCaptureKubectl = (host: string, args: readonly string[]) => {
      reads.push({ host, args });
      if (host !== 'node-b' || args[1] !== placement.context || args[3] !== placement.namespace) return { status: 1, stdout: '', stderr: 'wrong host or placement' };
      const job = args[4] === 'logs' ? args[5]?.replace(/^pod\//, '').replace(/-pod$/, '') : args[5] === 'pods' ? args[7]?.replace('job-name=', '') : args[6];
      if (!jobNames.includes(job ?? '')) return { status: 1, stdout: '', stderr: 'NotFound' };
      if (args[5] === 'job') return { status: 0, stdout: JSON.stringify({ metadata: { name: job, uid: '12345678-1234-1234-1234-123456789abc' } }), stderr: '' };
      if (args[5] === 'pods') return { status: 0, stdout: JSON.stringify({ items: [{ metadata: { name: `${job}-pod`, ownerReferences: [{ uid: '12345678-1234-1234-1234-123456789abc' }] } }] }), stderr: '' };
      if (args[4] === 'logs') return { status: 0, stdout: `${host}:${job} log`, stderr: '' };
      return { status: 1, stdout: '', stderr: 'unsupported' };
    };
    try {
      const dir = runLedgerDir(root);
      appendRunLedgerEntry({ runId, event: 'incident', data: { host: 'mbp' } }, dir);
      for (const job of jobNames) appendRunLedgerEntry({ runId, event: 'pod-job-applied', data: { job, childRunId: 'run-child', jobUid: '12345678-1234-1234-1234-123456789abc', ...placement } }, dir);
      for (const spaceId of spaces) {
        await podSelfImplementSpawn({ kubectl, failureCaptureRemote: failureCaptureKubectl, pool: pool as never,
          env: { ELANOUS_RUN_ID: runId, ELANOUS_STATE_DIR: root }, credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'gh' }),
          now: () => 1000 })({ spaceId, feature: 'test' }).done;
      }
      const rows = readFileSync(runLedgerPath(runId, dir), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event: string; data: Record<string, unknown> });
      const captures = rows.filter(row => row.event === 'pod-failure-capture');
      expect(rows.filter(row => row.event === 'pod-job-applied').map(row => row.data.jobUid)).toEqual(jobNames.flatMap(() => ['12345678-1234-1234-1234-123456789abc', '12345678-1234-1234-1234-123456789abc']));
      expect(captures).toHaveLength(2);
      expect(captures.map(row => row.data.job)).toEqual(jobNames);
      for (const row of captures) {
        expect(row.data).toMatchObject({ outcome: 'collected', reason: 'job-failed', runId, childRunId: 'run-child', jobUid: '12345678-1234-1234-1234-123456789abc', ...placement, capturedAt: new Date(1000).toISOString() });
        expect(readFileSync(String(row.data.logEvidence), 'utf8')).toBe(`${placement.host}:${row.data.job} log`);
      }
      expect(reads).toHaveLength(6);
      expect(reads.every(read => read.host === 'node-b' && read.args[1] === placement.context && read.args[3] === placement.namespace)).toBe(true);
      const foreignJob = podJobName('foreign-host');
      appendRunLedgerEntry({ runId, event: 'pod-job-applied', data: { job: foreignJob, childRunId: 'run-child', jobUid: '12345678-1234-1234-1234-123456789abc', ...placement, host: 'other-host' } }, dir);
      await podSelfImplementSpawn({ kubectl, failureCaptureRemote: failureCaptureKubectl, pool: pool as never,
        env: { ELANOUS_RUN_ID: runId, ELANOUS_STATE_DIR: root }, credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'gh' }), now: () => 1000 })({ spaceId: 'foreign-host', feature: 'test' }).done;
      const after = readFileSync(runLedgerPath(runId, dir), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event: string; data: Record<string, unknown> });
      expect(after.filter(row => row.event === 'pod-failure-capture' && row.data.job === foreignJob).at(-1)?.data).toMatchObject({ outcome: 'failed', reason: 'placement-conflict' });
      expect(reads).toHaveLength(6);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
