import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGraphTemplateYaml, type GraphNodeSpec } from '../self-implement/graph-yaml.js';
import { createGraphEventBus, type GraphEvent, type GraphEventBus } from '../graph-runner/graph-events.js';
import { registerGraphSubscriptions } from '../graph-runner/graph-subscriptions.js';
import { debug } from '../debug/log.js';
import { runMacrophageHeal, type MacrophageScrap } from './macrophage-heal.js';

const SUBSCRIBER_GRAPH = join(import.meta.dir, '../../graphs/release/macrophage-subscriber.yaml');
const SUBSCRIBER_NODE_ID = 'macrophage-heal';
const DECISION_EVENT = 'release.macrophage.decision';

export interface MacrophageRuntimeOptions {
  readonly runId: string;
  readonly graphId?: string;
  readonly eventBus?: GraphEventBus;
  readonly mode?: 'live' | 'simulation';
  readonly inventory?: (event: GraphEvent) => readonly MacrophageScrap[];
  /** Applies only the two explicitly safe live cleanup kinds, after the adapter revalidates ownership. */
  readonly liveCleanup?: (scrap: MacrophageScrap) => Promise<string | undefined> | string | undefined;
  readonly now?: () => Date;
  readonly consecutiveFailureLimit?: number;
}

export interface MacrophageRuntime {
  readonly eventBus: GraphEventBus;
  readonly decisions: readonly GraphEvent[];
  dispose(): void;
}

function parseInventory(value: unknown): MacrophageScrap[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`macrophage inventory[${index}] must be an object`);
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.kind !== 'string' || !item.evidence || typeof item.evidence !== 'object' || Array.isArray(item.evidence))
      throw new Error(`macrophage inventory[${index}] is missing id, kind, or evidence`);
    if (item.owner !== undefined && typeof item.owner !== 'string') throw new Error(`macrophage inventory[${index}].owner must be text`);
    return { id: item.id, kind: item.kind as MacrophageScrap['kind'], evidence: item.evidence as MacrophageScrap['evidence'],
      ...(typeof item.owner === 'string' ? { owner: item.owner } : {}) };
  });
}

function subscriberNodes(): readonly GraphNodeSpec[] {
  const parsed = parseGraphTemplateYaml(readFileSync(SUBSCRIBER_GRAPH, 'utf8'), 'graphs/release/macrophage-subscriber.yaml');
  if (parsed.errors.length || !parsed.template) throw new Error(`invalid macrophage subscriber graph: ${parsed.errors.map((error) => error.message).join('; ')}`);
  return parsed.template.nodes;
}

/** Attach the declarative macrophage subscriber to an active release graph's real event bus. */
export function createMacrophageRuntime(options: MacrophageRuntimeOptions): MacrophageRuntime {
  const bus = options.eventBus ?? createGraphEventBus({ now: options.now });
  bus.registerType(DECISION_EVENT);
  const decisions: GraphEvent[] = [];
  bus.subscribe((event) => { if (event.type === DECISION_EVENT) decisions.push(event); }, { type: DECISION_EVENT });
  const unsubscribe = registerGraphSubscriptions(bus, subscriberNodes(), async (dispatch) => {
    if (dispatch.nodeId !== SUBSCRIBER_NODE_ID || dispatch.action !== 'wake') return;
    const inventory = options.inventory?.(dispatch.event) ?? parseInventory(dispatch.event.data?.macrophageScraps);
    const result = runMacrophageHeal({ phase: 'idle', mode: options.mode ?? 'live', now: (options.now ?? (() => new Date()))(),
      consecutiveFailureLimit: options.consecutiveFailureLimit ?? 3, inventory });
    const rows = result.events.length ? result.events : [{ id: 'inventory', kind: 'parked-pr' as const,
      evidence: 'no scrap inventory evidence was attached to the phase event', action: 'retain' as const,
      result: 'unmeasured no cleanup applied', applied: false }];
    for (const row of rows) {
      let emitted = row;
      const scrap = inventory.find((candidate) => candidate.id === row.id);
      if ((options.mode ?? 'live') === 'live' && options.liveCleanup && scrap
        && ((scrap.kind === 'merged-land-queue-row' && row.action === 'remove-queue-row')
          || (scrap.kind === 'orphan-worktree' && row.action === 'remove-resource' && scrap.evidence.mergedMainline === true))) {
        try {
          const appliedResult = await options.liveCleanup(scrap);
          if (appliedResult) emitted = { ...row, applied: true, result: appliedResult };
        } catch (error) {
          emitted = { ...row, result: `cleanup failed; retained (${error instanceof Error ? error.message : String(error)})` };
        }
      }
      const data = { sourceEventId: dispatch.event.eventId, phaseNodeId: dispatch.event.source.nodeId, status: result.status, ...emitted };
      debug.log('release-loop.macrophage', 'decision', { graphId: dispatch.event.graphId, runId: dispatch.event.runId, ...data });
      await bus.publish({ graphId: dispatch.event.graphId, runId: dispatch.event.runId,
        type: DECISION_EVENT, source: { kind: 'runner' }, data });
    }
  }, { scope: { graphId: options.graphId ?? 'release-loop', runId: options.runId } });
  return { eventBus: bus, decisions, dispose: unsubscribe };
}
