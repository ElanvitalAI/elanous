import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { debug } from '../debug/log.js';
import { notifyExecRequestTransition } from '../web-push/notify-exec-request.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { lastJsonObject, runGraph, type GraphRunState } from '../graph-runner/runner.js';
import { installedGraphs, planExecRequest, type ExecPlanItem, type InstalledGraph } from './planner.js';
import { ExecRequestStore, type ExecAttachment, type ExecRequest, type ExecResult, type ExecSeat } from './store.js';
import { answerAsSeat } from '../intake-plane/seat-answer.js';
import { redactSecrets } from '../task-cards/card-store.js';

export interface ExecRunnerDeps {
  store?: ExecRequestStore;
  graphs?: () => Promise<InstalledGraph[]>;
  plan?: (text: string, attachments?: readonly ExecAttachment[]) => Promise<ExecPlanItem[]>;
  answer?: typeof answerAsSeat;
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
    // EXEC2 — plugin graphs (doc-draft · geo-check) write into `<graphId>/<runId>/`; that directory is this run's own too.
    const runDir = join(allowed, runId);
    const realRunDir = existsSync(runDir) && statSync(runDir).isDirectory() ? realpathSync(runDir) : null;
    const inOwnRunDir = realRunDir === join(base, runId) && real.startsWith(`${realRunDir}${sep}`);
    if ((!local && !inRunDirectory && !inOwnRunDir) || !statSync(real).isFile()) return null;
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

/** EXEC2 — `report` is how geo-check names its file; treat it like `file`/`path`. */
function fileCandidate(output: Record<string, unknown>): string | null {
  if (typeof output.file === 'string') return output.file;
  if (typeof output.path === 'string') return output.path;
  if (typeof output.report === 'string' && /\.(md|txt|pdf)$/i.test(output.report)) return output.report;
  return null;
}

const TEXT_RESULT_LIMIT = 200_000;
const TEXT_RESULT_NAME = 'result.md';

/** EXEC2 — a done seat whose graph only answered in text gets that text as a run artifact (redacted), so the result is viewable. */
function textResultFile(seat: ExecSeat, state: GraphRunState, root: string): string | null {
  const outputs = [...(state.nodes ?? [])].reverse().map(node => lastJsonObject(node.output)).filter((o): o is Record<string, unknown> => !!o);
  const text = outputs.map(o => o.markdown ?? o.text).find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  if (!text || !SEGMENT.test(seat.graphId) || !SEGMENT.test(seat.runId)) return null;
  const dir = join(root, 'graph-runs', seat.graphId, `${seat.runId}.json.artifacts`);
  const path = join(dir, TEXT_RESULT_NAME);
  try {
    if (!existsSync(path)) { mkdirSync(dir, { recursive: true }); writeFileSync(path, redactSecrets(text.slice(0, TEXT_RESULT_LIMIT)), { mode: 0o600 }); }
    return path;
  } catch { return null; }
}

function resultOf(output: Record<string, unknown>, seat: ExecSeat, id: string, root: string): ExecResult | null {
  const candidate = fileCandidate(output);
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
      notifyTransition(item, item.status, item.approvals.length);
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
  if (seat.status === 'done' && !item.results.some(existing => existing.seat === seat.seat)) {
    const file = textResultFile(seat, state, root);
    const result = file ? resultOf({ file, title: seat.title }, seat, item.id, root) : null;
    if (result) item.results.push(result);
    else {
      const keys = [...new Set((state.nodes ?? []).flatMap(node => Object.keys(lastJsonObject(node.output) ?? {})))];
      debug.log('exec.result', 'none', { seat: seat.seat, graphId: seat.graphId, keys });
    }
  }
  const summary = [...(state.nodes ?? [])].reverse().map(node => lastJsonObject(node.output)?.summary).find(value => typeof value === 'string');
  if (typeof summary === 'string') item.summary = summary;
  if (seat.status === 'failed') seat.reason = failureReason(state);
}

/** EXEC2 — the failing node's own error (e.g. doc-draft `check` {outcome:'fail', error}) beats the terminal gate's empty one. */
function failureReason(state: GraphRunState): string {
  for (const node of [...(state.nodes ?? [])].reverse()) {
    if (typeof node.error === 'string' && node.error) return node.error;
    const output = lastJsonObject(node.output);
    if (output && typeof output.error === 'string' && output.error) return redactSecrets(output.error);
  }
  return `그래프 런 ${state.status}`;
}

const PRIOR_TEXT_LIMIT = 4_000;

/** Earlier seats' outcome as plain context: the last summary and the head of a text/markdown report it wrote. */
export function withPriorResults(inputs: Record<string, unknown> | undefined, prior: Array<{ seat: ExecSeat; state: GraphRunState }>): Record<string, unknown> {
  const parts = prior.map(({ seat, state }) => {
    const outputs = [...(state.nodes ?? [])].reverse().map(node => lastJsonObject(node.output)).filter((o): o is Record<string, unknown> => !!o);
    const summary = outputs.map(o => o.summary).find((v): v is string => typeof v === 'string');
    const report = outputs.map(o => o.report).find((v): v is string => typeof v === 'string' && /\.(md|txt)$/i.test(v));
    let body = '';
    if (report && existsSync(report)) { try { body = readFileSync(report, 'utf8').slice(0, PRIOR_TEXT_LIMIT); } catch { /* summary is enough */ } }
    return [`[${seat.seat} · ${seat.title}]`, summary ?? '', body].filter(Boolean).join('\n');
  });
  const base = inputs ?? {};
  const previous = typeof base.context === 'string' && base.context.trim() ? `${base.context.trim()}\n\n` : '';
  return { ...base, context: `${previous}앞 자리 결과:\n${parts.join('\n\n')}` };
}

function notifyTransition(item: ExecRequest, from: ExecRequest['status'], pendingApprovals: number): void {
  void notifyExecRequestTransition({ id: item.id, text: item.text, from, to: item.status,
    summary: item.summary, pendingApprovals }).catch(() => { /* Push never interrupts execution. */ });
}

function aggregate(item: ExecRequest): void {
  if (item.status === 'planning' || item.seats.length === 0) return;
  const previous = item.status;
  if (item.seats.some(seat => seat.status === 'waiting' || seat.status === 'running')) item.status = 'running';
  else item.status = item.seats.some(seat => seat.status === 'failed') ? 'failed' : 'done';
  // 실패면 요약은 «실패 사유»가 이긴다 — 먼저 끝난 자리의 산출 설명이 남아 있어도 덮는다(혼합 결과에서 성공처럼 보이지 않게).
  if (item.status === 'failed') {
    const reasons = item.seats.filter(seat => seat.status === 'failed').map(seat => seat.reason ?? `${seat.seat}: 그래프 실행 실패`);
    if (reasons.length > 0) item.summary = reasons.join('; ');
  }
  if (previous !== item.status && (item.status === 'done' || item.status === 'failed')) notifyTransition(item, previous, item.approvals.length);
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
        notifyTransition(item, 'planning', item.approvals.length);
      } else {
        if (item.seats.length === 0) {
          item.status = 'failed';
          item.summary = '데몬 재시작으로 자리 배정이 중단됐습니다';
          notifyTransition(item, 'running', item.approvals.length);
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

  submit(text: string, attachments?: ExecAttachment[]): ExecRequest {
    const item = this.store.create(text, attachments);
    void this.execute(item.id).catch(error => {
      const current = this.store.get(item.id);
      if (!current) return;
      const previous = current.status;
      current.status = 'failed';
      current.summary = error instanceof Error ? error.message : String(error);
      this.store.save(current);
      if (previous !== current.status) notifyTransition(current, previous, current.approvals.length);
      debug.log('exec-requests', 'failed', { id: item.id, reason: current.summary });
    });
    return item;
  }

  private async execute(id: string): Promise<void> {
    const item = this.store.get(id);
    if (!item) return;
    const graphs = await (this.deps.graphs ?? installedGraphs)();
    const plans = await (this.deps.plan ?? ((text: string, attachments?: readonly ExecAttachment[]) => planExecRequest(text, { graphs: async () => graphs, attachments })))(item.text, item.attachments);
    const byId = new Map(graphs.map(graph => [graph.id, graph]));
    // Every clause must be a question — «상황 알려줘? 카드 만들어줘» carries a work item (review r1).
    const clauses = [...item.text.trim().matchAll(/([^?？.!。\n]+)([?？]?)/g)].map(m => ({ body: m[1]!.trim(), asked: m[2] !== '' })).filter(c => c.body);
    const isQuestion = clauses.length > 0 && clauses.every(c => c.asked
      || /(?:알려\s*줘|알려\s*주세요|보여\s*줘|보여\s*주세요|어떻게|무엇|뭐|어떤|언제|누구|질문|인가요|나요|습니까)$/.test(c.body));
    if (isQuestion && plans.length > 0 && plans.every(plan => !plan.graphId
      && !/\s—\s.+\s필요\s*$/.test(plan.title) && !/\s—\s.+\s필요\s*$/.test(plan.reason ?? '')
      && !/(?:초안|작성|제작|생성|게시|분석|전략|메일|보고서)/.test(plan.title)) && !(item.attachments?.length)) {
      for (const plan of plans) {
        const answered = await (this.deps.answer ?? answerAsSeat)(plan.seat, item.text);
        if (!answered) {
          item.seats.push({ seat: plan.seat, title: plan.title, status: 'failed', graphId: '', runId: '',
            reason: plan.reason ?? `${plan.seat}: 요청에 맞는 설치된 실행 그래프가 없습니다` });
          continue;
        }
        const seat: ExecSeat = { seat: plan.seat, title: plan.title, status: 'done', graphId: 'seat-answer', runId: randomUUID() };
        const dir = join(this.root, 'graph-runs', seat.graphId);
        const statePath = join(dir, `${seat.runId}.json`);
        const artifactDir = join(dir, `${seat.runId}.json.artifacts`);
        mkdirSync(artifactDir, { recursive: true });
        const file = join(artifactDir, TEXT_RESULT_NAME);
        writeFileSync(file, redactSecrets(answered.text.slice(0, TEXT_RESULT_LIMIT)), { mode: 0o600 });
        const state: GraphRunState = { graphId: seat.graphId, runId: seat.runId, status: 'done', path: [], executed: 0, dryRun: false, statePath, nodes: [] };
        writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
        item.seats.push(seat);
        const result = resultOf({ file, title: answered.title }, seat, id, this.root);
        if (result) item.results.push(result);
      }
      item.status = 'running';
      aggregate(item);
      this.store.save(item);
      return;
    }
    item.seats = plans.map(plan => ({ seat: plan.seat, title: plan.title, status: plan.reason || !byId.has(plan.graphId) ? 'failed' : 'waiting', graphId: plan.graphId,
      runId: plan.reason || !byId.has(plan.graphId) ? '' : randomUUID(), inputs: plan.inputs, ...(plan.after?.length ? { after: plan.after } : {}),
      ...(plan.reason || !byId.has(plan.graphId) ? { reason: plan.reason ?? `${plan.seat}: 요청에 맞는 설치된 실행 그래프가 없습니다` } : {}) }));
    item.status = 'running';
    debug.log('exec-requests', 'planned', { id, seats: item.seats.map(seat => ({ seat: seat.seat, graphId: seat.graphId, status: seat.status })) });
    this.store.save(item);
    // A5b — a seat that needs earlier results waits for them and starts with them in its `context`;
    // seats with nothing to wait for still run together.
    const states: Array<Promise<GraphRunState | null>> = [];
    item.seats.forEach((seat, index) => {
      states[index] = (async (): Promise<GraphRunState | null> => {
        const graph = byId.get(seat.graphId);
        if (!graph || seat.status === 'failed') return null;
        let inputs = seat.inputs;
        if (seat.after?.length) {
          debug.log('exec-requests', 'waiting-on', { id, seat: seat.seat, after: seat.after });
          const earlier = await Promise.all(seat.after.map(j => states[j] ?? Promise.resolve(null)));
          const now = this.store.get(id)!;
          const missing = seat.after.filter((j, k) => !earlier[k] || now.seats[j]?.status === 'failed');
          if (missing.length) {
            now.seats[index]!.status = 'failed';
            now.seats[index]!.reason = `${seat.seat}: 앞 자리(${missing.map(j => now.seats[j]?.seat ?? j).join(', ')}) 결과가 없어 진행하지 않았습니다`;
            debug.log('exec-requests', 'seat-status', { id, seat: seat.seat, to: 'failed', reason: 'dependency-failed' });
            aggregate(now); this.store.save(now);
            return null;
          }
          inputs = withPriorResults(seat.inputs, seat.after.map((j, k) => ({ seat: now.seats[j]!, state: earlier[k]! })));
        }
        const starting = this.store.get(id)!;
        starting.seats[index]!.status = 'running';
        this.store.save(starting);
        debug.log('exec-requests', 'started', { id, seat: seat.seat, graphId: seat.graphId, runId: seat.runId, ...(seat.after?.length ? { after: seat.after } : {}) });
        debug.log('exec-requests', 'seat-status', { id, seat: seat.seat, from: 'waiting', to: 'running' });
        try {
          const state = await (this.deps.run ?? runGraph)(graph.path, { input: inputs, runId: seat.runId, deps: { root: this.root } });
          const current = this.store.get(id)!;
          syncRun(current, current.seats[index]!, state, this.root);
          aggregate(current);
          this.store.save(current);
          return current.seats[index]!.status === 'failed' ? null : state;
        } catch (error) {
          const current = this.store.get(id)!;
          current.seats[index]!.status = 'failed';
          current.seats[index]!.reason = error instanceof Error ? error.message : String(error);
          debug.log('exec-requests', 'seat-status', { id, seat: seat.seat, to: 'failed', reason: current.seats[index]!.reason });
          aggregate(current);
          this.store.save(current);
          return null;
        }
      })();
    });
    await Promise.all(states);
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
          const candidate = fileCandidate(artifact);
          if (typeof candidate !== 'string') continue;
          const path = safeFile(candidate, this.root, seat.graphId, seat.runId);
          if (path && fileName(path, seat.runId) === name) return path;
        }
      }
      const text = safeFile(join(this.root, 'graph-runs', seat.graphId, `${seat.runId}.json.artifacts`, TEXT_RESULT_NAME), this.root, seat.graphId, seat.runId);
      if (text && fileName(text, seat.runId) === name) return text;
    } catch { return null; }
    return null;
  }
}
