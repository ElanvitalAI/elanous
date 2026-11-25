// DEMO-INVEST-SCENE-WIRE — the invest run's graph tab draws the widget-kit scene (FanoutBoard · StepList · ResultCard)
// instead of the plain node list. This feed watches the same (parent-addressed) node events the els graph producer
// sees, keeps one state per node (runtime · model from the graph file, verdict from the node's last progress note) and
// sends the scene model to the run's tab (`child scene graph:<runId>`); after the run, `finish(dashboard.json)` sends
// the end card built from the run's real output. Observation only: a refused or failed request never reaches the run
// (a scene that arrives before the tab exists is simply sent again with the next change).
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { fromInvestRun, investRunLive, type InvestLiveNode, type InvestNodeState, type InvestRunDashboard } from '../../src/tui/widgets/scenes/invest-run.js';
import type { InvestResearchModel } from '../../src/tui/widgets/scenes/invest-research.js';
import type { ElsResult } from '../../src/els/core.js';
import type { ElsRequest } from '../../src/els/server.js';
import type { ParentRunSources } from './parent-run-sources.js';

interface Binding { runtime?: string; model?: string }
/** node id → the runtime and model the graph file binds it to (panel and mentor nodes). */
export function graphBindings(graphYamlPath: string): Map<string, Binding> {
  const doc = parseYaml(readFileSync(graphYamlPath, 'utf8')) as { nodes?: Array<{ node_id: string; input?: Binding }> };
  return new Map((doc.nodes ?? []).map((n) => [n.node_id, { ...(n.input?.runtime ? { runtime: n.input.runtime } : {}), ...(n.input?.model ? { model: n.input.model } : {}) }]));
}

/** «runtime=codex model=gpt-6.2-sol · BUY 7/10 · …» → its parts (the panelist handler's progress note). */
export function parsePanelNote(note: string): { runtime?: string; model?: string; verdict?: string } {
  const runtime = /\bruntime=([\w-]+)/u.exec(note)?.[1];
  const model = /\bmodel=([^\s·]+)/u.exec(note)?.[1];
  const verdict = /·\s*((?:BUY|HOLD|SELL)\s+\d+\/10)/u.exec(note)?.[1] ?? (/·\s*failed\b/u.test(note) ? 'no answer' : undefined);
  return { ...(runtime ? { runtime } : {}), ...(model ? { model } : {}), ...(verdict ? { verdict } : {}) };
}

export interface SceneFeedOptions {
  readonly graphYamlPath: string;
  readonly ticker: string;
  readonly socketPath: string;
  readonly sources: ParentRunSources;
  readonly request: (socketPath: string, request: ElsRequest) => Promise<ElsResult>;
  readonly now?: () => number;
  /** How often a changed scene is sent at most (ms). */
  readonly everyMs?: number;
}

export function feedInvestScene(opts: SceneFeedOptions): { finish(dashboard?: InvestRunDashboard): Promise<void>; stop(): void; model(): InvestResearchModel } {
  const now = opts.now ?? Date.now;
  const bindings = graphBindings(opts.graphYamlPath);
  // Every node the graph names (except gates) starts as waiting, so the board shows all 15 panel rows from the start.
  const nodes = new Map<string, InvestLiveNode>([...bindings.keys()]
    .filter((id) => !['gather', 'panel-join', 'done', 'failed'].includes(id))
    .map((id) => [id, { id, state: 'waiting' as InvestNodeState, ...bindings.get(id) }]));
  let runId: string | undefined;
  let dirty = false;
  let sending: Promise<void> = Promise.resolve();
  let finalModel: InvestResearchModel | undefined;
  const model = (): InvestResearchModel => finalModel ?? investRunLive({ ticker: opts.ticker, nodes: [...nodes.values()], nowMs: now() });
  const send = async (): Promise<boolean> => {
    if (!runId) return false;
    try {
      const r = await opts.request(opts.socketPath, { op: 'child', action: 'scene', id: `graph:${runId}`, scene: { kind: 'invest-research', model: model() } });
      return r.exitCode === 0;
    } catch { return false; }
  };
  let ticks = 0;
  const flush = (): void => {
    // Running rows show their elapsed time: refresh about once a second while any node runs.
    if (++ticks % 4 === 0 && !finalModel && [...nodes.values()].some((n) => n.state === 'running')) dirty = true;
    if (!dirty) return;
    dirty = false;
    sending = sending.then(async () => { if (!(await send())) dirty = true; });
  };
  const timer = setInterval(flush, opts.everyMs ?? 250);
  timer.unref?.();
  const update = (id: string, patch: Partial<InvestLiveNode>): void => {
    const prev = nodes.get(id);
    if (!prev) return;
    nodes.set(id, { ...prev, ...patch });
    dirty = true;
  };
  const offLifecycle = opts.sources.onLifecycle((event) => {
    if (event.dryRun) return;
    if (event.nodeId === 'plan' && event.phase === 'start') runId = event.runId;
    if (event.phase === 'start') update(event.nodeId, { state: 'running', startedAt: Date.parse(event.at) || now() });
    else if (event.phase === 'end') update(event.nodeId, { state: event.outcome === 'fail' ? 'failed' : (nodes.get(event.nodeId)?.lastLine === 'no answer' ? 'failed' : 'done'), endedAt: Date.parse(event.at) || now() });
  });
  const offProgress = opts.sources.onProgress((notice) => {
    if (notice.dryRun) return;
    const note = notice.progress.note ?? '';
    const parsed = parsePanelNote(note);
    update(notice.nodeId, { ...(parsed.runtime ? { runtime: parsed.runtime } : {}),
      // A resolved model beats the graph binding; an unresolved «default» never replaces a known name.
      ...(parsed.model && parsed.model !== 'default' ? { model: parsed.model } : {}),
      ...(parsed.verdict ? { lastLine: parsed.verdict } : {}) });
  });
  const stop = (): void => { clearInterval(timer); offLifecycle(); offProgress(); };
  return {
    model,
    stop,
    async finish(dashboard) {
      stop();
      if (dashboard) finalModel = fromInvestRun(dashboard);
      await sending;
      for (let attempt = 0; attempt < 3; attempt++) if (await send()) return;
    },
  };
}
