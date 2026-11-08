import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatchReleaseStatus } from '../domains/release-tool.js';
import { buildDashboardSlashRegistry, type DashboardSlashContext } from '../dashboard/slash-runtime/dashboard-handlers.js';
import { getElanousConfigDirOverride, resetElanousConfigDir, setElanousConfigDir } from '../elanous-config-dir.js';
import { openSurfaceEventsDb } from '../domains/surface-events.js';
import { listCoordEvents } from '../context-bus/coord-events.js';
import { contextNow, type ContextFact, type ContextNowDeps } from '../context-bus/context-now.js';
import { recordExternalEvent } from '../context-bus/external-events.js';
import { createGraphEventBus } from '../graph-runner/graph-events.js';
import { runGraph } from '../graph-runner/runner.js';
import { registerReleaseGraphEventAdapters } from '../release-loop/graph-event-adapters.js';
import { defaultTelegramCommands, parseTelegramSlash } from '../telegram-commands.js';

export interface ReleaseStatusArrivalSnapshot {
  readonly runId: string;
  readonly release: Extract<ContextFact, { kind: 'release' }> | undefined;
  readonly expectedArrivalSource: string | undefined;
  readonly cli: string;
  readonly telegram: string;
  readonly tui: string[];
}

async function telegramReleaseReply(deps: ContextNowDeps): Promise<string> {
  const command = parseTelegramSlash('/release', defaultTelegramCommands(deps));
  if (command.kind !== 'match') throw new Error('Telegram /release was not registered');
  return String(await command.cmd.handler(command.args, {} as never, {} as never));
}

async function tuiReleaseReply(deps: ContextNowDeps): Promise<string[]> {
  const lines: string[] = [];
  const ctx = { pushChatLine: (line: string) => lines.push(line) } as unknown as DashboardSlashContext;
  await buildDashboardSlashRegistry(deps).dispatch('release', [], ctx);
  return lines;
}

/** Drives a real isolated release graph through node-arrival and samples all three consumers there. */
export async function simulateReleaseStatusArrivalEvent(): Promise<ReleaseStatusArrivalSnapshot[]> {
  const root = mkdtempSync(join(tmpdir(), 'rla-context-arrival-sim-'));
  const previous = { config: process.env.ELANOUS_CONFIG_DIR, state: process.env.ELANOUS_STATE_DIR };
  const previousConfigDir = getElanousConfigDirOverride();
  const version = '9.8.7';
  const runId = 'context-arrival-run';
  const contextDb = openSurfaceEventsDb(':memory:');
  let expectedArrivalSource: string | undefined;
  process.env.ELANOUS_CONFIG_DIR = root;
  process.env.ELANOUS_STATE_DIR = root;
  setElanousConfigDir(root);
  writeFileSync(join(root, 'recipes.yaml'), '{}\n');
  const graph = join(root, 'release-loop.yaml');
  writeFileSync(graph, [
    'graph_id: release-loop', 'version: 1', 'entry_node: done', 'terminal_nodes: [done]', 'nodes:',
    '  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }', '',
  ].join('\n'));
  const bus = createGraphEventBus();
  for (const type of ['node-arrival', 'node-start', 'node-end', 'node-leave', 'release-stage']) bus.registerType(type);
  const disposeAdapters = registerReleaseGraphEventAdapters(bus, { graphId: 'release-loop', runId }, {
    root,
    contextEvent: input => {
      if (input.summary === `release graph node-arrival · run=${runId} · node=done`) expectedArrivalSource = input.source;
      return recordExternalEvent(input, { db: contextDb });
    },
    stageMail: () => undefined,
  });
  const snapshots: ReleaseStatusArrivalSnapshot[] = [];
  const deps: ContextNowDeps = {
    version: () => version,
    checklist: v => ({ version: v, released: '', dev: v, history: [], items: [] }),
    decisions: () => [], seatEntries: () => [], runningRuns: () => [], lateSchedules: () => null,
    events: since => listCoordEvents({ since, seat: 'release-graph' }, { db: contextDb }),
  };
  const disposeObserver = bus.subscribe(async event => {
    if (event.type !== 'node-arrival' || event.runId !== runId || event.source.nodeId !== 'done') return;
    recordExternalEvent({ origin: 'release-graph', kind: 'exit',
      summary: 'release graph node-arrival · run=other-run · node=done',
      source: 'elanous://graph-event/other-run/context-bus',
      delivery: { eventId: 'other-run:arrival', subscriberId: 'context-bus' } }, { db: contextDb });
    recordExternalEvent({ origin: 'release-graph', kind: 'exit',
      summary: `release graph node-arrival · run=${runId} · node=done-extra`,
      source: 'elanous://graph-event/same-run-prefix/context-bus',
      delivery: { eventId: `${runId}:prefix-arrival`, subscriberId: 'context-bus' } }, { db: contextDb });
    const answer = contextNow({ topic: 'release' }, deps);
    const cli = dispatchReleaseStatus({ topic: 'ops' }, { contextNow: options => contextNow(options, deps) }).text;
    snapshots.push({ runId, release: answer.facts.find((fact): fact is Extract<ContextFact, { kind: 'release' }> => fact.kind === 'release'),
      expectedArrivalSource,
      cli, telegram: await telegramReleaseReply(deps), tui: await tuiReleaseReply(deps) });
  }, { type: 'node-arrival' });

  try {
    const state = await runGraph(graph, { runId, quiet: true, input: { version, publishAt: '2026-11-08T12:00:00.000Z' }, eventBus: bus,
      deps: { root, releaseGraphEventAdapters: false } });
    if (state.status !== 'done') throw new Error(`simulated release graph ended ${state.status}`);
    return snapshots;
  } finally {
    disposeObserver();
    disposeAdapters();
    contextDb.close();
    if (previous.config === undefined) delete process.env.ELANOUS_CONFIG_DIR;
    else process.env.ELANOUS_CONFIG_DIR = previous.config;
    if (previous.state === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previous.state;
    if (previousConfigDir === undefined) resetElanousConfigDir();
    else setElanousConfigDir(previousConfigDir);
    rmSync(root, { recursive: true, force: true });
  }
}
