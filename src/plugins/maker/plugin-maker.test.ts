import { afterEach, expect, spyOn, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makePlugin, validatePluginDir } from './plugin-maker.js';
import { runGraph } from '../../graph-runner/runner.js';
import { debug } from '../../debug/log.js';
import { fromWizardLogFrame } from '../../../apps/pwa/src/lib/inside-events.js';
import { listInstalledPlugins } from '../install/plugin-install.js';
import { parse as parseYaml } from 'yaml';

const dirs: string[] = [];
const previous = process.env.ELANOUS_STATE_DIR;
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'plugin-maker-'));
  dirs.push(root);
  process.env.ELANOUS_STATE_DIR = root;
  return root;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (previous === undefined) delete process.env.ELANOUS_STATE_DIR;
  else process.env.ELANOUS_STATE_DIR = previous;
});

function twoNodesFor(dir: string, name: string): void {
  const graph = join(dir, 'graphs', `${name}.yaml`);
  writeFileSync(graph, readFileSync(graph, 'utf8')
    .replace("  - { node_id: done,", "  - { node_id: second, kind: agent, recipe: 'cmd:second', max_visits: 1 }\n  - { node_id: done,")
    .replace('map: { ok: done, fail: failed } }', 'map: { ok: second, fail: failed } }\n  - { from: second, on: outcome, map: { ok: done, fail: failed } }'));
  writeFileSync(join(dir, 'graphs', 'recipes.yaml'), 'main:\n  command: \'bun "$ELANOUS_GRAPH_DIR/run-step.ts" main\'\n  timeout_ms: 120000\nsecond:\n  command: \'bun "$ELANOUS_GRAPH_DIR/run-step.ts" second\'\n  timeout_ms: 120000\n');
  writeFileSync(join(dir, 'examples', 'input.json'), '{"phrase":"hello"}\n');
  writeFileSync(join(dir, 'graphs', 'run-step.ts'), "import { readFileSync } from 'node:fs';\nconst context = JSON.parse(readFileSync(process.env.ELANOUS_GRAPH_CONTEXT!, 'utf8'));\nconsole.log(JSON.stringify({ outcome: 'ok', input: context.input }));\n");
  const manifestPath = join(dir, 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  delete manifest.extensions['ai.elanous'].researchDraft;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}

function twoNodes(dir: string): void { twoNodesFor(dir, 'sample'); }

test('fake codex writes two nodes; installed graph runs real runner with example input and six timings', async () => {
  const root = temp();
  let calls = 0;
  const result = await makePlugin({ request: 'sample', name: 'sample', parentDir: join(root, 'plugins-local'), run: true,
    deps: { codex: async (dir, prompt) => { calls++; expect(prompt).toContain('요청 원문:\nsample'); twoNodes(dir); } } });
  expect(result.errors).toEqual([]);
  expect(calls).toBe(1);
  expect(result.status).toBe('ran');
  expect(result.runStatus).toBe('done');
  expect(result.timings).toEqual({ scaffold: expect.any(Number), write: expect.any(Number), validate: expect.any(Number), install: expect.any(Number), run: expect.any(Number) });
  expect(result.graph).toContain(join('plugins', 'local', 'sample', '0.1.0', 'graphs', 'sample.yaml'));
  expect(listInstalledPlugins(root).map(item => item.name)).toEqual(['sample']);
});

test('long request slug fits the generated wizard file name', async () => {
  const root = temp();
  const result = await makePlugin({ request: 'a'.repeat(32), parentDir: join(root, 'plugins-local'),
    deps: { codex: async dir => { twoNodesFor(dir, 'a'.repeat(31)); } } });
  expect(result.status).toBe('installed');
  expect(result.plugin).toBe('a'.repeat(31));
  expect(listInstalledPlugins(root).map(item => item.name)).toEqual(['a'.repeat(31)]);
});

test('generated research graph remains uninstalled when codex leaves draft steps unimplemented', async () => {
  const root = temp();
  const result = await makePlugin({ request: 'weather research', name: 'weather-research',
    parentDir: join(root, 'plugins-local'), deps: { codex: async dir => {
      twoNodesFor(dir, 'weather-research');
      const file = join(dir, 'plugin.json');
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      manifest.extensions['ai.elanous'].researchDraft = true;
      writeFileSync(file, JSON.stringify(manifest));
      writeFileSync(join(dir, 'graphs', 'run-step.ts'), `console.log(JSON.stringify({ outcome: 'fail', error: 'Weather backend offline' }));\nprocess.exitCode = 1;\n`);
    } } });
  expect(result.status).toBe('failed');
  expect(result.errors).toContain('research graph validation failed: failed');
  expect(result.timings.repair).toEqual(expect.any(Number));
  expect(listInstalledPlugins(root)).toEqual([]);
  expect(JSON.parse(readFileSync(join(result.dir, 'plugin.json'), 'utf8')).extensions['ai.elanous'].researchDraft).toBe(true);
});

test('failed graph steps cannot install even if codex removes the researchDraft flag', async () => {
  const root = temp();
  const result = await makePlugin({ request: 'weather research', name: 'failed-weather',
    parentDir: join(root, 'plugins-local'), deps: { codex: async dir => {
      twoNodesFor(dir, 'failed-weather');
      writeFileSync(join(dir, 'graphs', 'run-step.ts'), `console.log(JSON.stringify({ outcome: 'fail', error: 'Weather backend offline' }));\n`);
    } } });
  expect(result.status).toBe('failed');
  expect(result.errors).toContain('research graph validation failed: failed');
  expect(result.timings.repair).toEqual(expect.any(Number));
  expect(listInstalledPlugins(root)).toEqual([]);
  expect(JSON.parse(readFileSync(join(result.dir, 'plugin.json'), 'utf8')).extensions['ai.elanous'].researchDraft).toBe(true);
});

test('draft-file plugin make validates definitions but does not install an unimplemented graph', async () => {
  const root = temp();
  const draftFile = join(root, 'research-draft.json');
  writeFileSync(draftFile, JSON.stringify({ description: 'Research the weather',
    connectors: [{ id: 'weather', credentials: [{ name: 'WEATHER_API_KEY' }] }],
    skill: { description: 'Weather researcher', instructions: 'Check the forecast.', requires: ['openai'] },
  }));
  const result = await makePlugin({ request: 'weather research', name: 'weather-research', draftFile,
    parentDir: join(root, 'plugins-local'), deps: { codex: async () => { throw new Error('draft must not invoke codex'); } } });
  expect(result.status).toBe('draft');
  expect(result.errors).toEqual([]);
  expect(result.timings.install).toBe(0);
  expect(result.timings.repair).toBeUndefined();
  const manifest = JSON.parse(readFileSync(join(result.dir, 'plugin.json'), 'utf8'));
  expect(manifest.extensions['ai.elanous'].connectors).toEqual([
    { id: 'weather', fields: [{ name: 'WEATHER_API_KEY', secret: true }] },
  ]);
  const skill = readFileSync(join(result.dir, 'skills', 'weather-research', 'SKILL.md'), 'utf8');
  expect(parseYaml(skill.split('---')[1]!)).toMatchObject({ requires: ['openai'] });
  expect(listInstalledPlugins(root)).toEqual([]);
});

test('invalid research draft cannot reach installation or codex repair', async () => {
  const root = temp();
  const draftFile = join(root, 'research-draft.json');
  writeFileSync(draftFile, JSON.stringify({ description: 'Research the weather',
    skill: { description: 'Weather', instructions: 'Check the forecast.', requires: ['invented-resource'] },
  }));
  const result = await makePlugin({ request: 'weather research', name: 'weather-research', draftFile,
    parentDir: join(root, 'plugins-local'), deps: { codex: async () => { throw new Error('draft must not invoke codex'); } } });
  expect(result.status).toBe('failed');
  expect(result.errors.join(' ')).toContain('existing resource ids');
  expect(listInstalledPlugins(root)).toEqual([]);
});

test('one-line request collects cited connector, skill and graph draft before existing make, with ordered wizard steps', async () => {
  const root = temp();
  const steps: string[] = [];
  const eventIds: string[] = [];
  const logged: string[] = [];
  const inside: string[] = [];
  const log = spyOn(debug, 'log').mockImplementation((category, event, data) => {
    if (category === 'wizard.step' && event === 'wizard.step') {
      logged.push((data as { step: string }).step);
      const parsed = fromWizardLogFrame({ category, event, data });
      if (parsed) inside.push(parsed.step);
    }
  });
  let prompt = '';
  try {
    const result = await makePlugin({ request: 'Sync tickets using Acme API skill', name: 'ticket-sync', parentDir: join(root, 'plugins-local'), deps: {
      webSearch: async query => {
        expect(query).toBe('Sync tickets using Acme API skill');
        return { sources: [
          { source: 'omni-crawl', url: 'https://api.acme.example/docs', title: 'Acme API integration', snippet: 'Use ACME_API_KEY for tickets' },
          { source: 'omni-crawl', url: 'https://api.acme.example/skills', title: 'Ticket skill workflow', snippet: 'Skill to process tickets' },
        ] };
      },
      memorySearch: async () => [{ source: 'aside', url: 'aside:ticket-note', title: 'Ticket note', snippet: 'Report after sync' }],
      onEvent: event => { steps.push(event.step); eventIds.push(event.wizardId); expect(event.ts).toEqual(expect.any(String)); expect(event.wizardId).toEqual(expect.any(String)); },
      codex: async (dir, text) => {
        prompt = text;
        expect(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')).extensions['ai.elanous'].connectors)
          .toEqual([{ id: 'api-acme-example', fields: [{ name: 'ACME_API_KEY', secret: true }] }]);
        expect(existsSync(join(dir, 'skills', 'ticket-sync', 'SKILL.md'))).toBe(true);
        twoNodesFor(dir, 'ticket-sync');
      },
    } });
    expect(result.status).toBe('installed');
    expect(steps).toEqual(['request', 'research', 'draft', 'validate', 'install', 'done']);
    expect(new Set(eventIds).size).toBe(1);
    expect(result.draft.connectors[0]).toMatchObject({ name: 'api.acme.example', missingCredentials: ['ACME_API_KEY'], evidence: ['https://api.acme.example/docs'] });
    expect(result.draft.skills[0]?.evidence).toContain('https://api.acme.example/skills');
    expect(result.draft.graph.nodes).toEqual(['process', 'fetch', 'report']);
    expect(result.draft.graph.evidence).toContain('aside:ticket-note');
    expect(prompt).toContain(JSON.stringify(result.draft, null, 2));
    const manifest = JSON.parse(readFileSync(join(result.dir, 'plugin.json'), 'utf8'));
    expect(manifest.extensions['ai.elanous'].connectors).toEqual([
      { id: 'api-acme-example', fields: [{ name: 'ACME_API_KEY', secret: true }] },
    ]);
    expect(manifest.extensions['ai.elanous'].researchDraft).toBeUndefined();
    const installed = listInstalledPlugins(root)[0]!;
    expect(JSON.parse(readFileSync(join(installed.path, 'plugin.json'), 'utf8')).extensions['ai.elanous'].connectors)
      .toEqual(manifest.extensions['ai.elanous'].connectors);
    expect(parseYaml(readFileSync(join(installed.path, 'skills', 'ticket-sync', 'SKILL.md'), 'utf8').split('---')[1]!))
      .toMatchObject({ name: 'ticket-sync', requires: [] });
    expect(await validatePluginDir(installed.path)).toEqual([]);
    expect(logged).toEqual(steps);
    expect(inside).toEqual(steps);
  } finally { log.mockRestore(); }
});

test('malformed research URLs are excluded with reasons while the existing make continues', async () => {
  const root = temp();
  const events: Array<{ step: string; text: string; detail?: unknown }> = [];
  let prompt = '';
  const result = await makePlugin({ request: 'Sync tickets via API', name: 'bad-link', parentDir: join(root, 'plugins-local'), deps: {
    webSearch: async () => ({ sources: [
      { source: 'omni-crawl', url: 'https://', title: 'Broken API connector', snippet: 'Use BROKEN_API_KEY' },
      { source: 'omni-crawl', url: 'https://valid.example/skill', title: 'Ticket skill workflow', snippet: 'process and report' },
    ] }),
    memorySearch: async () => [],
    onEvent: event => events.push(event),
    codex: async (dir, text) => { prompt = text; twoNodesFor(dir, 'bad-link'); },
  } });
  expect(result.status).toBe('installed');
  expect(result.draft.research.sources.map(source => source.url)).toEqual(['https://valid.example/skill']);
  expect(result.draft.research.unavailable.join(' ')).toContain('잘못된 출처 URL: https://');
  expect(result.draft.connectors[0]?.evidence).not.toContain('https://');
  expect(result.draft.graph.evidence).toEqual(['https://valid.example/skill']);
  expect(events.find(event => event.step === 'research')?.detail).toMatchObject({ unavailable: expect.arrayContaining([expect.stringContaining('잘못된 출처 URL')]) });
  expect(prompt).toContain(JSON.stringify(result.draft, null, 2));
  expect(events.map(event => event.step)).toEqual(['request', 'research', 'draft', 'validate', 'install', 'done']);
});

test('aside CLI searches local memory and passes its cited results into the existing make input', async () => {
  const root = temp();
  const bin = join(root, 'fake-aside');
  const argsFile = join(root, 'aside-args.json');
  writeFileSync(bin, `#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
console.log(JSON.stringify({ sources: [
  { title: 'Ticket API connector', url: 'aside:notes/ticket-api', snippet: 'API uses TICKET_API_KEY for sync' },
  { title: 'Ticket skill workflow graph', url: 'aside:notes/ticket-flow', snippet: 'Skill workflow: collect, process, report' }
] }));
`);
  chmodSync(bin, 0o755);
  let prompt = '';
  const result = await makePlugin({ request: 'Sync tickets via API', name: 'aside-wired', parentDir: join(root, 'plugins-local'), deps: {
    asideBin: bin,
    webSearch: async () => ({ sources: [] }),
    codex: async (dir, text) => { prompt = text; twoNodesFor(dir, 'aside-wired'); },
  } });
  expect(result.status).toBe('installed');
  expect(JSON.parse(readFileSync(argsFile, 'utf8'))).toEqual(['exec', '--effort', 'low', expect.stringContaining('Sync tickets via API')]);
  expect(result.draft.research.sources.map(source => source.source)).toEqual(['aside', 'aside']);
  expect(result.draft.connectors[0]).toMatchObject({ name: 'Ticket API connector', missingCredentials: ['TICKET_API_KEY'], evidence: ['aside:notes/ticket-api'] });
  expect(result.draft.skills[0]).toMatchObject({ name: 'Ticket skill workflow graph', evidence: ['aside:notes/ticket-flow'] });
  expect(result.draft.graph.evidence).toContain('aside:notes/ticket-flow');
  expect(prompt).toContain(JSON.stringify(result.draft, null, 2));
});

test('absent aside records its reason and still calls make', async () => {
  const root = temp();
  let calls = 0;
  const result = await makePlugin({ request: 'Local tickets', name: 'aside-absent', parentDir: join(root, 'plugins-local'), deps: {
    asideBin: join(root, 'missing-aside'),
    webSearch: async () => ({ sources: [] }),
    codex: async dir => { calls++; twoNodesFor(dir, 'aside-absent'); },
  } });
  expect(result.status).toBe('installed');
  expect(calls).toBe(1);
  expect(result.draft.research.unavailable.join(' ')).toContain('aside:');
  expect(result.draft.research.unavailable.join(' ')).toContain('ENOENT');
});

test('research unavailable preserves make and emits the reason instead of blocking', async () => {
  const root = temp();
  const events: Array<{ step: string; text: string }> = [];
  let calls = 0;
  const result = await makePlugin({ request: 'simple plugin', name: 'no-research', parentDir: join(root, 'plugins-local'), deps: {
    webSearch: () => { throw new Error('web offline'); },
    memorySearch: async () => { throw new Error('aside offline'); },
    onEvent: event => events.push(event),
    codex: async dir => { calls++; twoNodesFor(dir, 'no-research'); },
  } });
  expect(result.status).toBe('installed');
  expect(calls).toBe(1);
  expect(result.draft.research.unavailable.join(' ')).toContain('web offline');
  expect(result.draft.research.unavailable.join(' ')).toContain('aside offline');
  expect(JSON.parse(readFileSync(join(result.dir, 'plugin.json'), 'utf8')).extensions['ai.elanous'].connectors).toEqual([]);
  expect(events.find(event => event.step === 'research')?.text).toContain('조사 없음 ·');
  expect(events.map(event => event.step)).toEqual(['request', 'research', 'draft', 'validate', 'install', 'done']);
});

test('missing cmd:score is reported and repaired exactly once', async () => {
  const root = temp();
  let calls = 0;
  const result = await makePlugin({ request: 'score', name: 'score-plugin', parentDir: join(root, 'plugins-local'), deps: {
    codex: async (dir, prompt) => {
      calls++;
      if (calls === 1) writeFileSync(join(dir, 'graphs', 'score-plugin.yaml'), readFileSync(join(dir, 'graphs', 'score-plugin.yaml'), 'utf8').replace('cmd:main', 'cmd:score'));
      else { expect(prompt).toContain('recipe score 없음'); twoNodesFor(dir, 'score-plugin'); writeFileSync(join(dir, 'graphs', 'recipes.yaml'), 'score:\n  command: \'bun "$ELANOUS_GRAPH_DIR/run-step.ts" score\'\n  timeout_ms: 120000\nsecond:\n  command: \'bun "$ELANOUS_GRAPH_DIR/run-step.ts" second\'\n  timeout_ms: 120000\n'); }
    },
  } });
  expect(calls).toBe(2);
  expect(result.status).toBe('installed');
  expect(result.errors).toEqual([]);
  expect(result.timings.repair).toEqual(expect.any(Number));
  expect(result.runStatus).toBeUndefined();
});

test('still missing recipe after repair leaves folder and never installs', async () => {
  const root = temp();
  let calls = 0;
  const result = await makePlugin({ request: 'score', name: 'broken', parentDir: join(root, 'plugins-local'), deps: {
    codex: async dir => { calls++; writeFileSync(join(dir, 'graphs', 'broken.yaml'), readFileSync(join(dir, 'graphs', 'broken.yaml'), 'utf8').replace('cmd:main', 'cmd:score')); },
  } });
  expect(calls).toBe(2);
  expect(result.status).toBe('failed');
  expect(result.errors).toContain('recipe score 없음');
  expect(existsSync(result.dir)).toBe(true);
  expect(listInstalledPlugins(root)).toEqual([]);
});

test('src import and widened capabilities cause validation errors', async () => {
  const root = temp();
  const result = await makePlugin({ request: 'unsafe', name: 'unsafe', parentDir: join(root, 'plugins-local'), deps: {
    codex: async dir => {
      writeFileSync(join(dir, 'graphs', 'run-step.ts'), "import bad from '../../../src/secret';\nconsole.log(bad);\n");
      const manifest = join(dir, 'plugin.json');
      writeFileSync(manifest, readFileSync(manifest, 'utf8').replace('"proc:elanous"', '"proc:elanous", "network"'));
    },
  } });
  expect(result.status).toBe('failed');
  expect(result.errors.join('\n')).toContain('src import 금지');
  expect(result.errors.join('\n')).toContain('capabilities');
  expect(await validatePluginDir(result.dir)).toEqual(result.errors);
  expect(listInstalledPlugins(root)).toEqual([]);
});

test('invalid run-step syntax is caught before install and passed to repair', async () => {
  const root = temp();
  let calls = 0;
  const result = await makePlugin({ request: 'syntax', name: 'syntax', parentDir: join(root, 'plugins-local'), deps: {
    codex: async (dir, prompt) => {
      calls++;
      if (calls === 2) expect(prompt).toContain('run-step.ts 문법 오류');
      writeFileSync(join(dir, 'graphs', 'run-step.ts'), 'const broken = ;\n');
    },
  } });
  expect(calls).toBe(2);
  expect(result.status).toBe('failed');
  expect(result.errors.join(' ')).toContain('run-step.ts 문법 오류');
  expect(listInstalledPlugins(root)).toEqual([]);
});

test('manifest top-level capabilities cannot override the fixed extension permissions', async () => {
  const root = temp();
  const result = await makePlugin({ request: 'override', name: 'override', parentDir: join(root, 'plugins-local'), deps: {
    codex: async dir => {
      const file = join(dir, 'plugin.json');
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      manifest.capabilities = ['network'];
      writeFileSync(file, JSON.stringify(manifest));
    },
  } });
  expect(result.status).toBe('failed');
  expect(result.errors.join(' ')).toContain('덮어쓰기 금지');
  expect(listInstalledPlugins(root)).toEqual([]);
});

test('named directory cannot target repository plugins', async () => {
  const root = temp();
  await expect(makePlugin({ request: 'no repo write', name: 'no-repo', parentDir: join(import.meta.dir, '../../../plugins'),
    deps: { codex: async () => { throw new Error('must not invoke codex'); } } })).rejects.toThrow('repository plugins/');
  expect(listInstalledPlugins(root)).toEqual([]);
});

test('symlink parent into repository plugins is rejected before any write or codex call', async () => {
  const root = temp();
  const link = join(root, 'linked-plugins');
  symlinkSync(join(import.meta.dir, '../../../plugins'), link, 'dir');
  let calls = 0;
  await expect(makePlugin({ request: 'no repo write', name: 'link-guard-check', parentDir: link,
    deps: { codex: async () => { calls++; } } })).rejects.toThrow('repository plugins/');
  expect(calls).toBe(0);
  expect(existsSync(join(link, 'link-guard-check'))).toBe(false);
  expect(listInstalledPlugins(root)).toEqual([]);
});

test('unchanged single-node scaffold fails after one repair and never installs', async () => {
  const root = temp();
  let calls = 0;
  const result = await makePlugin({ request: 'unchanged', name: 'unchanged', parentDir: join(root, 'plugins-local'),
    deps: { codex: async (_dir, prompt) => { calls++; if (calls === 2) expect(prompt).toContain('실행 노드는 2개 이상이어야 한다: 1개'); } } });
  expect(calls).toBe(2);
  expect(result.status).toBe('failed');
  expect(result.errors).toContain('실행 노드는 2개 이상이어야 한다: 1개');
  expect(existsSync(result.dir)).toBe(true);
  expect(listInstalledPlugins(root)).toEqual([]);
});

function approvalGraphFixture(): { dir: string; graph: string; recipes: string } {
  const dir = join(temp(), 'image-first-shorts');
  mkdirSync(join(dir, 'graphs'), { recursive: true });
  mkdirSync(join(dir, 'examples'));
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'image-first-shorts', version: '0.1.0',
    extensions: { 'ai.elanous': { graphs: ['./graphs/image-first-shorts.yaml'], capabilities: ['fs:workdir', 'proc:bun', 'proc:elanous'] } } }));
  const graph = join(dir, 'graphs', 'image-first-shorts.yaml');
  const nodes = Array.from({ length: 15 }, (_, i) => ({ node_id: `step${i}`, kind: 'agent', recipe: i < 7 ? `approval:review${i}` : 'cmd:main', max_visits: 1 }));
  const edges = nodes.map((node, i) => ({ from: node.node_id, on: 'outcome', map: { ok: i === 14 ? 'done' : `step${i + 1}`, fail: 'failed' } }));
  writeFileSync(graph, `graph_id: image-first-shorts\nversion: 1\nentry_node: step0\nterminal_nodes: [done, failed]\nnodes:\n${[...nodes, { node_id: 'done', kind: 'gate', recipe: 'none', max_visits: 1 }, { node_id: 'failed', kind: 'gate', recipe: 'none', max_visits: 1 }].map(node => `  - ${JSON.stringify(node)}`).join('\n')}\nedges:\n${edges.map(edge => `  - ${JSON.stringify(edge)}`).join('\n')}\n`);
  const recipes = join(dir, 'graphs', 'recipes.yaml');
  writeFileSync(recipes, `main:\n  command: echo ok\n  timeout_ms: 120000\n${Array.from({ length: 7 }, (_, i) => `review${i}:\n  approval: 'Review step ${i}'\n`).join('')}`);
  writeFileSync(join(dir, 'graphs', 'run-step.ts'), "console.log(JSON.stringify({ outcome: 'ok' }));\n");
  writeFileSync(join(dir, 'examples', 'input.json'), '{}\n');
  return { dir, graph, recipes };
}

test('15 execution nodes including 7 approval-only recipes validate; missing and unsupported recipes are rejected', async () => {
  const { dir, graph, recipes } = approvalGraphFixture();
  expect(await validatePluginDir(dir)).toEqual([]);
  const original = readFileSync(graph, 'utf8');
  writeFileSync(graph, original.replace('approval:review0', 'approval:missing'));
  expect(await validatePluginDir(dir)).toContain('approval recipe missing 없음');
  writeFileSync(graph, original.replace('approval:review0', 'skill:review0'));
  expect(await validatePluginDir(dir)).toContain('지원하지 않는 recipe: skill:review0');
  writeFileSync(graph, original);
  const originalRecipes = readFileSync(recipes, 'utf8');
  writeFileSync(recipes, originalRecipes.replace('Review step 0', '   '));
  expect(await validatePluginDir(dir)).toContain('approval recipe review0 없음');
  expect(await validatePluginDir(dir)).toContain('잘못된 recipe: review0');
  writeFileSync(recipes, originalRecipes.replace("  approval: 'Review step 0'", "  approval: 'Review step 0'\n  command: echo ok"));
  expect(await validatePluginDir(dir)).toEqual([]);
  writeFileSync(graph, original.replace('approval:review0', 'cmd:review0'));
  expect(await validatePluginDir(dir)).toContain('recipe review0 없음');
  const runRoot = join(temp(), 'graph-run');
  await expect(runGraph(graph, { input: {}, deps: { root: runRoot } }))
    .rejects.toThrow('unknown command recipe for step0: cmd:review0');
  writeFileSync(graph, original);
  writeFileSync(recipes, originalRecipes.replace('  timeout_ms: 120000', '  timeout_ms: 0'));
  expect(await validatePluginDir(dir)).toContain('잘못된 recipe: main');
});

test('six execution nodes are accepted', async () => {
  const root = temp();
  const result = await makePlugin({ request: 'upper bound', name: 'upper-bound', parentDir: join(root, 'plugins-local'), deps: {
    codex: async dir => {
      const graph = join(dir, 'graphs', 'upper-bound.yaml');
      const text = readFileSync(graph, 'utf8');
      writeFileSync(graph, text.replace('  - { node_id: done,', Array.from({ length: 5 }, (_, i) => `  - { node_id: extra${i}, kind: agent, recipe: 'cmd:main', max_visits: 1 }`).join('\n') + '\n  - { node_id: done,'));
      writeFileSync(join(dir, 'graphs', 'run-step.ts'), "console.log(JSON.stringify({ outcome: 'ok' }));\n");
    },
  } });
  expect(result.status).toBe('installed');
  expect(result.errors).toEqual([]);
  expect(listInstalledPlugins(root).map(item => item.name)).toEqual(['upper-bound']);
});

test('run failure keeps the installation and returns failed with runStatus', async () => {
  const root = temp();
  const result = await makePlugin({ request: 'error-on-run', name: 'error-on-run', parentDir: join(root, 'plugins-local'), run: true, deps: {
    codex: async dir => { twoNodesFor(dir, 'error-on-run'); }, runGraph: async () => { throw new Error('run unavailable'); },
  } });
  expect(result.status).toBe('failed');
  expect(result.errors).toContain('run unavailable');
  expect(listInstalledPlugins(root).map(item => item.name)).toEqual(['error-on-run']);
});

test('without --run never calls graph runner and leaves runStatus absent', async () => {
  const root = temp();
  let runs = 0;
  const result = await makePlugin({ request: 'local-only', name: 'local-only', parentDir: join(root, 'plugins-local'), deps: {
    codex: async dir => { twoNodesFor(dir, 'local-only'); }, runGraph: async () => { runs++; throw new Error('unexpected run'); },
  } });
  expect(result.status).toBe('installed');
  expect(runs).toBe(0);
  expect(result.runStatus).toBeUndefined();
  expect(result.timings.run).toBeUndefined();
});

test('existing name refuses before codex without overwriting', async () => {
  const root = temp();
  const parent = join(root, 'plugins-local');
  mkdirSync(join(parent, 'taken'), { recursive: true });
  let calls = 0;
  await expect(makePlugin({ request: 'anything', name: 'taken', parentDir: parent, deps: { codex: async () => { calls++; } } })).rejects.toThrow('already exists');
  expect(calls).toBe(0);
});

test('codexWrite leaves no run debris a fresh plugin cannot be installed with', async () => {
  const { chmodSync, existsSync: exists, mkdtempSync: mkd, mkdirSync: mkdir, readdirSync: ls, rmSync: rm, writeFileSync: write } = await import('node:fs');
  const { tmpdir: tmp } = await import('node:os');
  const { join: j } = await import('node:path');
  const { codexWrite } = await import('./plugin-maker.js');
  const root = mkd(j(tmp(), 'codex-debris-'));
  const fake = j(root, 'fake-codex');
  // Stands in for codex: writes the requested file, the -o message, and the debug tree an elanous child leaves in cwd.
  write(fake, `#!/bin/sh
out=""; prev=""; for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
echo done > "$out"; echo node > nodes.yaml
mkdir -p .elanous/debug && echo log > .elanous/debug/debug-1.log && ln -sf "$PWD/.elanous/debug/debug-1.log" .elanous/debug/latest
`);
  chmodSync(fake, 0o755);
  try {
    const fresh = j(root, 'fresh'); mkdir(fresh);
    await codexWrite(fresh, 'write a node', fake);
    expect(ls(fresh).sort()).toEqual(['nodes.yaml']);
    const kept = j(root, 'kept'); mkdir(j(kept, '.elanous'), { recursive: true }); write(j(kept, '.elanous', 'mine.txt'), 'x');
    await codexWrite(kept, 'write a node', fake);
    expect(exists(j(kept, '.elanous', 'mine.txt'))).toBe(true);
  } finally { rm(root, { recursive: true, force: true }); }
});
