/**
 * POD-LIFECYCLE-STAGES (P0 · Pod 재사용 기준선) — Pod 하나가 끝날 때 «어느 단계에 시간이 갔나»를 한 줄로 낸다.
 *
 * 계약: category `pod.lifecycle` · event `stages` ·
 *   data `{ runId, podJob, host, kind, stages: [{ stage, start, end, clock }], outcome, missing }`.
 *   - 시각은 epoch ms 하나로 통일한다(Pod 시계의 초 값은 ×1000).
 *   - `clock` 은 그 값이 어느 시계에서 왔나 — `host`(이 프로세스) · `k8s`(API 서버 시각) · `pod`(Pod 안 `date +%s`) · `mixed`.
 *   - ⛔ «0초»와 «못 잼»을 섞지 않는다: 시작·끝 둘 다 잰 단계만 `stages` 에 들어가고, 나머지는 이름만 `missing` 에 간다.
 *     끝이 시작보다 앞서면(시계가 어긋났다) 그 단계도 지어내지 않고 `missing` 이다.
 *
 * 관측만 한다 — 판정·rc·파일을 바꾸지 않고, 내보내기가 실패해도 삼킨다.
 */
import { debug } from '../../debug/log.js';

export const POD_LIFECYCLE_STAGES = ['create', 'schedule', 'clone', 'mirror', 'deps', 'test', 'delete'] as const;
/** si-task Pod 은 시험이 아니라 `self implement`(또는 harness ask/say) 본체를 돈다 — 그 칸은 `test` 가 아니라 `run` 이다. */
export const SI_TASK_POD_LIFECYCLE_STAGES = ['create', 'schedule', 'clone', 'mirror', 'deps', 'run', 'delete'] as const;
export type PodLifecycleStageName = typeof POD_LIFECYCLE_STAGES[number] | typeof SI_TASK_POD_LIFECYCLE_STAGES[number];
export type PodLifecycleClock = 'host' | 'k8s' | 'pod' | 'mixed';
export type PodLifecycleKind = 'gate' | 'si-task';

export interface PodLifecycleStage { stage: PodLifecycleStageName; start: number; end: number; clock: PodLifecycleClock }

export interface PodLifecycleEvent {
  runId: string | null;
  podJob: string | null;
  host: string | null;
  kind: PodLifecycleKind;
  stages: PodLifecycleStage[];
  outcome: string;
  missing: PodLifecycleStageName[];
  [extra: string]: unknown;
}

type Measured = Partial<Record<PodLifecycleStageName, { start?: number; end?: number; clock: PodLifecycleClock }>>;

/** ISO 문자열 → epoch ms (못 읽으면 undefined — 지어내지 않는다). */
export function isoMs(value: string | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Pod 시계의 epoch 초 → ms. */
function podSecondsMs(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : undefined;
}

/** 잰 것만 stages 로, 나머지는 missing 으로 — 계약의 단계 순서대로. */
export function splitPodLifecycleStages(measured: Measured, order: readonly PodLifecycleStageName[] = POD_LIFECYCLE_STAGES): { stages: PodLifecycleStage[]; missing: PodLifecycleStageName[] } {
  const stages: PodLifecycleStage[] = [];
  const missing: PodLifecycleStageName[] = [];
  for (const name of order) {
    const item = measured[name];
    if (item && item.start !== undefined && item.end !== undefined && item.end >= item.start) stages.push({ stage: name, start: item.start, end: item.end, clock: item.clock });
    else missing.push(name);
  }
  return { stages, missing };
}

/**
 * gate shard Pod — `pod-N.json` 에 쓰는 바로 그 값(phaseTimes · podStages · podLifecycle)에서 단계를 고른다.
 * - create   = 풀 자리 배정(없으면 입장 끝 · host) → Pod 생성(k8s)
 * - schedule = Pod 생성 → PodScheduled (k8s)
 * - clone    = 자식 컨테이너 PID 1(prep-start) → 셸 첫 줄(clone-end) (pod)
 * - deps     = deps-start → deps-end (pod) · test = test-start → test-end (pod)
 * - mirror · delete = gate 는 Pod 별로 재지 않는다 → 늘 missing.
 */
export function gatePodLifecycleStages(input: {
  phaseTimes?: Readonly<Record<string, string>>;
  podStages?: Readonly<Record<string, number>>;
  podLifecycle?: Readonly<Record<string, string>>;
}): { stages: PodLifecycleStage[]; missing: PodLifecycleStageName[] } {
  const phase = input.phaseTimes ?? {};
  const pod = input.podStages ?? {};
  const k8s = input.podLifecycle ?? {};
  return splitPodLifecycleStages({
    create: { start: isoMs(phase.poolPlaced) ?? isoMs(phase.admissionEnd), end: isoMs(k8s.podCreated), clock: 'mixed' },
    schedule: { start: isoMs(k8s.podCreated), end: isoMs(k8s.podScheduled), clock: 'k8s' },
    clone: { start: podSecondsMs(pod['prep-start']), end: podSecondsMs(pod['clone-end']), clock: 'pod' },
    deps: { start: podSecondsMs(pod['deps-start']), end: podSecondsMs(pod['deps-end']), clock: 'pod' },
    test: { start: podSecondsMs(pod['test-start']), end: podSecondsMs(pod['test-end']), clock: 'pod' },
  });
}

/** gate shard 의 끝 — 판정 코드와 같은 순서(잡 실패 → 정지 → 시간 초과 → 판정 없음 → rc). */
export function gatePodOutcome(o: { jobFailed: boolean; stalled: boolean; timedOut: boolean; rc: number | undefined }): string {
  if (o.jobFailed) return 'job-failed';
  if (o.stalled) return 'stall';
  if (o.timedOut) return 'timeout';
  if (o.rc === undefined) return 'no-verdict';
  return o.rc === 0 ? 'pass' : 'fail';
}

export function gatePodLifecycleEvent(input: {
  runId?: string | null;
  podJob?: string | null;
  host?: string | null;
  shard: string;
  attemptId?: string;
  phaseTimes?: Readonly<Record<string, string>>;
  podStages?: Readonly<Record<string, number>>;
  podLifecycle?: Readonly<Record<string, string>>;
  outcome: string;
}): PodLifecycleEvent {
  const { stages, missing } = gatePodLifecycleStages(input);
  return { runId: input.runId ?? null, podJob: input.podJob ?? null, host: input.host ?? null, kind: 'gate', stages, outcome: input.outcome, missing,
    shard: input.shard, ...(input.attemptId ? { attemptId: input.attemptId } : {}) };
}

/** si-task Pod 셸이 찍는 단계 표지 — `ELANOUS_POD_STAGE <stage> <start|end> <epoch초>` (Pod 시계 · `date +%s`). */
/** Pod 셸이 실제로 표지를 찍는 단계만 — deps 는 si-task Job 에 설치 단계가 없어 읽지도 않는다(늘 missing). */
const SI_TASK_MARKED_STAGES = ['clone', 'mirror', 'run'] as const;
export type SiTaskMarkedStage = typeof SI_TASK_MARKED_STAGES[number];

/** Pod 셸 한 줄 — 단계 경계에서 Pod 시계(초)를 찍는다. 실패해도 셸을 끊지 않는다(`|| true`). */
export function siTaskPodStageShell(stage: SiTaskMarkedStage, edge: 'start' | 'end'): string {
  return `printf 'ELANOUS_POD_STAGE ${stage} ${edge} %s\\n' "$(date +%s)" || true`;
}
const SI_TASK_STAGE_LINE = /^ELANOUS_POD_STAGE (clone|mirror|run) (start|end) (\d{1,12})\r?$/gm;

/**
 * Job 로그에서 단계 표지를 읽는다 → `{ 'clone-start': 초, 'clone-end': 초, … }` (gate 의 podStages 와 같은 꼴).
 * 같은 표지가 두 번 나오면 «첫» 값 — 셸 표지는 모두 자식 출력(`cat /tmp/si.out`)보다 앞에 찍히므로, 자식이 같은 모양의 줄을
 * 내도 셸 값을 덮지 못한다(리뷰 should-fix). 모르는 단계·꼴은 버린다(지어내지 않는다).
 */
export function parseSiTaskPodStages(logs: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!logs) return out;
  for (const match of logs.matchAll(SI_TASK_STAGE_LINE)) {
    const key = `${match[1]}-${match[2]}`;
    if (!(key in out)) out[key] = Number(match[3]);
  }
  return out;
}

/**
 * si-task Pod — Pod 셸이 찍은 단계 표지(`parseSiTaskPodStages`)로 clone · mirror · deps · run 을 채운다(pod 시계).
 * - clone  = 소스 받기(`podSourceScript`) 시작 → 그 스크립트 전체가 끝난 뒤(`cd repo` 포함 · 어느 줄에서든 exit 하면 끝이 없다 → missing)
 * - mirror = 호스트 미러 `clone --shared` 시도 → 성공(미러를 건너뛰면 끝이 없다 → missing)
 * - deps   = si-task Job 셸엔 의존성 설치 단계가 없다 → 표지를 읽지 않는다(`deps` 표지 줄이 있어도 늘 missing)
 * - run    = 본체(`self implement` · `harness ask`/`say`) 띄움 → `wait` 가 돌아옴(SIGTERM 이면 끝이 없다 → missing)
 * - create · schedule · delete = 호스트가 잴 값이 없다 → missing.
 * 호스트가 지켜본 구간은 단계가 아닌 `watch`(host 시계)로 따로 싣는다 — 단계로 지어내지 않는다.
 */
export function siTaskPodLifecycleEvent(input: {
  runId?: string | null;
  podJob: string;
  host?: string | null;
  watchStart?: number;
  watchEnd?: number;
  podStages?: Readonly<Record<string, number>>;
  outcome: string;
}): PodLifecycleEvent {
  const pod = input.podStages ?? {};
  const measured: Measured = {};
  for (const name of SI_TASK_MARKED_STAGES) measured[name] = { start: podSecondsMs(pod[`${name}-start`]), end: podSecondsMs(pod[`${name}-end`]), clock: 'pod' };
  const { stages, missing } = splitPodLifecycleStages(measured, SI_TASK_POD_LIFECYCLE_STAGES);
  const watched = input.watchStart !== undefined && input.watchEnd !== undefined && Number.isFinite(input.watchStart) && Number.isFinite(input.watchEnd) && input.watchEnd >= input.watchStart;
  return { runId: input.runId ?? null, podJob: input.podJob, host: input.host ?? null, kind: 'si-task', stages, outcome: input.outcome, missing,
    ...(watched ? { watch: { start: input.watchStart, end: input.watchEnd, clock: 'host' as const } } : {}) };
}

export type PodLifecycleLog = (category: string, event: string, data: Record<string, unknown>) => void;

/** 한 줄 낸다 — 관측은 fail-soft(판정 경로를 절대 깨지 않는다). */
export function emitPodLifecycle(event: PodLifecycleEvent, log: PodLifecycleLog = (category, name, data) => debug.log(category, name, data)): void {
  try { log('pod.lifecycle', 'stages', event); } catch { /* observation is fail-soft */ }
}
