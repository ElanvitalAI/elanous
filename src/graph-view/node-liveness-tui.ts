// NODE-INNER-PROGRESS «추가» 4) — the default TUI (no sidetab) draws the same node-progress ledger first: the running
// tool row becomes `⏺ app_build · verify-repair r6 · 실패 시험 1 · ● 5분 전 수리 호출 · 1h45m` (+ `↳ 수리 중 …`), the
// progress row carries the node chain and the ● ◐ ✕ mark, and a stalled node (✕) queues one notice per node.
import type { GraphEvent } from '../graph-runner/graph-events.js';
import type { GraphProgressObservation } from '../graph-runner/graph-progress-observation.js';
import { graphRunEventLedgerPath, readGraphRunEvents } from '../graph-runner/graph-run-event-ledger.js';
import { renderNodeLivenessNarrow, renderNodeLivenessProgressRow, renderNodeLivenessToolRow, summarizeNodeLiveness,
  type ActiveNodeLiveness, type NodeLivenessSummary } from './node-liveness.js';

/** The TUI re-renders every second while a turn runs; the ledger file is read at most this often. */
export const NODE_LIVENESS_READ_INTERVAL_MS = 2_000;

export interface NodeLivenessTuiOptions {
  readonly root: string;
  readonly readEvents?: (path: string) => GraphEvent[];
  /** Called once per stalled node (graph · run · node); the TUI puts the text in its input queue. */
  readonly onStalled?: (text: string) => void;
}

export interface NodeLivenessView {
  readonly graphId: string;
  /** The tool that was running when the run was first observed (the tool that started the graph). */
  readonly tool?: string;
  /** undefined = the run has no ledger events yet → renderers print «정보 없음». */
  readonly summary: NodeLivenessSummary | undefined;
}

export function stalledNodeNotice(graphId: string, node: Pick<ActiveNodeLiveness, 'nodeId' | 'round' | 'quietMs'>): string {
  const round = node.round === undefined ? '' : ` r${node.round}`;
  return `그래프 노드 멎음 ✕ ${graphId} · ${node.nodeId}${round} · ${Math.floor(node.quietMs / 60_000)}분 무사건`;
}

export function createNodeLivenessTui(options: NodeLivenessTuiOptions) {
  const read = options.readEvents ?? ((path: string) => readGraphRunEvents(path));
  let run: { graphId: string; runId: string; tool?: string } | undefined;
  let events: GraphEvent[] = [];
  let readAt = Number.NEGATIVE_INFINITY;
  const notified = new Set<string>();
  return {
    /** A runner lifecycle observation names the run whose ledger this turn shows. */
    observe(event: GraphProgressObservation, runningTool?: string): void {
      if (run?.graphId !== event.graphId || run.runId !== event.runId) {
        run = { graphId: event.graphId, runId: event.runId, ...(runningTool ? { tool: runningTool } : {}) };
        events = [];
      }
      readAt = Number.NEGATIVE_INFINITY;
    },
    reset(): void { run = undefined; events = []; readAt = Number.NEGATIVE_INFINITY; },
    /** null = no graph run in this turn: callers leave their rows untouched. */
    view(nowMs: number): NodeLivenessView | null {
      if (!run) return null;
      if (nowMs - readAt >= NODE_LIVENESS_READ_INTERVAL_MS) {
        readAt = nowMs;
        // A torn or unreadable ledger keeps the last good read; the view never invents events.
        try { events = read(graphRunEventLedgerPath(options.root, run.graphId, run.runId)); } catch { /* keep */ }
      }
      const summary = summarizeNodeLiveness(events, nowMs);
      // Each stalled parallel node gets its own notice, once.
      for (const node of summary?.activeNodes ?? []) {
        if (node.liveness !== 'stalled') continue;
        const key = `${run.graphId}:${run.runId}:${node.nodeId}`;
        if (!notified.has(key)) { notified.add(key); options.onStalled?.(stalledNodeNotice(run.graphId, node)); }
      }
      return { graphId: run.graphId, ...(run.tool ? { tool: run.tool } : {}), summary };
    },
  };
}

/**
 * Replace the newest running row of the tool that started the graph (`⏺ app_build 3997s`) with the liveness tool row. Rows of other tools and
 * finished rows stay as they are; with no ledger events yet the row is left alone (the progress row says «정보 없음»).
 */
export function withNodeLivenessToolRow(lines: readonly string[], glyph: string,
  view: NodeLivenessView | null, nowMs: number): string[] {
  const tool = view?.tool;
  if (!tool || !view.summary) return [...lines];
  const head = `${glyph} ${tool}`;
  let index = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line === head || line.startsWith(`${head} `) || line.startsWith(`${head}(`)) { index = i; break; }
  }
  if (index < 0) return [...lines];
  return [...lines.slice(0, index), ...renderNodeLivenessToolRow(view.summary, tool, nowMs, glyph), ...lines.slice(index + 1)];
}

/** The progress row (⎇): node chain + ● ◐ ✕; one line, the narrow form when the chain does not fit. */
export function nodeLivenessProgressRow(view: NodeLivenessView | null, columns: number): string | undefined {
  if (!view) return undefined;
  return view.summary ? renderNodeLivenessProgressRow(view.summary, view.graphId, columns)
    : renderNodeLivenessNarrow(undefined, view.graphId);
}

/** Footer hint (hint modes): the runner's own line stays, the liveness part (chain · r · fail · mark) follows it. */
export function nodeLivenessFooterLine(view: NodeLivenessView | null, base: string | null, columns: number): string | null {
  const row = nodeLivenessProgressRow(view, columns);
  if (!row || !view) return base;
  const tail = row.slice(`⎇ ${view.graphId}`.length).replace(/^ · /, '');
  return base ? `${base} · ${tail}` : row;
}
