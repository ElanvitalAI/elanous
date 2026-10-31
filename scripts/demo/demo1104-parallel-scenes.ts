import { DEMO1104_STAGE_CONFIG, type DemoActId, type DemoLaneId } from './demo1104-stage.config.js';
import { createDemoStageConsole, type StageSnapshot } from './demo1104-stage.js';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { handleGraphRunRoute, type GraphRunView } from '../../src/graph-runner/graph-run-api.js';
import { runGraph, type GraphRunOptions } from '../../src/graph-runner/runner.js';
import { appendTopicBriefingTelegramDryRun, deliverTopicBriefingWithReceipts } from '../../src/intake-plane/actions.js';
import type { BriefItem } from '../../src/briefing/brief-items.js';
import { spawnCodingAgent } from '../../src/terminal/coding-agent.js';
import type { TerminalSession, TerminalSessionRegistry } from '../../src/terminal/session-registry.js';

export const DEMO1104_SURFACES = [
  { id: 'claude-code-tui', lane: 'maker', title: 'Claude Code TUI' },
  { id: 'codex-tui', lane: 'maker', title: 'Codex TUI' },
  { id: 'web-run-graph', lane: 'secretary', title: '웹 실행 그래프' },
  { id: 'telegram', lane: 'secretary', title: 'Telegram (dry-run)' },
] as const;

export type DemoSurfaceId = typeof DEMO1104_SURFACES[number]['id'];
export type DemoSurfaceAdapter = {
  start(signal: AbortSignal): Promise<void>;
  runAct(act: typeof DEMO1104_STAGE_CONFIG.acts[number], signal: AbortSignal): Promise<void>;
  showVideo(videoId: string, act: typeof DEMO1104_STAGE_CONFIG.acts[number], signal: AbortSignal): Promise<void>;
};

export type DemoVideoTransition = { videoId: string; source: string; actId: typeof DEMO1104_STAGE_CONFIG.acts[number]['id']; title: string };

function videoTransition(videoId: string, act: typeof DEMO1104_STAGE_CONFIG.acts[number], sources: Readonly<Record<string, string>>): DemoVideoTransition {
  const source = sources[videoId]?.trim();
  if (!source) throw new Error(`highlight video source is missing: ${videoId}`);
  return { videoId, source, actId: act.id, title: act.title };
}

function writeTelegramVideoDryRun(file: string, linearIssueId: string, transition: DemoVideoTransition): void {
  appendFileSync(file, `${JSON.stringify({ recordedAt: new Date().toISOString(), linearIssueId, kind: 'video', ...transition })}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(file, 0o600);
}

export type DemoTerminalTabAdapters = Pick<Record<DemoSurfaceId, DemoSurfaceAdapter>, 'claude-code-tui' | 'codex-tui'>;

/** Uses the existing dashboard session registry and spawnCodingAgent → TerminalSessionRegistry.spawn path. */
export function createDemo1104TuiTabAdapters(options: {
  registry: TerminalSessionRegistry;
  cwd: string;
  termSize: () => { cols: number; rows: number };
  runMission: (session: TerminalSession, act: typeof DEMO1104_STAGE_CONFIG.acts[number], signal: AbortSignal) => Promise<void>;
  showVideo: (session: TerminalSession, transition: DemoVideoTransition, signal: AbortSignal) => Promise<void> | void;
  videoSources: Readonly<Record<string, string>>;
  spawnAgent?: typeof spawnCodingAgent;
}): DemoTerminalTabAdapters {
  const sessions = new Map<'claude-code-tui' | 'codex-tui', TerminalSession>();
  const create = (id: 'claude-code-tui' | 'codex-tui', brand: 'claude-code' | 'codex'): DemoSurfaceAdapter => ({
    async start(signal) {
      if (signal.aborted) throw new Error(`${id} startup cancelled`);
      const size = options.termSize();
      const session = (options.spawnAgent ?? spawnCodingAgent)(
        { brand, cwd: options.cwd, title: `11-04 demo · ${brand}` },
        { registry: options.registry, termCols: size.cols, termRows: size.rows },
      );
      sessions.set(id, session);
    },
    async runAct(act, signal) {
      if (act.id !== 'act-2' && act.id !== 'act-5') return;
      const session = sessions.get(id);
      if (!session) throw new Error(`${id} session was not started`);
      if (signal.aborted) throw new Error(`${id} mission cancelled`);
      await options.runMission(session, act, signal);
      if (signal.aborted) throw new Error(`${id} mission cancelled`);
    },
    async showVideo(videoId, act, signal) {
      const session = sessions.get(id);
      if (!session) throw new Error(`${id} session was not started`);
      if (signal.aborted) throw new Error(`${id} video transition cancelled`);
      await options.showVideo(session, videoTransition(videoId, act, options.videoSources), signal);
      if (signal.aborted) throw new Error(`${id} video transition cancelled`);
    },
  });
  return {
    'claude-code-tui': create('claude-code-tui', 'claude-code'),
    'codex-tui': create('codex-tui', 'codex'),
  };
}

/** Run the same graph API the web editor calls and publish its live run view to a screen renderer. */
export function createDemoRunGraphSurfaceAdapter(options: {
  graphId: string;
  graphYaml: string;
  videoSources: Readonly<Record<string, string>>;
  onView: (view: GraphRunView, act: typeof DEMO1104_STAGE_CONFIG.acts[number], signal: AbortSignal) => void;
  onVideo: (transition: DemoVideoTransition, signal: AbortSignal) => Promise<void> | void;
  recipesFile?: string;
}): DemoSurfaceAdapter & { close(): void } {
  const root = mkdtempSync(join(tmpdir(), 'demo1104-run-graph-'));
  const mineDir = join(root, 'mine');
  mkdirSync(mineDir, { recursive: true });
  const graphId = options.graphId;
  const graphFile = join(mineDir, `${graphId}.yaml`);
  writeFileSync(graphFile, options.graphYaml);
  let executionSettled: Promise<void> | undefined;
  const deps = {
    root, mineDir, recipesFile: options.recipesFile ?? resolve(import.meta.dir, '../../graphs/demo/editor-recipes.yaml'),
    run(path: string, runOptions?: GraphRunOptions) {
      const execution = runGraph(path, runOptions);
      executionSettled = execution.then(() => {}, () => {});
      return execution;
    },
  };
  const abortCheck = (signal: AbortSignal) => { if (signal.aborted) throw new Error('graph screen run aborted'); };
  const awaitExecutionCleanup = async () => {
    if (!executionSettled) throw new Error('graph run completion handle is missing');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const settled = await Promise.race([
        executionSettled.then(() => true),
        new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), DEMO1104_STAGE_CONFIG.failoverDeadlineMs); }),
      ]);
      if (!settled) throw new Error(`graph runner cleanup exceeded ${DEMO1104_STAGE_CONFIG.failoverDeadlineMs}ms`);
    } finally { if (timeout) clearTimeout(timeout); }
  };
  return {
    async start(signal) { abortCheck(signal); },
    async runAct(act, signal) {
      abortCheck(signal);
      try {
        const started = handleGraphRunRoute('POST', `/v1/graphs/${graphId}/run`, { ...deps, signal });
        if (!started || started.status !== 202) throw new Error(`run-graph start failed: ${started?.status ?? 'no route'}`);
        const { runId } = await started.json() as { runId: string };
        if (!executionSettled) throw new Error('run-graph route did not start a tracked execution');
        for (let attempt = 0; attempt < 200; attempt += 1) {
          abortCheck(signal);
          const response = handleGraphRunRoute('GET', `/v1/graphs/${graphId}/runs/${runId}`, deps);
          if (!response?.ok) throw new Error(`run-graph view failed: ${response?.status ?? 'no route'}`);
          const view = await response.json() as GraphRunView;
          abortCheck(signal);
          options.onView(view, act, signal);
          abortCheck(signal);
          if (view.status === 'done') { await awaitExecutionCleanup(); return; }
          if (view.status === 'failed' || view.status === 'budget-exceeded') {
            await awaitExecutionCleanup();
            throw new Error(`run-graph ${view.status}: ${view.error ?? runId}`);
          }
          await Bun.sleep(25);
        }
        throw new Error('run-graph screen did not settle within 5 seconds');
      } finally {
        if (signal.aborted && executionSettled) await awaitExecutionCleanup();
      }
    },
    async showVideo(videoId, act, signal) {
      abortCheck(signal);
      await options.onVideo(videoTransition(videoId, act, options.videoSources), signal);
      abortCheck(signal);
    },
    close() { rmSync(root, { recursive: true, force: true }); },
  };
}

/** Exercise the production delivery/receipt path with its landed Telegram file recorder; never sends externally. */
export function createDemoTelegramDryRunAdapter(options: {
  stateDir?: string;
  file: string;
  linearIssueId: string;
  videoSources: Readonly<Record<string, string>>;
  appendDryRun?: typeof appendTopicBriefingTelegramDryRun;
}): DemoSurfaceAdapter & { close(): void } {
  const ownsStateDir = options.stateDir === undefined;
  const stateDir = options.stateDir ?? mkdtempSync(join(tmpdir(), 'demo1104-telegram-'));
  const appendDryRun = options.appendDryRun ?? appendTopicBriefingTelegramDryRun;
  mkdirSync(dirname(options.file), { recursive: true });
  const brief = (act: typeof DEMO1104_STAGE_CONFIG.acts[number]): BriefItem => ({
    id: DEMO1104_STAGE_CONFIG.acts.findIndex(row => row.id === act.id) + 1,
    text: `11-04 데모 · ${act.title}`, domain: '운영', priority: 'P1', deadline: null,
    evidence: `https://example.invalid/demo/${act.id}`, source: 'demo1104', linearIssueId: options.linearIssueId,
    created_at: new Date(0).toISOString(), sent_at: null,
  });
  return {
    async start() {},
    async runAct(act, signal) {
      const assertActive = () => { if (signal.aborted) throw new Error('Telegram dry-run superseded'); };
      const item = brief(act);
      const defaults: Parameters<typeof deliverTopicBriefingWithReceipts>[2] = {
        sendIssueCard: async ({ text }) => { assertActive(); appendDryRun(options.file, { linearIssueId: options.linearIssueId, text, kind: 'issue' }); },
        commentIssue: async () => { assertActive(); },
        issueIsDone: async () => { assertActive(); return false; },
        isDecisionImpacting: async () => { assertActive(); return false; },
        reopenIssue: async () => { assertActive(); },
        sendMemoUpdateCard: async ({ text }) => { assertActive(); appendDryRun(options.file, { linearIssueId: options.linearIssueId, text, kind: 'memo' }); },
      };
      const guarded: typeof defaults = {
        async sendIssueCard(input) { assertActive(); await defaults.sendIssueCard(input); assertActive(); },
        async commentIssue(id, text) { assertActive(); await defaults.commentIssue(id, text); assertActive(); },
        async issueIsDone(id) { assertActive(); const done = await defaults.issueIsDone(id); assertActive(); return done; },
        async isDecisionImpacting(items) { assertActive(); const impact = await defaults.isDecisionImpacting(items); assertActive(); return impact; },
        async reopenIssue(id) { assertActive(); await defaults.reopenIssue(id); assertActive(); },
        async sendMemoUpdateCard(input) { assertActive(); await defaults.sendMemoUpdateCard(input); assertActive(); },
      };
      await deliverTopicBriefingWithReceipts({ linearIssueId: options.linearIssueId, issueLabel: '11-04 데모', summary: item.text, items: [item] }, stateDir, guarded, 'telegram-dry-run');
    },
    async showVideo(videoId, act, signal) {
      if (signal.aborted) throw new Error('Telegram video transition superseded');
      writeTelegramVideoDryRun(options.file, options.linearIssueId, videoTransition(videoId, act, options.videoSources));
      if (signal.aborted) throw new Error('Telegram video transition superseded');
    },
    close() { if (ownsStateDir) rmSync(stateDir, { recursive: true, force: true }); },
  };
}

export type DemoParallelSnapshot = StageSnapshot & {
  surfaces: Array<{ id: DemoSurfaceId; lane: DemoLaneId; title: string; status: 'pending' | 'starting' | 'ready' | 'failed'; error: string | null }>;
};

async function runSurfaces(operations: Array<(signal: AbortSignal) => Promise<void>>, parentSignal: AbortSignal): Promise<void> {
  const controller = new AbortController();
  let interrupt!: () => void;
  const interrupted = new Promise<{ kind: 'interrupted' }>(resolve => { interrupt = () => resolve({ kind: 'interrupted' }); });
  const abortChildren = () => { controller.abort(); interrupt(); };
  if (parentSignal.aborted) controller.abort();
  else parentSignal.addEventListener('abort', abortChildren, { once: true });
  let firstFailure: unknown;
  let fail!: (error: unknown) => void;
  const failed = new Promise<{ kind: 'failed'; error: unknown }>(resolve => { fail = error => resolve({ kind: 'failed', error }); });
  const pending = operations.map(operation => Promise.resolve().then(() => {
    if (controller.signal.aborted) throw new Error('demo surface action cancelled');
    return operation(controller.signal);
  }).catch(error => {
    if (firstFailure === undefined) {
      firstFailure = error;
      controller.abort();
      fail(error);
    }
    throw error;
  }));
  const settled = Promise.allSettled(pending);
  try {
    const first = await Promise.race([
      settled.then(results => ({ kind: 'settled' as const, results })),
      failed,
      interrupted,
    ]);
    if (first.kind === 'settled') {
      const failure = first.results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) throw failure.reason;
      return;
    }
    // Let abort-aware adapters clean up briefly; a wedged host callback cannot hold failover.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const clean = await Promise.race([
        settled.then(() => true),
        new Promise<false>(resolve => { timeout = setTimeout(() => resolve(false), Math.min(250, DEMO1104_STAGE_CONFIG.failoverDeadlineMs)); }),
      ]);
      if (!clean) throw new Error(`demo surface cleanup exceeded ${Math.min(250, DEMO1104_STAGE_CONFIG.failoverDeadlineMs)}ms`);
    } finally { if (timeout) clearTimeout(timeout); }
    if (first.kind === 'failed') throw first.error;
    if (firstFailure !== undefined) throw firstFailure;
    throw new Error('demo surface action cancelled');
  }
  finally {
    parentSignal.removeEventListener('abort', abortChildren);
    controller.abort();
  }
}

/** Connects the existing five-second failover controller to all four real demo surfaces.
 * Launches stay adapter-owned: the CLI/session manager supplies TUI tabs, the PWA run-graph
 * client supplies the web surface, and the Telegram adapter must use file-only dry-run output. */
export function createDemo1104ParallelScenes(adapters: Record<DemoSurfaceId, DemoSurfaceAdapter>) {
  const surfaceState = new Map<DemoSurfaceId, DemoParallelSnapshot['surfaces'][number]>(
    DEMO1104_SURFACES.map(surface => [surface.id, { ...surface, status: 'pending' as const, error: null }] as const),
  );
  const controller = createDemoStageConsole({
    adapters: {
      async startLane(lane) {
        const surfaces = DEMO1104_SURFACES.filter(surface => surface.lane === lane.id);
        await Promise.all(surfaces.map(async surface => {
          const state = surfaceState.get(surface.id)!;
          state.status = 'starting';
          try {
            await adapters[surface.id].start(new AbortController().signal);
            state.status = 'ready';
          } catch (error) {
            state.status = 'failed';
            state.error = error instanceof Error ? error.message : String(error);
            throw error;
          }
        }));
      },
      async runAct(act, signal) { await runSurfaces(DEMO1104_SURFACES.map(surface => childSignal => adapters[surface.id].runAct(act, childSignal)), signal); },
      async showVideo(videoId, act, signal) { await runSurfaces(DEMO1104_SURFACES.map(surface => childSignal => adapters[surface.id].showVideo(videoId, act, childSignal)), signal); },
    },
  });
  return {
    start: () => controller.start(),
    runActNow: (id: DemoActId) => controller.runActNow(id),
    switchToVideo: (id: DemoActId) => controller.switchToVideo(id),
    snapshot(): DemoParallelSnapshot {
      return { ...controller.snapshot(), surfaces: DEMO1104_SURFACES.map(surface => ({ ...surfaceState.get(surface.id)! })) };
    },
  };
}
