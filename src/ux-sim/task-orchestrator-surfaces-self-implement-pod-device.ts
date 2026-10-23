import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyHarnessPodExit, recordClassifiedHarnessPodExit } from '../harness/harness-cli-command.js';
import { loadRunLedger, runLedgerDir } from '../self-implement/run-ledger.js';
import { podJobName, podSelfImplementSpawn, type Kubectl } from '../task-orchestrator/surfaces/self-implement-pod.js';
import { POD_TERMINATION_JOB_JSONPATH, POD_TERMINATION_PODS_JSONPATH } from '../task-orchestrator/surfaces/pod-failure-reason.js';
import type { UserConfig } from '../user-config.js';

/**
 * L2 가짜 kubectl 장치 — si-task Job 실패 사건(Job BackoffLimitExceeded · child container OOMKilled ·
 * Job DeadlineExceeded · result marker 조기 종료(아직 running) · GC 뒤 조회 실패)을 주입해, 생산 함수
 * `readPodTermination`(pod-failure-reason.ts)이 GC «전»에 읽을 원문을 스크립트대로 답한다
 * (10-22 05:07·12:56~13:55 node-b «unknown · 판정 불가» 관측 공백 메우기 · JOB-FAILURE-TERMINATION-CAPTURE).
 * 장치는 운영 코드가 아니다 — 생산 함수의 jsonpath 상수를 그대로 받아 그 질의에만 답한다.
 */
export type PodDeviceEventKind =
  | 'job-failed-backoff'
  | 'child-oomkilled'
  | 'job-deadline-exceeded'
  | 'result-marker-running'
  | 'lookup-failure';

export interface PodDeviceEvent {
  kind: PodDeviceEventKind;
  jobName: string;
  namespace?: string;
  jobUid?: string;
  jobConditionType?: string;
  jobConditionReason?: string;
  jobConditionMessage?: string;
  activeDeadlineSeconds?: number;
  podPhase?: string;
  podCreatedAt?: string;
  containerReason?: string | null;
  containerExitCode?: number | null;
  containerFinishedAt?: string | null;
  /** An earlier Pod of a different Job uid under the same Job name (OOM retry · relaunch) — must never be read. */
  staleOtherJobPod?: { uid: string; createdAt: string; reason: string; exitCode: number; finishedAt: string };
}

export interface PodDeviceCall {
  args: readonly string[];
}

export interface ScriptedKubectlDevice {
  kubectl: Kubectl;
  calls: PodDeviceCall[];
}

/** 10-22 관측 공백을 메우는 다섯 사건의 고정 입력. */
export const POD_DEVICE_EVENTS: readonly PodDeviceEvent[] = [
  {
    kind: 'job-failed-backoff',
    jobName: 'si-task-backoff',
    jobUid: '11111111-1111-4111-8111-111111111111',
    jobConditionType: 'Failed',
    jobConditionReason: 'BackoffLimitExceeded',
    jobConditionMessage: 'Job has reached the specified backoff limit',
    activeDeadlineSeconds: 14400,
    podPhase: 'Failed',
    containerReason: 'Error',
    containerExitCode: 1,
    containerFinishedAt: '2026-10-22T05:07:41Z',
  },
  {
    kind: 'child-oomkilled',
    jobName: 'si-task-oom',
    jobUid: '22222222-2222-4222-8222-222222222222',
    jobConditionType: 'Failed',
    jobConditionReason: 'BackoffLimitExceeded',
    jobConditionMessage: 'Job has reached the specified backoff limit',
    activeDeadlineSeconds: 14400,
    podPhase: 'Failed',
    containerReason: 'OOMKilled',
    containerExitCode: 137,
    containerFinishedAt: '2026-10-22T12:56:03Z',
    staleOtherJobPod: { uid: '99999999-9999-4999-8999-999999999999', createdAt: '2026-10-22T12:59:00Z', reason: 'Completed', exitCode: 0, finishedAt: '2026-10-22T13:00:00Z' },
  },
  {
    kind: 'job-deadline-exceeded',
    jobName: 'si-task-deadline',
    jobUid: '33333333-3333-4333-8333-333333333333',
    jobConditionType: 'Failed',
    jobConditionReason: 'DeadlineExceeded',
    jobConditionMessage: 'Job was active longer than specified deadline',
    activeDeadlineSeconds: 3600,
    podPhase: 'Failed',
    containerReason: 'Error',
    containerExitCode: 143,
    containerFinishedAt: '2026-10-22T13:55:10Z',
  },
  {
    kind: 'result-marker-running',
    jobName: 'si-task-marker',
    jobUid: '44444444-4444-4444-8444-444444444444',
    jobConditionType: '',
    activeDeadlineSeconds: 14400,
    podPhase: 'Running',
    containerReason: null,
    containerExitCode: null,
    containerFinishedAt: null,
  },
  {
    kind: 'lookup-failure',
    jobName: 'si-task-gone',
    containerReason: null,
    containerExitCode: null,
  },
];

const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });

function answerJob(event: PodDeviceEvent, jsonpath: string): { status: number; stdout: string; stderr: string } {
  if (jsonpath === POD_TERMINATION_JOB_JSONPATH) {
    return ok(`${event.jobConditionReason ?? ''}\t${event.activeDeadlineSeconds ?? ''}\t${event.jobUid ?? ''}`);
  }
  if (jsonpath.includes('.spec.activeDeadlineSeconds')) return ok(event.activeDeadlineSeconds != null ? String(event.activeDeadlineSeconds) : '');
  if (jsonpath.includes('conditions[?(@.type=="Failed")].reason')) return ok(event.jobConditionReason ?? '');
  if (jsonpath.includes('conditions[?(@.type=="Failed")].message')) return ok(event.jobConditionMessage ?? '');
  if (jsonpath.includes('.status.conditions[*].type')) return ok(event.jobConditionType ?? 'Failed');
  if (jsonpath.includes('.metadata.uid')) return ok(event.jobUid ?? '');
  return ok('');
}

function answerPods(event: PodDeviceEvent, jsonpath: string): { status: number; stdout: string; stderr: string } {
  const created = event.podCreatedAt ?? '2026-10-22T05:00:00Z';
  if (jsonpath === POD_TERMINATION_PODS_JSONPATH) {
    // kubectl's own shape: the `child` range emits nothing until the container has a status.
    const child = event.containerReason == null && event.containerExitCode == null
      ? '' : `${event.containerReason ?? ''}\t${event.containerExitCode ?? ''}\t${event.containerFinishedAt ?? ''}`;
    const rows = [`${created}\t${child}\t\t\t|${event.podPhase ?? ''}\t${event.jobUid ?? ''}`];
    const stale = event.staleOtherJobPod;
    if (stale) rows.push(`${stale.createdAt}\t${stale.reason}\t${stale.exitCode}\t${stale.finishedAt}\t\t\t|Succeeded\t${stale.uid}`);
    return ok(`${rows.join('\n')}\n`);
  }
  if (jsonpath.includes('.state.terminated.exitCode')) {
    if (event.containerReason == null && event.containerExitCode == null) return ok('');
    return ok(`${created}\t${event.containerReason ?? ''}\t${event.containerExitCode ?? ''}\n`);
  }
  return ok(event.containerReason != null ? String(event.containerReason) : '');
}

export function makeScriptedKubectlDevice(events: readonly PodDeviceEvent[]): ScriptedKubectlDevice {
  const calls: PodDeviceCall[] = [];
  const kubectl: Kubectl = (args) => {
    calls.push({ args: [...args] });
    const argv = [...args];
    const namespaceIndex = argv.indexOf('-n');
    const namespace = namespaceIndex >= 0 ? argv[namespaceIndex + 1] ?? '' : '';
    const event = events.find(
      (candidate) =>
        argv.some((arg) => arg === candidate.jobName || arg === `job-name=${candidate.jobName}` || arg === `job/${candidate.jobName}`) &&
        (candidate.namespace == null || candidate.namespace === namespace),
    );
    if (!event) return { status: 1, stdout: '', stderr: 'no fixture' };
    if (event.kind === 'lookup-failure') {
      // The verdict poll saw the Failed condition; GC took the Job and its Pod before any later read.
      if (argv.includes('job') && argv.includes('jsonpath={.status.conditions[*].type}')) return ok('Failed');
      return argv.includes('pods')
        ? { status: 0, stdout: '', stderr: 'No resources found in elanous namespace.' }
        : { status: 1, stdout: '', stderr: `Error from server (NotFound): jobs.batch "${event.jobName}" not found` };
    }
    const outputIndex = argv.indexOf('-o');
    const output = outputIndex >= 0 ? argv[outputIndex + 1] ?? '' : '';
    const jsonpath = output.startsWith('jsonpath=') ? output.slice('jsonpath='.length) : '';
    if (outputIndex >= 0 && !jsonpath) return ok('');
    if (argv.includes('pods')) return answerPods(event, jsonpath);
    if (argv.includes('job')) return answerJob(event, jsonpath);
    return ok('');
  };
  return { kubectl, calls };
}

export interface PodTerminationIncidentObservation {
  readonly injectionId: string;
  readonly kind: PodDeviceEventKind;
  readonly job: string;
  /** `podSelfImplementSpawn`'s own exit code and error code for this event. */
  readonly exitCode: number | null;
  readonly errorCode: string | null;
  /** The parent-ledger event names the spawn wrote (the sim writes none). */
  readonly ledgerEvents: readonly string[];
  /** The raw `incidents/YYYY-MM-DD.jsonl` line `recordClassifiedHarnessPodExit` wrote for this run. */
  readonly incidentLine: string;
  readonly incidentRows: number;
}

/**
 * E4 사다리 — 한 사건을 «생산 경로 그대로» 돌린다: 진짜 `podSelfImplementSpawn`(kubectl = 이 장치 ·
 * apply·logs·재부착 확인만 감싼다) → spawn 이 스스로 쓴 부모 원장(`pod-child-run` ⊕ `pod-child-evidence`)
 * → 진짜 `classifyHarnessPodExit` → `recordClassifiedHarnessPodExit` → 임시 incidents JSONL.
 * 이 함수는 원장 줄을 쓰지 않는다. 실 kubectl·Pod·LLM·네트워크 0 · 쓰기는 임시 ELANOUS_STATE_DIR 하나에만 가고 지운다.
 */
export async function simPodTerminationSpawnIncident(kind: PodDeviceEventKind): Promise<PodTerminationIncidentObservation> {
  const fixture = POD_DEVICE_EVENTS.find((event) => event.kind === kind);
  if (!fixture) throw new Error(`no device event: ${kind}`);
  const suffix = randomBytes(4).toString('hex');
  const spaceId = `sim-pod-termination-${kind}-${suffix}`;
  const job = podJobName(spaceId);
  const runId = `run-sim-pod-termination-${suffix}`;
  const injectionId = `pod-termination:${kind}:${suffix}`;
  const device = makeScriptedKubectlDevice([{ ...fixture, jobName: job }]);
  const markerRc = kind === 'result-marker-running' ? 3 : undefined;
  let childRunId = '';
  const kubectl: Kubectl = (args, input) => {
    if (args.includes('current-context')) return { status: 0, stdout: 'sim-context', stderr: '' };
    if (args.includes('apply') && input) {
      const manifest = JSON.parse(input) as { kind?: string; spec?: { template?: { spec?: { containers?: Array<{ env?: Array<{ name: string; value?: string }> }> } } } };
      if (manifest.kind === 'Job') childRunId = manifest.spec?.template?.spec?.containers?.[0]?.env?.find((e) => e.name === 'ELANOUS_RUN_ID')?.value ?? '';
      return { status: 0, stdout: '', stderr: '' };
    }
    // A fresh launch: no Job of this name exists yet (the resume probe).
    if (args.some((a) => a.startsWith('jsonpath={.metadata.uid} '))) return { status: 1, stdout: '', stderr: 'NotFound' };
    if (args.includes('logs')) {
      const marker = markerRc === undefined ? '' : `\n__ELANOUS_POD_DONE__ ${childRunId} rc=${markerRc}\n`;
      return { status: 0, stdout: args.includes('--tail=2') ? marker.slice(1) : `child exited without a result line\n${marker}`, stderr: '' };
    }
    return device.kubectl(args, input);
  };
  const root = mkdtempSync(join(tmpdir(), 'ux-sim-pod-termination-'));
  const previous = process.env.ELANOUS_STATE_DIR;
  process.env.ELANOUS_STATE_DIR = root;
  try {
    const result = await podSelfImplementSpawn({
      kubectl, sleep: async () => {}, resultMarker: markerRc !== undefined,
      credentials: () => ({ elanousAuth: '{}', codexAuth: '{}', ghToken: 'sim' }),
      // Host-side lookups the unit fakes also opt out of — nothing here reaches a real budget, config, or GitHub.
      budgetSnapshot: () => undefined, fallbackConfig: () => ({ llm: {} }) as UserConfig, openGatewayConfig: () => ({ llm: {} }) as UserConfig,
      lookupOpenPrByBranch: () => ({ status: 'not-found', reason: 'ux-sim' }),
      // High tier already: an OOMKilled child ends the attempt instead of an OOM retry (the retry is not this event).
      // A bare env (no host keys): ProcessEnv's ambient NODE_ENV requirement is not this child's.
      env: Object.assign({} as NodeJS.ProcessEnv, { ELANOUS_RUN_ID: runId, ELANOUS_STATE_DIR: root, ELANOUS_STATE_DIR_SOURCE: 'explicit', ELANOUS_POD_MEMORY_TIER: 'high', ELANOUS_POD_MEMORY_HIGH: '24Gi' }),
    })({ feature: `ux-sim ${injectionId}`, spaceId }).done;
    const output = result.output ?? '';
    const classified = classifyHarnessPodExit({ status: result.exitCode ?? 1 }, output, { runId,
      supervisorDecision: () => undefined, hasJobApplied: () => true, loadCheckpoint: () => null });
    recordClassifiedHarnessPodExit(runId, classified.reason, result.exitCode ?? 1, { output });
    const ledgerEvents = (loadRunLedger(runId, runLedgerDir(root)) ?? []).map((entry) => entry.event);
    const incidents = join(root, 'incidents');
    const lines = (existsSync(incidents) ? readdirSync(incidents) : []).flatMap((file) => readFileSync(join(incidents, file), 'utf8').split('\n')).filter(Boolean);
    return { injectionId, kind, job, exitCode: result.exitCode, errorCode: result.error?.code ?? null, ledgerEvents,
      incidentLine: lines.find((line) => line.includes(runId)) ?? '', incidentRows: lines.length };
  } finally {
    if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
}
