import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleGraphsCreate, handleGraphsGet, handleGraphsPut } from '../nexus/api/graphs-api.js';
import { handleGraphRunRoute, type GraphRunView } from '../graph-runner/graph-run-api.js';
import { defaultGraphsDir } from '../self-implement/graph-templates.js';
import { parseWizardSteps, readWizardSteps, savedStepsFile, wizardRecipesFor } from './saved-steps.js';

/** GRAPH-WIZARD-SAVE-RECIPES — the wizard's steps survive «저장», and «실행» runs them (server-generated commands). */

const roots: string[] = [];
const envBin = process.env.ELANOUS_WIZARD_BIN;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (envBin === undefined) delete process.env.ELANOUS_WIZARD_BIN; else process.env.ELANOUS_WIZARD_BIN = envBin;
});

const YAML = `graph_id: ai-news-mine
version: 1
entry_node: collect
terminal_nodes: [done, failed]
nodes:
  - { node_id: collect, kind: agent, recipe: 'cmd:collect', max_visits: 1 }
  - { node_id: summarize, kind: agent, recipe: 'cmd:summarize', max_visits: 1 }
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }
edges:
  - { from: collect, on: outcome, map: { ok: summarize, fail: failed } }
  - { from: summarize, on: outcome, map: { ok: done, fail: failed } }
`;
const STEPS = {
  collect: { label: '뉴스 수집', step: 'web-search', arg: "오늘 AI 뉴스'; touch PWNED; echo '", retries: 2 },
  summarize: { label: '뉴스 요약', step: 'summarize', arg: '핵심 5줄' },
  gone: { label: '지워진 노드', step: 'llm' },
};

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'wizard-save-'));
  roots.push(root);
  const mineDir = join(root, 'mine');
  mkdirSync(mineDir);
  return { root, mineDir };
}

describe('GRAPH-WIZARD-SAVE-RECIPES', () => {
  test('steps are checked against the step library and the graph; removed nodes are dropped', () => {
    const ok = parseWizardSteps(STEPS, YAML);
    expect(ok.ok && Object.keys(ok.steps)).toEqual(['collect', 'summarize']);
    expect(parseWizardSteps({ collect: { step: 'rm-rf' } }, YAML)).toEqual({ ok: false, reason: expect.stringContaining('steps.collect.step must be one of') });
    expect(parseWizardSteps({ collect: { step: 'llm', retries: 99 } }, YAML).ok).toBe(false);
    expect(parseWizardSteps({ collect: { command: 'touch x' } }, YAML)).toEqual({ ok: true, steps: { collect: {} } });
    expect(parseWizardSteps([], YAML).ok).toBe(false);
  });

  test('the server writes the commands: library step + shell-quoted argument (no client command text)', () => {
    const parsed = parseWizardSteps(STEPS, YAML);
    if (!parsed.ok) throw new Error('parse');
    const recipes = wizardRecipesFor(YAML, parsed.steps, 'elanous') as Record<string, { command: string }>;
    expect(recipes.collect!.command).toBe("elanous graph step web-search --arg '오늘 AI 뉴스'\\''; touch PWNED; echo '\\''' --retries 2");
    expect(recipes.summarize!.command).toBe("elanous graph step summarize --arg '핵심 5줄'");
  });

  test('POST /v1/graphs with steps keeps them beside the graph; PUT without steps keeps them; bad steps save nothing', async () => {
    const { mineDir } = dirs();
    const deps = { coreDir: defaultGraphsDir(), mineDir };
    const created = await handleGraphsCreate(new Request('http://localhost/v1/graphs', { method: 'POST', body: JSON.stringify({ id: 'ai-news-mine', yaml: YAML, steps: STEPS }) }), deps);
    expect(created.status).toBe(201);
    expect(Object.keys(JSON.parse(readFileSync(savedStepsFile(mineDir, 'ai-news-mine'), 'utf8')))).toEqual(['collect', 'summarize']);
    const got = await handleGraphsGet('/v1/graphs/ai-news-mine/yaml', defaultGraphsDir(), deps).json() as { steps?: Record<string, { label: string }> };
    expect(got.steps?.collect?.label).toBe('뉴스 수집');

    const put = await handleGraphsPut('/v1/graphs/ai-news-mine/yaml', new Request('http://localhost/x', { method: 'PUT', body: JSON.stringify({ yaml: YAML }) }), deps);
    expect(put.status).toBe(200);
    expect(readWizardSteps(mineDir, 'ai-news-mine', YAML)?.summarize?.step).toBe('summarize');

    const bad = await handleGraphsCreate(new Request('http://localhost/v1/graphs', { method: 'POST', body: JSON.stringify({ id: 'other-mine', yaml: YAML.replace('ai-news-mine', 'other-mine'), steps: { collect: { step: 'shell' } } }) }), deps);
    expect(bad.status).toBe(400);
    expect(existsSync(join(mineDir, 'other-mine.yaml'))).toBe(false);
  });

  test('PUT with bad steps (or an explicit null) is 400 and changes nothing; a failed save leaves neither file behind', async () => {
    const { mineDir } = dirs();
    const deps = { coreDir: defaultGraphsDir(), mineDir };
    const post = (id: string, steps: unknown) => handleGraphsCreate(new Request('http://localhost/v1/graphs', { method: 'POST', body: JSON.stringify({ id, yaml: YAML.replace('ai-news-mine', id), steps }) }), deps);
    const putYaml = (yaml: string, steps: unknown) => handleGraphsPut('/v1/graphs/ai-news-mine/yaml', new Request('http://localhost/x', { method: 'PUT', body: JSON.stringify({ yaml, steps }) }), deps);
    expect((await post('ai-news-mine', STEPS)).status).toBe(201);
    const before = readFileSync(join(mineDir, 'ai-news-mine.yaml'), 'utf8');
    const stepsBefore = readFileSync(savedStepsFile(mineDir, 'ai-news-mine'), 'utf8');
    const edited = YAML.replace("max_visits: 1 }\n  - { node_id: summarize", "max_visits: 2 }\n  - { node_id: summarize");
    expect((await putYaml(edited, { collect: { step: 'shell' } })).status).toBe(400);
    expect((await putYaml(edited, null)).status).toBe(400);
    expect(readFileSync(join(mineDir, 'ai-news-mine.yaml'), 'utf8')).toBe(before);
    expect(readFileSync(savedStepsFile(mineDir, 'ai-news-mine'), 'utf8')).toBe(stepsBefore);
    expect((await post('null-mine', null)).status).toBe(400);
    expect(existsSync(join(mineDir, 'null-mine.yaml'))).toBe(false);

    // The graph write fails after the sidecar was written (version history blocked) → both roll back.
    writeFileSync(join(mineDir, '.versions-block'), 'x');
    rmSync(join(mineDir, '.versions'), { recursive: true, force: true });
    writeFileSync(join(mineDir, '.versions'), 'not a directory');
    const failed = await post('broken-mine', STEPS);
    expect(failed.status).toBe(500);
    expect(existsSync(join(mineDir, 'broken-mine.yaml'))).toBe(false);
    expect(existsSync(savedStepsFile(mineDir, 'broken-mine'))).toBe(false);
  });

  test('a sidecar that cannot be written stops the save before the graph is touched', async () => {
    const { mineDir } = dirs();
    writeFileSync(join(mineDir, '.steps'), 'not a directory');
    const created = await handleGraphsCreate(new Request('http://localhost/v1/graphs', { method: 'POST', body: JSON.stringify({ id: 'ai-news-mine', yaml: YAML, steps: STEPS }) }), { coreDir: defaultGraphsDir(), mineDir });
    expect(created.status).toBe(500);
    expect(existsSync(join(mineDir, 'ai-news-mine.yaml'))).toBe(false);
  });

  test('«저장 → 실행»: the saved wizard graph runs its own steps; the argument reaches the step as one literal value', async () => {
    const { root, mineDir } = dirs();
    const deps = { coreDir: defaultGraphsDir(), mineDir };
    // A stand-in for `elanous`: records its argv and answers like a library step.
    const bin = join(root, 'fake-elanous');
    const seen = join(root, 'argv.log');
    writeFileSync(bin, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${seen}'; done\necho END >> '${seen}'\nprintf '{"outcome":"ok","text":"step %s"}\\n' "$3"\n`);
    chmodSync(bin, 0o755);
    process.env.ELANOUS_WIZARD_BIN = bin;
    await handleGraphsCreate(new Request('http://localhost/v1/graphs', { method: 'POST', body: JSON.stringify({ id: 'ai-news-mine', yaml: YAML, steps: STEPS }) }), deps);
    const recipesFile = join(root, 'editor-recipes.yaml');
    writeFileSync(recipesFile, 'plan:\n  command: "true"\n');
    const runDeps = { root, mineDir, recipesFile };
    const started = handleGraphRunRoute('POST', '/v1/graphs/ai-news-mine/run', runDeps)!;
    expect(started.status).toBe(202);
    const { runId } = await started.json() as { runId: string };
    let view: GraphRunView | null = null;
    for (let i = 0; i < 200; i++) {
      view = await handleGraphRunRoute('GET', `/v1/graphs/ai-news-mine/runs/${runId}`, runDeps)!.json() as GraphRunView;
      if (view.status === 'done' || view.status === 'failed') break;
      await Bun.sleep(25);
    }
    expect(view!.status).toBe('done');
    expect(view!.path).toEqual(['collect', 'summarize', 'done']);
    const argv = readFileSync(seen, 'utf8');
    expect(argv).toContain("graph\nstep\nweb-search\n--arg\n오늘 AI 뉴스'; touch PWNED; echo '\n--retries\n2\nEND");
    expect(argv).toContain('graph\nstep\nsummarize\n--arg\n핵심 5줄\nEND');
    expect(existsSync(join(root, 'PWNED'))).toBe(false);
  });
});
