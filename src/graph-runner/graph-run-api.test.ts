import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleGraphRunRoute, type GraphRunView } from './graph-run-api.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const FAST = `done:\n  command: 'printf ''{"outcome":"ok"}\\n'''\nplan:\n  command: 'printf ''{"outcome":"ok"}\\n'''\nbuild:\n  command: 'printf ''{"outcome":"ok"}\\n'''\n`
  + `review:\n  command: 'if [ -f "\${ELANOUS_GRAPH_CONTEXT%/*}/review-seen" ]; then printf ''{"outcome":"ok"}\\n''; else : > "\${ELANOUS_GRAPH_CONTEXT%/*}/review-seen"; printf ''{"outcome":"rework"}\\n''; fi'\n`;

/** 데모 영상의 그래프 — plan → build → review(rework → build) → done. */
const DEMO = (terminal = 'done', reviewRecipe = 'cmd:review') => `graph_id: demo-review-mine
version: 1
entry_node: plan
terminal_nodes: [${terminal}]
nodes:
  - { node_id: plan, kind: agent, recipe: 'cmd:plan', max_visits: 1 }
  - { node_id: build, kind: agent, recipe: 'cmd:build', max_visits: 2 }
  - { node_id: review, kind: judge, recipe: '${reviewRecipe}', max_visits: 2 }
  - { node_id: done, kind: gate, recipe: 'cmd:done', max_visits: 1 }
edges:
  - { from: plan, on: outcome, map: { ok: build } }
  - { from: build, on: outcome, map: { ok: review } }
  - { from: review, on: outcome, map: { rework: build, ok: done } }
`;

function setup(graph = DEMO()) {
  const root = mkdtempSync(join(tmpdir(), 'graph-run-api-'));
  roots.push(root);
  const mineDir = join(root, 'mine');
  mkdirSync(mineDir);
  writeFileSync(join(mineDir, 'demo-review-mine.yaml'), graph);
  const recipesFile = join(root, 'editor-recipes.yaml');
  writeFileSync(recipesFile, FAST);
  return { root, mineDir, deps: { root, mineDir, recipesFile } };
}

async function until(read: () => Promise<GraphRunView>, done: (view: GraphRunView) => boolean): Promise<GraphRunView> {
  for (let i = 0; i < 200; i++) {
    const view = await read();
    if (done(view)) return view;
    await Bun.sleep(25);
  }
  throw new Error('run did not finish');
}

describe('CGE-RUN graph run API', () => {
  test('runs the edited graph for real and reports per-node state, including the rework loop back to build', async () => {
    const { deps } = setup();
    const started = handleGraphRunRoute('POST', '/v1/graphs/demo-review-mine/run', deps)!;
    expect(started.status).toBe(202);
    const { runId, demo } = await started.json() as { runId: string; demo: boolean };
    expect(demo).toBe(true);
    const view = await until(async () => await handleGraphRunRoute('GET', `/v1/graphs/demo-review-mine/runs/${runId}`, deps)!.json() as GraphRunView,
      (v) => v.status === 'done' || v.status === 'failed');
    expect(view.status).toBe('done');
    expect(view.path).toEqual(['plan', 'build', 'review', 'build', 'review', 'done']);
    expect(view.nodes.filter((node) => node.nodeId === 'review').map((node) => node.ok)).toEqual([true, true]);
    expect(view.nodes.every((node) => node.ok)).toBe(true);
  });

  test('a graph the runner cannot finish is refused before it starts, in words the editor can show', async () => {
    const { deps } = setup(DEMO('review'));
    const response = handleGraphRunRoute('POST', '/v1/graphs/demo-review-mine/run', deps)!;
    expect(response.status).toBe(422);
    expect((await response.json() as { issues: string[] }).issues).toEqual([
      "끝 노드 'review' 는 실행할 수 없다 — 끝 노드 이름은 done 또는 failed 여야 한다"]);
  });

  test('only repository recipes run: an unknown cmd is refused, and a recipes.yaml in «mine» is never read', async () => {
    const refused = setup(DEMO('done', 'cmd:deploy'));
    const response = handleGraphRunRoute('POST', '/v1/graphs/demo-review-mine/run', refused.deps)!;
    expect(response.status).toBe(422);
    expect((await response.json() as { issues: string[] }).issues[0]).toContain("레시피 'cmd:deploy' 는 편집기 실행 목록에 없다");

    const { root, mineDir, deps } = setup();
    const marker = join(root, 'PWNED');
    writeFileSync(join(mineDir, 'recipes.yaml'), `plan:\n  command: 'touch ${marker}; printf ''{"outcome":"ok"}\\n'''\n`);
    const { runId } = await handleGraphRunRoute('POST', '/v1/graphs/demo-review-mine/run', deps)!.json() as { runId: string };
    const view = await until(async () => await handleGraphRunRoute('GET', `/v1/graphs/demo-review-mine/runs/${runId}`, deps)!.json() as GraphRunView,
      (v) => v.status === 'done' || v.status === 'failed');
    expect(view.status).toBe('done');
    expect(existsSync(marker)).toBe(false);
  });

  test('ids are checked; core-only or unknown graphs and unknown runs are 404', async () => {
    const { deps } = setup();
    expect(handleGraphRunRoute('POST', '/v1/graphs/self-implement/run', deps)!.status).toBe(404);
    expect(handleGraphRunRoute('POST', '/v1/graphs/..%2Fx/run', deps)!.status).toBe(400);
    expect(handleGraphRunRoute('GET', '/v1/graphs/demo-review-mine/runs/..%2F..%2Fx', deps)!.status).toBe(400);
    expect(handleGraphRunRoute('GET', '/v1/graphs/demo-review-mine/runs/ed-abc-123456', deps)!.status).toBe(404);
    expect(handleGraphRunRoute('GET', '/v1/graphs/demo-review-mine/run', deps)).toBeNull();
  });
});

test('the shipped editor recipes cover the demo graph the canvas makes (plan · build · review · done)', async () => {
  const { readFileSync } = await import('node:fs');
  const { parse } = await import('yaml');
  const { runnableIssues } = await import('./graph-run-api.js');
  const shipped = parse(readFileSync(join(import.meta.dir, '../../graphs/demo/editor-recipes.yaml'), 'utf8')) as Record<string, { command: string }>;
  expect(runnableIssues(parse(DEMO()) as Record<string, unknown>, new Set(Object.keys(shipped)))).toEqual([]);
  // 부작용 0 — 네트워크·git·gh·파일 삭제를 부르지 않는다.
  for (const recipe of Object.values(shipped)) expect(recipe.command).not.toMatch(/\b(gh|git|curl|rm|eln|elanous)\b/);
});

test('refused before start: a loop node with max_visits 1, grow, and approval recipes', async () => {
  const { runnableIssues } = await import('./graph-run-api.js');
  const { parse } = await import('yaml');
  const allowed = new Set(['plan', 'build', 'review', 'done']);
  const oneVisit = parse(DEMO().replace("recipe: 'cmd:build', max_visits: 2", "recipe: 'cmd:build', max_visits: 1")) as Record<string, unknown>;
  expect(runnableIssues(oneVisit, allowed)).toEqual(["노드 'build' 는 되돌이 위에 있는데 max_visits 가 1 이다 — 두 번째 방문에서 멈춘다 · 2 이상으로"]);
  expect(runnableIssues({ ...(parse(DEMO()) as Record<string, unknown>), grow: 'on' }, allowed)[0]).toContain('grow');
  expect(runnableIssues(parse(DEMO('done', 'approval:review')) as Record<string, unknown>, allowed)[0]).toContain("승인 레시피 'approval:review'");
});
