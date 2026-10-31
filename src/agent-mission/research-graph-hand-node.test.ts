import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBackend, AgentMissionResult, AgentMissionSpec } from './driver.js';
import { createResearchGraphHandNodeHandler } from './driver.js';
import { runGraph } from '../graph-runner/runner.js';

test('research graph hands run Codex and Claude and pass both reports to the synthesis node', async () => {
  const root = mkdtempSync(join(tmpdir(), 'research-graph-hands-'));
  const worktrees = mkdtempSync(join(tmpdir(), 'research-graph-hand-worktrees-'));
  try {
    const graph = join(root, 'graph.yaml');
    writeFileSync(join(root, 'recipes.yaml'), '{}\n');
    writeFileSync(graph, `graph_id: research-hands\nversion: 1\nentry_node: codex-hand\nterminal_nodes: [done, failed]\nnodes:\n  - { node_id: codex-hand, kind: agent, recipe: 'handler:codex-hand', max_visits: 1 }\n  - { node_id: claude-hand, kind: agent, recipe: 'handler:claude-hand', max_visits: 1 }\n  - { node_id: synthesis, kind: agent, recipe: 'handler:synthesis', max_visits: 1 }\n  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }\n  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }\nedges:\n  - { from: codex-hand, on: outcome, map: { ok: claude-hand, fail: failed } }\n  - { from: claude-hand, on: outcome, map: { ok: synthesis, fail: failed } }\n  - { from: synthesis, on: outcome, map: { ok: done, fail: failed } }\n`);

    const specs: AgentMissionSpec[] = [];
    const runMission = async (spec: AgentMissionSpec): Promise<AgentMissionResult> => {
      specs.push(spec);
      const agent = spec.agent!.name as 'codex' | 'claude';
      const worktree = join(worktrees, agent);
      const reportPath = join(worktree, '.elanous', 'mission-results', 'hand-result.md');
      mkdirSync(join(worktree, '.elanous', 'mission-results'), { recursive: true });
      writeFileSync(reportPath, `${agent} findings: source-backed conclusion\n`);
      return {
        ok: true, worktree, branch: spec.branch ?? null, rounds: 2,
        evidencePath: reportPath, evidenceSatisfied: true, committed: true,
        usedOmniCrawl: false, detail: 'completed', ptyId: `pty-${agent}`,
      };
    };
    const backend = (name?: string) => ({ name: name ?? 'codex', cmd: 'fake', args: [] }) as AgentBackend;
    let synthesisInput: Record<string, unknown> | undefined;
    const state = await runGraph(graph, {
      input: { question: 'HBM4 2027 전망', codexMission: '정량 근거를 찾아라.' },
      deps: {
        root,
        inProcessHandlers: {
          'codex-hand': createResearchGraphHandNodeHandler({ agent: 'codex' }, { runMission, resolveBackend: backend }),
          'claude-hand': createResearchGraphHandNodeHandler({ agent: 'claude' }, { runMission, resolveBackend: backend }),
          synthesis: async (context) => {
            synthesisInput = context.outputs;
            return { ok: true, outcome: 'ok', evidence: { received: Object.keys(context.outputs) } };
          },
        },
      },
    });

    expect(state.status).toBe('done');
    expect(state.path).toEqual(['codex-hand', 'claude-hand', 'synthesis', 'done']);
    expect(specs.map((spec) => spec.agent?.name)).toEqual(['codex', 'claude']);
    expect(specs[0]?.mission).toContain('정량 근거를 찾아라.');
    expect(specs[1]?.mission).toContain('반대 근거');
    expect(specs.map((spec) => spec.decisionMissionId)).toEqual([specs[0]?.decisionMissionId, specs[0]?.decisionMissionId]);
    const codex = synthesisInput?.['codex-hand'] as { evidence?: { report?: string; reportPath?: string; hand?: string } };
    const claude = synthesisInput?.['claude-hand'] as { evidence?: { report?: string; reportPath?: string; hand?: string } };
    expect(codex.evidence).toMatchObject({ hand: 'codex', report: 'codex findings: source-backed conclusion', reportPath: join(worktrees, 'codex', '.elanous', 'mission-results', 'hand-result.md') });
    expect(claude.evidence).toMatchObject({ hand: 'claude', report: 'claude findings: source-backed conclusion', reportPath: join(worktrees, 'claude', '.elanous', 'mission-results', 'hand-result.md') });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});

test('research graph hand fails closed without a research question', async () => {
  let calls = 0;
  const handler = createResearchGraphHandNodeHandler({ agent: 'codex' }, {
    runMission: async () => { calls++; throw new Error('must not launch a hand'); },
  });
  const result = await handler({ graphId: 'g', runId: 'r', nodeId: 'codex-hand', input: {}, outputs: {} });
  expect(result).toMatchObject({ ok: false, outcome: 'fail' });
  expect(calls).toBe(0);
});
