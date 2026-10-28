// ☸️ 명령 Job — 하니스 없이 스크립트 한 줄을 Pod 에서 돌리고 `~/outbox` 산출을 호스트로 돌려받는다.
//
// 자격은 기본 0 이다. `skills` 에 이름이 있을 때만 그 스킬 `.env`(기존 스킬 키 관 · 런 Secret · 0600)를,
// `llm: 'grok'` 일 때만 grok access 사본(refresh 없음 · `hostGrokCredentials` 검사 재사용)을 싣는다.
// codex·elanous 자격 파일은 이 Job 에 없다. 격리 관문(호스트 넥서스에 닿으면 종료)은 기존 Job 과 같다.
// 명령 인자는 셸 문자열로 이어붙이지 않고 `"$@"` 로 따로 인용한다.

import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { getUserConfig } from '../../user-config.js';
import { debug } from '../../debug/log.js';
import { effectiveInstanceRoot } from '../../instance/resolve.js';
import { collectPodArtifacts } from './pod-artifact-return.js';
import { getDefaultLogStore, type LogStore } from '../../mss/logging/log-store.js';
import { podBunCacheVolume } from './pod-bun-cache.js';
import { POD_JOB_TTL_AFTER_FINISHED_SECONDS } from './pod-lease.js';
import { podHostDirsCheckScript, podInstallSlotsVolume, prepareHostDirsOnce, type HostDirsPrepResult, podHostDirsScript } from './pod-install-slots.js';
import { type PodPoolMember, PodPoolScheduler, defaultRemoteRun, resolvePodPoolSpec, parsePodPool, checkPodPool, syncPoolImages, registryImageRef, type PoolKubectl } from './pod-pool.js';
import { podSkillsDigest, readSkillEnvFiles, resolvePodSkills } from './pod-skills.js';
import { podSourceScript, type PodSource } from './pod-source-receive.js';
import { podProvenanceMetadata, type PodProvenance } from './pod-provenance.js';
import { seedMirrorOnce, type MirrorSeedResult } from './pod-mirror-seed.js';
import {
  POD_CHILD_REQUESTS,
  POD_JOB_DEADLINE_SECONDS,
  defaultGhToken,
  defaultKubectl,
  hostGrokCredentials,
  podImageFreshness,
  podJobName,
  type Kubectl,
} from './self-implement-pod.js';

/** CLI `--deadline` 생략 시 — 기존 Pod Job 수명 상한과 같다. */
export const POD_COMMAND_DEADLINE_SECONDS = POD_JOB_DEADLINE_SECONDS;
/** An opt-in shadow cannot let a synchronous kubectl call hide its host deadline for two minutes. */
export const POD_COMMAND_CANCEL_KUBECTL_TIMEOUT_MS = 15_000;

export const POD_NETWORK_SKILLS = ['omni-crawl', 'omni-digest'] as const;
export const POD_LITE_IMAGE = 'elanous-harness-lite:local';

export const POD_LITE_MEMORY_LIMIT = '2Gi';

/** W5 (10-15 #27801): where a memory-backed TMPDIR is mounted for release gate shards — the overlayfs `/tmp` made SQLite
 *  tests take 0.4~5s per turn (once 124s). tmpfs pages count against the container memory limit, so the caller's cap
 *  (`tmpfsSizeLimit`) stays small next to the 16Gi shard limit (request 6Gi). */
export const POD_TMPFS_MOUNT_PATH = '/tmp-mem';

/** 요청은 한도를 넘을 수 없다(쿠버네티스가 Job 을 거부한다) — lite 2Gi 처럼 한도가 기본 요청보다 작으면 한도로 맞춘다. */
/** The command Job container's CPU limit when the caller names none (GATE-SPEED A3①: unchanged default). */
export const POD_COMMAND_CPU_LIMIT_DEFAULT = '4';
/** 게이트 조각·pod-command 의 CPU 요청 기본 — 하니스 Pod(POD_CHILD_REQUESTS.cpu)와 따로 둔다(조각은 bun test 로 CPU 를 실제로 쓴다). */
export const POD_COMMAND_CPU_REQUEST_DEFAULT = '1';
/** Gate and command Pods retain their measured 6Gi scheduler request; si-task admission uses its own size. */
export const POD_COMMAND_MEMORY_REQUEST_DEFAULT = '6Gi';

/** Container CPU request/limit override. Omitted fields keep the defaults (request `POD_COMMAND_CPU_REQUEST_DEFAULT` · limit 4). */
export interface PodCpu { request?: string; limit?: string }

/** Kubernetes CPU quantity → millicores (`1` · `0.5` · `500m`); null when it is not a positive quantity we accept. */
export function podCpuMillis(value: string): number | null {
  const m = /^(?:(\d+(?:\.\d{1,3})?)|(\d+)m)$/.exec(value.trim());
  if (!m) return null;
  const millis = m[1] !== undefined ? Math.round(Number(m[1]) * 1000) : Number(m[2]);
  return Number.isSafeInteger(millis) && millis > 0 ? millis : null;
}

/** Resolve a CPU override against the defaults; throws when a value is malformed or the request exceeds the limit (k8s would refuse the Job). */
export function resolvePodCpu(cpu: PodCpu | undefined): { request: string; limit: string } {
  const request = cpu?.request?.trim() || POD_COMMAND_CPU_REQUEST_DEFAULT;
  const limit = cpu?.limit?.trim() || POD_COMMAND_CPU_LIMIT_DEFAULT;
  const r = podCpuMillis(request), l = podCpuMillis(limit);
  if (r === null) throw new Error(`pod cpu request is not a positive CPU quantity: ${request}`);
  if (l === null) throw new Error(`pod cpu limit is not a positive CPU quantity: ${limit}`);
  if (r > l) throw new Error(`pod cpu request ${request} exceeds limit ${limit}`);
  return { request, limit };
}

/** Config value → CPU override (release gate `release.loop.gatePodCpu`). A scalar (`2` · `"1500m"`) sets request = limit;
 *  `{ request, limit }` sets either side. Absent/empty = undefined (request 1 / limit 4). Malformed values throw. */
export function parsePodCpu(value: unknown, label = 'cpu'): PodCpu | undefined {
  const text = (v: unknown): string | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'number' && typeof v !== 'string') throw new Error(`${label} must be a CPU quantity or { request, limit }`);
    return String(v).trim() || undefined;
  };
  let cpu: PodCpu;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const { request, limit, ...rest } = value as Record<string, unknown>;
    if (Object.keys(rest).length) throw new Error(`${label} has unknown keys: ${Object.keys(rest).join(', ')}`);
    const r = text(request), l = text(limit);
    cpu = { ...(r ? { request: r } : {}), ...(l ? { limit: l } : {}) };
  } else {
    const both = text(value);
    cpu = both ? { request: both, limit: both } : {};
  }
  if (!cpu.request && !cpu.limit) return undefined;
  resolvePodCpu(cpu);
  return cpu;
}

export function memoryRequestWithin(limit: string | undefined): string {
  const gi = (value: string | undefined) => { const m = /^(\d+)Gi$/.exec(value ?? ''); return m ? Number(m[1]) : null; };
  const request = gi(POD_COMMAND_MEMORY_REQUEST_DEFAULT);
  const max = gi(limit);
  return request !== null && max !== null && request > max ? limit! : POD_COMMAND_MEMORY_REQUEST_DEFAULT;
}

// ═══════════ POD-CPU-REQUEST-RIGHTSIZE-2-FU ═══════════
// CPU 요청량(기본 request 1)을 바꾸려면 «gate16+harness40 이 같은 호스트에서 함께 도는» 측정값이 있어야 한다.
// 그 측정을 내는 발사는 두 관문을 지난다 — ①발사 선행 조건(풀 슬롯·SSH·Pod admission·allocatable/request 기준선)을
// 먼저 읽어 기록하고 하나라도 불가하면 발사 0 · 사유 · HITL(local substrate 대체 없음) ②측정이 없는 같은 조건의
// 재발사 금지(run-477b2ee2·run-7bc13989 는 CPU 측정 전에 no-launch(pod-error)로 끝났다). 측정이 모자라면 yellow —
// 기본 요청량 그대로다.

/** POD-CPU-REQUEST-RIGHTSIZE-2-FU — 이 요청량을 정당화하는 공존 조건(게이트 조각 16 ⊕ 하니스 40 동시 실행). */
export const POD_RIGHTSIZE_CONDITION = 'gate16+harness40';
/** 측정 사용량 위에 남기는 여유 — 조정 요청량은 100m 단위로 올린다. */
export const POD_RIGHTSIZE_HEADROOM = 1.25;
/** 스케줄 대기가 이보다 길면 그 요청은 그 호스트에 «너무 크다» — 조정 사유에 원문을 남긴다. */
export const POD_RIGHTSIZE_WAIT_LIMIT_MS = 120_000;

/** 한 발사의 결과 기록 — `no-launch` 는 CPU 측정 «전에» 끝난 발사다(pod-error). */
export interface PodRightsizeLaunchRecord {
  run: string;
  condition: string;
  outcome: 'no-launch' | 'launched';
  reason?: string;
  /** 그 발사가 CPU 사용량을 쟀나 — no-launch 면 false. */
  cpuMeasured?: boolean;
}

/** run-477b2ee2·run-7bc13989 — CPU 측정 전에 no-launch(pod-error)로 끝나 gate16+harness40 공존 증거가 0 인 두 발사. */
export const POD_RIGHTSIZE_VOID_LAUNCHES: readonly PodRightsizeLaunchRecord[] = [
  { run: 'run-477b2ee2', condition: POD_RIGHTSIZE_CONDITION, outcome: 'no-launch', reason: 'pod-error', cpuMeasured: false },
  { run: 'run-7bc13989', condition: POD_RIGHTSIZE_CONDITION, outcome: 'no-launch', reason: 'pod-error', cpuMeasured: false },
];

/** 동일 호스트 동시 실행 한 표본 — 요청량·사용량·스케줄 대기·eviction 원문을 그대로 든다. */
export interface PodCpuSample {
  /** 이 표본을 낸 실행(게이트 조각 16 · 하니스 40). */
  label: string;
  /** 매니페스트에 실려 실제로 발사된 CPU 요청(millis). */
  requestMillis: number;
  /** 실행 중 측정된 CPU 사용량(millis) — 못 쟀으면 null. */
  usageMillis: number | null;
  /** 스케줄 대기(ms) — 못 쟀으면 null. */
  waitMs: number | null;
  /** eviction 원문(있으면 그대로 · 없으면 null/빈 문자열). */
  eviction?: string | null;
}

/** `runPodCommand` 에 붙는 재측정 요청 — 어떤 조건의 표본인지, 앞선 발사 기록, 이번 발사의 호스트 이름. */
export interface PodCpuRightsizeRequest {
  /** 공존 조건 이름 — 기본 {@link POD_RIGHTSIZE_CONDITION}. */
  condition?: string;
  /** 같은 호스트 동시 실행 표본. 비었거나 사용량을 못 쟀으면 yellow(기본 요청량 유지). */
  samples?: readonly PodCpuSample[];
  /** 앞선 발사 기록 — 기본 {@link POD_RIGHTSIZE_VOID_LAUNCHES}(측정 전 no-launch 두 건). */
  priorLaunches?: readonly PodRightsizeLaunchRecord[];
  /** 기록·사유에 남길 대상 호스트(없으면 임차한 멤버의 ssh 호스트). */
  host?: string;
}

/**
 * CLI(`elanous pod run --cpu-rightsize`)가 받는 JSON → 재측정 요청. `{ condition?, samples?, priorLaunches?, host? }` 만 받고
 * 모르는 키·잘못된 수량은 사유와 함께 거부한다(발사 전에 막는다). 비었으면 undefined = 종전 발사.
 */
export function parseCpuRightsizeRequest(value: unknown, label = 'cpuRightsize'): PodCpuRightsizeRequest | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be { condition?, samples?, priorLaunches?, host? }`);
  const raw = value as Record<string, unknown>;
  const unknownKeys = Object.keys(raw).filter((key) => !['condition', 'samples', 'priorLaunches', 'host'].includes(key));
  if (unknownKeys.length) throw new Error(`${label} has unknown keys: ${unknownKeys.join(', ')}`);
  const text = (v: unknown, key: string): string | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') throw new Error(`${label}.${key} must be a string`);
    return v.trim() || undefined;
  };
  const millis = (v: unknown, key: string, allowZero = false): number | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || (allowZero ? v < 0 : v <= 0)) {
      throw new Error(`${label}.${key} must be ${allowZero ? 'non-negative' : 'positive'} whole millicores`);
    }
    return v;
  };
  const sampleList = raw.samples === undefined || raw.samples === null ? [] : raw.samples;
  if (!Array.isArray(sampleList)) throw new Error(`${label}.samples must be an array`);
  const samples = sampleList.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${label}.samples[${i}] must be an object`);
    const row = entry as Record<string, unknown>;
    const name = text(row.label, `samples[${i}].label`);
    if (!name) throw new Error(`${label}.samples[${i}].label is required`);
    const requestMillis = millis(row.requestMillis, `samples[${i}].requestMillis`);
    if (requestMillis === null) throw new Error(`${label}.samples[${i}].requestMillis is required`);
    return {
      label: name, requestMillis,
      usageMillis: millis(row.usageMillis, `samples[${i}].usageMillis`),
      waitMs: millis(row.waitMs, `samples[${i}].waitMs`, true),
      eviction: text(row.eviction, `samples[${i}].eviction`) ?? null,
    };
  });
  const launchList = raw.priorLaunches === undefined || raw.priorLaunches === null ? [] : raw.priorLaunches;
  if (!Array.isArray(launchList)) throw new Error(`${label}.priorLaunches must be an array`);
  const priorLaunches = launchList.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${label}.priorLaunches[${i}] must be an object`);
    const row = entry as Record<string, unknown>;
    const run = text(row.run, `priorLaunches[${i}].run`);
    if (!run) throw new Error(`${label}.priorLaunches[${i}].run is required`);
    const rawOutcome = row.outcome;
    if (rawOutcome !== 'no-launch' && rawOutcome !== 'launched') throw new Error(`${label}.priorLaunches[${i}].outcome must be no-launch or launched`);
    const outcome: 'no-launch' | 'launched' = rawOutcome === 'launched' ? 'launched' : 'no-launch';
    const condition = text(row.condition, `priorLaunches[${i}].condition`) ?? POD_RIGHTSIZE_CONDITION;
    const reason = text(row.reason, `priorLaunches[${i}].reason`);
    return { run, condition, outcome, ...(reason ? { reason } : {}) };
  });
  const condition = text(raw.condition, 'condition');
  const host = text(raw.host, 'host');
  return {
    ...(condition ? { condition } : {}),
    samples,
    ...(priorLaunches.length ? { priorLaunches } : {}),
    ...(host ? { host } : {}),
  };
}

/** millis → 쿠버네티스 수량(`2000` → `2` · `2800` → `2800m`). */
export function podCpuQuantity(millis: number): string {
  if (!Number.isSafeInteger(millis) || millis <= 0) throw new Error(`pod cpu quantity needs positive millicores: ${millis}`);
  return millis % 1000 === 0 ? String(millis / 1000) : `${millis}m`;
}

export interface PodCpuRightsizeVerdict {
  /** green = 측정값이 요청량을 정한다 · yellow = 재측정 불가(기본 요청량 유지). */
  status: 'green' | 'yellow';
  /** 이번 발사에 실을 요청량(yellow 면 기본값). */
  request: string;
  requestMillis: number;
  reason: string;
  /** 판정에 쓴 표본(사용량을 잰 것만). */
  measured: Array<{ label: string; requestMillis: number; usageMillis: number; waitMs: number | null; eviction: string | null }>;
}

/**
 * 측정값 → 요청량. 표본이 하나도 없거나, 사용량을 못 쟀거나, eviction 원문이 있으면 yellow 로 기본 요청량을 지킨다
 * (재측정 불가 = 결함 없음이 아니다). 그 밖에는 표본들의 최대 사용량 ⊕ 여유(POD_RIGHTSIZE_HEADROOM)를 100m 로
 * 올린 값이 요청량이고, 한도(POD_COMMAND_CPU_LIMIT_DEFAULT)를 넘지 않는다.
 */
export function podCpuRightsize(samples: readonly PodCpuSample[]): PodCpuRightsizeVerdict {
  const yellow = (reason: string): PodCpuRightsizeVerdict => ({
    status: 'yellow', request: POD_COMMAND_CPU_REQUEST_DEFAULT,
    requestMillis: podCpuMillis(POD_COMMAND_CPU_REQUEST_DEFAULT)!, reason, measured: [],
  });
  if (samples.length === 0) return yellow('no same-host co-residency samples');
  const evicted = samples.find((s) => (s.eviction ?? '').trim().length > 0);
  if (evicted) return yellow(`eviction on ${evicted.label}: ${evicted.eviction!.trim().replace(/\s+/g, ' ').slice(0, 200)}`);
  const unmeasured = samples.find((s) => s.usageMillis === null);
  if (unmeasured) return yellow(`usage unmeasured on ${unmeasured.label}`);
  const measured = samples.map((s) => ({
    label: s.label, requestMillis: s.requestMillis, usageMillis: s.usageMillis!, waitMs: s.waitMs, eviction: null,
  }));
  const peak = Math.max(...measured.map((s) => s.usageMillis));
  const limitMillis = podCpuMillis(POD_COMMAND_CPU_LIMIT_DEFAULT)!;
  const sized = Math.min(Math.ceil((peak * POD_RIGHTSIZE_HEADROOM) / 100) * 100, limitMillis);
  const waits = measured.map((s) => s.waitMs).filter((ms): ms is number => ms !== null);
  const slow = waits.filter((ms) => ms > POD_RIGHTSIZE_WAIT_LIMIT_MS);
  const waitNote = waits.length === 0
    ? 'wait unreadable'
    : `waited ${Math.max(...waits)}ms${slow.length ? ` (over ${POD_RIGHTSIZE_WAIT_LIMIT_MS}ms on ${slow.length})` : ''}`;
  return {
    status: 'green', request: podCpuQuantity(sized), requestMillis: sized,
    reason: `peak usage ${peak}m over ${measured.length} samples · ${waitNote} · no eviction → request ${podCpuQuantity(sized)}`,
    measured,
  };
}

/**
 * 같은 조건의 «무효 재발사» 금지 — 그 조건의 발사가 CPU 측정 전에 no-launch(pod-error)로 끝났고 아직 사용량을 잰
 * 표본이 없으면, 같은 조건을 다시 쏘는 것은 같은 무효를 한 번 더 사는 일이다.
 */
export function podRightsizeRefusal(o: {
  condition: string;
  samples: readonly PodCpuSample[];
  priorLaunches?: readonly PodRightsizeLaunchRecord[];
}): { refused: boolean; reason: string; priorVoid: PodRightsizeLaunchRecord[] } {
  // Only a no-launch that measured nothing is a void — a launch that died after a reading is not «no evidence».
  const priorVoid = (o.priorLaunches ?? POD_RIGHTSIZE_VOID_LAUNCHES)
    .filter((r) => r.condition === o.condition && r.outcome === 'no-launch' && r.cpuMeasured !== true);
  if (priorVoid.length === 0) return { refused: false, reason: 'no no-launch record for this condition', priorVoid };
  if (o.samples.some((s) => s.usageMillis !== null)) return { refused: false, reason: 'a measured sample exists', priorVoid };
  const seen = priorVoid.map((r) => `${r.run}:${r.reason ?? r.outcome}`).join('·');
  return {
    refused: true,
    reason: `same condition ${o.condition} re-launch refused — ${seen} ended before any CPU measurement`,
    priorVoid,
  };
}

/** 발사 선행 조건 기록 — 풀 슬롯 · SSH · Pod admission · allocatable/request 기준선. 하나라도 ok=false 면 발사하지 않는다. */
export interface PodLaunchPreconditions {
  slots: { ok: boolean; ready: number; capacity: number; detail?: string };
  ssh: { ok: boolean; host: string | null; detail?: string };
  admission: { ok: boolean; detail?: string };
  baseline: {
    ok: boolean; node: string | null;
    allocatableCpuMillis: number | null; requestedCpuMillis: number | null;
    requestCpuMillis: number | null; freeCpuMillis: number | null;
    detail?: string;
  };
}

export interface PodLaunchPreconditionsDeps {
  kubectl: Kubectl;
  namespace: string;
  member?: PodPoolMember | null;
  /** 발사할 풀의 자리 — 풀이 없으면 null(단일 컨텍스트 하나). */
  pool?: { ready: number; capacity: number } | null;
  /** 이번 발사가 요청할 CPU(millis) — 기준선 여유와 비교한다. */
  requestCpuMillis: number;
  /** 원격 멤버 SSH 도달 시험. null/생략 = 못 잼(원격이면 불가로 센다). */
  sshProbe?: ((host: string) => { status: number | null; stdout: string; stderr: string }) | null;
}

/** 대상 호스트의 선행 조건을 실제 클러스터에서 읽어 기록한다 — 판정하지 않고 «읽은 그대로» 남긴다. */
export function podLaunchPreconditions(o: PodLaunchPreconditionsDeps): PodLaunchPreconditions {
  const slots: PodLaunchPreconditions['slots'] = o.pool
    ? { ok: o.pool.ready > 0, ready: o.pool.ready, capacity: o.pool.capacity, ...(o.pool.ready > 0 ? {} : { detail: 'no ready pool member' }) }
    : { ok: true, ready: 1, capacity: 1, detail: 'single context (no pool)' };

  const host = o.member?.sshHost ?? null;
  let ssh: PodLaunchPreconditions['ssh'];
  if (!host) ssh = { ok: true, host: null, detail: 'this machine (no ssh)' };
  else if (!o.sshProbe) ssh = { ok: false, host, detail: 'ssh probe unavailable' };
  else {
    const probed = o.sshProbe(host);
    ssh = probed.status === 0
      ? { ok: true, host }
      : { ok: false, host, detail: (probed.stderr.trim().split('\n').pop() ?? '').slice(0, 200) || `ssh exit ${probed.status}` };
  }

  const cani = o.kubectl(['-n', o.namespace, 'auth', 'can-i', 'create', 'jobs.batch']);
  const admission: PodLaunchPreconditions['admission'] = cani.status === 0 && /^yes$/i.test(cani.stdout.trim())
    ? { ok: true, detail: 'can-i create jobs.batch' }
    : { ok: false, detail: (cani.stderr.trim().split('\n').pop() ?? '').slice(0, 200) || `can-i ${cani.stdout.trim() || `exit ${cani.status}`}` };

  const nodes = o.kubectl(['get', 'nodes', '-o', 'json']);
  const pods = o.kubectl(['get', 'pods', '--all-namespaces', '-o', 'json']);
  let allocatable: Array<{ name: string; cpu: number }> = [];
  let perNode: Record<string, number> = {};
  let baselineError: string | null = null;
  try {
    const parsed = JSON.parse(nodes.stdout) as { items?: Array<{ metadata?: { name?: string }; status?: { allocatable?: { cpu?: string } } }> };
    allocatable = (parsed.items ?? []).flatMap((item) => {
      const name = item.metadata?.name;
      const cpu = podCpuMillis(item.status?.allocatable?.cpu ?? '');
      return name && cpu !== null ? [{ name, cpu }] : [];
    });
  } catch { baselineError = `node list unreadable: ${(nodes.stderr.trim() || 'invalid json').slice(0, 200)}`; }
  if (!baselineError) {
    try {
      const parsed = JSON.parse(pods.stdout) as { items?: Array<{ spec?: { nodeName?: string; containers?: Array<{ resources?: { requests?: { cpu?: string } } }> } }> };
      for (const pod of parsed.items ?? []) {
        const node = pod.spec?.nodeName;
        if (!node) continue;
        for (const container of pod.spec?.containers ?? []) {
          perNode[node] = (perNode[node] ?? 0) + (podCpuMillis(container.resources?.requests?.cpu ?? '') ?? 0);
        }
      }
    } catch { baselineError = `pod list unreadable: ${(pods.stderr.trim() || 'invalid json').slice(0, 200)}`; }
  }
  const ranked = [...allocatable]
    .map((node) => ({ ...node, requested: perNode[node.name] ?? 0 }))
    .sort((a, b) => (b.cpu - b.requested) - (a.cpu - a.requested) || a.name.localeCompare(b.name));
  const chosen = baselineError ? undefined : ranked[0];
  const baseline: PodLaunchPreconditions['baseline'] = !chosen
    ? {
      ok: false, node: null, allocatableCpuMillis: null, requestedCpuMillis: null,
      requestCpuMillis: o.requestCpuMillis, freeCpuMillis: null,
      detail: baselineError ?? (nodes.status !== 0 ? `node list exit ${nodes.status}` : 'no node reports an allocatable cpu'),
    }
    : {
      ok: chosen.cpu - chosen.requested >= o.requestCpuMillis,
      node: chosen.name, allocatableCpuMillis: chosen.cpu, requestedCpuMillis: chosen.requested,
      requestCpuMillis: o.requestCpuMillis, freeCpuMillis: chosen.cpu - chosen.requested,
      ...(chosen.cpu - chosen.requested >= o.requestCpuMillis ? {} : { detail: `free ${chosen.cpu - chosen.requested}m < request ${o.requestCpuMillis}m` }),
    };
  return { slots, ssh, admission, baseline };
}

/** POD7 must-fix: the skill list alone can't tell a network-only job from one that needs ffmpeg/browser — so lite is
 *  only ever chosen when the caller says so (`lite`), and then only for network skills without a clone. Anything we
 *  can't judge keeps the full image. A lite request that doesn't fit is refused with the reason, not silently widened. */
export function podCommandImageFor(skills: readonly string[], clone: boolean, lite = false): string {
  if (!lite) return 'elanous-harness:local';
  if (clone) throw new Error('pod command: --lite 는 clone 없는 명령만 받는다(lite 이미지는 git·빌드 도구가 적다)');
  const outside = skills.filter((skill) => !(POD_NETWORK_SKILLS as readonly string[]).includes(skill));
  if (skills.length === 0 || outside.length > 0) {
    throw new Error(`pod command: --lite 는 네트워크 스킬(${POD_NETWORK_SKILLS.join('·')})만 받는다${outside.length ? ` — 벗어난 스킬: ${outside.join(', ')}` : ' — --skill 이 없다'}`);
  }
  return POD_LITE_IMAGE;
}

const COMMAND_LOG_CHARS = 80;

/** 자식 로그 전문 상한(바이트) — 넘으면 끝부분을 남긴다. config `pod.childLogMaxBytes` 가 양의 정수일 때만 그 값. */
export const POD_CHILD_LOG_MAX_BYTES_DEFAULT = 1_048_576;

export function podChildLogMaxBytes(read: () => number | undefined = () => getUserConfig().pod?.childLogMaxBytes): number {
  const configured = read();
  return typeof configured === 'number' && Number.isSafeInteger(configured) && configured > 0
    ? configured
    : POD_CHILD_LOG_MAX_BYTES_DEFAULT;
}

/** 크기 상한을 넘으면 끝부분을 남긴다(잘린 앞은 표시). */
export function tailBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  const cut = bytes.subarray(bytes.length - maxBytes);
  let start = 0;
  while (start < cut.length && (cut[start]! & 0xc0) === 0x80) start += 1;
  return `…[앞 ${bytes.length - maxBytes}바이트 생략]\n${cut.subarray(start).toString('utf8')}`;
}

/**
 * The isolation probe: wait until the NetworkPolicy blocks the host/prod daemons, then go on with the child shell.
 * GATE-WARM-BOOT-NO-INIT (10-15) — this used to be the `isolation-gate` init container; it is now the child shell's first
 * lines, before any credential is read. Same probes, same log lines, same exit 1 when isolation is not enforced in 30 s.
 * Measured on node-b k3d (#27805): init 2 → 354 s · init 1 → 41 s · none → 1 s from Pod creation to the child start.
 */
export function isolationGateLines(): string {
  return `elanous_isolation_gate() {
  local ok=0 i
  for i in $(seq 1 60); do
    if curl -s -m 1 -o /dev/null http://host.orb.internal:31415/health || curl -s -m 1 -o /dev/null http://core.elanous-prod:8080/; then ok=0; else ok=$((ok+1)); fi
    [ "$ok" -ge 3 ] && { echo "[gate] isolation enforced after \${i} probes"; return 0; }
    sleep 0.5
  done
  echo "[gate] ISOLATION NOT ENFORCED within 30s"; exit 1
}
elanous_isolation_gate || exit 1`;
}

/** Export the command's log store into the existing outbox return channel without changing the command exit status. */
const COMMAND_LOG_EXPORT = `if mkdir -p "$HOME/outbox/pod-logs" && elanous --test="$HOME/.elanous-test" logs --instance prod --since 12h --limit 20000 --json --json-data > "$HOME/outbox/pod-logs/logs.jsonl"; then
  logs_size=$(( $(wc -c < "$HOME/outbox/pod-logs/logs.jsonl") ))
  if [ "$logs_size" -gt 5242880 ]; then
    tail -c 5242880 "$HOME/outbox/pod-logs/logs.jsonl" | tail -n +2 > "$HOME/outbox/pod-logs/logs.jsonl.tail" && mv -f "$HOME/outbox/pod-logs/logs.jsonl.tail" "$HOME/outbox/pod-logs/logs.jsonl"
    printf 'ELANOUS_POD_LOGS_TRUNCATED %s %s\\n' "$logs_size" "$(( $(wc -c < "$HOME/outbox/pod-logs/logs.jsonl") ))"
  fi
else
  logs_rc=$?
  rm -f "$HOME/outbox/pod-logs/logs.jsonl"
  printf 'ELANOUS_POD_LOGS_UNAVAILABLE export-exit-%s\\n' "$logs_rc"
fi`;

/** 기존 Job 과 같은 `~/outbox` 조각 형식(`ELANOUS_POD_ARTIFACT`). 원장 회수는 하지 않는다. */
const ARTIFACT_EMIT = `set -o pipefail
artifact_bytes=0
if [ -d "$HOME/outbox" ]; then
  while IFS= read -r -d '' file; do
    [ -f "$file" ] && [ ! -L "$file" ] || continue
    relative=\${file#"$HOME/outbox/"}
    size=$(( $(wc -c < "$file") ))
    if [ "$size" -gt 5242880 ] || [ $((artifact_bytes + size)) -gt 20971520 ]; then
      printf 'ELANOUS_POD_ARTIFACT_SKIPPED %s %s\\n' "$relative" "$size"
      continue
    fi
    path_token=$(printf '%s' "$relative" | base64 | tr -d '\\n' | tr '+/' '-_' | tr -d '=')
    if encoded=$(gzip -c "$file" | base64 | tr -d '\\n'); then
      artifact_bytes=$((artifact_bytes + size))
      total=$(( (\${#encoded} + 7999) / 8000 ))
      for ((n=1; n<=total; n++)); do
        chunk=\${encoded:$(( (n-1)*8000 )):8000}
        printf 'ELANOUS_POD_ARTIFACT %s %s/%s %s\\n' "$path_token" "$n" "$total" "$chunk"
      done
    else
      printf 'ELANOUS_POD_ARTIFACT_SKIPPED %s %s\\n' "$relative" "$size"
    fi
  done < <(find "$HOME/outbox" -type f -print0 | while IFS= read -r -d '' f; do printf '%s\\t%s\\0' "$(( $(wc -c < "$f") ))" "$f"; done | LC_ALL=C sort -z -t $'\\t' -k1,1n -k2 | while IFS= read -r -d '' row; do printf '%s\\0' "\${row#*$'\\t'}"; done)
fi`;

export interface PodCommandJobInput {
  provenance?: Partial<PodProvenance>;
  provenanceGate?: boolean;
  /** POD1 — this launch's own label; cleanup selects by it, never by name alone. */
  launch?: string;
  name: string;
  namespace: string;
  image: string;
  imagePullPolicy?: 'Never' | 'IfNotPresent';
  repoUrl: string;
  command: readonly string[];
  skills: readonly string[];
  /** pod run opt-in: return this command's local log store with its outbox artifacts. */
  returnLogs?: boolean;
  llm?: 'grok';
  /** 저장소를 clone 한다 — 비공개 저장소라 GitHub 토큰이 Secret 으로 간다(명시 opt-in). 기본은 clone 없이 `~/work` 에서 이미지의 `elanous` 로 돈다. */
  clone?: boolean;
  hostMirror?: string;
  bunCache?: string;
  /** GATE-INSTALL-CACHE — hostPath of the node-wide install tokens (release gate shards only · `pod-install-slots.ts`). */
  installSlots?: string;
  /** 컨테이너 메모리 한도(기본 16Gi) — 게이트가 파일 하나 격리 Job 에 올린다. */
  memoryLimit?: string;
  /** GATE-SPEED A3①: CPU request/limit override (release gate shards only). Omitted = request 1 / limit 4. */
  cpu?: PodCpu;
  /** W5 — emptyDir{medium: Memory} sizeLimit mounted at {@link POD_TMPFS_MOUNT_PATH} ⊕ `TMPDIR` (release gate shards only). Omitted = image `/tmp`. */
  tmpfsSizeLimit?: string;
  source?: PodSource;
  /** Verified producer files, delivered into this Job's own source tree. */
  warmFiles?: readonly string[];
  deadlineSeconds: number;
  runId?: string;
  /** GATE-WARM-BOOT-NO-INIT fallback: the node-side hand-over did not run, so a root init container hands the hostPath dirs to uid 1000. */
  hostDirsInit?: boolean;
}

function warmSourceName(name: string, launch: string): string {
  return `${name.slice(0, 50).replace(/-+$/, '')}-${launch}`;
}

function bashSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function assertGateProvenanceException(gate: boolean | undefined, provenance: Partial<PodProvenance> | undefined,
  clone: boolean | undefined, source: PodSource | undefined): void {
  if (!gate) return;
  const shardEntrance = process.env.ELANOUS_RELEASE_ENTRANCE?.trim() || 'release-run';
  const shard = provenance?.kind === 'gate-shard' && provenance.entrance === shardEntrance;
  const recheck = provenance?.kind === 'gate-recheck' && provenance.entrance === 'release-recheck';
  if (!(shard || recheck) || clone !== true || source?.kind !== 'commit') {
    throw new Error('pod provenance gate exception requires a release shard/recheck commit Job');
  }
}

/** 명령 Job 매니페스트. `skills`·`llm` 을 안 주면 Secret 키를 하나도 참조하지 않는다. */
export function podCommandJobManifest(o: PodCommandJobInput): Record<string, unknown> {
  assertGateProvenanceException(o.provenanceGate, o.provenance, o.clone, o.source);
  const provenance = podProvenanceMetadata(o.provenance, o.provenanceGate);
  const skillNames = [...new Set(o.skills.map((s) => s.trim()).filter(Boolean))];
  for (const name of skillNames) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) throw new Error(`pod command skill name rejected: ${name}`);
  }
  const grok = o.llm === 'grok';
  const bunCache = o.bunCache ? podBunCacheVolume(o.bunCache) : undefined;
  const installSlots = o.installSlots ? podInstallSlotsVolume(o.installSlots) : undefined;
  // hostPath directories the uid-1000 child writes. DirectoryOrCreate makes them root 0755, so runPodCommand hands them to
  // uid 1000 once per node (prepareHostDirsOnce); the child only reports a directory it still cannot write.
  const hostDirMounts = [...(bunCache ? [bunCache.volumeMount] : []), ...(installSlots ? [installSlots.volumeMount] : [])];
  const tmpfs = o.tmpfsSizeLimit?.trim() || undefined;
  const tmpfsMounts = tmpfs ? [{ name: 'tmp-mem', mountPath: POD_TMPFS_MOUNT_PATH }] : [];
  const cpu = resolvePodCpu(o.cpu);
  const quotedArgs = o.command.map(bashSingleQuote).join(' ');
  const credLines = [
    ...(grok ? ['mkdir -p ~/.grok && install -m 600 /creds/grok-auth.json ~/.grok/auth.json'] : []),
    ...(skillNames.length
      ? [`for n in ${skillNames.join(' ')}; do [ -d ~/.claude/skills/$n ] && install -m 600 /creds/skillenv-$n ~/.claude/skills/$n/.env; done`]
      : []),
  ];
  const script = [
    isolationGateLines(),
    'set -u',
    ...credLines,
    'curl -s -m 3 -o /dev/null http://host.orb.internal:31415/health && { echo "[pod] ISOLATION FAIL"; exit 3; }',
    ...(o.clone
      ? ['export GH_TOKEN="$(cat /creds/gh-token)" && gh auth setup-git', podSourceScript(o.source ?? { kind: 'default' }, o.repoUrl)]
      : ['mkdir -p ~/work && cd ~/work']),
    ...(o.warmFiles?.length ? [
      `if [ "$(git rev-parse HEAD)" != ${bashSingleQuote(o.source?.kind === 'commit' ? o.source.sha : '')} ]; then echo '[warm-source] commit mismatch'; exit 5; fi`,
      ...o.warmFiles.map((path, i) => `install -m 644 -D /warm-source/file-${i} ${bashSingleQuote(`./${path}`)} || exit 5\nprintf 'ELANOUS_WARM_SOURCE %s %s %s\\n' ${bashSingleQuote(path)} "$(sha256sum ${bashSingleQuote(`./${path}`)} | cut -d ' ' -f1)" "$(git rev-parse HEAD)"`),
    ] : []),
    ...(hostDirMounts.length ? [podHostDirsCheckScript(hostDirMounts)] : []),
    ...(bunCache ? [bunCache.shellPrefix] : []),
    `set -- ${quotedArgs}`,
    '"$@"',
    'rc=$?',
    // A command may not end in LF; keep artifact markers on their own line for the existing parser.
    ...(o.returnLogs ? ["printf '\\n'", COMMAND_LOG_EXPORT] : []),
    ARTIFACT_EMIT,
    // GATE-POD-RESULT-MARKER: the last line says «the child is done» so the host need not wait for the Job condition
    // (k3d on node-b flips it 90~550s late). Leading LF keeps it on its own line; the host strips exactly this tail.
    // The token is this launch's random id — a command that prints the bare marker word cannot end the wait early.
    `printf '\\n${podResultMarker(o.launch ?? o.name)} rc=%s\\n' "$rc"`,
    'exit $rc',
  ].join('\n');
  const secretKeys = grok || skillNames.length || o.clone === true;
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: o.name, namespace: o.namespace, labels: { 'elanous.substrate': 'pod', 'elanous.job': o.name, 'elanous.kind': 'command', ...(o.launch ? { 'elanous.launch': o.launch } : {}), ...provenance?.labels }, ...(provenance ? { annotations: provenance.annotations } : {}) },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: POD_JOB_TTL_AFTER_FINISHED_SECONDS,
      activeDeadlineSeconds: o.deadlineSeconds,
      template: {
        metadata: { labels: { 'elanous.job': o.name, 'elanous.kind': 'command', ...(o.launch ? { 'elanous.launch': o.launch } : {}), ...provenance?.labels }, ...(provenance ? { annotations: provenance.annotations } : {}) },
        spec: {
          restartPolicy: 'Never',
          securityContext: { runAsUser: 1000, fsGroup: 1000 },
          // Normal path: no init container. Fallback only when the node-side hand-over did not run (no member · prep failed).
          ...(o.hostDirsInit && hostDirMounts.length ? { initContainers: [
            { name: 'host-dirs', image: o.image, imagePullPolicy: o.imagePullPolicy ?? 'Never', securityContext: { runAsUser: 0 }, command: ['bash', '-c'], args: [podHostDirsScript(hostDirMounts)], volumeMounts: hostDirMounts.map((mount) => ({ ...mount })) },
          ] } : {}),
          containers: [{
            name: 'child', image: o.image, imagePullPolicy: o.imagePullPolicy ?? 'Never',
            resources: { requests: { ...POD_CHILD_REQUESTS, cpu: cpu.request, memory: memoryRequestWithin(o.memoryLimit) }, limits: { memory: o.memoryLimit ?? '16Gi', cpu: cpu.limit } },
            command: ['bash', '-c'], args: [script],
            env: [
              ...(o.runId ? [{ name: 'ELANOUS_RUN_ID', value: o.runId }] : []),
              { name: 'ELANOUS_SUBSTRATE', value: 'pod' },
              { name: 'ELANOUS_POD_NAME', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
              ...(provenance?.env ?? []),
              ...(tmpfs ? [{ name: 'TMPDIR', value: POD_TMPFS_MOUNT_PATH }] : []),
            ],
            ...(secretKeys || o.hostMirror || hostDirMounts.length || tmpfs || o.warmFiles?.length ? { volumeMounts: [
              ...(o.warmFiles?.length ? [{ name: 'warm-source', mountPath: '/warm-source', readOnly: true }] : []),
              ...(secretKeys ? [{ name: 'creds', mountPath: '/creds', readOnly: true }] : []),
              ...(o.hostMirror ? [{ name: 'host-mirror', mountPath: '/host-mirror', readOnly: true }] : []),
              ...hostDirMounts,
              ...tmpfsMounts,
            ] } : {}),
          }],
          ...(secretKeys || o.hostMirror || hostDirMounts.length || tmpfs || o.warmFiles?.length ? { volumes: [
            ...(o.warmFiles?.length ? [{ name: 'warm-source', configMap: { name: warmSourceName(o.name, o.launch ?? 'source') } }] : []),
            ...(secretKeys ? [{ name: 'creds', secret: { secretName: `${o.name}-creds`, defaultMode: 0o400 } }] : []),
            ...(o.hostMirror ? [{ name: 'host-mirror', hostPath: { path: o.hostMirror, type: 'Directory' } }] : []),
            ...(bunCache ? [bunCache.volume] : []),
            ...(installSlots ? [installSlots.volume] : []),
            ...(tmpfs ? [{ name: 'tmp-mem', emptyDir: { medium: 'Memory', sizeLimit: tmpfs } }] : []),
          ] } : {}),
        },
      },
    },
  };
}

export function commandJobSecret(o: {
  name: string;
  namespace: string;
  skills: readonly string[];
  skillEnvText: Readonly<Record<string, string>>;
  grokAuth?: string;
  ghToken?: string;
  launch?: string;
}): Record<string, unknown> | null {
  const stringData: Record<string, string> = {};
  if (o.grokAuth !== undefined) stringData['grok-auth.json'] = o.grokAuth;
  if (o.ghToken !== undefined) stringData['gh-token'] = o.ghToken;
  for (const name of o.skills) {
    const text = o.skillEnvText[name];
    if (text !== undefined) stringData[`skillenv-${name}`] = text;
  }
  if (Object.keys(stringData).length === 0) return null;
  return {
    apiVersion: 'v1', kind: 'Secret', type: 'Opaque',
    metadata: { name: `${o.name}-creds`, namespace: o.namespace, labels: { 'elanous.job': o.name, ...(o.launch ? { 'elanous.launch': o.launch } : {}) } },
    stringData,
  };
}

export function podCommandScript(manifest: Record<string, unknown>): string {
  const spec = manifest.spec as { template: { spec: { containers: Array<{ args: string[] }> } } };
  return spec.template.spec.containers[0]!.args[0]!;
}

export function podCommandSecretKeys(secret: Record<string, unknown> | null): string[] {
  if (!secret) return [];
  return Object.keys((secret.stringData as Record<string, string> | undefined) ?? {});
}

export interface PodArtifactCollection {
  /** 회수한 산출 파일 수(child.log 제외). 로그 조회 실패면 null. */
  files: number | null;
  /** 회수한 산출 파일의 상대 경로. */
  names: string[];
  /** 로그 조회 자체가 실패했을 때의 사유. 성공이면 null. */
  error: string | null;
}

export interface PodCommandResult {
  exitCode: number;
  artifactsDir: string;
  job: string;
  /** 이 런이 실제로 쓴 이미지(레지스트리 판 태그 또는 로컬 이름). */
  image?: string;
  /** collectPodArtifacts 가 회수한 파일. 로그 조회 실패면 files=null · error=사유. runPodCommand 는 항상 채운다. */
  artifacts?: PodArtifactCollection;
}

export interface RunPodCommandOptions {
  provenance?: Partial<PodProvenance>;
  /** Release gate keeps availability: missing required identity becomes unknown and emits a warning. */
  provenanceGate?: boolean;
  command: readonly string[];
  /** pod run opt-in; other runPodCommand callers keep their existing Job script. */
  returnLogs?: boolean;
  pool?: string;
  skills?: readonly string[];
  llm?: 'grok';
  clone?: boolean;
  hostMirror?: string;
  bunCache?: string;
  /** GATE-INSTALL-CACHE — hostPath of the node-wide install tokens (absolute). */
  installSlots?: string;
  /** 컨테이너 메모리 한도(기본 16Gi · lite 면 2Gi). */
  memoryLimit?: string;
  /** GATE-SPEED A3①: CPU request/limit override — only the release gate passes it. Omitted = request 1 / limit 4. */
  cpu?: PodCpu;
  /**
   * POD-CPU-REQUEST-RIGHTSIZE-2-FU — this launch is a co-residency CPU measurement (게이트 조각 16 ⊕ 하니스 40 on one host).
   * Omitted callers keep today's behaviour byte for byte: no precondition read, no measurement-driven request.
   */
  cpuRightsize?: PodCpuRightsizeRequest;
  /** W5 — memory-backed TMPDIR sizeLimit mounted at {@link POD_TMPFS_MOUNT_PATH}; only the release gate passes it. Omitted = image `/tmp`. */
  tmpfsSizeLimit?: string;
  /** POD7: 호출부가 «네트워크 스킬만 쓰는 명령»이라고 말할 때만 lite 이미지 ⊕ 2Gi. */
  lite?: boolean;
  source?: PodSource;
  /** Opt-in handoff from an existing producer Pod in the same namespace. */
  warmProducer?: { pod: string; podUid: string; context: string; image: string; commit: string; files: readonly [string, string] };
  ghToken?: () => string;
  deadlineSeconds?: number;
  namespace?: string;
  image?: string;
  repoUrl?: string;
  runId?: string;
  name?: string;
  pollMs?: number;
  /**
   * GATE-MULTI-HOST — throw once the Job's status has been unreadable (`kubectl get job` failing) this long, instead of
   * polling forever: a pool member that died mid-Job (host off · tailnet drop) then frees its caller to place the work
   * elsewhere. Omitted = poll without a bound (unchanged for every caller but the release gate).
   */
  statusUnreadableMs?: number;
  /** Optional caller cancellation. Omitted callers keep their existing polling behavior. */
  signal?: AbortSignal;
  /** Optional host wall-clock deadline; checked even when a synchronous kubectl delayed the abort timer. */
  hostDeadlineAtMs?: number;
  /** Clock seam for deadline checks. */
  nowMs?: () => number;
  kubectl?: Kubectl;
  /** A caller-owned scheduler is self-capped: acquires count only its own Jobs, never cluster occupancy (POOLGLOBAL-REG). */
  poolScheduler?: PodPoolScheduler;
  /** GATE-WARM-BOOT — seeds a commit-pinned clone's commit into the pool host mirror (test seam · default {@link seedMirrorOnce}). */
  seedMirror?: (o: { host: string; commit: string; cwd: string }) => Promise<MirrorSeedResult | undefined>;
  /** GATE-WARM-BOOT — the git tree the seed pushes from (default: the process cwd — the gate runs in the repo tree). */
  mirrorSeedCwd?: string;
  /** GATE-WARM-BOOT-NO-INIT — hands the hostPath dirs to uid 1000 on the member's nodes (test seam · default {@link prepareHostDirsOnce}). */
  prepareHostDirs?: (o: { member: PodPoolMember; hostPaths: readonly string[] }) => Promise<HostDirsPrepResult | undefined>;
  /** POD-CPU-REQUEST-RIGHTSIZE-2-FU — SSH 도달 시험(test seam · 기본 `ssh <host> true`; 주입된 kubectl 이면 기본 없음). */
  sshProbe?: (host: string) => { status: number | null; stdout: string; stderr: string };
  checkPool?: typeof checkPodPool;
  syncImages?: typeof syncPoolImages;
  imageCommit?: string | null;
  /** Shelf: require this exact registry tag; never fall back to a mutable local image. */
  shelfImage?: string;
  shelfLookup?: typeof registryImageRef;
  readSkillEnv?: (skills: readonly string[]) => Record<string, string>;
  grokCredentials?: () => { grokAuth?: string; grokApiKey?: string; ghToken: string };
  artifactsRoot?: string;
  /** Test seam for the launching instance's log store. */
  logStore?: LogStore | null;
  sleep?: (ms: number) => Promise<void>;
  log?: (category: string, event: string, data: Record<string, unknown>) => void;
  env?: NodeJS.ProcessEnv;
  configHostMirror?: () => string | undefined;
  /** 자식 로그 전문 상한(바이트). 생략 시 config `pod.childLogMaxBytes`, 없으면 1MiB. 넘으면 끝부분 우선. */
  childLogMaxBytes?: number;
}

/** GATE-POD-RESULT-MARKER — the child script's final line (`\n<marker> <token> rc=<n>\n`), printed after the artifact emit. */
export const POD_RESULT_MARKER = '__ELANOUS_POD_DONE__';
/** The marker bound to one launch (`token` = the launch's random id · the Job name when the manifest has no launch). */
/** Full-log re-reads after an early marker return before the artifacts count as lost (GATE-POD-RESULT-MARKER follow-up). */
export const POD_MARKER_LOG_RETRIES = 2;
export function podResultMarker(token: string): string { return `${POD_RESULT_MARKER} ${token}`; }

/** Split the child's logs into the command output (marker tail removed, bytes otherwise unchanged) and the marker rc (null = no marker for this token). */
export function splitPodResultMarker(logs: string, token: string): { logs: string; rc: number | null } {
  const escaped = podResultMarker(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`\\n${escaped} rc=(\\d+)\\n?$`).exec(logs);
  if (!match) return { logs, rc: null };
  return { logs: logs.slice(0, match.index), rc: Number(match[1]) };
}

function jobFinished(types: string): 'complete' | 'failed' | null {
  if (/Complete|SuccessCriteriaMet/.test(types)) return 'complete';
  if (/Failed|FailureTarget/.test(types)) return 'failed';
  return null;
}

function artifactNames(logs: string): string[] {
  const names = new Set<string>();
  for (const line of logs.split(/\r?\n/)) {
    const match = /^ELANOUS_POD_ARTIFACT (\S+) \d+\/\d+ /.exec(line);
    if (!match) continue;
    try {
      const path = Buffer.from(match[1]!, 'base64url').toString('utf8');
      if (path && !path.split('/').some((part) => part === '' || part === '.' || part === '..')) names.add(path);
    } catch { /* 회수 쪽(collectPodArtifacts)이 불완전 사유를 남긴다 */ }
  }
  return [...names];
}

function exitCodeFromPod(kubectl: Kubectl, namespace: string, job: string, state: 'complete' | 'failed'): number {
  const got = kubectl(['-n', namespace, 'get', 'pods', '-l', `job-name=${job}`, '-o', 'jsonpath={.items[0].status.containerStatuses[?(@.name=="child")].state.terminated.exitCode}']);
  const code = Number(got.stdout.trim());
  if (got.status === 0 && Number.isInteger(code)) return code;
  return state === 'complete' ? 0 : 1;
}

/** 명령 Job 의 목표 이미지 판. 원격 노드면 발사 트리의 HEAD(없으면 로컬 이미지 판) · 이 기계면 로컬 이미지 판. */
export function podCommandTargetCommit(o: { remote: boolean; gitHead: () => string | null; localImageCommit: () => string | null }): string | null {
  if (o.remote) return o.gitHead() ?? o.localImageCommit();
  return o.localImageCommit();
}

/** Only opt-in callers can stop waiting on a pre-Job async operation. Late rejections stay observed. */
function awaitPodCommandAbort<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(signal.reason ?? new Error('pod command aborted')); };
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
    if (signal.aborted) onAbort();
  });
}

/** 풀 자리 · 이미지 판 · Job 적용 · 완료 대기 · 산출 회수 · Secret 정리. */
export async function runPodCommand(options: RunPodCommandOptions): Promise<PodCommandResult> {
  // A non-gate Job must have its owner before a pool lease, Secret, or Job is created.
  assertGateProvenanceException(options.provenanceGate, options.provenance, options.clone, options.source);
  const provenance = podProvenanceMetadata(options.provenance, options.provenanceGate);
  const nowMs = options.nowMs ?? Date.now;
  const ensureLive = () => {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('pod command aborted');
    if (options.hostDeadlineAtMs !== undefined && nowMs() >= options.hostDeadlineAtMs) throw new Error('pod shadow: host timeout');
  };
  ensureLive();
  const command = [...options.command];
  if (command.length === 0) throw new Error('pod command: 명령이 비었다');
  const skills = [...new Set((options.skills ?? []).map((s) => s.trim()).filter(Boolean))];
  const llm = options.llm;
  const log = options.log ?? ((c, e, d) => debug.log(c, e, d));
  if (provenance.missing.length) log('pod.provenance', 'missing-gate-fields', { missing: provenance.missing });
  const baseKubectl = options.kubectl ?? ((args: readonly string[], input?: string) =>
    defaultKubectl(args, input, options.signal ? POD_COMMAND_CANCEL_KUBECTL_TIMEOUT_MS : undefined));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const namespace = options.namespace ?? 'elanous-test';
  const image = options.image ?? podCommandImageFor(skills, options.clone === true, options.lite === true);
  if (options.warmProducer && (!options.clone || options.source?.kind !== 'commit' || options.source.sha !== options.warmProducer.commit || options.image !== options.warmProducer.image || options.imageCommit !== options.warmProducer.commit)) {
    throw new Error('pod warm source: consumer image and source commit must match producer');
  }
  if (options.warmProducer && (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(options.warmProducer.pod) || !options.warmProducer.podUid || typeof options.warmProducer.context !== 'string' || !/^[0-9a-f]{40}$/.test(options.warmProducer.commit) || options.warmProducer.files.length !== 2 || options.warmProducer.files.some((path) => !path || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..' || !/^[\w.-]+$/.test(part))))) {
    throw new Error('pod warm source: invalid producer identity, commit or file path');
  }
  if (options.shelfImage && (options.image !== options.shelfImage || !options.imageCommit || !options.clone || options.source?.kind !== 'commit' || options.source.sha !== options.imageCommit)) {
    throw new Error('pod shelf: image and source commit must match');
  }
  const memoryLimit = options.memoryLimit ?? (image === POD_LITE_IMAGE ? POD_LITE_MEMORY_LIMIT : undefined);
  const repoUrl = options.repoUrl ?? 'https://github.com/ElanvitalAI/elanous';
  const deadlineSeconds = options.deadlineSeconds ?? POD_COMMAND_DEADLINE_SECONDS;
  // POD1 (10-01): two launches in the same moment got the same `si-cmd-<time>` and the failing one's cleanup
  // deleted the other's credentials. The name now has a random tail, and cleanup selects this launch's label.
  const launch = randomBytes(6).toString('hex');
  const name = options.name ?? podJobName(`cmd-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`);
  const own = `elanous.job=${name},elanous.launch=${launch}`;
  const env = options.env ?? process.env;
  const hostMirror = (options.hostMirror ?? env.ELANOUS_POD_HOST_MIRROR
    ?? (options.configHostMirror ?? (() => getUserConfig().pod?.hostMirror))())?.trim() || undefined;
  if (hostMirror && !isAbsolute(hostMirror)) throw new Error('pod.hostMirror must be an absolute directory path');
  const bunCache = options.bunCache?.trim() || undefined;
  if (bunCache && !isAbsolute(bunCache)) throw new Error('pod.bunCache must be an absolute directory path');
  const installSlots = options.installSlots?.trim() || undefined;
  if (installSlots && !isAbsolute(installSlots)) throw new Error('pod installSlots must be an absolute directory path');
  // Fail before any Secret/Job is applied — a bad quantity must not reach the cluster.
  if (options.cpu) resolvePodCpu(options.cpu);

  let member: PodPoolMember | null = null;
  let pool = options.poolScheduler;
  if (!pool) {
    const spec = resolvePodPoolSpec(options.pool, env, () => options.kubectl ? undefined : getUserConfig().pod?.pool);
    if (options.pool && !spec) throw new Error('pod command: 풀 스펙이 비었다');
    if (spec) {
      const members = parsePodPool(spec);
      const checked = (options.checkPool ?? checkPodPool)(members, baseKubectl as PoolKubectl);
      if (!checked.ok) throw new Error('pod command: 풀의 노드가 하나도 준비되지 않았다');
      // Occupancy reads go through the same kubectl as the readiness check (an injected one included).
      pool = new PodPoolScheduler(checked.ready, { kubectl: baseKubectl as PoolKubectl });
    }
  }
  if (pool) {
    // POOLGLOBAL-REG: a caller that hands in its own scheduler (the release gate fans its shards over one) holds its own
    // concurrency cap — its Jobs count against the spec caps, not the cluster's goal Pods (#24253 → 0.2.15 gate ran 1 shard).
    const selfCapped = options.poolScheduler !== undefined;
    for (;;) {
      ensureLive();
      const acquiring = pool.tryAcquire(undefined, undefined, { selfCapped, signal: options.signal });
      try { member = await awaitPodCommandAbort(acquiring, options.signal); }
      catch (error) {
        // If cancellation won the await at the same instant acquisition completed, return that lease.
        void acquiring.then((late) => { if (late) pool!.release(late); }, () => {});
        throw error;
      }
      if (member) break;
      await awaitPodCommandAbort(sleep(options.pollMs ?? 15_000), options.signal);
    }
  }
  if (options.signal?.aborted) {
    if (member && pool) pool.release(member);
    ensureLive();
  }
  if (options.shelfImage && !member) throw new Error('pod shelf: remote pool member required');
  const currentContext = member || options.kubectl ? null : baseKubectl(['config', 'current-context']);
  const context = member?.context ?? (currentContext?.status === 0 ? currentContext.stdout.trim() : '');
  const kubectlRaw: Kubectl = (args, stdin) => baseKubectl(context ? ['--context', context, ...args] : [...args], stdin);
  const kubectl: Kubectl = (args, stdin) => { ensureLive(); const result = kubectlRaw(args, stdin); ensureLive(); return result; };
  const cleanupSecret = () => { kubectlRaw(['-n', namespace, 'delete', 'secret', '-l', own, '--ignore-not-found']); };
  const cleanupWarmSource = () => {
    if (options.warmProducer) kubectlRaw(['-n', namespace, 'delete', 'configmap', '-l', own, '--ignore-not-found']);
  };
  const artifactRoot = options.artifactsRoot ?? `${effectiveInstanceRoot()}/pod-artifacts`;
  const artifactsDir = `${artifactRoot}/${name}`;
  let jobApplied = false;
  /** POD-CPU-REQUEST-RIGHTSIZE-2-FU — 측정값이 정한 요청량(yellow 면 undefined = 기본값 그대로). */
  let rightsizeCpu: PodCpu | undefined;
  try {
    ensureLive();
    if (!context && !options.kubectl) throw new Error('pod command: kubectl context 를 확인할 수 없다');
    if (options.cpuRightsize) {
      const condition = options.cpuRightsize.condition?.trim() || POD_RIGHTSIZE_CONDITION;
      const samples = [...(options.cpuRightsize.samples ?? [])];
      const priorLaunches = [...(options.cpuRightsize.priorLaunches ?? POD_RIGHTSIZE_VOID_LAUNCHES)];
      const targetHost = options.cpuRightsize.host?.trim() || member?.sshHost || null;
      // A no-launch(pod-error) run never produced a reading — firing the same condition again would buy the same void.
      const refusal = podRightsizeRefusal({ condition, samples, priorLaunches });
      if (refusal.refused) {
        log('pod.command-job', 'rightsize-relaunch-refused', {
          condition, host: targetHost, reason: refusal.reason, substrate: 'pod', launched: false, fallback: 'none',
          hitl: true, priorVoid: refusal.priorVoid,
        });
        throw new Error(`pod command: ${refusal.reason}`);
      }
      const requestCpuMillis = podCpuMillis(resolvePodCpu(options.cpu).request)!;
      const members = (pool as { members?: readonly PodPoolMember[] } | undefined)?.members;
      const preconditions = podLaunchPreconditions({
        kubectl, namespace, member,
        pool: members ? { ready: members.filter((m) => m.capacity > 0).length, capacity: members.reduce((sum, m) => sum + Math.max(0, m.capacity), 0) } : null,
        requestCpuMillis,
        sshProbe: options.sshProbe ?? (options.kubectl ? null : (host) => defaultRemoteRun(host, 'true')),
      });
      log('pod.command-job', 'rightsize-preconditions', { condition, host: targetHost, job: name, context, preconditions });
      const blocked = (['slots', 'ssh', 'admission', 'baseline'] as const).filter((key) => !preconditions[key].ok);
      if (blocked.length) {
        log('pod.command-job', 'rightsize-launch-refused', {
          condition, host: targetHost, job: name, context, blocked, preconditions,
          substrate: 'pod', launched: false, fallback: 'none', hitl: true,
        });
        throw new Error(`pod command: 발사 선행 조건 미충족(${blocked.join(', ')}) — 발사 0 · HITL`);
      }
      const verdict = podCpuRightsize(samples);
      log('pod.command-job', 'cpu-rightsize', {
        condition, host: targetHost, job: name, status: verdict.status, request: verdict.request, reason: verdict.reason, samples: verdict.measured,
      });
      if (verdict.status === 'green') rightsizeCpu = { request: verdict.request };
    }
    let grokAuth: string | undefined;
    if (llm === 'grok') {
      // POD-GROK-VALIDITY-FIT — this Job's deadline is not fitted to the token, so the copy must outlive the whole Job.
      const creds = (options.grokCredentials ?? (() => hostGrokCredentials({ env, apiKeyOptIn: false, minValidityMs: deadlineSeconds * 1000 })))();
      if (!creds.grokAuth) throw new Error('grok: 구독 자격 없음 · API 키 opt-in 꺼짐 또는 키 없음');
      let parsed: unknown;
      try { parsed = JSON.parse(creds.grokAuth); } catch { throw new Error('grok: Pod 구독 자격 JSON 이 아니다'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Object.values(parsed).some((scope) => scope && typeof scope === 'object' && typeof (scope as { key?: unknown }).key === 'string') || /"[^"]*refresh[^"]*"\s*:/i.test(creds.grokAuth)) {
        throw new Error('grok: Pod 구독 자격에 access 토큰이 없거나 refresh 필드가 있다');
      }
      grokAuth = creds.grokAuth;
    }
    const skillEnvText = skills.length ? (options.readSkillEnv ?? readSkillEnvFiles)(skills) : {};
    // ☸️ 원격 노드면 목표 판 = 발사 트리의 HEAD(하니스 발사와 같은 규칙) — 이 기계의 로컬 이미지 판을 따르지 않는다.
    //   🐞 2026-09-27(🅞 실측): 로컬 `elanous-harness:local` 이 옛 판(30f95cf1)이라 레지스트리의 옛 태그를 골라 새 스킬이 없는 이미지로 돌았다.
    const imageCommit = options.imageCommit !== undefined
      ? options.imageCommit
      : options.kubectl ? null
        : podCommandTargetCommit({
          remote: Boolean(member?.sshHost),
          gitHead: () => spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() || null,
          localImageCommit: () => podImageFreshness({ image }).imageCommit,
        });
    if (pool && member) {
      const localSkillsDigest = options.kubectl ? null : image === POD_LITE_IMAGE
        ? podSkillsDigest(POD_NETWORK_SKILLS, resolve(import.meta.dir, '../../../skills')).digest
        : podSkillsDigest(resolvePodSkills(env).skills).digest;
      if (options.warmProducer) {
        // The leased producer is already running this immutable image on the selected pool.
        // Do not replace it with the host's independently synchronized commit tag.
        member = { ...member, imageRef: options.warmProducer.image };
      } else if (options.shelfImage) {
        const found = (options.shelfLookup ?? registryImageRef)(member, imageCommit);
        if (found !== options.shelfImage) throw new Error(`pod shelf: selected image unavailable on ${member.context}`);
        member = { ...member, imageRef: found };
      } else {
        const syncs = await awaitPodCommandAbort((options.syncImages ?? syncPoolImages)([member], image, imageCommit, { localSkillsDigest }), options.signal);
        const synced = syncs.get(member.context);
        if (synced && !synced.ok) throw new Error(`pod command: 이미지 판을 못 맞췄다: ${synced.detail}`);
        if (synced?.imageRef) member = { ...member, imageRef: synced.imageRef };
      }
    }
    const imageRef = member?.imageRef;
    if (!imageRef) log('pod.command-job', 'image-fallback-local', { reason: !member ? 'no-pool-member' : !imageCommit ? 'image-commit-unavailable' : 'registry-tag-unavailable' });
    // GATE-WARM-BOOT (10-15): a commit-pinned clone on a pool host — put that commit into the host's mirror first (once per
    // host·commit in this process), so the Pod's podSourceScript finds it (`cat-file -e`) instead of fetching from GitHub.
    // Best effort: a failed seed only logs; the Pod keeps the old path. Never with an injected kubectl (tests) unless seeded.
    const seedMirror = options.seedMirror ?? (options.kubectl ? undefined : seedMirrorOnce);
    if (seedMirror && options.clone && options.source?.kind === 'commit' && hostMirror && member?.sshHost) {
      // Worst case added to a cold start: the push limit (GATE_MIRROR_SEED_LIMIT_MS), once per host·commit.
      const seed = await awaitPodCommandAbort(seedMirror({ host: member.sshHost, commit: options.source.sha, cwd: options.mirrorSeedCwd ?? process.cwd() })
        .catch((error: unknown) => ({ host: member!.sshHost!, ok: false, ms: 0, detail: String(error).slice(0, 300) })), options.signal);
      log('pod.command-job', 'mirror-seed', { host: member.sshHost, commit: options.source.sha, ok: seed?.ok ?? false, ms: seed?.ms ?? 0, ...(seed?.detail ? { detail: seed.detail } : {}) });
    }
    // Only a matching, live producer may hand its two source files to this Job; no other Pod's tree is trusted.
    const warmHashes: Record<string, string> = {};
    if (options.warmProducer) {
      const producer = options.warmProducer;
      if (context !== producer.context || (imageRef && imageRef !== producer.image)) throw new Error('pod warm source: selected pool or image differs from producer');
      const got = kubectl(['-n', namespace, 'get', 'pod', producer.pod, '-o', 'json']);
      if (got.status !== 0) throw new Error('pod warm source: producer Pod unavailable');
      let pod: { metadata?: { name?: string; uid?: string }; spec?: { containers?: Array<{ name?: string; image?: string }> } };
      try { pod = JSON.parse(got.stdout); } catch { throw new Error('pod warm source: invalid producer Pod'); }
      if (pod.metadata?.name !== producer.pod || pod.metadata?.uid !== producer.podUid || pod.spec?.containers?.find((container) => container.name === 'child')?.image !== producer.image) {
        throw new Error('pod warm source: producer Pod identity or image mismatch');
      }
      // kubectl exec starts in the image working directory; podSourceScript cloned
      // `repo` there, then changed directory only in the original Job shell.
      const head = kubectl(['-n', namespace, 'exec', producer.pod, '-c', 'child', '--', 'bash', '-c', 'git -C repo rev-parse HEAD']);
      if (head.status !== 0 || head.stdout.trim() !== producer.commit) throw new Error('pod warm source: producer commit mismatch');
      const binaryData: Record<string, string> = {};
      for (const [i, path] of producer.files.entries()) {
        const read = kubectl(['-n', namespace, 'exec', producer.pod, '-c', 'child', '--', 'bash', '-c', `base64 -w0 ${bashSingleQuote(`repo/${path}`)}`]);
        if (read.status !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(read.stdout.trim())) throw new Error(`pod warm source: producer file unavailable: ${path}`);
        binaryData[`file-${i}`] = read.stdout.trim();
        warmHashes[path] = createHash('sha256').update(Buffer.from(binaryData[`file-${i}`]!, 'base64')).digest('hex');
      }
      const config = { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: warmSourceName(name, launch), namespace, labels: { 'elanous.job': name, 'elanous.launch': launch } }, binaryData };
      const applied = kubectl(['apply', '-f', '-'], JSON.stringify(config));
      if (applied.status !== 0) throw new Error(applied.stderr.trim() || 'pod warm source: ConfigMap apply failed');
    }
    // GATE-WARM-BOOT-NO-INIT (10-15): the hostPath dirs the uid-1000 child writes are handed over on the node itself, once per
    // member·paths in this process (no init container). Best effort: a failure only logs; the child then falls back.
    const hostDirPaths = [...(bunCache ? [bunCache] : []), ...(installSlots ? [installSlots] : [])];
    const prepareHostDirs = options.prepareHostDirs ?? (options.kubectl ? undefined : prepareHostDirsOnce);
    let hostDirsPrepared = false;
    if (hostDirPaths.length) {
      // Observed whether or not a hand-over runs: no member (nothing to reach) and an injected kubectl without a seam are skips.
      if (!member) log('pod.command-job', 'host-dirs-prep', { ok: false, reason: 'no-pool-member', paths: hostDirPaths });
      else if (!prepareHostDirs) log('pod.command-job', 'host-dirs-prep', { ok: false, reason: 'prep-disabled', paths: hostDirPaths });
      else {
        const prep = await awaitPodCommandAbort(prepareHostDirs({ member, hostPaths: hostDirPaths })
          .catch((error: unknown) => ({ host: member!.sshHost ?? 'local', ok: false, ms: 0, detail: String(error).slice(0, 300) })), options.signal);
        hostDirsPrepared = prep?.ok === true;
        log('pod.command-job', 'host-dirs-prep', { host: prep?.host ?? member.sshHost ?? 'local', ok: prep?.ok ?? false, ms: prep?.ms ?? 0, paths: hostDirPaths, ...(prep?.detail ? { detail: prep.detail } : {}) });
      }
    }
    // Any path where the node-side hand-over did not succeed keeps the old in-Pod hand-over (review mf: uid 1000 could not write).
    const hostDirsInit = hostDirPaths.length > 0 && !hostDirsPrepared;
    ensureLive();
    const ghToken = options.clone ? (options.ghToken ?? defaultGhToken)() : undefined;
    const secret = commandJobSecret({ name, namespace, launch, skills, skillEnvText, ...(grokAuth !== undefined ? { grokAuth } : {}), ...(ghToken !== undefined ? { ghToken } : {}) });
    if (secret) {
      const applied = kubectl(['apply', '-f', '-'], JSON.stringify(secret));
      if (applied.status !== 0) throw new Error(applied.stderr.trim() || 'pod command: Secret 적용 실패');
    }
    const effectiveCpu = options.cpu ?? rightsizeCpu;
    const manifest = podCommandJobManifest({
      name, namespace, launch, image: imageRef ?? image,
      provenance: options.provenance, provenanceGate: options.provenanceGate,
      ...(imageRef ? { imagePullPolicy: 'IfNotPresent' as const } : {}),
      repoUrl, command, skills, ...(options.returnLogs ? { returnLogs: true } : {}), ...(llm ? { llm } : {}), ...(options.clone ? { clone: true } : {}),
      ...(options.source ? { source: options.source } : {}), ...(options.warmProducer ? { warmFiles: options.warmProducer.files } : {}), ...(hostMirror ? { hostMirror } : {}), ...(bunCache ? { bunCache } : {}), ...(installSlots ? { installSlots } : {}), ...(memoryLimit ? { memoryLimit } : {}), ...(effectiveCpu ? { cpu: effectiveCpu } : {}), ...(options.tmpfsSizeLimit ? { tmpfsSizeLimit: options.tmpfsSizeLimit } : {}), deadlineSeconds,
      ...(options.runId ? { runId: options.runId } : {}),
      ...(hostDirsInit ? { hostDirsInit: true } : {}),
    });
    kubectl(['-n', namespace, 'delete', 'job', '-l', own, '--ignore-not-found']);
    // A wall deadline can elapse inside the synchronous apply; cleanup by this launch's name then remains safe.
    jobApplied = true;
    const applied = kubectl(['apply', '-f', '-'], JSON.stringify(manifest));
    if (applied.status !== 0) {
      cleanupSecret();
      throw new Error(applied.stderr.trim() || 'pod command: Job 적용 실패');
    }
    let state: 'complete' | 'failed' = 'failed';
    let unreadableSince: number | null = null;
    let markerRc: number | null = null;
    const appliedAt = Date.now();
    for (;;) {
      // PRLAND-SHADOW-HOST-TIMEOUT: a Pending Pod poll never ends by itself — the host wall-clock deadline ends the
      // loop here (before another status read) and leaves exactly one timeout record (deadline time ⊕ final state).
      if (options.hostDeadlineAtMs !== undefined && nowMs() >= options.hostDeadlineAtMs) {
        log('pod.command', 'host-timeout', { job: name, context, hostDeadlineAtMs: options.hostDeadlineAtMs, nowMs: nowMs(), finalState: 'timeout', waitedMs: nowMs() - appliedAt });
        throw new Error('pod shadow: host timeout');
      }
      ensureLive();
      const got = kubectl(['-n', namespace, 'get', 'job', name, '-o', 'jsonpath={.status.conditions[*].type}']);
      const finished = jobFinished(got.stdout);
      if (finished) { state = finished; break; }
      // GATE-POD-RESULT-MARKER: the condition is not there yet — the child may already be done (k3d condition lag).
      // A tail read that fails (Pod still pending · init container) or lacks the marker changes nothing.
      const tail = kubectl(['-n', namespace, 'logs', `job/${name}`, '-c', 'child', '--tail=2']);
      if (tail.status === 0) {
        const seen = splitPodResultMarker(tail.stdout.startsWith('\n') ? tail.stdout : `\n${tail.stdout}`, launch).rc;
        if (seen !== null) {
          markerRc = seen;
          state = seen === 0 ? 'complete' : 'failed';
          log('pod.command-job', 'result-marker-early', { job: name, waitedMs: Date.now() - appliedAt, rc: seen });
          break;
        }
      }
      if (got.status !== 0 && options.statusUnreadableMs !== undefined) {
        unreadableSince ??= Date.now();
        if (Date.now() - unreadableSince >= options.statusUnreadableMs) {
          log('pod.command', 'job-status-unreadable', { job: name, context, unreadableMs: Date.now() - unreadableSince, error: (got.stderr ?? '').trim().slice(0, 300) });
          throw new Error(`pod command: Job 상태를 ${Math.round(options.statusUnreadableMs / 1000)}초 동안 못 읽었다(${context}) — ${(got.stderr ?? '').trim().split('\n').pop()?.slice(0, 200) ?? ''}`);
        }
      } else unreadableSince = null;
      await awaitPodCommandAbort(sleep(options.pollMs ?? 15_000), options.signal);
    }
    ensureLive();
    if (options.warmProducer) {
      const found = kubectl(['-n', namespace, 'get', 'pods', '-l', `job-name=${name}`, '-o', 'json']);
      let pods: { items?: Array<{ metadata?: { name?: string }; spec?: { containers?: Array<{ name?: string; image?: string }> } }> };
      try { pods = JSON.parse(found.stdout); } catch { throw new Error('pod warm source: consumer Pod unavailable'); }
      // A retried Job can leave an older Pod in the list. Never attribute the
      // warm-source proof to an arbitrary Pod when the consumer is ambiguous.
      const consumer = pods.items?.length === 1 ? pods.items[0] : undefined;
      if (found.status !== 0 || !consumer?.metadata?.name || consumer.metadata.name === options.warmProducer.pod || consumer.spec?.containers?.find((container) => container.name === 'child')?.image !== (imageRef ?? image)) {
        throw new Error('pod warm source: consumer Pod identity or image mismatch');
      }
      log('pod.command-job', 'warm-source-linked', { producerPod: options.warmProducer.pod, consumerPod: consumer.metadata.name, image: imageRef ?? image, commit: options.warmProducer.commit, files: [...options.warmProducer.files] });
    }
    let logsResult = kubectl(['-n', namespace, 'logs', `job/${name}`, '-c', 'child']);
    // Marker path returns before the Job condition — a full-log read can hit the same transient window the tail read
    // already survived (container log rotation · API hiccup). Retry it a little before calling the artifacts lost.
    // A read that «succeeds» but stops before this launch's marker (empty · cut off) is incomplete too (review mf · #27842).
    const fullLogIncomplete = (r: { status: number | null; stdout: string }) =>
      r.status !== 0 || splitPodResultMarker(r.stdout.startsWith('\n') ? r.stdout : `\n${r.stdout}`, launch).rc === null;
    for (let attempt = 1; markerRc !== null && fullLogIncomplete(logsResult) && attempt <= POD_MARKER_LOG_RETRIES; attempt++) {
      log('pod.command-job', 'result-marker-log-retry', { job: name, attempt, ...(logsResult.status !== 0 ? { error: (logsResult.stderr ?? '').trim().slice(0, 200) } : { reason: 'marker-missing-in-full-log' }) });
      await sleep(options.pollMs === undefined ? 1_000 : Math.min(options.pollMs, 1_000));   // ≤2 re-reads within ≈2s total
      logsResult = kubectl(['-n', namespace, 'logs', `job/${name}`, '-c', 'child']);
    }
    // Still without this launch's marker after the retries: the artifacts are not trusted as complete (explicit failure).
    if (markerRc !== null && logsResult.status === 0 && fullLogIncomplete(logsResult)) {
      logsResult = { ...logsResult, status: 1, stderr: 'full log ended before this launch\'s result marker (incomplete after retries)' };
    }
    const logsFailed = logsResult.status !== 0;
    const logs = logsFailed ? '' : splitPodResultMarker(logsResult.stdout, launch).logs;
    if (options.warmProducer) {
      if (logsFailed) throw new Error(`pod warm source: consumer logs unavailable: ${logsResult.stderr.trim() || logsResult.status}`);
      for (const path of options.warmProducer.files) {
        const marker = `ELANOUS_WARM_SOURCE ${path} ${warmHashes[path]} ${options.warmProducer.commit}`;
        if (logs.split(/\r?\n/).filter((line) => line === marker).length !== 1) throw new Error(`pod warm source: consumer file or commit mismatch: ${path}`);
      }
    }
    const artifactDir = artifactRoot;
    let artifacts: PodArtifactCollection;
    if (logsFailed) {
      const reason = logsResult.stderr.trim() || `kubectl logs exit ${logsResult.status}`;
      artifacts = { files: null, names: [], error: reason };
      log('pod.command', 'artifact-collect-failed', { job: name, reason });
    } else {
      const store = options.returnLogs ? (options.logStore === undefined ? getDefaultLogStore() : options.logStore) : null;
      collectPodArtifacts(logs, {
        dir: artifactDir, job: name, log: (c, e, d) => log(c, e, d),
        ...(options.returnLogs ? { logStore: store } : {}),
      });
      const names = artifactNames(logs);
      // A plain command need not write JSONL. Make its child output queryable without changing the store schema.
      if (options.returnLogs && store) {
        try {
          const output = logs.split(/\r?\n/).filter((line) => !line.startsWith('ELANOUS_POD_ARTIFACT ')).join('\n').trim();
          if (output) store.insertPodBatch(name, [{ line: -1, surface: 'pod', rec: {
            ts: new Date().toISOString(), category: 'pod.command', event: 'child-output', level: 'info',
            data: { job: name, output: tailBytes(output, options.childLogMaxBytes ?? podChildLogMaxBytes()), origin: 'pod', podJob: name },
          } }]);
        } catch (error) {
          log('pod.command', 'child-output-import-failed', { job: name, reason: error instanceof Error ? error.message : String(error) });
        }
      }
      artifacts = { files: names.length, names, error: null };
    }
    // 표지가 없어도 알리는 경로는 실제로 존재해야 한다. 자식 로그 전문은 child.log (상한 넘으면 끝부분).
    mkdirSync(artifactsDir, { recursive: true });
    const maxBytes = options.childLogMaxBytes ?? podChildLogMaxBytes();
    const childLog = logsFailed ? `산출 회수 못 함: ${artifacts.error}` : tailBytes(logs, maxBytes);
    writeFileSync(resolve(artifactsDir, 'child.log'), childLog);
    // Marker path: the rc the child printed (the Pod's terminated state may lag like the condition). Condition path: unchanged.
    const exitCode = markerRc ?? exitCodeFromPod(kubectl, namespace, name, state);
    cleanupSecret();
    cleanupWarmSource();
    log('pod.command', 'job-finished', {
      job: name,
      exitCode,
      skills,
      llm: llm ?? null,
      command: command.join(' ').slice(0, COMMAND_LOG_CHARS),
      artifactsDir,
      artifacts,
      ...(logsFailed ? { artifactError: `산출 회수 못 함: ${artifacts.error}` } : {}),
    });
    return { exitCode, artifactsDir, job: name, image: imageRef ?? image, artifacts };
  } catch (err) {
    if (jobApplied && options.signal) {
      // Opt-in bounded callers remove their own failed/Pending Job, including status-unreadable exits.
      // On an unreachable API this is best effort; the local lease is always released in finally.
      try { kubectlRaw(['-n', namespace, 'delete', 'job', name, '--ignore-not-found', '--wait=false']); }
      catch { /* preserve the cancellation reason */ }
    }
    cleanupSecret();
    cleanupWarmSource();
    throw err;
  } finally {
    if (member && pool) pool.release(member);
  }
}
