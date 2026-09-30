import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { normalizeRunId } from './harness-space.js';
import { controlInboxPath, type ControlMemoPayload } from './control-inbox.js';
import { sendPodControl } from './pod-control-send.js';
import type { Kubectl } from '../task-orchestrator/surfaces/self-implement-pod.js';

export interface PodFragmentRecord {
  spaceId: string;
  runId?: string;
  parentRunId?: string;
  context: string;
  namespace: string;
  job: string;
  inboxDir: string;
}

function podRecordPath(spaceId: string, env?: NodeJS.ProcessEnv): string {
  return `${controlInboxPath(spaceId, env)}.pod.json`;
}

export function readPodFragment(spaceId: string, env?: NodeJS.ProcessEnv): PodFragmentRecord | null {
  try {
    const record = JSON.parse(readFileSync(podRecordPath(spaceId, env), 'utf8')) as PodFragmentRecord;
    return record.spaceId === spaceId && typeof record.context === 'string' && typeof record.namespace === 'string'
      && typeof record.job === 'string' && typeof record.inboxDir === 'string' ? record : null;
  } catch { return null; }
}

export function podFragmentFinished(spaceId: string, env?: NodeJS.ProcessEnv): boolean {
  return existsSync(`${podRecordPath(spaceId, env)}.finished`);
}

export function listPodFragmentsForRun(runId: string, env?: NodeJS.ProcessEnv): PodFragmentRecord[] {
  if (!runId || runId !== normalizeRunId(runId)) return [];
  const dir = dirname(podRecordPath('fragment', env));
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const suffix = '.inbox.pod.json';
  const matches: PodFragmentRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(suffix)) continue;
    const spaceId = name.slice(0, -suffix.length);
    if (podFragmentFinished(spaceId, env)) continue;
    const record = readPodFragment(spaceId, env);
    if (record && ((record.runId === runId && normalizeRunId(record.runId) === runId)
      || (record.parentRunId === runId && normalizeRunId(record.parentRunId) === runId))) matches.push(record);
  }
  return matches;
}

export function writePodFragment(record: PodFragmentRecord, env?: NodeJS.ProcessEnv): void {
  const path = podRecordPath(record.spaceId, env);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(record), { flag: 'wx' });
    renameSync(temp, path);
    rmSync(`${path}.finished`, { force: true });
  } finally { rmSync(temp, { force: true }); }
}

export function finishPodFragment(spaceId: string, env?: NodeJS.ProcessEnv): void {
  const path = podRecordPath(spaceId, env);
  if (existsSync(path)) {
    writeFileSync(`${path}.finished`, spaceId);
    rmSync(path);
  }
}

export function dispatchPodSelfSend(spaceId: string, message: { stop: true } | { memo: ControlMemoPayload }, kubectl?: Kubectl, env?: NodeJS.ProcessEnv): { job: string } | null {
  const record = readPodFragment(spaceId, env);
  if (!record) {
    if (podFragmentFinished(spaceId, env)) throw new Error(`self send 대상 조각이 이미 끝났다: ${spaceId}`);
    return null;
  }
  sendPodControl(record, message, kubectl);
  return { job: record.job };
}

export type SelfSendTargetResolution =
  | { kind: 'space'; spaceId: string }
  | { kind: 'space'; spaceId: string; via: 'pty'; ptyId: string }
  | {
    kind: 'refuse';
    reason: 'tui-self-report-has-no-inbox-reader' | 'pty-not-found' | 'pty-has-no-space';
    hint?: string;
  };

export interface SelfSendTargetDeps {
  getPtyManifest(id: string): { spaceId: string; ptyPid?: number } | null;
  listPtyManifestRows(): Array<{ id: string; spaceId: string; ptyPid?: number }>;
}

export function resolveSelfSendTarget(requested: string, deps: SelfSendTargetDeps): SelfSendTargetResolution {
  if (requested.startsWith('pty_')) {
    const manifest = deps.getPtyManifest(requested);
    if (manifest === null) return { kind: 'refuse', reason: 'pty-not-found' };
    if (manifest.spaceId === '') return { kind: 'refuse', reason: 'pty-has-no-space' };
    return { kind: 'space', spaceId: manifest.spaceId, via: 'pty', ptyId: requested };
  }

  if (requested.startsWith('tui:')) {
    const ptyPid = Number(requested.slice('tui:'.length));
    const matchingRow = Number.isInteger(ptyPid)
      ? deps.listPtyManifestRows().find((row) => row.ptyPid === ptyPid && row.spaceId !== '')
      : undefined;
    return {
      kind: 'refuse',
      reason: 'tui-self-report-has-no-inbox-reader',
      ...(matchingRow === undefined ? {} : { hint: matchingRow.spaceId }),
    };
  }

  return { kind: 'space', spaceId: requested };
}
