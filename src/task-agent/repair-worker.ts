/** Detached HQ parent for one same-PR Pod repair. It never pushes or opens a PR. */
import { spawn } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RepairCommitResult } from './repair-branch-cas.js';
import type { TaskChildLlm } from './task-hand.js';
import { publishInsideEvent } from '../nexus/api/inside-events.js';
import { taskParentRoleEnv } from './task-parent-role-llm.js';

const SHA40 = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const MARKER = 'ELANOUS_POD_REPAIR_RESULT ';

export interface RepairWorkerRequest {
  card: string; pr: number; head: string; repo: string; resultPath: string;
  entry: string; configDir: string; runId: string; seat?: string;
  model: TaskChildLlm; goal: string;
  parentRoleLlm?: string[];
  /** HARNESS-FULL-GRAPH-NEXTMOVE — 이 발사를 고른 next-move 결정의 수 id(관측 조인 · 없으면 옛 발사). */
  moveId?: string;
}

export interface RepairWorkerResult {
  pr: number; head: string; runId: string; ok: boolean; reason?: string; moveId?: string;
  /** A classified, stable failure only. Generic gate-failed is deliberately unsigned. */
  failureSignature?: string;
  /** Exact introduced test identities from the same signed gate receipt. */
  gateFailureTests?: string[];
  job?: string; artifactDir?: string; result?: RepairCommitResult;
}

export function repairFailureSignature(output: string): string | null {
  const gate = output.match(/^GATE_FAILURE_SIGNATURE=sha256:([a-f0-9]{64})\s*$/m);
  if (gate) return `gate:sha256:${gate[1]}`;
  const model = output.match(/review fallback: ambiguous or unsupported primary model ["“]([^"”\n]+)["”]/i);
  const name = model?.[1]?.trim().toLowerCase();
  return name && /^[a-z0-9._/-]{1,120}$/.test(name) ? `provider:ambiguous-primary:${name}` : null;
}

export function repairGateFailureTests(output: string): string[] | null {
  const line = /^GATE_FAILURE_TESTS=(\[[^\r\n]*\])\s*$/m.exec(output)?.[1];
  if (!line) return null;
  try {
    const tests: unknown = JSON.parse(line);
    return Array.isArray(tests) && tests.length > 0 && tests.length <= 32
      && tests.every((test) => typeof test === 'string' && test.length > 0 && test.length <= 512)
      ? tests as string[] : null;
  } catch { return null; }
}

export function repairHarnessArgs(request: RepairWorkerRequest): string[] {
  if (!Number.isSafeInteger(request.pr) || request.pr < 1 || !SHA40.test(request.head)
    || !request.goal.trim() || !request.runId) throw new Error('repair worker request invalid');
  return [request.entry, '--config-dir', request.configDir, 'harness', 'say', '--substrate', 'pod',
    '--source', `pr:${request.pr}`, '--repair-commit-only', request.head,
    ...(request.seat ? ['--seat', request.seat] : []), '--no-queue', '--no-auto-merge',
    '--child-llm-provider', request.model.provider, '--child-llm-model', request.model.model,
    ...(request.model.effort ? ['--child-llm-effort', request.model.effort] : []), '--', request.goal];
}

/** The harness-say parent reads role pins from env; its CLI has no --role-llm flag. */
export function repairWorkerEnv(request: RepairWorkerRequest): Record<string, string> {
  return { ELANOUS_RUN_ID: request.runId, ...taskParentRoleEnv(request.parentRoleLlm ?? []) };
}

export function parseRepairMarker(output: string, pr: number, head: string, runId: string): Pick<RepairWorkerResult, 'job' | 'artifactDir' | 'result'> | null {
  const line = output.split(/\r?\n/).reverse().find((entry: string) => entry.startsWith(MARKER));
  if (!line) return null;
  let value: unknown;
  try { value = JSON.parse(line.slice(MARKER.length)); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (v.pr !== pr || v.runId !== runId || typeof v.baseHead !== 'string' || v.baseHead.toLowerCase() !== head.toLowerCase()
    || typeof v.commit !== 'string' || !SHA40.test(v.commit) || typeof v.bundleSha256 !== 'string' || !SHA256.test(v.bundleSha256)
    || typeof v.job !== 'string' || !v.job || typeof v.artifactDir !== 'string' || !v.artifactDir.startsWith('/')) return null;
  return { job: v.job, artifactDir: v.artifactDir,
    result: { pr, baseHead: v.baseHead, runId, commit: v.commit, bundleSha256: v.bundleSha256 } };
}

export async function runRepairWorker(request: RepairWorkerRequest): Promise<RepairWorkerResult> {
  const result: RepairWorkerResult = { pr: request.pr, head: request.head, runId: request.runId, ok: false,
    ...(request.moveId ? { moveId: request.moveId } : {}) };
  try {
    const args = repairHarnessArgs(request);
    const child = spawn(process.execPath, args, {
      cwd: request.repo, env: { ...process.env, ...repairWorkerEnv(request) }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const append = (data: Buffer) => { output = (output + data.toString('utf8')).slice(-512_000); };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const marker = parseRepairMarker(output, request.pr, request.head, request.runId);
    if (code !== 0) {
      result.reason = `harness exited ${code}: ${output.slice(-600)}`;
      const failureSignature = repairFailureSignature(output);
      if (failureSignature) {
        result.failureSignature = failureSignature;
        const tests = failureSignature.startsWith('gate:') ? repairGateFailureTests(output) : null;
        if (tests) result.gateFailureTests = tests;
      }
    }
    else if (!marker) result.reason = `repair artifact marker missing or invalid: ${output.slice(-600)}`;
    else Object.assign(result, { ok: true, ...marker });
  } catch (error) {
    result.reason = error instanceof Error ? error.message : String(error);
  }
  mkdirSync(dirname(request.resultPath), { recursive: true });
  const tmp = `${request.resultPath}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(result));
  renameSync(tmp, request.resultPath);
  // The result file, rather than this best-effort notification, is the durable source.
  try {
    publishInsideEvent({ kind: 'ta.repair.completed', schema: 1, card: request.card,
      pr: request.pr, head: request.head, runId: request.runId, ...(request.moveId ? { moveId: request.moveId } : {}),
      resultPath: request.resultPath, completedAt: new Date().toISOString() });
  } catch { /* a missing daemon cannot change the worker result */ }
  return result;
}

export function parseRepairWorkerResult(text: string, pr: number, head: string, runId: string): RepairWorkerResult | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as RepairWorkerResult;
  if (v.pr !== pr || typeof v.head !== 'string' || v.head.toLowerCase() !== head.toLowerCase() || v.runId !== runId || typeof v.ok !== 'boolean') return null;
  if (v.failureSignature !== undefined && (typeof v.failureSignature !== 'string'
    || !/^(?:gate:sha256:[a-f0-9]{64}|provider:ambiguous-primary:[a-z0-9._/-]{1,120})$/.test(v.failureSignature))) delete v.failureSignature;
  if (v.gateFailureTests !== undefined && (!v.failureSignature?.startsWith('gate:')
    || !Array.isArray(v.gateFailureTests) || v.gateFailureTests.length < 1 || v.gateFailureTests.length > 32
    || !v.gateFailureTests.every((test) => typeof test === 'string' && test.length > 0 && test.length <= 512))) delete v.gateFailureTests;
  if (v.ok && (typeof v.artifactDir !== 'string' || !v.artifactDir.startsWith('/') || typeof v.job !== 'string' || !v.job
    || !v.result || v.result.pr !== pr || typeof v.result.baseHead !== 'string'
    || v.result.baseHead.toLowerCase() !== head.toLowerCase() || v.result.runId !== runId || !SHA40.test(v.result.commit)
    || !SHA256.test(v.result.bundleSha256))) return null;
  return v;
}
