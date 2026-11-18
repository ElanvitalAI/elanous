// NODE-INNER-PROGRESS (ASK-GRAPH-LIVE-SIDETAB-1117 «추가»): a long node reports what it is doing inside, and the
// runner beats for it when it goes quiet. Both land in the run's event ledger — the one source the sidetab reads.

export const NODE_PROGRESS_EVENT = 'node-progress';
export const NODE_HEARTBEAT_EVENT = 'node-heartbeat';

export type GraphNodeProgressPhase = 'verify' | 'repair' | 'test' | 'generate' | 'materialize' | 'publish';
const PHASES: readonly GraphNodeProgressPhase[] = ['verify', 'repair', 'test', 'generate', 'materialize', 'publish'];

export interface GraphNodeProgress {
  readonly round?: number;
  readonly phase: GraphNodeProgressPhase;
  /** One file path the node is working on. */
  readonly target?: string;
  readonly result?: { readonly pass: number; readonly fail: number };
  /** ISO time a model call started (repair calls); the sidetab reads «마지막 수리 호출 n분 전» from it. */
  readonly llmCallAt?: string;
  readonly note?: string;
}

export interface GraphNodeProgressData extends GraphNodeProgress { readonly nodeId: string }
// A type alias (not an interface) so it is assignable to the ledger's Record<string, unknown> payload.
export type GraphNodeHeartbeatData = { readonly nodeId: string; readonly lastActivityAt: string; readonly quietMs: number };

// 출처: ASK-GRAPH-LIVE-SIDETAB-1117 «추가» 1) — note ≤80자, a quiet node gets a beat after 60s.
export const NODE_PROGRESS_NOTE_CHARS = 80;
export const NODE_HEARTBEAT_QUIET_MS = 60_000;

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Keep only the declared fields, in their declared shapes; anything else from a node is dropped. */
export function normalizeNodeProgress(nodeId: string, progress: GraphNodeProgress): GraphNodeProgressData | undefined {
  if (!PHASES.includes(progress.phase)) return undefined;
  const round = count(progress.round);
  const pass = count(progress.result?.pass);
  const fail = count(progress.result?.fail);
  const target = typeof progress.target === 'string' ? progress.target.split(/[\r\n]/u)[0]!.trim() : '';
  const note = typeof progress.note === 'string' ? Array.from(progress.note.replace(/\s+/gu, ' ').trim()).slice(0, NODE_PROGRESS_NOTE_CHARS).join('') : '';
  const llmCallAt = typeof progress.llmCallAt === 'string' && Number.isFinite(Date.parse(progress.llmCallAt)) ? progress.llmCallAt : undefined;
  return {
    nodeId, phase: progress.phase,
    ...(round === undefined ? {} : { round }),
    ...(target ? { target } : {}),
    ...(pass === undefined || fail === undefined ? {} : { result: { pass, fail } }),
    ...(llmCallAt ? { llmCallAt } : {}),
    ...(note ? { note } : {}),
  };
}

/** Bun's own summary lines (` 3 pass` / ` 1 fail`), summed over every run in the diagnostic; undefined when absent. */
export function bunTestCounts(diagnostic: string): { pass: number; fail: number } | undefined {
  let pass = 0; let fail = 0; let seen = false;
  for (const match of diagnostic.matchAll(/^\s*(\d+) (pass|fail)\s*$/gmu)) {
    seen = true;
    if (match[2] === 'pass') pass += Number(match[1]); else fail += Number(match[1]);
  }
  return seen ? { pass, fail } : undefined;
}

export interface NodeProgressReporter {
  report(progress: GraphNodeProgress): Promise<void>;
  /** Any other event of this node (not a heartbeat) is activity too. */
  touch(): void;
  stop(): void;
}

/**
 * One reporter per node visit. Every report and every other node event (touch) counts as activity; when nothing happened for `quietMs` the runner
 * publishes one heartbeat per quiet period (a heartbeat is not activity, so the quiet time keeps growing).
 */
export function createNodeProgressReporter(options: {
  readonly nodeId: string;
  readonly publish: (type: typeof NODE_PROGRESS_EVENT | typeof NODE_HEARTBEAT_EVENT, data: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly now?: () => number;
  readonly quietMs?: number;
  readonly setInterval?: (tick: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}): NodeProgressReporter {
  const now = options.now ?? Date.now;
  const quietMs = options.quietMs ?? NODE_HEARTBEAT_QUIET_MS;
  let lastActivity = now();
  let lastBeat = lastActivity;
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    const at = now();
    if (at - lastActivity < quietMs || at - lastBeat < quietMs) return;
    lastBeat = at;
    const data: GraphNodeHeartbeatData = { nodeId: options.nodeId, lastActivityAt: new Date(lastActivity).toISOString(), quietMs: at - lastActivity };
    void options.publish(NODE_HEARTBEAT_EVENT, data).catch(() => undefined);
  };
  const schedule = options.setInterval ?? ((callback: () => void, ms: number) => {
    const handle = setInterval(callback, ms);
    (handle as { unref?: () => void }).unref?.();
    return handle;
  });
  const handle = schedule(tick, Math.max(1, Math.floor(quietMs / 4)));
  return {
    async report(progress) {
      if (stopped) return;
      const data = normalizeNodeProgress(options.nodeId, progress);
      if (!data) return;
      lastActivity = now();
      lastBeat = lastActivity;
      try { await options.publish(NODE_PROGRESS_EVENT, data as unknown as Readonly<Record<string, unknown>>); }
      catch { /* progress is an observation; it never fails the node */ }
    },
    touch() {
      if (stopped) return;
      lastActivity = now();
      lastBeat = lastActivity;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      (options.clearInterval ?? ((value: unknown) => clearInterval(value as ReturnType<typeof setInterval>)))(handle);
    },
  };
}
