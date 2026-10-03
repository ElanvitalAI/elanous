import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, statSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { debug } from '../debug/log.js';
import {
  decomposeFabricRequest,
  type FabricDecomposeRequestOptions,
} from './fabric-decompose-adapter.js';
import type { JobKind } from './orchestrate.js';

export interface FabricPlanNode {
  id: string;
  title: string;
  kind: JobKind;
  dependsOn: string[];
  expectedOutput: string;
  children: FabricPlanNode[];
}

export interface FabricPlan {
  id: string;
  request: string;
  status: 'draft' | 'approved';
  nodes: FabricPlanNode[];
  createdAt: string;
  updatedAt: string;
}

export interface FabricPlanEdit {
  id: string;
  title?: string;
  kind?: JobKind;
  dependsOn?: string[];
  expectedOutput?: string;
}

export interface FabricExecutionCandidate {
  planId: string;
  nodes: FabricPlanNode[];
  approvedAt: string;
}

type FabricPlanEvent =
  | { type: 'plan'; plan: FabricPlan }
  | { type: 'execution-candidate'; candidate: FabricExecutionCandidate };
/** An approval is one line, so a torn write can never leave «approved» without its candidate (review must-fix). */
type FabricPlanLine = FabricPlanEvent | { type: 'approved'; plan: FabricPlan; candidate: FabricExecutionCandidate };

function ledgerPath(root: string): string {
  return join(root, 'fabric', 'plans.jsonl');
}

// One ledger lock also protects reads: a reader must not observe half of an approval pair.
// The owner file is fully written before its hard link becomes the visible lock.
function lockOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Process start time as `ps` reports it — with the pid it identifies one process even after the pid is reused. */
function processStart(pid: number): string | null {
  const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  const value = r.status === 0 ? r.stdout.trim() : '';
  return value || null;
}

function reclaimAbandonedLock(lockPath: string): void {
  let observed: string;
  let inode: number;
  try {
    observed = readFileSync(lockPath, 'utf8');
    inode = statSync(lockPath).ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const [pidText, ...startParts] = observed.trim().split('|');
  const pid = Number(pidText);
  const ownerStart = startParts.join('|');
  // Unidentified locks are not evidence that their owner has died.
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  // Alive pid with a different start time = the pid was reused by another process; the owner is gone (review must-fix).
  const reused = ownerStart !== '' && lockOwnerAlive(pid) && processStart(pid) !== null && processStart(pid) !== ownerStart;
  if (lockOwnerAlive(pid) && !reused) return;
  try {
    if (statSync(lockPath).ino === inode && readFileSync(lockPath, 'utf8') === observed) unlinkSync(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function withLedgerLock<T>(root: string, operation: () => T): T {
  const directory = join(root, 'fabric');
  mkdirSync(directory, { recursive: true });
  const lockPath = join(directory, 'plans.lock');
  const ownerPath = join(directory, `plans.lock.${process.pid}.${randomUUID()}`);
  writeFileSync(ownerPath, `${process.pid}|${processStart(process.pid) ?? ''}`, { flag: 'wx' });
  const deadline = Date.now() + 10_000;
  let acquired = false;
  try {
    while (!acquired) {
      try {
        linkSync(ownerPath, lockPath);
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        reclaimAbandonedLock(lockPath);
        if (Date.now() >= deadline) throw new Error('fabric plan ledger lock timeout');
        Bun.sleepSync(5);
      }
    }
    return operation();
  } finally {
    if (acquired) unlinkSync(lockPath);
    unlinkSync(ownerPath);
  }
}

function appendLines(root: string, lines: readonly FabricPlanLine[]): void {
  const path = ledgerPath(root);
  mkdirSync(join(root, 'fabric'), { recursive: true });
  appendFileSync(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
}

function appendEvent(root: string, event: FabricPlanEvent): void {
  appendLines(root, [event]);
}

/** Called under the ledger lock. A torn last line (crash mid-append) is cut back to the last whole line so the ledger stays usable. */
function readEvents(root: string): FabricPlanEvent[] {
  const path = ledgerPath(root);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n');
  const events: FabricPlanEvent[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const complete = i < lines.length - 1;
    if (line) {
      let parsed: FabricPlanLine | undefined;
      try { parsed = JSON.parse(line) as FabricPlanLine; } catch { parsed = undefined; }
      if (!parsed || !complete) {
        // Only the tail may be torn; a bad line in the middle is real corruption and must not be silently skipped.
        if (lines.slice(i + 1).some(Boolean)) throw new Error(`fabric plan ledger corrupt at line ${i + 1}`);
        truncateSync(path, Buffer.byteLength(text.slice(0, offset)));
        debug.log('fabric.plan', 'torn-tail-repaired', { line: i + 1, bytes: Buffer.byteLength(line) });
        break;
      }
      if (parsed.type === 'approved') events.push({ type: 'plan', plan: parsed.plan }, { type: 'execution-candidate', candidate: parsed.candidate });
      else events.push(parsed);
    }
    offset += line.length + 1;
  }
  return events;
}

function inferredKind(text: string): JobKind {
  if (/영상|비디오|video|media|편집|촬영/i.test(text)) return 'media';
  if (/배포|출시|deploy|release|publish/i.test(text)) return 'deploy';
  if (/조사|검색|분석|research|search|investigat/i.test(text)) return 'search';
  return 'dev';
}

function flatten(nodes: readonly FabricPlanNode[]): FabricPlanNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

function validateNodes(nodes: readonly FabricPlanNode[]): void {
  const all = flatten(nodes);
  if (!all.length) throw new Error('fabric plan requires nodes');
  const byId = new Map(all.map((node) => [node.id, node]));
  if (byId.size !== all.length) throw new Error('duplicate fabric plan node id');
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('cyclic fabric plan dependency');
    if (visited.has(id)) return;
    const node = byId.get(id);
    if (!node) throw new Error(`unknown fabric plan dependency: ${id}`);
    visiting.add(id);
    for (const dependency of node.dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of all) {
    if (typeof node.title !== 'string' || !node.title.trim()
      || typeof node.expectedOutput !== 'string' || !node.expectedOutput.trim()) {
      throw new Error('fabric plan node requires title and expected output');
    }
    if (!['dev', 'search', 'deploy', 'media'].includes(node.kind)) throw new Error('invalid fabric plan node kind');
    if (!Array.isArray(node.dependsOn) || node.dependsOn.some((id) => typeof id !== 'string')) {
      throw new Error('invalid fabric plan dependencies');
    }
    visit(node.id);
  }
}

function loadPlanUnlocked(root: string, id: string): FabricPlan | null {
  const events = readEvents(root);
  return events.filter((event): event is Extract<FabricPlanEvent, { type: 'plan' }> => event.type === 'plan')
    .map((event) => event.plan).reverse().find((plan) => plan.id === id) ?? null;
}

export function loadFabricPlan(root: string, id: string): FabricPlan | null {
  return withLedgerLock(root, () => loadPlanUnlocked(root, id));
}

export function listFabricExecutionCandidates(root: string): FabricExecutionCandidate[] {
  return withLedgerLock(root, () => readEvents(root)
    .filter((event): event is Extract<FabricPlanEvent, { type: 'execution-candidate' }> => event.type === 'execution-candidate')
    .map((event) => event.candidate));
}

/** Drafting and human edits record plan versions, never executable candidates. */
export async function createFabricPlan(
  root: string,
  request: string,
  options: FabricDecomposeRequestOptions = {},
): Promise<FabricPlan> {
  if (!request.trim()) throw new Error('fabric plan request is empty');
  const result = await decomposeFabricRequest(request, options);
  if (result.status !== 'decomposed' || result.rfc.arcs.length === 0) {
    throw new Error(`fabric plan decomposition failed: ${result.status}`);
  }
  const nodes: FabricPlanNode[] = result.rfc.arcs.map((arc, arcIndex) => {
    const id = `arc-${arcIndex + 1}`;
    const previousArc = result.rfc.arcs[arcIndex - 1];
    const previous = previousArc ? [`arc-${arcIndex}:task-${previousArc.workItems.length}`] : [];
    const children: FabricPlanNode[] = arc.workItems.map((item, itemIndex) => ({
      id: `${id}:task-${itemIndex + 1}`,
      title: item.title,
      kind: inferredKind(`${arc.heading} ${item.title}`),
      dependsOn: itemIndex ? [`${id}:task-${itemIndex}`] : [id],
      expectedOutput: item.detail?.trim() || item.title,
      children: [],
    }));
    return {
      id,
      title: arc.heading,
      kind: inferredKind(arc.heading),
      dependsOn: previous,
      expectedOutput: arc.workItems.map((item) => item.detail?.trim() || item.title).join('; '),
      children,
    };
  });
  validateNodes(nodes);
  const now = new Date().toISOString();
  const plan: FabricPlan = { id: randomUUID(), request, status: 'draft', nodes, createdAt: now, updatedAt: now };
  withLedgerLock(root, () => appendEvent(root, { type: 'plan', plan }));
  return plan;
}

export function reviseFabricPlan(root: string, id: string, edits: readonly FabricPlanEdit[]): FabricPlan {
  return withLedgerLock(root, () => {
    const current = loadPlanUnlocked(root, id);
    if (!current) throw new Error(`fabric plan not found: ${id}`);
    if (current.status !== 'draft' || readEvents(root).some((event) => event.type === 'execution-candidate' && event.candidate.planId === id)) {
      throw new Error('approved fabric plan cannot be revised');
    }
    const ids = new Set(flatten(current.nodes).map((node) => node.id));
    if (new Set(edits.map((edit) => edit.id)).size !== edits.length || edits.some((edit) => !ids.has(edit.id))) {
      throw new Error('duplicate or unknown fabric plan edit id');
    }
    const byId = new Map(edits.map((edit) => [edit.id, edit]));
    const apply = (node: FabricPlanNode): FabricPlanNode => {
      const edit = byId.get(node.id);
      return { ...node, ...edit, dependsOn: [...(edit?.dependsOn ?? node.dependsOn)], children: node.children.map(apply) };
    };
    const nodes = current.nodes.map(apply);
    validateNodes(nodes);
    const plan: FabricPlan = { ...current, nodes, updatedAt: new Date().toISOString() };
    appendEvent(root, { type: 'plan', plan });
    return plan;
  });
}

/** Approval is the sole operation allowed to append an execution candidate. */
export function approveFabricPlan(root: string, id: string): FabricExecutionCandidate {
  return withLedgerLock(root, () => {
    const current = loadPlanUnlocked(root, id);
    if (!current) throw new Error(`fabric plan not found: ${id}`);
    if (current.status !== 'draft' || readEvents(root).some((event) => event.type === 'execution-candidate' && event.candidate.planId === id)) {
      throw new Error('fabric plan already approved');
    }
    validateNodes(current.nodes);
    const approvedAt = new Date().toISOString();
    const candidate: FabricExecutionCandidate = { planId: id, nodes: current.nodes, approvedAt };
    appendLines(root, [{ type: 'approved', plan: { ...current, status: 'approved', updatedAt: approvedAt }, candidate }]);
    return candidate;
  });
}
