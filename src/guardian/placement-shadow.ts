/** Pure placement contract for the phase-one shadow graph. It never starts/stops VMs or assigns work. */
import type { InProcessHandler, InProcessHandlerRegistry } from '../graph-runner/in-process-registry.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { runGraph, type GraphRunOptions, type GraphRunState } from '../graph-runner/runner.js';

const execFileAsync = promisify(execFile);

export type PlacementWorkKind = 'review' | 'test' | 'tsc' | 'tab' | 'train';
export type PlacementCloudAction = 'none' | 'start' | 'stop';

export interface PlacementHostFacts {
  readonly host: string;
  readonly load1Pct: number;
  readonly load15Pct: number;
  readonly memoryAvailablePct: number;
  readonly diskUsedPct: number;
  readonly tools: readonly string[];
  readonly ssh: boolean;
  readonly maintenance: boolean;
  readonly gateProtected?: boolean;
  readonly runningKinds: readonly PlacementWorkKind[];
  /** Active count and configured ceiling let the yellow rule prove it adds at most one workload. */
  readonly runningByKind?: Readonly<Partial<Record<PlacementWorkKind, { readonly running: number; readonly max: number }>>>;
  readonly tabCount: number;
  readonly trainRows: number;
  readonly warmPoolPods: number;
  readonly cloudRunning?: boolean;
  readonly cloudIdleMinutes?: number;
}

export interface PlacementSnapshot {
  readonly workKind: PlacementWorkKind;
  readonly hosts: readonly PlacementHostFacts[];
}

export interface PlacementDecision {
  readonly host: string | 'wait';
  readonly workKind: PlacementWorkKind;
  readonly reason: string;
  readonly confidence: number;
  readonly cloudAction: PlacementCloudAction;
}

export interface PlacementCandidate extends PlacementHostFacts {
  readonly tier: 'local' | 'cloud';
  readonly grade: 'green' | 'yellow';
}

const localOrder: Record<PlacementWorkKind, readonly string[]> = {
  review: ['node-b', 'mshq', 'minim5'],
  test: ['node-b', 'minim5', 'mshq'],
  tsc: ['node-b', 'minim5', 'mshq'],
  tab: ['mshq', 'node-b', 'minim5', 'node-c'],
  train: ['node-b', 'mshq', 'minim5'],
};
const cloudOrder = ['aws2', 'gcp2'] as const;
const localHosts = ['node-b', 'mshq', 'minim5', 'node-c'] as const;
const requiredTools: Record<PlacementWorkKind, readonly string[]> = {
  review: ['repo', 'bun', 'codex'], test: ['bun', 'node_modules'], tsc: ['bun', 'node_modules'],
  tab: ['repo', 'codex'], train: ['repo', 'bun'],
};

function isPlacementWorkKind(value: unknown): value is PlacementWorkKind {
  return value === 'review' || value === 'test' || value === 'tsc' || value === 'tab' || value === 'train';
}

function isPlacementHostFacts(value: unknown): value is PlacementHostFacts {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const host = value as Record<string, unknown>;
  const percentage = (field: unknown) => typeof field === 'number' && Number.isFinite(field) && field >= 0 && field <= 100; // Source: R-TST36; L/L15/M/D facts are percentages in the placement brief.
  const nonNegativeCount = (field: unknown) => typeof field === 'number' && Number.isSafeInteger(field) && field >= 0;
  if (typeof host.host !== 'string' || !host.host || !percentage(host.load1Pct) || !percentage(host.load15Pct) ||
      !percentage(host.memoryAvailablePct) || !percentage(host.diskUsedPct) || !Array.isArray(host.tools) ||
      !host.tools.every(tool => typeof tool === 'string' && tool.length > 0) || typeof host.ssh !== 'boolean' ||
      typeof host.maintenance !== 'boolean' || host.gateProtected !== undefined && typeof host.gateProtected !== 'boolean' ||
      !Array.isArray(host.runningKinds) || !host.runningKinds.every(isPlacementWorkKind) ||
      !nonNegativeCount(host.tabCount) || !nonNegativeCount(host.trainRows) || !nonNegativeCount(host.warmPoolPods) ||
      host.cloudRunning !== undefined && typeof host.cloudRunning !== 'boolean' ||
      host.cloudIdleMinutes !== undefined && (typeof host.cloudIdleMinutes !== 'number' || !Number.isFinite(host.cloudIdleMinutes) || host.cloudIdleMinutes < 0)) return false;
  if (host.runningByKind !== undefined) {
    if (!host.runningByKind || typeof host.runningByKind !== 'object' || Array.isArray(host.runningByKind)) return false;
    for (const [kind, raw] of Object.entries(host.runningByKind)) {
      if (!isPlacementWorkKind(kind) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
      const counts = raw as Record<string, unknown>;
      if (!nonNegativeCount(counts.running) || typeof counts.max !== 'number' || !Number.isSafeInteger(counts.max) || counts.max < 1 || (counts.running as number) > counts.max) return false;
    }
  }
  return true;
}

function grade(host: PlacementHostFacts): 'green' | 'yellow' | 'red' {
  // Source: seat-state/OP/BRIEF-LOCAL-FIRST-PLACEMENT-1111.md, rubric v1 green/yellow thresholds.
  if (host.load1Pct < 40 && host.load15Pct < 50 && host.memoryAvailablePct > 30 && host.diskUsedPct < 85) return 'green';
  if (host.load1Pct < 70 && host.load15Pct < 80 && host.memoryAvailablePct > 15 && host.diskUsedPct < 90) return 'yellow';
  return 'red';
}

function uniquePlacementHostFacts(snapshot: PlacementSnapshot): PlacementHostFacts[] {
  const counts = new Map<string, number>();
  const valid = snapshot.hosts.filter(isPlacementHostFacts);
  for (const host of valid) counts.set(host.host, (counts.get(host.host) ?? 0) + 1);
  return valid.filter(host => counts.get(host.host) === 1);
}

/** Excludes hard-invalid hosts before the language model sees candidates. */
export function filterPlacementCandidates(snapshot: PlacementSnapshot): PlacementCandidate[] {
  const facts = uniquePlacementHostFacts(snapshot).filter(host => (localHosts.includes(host.host as typeof localHosts[number]) || cloudOrder.includes(host.host as typeof cloudOrder[number])) &&
    (snapshot.workKind === 'tab' || host.host !== 'node-c') &&
    ((localHosts.includes(host.host as typeof localHosts[number])) || typeof host.cloudRunning === 'boolean') &&
    host.ssh && !host.maintenance && !host.gateProtected &&
    requiredTools[snapshot.workKind].every(tool => host.tools.includes(tool)));
  return facts.flatMap(host => {
    const hostGrade = grade(host);
    if (hostGrade === 'red') return [];
    const tier = host.host === 'aws2' || host.host === 'gcp2' ? 'cloud' as const : 'local' as const;
    const candidate = { ...host, tier, grade: hostGrade };
    if (hostGrade === 'yellow') {
      const load = host.runningByKind?.[snapshot.workKind];
      if (tier !== 'local' || !host.runningKinds.includes(snapshot.workKind) || !load || load.running <= 0 || load.running >= load.max) return [];
    }
    return [candidate];
  }).sort((a, b) => {
    const aIndex = a.tier === 'local' ? localOrder[snapshot.workKind].indexOf(a.host) : localOrder[snapshot.workKind].length + cloudOrder.indexOf(a.host as typeof cloudOrder[number]);
    const bIndex = b.tier === 'local' ? localOrder[snapshot.workKind].indexOf(b.host) : localOrder[snapshot.workKind].length + cloudOrder.indexOf(b.host as typeof cloudOrder[number]);
    return aIndex - bIndex;
  });
}

function candidateFor(hostName: string, candidates: readonly PlacementCandidate[]): PlacementCandidate | undefined {
  return candidates.find(candidate => candidate.host === hostName);
}

function preferredCandidate(snapshot: PlacementSnapshot, candidates: readonly PlacementCandidate[]): PlacementCandidate | undefined {
  const localGreen = localOrder[snapshot.workKind]
    .map(hostName => candidateFor(hostName, candidates))
    .find(item => item?.grade === 'green');
  if (localGreen) return localGreen;
  const localYellow = localOrder[snapshot.workKind]
    .map(hostName => candidateFor(hostName, candidates))
    .find(item => {
      const load = item?.runningByKind?.[snapshot.workKind];
      return item?.grade === 'yellow' && item.runningKinds.includes(snapshot.workKind) && load !== undefined &&
        Number.isSafeInteger(load.running) && Number.isSafeInteger(load.max) && load.running > 0 && load.running < load.max; // Source: brief local-first rule permits one additional same-kind workload only below the host cap.
    });
  if (localYellow) return localYellow;
  return cloudOrder.map(hostName => candidateFor(hostName, candidates)).find(item => item?.grade === 'green');
}

export function isValidPlacementDecision(proposed: unknown, snapshot: PlacementSnapshot): proposed is PlacementDecision {
  const candidates = filterPlacementCandidates(snapshot);
  const value = proposed && typeof proposed === 'object' && !Array.isArray(proposed)
    ? proposed as Record<string, unknown> : {};
  const host = typeof value.host === 'string' ? value.host : '';
  const validShape = typeof value.workKind === 'string' && value.workKind === snapshot.workKind &&
    typeof value.reason === 'string' && value.reason.trim().length > 0 &&
    typeof value.confidence === 'number' && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1 && // Source: placement JSON contract confidence is a probability.
    (value.cloudAction === 'none' || value.cloudAction === 'start' || value.cloudAction === 'stop') &&
    Object.keys(value).every(key => ['host', 'workKind', 'reason', 'confidence', 'cloudAction'].includes(key));
  const candidate = candidateFor(host, candidates);
  const requestedCloudAction = value.cloudAction as PlacementCloudAction;
  const preferred = preferredCandidate(snapshot, candidates);
  const localGreenExists = candidates.some(item => item.tier === 'local' && item.grade === 'green');
  const uniqueGreenLocals = new Set(candidates.filter(item => item.tier === 'local' && item.grade === 'green').map(item => item.host));
  const canStopIdleCloud = uniqueGreenLocals.size >= 2 &&
    uniquePlacementHostFacts(snapshot).some(item => cloudOrder.includes(item.host as typeof cloudOrder[number]) && item.ssh && !item.maintenance && !item.gateProtected &&
      item.cloudRunning === true && (item.cloudIdleMinutes ?? 0) >= 5 && item.load15Pct < 10 && item.tabCount === 0 && item.trainRows === 0 && item.warmPoolPods === 0); // Source: seat-state/OP/BRIEF-LOCAL-FIRST-PLACEMENT-1111.md, two-green-local + five-minute cloud idle stop rule.
  const actionMatchesHostState = host === 'wait'
    ? requestedCloudAction === 'none'
    : candidate?.tier === 'cloud'
      ? (candidate.cloudRunning === false ? requestedCloudAction === 'start' : requestedCloudAction === 'none')
      : requestedCloudAction !== 'start';
  return validShape && actionMatchesHostState && (host === 'wait' || candidate !== undefined) &&
    (host === 'wait' ? preferred === undefined : candidate?.host === preferred?.host) &&
    (requestedCloudAction !== 'start' || (candidate?.tier === 'cloud' && !localGreenExists && candidate.cloudRunning === false)) &&
    (requestedCloudAction !== 'stop' || (candidate?.tier === 'local' && canStopIdleCloud));
}

/** Validate the model's proposal against the deterministic hard filter; invalid proposals use pick-host order. */
export function validatePlacementDecision(
  proposed: unknown,
  snapshot: PlacementSnapshot,
  options: { readonly fallbackHost?: string } = {},
): PlacementDecision {
  const candidates = filterPlacementCandidates(snapshot);
  const value = proposed && typeof proposed === 'object' && !Array.isArray(proposed)
    ? proposed as Record<string, unknown> : {};
  const host = typeof value.host === 'string' ? value.host : '';
  const preferred = preferredCandidate(snapshot, candidates);
  if (isValidPlacementDecision(proposed, snapshot)) return {
    host, workKind: snapshot.workKind, reason: value.reason as string,
    confidence: value.confidence as number, cloudAction: value.cloudAction as PlacementCloudAction,
  };

  const fallback = options.fallbackHost ? candidateFor(options.fallbackHost, candidates) : undefined;
  // Ignore an invalid external fallback result; never let it bypass the candidate or local-first policy.
  const selected = fallback?.host === preferred?.host ? fallback : preferred;
  const decision: PlacementDecision = {
    host: selected?.host ?? 'wait', workKind: snapshot.workKind,
    reason: 'invalid-model-decision; deterministic pick-host fallback', confidence: 1,
    cloudAction: selected?.tier === 'cloud' && selected.cloudRunning === false ? 'start' : 'none',
  };
  if (!isValidPlacementDecision(decision, snapshot)) throw new Error('deterministic placement fallback failed the placement validator');
  return decision;
}

/** Shadow comparison output is safe to persist; it has no executable assignment or VM side effect. */
export function comparePlacementShadow(
  decision: PlacementDecision,
  cioHost: string | 'wait',
): { readonly mode: 'shadow'; readonly proposedHost: string | 'wait'; readonly cioHost: string | 'wait'; readonly agrees: boolean; readonly cloudAction: PlacementCloudAction } {
  return { mode: 'shadow', proposedHost: decision.host, cioHost, agrees: decision.host === cioHost, cloudAction: decision.cloudAction };
}

export interface PlacementGraphInput {
  readonly snapshot: PlacementSnapshot;
  readonly cioHost: string | 'wait';
  readonly precedents?: readonly PlacementDecision[];
}

export interface PlacementShadowLedgerRow {
  readonly at: string;
  readonly kind: PlacementWorkKind;
  readonly host: string | 'wait';
  readonly reason: string;
  readonly confidence: number;
  readonly mode: 'shadow';
  readonly cioHost: string | 'wait';
  readonly agrees: boolean;
  readonly cloudAction: PlacementCloudAction;
}

export function createPlacementJsonlRecorder(path = join(homedir(), 'elanous-hq/seat-state/OP/cio/placement.jsonl')):
  (row: PlacementShadowLedgerRow) => Promise<void> {
  return async row => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(row)}\n`, { encoding: 'utf8', flag: 'a' });
  };
}

/** Adapt the HQ host-picker's stdout contract without running a shell or accepting extra output as a host. */
export async function pickHostScriptAdapter(kind: PlacementWorkKind,
  scriptPath = join(homedir(), 'elanous-hq/seat-state/OP/tools/pick-host.sh')): Promise<string | undefined> {
  try {
    const result = await execFileAsync('zsh', [scriptPath, kind], { timeout: 5_000, maxBuffer: 8_192 }); // Source: bound the host-picker adapter to a short read-only lookup and small two-line response.
    const lines = result.stdout.trim().split(/\r?\n/);
    return lines.length === 1 && /^[a-z][a-z0-9-]*$/.test(lines[0]!) ? lines[0] : undefined;
  } catch { return undefined; }
}

/** Manually executable production entry: supplied snapshots use the real graph and handler registry. */
export async function runPlacementShadowGraph(input: PlacementGraphInput, options: {
  readonly graphPath?: string;
  readonly runId?: string;
  readonly root?: string;
  readonly pickHost?: (kind: PlacementWorkKind) => Promise<string | undefined>;
  readonly recordShadow?: (row: PlacementShadowLedgerRow) => Promise<void>;
  readonly callLLM?: NonNullable<GraphRunOptions['deps']>['callLLM'];
} = {}): Promise<GraphRunState> {
  const graphPath = options.graphPath ?? join(process.cwd(), 'graphs/ops/placement.yaml');
  const graphOptions: GraphRunOptions = {
    ...(options.runId ? { runId: options.runId } : {}),
    input,
    deps: {
      ...(options.root ? { root: options.root } : {}),
      ...(options.callLLM ? { callLLM: options.callLLM } : {}),
      inProcessHandlers: createPlacementShadowGraphHandlers({
        pickHostFallback: options.pickHost ?? pickHostScriptAdapter,
        ...(options.recordShadow ? { recordShadow: options.recordShadow } : {}),
      }),
    },
  };
  return runGraph(graphPath, graphOptions);
}

function placementInput(value: unknown): PlacementGraphInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('placement graph input must be an object');
  const input = value as Partial<PlacementGraphInput>;
  if (!input.snapshot || !Array.isArray(input.snapshot.hosts) || !['review', 'test', 'tsc', 'tab', 'train'].includes(input.snapshot.workKind))
    throw new Error('placement graph input requires a valid snapshot');
  if (typeof input.cioHost !== 'string' || !input.cioHost.trim()) throw new Error('placement graph input requires cioHost');
  return input as PlacementGraphInput;
}

/** Handler set used by the graph and fake world; every decision stage is on the graph execution path. */
export function createPlacementShadowGraphHandlers(options: {
  readonly pickHostFallback: (kind: PlacementWorkKind) => Promise<string | undefined>;
  readonly recordShadow?: (row: PlacementShadowLedgerRow) => Promise<void>;
}): InProcessHandlerRegistry {
  const recordShadow = options.recordShadow ?? createPlacementJsonlRecorder();
  const collect: InProcessHandler = context => {
    const request = placementInput(context.input);
    return { ok: true, outcome: 'ok', result: { snapshot: request.snapshot, cioHost: request.cioHost,
      precedents: request.precedents ?? [] } };
  };
  const filter: InProcessHandler = context => {
    const request = placementInput(context.input);
    return { ok: true, outcome: 'ok', result: { workKind: request.snapshot.workKind,
      candidates: filterPlacementCandidates(request.snapshot), precedents: request.precedents ?? [] } };
  };
  const validate: InProcessHandler = async context => {
    const request = placementInput(context.input);
    const raw = context.outputs['placement-judge'];
    let proposal: unknown;
    try { proposal = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { proposal = null; }
    const candidates = filterPlacementCandidates(request.snapshot);
    let usableFallback: string | undefined;
    if (!isValidPlacementDecision(proposal, request.snapshot)) {
      try { usableFallback = await options.pickHostFallback(request.snapshot.workKind); } catch { usableFallback = undefined; }
    }
    const decision = validatePlacementDecision(proposal, request.snapshot, { fallbackHost: usableFallback });
    return { ok: true, outcome: 'ok', result: decision,
      evidence: { modelJsonValid: proposal !== null, filteredCandidateCount: candidates.length,
        fallbackUsed: decision.reason === 'invalid-model-decision; deterministic pick-host fallback' } };
  };
  const compare: InProcessHandler = async context => {
    const request = placementInput(context.input);
    const prior = context.outputs['placement-validate'];
    const envelope = prior && typeof prior === 'object' && !Array.isArray(prior) ? prior as Record<string, unknown> : {};
    const decision = envelope.result as PlacementDecision | undefined;
    if (!decision || decision.workKind !== request.snapshot.workKind) return { ok: false, outcome: 'fail', error: 'validated placement result missing' };
    const comparison = comparePlacementShadow(decision, request.cioHost);
    await recordShadow({ at: new Date().toISOString(), kind: decision.workKind, host: decision.host,
      reason: decision.reason, confidence: decision.confidence, ...comparison });
    return { ok: true, outcome: 'ok', result: comparison,
      evidence: { phase: 'shadow-only', assignmentExecuted: false, cloudActionExecuted: false } };
  };
  return { 'placement-collect': collect, 'placement-filter': filter, 'placement-validate': validate, 'placement-compare': compare };
}
