// GRAPH-LOOP-VIEW (내부 문서 `GRAPH-LOOP-VIEW` · 대표 11-17 «루프 표현 방법론 일반화»).
// One Loop View Model for every graph loop (app_build, release run, harness children, TA, ARG …):
// adapters project their own ledgers into these events; one renderer draws them. No screen-only state:
// every field below is a fold of events, and every number on screen comes from here.

export type GraphViewStageStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';
export type GraphViewCheckpointStatus = 'waiting' | 'active' | 'passed' | 'rejected';
/** Who resolved a decision: deterministic code, a model, or a person. */
export type GraphViewRoute = 'code' | 'model' | 'human';
export type GraphViewLoopStatus = 'running' | 'done' | 'failed' | 'cancelled';

/** Event schema (`eln logs` category `graph.view`). `at` is epoch ms from the source ledger. */
export type GraphViewEvent =
  | { readonly type: 'loop.started'; readonly loopId: string; readonly at: number; readonly kind: string; readonly lead: string; readonly title?: string;
      /** 개정 2: a small loop inside a node (ARG, retry, review rounds) names its parent loop and node and its round. */
      readonly parentLoopId?: string; readonly parentNode?: string; readonly round?: number;
      /** 개정 5: a harness child's PTY, shown read-only in the detail sidetab (`pty snapshot` source). */
      readonly ptyId?: string }
  | { readonly type: 'stage.changed'; readonly loopId: string; readonly at: number; readonly stage: string; readonly label?: string;
      readonly status: GraphViewStageStatus; readonly progress?: number }
  | { readonly type: 'worker.changed'; readonly loopId: string; readonly at: number; readonly worker: string; readonly model?: string;
      readonly stage?: string; readonly status: GraphViewStageStatus; readonly progress?: number;
      /** 개정 2: parallel lane name and the stage the lanes join into. */
      readonly lane?: string; readonly joinTo?: string }
  | { readonly type: 'decision.made'; readonly loopId: string; readonly at: number; readonly question: string; readonly choice: string;
      readonly confidence?: number; readonly route: GraphViewRoute }
  | { readonly type: 'checkpoint.changed'; readonly loopId: string; readonly at: number; readonly checkpoint: string;
      readonly status: GraphViewCheckpointStatus; readonly actor?: string; readonly summary?: string }
  | { readonly type: 'loop.ended'; readonly loopId: string; readonly at: number; readonly status: Exclude<GraphViewLoopStatus, 'running'> };

export interface GraphViewStage { readonly id: string; readonly label: string; readonly status: GraphViewStageStatus; readonly progress?: number }
export interface GraphViewWorker {
  readonly id: string; readonly model?: string; readonly stage?: string; readonly status: GraphViewStageStatus; readonly progress?: number;
  readonly lane?: string; readonly joinTo?: string;
  /** Times this worker went from failed back to running (a retried lane). */
  readonly retries: number;
}
export interface GraphViewDecision { readonly question: string; readonly choice: string; readonly confidence?: number; readonly route: GraphViewRoute; readonly at: number }
export interface GraphViewCheckpoint { readonly id: string; readonly status: GraphViewCheckpointStatus; readonly actor?: string; readonly summary?: string }
export interface GraphViewLogEntry { readonly at: number; readonly actor: string; readonly event: string; readonly detail: string }

/** The six elements: Lead · Stages · Workers · Decisions · Checkpoints · Log ⊕ Chips (chips are derived). */
export interface GraphLoopView {
  readonly loopId: string;
  readonly kind: string;
  readonly title?: string;
  readonly lead: string;
  readonly parentLoopId?: string;
  readonly parentNode?: string;
  readonly round?: number;
  readonly ptyId?: string;
  readonly status: GraphViewLoopStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly stages: readonly GraphViewStage[];
  readonly workers: readonly GraphViewWorker[];
  readonly decisions: readonly GraphViewDecision[];
  readonly checkpoints: readonly GraphViewCheckpoint[];
  readonly log: readonly GraphViewLogEntry[];
}

/** Summary chips, derived only from the view. */
export interface GraphViewChips {
  readonly stage: string | null;
  /** 1-based position of the current stage (running, else the last done), and the stage count. */
  readonly stageIndex: number;
  readonly stageCount: number;
  readonly workersRunning: number;
  readonly workersTotal: number;
  readonly decisions: number;
  readonly waitingCheckpoint: string | null;
  readonly elapsedMs: number;
}

function upsert<T extends { readonly id: string }>(rows: readonly T[], next: T): T[] {
  const index = rows.findIndex((row) => row.id === next.id);
  return index < 0 ? [...rows, next] : rows.map((row, at) => (at === index ? next : row));
}

function logLine(event: GraphViewEvent, lead: string): GraphViewLogEntry {
  switch (event.type) {
    case 'loop.started': return { at: event.at, actor: event.lead, event: 'started', detail: event.title ?? event.kind };
    case 'stage.changed': return { at: event.at, actor: lead, event: `stage ${event.status}`, detail: event.label ?? event.stage };
    case 'worker.changed': return { at: event.at, actor: event.worker, event: `worker ${event.status}`, detail: event.stage ?? '' };
    case 'decision.made': return { at: event.at, actor: event.route, event: 'decision', detail: `${event.question} → ${event.choice}` };
    case 'checkpoint.changed': return { at: event.at, actor: event.actor ?? event.checkpoint, event: `checkpoint ${event.status}`, detail: event.summary ?? event.checkpoint };
    case 'loop.ended': return { at: event.at, actor: lead, event: 'ended', detail: event.status };
  }
}

/** Fold events into one view per loop, in event order. Events for a loop before its `loop.started` are ignored. */
export function projectGraphLoopViews(events: readonly GraphViewEvent[]): Map<string, GraphLoopView> {
  const views = new Map<string, GraphLoopView>();
  for (const event of events) {
    if (event.type === 'loop.started') {
      views.set(event.loopId, { loopId: event.loopId, kind: event.kind, lead: event.lead, status: 'running', startedAt: event.at,
        stages: [], workers: [], decisions: [], checkpoints: [], log: [logLine(event, event.lead)],
        ...(event.title ? { title: event.title } : {}),
        ...(event.parentLoopId ? { parentLoopId: event.parentLoopId } : {}),
        ...(event.parentNode ? { parentNode: event.parentNode } : {}),
        ...(event.round === undefined ? {} : { round: event.round }),
        ...(event.ptyId ? { ptyId: event.ptyId } : {}) });
      continue;
    }
    const view = views.get(event.loopId);
    if (!view) continue;
    const log = [...view.log, logLine(event, view.lead)];
    switch (event.type) {
      case 'stage.changed':
        views.set(event.loopId, { ...view, log, stages: upsert(view.stages, { id: event.stage,
          label: event.label ?? view.stages.find((stage) => stage.id === event.stage)?.label ?? event.stage,
          status: event.status, ...(event.progress === undefined ? {} : { progress: event.progress }) }) });
        break;
      case 'worker.changed': {
        const previous = view.workers.find((worker) => worker.id === event.worker);
        const retried = previous?.status === 'failed' && event.status === 'running';
        views.set(event.loopId, { ...view, log, workers: upsert(view.workers, { id: event.worker, status: event.status,
          retries: (previous?.retries ?? 0) + (retried ? 1 : 0),
          ...(event.model ?? previous?.model ? { model: event.model ?? previous?.model } : {}),
          ...(event.stage ?? previous?.stage ? { stage: event.stage ?? previous?.stage } : {}),
          ...(event.lane ?? previous?.lane ? { lane: event.lane ?? previous?.lane } : {}),
          ...(event.joinTo ?? previous?.joinTo ? { joinTo: event.joinTo ?? previous?.joinTo } : {}),
          ...(event.progress === undefined ? {} : { progress: event.progress }) }) });
        break;
      }
      case 'decision.made':
        views.set(event.loopId, { ...view, log, decisions: [...view.decisions, { question: event.question, choice: event.choice,
          route: event.route, at: event.at, ...(event.confidence === undefined ? {} : { confidence: event.confidence }) }] });
        break;
      case 'checkpoint.changed':
        views.set(event.loopId, { ...view, log, checkpoints: upsert(view.checkpoints, { id: event.checkpoint, status: event.status,
          ...(event.actor ? { actor: event.actor } : {}), ...(event.summary ? { summary: event.summary } : {}) }) });
        break;
      case 'loop.ended':
        views.set(event.loopId, { ...view, log, status: event.status, endedAt: event.at });
        break;
    }
  }
  return views;
}

export function graphViewChips(view: GraphLoopView, nowMs: number): GraphViewChips {
  const running = view.stages.findIndex((stage) => stage.status === 'running');
  let lastDone = -1;
  view.stages.forEach((stage, index) => { if (stage.status === 'done') lastDone = index; });
  const current = running >= 0 ? running : lastDone;
  const waiting = view.checkpoints.find((checkpoint) => checkpoint.status === 'waiting' || checkpoint.status === 'active');
  return {
    stage: current >= 0 ? view.stages[current]!.label : null,
    stageIndex: current + 1,
    stageCount: view.stages.length,
    workersRunning: view.workers.filter((worker) => worker.status === 'running').length,
    workersTotal: view.workers.length,
    decisions: view.decisions.length,
    waitingCheckpoint: waiting ? waiting.id : null,
    elapsedMs: Math.max(0, (view.endedAt ?? nowMs) - view.startedAt),
  };
}

/** Small loops inside `node` of `parent`, oldest round first (개정 2 · depth 1 is expanded by the renderer). */
export function graphViewChildLoops(views: readonly GraphLoopView[], parent: GraphLoopView, node: string): GraphLoopView[] {
  return views.filter((view) => view.parentLoopId === parent.loopId && view.parentNode === node)
    .sort((left, right) => (left.round ?? 0) - (right.round ?? 0) || left.startedAt - right.startedAt);
}
