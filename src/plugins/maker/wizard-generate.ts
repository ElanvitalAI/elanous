import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** Research is descriptive. Credential values are never an input to the generator. */
export interface WizardResearchDraft {
  description: string;
  connectors?: Array<{
    id: string;
    credentials?: Array<{ name: string }>;
  }>;
  skill?: { description: string; instructions: string; requires?: string[] };
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,31}$/;
const FIELD = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/** Materialize a research draft; its graph steps fail until the requested processing is implemented. */
export function generateWizardFiles(dir: string, slug: string, draft: WizardResearchDraft): string[] {
  if (!SLUG.test(slug)) throw new Error(`invalid wizard plugin name: ${slug}`);
  if (!draft || typeof draft.description !== 'string' || !draft.description.trim()) throw new Error('wizard description is required');
  if (draft.connectors !== undefined && !Array.isArray(draft.connectors)) throw new Error('invalid wizard connectors');
  const connectors = (draft.connectors ?? []).map(connector => {
    if (!connector || typeof connector !== 'object' || Object.keys(connector).some(key => key !== 'id' && key !== 'credentials') ||
      !SLUG.test(connector.id) || (connector.credentials !== undefined && !Array.isArray(connector.credentials))) {
      throw new Error('wizard connectors must contain ids and credential names only');
    }
    const names = (connector.credentials ?? []).map(credential => {
      if (!credential || typeof credential !== 'object' || !FIELD.test(credential.name) || Object.keys(credential).some(key => key !== 'name')) {
        throw new Error('wizard credentials must contain names only');
      }
      return credential.name;
    });
    if (new Set(names).size !== names.length) throw new Error(`duplicate wizard credential name: ${connector.id}`);
    return { id: connector.id, fields: names.map(name => ({ name, secret: true })) };
  });
  if (new Set(connectors.map(connector => connector.id)).size !== connectors.length) throw new Error('duplicate wizard connector id');
  if (draft.skill && (typeof draft.skill.description !== 'string' || typeof draft.skill.instructions !== 'string')) {
    throw new Error('invalid wizard skill');
  }
  const catalog = parseYaml(readFileSync(join(import.meta.dir, '../../../catalog/resources.yaml'), 'utf8')) as {
    resources: Array<{ id: string }>;
  };
  const knownResources = new Set(catalog.resources.map(resource => resource.id));
  const requires = draft.skill?.requires ?? [];
  if (!Array.isArray(requires) || requires.some(resource => typeof resource !== 'string' || !knownResources.has(resource))) {
    throw new Error('wizard requires must reference existing resource ids');
  }
  const manifestPath = join(dir, 'plugin.json');
  const existing = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    name: string; extensions: { 'ai.elanous': { connectors?: unknown[]; graphs?: string[]; researchDraft?: boolean } };
  } : undefined;
  if (existing && (existing.name !== slug || !existing.extensions?.['ai.elanous'])) {
    throw new Error('wizard scaffold name or extension mismatch');
  }
  if (existsSync(join(dir, `skills/${slug}/SKILL.md`))) {
    throw new Error(`wizard file already exists: skills/${slug}/SKILL.md`);
  }
  const scaffoldConnectors = existing?.extensions['ai.elanous'].connectors;
  if (scaffoldConnectors !== undefined && (!Array.isArray(scaffoldConnectors) || scaffoldConnectors.length > 0)) {
    throw new Error('wizard cannot replace existing scaffold connectors');
  }
  const manifest = existing ?? { name: slug, version: '0.1.0', description: draft.description,
    extensions: { 'ai.elanous': { graphs: [`./graphs/${slug}.yaml`],
      capabilities: ['fs:workdir', 'proc:bun', 'proc:elanous'], connectors: [] as unknown[], researchDraft: true } } };
  manifest.extensions['ai.elanous'].connectors = connectors;
  manifest.extensions['ai.elanous'].researchDraft = true;

  const files: Array<[string, string]> = [
    ['plugin.json', JSON.stringify(manifest, null, 2) + '\n'],
    [`graphs/${slug}.yaml`, stringifyYaml({ graph_id: slug, version: 1, entry_node: 'prepare', terminal_nodes: ['done', 'failed'],
      nodes: [
        { node_id: 'prepare', kind: 'agent', recipe: 'cmd:prepare', max_visits: 1 },
        { node_id: 'summarize', kind: 'agent', recipe: 'cmd:summarize', max_visits: 1 },
        { node_id: 'done', kind: 'gate', recipe: 'none', max_visits: 1 },
        { node_id: 'failed', kind: 'gate', recipe: 'none', max_visits: 1 },
      ], edges: [
        { from: 'prepare', on: 'outcome', map: { ok: 'summarize', fail: 'failed' } },
        { from: 'summarize', on: 'outcome', map: { ok: 'done', fail: 'failed' } },
      ] })],
    ['graphs/recipes.yaml', stringifyYaml({ prepare: { command: 'bun "$ELANOUS_GRAPH_DIR/run-step.ts" prepare', timeout_ms: 120000 },
      summarize: { command: 'bun "$ELANOUS_GRAPH_DIR/run-step.ts" summarize', timeout_ms: 120000 } })],
    ['graphs/run-step.ts', `const step = process.argv[2];
console.log(JSON.stringify({ outcome: 'fail', error: step === 'prepare' || step === 'summarize'
  ? 'Research draft only: implement the requested processing before running this graph.'
  : 'unknown step' }));
process.exitCode = 1;
`],
    ['examples/input.json', '{}\n'],
    ['README.md', `# ${slug}\n\n${draft.description}\n\nResearch draft only. Connector declarations contain credential names, not values. The graph cannot perform the requested processing yet: implement and validate its steps, then remove extensions["ai.elanous"].researchDraft from plugin.json before installing or running it. No messages are sent.\n`],
    [`skills/${slug}/SKILL.md`, `---\n${stringifyYaml({ name: slug, description: draft.skill?.description ?? draft.description, requires: [...new Set(requires)] })}---\n\n${draft.skill?.instructions ?? draft.description}\n`],
  ];
  const generated = existing ? files.filter(([path]) => path === 'plugin.json' || path.startsWith('skills/')) : files;
  for (const [path] of generated) {
    if (path !== 'plugin.json' && existsSync(join(dir, path))) throw new Error(`wizard file already exists: ${path}`);
  }
  for (const [path, content] of generated) {
    const target = join(dir, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content, { flag: path === 'plugin.json' && existing ? 'w' : 'wx' });
  }
  return generated.map(([path]) => path);
}
