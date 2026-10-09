import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, readdirSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validatePluginDir } from './plugin-maker.js';
import { runGraph } from '../../graph-runner/runner.js';
import { generateWizardFiles, listWizardDrafts, saveWizardDraft, type WizardResearchDraft } from './wizard-generate.js';

const roots: string[] = [];
function temp(): string {
  const root = mkdtempSync(join(tmpdir(), 'wizard-generate-'));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const draft: WizardResearchDraft = {
  description: 'Research the weather and summarize it.',
  connectors: [{ id: 'weather', credentials: [{ name: 'WEATHER_API_KEY' }] }],
  skill: { description: 'Weather researcher', instructions: 'Read the forecast before answering.', requires: ['openai'] },
};

test('research draft writes structurally valid files, declared secret names only, and existing requires', async () => {
  const dir = temp();
  const files = generateWizardFiles(dir, 'weather-research', draft);
  expect(files).toContain('skills/weather-research/SKILL.md');
  expect(await validatePluginDir(dir)).toEqual([]);
  const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
  expect(manifest.extensions['ai.elanous'].connectors).toEqual([{
    id: 'weather', fields: [{ name: 'WEATHER_API_KEY', secret: true }],
  }]);
  expect(manifest.extensions['ai.elanous'].researchDraft).toBe(true);
  const skill = readFileSync(join(dir, 'skills/weather-research/SKILL.md'), 'utf8');
  expect(parseYaml(skill.split('---')[1]!)).toMatchObject({ name: 'weather-research', requires: ['openai'] });
  expect(skill).toContain('Read the forecast before answering.');
  expect(readdirSync(dir).sort()).toEqual(['README.md', 'examples', 'graphs', 'plugin.json', 'skills']);
});

test('generated research graph steps fail explicitly until requested processing is implemented', () => {
  const dir = temp();
  generateWizardFiles(dir, 'weather-research', draft);
  for (const step of ['prepare', 'summarize']) {
    const result = Bun.spawnSync([process.execPath, join(dir, 'graphs/run-step.ts'), step], { cwd: dir });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.stdout.toString())).toEqual({ outcome: 'fail',
      error: 'Research draft only: implement the requested processing before running this graph.' });
  }
});

test('generated research draft reaches the real graph failed terminal, never done', async () => {
  const dir = temp();
  generateWizardFiles(dir, 'weather-research', draft);
  const state = await runGraph(join(dir, 'graphs/weather-research.yaml'), {
    input: { city: 'Seoul' }, deps: { root: join(dir, 'state') },
  });
  expect(state.status).toBe('failed');
  expect(state.path).toEqual(['prepare', 'failed']);
  expect(state.nodes[0]?.ok).toBe(false);
  expect(state.nodes[0]?.exit).toBe(1);
});

test('unknown requires and credential values are rejected before writing files', () => {
  const dir = temp();
  expect(() => generateWizardFiles(dir, 'weather-research', { ...draft,
    skill: { ...draft.skill!, requires: ['invented-resource'] },
  })).toThrow('existing resource ids');
  expect(readdirSync(dir)).toEqual([]);
  expect(() => generateWizardFiles(dir, 'weather-research', { ...draft,
    connectors: [{ id: 'weather', credentials: [{ name: 'WEATHER_API_KEY', value: 'secret-value' }] }],
  } as unknown as WizardResearchDraft)).toThrow('names only');
  expect(readdirSync(dir)).toEqual([]);
  expect(() => generateWizardFiles(dir, 'weather-research', { ...draft,
    connectors: [{ id: 'weather', url: 'https://user:secret@example.com', credentials: [{ name: 'WEATHER_API_KEY' }] }],
  } as unknown as WizardResearchDraft)).toThrow('ids and credential names only');
  expect(readdirSync(dir)).toEqual([]);
});

test('refuses to replace existing scaffold connectors without changing files', () => {
  const dir = temp();
  mkdirSync(join(dir, 'graphs'));
  const graph = join(dir, 'graphs/weather-research.yaml');
  writeFileSync(graph, 'original graph\n');
  const manifestPath = join(dir, 'plugin.json');
  const manifest = JSON.stringify({ name: 'weather-research', version: '0.1.0',
    extensions: { 'ai.elanous': { graphs: ['./graphs/weather-research.yaml'],
      connectors: [{ id: 'existing', fields: [{ name: 'EXISTING_TOKEN', secret: true }] }] } } }, null, 2) + '\n';
  writeFileSync(manifestPath, manifest);

  expect(() => generateWizardFiles(dir, 'weather-research', draft)).toThrow('existing scaffold connectors');
  expect(readFileSync(manifestPath, 'utf8')).toBe(manifest);
  expect(readFileSync(graph, 'utf8')).toBe('original graph\n');
  expect(readdirSync(dir).sort()).toEqual(['graphs', 'plugin.json']);
});

test('explicit regeneration updates only wizard-owned text and preserves the graph', async () => {
  const dir = temp();
  generateWizardFiles(dir, 'weather-research', draft);
  const graph = readFileSync(join(dir, 'graphs/weather-research.yaml'), 'utf8');
  const recipe = readFileSync(join(dir, 'graphs/recipes.yaml'), 'utf8');
  const files = generateWizardFiles(dir, 'weather-research', {
    description: 'Summarize tomorrow’s forecast.',
    connectors: [{ id: 'forecast', credentials: [{ name: 'FORECAST_TOKEN' }] }],
    skill: { description: 'Forecast summary', instructions: 'Summarize tomorrow.', requires: [] },
  }, { regenerate: true });
  expect(files).toEqual(['plugin.json', 'README.md', 'skills/weather-research/SKILL.md']);
  expect(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')).description).toBe('Summarize tomorrow’s forecast.');
  expect(readFileSync(join(dir, 'skills/weather-research/SKILL.md'), 'utf8')).toContain('Summarize tomorrow.');
  expect(readFileSync(join(dir, 'graphs/weather-research.yaml'), 'utf8')).toBe(graph);
  expect(readFileSync(join(dir, 'graphs/recipes.yaml'), 'utf8')).toBe(recipe);
  expect(await validatePluginDir(dir)).toEqual([]);
  expect(() => generateWizardFiles(dir, 'weather-research', draft)).toThrow('already exists');
  expect(() => generateWizardFiles(dir, 'weather-research', { ...draft,
    connectors: [{ id: 'forecast', credentials: [{ name: 'TOKEN', value: 'secret' }] }],
  } as unknown as WizardResearchDraft, { regenerate: true })).toThrow('names only');
  expect(readFileSync(join(dir, 'graphs/weather-research.yaml'), 'utf8')).toBe(graph);
});

test('regeneration refuses non-wizard scaffold without changing it', () => {
  const dir = temp();
  mkdirSync(dir, { recursive: true });
  const manifest = JSON.stringify({ name: 'weather-research', extensions: { 'ai.elanous': { connectors: [] } } });
  writeFileSync(join(dir, 'plugin.json'), manifest);
  expect(() => generateWizardFiles(dir, 'weather-research', draft, { regenerate: true })).toThrow('existing research draft');
  expect(readFileSync(join(dir, 'plugin.json'), 'utf8')).toBe(manifest);
});

test('regeneration leaves user-owned README intact after generation', () => {
  const dir = temp();
  generateWizardFiles(dir, 'weather-research', draft);
  const path = join(dir, 'README.md');
  writeFileSync(path, 'Custom documentation\n');
  expect(generateWizardFiles(dir, 'weather-research', { ...draft, description: 'Revised' }, { regenerate: true }))
    .toEqual(['plugin.json', 'skills/weather-research/SKILL.md']);
  expect(readFileSync(path, 'utf8')).toBe('Custom documentation\n');
});

test('wizard draft inventory survives reload and regeneration without touching the install ledger', () => {
  const parent = temp();
  expect(listWizardDrafts(parent)).toEqual([]);
  saveWizardDraft(parent, 'weather-research', draft);
  expect(listWizardDrafts(parent)).toEqual([{ name: 'weather-research', description: draft.description, draft }]);
  expect(() => saveWizardDraft(parent, 'weather-research', draft)).toThrow('already exists');
  saveWizardDraft(parent, 'weather-research', { ...draft, description: 'Tomorrow weather.' }, true);
  expect(listWizardDrafts(parent)[0]?.description).toBe('Tomorrow weather.');
  expect(readdirSync(parent)).toEqual(['weather-research']);
  expect(() => saveWizardDraft(parent, '../escape', draft)).toThrow('invalid wizard plugin name');
});

test('browser wizard rejects a symlinked draft directory without touching the target', () => {
  const parent = temp();
  const outside = temp();
  writeFileSync(join(outside, 'sentinel'), 'unchanged');
  symlinkSync(outside, join(parent, 'weather-research'));
  expect(() => saveWizardDraft(parent, 'weather-research', draft, true)).toThrow('local directory');
  expect(readFileSync(join(outside, 'sentinel'), 'utf8')).toBe('unchanged');
});

test('adds research files to an existing maker scaffold without replacing its graph', () => {
  const dir = temp();
  mkdirSync(join(dir, 'graphs'));
  writeFileSync(join(dir, 'graphs/weather-research.yaml'), 'original graph\n');
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ name: 'weather-research', version: '0.1.0',
    extensions: { 'ai.elanous': { graphs: ['./graphs/weather-research.yaml'], capabilities: ['fs:workdir', 'proc:bun', 'proc:elanous'] } } }));
  expect(generateWizardFiles(dir, 'weather-research', draft)).toEqual(['plugin.json', 'skills/weather-research/SKILL.md']);
  expect(readFileSync(join(dir, 'graphs/weather-research.yaml'), 'utf8')).toBe('original graph\n');
  const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'));
  expect(manifest.extensions['ai.elanous'].connectors)
    .toEqual([{ id: 'weather', fields: [{ name: 'WEATHER_API_KEY', secret: true }] }]);
  expect(manifest.extensions['ai.elanous'].researchDraft).toBe(true);
  expect(() => generateWizardFiles(dir, 'weather-research', draft)).toThrow('already exists');
  expect(generateWizardFiles(dir, 'weather-research', { ...draft, description: 'Revised scaffold draft' }, { regenerate: true }))
    .toEqual(['plugin.json', 'skills/weather-research/SKILL.md']);
  expect(readFileSync(join(dir, 'graphs/weather-research.yaml'), 'utf8')).toBe('original graph\n');
  expect(JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')).description).toBe('Revised scaffold draft');
});
