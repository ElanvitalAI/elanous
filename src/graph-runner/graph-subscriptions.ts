import type { GraphEvent, GraphEventBus } from './graph-events.js';
import type { GraphEdgeSpec, GraphNodeSpec, GraphNodeSubscription } from '../self-implement/graph-yaml.js';

export type GraphSubscriptionAction = 'wake' | 'invalidate' | 'reroute';

export type GraphSubscriptionSpec = GraphNodeSubscription;

export interface GraphSubscriptionNode {
  readonly nodeId: string;
  readonly subscribes?: readonly GraphSubscriptionSpec[];
}

export interface GraphSubscriptionDispatch {
  readonly subscriberId: string;
  readonly nodeId: string;
  readonly action: GraphSubscriptionAction;
  readonly event: GraphEvent;
  /** N21 extension point: adaptive consumers register accepted event vocabulary here. */
  readonly eventVocabulary: Pick<GraphEventBus, 'registerType' | 'hasType'>;
  /** N21 extension point: accepted adaptive edges pass through the edge policy owner. */
  readonly proposeEdge?: GraphEdgeAdditionApi;
  /** Persist and queue a run-local linear subgraph, then return to its declared resume node. */
  readonly appendGraph?: GraphSubgraphAppendApi;
}

export interface GraphSubgraphAppendProposal {
  readonly nodes: readonly GraphNodeSpec[];
  readonly edges: readonly GraphEdgeSpec[];
  readonly entryNodeId: string;
  readonly returnTo: string;
  /** Optional fail-closed terminal for outcome-routed repair nodes. */
  readonly failureTo?: string;
  readonly reason: string;
}

export type GraphSubgraphAppendResult =
  | { readonly disposition: 'appended' | 'duplicate'; readonly nodeId: string }
  | { readonly disposition: 'rejected'; readonly nodeId?: string; readonly reason: string };

export type GraphSubgraphAppendApi = (proposal: GraphSubgraphAppendProposal) => Promise<GraphSubgraphAppendResult>;

interface GraphEdgeAdditionProposalBase {
  readonly from: string;
  readonly to: string;
  readonly triggerEvent: string;
  readonly rationale: string;
}

export type GraphEdgeAdditionProposal = GraphEdgeAdditionProposalBase &
  ({ readonly mode?: 'live'; readonly unmeasuredAxis?: never } |
   { readonly mode: 'shadow'; readonly unmeasuredAxis: string });

export type GraphEdgeAdditionResult =
  | { readonly disposition: 'added' | 'rejected'; readonly reason: string }
  | { readonly disposition: 'shadow'; readonly unmeasuredAxis: string; readonly reason: string };

/** Live is the default. Shadow may be requested only with the simulation-unmeasured axis named. */
export type GraphEdgeAdditionApi = (proposal: GraphEdgeAdditionProposal) => Promise<GraphEdgeAdditionResult>;

export type GraphSubscriptionHandler = (dispatch: GraphSubscriptionDispatch) => void | Promise<void>;

export interface GraphSubscriptionScope {
  readonly graphId: string;
  readonly runId: string;
}

function matches(event: GraphEvent, match: Readonly<Record<string, unknown>> | undefined): boolean {
  if (!match) return true;
  return Object.entries(match).every(([key, expected]) => {
    const actual = key === 'graphId' || key === 'runId' || key === 'type' || key === 'eventId' || key === 'sequence'
      ? event[key]
      : key === 'nodeId' ? event.source.nodeId
      : key in event ? event[key as keyof GraphEvent] : event.data?.[key];
    return Object.is(actual, expected);
  });
}

/** Connects node declarations to the event bus and dispatches matching actions in declaration order. */
export function registerGraphSubscriptions(
  bus: GraphEventBus,
  nodes: readonly GraphSubscriptionNode[],
  dispatch: GraphSubscriptionHandler,
  options: { readonly scope: GraphSubscriptionScope; readonly proposeEdge?: GraphEdgeAdditionApi },
): () => void {
  const dispose: (() => void)[] = [];
  try {
    for (const node of nodes) {
      for (const [index, subscription] of (node.subscribes ?? []).entries()) {
        const subscriberId = `${options.scope.graphId}/${options.scope.runId}/${node.nodeId}:${index}`;
        dispose.push(bus.subscribe(async (event) => {
          if (event.graphId !== options.scope.graphId || event.runId !== options.scope.runId) return;
          if (!matches(event, subscription.match)) return;
          const proposeEdge: GraphEdgeAdditionApi | undefined = options.proposeEdge === undefined ? undefined : async (proposal) => {
            if (proposal.mode === 'shadow' && !proposal.unmeasuredAxis.trim())
              throw new Error('shadow graph edge proposal requires a non-empty unmeasuredAxis');
            const result = await options.proposeEdge!(proposal.mode === 'shadow' ? proposal : { ...proposal, mode: 'live' });
            if (result.disposition === 'shadow' && !result.unmeasuredAxis.trim())
              throw new Error('shadow graph edge result requires a non-empty unmeasuredAxis');
            return result;
          };
          await dispatch({ subscriberId, nodeId: node.nodeId, action: subscription.action, event,
            eventVocabulary: { registerType: (type) => bus.registerType(type), hasType: (type) => bus.hasType(type) },
            ...(proposeEdge === undefined ? {} : { proposeEdge }) });
        }, { type: subscription.event }));
      }
    }
  } catch (error) {
    for (const unsubscribe of dispose) unsubscribe();
    throw error;
  }
  return () => { for (const unsubscribe of dispose) unsubscribe(); };
}
