// HARNESS-RUN-LIVE-GRAPH (0.2.21) — one harness run's «which node, which outcome, when» for the PWA
// live/replay graph page (`/live-run/?run=<runId>`).
//
// Canonical source = the run's own ledger `~/.elanous/run-ledger/<runId>.jsonl` (federated: pod ledgers synced
// home are found through the same directories as the running-runs query):
//   · `pipeline-node-entry` — one per node visit (node · round · graphId)
//   · `graph-visit-budget`  — the visit count the runtime itself counted
//   · per-node outcome events — implemented · gated · reviewed(+review-reflect) · rework-budget · pre-pr-sync ·
//     gate.postsync · pr-opened · merge-decision
//   · `run-status` — terminal status of the whole run
// Durations are derived (gap to the next node entry, or to the terminal status); nothing writes a node «end».
//
// Node ids are never hardcoded for routing: any node the graph declares and the runtime enters (including the journey
// nodes HARNESS-FULL-GRAPH adds — entrance, queue, author, dispatch, landing, failure side) shows up as a step. A
// generic `pipeline-node-exit {node, outcome, detail?}` wins over the per-node heuristics below when present.
//
// ⛔ No goal body: the title is the first line of `start.feature`, cut to 80 chars. No artifact paths, no tokens.

import { loadFederatedRunLedger, loadRunLedger, runLedgerDir, type RunLedgerEntry } from '../../self-implement/run-ledger.js';
import { debug, redactSecretText } from '../../debug/log.js';
import { projectRunLedgerSteps, type RunStep } from '../../self-implement/run-step-projection.js';

export interface TraversalStepWire {
  node: string;
  round: number | null;
  /** `pass` · `fail` · null (still running). */
  outcome: string | null;
  at: string;
  durationMs: number | null;
  visit: number;
  maxVisits: number | null;
  detail: string | null;
  /** Ledger sequence of this traversal entry; absent on legacy records. */
  sourceSeq?: number;
  /** Safe resource names explicitly observed in this node's ledger window. */
  resources?: { host?: string; pod?: string; models?: string[]; plugins?: string[] };
}

export interface RunTraversalWire {
  runId: string;
  graphId: string | null;
  title: string | null;
  /** `running` until the ledger carries a terminal `run-status`. */
  status: string;
  stage: string | null;
  startedAt: string | null;
  endedAt: string | null;
  prNumber: number | null;
  substrate: string | null;
  steps: TraversalStepWire[];
  /** Structural graph changes in the same per-run sequence domain as `steps[].sourceSeq`. */
  graphEvents?: Extract<RunStep, { type: 'node-added' | 'edge-rerouted' | 'priority-changed' | 'unit-expanded' | 'unit-collapsed' }>[];
  /** Outcome edges read from this run's graph.path ledger rows, including injected fixture provenance. */
  journeyEdges?: Array<{ seq?: number; from: string; label: string; taken: string; source: 'graph' | 'code-default'; injected?: boolean; mockOutcome?: string; scene?: string; demo1104Scene?: string }>;
  ledgerEvents: number;
}

const str = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const num = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const ms = (iso: string | undefined | null): number => iso ? Date.parse(iso) : Number.NaN;

const TERMINAL_FAIL = new Set(['failed', 'abandoned', 'cancelled', 'error', 'aborted', 'stopped']);

/** A display title from a goal's first line: path-like tokens shrink to their basename (`a/b/c.tsx` → `c.tsx`),
 *  then the line is redacted and cut to 80 chars. Shared with the PWA picker (`apps/pwa/src/lib/live-run-view.ts`). */
export function displayTitle(text: string | null | undefined, max = 80): string | null {
  const line = text?.split('\n').map((part) => part.trim()).find(Boolean) ?? '';
  const shrunk = line.replace(/\s*\[truncated[^\]]*\]\s*$/, '').replace(/(?:~|\.{0,2})?\/?(?:[\w.@-]+\/)+([\w.@-]+)/g, '$1');
  const cut = shrunk.length > max ? `${shrunk.slice(0, max - 1)}…` : shrunk;
  return cut ? redactSecretText(cut) : null;
}

function titleOf(entries: readonly RunLedgerEntry[]): string | null {
  return displayTitle(str(entries.find((entry) => entry.event === 'start')?.data.feature));
}

function safeResource(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const clean = redactSecretText(value.trim().replace(/[\r\n\t]+/g, ' ')).slice(0, 100);
  return clean || undefined;
}

/** Project only named resource identifiers from the run-origin and this node's ledger interval. */
function resourcesFor(window: readonly RunLedgerEntry[], origin: RunLedgerEntry | undefined) {
  const resources: NonNullable<TraversalStepWire['resources']> = {};
  const models = new Set<string>();
  const plugins = new Set<string>();
  const originData = origin?.data ?? {};
  resources.host = safeResource(originData.hostname) ?? safeResource(originData.hostId);
  resources.pod = safeResource(originData.podName);
  const requestedModel = safeResource(originData.childModel);
  const events = window;
  for (const entry of events) {
    const data = entry.data;
    const nestedOrigin = data.origin && typeof data.origin === 'object' ? data.origin as Record<string, unknown> : {};
    const nestedResources = data.resources && typeof data.resources === 'object' ? data.resources as Record<string, unknown> : {};
    const provenance = data.provenance && typeof data.provenance === 'object' ? data.provenance as Record<string, unknown> : {};
    resources.host ??= safeResource(data.hostname) ?? safeResource(data.host) ?? safeResource(nestedOrigin.hostname);
    resources.pod ??= safeResource(data.podName) ?? safeResource(data.pod) ?? safeResource(nestedOrigin.podName);
    if (entry.event === 'pod-launch-started') {
      // The parent ledger's actual si-task launch row carries the launch host
      // in the provenance annotation set. `job` is a Kubernetes Job name, not
      // a Pod name, so it must not be presented as one.
      resources.host = safeResource(provenance['launch-host']) ?? resources.host;
    }
    for (const value of [data.model, data.childModel, nestedResources.model]) {
      const model = safeResource(value);
      if (model) models.add(model);
    }
    if (entry.event === 'plugin-tool-call') {
      const plugin = safeResource(data.plugin);
      const tool = safeResource(data.tool);
      const name = plugin && tool ? `${plugin}/${tool}` : plugin ?? tool;
      if (name) plugins.add(name);
    }
  }
  // Prefer the model consumed during this node over the launch request. The latter
  // remains a compatibility fallback for older ledgers without consume events.
  if (!models.size && requestedModel) models.add(requestedModel);
  if (models.size) resources.models = [...models];
  if (plugins.size) resources.plugins = [...plugins];
  return Object.values(resources).some(Boolean) ? resources : undefined;
}

/** Outcome + one-line detail of a node visit, read from the events between its entry and the next entry. */
function judgeVisit(node: string, window: readonly RunLedgerEntry[], lookback: readonly RunLedgerEntry[] = []): { outcome: 'pass' | 'fail' | null; detail: string | null } {
  const last = (event: string) => [...window].reverse().find((entry) => entry.event === event)?.data;
  // Some decisions are written just before the node they belong to is entered (merge-decision lands in the regate
  // window, right before open-pr) — look back to the previous node entry for those.
  const near = (event: string) => last(event) ?? [...lookback].reverse().find((entry) => entry.event === event)?.data;
  const exit = [...window].reverse().find((entry) => entry.event === 'pipeline-node-exit' && entry.data.node === node)?.data;
  const exitOutcome = str(exit?.outcome);
  if (exitOutcome) {
    const failed = TERMINAL_FAIL.has(exitOutcome) || exitOutcome === 'fail';
    const exitDetail = str(exit?.detail)?.replace(/\s+/g, ' ').trim();
    return { outcome: failed ? 'fail' : 'pass', detail: exitDetail ? redactSecretText(exitDetail.slice(0, 120)) : exitOutcome };
  }
  switch (node) {
    case 'implement': {
      const done = last('implemented');
      if (!done) return { outcome: null, detail: null };
      const evidence = last('off-diff-evidence');
      const covered = num(evidence?.coveredEvidence); const required = num(evidence?.requiredEvidence);
      const proof = covered !== null && required !== null ? ` · 증거 ${covered}/${required}` : '';
      return done.ok === false ? { outcome: 'fail', detail: '구현 실패' } : { outcome: 'pass', detail: `구현 완료${proof}` };
    }
    case 'gate': {
      const gated = last('gated');
      if (!gated) return { outcome: null, detail: null };
      return gated.passed === true ? { outcome: 'pass', detail: '게이트 통과' } : { outcome: 'fail', detail: '게이트 실패' };
    }
    case 'regate': {
      const gated = last('gate.postsync');
      if (!gated) return { outcome: null, detail: null };
      return gated.passed === true ? { outcome: 'pass', detail: 'main 동기화 뒤 재게이트 통과' } : { outcome: 'fail', detail: '재게이트 실패' };
    }
    case 'review': {
      const review = last('reviewed');
      if (!review) return { outcome: null, detail: null };
      const verdict = str(review.verdict) ?? '?';
      const mustFix = num(review.mustFix);
      const converged = window.some((entry) => entry.event === 'review-reflect' && entry.data.converged === true);
      const base = `리뷰 ${verdict}${mustFix !== null ? ` · 꼭 고칠 것 ${mustFix}` : ''}`;
      if (converged) return { outcome: 'pass', detail: `${base} · 반박 수렴` };
      return { outcome: verdict === 'fail' ? 'fail' : 'pass', detail: base };
    }
    case 'rework': {
      const budget = last('rework-budget');
      const verdict = str(budget?.verdict);
      return { outcome: 'pass', detail: verdict ? `재작업 예산 ${verdict}` : '재작업' };
    }
    case 'main-sync': {
      const sync = last('pre-pr-sync');
      if (!sync) return { outcome: null, detail: null };
      const status = str(sync.status) ?? '?';
      return { outcome: status === 'merged' || status === 'up-to-date' ? 'pass' : 'fail', detail: `main 동기화 ${status}` };
    }
    case 'open-pr': {
      const opened = last('pr-opened');
      const decision = str(near('merge-decision')?.decision);
      if (!opened) return { outcome: null, detail: decision ? `병합 결정 ${decision}` : null };
      const number = num(opened.number);
      return { outcome: 'pass', detail: `PR${number !== null ? ` #${number}` : ''} 열림${decision ? ` · 병합 결정 ${decision}` : ''}` };
    }
    default:
      return { outcome: null, detail: null };
  }
}

export function buildRunTraversal(runId: string, entries: readonly RunLedgerEntry[]): RunTraversalWire {
  const sorted = [...entries].map((entry, index) => ({ entry, index }))
    .sort((a, b) => (ms(a.entry.timestamp) - ms(b.entry.timestamp)) || a.index - b.index).map(({ entry }) => entry);
  const terminal = [...sorted].reverse().find((entry) => entry.event === 'run-status' && str(entry.data.runStatus));
  const origin = [...sorted].reverse().find((entry) => entry.event === 'run-origin');
  const status = terminal ? str(terminal.data.runStatus)! : 'running';
  const entryIndexes = sorted.map((entry, index) => entry.event === 'pipeline-node-entry' && str(entry.data.node) ? index : -1).filter((index) => index >= 0);
  const visits = new Map<string, number>();
  const steps: TraversalStepWire[] = entryIndexes.map((at, position) => {
    const entry = sorted[at]!;
    const node = str(entry.data.node)!;
    const nextAt = entryIndexes[position + 1];
    const window = sorted.slice(at + 1, nextAt ?? sorted.length);
    const budget = [...sorted.slice(Math.max(0, at - 3), at)].reverse()
      .find((candidate) => candidate.event === 'graph-visit-budget' && candidate.data.node === node);
    const visit = num(budget?.data.visits) ?? (visits.get(node) ?? 0) + 1;
    visits.set(node, visit);
    const prevAt = position > 0 ? entryIndexes[position - 1]! : -1;
    let { outcome, detail } = judgeVisit(node, window, sorted.slice(prevAt + 1, at));
    const isLast = nextAt === undefined;
    if (!isLast && outcome === null) outcome = 'pass';
    if (isLast && terminal) outcome = TERMINAL_FAIL.has(status) ? 'fail' : (outcome ?? 'pass');
    const endIso = nextAt !== undefined ? sorted[nextAt]!.timestamp : terminal?.timestamp;
    const duration = ms(endIso) - ms(entry.timestamp);
    const sourceSeq = (entry as RunLedgerEntry & { seq?: unknown }).seq ?? entry.data.seq;
    const resources = resourcesFor([entry, ...window], origin);
    return {
      node,
      round: num(entry.data.round),
      outcome,
      at: entry.timestamp ?? '',
      durationMs: Number.isFinite(duration) && duration >= 0 ? duration : null,
      visit,
      maxVisits: num(budget?.data.maxVisits),
      detail,
      ...(resources ? { resources } : {}),
      ...(typeof sourceSeq === 'number' && Number.isSafeInteger(sourceSeq) && sourceSeq > 0 ? { sourceSeq } : {}),
    };
  });

  const contract = sorted.find((entry) => entry.event === 'graph-run-contract-resolved')?.data;
  const pr = [...sorted].reverse().find((entry) => entry.event === 'pr-opened')?.data;
  const projected = projectRunLedgerSteps(runId, sorted);
  const graphEvents = projected.steps.filter((step): step is Extract<RunStep, { type: 'node-added' | 'edge-rerouted' | 'priority-changed' | 'unit-expanded' | 'unit-collapsed' }> =>
    step.type === 'node-added' || step.type === 'edge-rerouted' || step.type === 'priority-changed' || step.type === 'unit-expanded' || step.type === 'unit-collapsed');
  const journeyEdges = sorted.flatMap((entry) => {
    const source = entry.data.source;
    if (entry.event !== 'graph.path' || entry.data.event !== 'edge-taken'
      || typeof entry.data.from !== 'string' || typeof entry.data.label !== 'string' || typeof entry.data.taken !== 'string'
      || (source !== 'graph' && source !== 'code-default')) return [];
    const journeySource: 'graph' | 'code-default' = source;
    const seq = entry.seq ?? entry.data.seq;
    return [{
      ...(typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0 ? { seq } : {}),
      from: entry.data.from, label: entry.data.label, taken: entry.data.taken, source: journeySource,
      ...(entry.data.injected === true ? { injected: true } : {}),
      ...(typeof entry.data.mockOutcome === 'string' ? { mockOutcome: entry.data.mockOutcome } : {}),
      ...(str(entry.data.scene) ? { scene: str(entry.data.scene)! } : {}),
      ...(str(entry.data.demo1104Scene) ? { demo1104Scene: str(entry.data.demo1104Scene)! } : {}),
    }];
  });
  return {
    runId,
    graphId: str(contract?.graphId) ?? str(sorted.find((entry) => entry.event === 'pipeline-node-entry')?.data.graphId),
    title: titleOf(sorted),
    status,
    stage: terminal ? str(terminal.data.stage) : null,
    startedAt: sorted[0]?.timestamp ?? null,
    endedAt: terminal?.timestamp ?? null,
    prNumber: num(pr?.number),
    substrate: str(contract?.actualSubstrate),
    steps,
    ...(graphEvents.length ? { graphEvents } : {}),
    ...(journeyEdges.length ? { journeyEdges } : {}),
    ledgerEvents: sorted.length,
  };
}

export interface TraversalDeps {
  loadLedger?: (runId: string) => RunLedgerEntry[] | null;
}

const USAGE = 'usage: GET /v1/harness/run-traversal?runId=<runId>';

/** GET /v1/harness/run-traversal?runId= — ordered node steps of one harness run. */
export function handleHarnessRunTraversalGet(req: Request, deps: TraversalDeps = {}): Response {
  const totalStarted = performance.now();
  const runId = new URL(req.url).searchParams.get('runId')?.trim() ?? '';
  if (!runId || /[\\/]|\.\./.test(runId)) return Response.json({ error: USAGE }, { status: 400 });
  let entries: RunLedgerEntry[] | null;
  try {
    const loadStarted = performance.now();
    entries = deps.loadLedger
      ? deps.loadLedger(runId)
      : loadRunLedger(runId, runLedgerDir()) ?? loadFederatedRunLedger(runId);
    const loadMs = Math.max(0, Math.round(performance.now() - loadStarted));
    if (!entries) {
      debug.log('harness-http', 'run-traversal', { runId, found: false, loadMs, buildMs: 0, totalMs: Math.max(0, Math.round(performance.now() - totalStarted)) });
      return Response.json({ error: 'run-not-found', runId }, { status: 404 });
    }
    const buildStarted = performance.now();
    const traversal = buildRunTraversal(runId, entries);
    const buildMs = Math.max(0, Math.round(performance.now() - buildStarted));
    debug.log('harness-http', 'run-traversal', { runId, found: true, ledgerEvents: entries.length, steps: traversal.steps.length, loadMs, buildMs, totalMs: Math.max(0, Math.round(performance.now() - totalStarted)) });
    return Response.json(traversal);
  } catch (error) {
    debug.log('harness-http', 'run-traversal', { runId, found: false, error: true, totalMs: Math.max(0, Math.round(performance.now() - totalStarted)) });
    return Response.json({ error: 'ledger-unreadable', reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }, { status: 422 });
  }
}
