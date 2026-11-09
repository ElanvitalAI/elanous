import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { readGraphContext } from '../../scripts/release-loop/node-verdict.js';
import { getTestStateRoot, setTestStateRoot } from '../nexus/paths.js';
import { createGraphEventBus } from '../graph-runner/graph-events.js';
import { listGraphRuns, runGraph } from '../graph-runner/runner.js';
import { createIncidentPolicyHandler } from '../release-loop/incident-policy-handler.js';

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
  expect(gateTriage.subscribes).toEqual(scenario.cases.map(({ eventType }) => ({ event: eventType,
    match: { nodeId: 'gate' }, action: 'reroute' })));
  graphDocument.entry_node = 'gate';

  const root = mkdtempSync(join(realpathSync(tmpdir()), 'rla-sim-vocab-node-edge-'));
  const previousRoot = getTestStateRoot();
  setTestStateRoot(root);
  try {
    for (const item of scenario.cases) {
      const execute = async () => {
        const runId = `rla-sim-vocab-${item.id}-live-edge`;
        const bus = createGraphEventBus();
        const incidentPolicy = createIncidentPolicyHandler(async (dispatch) => ({
          vocabularyLine: dispatch.event.type,
          repairSummary: item.description,
          rationale: item.rationale,
        }));
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
              // A deterministic simulated agent proposal is passed through the production policy handler;
              // runner still owns validation, persistence, append execution, and routing.
              await incidentPolicy(dispatch);
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
        return state;
      };

      const state = await execute();

      expect(state.status).toBe('done');
      expect(state.adaptiveGraphVocabulary).toContain(item.eventType);
      expect(state.adaptiveGraphEdges).toEqual([expect.objectContaining({ from: 'gate', to: 'gate-triage',
        triggerEvent: item.eventType, rationale: item.rationale })]);
      const appendedNodeId = state.subscriptionGraphAppends?.[0]?.proposal.entryNodeId;
      if (!appendedNodeId) throw new Error('incident policy did not persist its repair node');
      expect(appendedNodeId).toMatch(/^gate-repair-[a-f0-9]{12}$/);
      expect(state.subscriptionGraphAppends).toEqual([expect.objectContaining({ proposal: expect.objectContaining({
        entryNodeId: appendedNodeId, reason: expect.stringContaining(item.rationale), nodes: [expect.objectContaining({ nodeId: appendedNodeId })],
      }) })]);
      expect(state.path).toEqual(['gate', 'gate-triage', appendedNodeId, 'done']);
      expect(state.subscriptionActions).toEqual(expect.arrayContaining([
        expect.objectContaining({ nodeId: 'gate-triage', action: 'reroute', outcome: 'handled' }),
      ]));
    }
  } finally {
    setTestStateRoot(previousRoot ?? null);
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
