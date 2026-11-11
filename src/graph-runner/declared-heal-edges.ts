import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { GraphTemplateSpec } from '../self-implement/graph-yaml.js';

type HealVocabularyKind = 'heal' | 'retry' | 'detour' | 'append-recheck' | 'accept' | 'escalate';
export interface DeclaredHealEdge {
  kind: HealVocabularyKind;
  edgeRef: string;
  from: string;
  on: readonly string[];
  attempts?: number;
  repair?: Readonly<Record<string, string | { escalate: string }>>;
  via?: string;
  rejoin?: string;
  recheck?: string;
  promote?: { when: readonly string[]; to: string };
  rules?: readonly string[];
  expiry?: string | number;
  ledger?: string;
  elseTo?: string;
  to?: string;
  evidence?: readonly string[];
  exhaustedTo?: string;
}

interface GraphHealManifest {
  readonly edgeVocabulary: readonly string[];
  readonly hitl: readonly string[];
  readonly policy: Readonly<Record<string, unknown>>;
}

export function graphHealManifest(graphFile: string, graphId: string, ownerPath?: string): GraphHealManifest | null {
  const candidates = [...new Set([ownerPath, dirname(graphFile), dirname(dirname(graphFile))].filter((value): value is string => !!value))];
  for (const directory of candidates) {
    const file = join(directory, 'plugin.json');
    if (!existsSync(file)) continue;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const extensions = parsed.extensions as Record<string, unknown> | undefined;
    const extension = extensions?.['ai.elanous'] as Record<string, unknown> | undefined;
    const graphs = extension?.graphs;
    const manifests = extension?.graphManifests as Record<string, unknown> | undefined;
    const entry = manifests?.[graphId] as Record<string, unknown> | undefined;
    if (!Array.isArray(graphs) || !graphs.some((path) => typeof path === 'string' && resolve(directory, path) === graphFile)
      || !entry || !Array.isArray(entry.edgeVocabulary)) continue;
    const policy = entry.policy && typeof entry.policy === 'object' && !Array.isArray(entry.policy)
      ? entry.policy as Record<string, unknown> : {};
    return { edgeVocabulary: entry.edgeVocabulary as string[], hitl: Array.isArray(entry.hitl) ? entry.hitl as string[] : [], policy };
  }
  return null;
}

/** Validate the executable vocabulary before any node runs; legacy graphs without heal_edges are unchanged. */
export function declaredHealEdges(document: Record<string, unknown>, graph: GraphTemplateSpec, manifest: GraphHealManifest | null): readonly DeclaredHealEdge[] {
  if (document.heal_edges === undefined) return [];
  if (!manifest) throw new Error('heal_edges require a plugin graph manifest with edgeVocabulary');
  if (!Array.isArray(document.heal_edges)) throw new Error('heal_edges must be a list');
  const nodes = new Map(graph.nodes.map((node) => [node.nodeId, node]));
  const hitl = new Set(manifest.hitl);
  const policyValue = (value: unknown, at: string): unknown => {
    if (typeof value !== 'string' || !value.startsWith('$policy.')) return value;
    const key = value.slice('$policy.'.length);
    const declared = manifest.policy[key];
    if (!declared || typeof declared !== 'object' || Array.isArray(declared) || !Object.hasOwn(declared, 'default'))
      throw new Error(`${at} references undeclared policy ${key}`);
    return (declared as Record<string, unknown>).default;
  };
  const target = (value: unknown, at: string): string => {
    if (typeof value !== 'string' || !nodes.has(value)) throw new Error(`${at} must name a declared node`);
    return value;
  };
  const words = new Set<HealVocabularyKind>(['heal', 'retry', 'detour', 'append-recheck', 'accept', 'escalate']);
  return document.heal_edges.map((raw, index): DeclaredHealEdge => {
    const edgeRef = `heal_edges/${index}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${edgeRef} must be a map`);
    const row = raw as Record<string, unknown>;
    if (!words.has(row.kind as HealVocabularyKind)) throw new Error(`${edgeRef}/kind is unsupported`);
    const kind = row.kind as HealVocabularyKind;
    if (!manifest.edgeVocabulary.includes(kind)) throw new Error(`${edgeRef}/kind is not declared in the plugin manifest`);
    const from = target(row.from, `${edgeRef}/from`);
    const on = row.on === undefined && (kind === 'append-recheck' || kind === 'accept') ? ['ok'] : row.on;
    if (!Array.isArray(on) || !on.length || on.some((value) => typeof value !== 'string' || !value.trim()))
      throw new Error(`${edgeRef}/on must be a non-empty outcome list`);
    const base: DeclaredHealEdge = { kind, edgeRef, from, on: on as string[] };
    const exhaustedTo = row.escalate === undefined ? ((kind === 'retry' || kind === 'heal' || kind === 'detour') ? target('failed', `${edgeRef}/escalate`) : undefined) : target(row.escalate, `${edgeRef}/escalate`);
    if (exhaustedTo && exhaustedTo !== 'failed' && (!hitl.has(exhaustedTo) || !nodes.get(exhaustedTo)?.recipe.startsWith('approval:')))
      throw new Error(`${edgeRef}/escalate must be a declared HITL approval node or failed`);
    if (kind === 'retry' || kind === 'heal') {
      const attempts = policyValue(row.attempts, `${edgeRef}/attempts`);
      if (!Number.isSafeInteger(attempts) || (attempts as number) < 1)
        throw new Error(`${edgeRef}/attempts must be a positive integer`);
      base.attempts = attempts as number;
      base.exhaustedTo = exhaustedTo;
    }
    if (kind === 'heal') {
      const classify = row.classify && typeof row.classify === 'object' && !Array.isArray(row.classify)
        ? row.classify as Record<string, unknown> : null;
      if (!classify || !Array.isArray(classify.classes) || !classify.classes.length ||
        classify.classes.some((name) => typeof name !== 'string' || !name.trim()))
        throw new Error(`${edgeRef}/classify/classes must list known classes`);
      if (!row.repair || typeof row.repair !== 'object' || Array.isArray(row.repair) || !Object.keys(row.repair).length)
        throw new Error(`${edgeRef}/repair must map classes to declared nodes`);
      base.repair = Object.fromEntries(Object.entries(row.repair as Record<string, unknown>)
        .map(([className, nodeId]) => {
          if (!(classify.classes as string[]).includes(className)) throw new Error(`${edgeRef}/repair/${className} is not a classified outcome`);
          const escalate = nodeId && typeof nodeId === 'object' && !Array.isArray(nodeId)
            ? (nodeId as Record<string, unknown>).escalate : undefined;
          if (escalate !== undefined) {
            const to = target(escalate, `${edgeRef}/repair/${className}/escalate`);
            if (!hitl.has(to) || !nodes.get(to)?.recipe.startsWith('approval:'))
              throw new Error(`${edgeRef}/repair/${className}/escalate must be a declared HITL approval node`);
            return [className, { escalate: to }];
          }
          return [className, target(nodeId, `${edgeRef}/repair/${className}`)];
        }));
    }
    if (kind === 'detour') {
      base.via = target(row.via, `${edgeRef}/via`);
      const rejoin = row.rejoin && typeof row.rejoin === 'object' && !Array.isArray(row.rejoin)
        ? (row.rejoin as Record<string, unknown>).to : undefined;
      base.rejoin = rejoin === 'computed' ? 'computed' : target(rejoin, `${edgeRef}/rejoin/to`);
      base.exhaustedTo = exhaustedTo;
    }
    if (kind === 'append-recheck') {
      base.recheck = target(row.recheck, `${edgeRef}/recheck`);
      const promote = row.promote && typeof row.promote === 'object' && !Array.isArray(row.promote)
        ? row.promote as Record<string, unknown> : null;
      const when = policyValue(promote?.when, `${edgeRef}/promote/when`);
      if (!promote || !Array.isArray(when) || when.some((part) => typeof part !== 'string' || !part.trim()))
        throw new Error(`${edgeRef}/promote/when must be a path pattern list`);
      base.promote = { when: when as string[], to: target(promote.to, `${edgeRef}/promote/to`) };
    }
    if (kind === 'accept') {
      const rules = policyValue(row.rules, `${edgeRef}/rules`);
      const expiry = policyValue(row.expiry, `${edgeRef}/expiry`);
      if (!Array.isArray(rules) || !rules.length || rules.some((rule) => typeof rule !== 'string' || !rule.trim()))
        throw new Error(`${edgeRef}/rules must list accepted rules`);
      if (!(typeof expiry === 'string' && Number.isFinite(Date.parse(expiry)))
        && !(Number.isSafeInteger(expiry) && (expiry as number) > 0))
        throw new Error(`${edgeRef}/expiry must be an ISO date or a positive version count`);
      if (typeof row.ledger !== 'string' || !row.ledger.trim() || row.ledger.startsWith('/') || row.ledger.split('/').includes('..'))
        throw new Error(`${edgeRef}/ledger must be a relative path inside the run root`);
      base.rules = rules as string[];
      base.expiry = expiry as string | number;
      base.ledger = row.ledger;
      base.elseTo = target(row.else, `${edgeRef}/else`);
      if (row.to !== undefined) base.to = target(row.to, `${edgeRef}/to`);
    }
    if (kind === 'escalate') {
      base.to = target(row.to, `${edgeRef}/to`);
      if (!hitl.has(base.to) || !nodes.get(base.to)?.recipe.startsWith('approval:'))
        throw new Error(`${edgeRef}/to must be a declared HITL approval node`);
      if (!Array.isArray(row.evidence) || row.evidence.some((id) => typeof id !== 'string' || !id.trim()))
        throw new Error(`${edgeRef}/evidence must be a list of evidence ids`);
      base.evidence = row.evidence as string[];
    }
    return base;
  });
}
