import { basename, dirname } from 'node:path';
import { isMap, isScalar, isSeq } from 'yaml';
import { readDefinitionYaml } from './yaml.js';
import { lintAgentYaml, type LintEnv } from '../loop-agent/v3/agent-yaml.js';
import { parseGraphTemplateYaml } from '../self-implement/graph-yaml.js';
import { DEFAULT_HOSTS } from '../kit/resource-facts/defaults.js';
import { validateLlmPolicy } from '../policy/llm-policy.js';
import { FEDERATION_API_VERSION, lintFederation } from './federation.js';

export type DefinitionKind = 'agent' | 'graph' | 'policy' | 'federation';
export interface DefinitionIssue { line: number; message: string }
export interface DefinitionResult { kind?: DefinitionKind; value?: unknown; errors: DefinitionIssue[] }
export const AGENT_ROOT_KEYS = ['apiVersion', 'manifest', 'identity', 'supervisor', 'goal', 'policies', 'kpis', 'done_when', 'never_auto', 'soul', 'wake', 'body', 'voice', 'memory', 'subs', 'budget', 'levels', 'hooks', 'actions'] as const;
const agentKeys = new Set<string>(AGENT_ROOT_KEYS);

/** A deliberately fail-closed entry point: unsupported definition types never pass as generic YAML. */
export function loadDefinition(path: string, env: LintEnv = {}): DefinitionResult {
  let parsed: ReturnType<typeof readDefinitionYaml>;
  try { parsed = readDefinitionYaml(path); } catch (e) { return { errors: [{ line: 1, message: String(e) }] }; }
  const { source, lines, doc } = parsed;
  const errors: DefinitionIssue[] = doc.errors.map(e => ({ line: lines.linePos(e.pos[0]).line, message: e.message.split('\n')[0] ?? 'invalid YAML' }));
  if (errors.length) return { errors };
  if (!isMap(doc.contents)) return { errors: [{ line: 1, message: 'definition must be a mapping' }] };
  const raw = doc.toJS() as Record<string, unknown>;
  // LLM policy has no kind tag and version is optional. Accept an explicit policy
  // filename, or structural policy keys when the filename is generic (e.g. definition.yaml).
  const policyFile = /^(?:llm|policy)\.ya?ml$/i.test(basename(path));
  const policyKeys = ['default', 'roles', 'fallback', 'accounts', 'credits', 'caps', 'resetCredits', 'alerts'];
  const looksLikePolicy = policyFile || policyKeys.some(k => Object.hasOwn(raw, k));
  const kind: DefinitionKind | undefined = raw.apiVersion === FEDERATION_API_VERSION ? 'federation' : raw.apiVersion === 'elanous/loop-agent@3' ? 'agent' : typeof raw.graph_id === 'string' ? 'graph' : !Object.hasOwn(raw, 'apiVersion') && looksLikePolicy ? 'policy' : undefined;
  if (!kind) return { errors: [{ line: 1, message: 'unsupported definition kind' }] };
  const locate = (node: unknown): number => {
    const range = (node as { range?: readonly number[] } | null)?.range;
    return range ? lines.linePos(range[0] ?? 0).line : 1;
  };
  const lineFor = (name: string): number => {
    const path = name.split(/[./\[\]: ]/).filter(Boolean);
    let node: unknown = doc.contents;
    let line = 1;
    for (const key of path) {
      if (isSeq(node) && /^\d+$/.test(key)) {
        const item = node.items[Number(key)];
        if (!item) break;
        node = item;
        line = locate(item);
        continue;
      }
      if (!isMap(node)) break;
      const pair = node.items.find(p => isScalar(p.key) && String(p.key.value) === key);
      if (!pair) break;
      line = locate(pair.key);
      node = pair.value;
    }
    return line;
  };
  if (kind === 'agent') for (const pair of doc.contents.items) {
    if (isScalar(pair.key) && typeof pair.key.value === 'string' && !agentKeys.has(pair.key.value))
      errors.push({ line: locate(pair.key), message: `unknown agent key ${pair.key.value}` });
  }
  const visit = (node: unknown): void => {
    if (isScalar(node) && typeof node.value === 'string' && DEFAULT_HOSTS.some(({ host }) => host.toLowerCase() === (node.value as string).toLowerCase()))
      errors.push({ line: locate(node), message: 'literal host name is not portable' });
    if (isMap(node)) for (const pair of node.items) { visit(pair.key); visit(pair.value); }
    if (isSeq(node)) for (const item of node.items) visit(item);
  };
  visit(doc.contents);
  if (kind === 'federation') {
    errors.push(...lintFederation(raw).map(issue => ({ line: lineFor(issue.path), message: issue.message })));
    return { kind, value: errors.length ? undefined : raw, errors };
  }
  if (kind === 'agent') {
    const result = lintAgentYaml(source, dirname(path), env);
    errors.push(...result.errors.map(message => ({ line: lineFor(message), message })));
    return { kind, value: errors.length ? undefined : result.compiled, errors };
  }
  if (kind === 'policy') {
    const result = validateLlmPolicy(raw);
    for (const message of result.errors) {
      const field = message.match(/(?:^|field )policy(?:\.([^ ]+))?/)?.[1];
      errors.push({ line: field ? lineFor(field) : 1, message });
    }
    return { kind, value: errors.length ? undefined : raw, errors };
  }
  const result = parseGraphTemplateYaml(source, path);
  errors.push(...result.errors.map(e => ({ line: lineFor(e.path.slice(path.length + 1)), message: e.message })));
  return { kind, value: errors.length ? undefined : result.template, errors };
}
