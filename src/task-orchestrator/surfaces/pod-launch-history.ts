/**
 * POD-LAUNCH-PROVENANCE slice 2 — TA/harness si-task Jobs.
 *
 * ① `siTaskPodProvenance` fills the shared provenance set (pod-provenance.ts · #29650) for a si-task Job from the
 *    launch env the parent already has (owner · seat · task card · checklist slot · entrance stamp). It never builds
 *    labels itself — `podProvenanceMetadata` stays the one builder.
 * ② The history is append-only rows on the parent's existing run ledger (`pod-launch-started` when the Job is
 *    applied, `pod-launch-finished` at the terminal verdict) — no new store. `readPodLaunchHistory(runId)` answers
 *    «who launched which Pod, when and why, and how did it end» from that ledger alone.
 */
import { userInfo } from 'node:os';
import { LAUNCH_SEATS, resolveLaunchStamp } from '../../harness/launch-stamp.js';
import { loadRunLedger, runLedgerDir, type RunLedgerEntry } from '../../self-implement/run-ledger.js';
import type { PodProvenance } from './pod-provenance.js';
import type { PodWorkIdentity } from './pod-pool.js';

export const POD_LAUNCH_STARTED_EVENT = 'pod-launch-started';
export const POD_LAUNCH_FINISHED_EVENT = 'pod-launch-finished';

export interface SiTaskProvenanceInput {
  env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>;
  /** The child runId this Job runs as (`ELANOUS_RUN_ID` inside the Pod). */
  runId: string;
  parentRunId?: string;
  workIdentity: PodWorkIdentity;
  /** ISO-8601 UTC. */
  requestedAt: string;
  feature: string;
  launchHost?: string;
  commit?: string | null;
  version?: string;
  memReq?: string;
  shard?: string;
}

const text = (value: string | undefined | null): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

function osUser(): string | undefined {
  try { return text(userInfo().username); } catch { return undefined; }
}

/**
 * The si-task identity. Actor order: the Job owner the dispatcher named → the launch stamp actor (seat · session · loop)
 * → the OS user. `pool` is deliberately absent: `ELANOUS_POD_POOL` is read as pool config by the child harness.
 */
export function siTaskPodProvenance(input: SiTaskProvenanceInput): Partial<PodProvenance> {
  const env = input.env as NodeJS.ProcessEnv;
  const identity = input.workIdentity;
  const stamp = resolveLaunchStamp({}, env);
  const ownerId = text(identity.ownerId);
  const stampActor = text(stamp.actor);
  const user = text(env.USER) ?? text(env.LOGNAME) ?? osUser();
  const actor = ownerId ?? stampActor ?? user;
  const actorKind = ownerId && identity.ownerKind
    ? (identity.ownerKind === 'steward' || identity.ownerKind === 'orchestrator' ? 'loop' : identity.ownerKind)
    : stampActor && (LAUNCH_SEATS as readonly string[]).includes(stampActor) ? 'seat'
      : stampActor && stampActor === text(env.ELANOUS_LOOP_NAME) ? 'loop'
        : actor ? 'human' : undefined;
  const authoring = identity.work === 'authoring';
  const entrance = stamp.entrance !== 'unknown' ? stamp.entrance : identity.taskCard ? 'tasks-hand' : undefined;
  const firstLine = input.feature.split('\n', 1)[0]?.trim().slice(0, 160) ?? '';
  const reason = [identity.taskCard ? `TA ${identity.taskCard}` : undefined, firstLine || undefined].filter(Boolean).join(' · ');
  return {
    ...(actorKind ? { actorKind } : {}),
    ...(actor ? { actor } : {}),
    kind: 'si-task',
    run: input.runId,
    phase: authoring ? 'authoring' : 'impl',
    requestedAt: input.requestedAt,
    character: identity.taskCard ? 'ta-child' : authoring ? 'author-child' : 'harness-child',
    ...(entrance ? { entrance } : {}),
    ...(text(identity.slotId) ? { cell: identity.slotId } : {}),
    ...(text(input.version) ? { version: input.version } : {}),
    ...(text(input.commit) ? { commit: input.commit! } : {}),
    ...(text(input.launchHost) ? { launchHost: input.launchHost } : {}),
    ...(text(input.shard) ? { shard: input.shard } : {}),
    ...(text(input.memReq) ? { memReq: input.memReq } : {}),
    ...(text(input.parentRunId) ? { parent: input.parentRunId } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** `elanous.ai/<key>` annotations → `{ <key>: value }` for the started row (full values, not the 63-char labels). */
export function provenanceRowFromAnnotations(annotations: Readonly<Record<string, string>>): Record<string, string> {
  const row: Record<string, string> = {};
  for (const [key, value] of Object.entries(annotations)) if (key.startsWith('elanous.ai/')) row[key.slice('elanous.ai/'.length)] = value;
  return row;
}

export interface PodLaunchRecord {
  job: string;
  run: string;
  attempt: number | null;
  startedAt: string | null;
  provenance: Record<string, string>;
  finished: { at: string | null; phase: string; exitCode: number | null; reason: string } | null;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

/** Rebuild launch records from one run ledger. Rows pair on job·run; an unpaired row stays visible (never dropped). */
export function readPodLaunchHistory(runId: string, dir: string = runLedgerDir()): PodLaunchRecord[] {
  const entries: RunLedgerEntry[] = loadRunLedger(runId, dir) ?? [];
  const records: PodLaunchRecord[] = [];
  const open = new Map<string, PodLaunchRecord>();
  for (const entry of entries) {
    if (entry.event !== POD_LAUNCH_STARTED_EVENT && entry.event !== POD_LAUNCH_FINISHED_EVENT) continue;
    const job = str(entry.data.job) ?? 'unknown';
    const run = str(entry.data.run) ?? 'unknown';
    const key = `${job}\u0000${run}`;
    if (entry.event === POD_LAUNCH_STARTED_EVENT) {
      const provenance: Record<string, string> = {};
      const raw = entry.data.provenance;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [name, value] of Object.entries(raw as Record<string, unknown>)) if (typeof value === 'string') provenance[name] = value;
      }
      const record: PodLaunchRecord = { job, run, attempt: typeof entry.data.attempt === 'number' ? entry.data.attempt : null,
        startedAt: entry.timestamp ?? null, provenance, finished: null };
      records.push(record);
      open.set(key, record);
      continue;
    }
    const finished = { at: entry.timestamp ?? null, phase: str(entry.data.phase) ?? 'unknown',
      exitCode: typeof entry.data.exitCode === 'number' ? entry.data.exitCode : null, reason: str(entry.data.reason) ?? 'unknown' };
    const started = open.get(key);
    if (started && !started.finished) { started.finished = finished; open.delete(key); continue; }
    records.push({ job, run, attempt: typeof entry.data.attempt === 'number' ? entry.data.attempt : null, startedAt: null, provenance: {}, finished });
  }
  return records;
}
