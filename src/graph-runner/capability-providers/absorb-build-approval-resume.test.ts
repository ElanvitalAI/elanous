import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createJsonlMemberEventStore } from '../../nexus/api/member-event-store.js';
import { setTestStateRoot } from '../../nexus/paths.js';
import { decideGraphApproval, runGraph } from '../runner.js';
import { createAbsorbBuildMemberRegistry } from './absorb-member-registry.js';
import { createMemberStoreProvider } from './member-store.js';

test('approved default absorb-build resumes through publish and records released board card', async () => {
  const root = mkdtempSync(join(tmpdir(), 'absorb-build-resume-'));
  const previousStateDir = process.env.ELANOUS_STATE_DIR;
  const memberId = 'member-resume';
  const suggestion = { id: 'suggestion-resume', owner: memberId, appId: 'ticket-app',
    ask: 'Build a ticket queue', briefingId: 'brief-resume', designPackId: 'design-resume',
    requirementLines: ['queue'], evidenceScrapIds: ['scrap-resume'] };
  process.env.ELANOUS_STATE_DIR = root;
  setTestStateRoot(root);
  try {
    const seeded = await createMemberStoreProvider({}, 'write')({ graphId: 'absorb-build', runId: 'seed',
      nodeId: 'seed-suggestion', verifiedOwnerId: memberId,
      input: { context: { memberId } }, graphInput: { context: { memberId } },
      nodeInput: { op: 'create', collection: 'suggestions', ownerScoped: true, owner: memberId,
        key: suggestion.id, value: suggestion }, outputs: {} });
    expect(seeded.ok).toBe(true);
    const nexusRoot = join(root, 'nexus');
    const eventRoot = join(nexusRoot, 'member-events');
    const actions: string[] = [];
    const transport = async (_slug: string, request: { action: string }) => {
      actions.push(request.action);
      return request.action === 'simulate'
        ? { status: 'simulated', receipt: 'sim-synthetic-resume' }
        : { status: 'published', resultUrl: 'http://127.0.0.1:40001/', deploymentId: 'dep-synthetic-resume' };
    };
    const deps = { root, capabilityProviders: createAbsorbBuildMemberRegistry(
      createJsonlMemberEventStore(eventRoot), nexusRoot, transport),
    callLLM: async (prompt: string) => {
      const source = prompt.match(/Input:\s*(\{[\s\S]*\})\s*$/)?.[1];
      const input = source ? JSON.parse(source) as { context?: { appId?: string } } : {};
      expect(input.context?.appId).toBe('ticket-app');
      return JSON.stringify({ outcome: 'done', result: { artifact: {
        manifestYaml: 'apiVersion: elanous.app/v0\nslug: ticket-app\ntitle: Ticket app\nfrontend:\n  kind: static-export\n  out: out\nroles:\n  public: { via: public-read }\n',
        html: '<!doctype html><html><body>Ticket queue</body></html>',
      }, service: 'ticketing', capacityAssumption: {
        concurrentUsers: 300, rationale: 'fixture estimate', source: 'model-estimate', userSpecified: false,
      } }, evidence: {} });
    } };
    const graph = resolve(import.meta.dir, '../../../plugins/absorb/graph/absorb-build.yaml');
    const waiting = await runGraph(graph, { input: { suggestionId: suggestion.id,
      context: { memberId } }, verifiedOwnerId: memberId, quiet: true, deps });
    expect(waiting.status).toBe('awaiting-approval');
    expect(actions).toEqual(['simulate']);
    const nodeId = waiting.pending!.nodeId;
    decideGraphApproval(waiting.graphId, waiting.runId, 'approved', memberId, root,
      { nodeId, visit: waiting.path.filter(node => node === nodeId).length });
    const completed = await runGraph(graph, { resumeRunId: waiting.runId,
      resumeGraphId: waiting.graphId, verifiedOwnerId: memberId, quiet: true, deps });
    expect(completed.status).toBe('done');
    expect(actions).toEqual(['simulate', 'publish']);
    expect(completed.nodes.find(node => node.nodeId === 'publish')?.ok).toBe(true);
    const events = readdirSync(eventRoot).filter(file => file.endsWith('.jsonl'))
      .flatMap(file => readFileSync(join(eventRoot, file), 'utf8').trim().split('\n').filter(Boolean)
        .map(line => JSON.parse(line)));
    expect(events.map(event => event.state)).toEqual(['building', 'testing', 'released']);
  } finally {
    setTestStateRoot(null);
    if (previousStateDir === undefined) delete process.env.ELANOUS_STATE_DIR;
    else process.env.ELANOUS_STATE_DIR = previousStateDir;
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
