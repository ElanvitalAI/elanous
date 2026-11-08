import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { readGraphContext } from '../../scripts/release-loop/node-verdict.js';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { createGraphEventBus } from '../graph-runner/graph-events.js';
import { listGraphRuns, runGraph } from '../graph-runner/runner.js';

interface IncidentCase {
  id: string;
  eventType: string;
  description: string;
  nodeId: string;
  rationale: string;
}

test('release graph learns incident vocabulary and appends a node and live edge for each simulated event', async () => {
  const scenarioPath = join(import.meta.dir, 'scenarios/rla-sim-vocab-node-edge.yaml');
  const scenario = parseYaml(readFileSync(scenarioPath, 'utf8')) as {
    input: { version: string; previousVersion: string };
    cases: IncidentCase[];
  };
  expect(scenario.cases.map(({ id }) => id)).toEqual([
    'stale-generated-artifact', 'release-host-lost', 'damaged-receipt-fragment',
  ]);
  const releaseGraphPath = join(import.meta.dir, '../../graphs/release/release-loop.yaml');
  const graphDocument = parseYaml(readFileSync(releaseGraphPath, 'utf8')) as Record<string, unknown> & {
    nodes: Array<Record<string, unknown>>;
    edges: unknown[];
  };
  const gateTriage = graphDocument.nodes.find((node) => node.node_id === 'gate-triage');
  if (!gateTriage) throw new Error('production release graph is missing gate-triage');
  gateTriage.subscribes = scenario.cases.map(({ eventType }) => ({ event: eventType,
    match: { nodeId: 'gate' }, action: 'reroute' }));
  graphDocument.entry_node = 'gate';

  const root = mkdtempSync(join(realpathSync(tmpdir()), 'rla-sim-vocab-node-edge-'));
  const previousRoot = getTestStateRoot();
  setTestStateRoot(root);
  try {
    for (const item of scenario.cases) {
      const execute = async (proposeLiveEdge: boolean) => {
        const runId = `rla-sim-vocab-${item.id}-${proposeLiveEdge ? 'live-edge' : 'no-edge'}`;
        const bus = createGraphEventBus();
        const edgeResults: string[] = [];
        const appendResults: Array<{ disposition: string; nodeId?: string; reason?: string }> = [];
        const state = await runGraph(releaseGraphPath, {
          graphSource: stringifyYaml(graphDocument), runId,
          input: scenario.input, pinChildUniverse: true, quiet: true, eventBus: bus,
          deps: {
            root,
            releaseGraphEventAdapters: true,
            runBash: async (_command, options) => {
              const { nodeId } = readGraphContext(options.env ?? process.env);
              if (nodeId === 'gate') {
                await bus.publish({ graphId: 'release-loop', runId, type: item.eventType,
                  source: { kind: 'node', nodeId: 'gate' }, data: { incidentId: item.id, description: item.description } });
                await bus.flush({ graphId: 'release-loop', runId });
              }
              return { exitCode: 0, stdout: '{"outcome":"ok"}\n', stderr: '' };
            },
            dispatchGraphSubscription: async (dispatch) => {
              expect(dispatch.event.type).toBe(item.eventType);
              expect(dispatch.nodeId).toBe('gate-triage');
              expect(dispatch.action).toBe('reroute');
              expect(dispatch.event.source.nodeId).toBe('gate');
              // The dispatcher is the deterministic simulated agent output. The runner still
              // owns event matching, reroute validation, persistence, append execution, and routing.
              dispatch.eventVocabulary.registerType(item.eventType);
              if (!dispatch.proposeEdge || !dispatch.appendGraph) throw new Error('release incident subscription ports are unavailable');
              const append = await dispatch.appendGraph({
                nodes: [{ nodeId: item.nodeId, kind: 'agent', recipe: 'cmd:gate-repair', maxVisits: 1 }],
                edges: [{ from: item.nodeId, on: 'outcome', map: { ok: 'done', fail: 'failed', error: 'failed' } }],
                entryNodeId: item.nodeId, returnTo: 'done', failureTo: 'failed', reason: item.rationale,
              });
              appendResults.push({ disposition: append.disposition,
                ...('nodeId' in append ? { nodeId: append.nodeId } : {}),
                ...('reason' in append ? { reason: append.reason } : {}) });
              if (proposeLiveEdge) {
                const edge = await dispatch.proposeEdge({ from: 'gate', to: 'gate-triage', triggerEvent: item.eventType,
                  rationale: item.rationale, mode: 'live' });
                edgeResults.push(edge.disposition);
              }
            },
          },
        });
        const persisted = listGraphRuns(root).runs.find((run) => run.graphId === 'release-loop' && run.runId === runId);
        expect(persisted).toBeDefined();
        expect(persisted).toMatchObject({
          adaptiveGraphVocabulary: state.adaptiveGraphVocabulary,
          subscriptionGraphAppends: state.subscriptionGraphAppends,
          path: state.path,
        });
        expect(persisted?.adaptiveGraphEdges ?? []).toEqual(state.adaptiveGraphEdges ?? []);
        return { state, edgeResults, appendResults };
      };

      if (item.id === scenario.cases[0]?.id) {
        const control = await execute(false);
        expect(control.state.status).toBe('done');
        expect(control.state.path).not.toContain('gate-triage');
        expect(control.state.path).toContain(item.nodeId);
        expect(control.state.adaptiveGraphVocabulary).toContain(item.eventType);
        expect(control.state.subscriptionGraphAppends).toEqual(expect.arrayContaining([
          expect.objectContaining({ proposal: expect.objectContaining({ entryNodeId: item.nodeId }) }),
        ]));
        expect(control.state.adaptiveGraphEdges ?? []).toHaveLength(0);
        expect(control.state.subscriptionActions).toEqual(expect.arrayContaining([
          expect.objectContaining({ nodeId: 'gate-triage', action: 'reroute', outcome: 'rejected' }),
        ]));
      }

      const { state, edgeResults, appendResults } = await execute(true);

      expect(state.status).toBe('done');
      expect(appendResults).toEqual([{ disposition: 'appended', nodeId: item.nodeId }]);
      expect(edgeResults).toEqual(['added']);
      expect(state.adaptiveGraphVocabulary).toContain(item.eventType);
      expect(state.adaptiveGraphEdges).toEqual([expect.objectContaining({ from: 'gate', to: 'gate-triage',
        triggerEvent: item.eventType, rationale: item.rationale })]);
      expect(state.subscriptionGraphAppends).toEqual([expect.objectContaining({ proposal: expect.objectContaining({
        entryNodeId: item.nodeId, reason: item.rationale, nodes: [expect.objectContaining({ nodeId: item.nodeId })],
      }) })]);
      expect(state.path).toEqual(['gate', 'gate-triage', item.nodeId, 'done']);
      expect(state.subscriptionActions).toEqual(expect.arrayContaining([
        expect.objectContaining({ nodeId: 'gate-triage', action: 'reroute', outcome: 'handled' }),
      ]));
    }
  } finally {
    setTestStateRoot(previousRoot ?? null);
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
