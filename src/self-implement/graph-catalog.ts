import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { GraphNodeKind, GraphTemplateSpec } from './graph-yaml.js';

export interface NodeCatalogRole {
  readonly kind: GraphNodeKind;
  readonly outcomes: readonly string[];
  readonly spawn: string;
  readonly grain: string;
  readonly effects: string;
}

export interface NodeCatalog {
  readonly roles: Map<string, NodeCatalogRole>;
  readonly kinds: string[];
}

/** Catalog location follows this repository's source, not the caller's working directory. */
export function loadNodeCatalog(path = join(import.meta.dir, '../../graphs/catalog/catalog.yaml')): NodeCatalog {
  const doc = parseYaml(readFileSync(path, 'utf8')) as {
    kinds: { existing: string[]; proposed: Record<string, string> };
    roles: Array<{ role: string; kind: GraphNodeKind; outcomes: string[]; spawn: string; grain: string; effects: string }>;
  };
  return {
    roles: new Map(doc.roles.map(({ role, kind, outcomes, spawn, grain, effects }) =>
      [role, { kind, outcomes, spawn, grain, effects }])),
    kinds: [...doc.kinds.existing, ...Object.keys(doc.kinds.proposed)],
  };
}

export interface RecipeCatalogIssue {
  readonly nodeId: string;
  readonly recipe: string;
  readonly problem: 'unknown-role' | 'kind-mismatch';
}

/** Declaration-only inspection: existing recipes are reported, never rejected at execution time. */
export function inspectRecipesAgainstCatalog(template: GraphTemplateSpec, catalog: NodeCatalog): RecipeCatalogIssue[] {
  const issues: RecipeCatalogIssue[] = [];
  for (const { nodeId, kind, recipe } of template.nodes) {
    if (recipe === 'none' || recipe.startsWith('cmd:') || recipe.startsWith('approval:') || recipe.startsWith('wf:')) continue;
    const role = catalog.roles.get(recipe);
    if (!role) issues.push({ nodeId, recipe, problem: 'unknown-role' });
    else if (kind !== role.kind) issues.push({ nodeId, recipe, problem: 'kind-mismatch' });
  }
  return issues;
}
