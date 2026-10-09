import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
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
export function generateWizardFiles(dir: string, slug: string, draft: WizardResearchDraft, options: { regenerate?: boolean } = {}): string[] {
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
    name: string; description?: string; extensions: { 'ai.elanous': { connectors?: unknown[]; graphs?: string[]; researchDraft?: boolean } };
  } : undefined;
  if (existing && (existing.name !== slug || !existing.extensions?.['ai.elanous'])) {
    throw new Error('wizard scaffold name or extension mismatch');
  }
  const skillPath = join(dir, `skills/${slug}/SKILL.md`);
  const readmePath = join(dir, 'README.md');
  const wizardReadme = options.regenerate && existsSync(readmePath) &&
    readFileSync(readmePath, 'utf8').includes('Research draft only. Connector declarations contain credential names, not values.');
  if (options.regenerate) {
    if (!existing || existing.extensions['ai.elanous'].researchDraft !== true || !existsSync(skillPath)) {
      throw new Error('wizard regeneration requires an existing research draft');
    }
  } else if (existsSync(skillPath)) {
    throw new Error(`wizard file already exists: skills/${slug}/SKILL.md`);
  }
  const scaffoldConnectors = existing?.extensions['ai.elanous'].connectors;
  if (!options.regenerate && scaffoldConnectors !== undefined && (!Array.isArray(scaffoldConnectors) || scaffoldConnectors.length > 0)) {
    throw new Error('wizard cannot replace existing scaffold connectors');
  }
  const manifest = existing ?? { name: slug, version: '0.1.0', description: draft.description,
    extensions: { 'ai.elanous': { graphs: [`./graphs/${slug}.yaml`],
      capabilities: ['fs:workdir', 'proc:bun', 'proc:elanous'], connectors: [] as unknown[], researchDraft: true } } };
  if (options.regenerate) manifest.description = draft.description;
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
  const generated = existing ? files.filter(([path]) => path === 'plugin.json' || path.startsWith('skills/') ||
    (options.regenerate && wizardReadme && path === 'README.md')) : files;
  for (const [path] of generated) {
    if (path !== 'plugin.json' && !(options.regenerate && (path === 'README.md' || path.startsWith('skills/'))) && existsSync(join(dir, path))) {
      throw new Error(`wizard file already exists: ${path}`);
    }
  }
  for (const [path, content] of generated) {
    const target = join(dir, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content, { flag: existing && (path === 'plugin.json' || options.regenerate) ? 'w' : 'wx' });
  }
  return generated.map(([path]) => path);
}

/** Browser wizard drafts are stored outside the install ledger. Only wizard-owned directories are listed. */
export function listWizardDrafts(parent: string): Array<{ name: string; description: string; draft: WizardResearchDraft }> {
  if (!existsSync(parent)) return [];
  return readdirSync(parent, { withFileTypes: true }).filter(entry => entry.isDirectory() && SLUG.test(entry.name)).flatMap(entry => {
    const dir = join(parent, entry.name);
    try {
      const manifestPath = join(dir, 'plugin.json');
      const skillDir = join(dir, 'skills', entry.name);
      const skillPath = join(skillDir, 'SKILL.md');
      if (lstatSync(manifestPath).isSymbolicLink() || lstatSync(skillDir).isSymbolicLink() || lstatSync(skillPath).isSymbolicLink()) return [];
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: string; description?: string; extensions?: { 'ai.elanous'?: { researchDraft?: boolean; connectors?: Array<{ id: string; fields: Array<{ name: string }> }> } } };
      if (manifest.name !== entry.name || manifest.extensions?.['ai.elanous']?.researchDraft !== true) return [];
      const skill = readFileSync(skillPath, 'utf8');
      const parts = /^---\n([\s\S]*?)---\n\n([\s\S]*)$/.exec(skill);
      if (!parts || typeof manifest.description !== 'string') return [];
      const meta = parseYaml(parts[1]!) as { description?: string; requires?: string[] };
      return [{ name: entry.name, description: manifest.description, draft: {
        description: manifest.description,
        connectors: manifest.extensions['ai.elanous'].connectors?.map(connector => ({ id: connector.id, credentials: connector.fields.map(field => ({ name: field.name })) })) ?? [],
        skill: { description: meta.description ?? manifest.description, instructions: parts[2]!.trimEnd(), requires: meta.requires ?? [] },
      } }];
    } catch { return []; }
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function saveWizardDraft(parent: string, slug: string, draft: WizardResearchDraft, regenerate = false): string[] {
  if (!SLUG.test(slug)) throw new Error(`invalid wizard plugin name: ${slug}`);
  const requested = resolve(parent);
  if (existsSync(requested) && lstatSync(requested).isSymbolicLink()) throw new Error('wizard parent cannot be a symlink');
  // Ancestors may be symlinks (macOS /var -> /private/var); compare the draft directory against the real parent.
  const base = existsSync(requested) ? realpathSync(requested) : requested;
  const dir = resolve(base, slug);
  if (!dir.startsWith(`${base}${sep}`)) throw new Error('invalid wizard directory');
  if (existsSync(dir) && (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory() || realpathSync(dir) !== dir)) {
    throw new Error('wizard directory must be a local directory');
  }
  if (regenerate && existsSync(join(dir, 'skills')) && lstatSync(join(dir, 'skills')).isSymbolicLink()) {
    throw new Error('wizard skills cannot be a symlink');
  }
  if (!regenerate && existsSync(dir)) throw new Error('wizard directory already exists');
  if (regenerate && existsSync(join(dir, 'skills', slug)) && lstatSync(join(dir, 'skills', slug)).isSymbolicLink()) {
    throw new Error('wizard skills cannot be a symlink');
  }
  if (regenerate && ['plugin.json', 'README.md', `skills/${slug}/SKILL.md`].some(file => {
    const path = join(dir, file);
    return existsSync(path) && lstatSync(path).isSymbolicLink();
  })) throw new Error('wizard regeneration cannot follow symlinks');
  if (!existsSync(base) && !regenerate) mkdirSync(base, { recursive: true });
  return generateWizardFiles(dir, slug, draft, { regenerate });
}
