import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { lastJsonObject, runGraph, type GraphRunState } from '../graph-runner/runner.js';
import { installedGraphs, planExecRequest, type ExecPlanItem, type InstalledGraph } from './planner.js';
import { ExecRequestStore, type ExecRequest, type ExecResult, type ExecSeat } from './store.js';

export interface ExecRunnerDeps {
  store?: ExecRequestStore;
  graphs?: () => Promise<InstalledGraph[]>;
  plan?: (text: string) => Promise<ExecPlanItem[]>;
  run?: typeof runGraph;
  root?: string;
}

const active = new Set<string>();
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const kinds: Record<string, ExecResult['kind']> = {
  '.pdf': 'pdf', '.mp4': 'video', '.mov': 'video', '.webm': 'video', '.png': 'image', '.jpg': 'image',
  '.jpeg': 'image', '.webp': 'image', '.md': 'report', '.txt': 'text',
};

function safeFile(path: string, root: string, graphId: string, runId: string): string | null {
  if (!SEGMENT.test(graphId) || !SEGMENT.test(runId)) return null;
  // Only run-prefixed files or the run artifact directory, never a sibling run's output.
  const allowed = join(root, 'graph-runs', graphId);
  const candidate = isAbsolute(path) ? path : resolve(allowed, path);
  try {
    const real = realpathSync(candidate);
    const base = realpathSync(allowed);
    const runPrefix = `${runId}.json.`;
    const local = dirname(real) === base && basename(real).startsWith(runPrefix)
      && !/\.(?:decision\.json|tmp)$/.test(real);
    const artifactsDir = join(allowed, `${runId}.json.artifacts`);
    const realArtifactsDir = existsSync(artifactsDir) && statSync(artifactsDir).isDirectory()
      ? realpathSync(artifactsDir) : null;
    const inRunDirectory = realArtifactsDir === join(base, `${runId}.json.artifacts`)
      && real.startsWith(`${realArtifactsDir}${sep}`);
    if ((!local && !inRunDirectory) || !statSync(real).isFile()) return null;
    return real;
  } catch { return null; }
}

function publicLink(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.hostname && !url.username && !url.password ? value : null;
  } catch { return null; }
}

function fileName(path: string, runId: string): string {
  const digest = createHash('sha256').update(path).digest('hex');
  return `${runId}--${digest}--${basename(path)}`;
}

function resultOf(output: Record<string, unknown>, seat: ExecSeat, id: string, root: string): ExecResult | null {
  const candidate = typeof output.file === 'string' ? output.file : typeof output.path === 'string' ? output.path : null;
  let url: string;
  let kind: ExecResult['kind'];
  let name: string;
  if (candidate !== null) {
    const path = safeFile(candidate, root, seat.graphId, seat.runId);
    if (!path) return null;
    const fileKind = kinds[basename(path).slice(basename(path).lastIndexOf('.')).toLowerCase()];
    if (!fileKind) return null;
    kind = fileKind;
    name = basename(path);
    url = `/v1/exec-requests/${id}/files/${encodeURIComponent(fileName(path, seat.runId))}`;
  } else {
    const link = publicLink(output.url);
    if (!link) return null;
    kind = 'link';
    name = link;
    url = link;
  }
  const sources = Array.isArray(output.sources) ? output.sources.flatMap((source: unknown) => {
    if (!source || typeof source !== 'object') return [];
    const entry = source as { title?: unknown; url?: unknown };
    const sourceUrl = publicLink(entry.url);
    return typeof entry.title === 'string' && sourceUrl ? [{ title: entry.title, url: sourceUrl }] : [];
  }) : [];
  return { seat: seat.seat, kind, title: typeof output.title === 'string' ? output.title : name,
    url, ...(sources.length ? { sources } : {}) };
}

function syncRun(item: ExecRequest, seat: ExecSeat, state: GraphRunState, root: string): void {
  const previous = seat.status;
  seat.status = state.status === 'done' ? 'done' : state.status === 'failed' || state.status === 'budget-exceeded' ? 'failed' : 'running';
  if (previous !== seat.status) debug.log('exec-requests', 'seat-status', { id: item.id, seat: seat.seat, from: previous, to: seat.status, graphId: seat.graphId, runId: seat.runId });
  const claim = state.status === 'awaiting-approval' && state.pending
    ? `${join(root, 'graph-runs', seat.graphId, `${seat.runId}.json`)}.${state.path.length}.decision.json` : '';
  if (state.status === 'awaiting-approval' && state.pending && !state.pending.decision && !existsSync(claim)) {
    if (!item.approvals.some(a => a.graphId === seat.graphId && a.runId === seat.runId)) {
      item.approvals.push({ graphId: seat.graphId, runId: seat.runId, message: state.pending.message });
    }
  } else item.approvals = item.approvals.filter(a => a.graphId !== seat.graphId || a.runId !== seat.runId);
  for (const node of state.nodes ?? []) {
    const output = lastJsonObject(node.output);
    if (!output) continue;
    const entries = Array.isArray(output.artifacts) ? output.artifacts : [output];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const result = resultOf(entry as Record<string, unknown>, seat, item.id, root);
      if (result && !item.results.some(existing => existing.seat === result.seat && existing.url === result.url)) item.results.push(result);
    }
  }
  const summary = [...(state.nodes ?? [])].reverse().map(node => lastJsonObject(node.output)?.summary).find(value => typeof value === 'string');
  if (typeof summary === 'string') item.summary = summary;
  if (seat.status === 'failed') seat.reason = state.nodes?.at(-1)?.error ?? `그래프 런 ${state.status}`;
}

function aggregate(item: ExecRequest): void {
  if (item.status === 'planning' || item.seats.length === 0) return;
  if (item.seats.some(seat => seat.status === 'waiting' || seat.status === 'running')) item.status = 'running';
  else item.status = item.seats.some(seat => seat.status === 'failed') ? 'failed' : 'done';
  // 실패면 요약은 «실패 사유»가 이긴다 — 먼저 끝난 자리의 산출 설명이 남아 있어도 덮는다(혼합 결과에서 성공처럼 보이지 않게).
  if (item.status === 'failed') {
    const reasons = item.seats.filter(seat => seat.status === 'failed').map(seat => seat.reason ?? `${seat.seat}: 그래프 실행 실패`);
    if (reasons.length > 0) item.summary = reasons.join('; ');
  }
}

export class ExecRequestRunner {
  readonly store: ExecRequestStore;
  private readonly root: string;
  constructor(private readonly deps: ExecRunnerDeps = {}) {
    this.store = deps.store ?? new ExecRequestStore();
    this.root = deps.root ?? effectiveInstanceRoot();
  }

  /** 데몬 «시작» 때 한 번만 부른다(`startNexusHttpServer`). 생성자에서 부르면 모듈을 import 만 한 다른 프로세스
   *  (시험·CLI·동시 서버)가 살아 있는 요청을 «재시작 중단»으로 실패 처리한다(리뷰 3라운드 must-fix). */
  reconcileInterrupted(): void {
    for (const item of this.store.list()) {
      if (item.status !== 'planning' && item.status !== 'running') continue;
      if (item.status === 'planning') {
        item.status = 'failed';
        item.summary = '데몬 재시작으로 COO 계획이 중단됐습니다';
      } else {
        if (item.seats.length === 0) {
          item.status = 'failed';
          item.summary = '데몬 재시작으로 자리 배정이 중단됐습니다';
        }
        for (const seat of item.seats) {
          if (seat.status === 'done' || seat.status === 'failed') continue;
          const reason = '데몬 재시작으로 그래프 실행이 중단됐습니다';
          if (SEGMENT.test(seat.graphId) && SEGMENT.test(seat.runId)) {
            try {
              const file = join(this.root, 'graph-runs', seat.graphId, `${seat.runId}.json`);
              const state = JSON.parse(readFileSync(file, 'utf8')) as GraphRunState;
              if (state.graphId === seat.graphId && state.runId === seat.runId) {
                if (state.status === 'done' || state.status === 'failed' || state.status === 'budget-exceeded'
                  || (state.status === 'awaiting-approval' && state.pending)) {
                  syncRun(item, seat, state, this.root);
                  continue;
                }
              }
            } catch { /* No trustworthy completed or approval-pending run to recover. */ }
          }
          const previous = seat.status;
          seat.status = 'failed';
          seat.reason = reason;
          item.approvals = item.approvals.filter(a => a.graphId !== seat.graphId || a.runId !== seat.runId);
          debug.log('exec-requests', 'seat-status', { id: item.id, seat: seat.seat, from: previous, to: 'failed', reason });
        }
        aggregate(item);
        if (item.status === 'failed' && item.seats.length > 0) item.summary = item.seats.filter(seat => seat.status === 'failed')
          .map(seat => seat.reason ?? `${seat.seat}: 그래프 실행 실패`).join('; ');
      }
      this.store.save(item);
      if (item.status === 'failed') debug.log('exec-requests', 'failed', { id: item.id, reason: item.summary });
    }
  }

  submit(text: string): ExecRequest {
    const item = this.store.create(text);
    void this.execute(item.id).catch(error => {
      const current = this.store.get(item.id);
      if (!current) return;
      current.status = 'failed';
      current.summary = error instanceof Error ? error.message : String(error);
      this.store.save(current);
      debug.log('exec-requests', 'failed', { id: item.id, reason: current.summary });
    });
    return item;
  }

  private async execute(id: string): Promise<void> {
    const item = this.store.get(id);
    if (!item) return;
    const graphs = await (this.deps.graphs ?? installedGraphs)();
    const plans = await (this.deps.plan ?? ((text: string) => planExecRequest(text, { graphs: async () => graphs })))(item.text);
    const byId = new Map(graphs.map(graph => [graph.id, graph]));
    item.seats = plans.map(plan => ({ seat: plan.seat, title: plan.title, status: plan.reason || !byId.has(plan.graphId) ? 'failed' : 'waiting', graphId: plan.graphId,
      runId: plan.reason || !byId.has(plan.graphId) ? '' : randomUUID(), inputs: plan.inputs,
      ...(plan.reason || !byId.has(plan.graphId) ? { reason: plan.reason ?? `${plan.seat}: 요청에 맞는 설치된 실행 그래프가 없습니다` } : {}) }));
    item.status = 'running';
    debug.log('exec-requests', 'planned', { id, seats: item.seats.map(seat => ({ seat: seat.seat, graphId: seat.graphId, status: seat.status })) });
    this.store.save(item);
    await Promise.all(item.seats.map(async (seat, index) => {
      const graph = byId.get(seat.graphId);
      if (!graph || seat.status === 'failed') return;
      const starting = this.store.get(id)!;
      starting.seats[index]!.status = 'running';
      this.store.save(starting);
      debug.log('exec-requests', 'started', { id, seat: seat.seat, graphId: seat.graphId, runId: seat.runId });
      debug.log('exec-requests', 'seat-status', { id, seat: seat.seat, from: 'waiting', to: 'running' });
      try {
        const state = await (this.deps.run ?? runGraph)(graph.path, { input: seat.inputs, runId: seat.runId, deps: { root: this.root } });
        const current = this.store.get(id)!;
        syncRun(current, current.seats[index]!, state, this.root);
        aggregate(current);
        this.store.save(current);
      } catch (error) {
        const current = this.store.get(id)!;
        current.seats[index]!.status = 'failed';
        current.seats[index]!.reason = error instanceof Error ? error.message : String(error);
        debug.log('exec-requests', 'seat-status', { id, seat: seat.seat, to: 'failed', reason: current.seats[index]!.reason });
        aggregate(current);
        this.store.save(current);
      }
    }));
    const finished = this.store.get(id)!;
    aggregate(finished);
    this.store.save(finished);
    if (finished.status === 'done' || finished.status === 'failed') debug.log('exec-requests', finished.status, { id, results: finished.results.length });
  }

  get(id: string): ExecRequest | null {
    const item = this.store.get(id);
    if (!item) return null;
    if (item.status === 'planning' || item.status === 'done' || item.status === 'failed') return item;
    for (const seat of item.seats) {
      // An approved decision triggers a resume; failures are terminal and never retried on reads.
      // A terminal seat is never re-synced from a stale awaiting-approval snapshot.
      if (seat.status === 'done' || seat.status === 'failed' || !seat.runId || !SEGMENT.test(seat.graphId) || !SEGMENT.test(seat.runId)) continue;
      const file = join(this.root, 'graph-runs', seat.graphId, `${seat.runId}.json`);
      if (!existsSync(file)) continue;
      try {
        const state = JSON.parse(readFileSync(file, 'utf8')) as GraphRunState;
        if (state.graphId !== seat.graphId || state.runId !== seat.runId) continue;
        syncRun(item, seat, state, this.root);
        if (state.status === 'awaiting-approval' && state.pending && !state.pending.decision) {
          const decision = `${file}.${state.path.length}.decision.json`;
          if (existsSync(decision)) {
            item.approvals = item.approvals.filter(a => a.runId !== seat.runId);
            const key = `${seat.graphId}/${seat.runId}`;
            if (!active.has(key)) {
              active.add(key);
              const launch = async () => {
                try {
                  const graphs = await (this.deps.graphs ?? installedGraphs)();
                  const graph = graphs.find(candidate => candidate.id === seat.graphId);
                  if (!graph) throw new Error('설치된 그래프가 없습니다');
                  const resumed = await (this.deps.run ?? runGraph)(graph.path, { resumeRunId: seat.runId, deps: { root: this.root } });
                  const current = this.store.get(id);
                  const target = current?.seats.find(s => s.runId === seat.runId);
                  if (current && target) { syncRun(current, target, resumed, this.root); aggregate(current); this.store.save(current); }
                } catch (error) {
                  const reason = error instanceof Error ? error.message : String(error);
                  const current = this.store.get(id);
                  const target = current?.seats.find(s => s.graphId === seat.graphId && s.runId === seat.runId);
                  if (current && target && target.status !== 'done') {
                    target.status = 'failed';
                    target.reason = `그래프 재개 실패: ${reason}`;
                    current.approvals = current.approvals.filter(a => a.graphId !== seat.graphId || a.runId !== seat.runId);
                    aggregate(current);
                    this.store.save(current);
                    debug.log('exec-requests', 'seat-status', { id, seat: seat.seat, to: 'failed', reason: target.reason });
                  }
                  debug.log('exec-requests', 'failed', { id, seat: seat.seat, reason });
                } finally { active.delete(key); }
              };
              void launch();
            }
          }
        }
      } catch (error) { debug.log('exec-requests', 'failed', { id, seat: seat.seat, reason: String(error) }); }
    }
    const current = this.store.get(id) ?? item;
    for (const seat of item.seats) {
      const target = current.seats.find(candidate => candidate.runId && candidate.runId === seat.runId);
      if (target && target.status !== 'done' && target.status !== 'failed') {
        target.status = seat.status;
        if (seat.reason) target.reason = seat.reason;
      }
    }
    const approvals = new Map(current.approvals.map(approval => [`${approval.graphId}/${approval.runId}`, approval]));
    for (const approval of item.approvals) approvals.set(`${approval.graphId}/${approval.runId}`, approval);
    current.approvals = [...approvals.values()].filter(approval => {
      const seat = current.seats.find(candidate => candidate.graphId === approval.graphId && candidate.runId === approval.runId);
      if (!seat || seat.status === 'done' || seat.status === 'failed') return false;
      const file = join(this.root, 'graph-runs', approval.graphId, `${approval.runId}.json`);
      try {
        const state = JSON.parse(readFileSync(file, 'utf8')) as GraphRunState;
        return state.status === 'awaiting-approval' && !!state.pending && !state.pending.decision
          && !existsSync(`${file}.${state.path.length}.decision.json`);
      } catch { return false; }
    });
    for (const result of item.results) {
      if (!current.results.some(existing => existing.url === result.url)) current.results.push(result);
    }
    if (item.summary && !current.summary) current.summary = item.summary;
    aggregate(current);
    this.store.save(current);
    return current;
  }

  file(id: string, name: string): string | null {
    // Artifact names may contain spaces and Unicode; only a single safe path component is accepted.
    if (!name || name === '.' || name === '..' || name !== basename(name) || /[\\/\x00-\x1f\x7f]/.test(name)) return null;
    const item = this.get(id);
    const result = item?.results.find(entry => entry.url === `/v1/exec-requests/${id}/files/${encodeURIComponent(name)}`);
    if (!result) return null;
    const seat = item!.seats.find(entry => name.startsWith(`${entry.runId}--`) && entry.seat === result.seat);
    if (!seat) return null;
    try {
      const state = JSON.parse(readFileSync(join(this.root, 'graph-runs', seat.graphId, `${seat.runId}.json`), 'utf8')) as GraphRunState;
      if (state.graphId !== seat.graphId || state.runId !== seat.runId) return null;
      for (const node of state.nodes ?? []) {
        const output = lastJsonObject(node.output);
        if (!output) continue;
        for (const entry of Array.isArray(output.artifacts) ? output.artifacts : [output]) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
          const artifact = entry as Record<string, unknown>;
          const candidate = typeof artifact.file === 'string' ? artifact.file : artifact.path;
          if (typeof candidate !== 'string') continue;
          const path = safeFile(candidate, this.root, seat.graphId, seat.runId);
          if (path && fileName(path, seat.runId) === name) return path;
        }
      }
    } catch { return null; }
    return null;
  }
}
