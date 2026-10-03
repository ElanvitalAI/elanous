import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validatePluginDir } from './plugin-maker.js';
import { runGraph } from '../../graph-runner/runner.js';
import { generateWizardFiles, type WizardResearchDraft } from './wizard-generate.js';

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
});
