import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { parse, stringify } from 'yaml';

/**
 * Writes an explicitly declared, isolated release graph fixture. Release-loop tests
 * must exercise the same fail-closed manifest contract as production runs.
 */
export function writeReleaseGraphFixture(graphPath: string, source: string, variants: readonly string[] = [], options: {
  extraRecipes?: readonly string[];
} = {}): {
  template: string;
  variants: string[];
} {
  const directory = dirname(graphPath);
  mkdirSync(directory, { recursive: true });
  const document = parse(source) as Record<string, any>;
  if (document.graph_id !== 'release-loop') throw new Error('release graph fixture requires graph_id: release-loop');
  document.loop ??= {};
  document.loop.trigger ??= {};
  document.loop.trigger.events ??= [];
  document.edges ??= [];
  const template = stringify(document);
  writeFileSync(graphPath, template);

  const variantPaths = variants.map((variant, index) => {
    const path = join(directory, `${basename(graphPath, '.yaml')}.variant-${index + 1}.yaml`);
    const variantDocument = parse(variant) as Record<string, any>;
    if (variantDocument.graph_id !== 'release-loop') throw new Error('release graph variant requires graph_id: release-loop');
    variantDocument.loop ??= {};
    variantDocument.loop.trigger ??= {};
    variantDocument.loop.trigger.events ??= document.loop.trigger.events;
    variantDocument.edges ??= [];
    const normalized = stringify(variantDocument);
    writeFileSync(path, normalized);
    return { path, source: normalized, document: variantDocument };
  });
  const allDocuments = [document, ...variantPaths.map(({ document: item }) => item)];
  const terminalNodes = document.terminal_nodes as string[];
  const recipes = [...new Set([...(options.extraRecipes ?? []), ...allDocuments.flatMap((item) =>
    (item.nodes as Array<{ recipe?: string }>).flatMap(({ recipe }) => {
      if (!recipe || recipe === 'none') return [];
      const separator = recipe.indexOf(':');
      return separator < 0 ? [] : [recipe.slice(separator + 1)];
    }))])];
  const hitl = [...new Set(allDocuments.flatMap((item) =>
    (item.nodes as Array<{ node_id: string; kind: string }>).filter(({ kind }) => kind === 'hitl').map(({ node_id }) => node_id)))];
  const graphEntries = [basename(graphPath), ...variantPaths.map(({ path }) => basename(path))];
  const inputs = document.loop.trigger.events as string[];
  const terminal = Object.fromEntries(terminalNodes.map((node, index) => [node, index === 0 ? 'success' : 'failure']));
  writeFileSync(join(directory, 'release-graph.schema.yaml'), stringify({
    apiVersion: 'elanous.dev/release-graph-schema/v1', graphId: 'release-loop',
    requiredGraphFields: ['graph_id', 'version', 'entry_node', 'terminal_nodes', 'nodes', 'edges'],
    nodeKinds: ['git', 'gate', 'judge', 'agent', 'hitl', 'subgraph'],
    edgeTriggers: ['outcome'], terminalStates: terminalNodes, recipePrefixes: ['cmd', 'approval'],
  }));
  writeFileSync(join(directory, 'release-edge-vocabulary.yaml'), 'edges: {}\n');
  writeFileSync(join(directory, 'plugin.json'), JSON.stringify({ name: 'release-loop-fixture', version: '1.0.0', extensions: {
    'ai.elanous': {
      identity: 'elanous.test-release-loop', inputs, graphs: graphEntries,
      graphSchema: './release-graph.schema.yaml', edgeVocabulary: './release-edge-vocabulary.yaml', domainPackFiles: [],
      graphManifests: { 'release-loop': { purpose: 'Isolated release graph runner test fixture.', allow: {
        recipes, skills: [], domainPacks: [],
      }, policy: {}, hitl, terminal, observe: { categories: [] } } },
    },
  } }, null, 2) + '\n');
  return { template, variants: variantPaths.map(({ source: variant }) => variant) };
}
