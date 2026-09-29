import { isMap, isScalar, isSeq, parseDocument, type Document, type Scalar, YAMLMap, YAMLSeq } from 'yaml';

/** Fallback kinds when the graph vocabulary service is unavailable. */
export const CORE_GRAPH_KINDS = ['agent', 'gate', 'git', 'judge', 'observe', 'hitl', 'subgraph'] as const;
export const CORE_WORKFLOW_KINDS = ['prompt', 'bash', 'skill', 'cft', 'approval', 'if', 'switch', 'iteration', 'classify', 'extract', 'set', 'filter', 'template', 'http', 'showroom', 'task', 'scheduleTrigger', 'webhookTrigger', 'discordTrigger', 'telegramTrigger', 'manualTrigger', 'chatTrigger'] as const;

export interface RunGraphNodeEdit {
  nodeId: string;
  kind: string;
  recipe: string;
}

export interface RunGraphEdgeEdit {
  from: string;
  outcome: string;
  to: string;
}

function rootMap(doc: Document): YAMLMap | null {
  return isMap(doc.contents) ? doc.contents : null;
}

function scalarNode(value: unknown): Scalar | null {
  return isScalar(value) ? value : null;
}

function keyText(key: unknown): string | undefined {
  const node = scalarNode(key);
  return node && (typeof node.value === 'string' || typeof node.value === 'number') ? String(node.value) : undefined;
}

function pair(map: YAMLMap, key: string): YAMLMap['items'][number] | undefined {
  return map.items.find((item) => keyText(item.key) === key);
}

function seqOf(map: YAMLMap, key: string): YAMLSeq | null {
  const value = pair(map, key)?.value;
  return isSeq(value) ? value : null;
}

function mapOf(node: unknown): YAMLMap | null {
  return isMap(node) ? node : null;
}

function scalar(map: YAMLMap, key: string): string | undefined {
  const value = scalarNode(pair(map, key)?.value);
  return value && (typeof value.value === 'string' || typeof value.value === 'number') ? String(value.value) : undefined;
}

function nodeMaps(doc: Document): YAMLMap[] {
  const nodes = rootMap(doc);
  if (!nodes) return [];
  const seq = seqOf(nodes, 'nodes');
  return seq ? seq.items.flatMap((item) => { const map = mapOf(item); return map ? [map] : []; }) : [];
}

function findNode(doc: Document, nodeId: string): YAMLMap | undefined {
  return nodeMaps(doc).find((node) => scalar(node, 'node_id') === nodeId);
}

function setScalar(map: YAMLMap, key: string, value: string): void {
  const existing = scalarNode(pair(map, key)?.value);
  if (existing) {
    existing.value = value;
    return;
  }
  map.set(key, value);
}

type TrackedDocument = Document & { src: string; removed: Array<[number, number]> };

/** Read with parseDocument so later edits touch the document tree, not a regenerated string. */
export function readRunGraphYaml(text: string): Document {
  const doc = parseDocument(text, { keepSourceTokens: true }) as TrackedDocument;
  doc.src = text;
  doc.removed = [];
  return doc;
}

function removedOf(doc: Document): Array<[number, number]> {
  return (doc as TrackedDocument).removed ?? [];
}

export function addRunGraphNode(doc: Document, node: RunGraphNodeEdit & { maxVisits?: number }): void {
  const root = rootMap(doc);
  if (!root) throw new Error('graph yaml root is not a map');
  let seq = seqOf(root, 'nodes');
  if (!seq) {
    root.set('nodes', []);
    seq = seqOf(root, 'nodes');
  }
  if (!seq) throw new Error('nodes is not a sequence');
  if (findNode(doc, node.nodeId)) throw new Error(`node already exists: ${node.nodeId}`);
  const created = new YAMLMap();
  created.set('node_id', node.nodeId);
  created.set('kind', node.kind);
  created.set('recipe', node.recipe);
  created.set('max_visits', node.maxVisits ?? 1);
  seq.add(created);
}

export function removeRunGraphNode(doc: Document, nodeId: string): void {
  const root = rootMap(doc);
  const seq = root ? seqOf(root, 'nodes') : null;
  if (!seq) return;
  const index = seq.items.findIndex((item) => { const map = mapOf(item); return map ? scalar(map, 'node_id') === nodeId : false; });
  if (index >= 0) {
    rememberRemoval(doc, seq.items[index]);
    seq.delete(index);
  }
}

export function setRunGraphNodeKind(doc: Document, nodeId: string, kind: string): void {
  const node = findNode(doc, nodeId);
  if (!node) throw new Error(`node not found: ${nodeId}`);
  setScalar(node, 'kind', kind);
}

export function setRunGraphNodeRecipe(doc: Document, nodeId: string, recipe: string): void {
  const node = findNode(doc, nodeId);
  if (!node) throw new Error(`node not found: ${nodeId}`);
  setScalar(node, 'recipe', recipe);
}

function edgeMaps(doc: Document): YAMLMap[] {
  const root = rootMap(doc);
  const seq = root ? seqOf(root, 'edges') : null;
  return seq ? seq.items.flatMap((item) => { const map = mapOf(item); return map ? [map] : []; }) : [];
}

function ensureMap(edge: YAMLMap): YAMLMap {
  const existing = pair(edge, 'map')?.value;
  if (isMap(existing)) return existing;
  const created = new YAMLMap();
  edge.set('map', created);
  return created;
}

/** Add one `map` entry on the edge that already leaves `from`. Creates that edge when absent. */
export function addRunGraphEdge(doc: Document, edge: RunGraphEdgeEdit): void {
  const root = rootMap(doc);
  if (!root) throw new Error('graph yaml root is not a map');
  let seq = seqOf(root, 'edges');
  if (!seq) {
    root.set('edges', []);
    seq = seqOf(root, 'edges');
  }
  if (!seq) throw new Error('edges is not a sequence');
  let owner = edgeMaps(doc).find((item) => scalar(item, 'from') === edge.from && pair(item, 'map'));
  if (!owner) {
    owner = new YAMLMap();
    owner.set('from', edge.from);
    seq.add(owner);
  }
  ensureMap(owner).set(edge.outcome, edge.to);
}

export function removeRunGraphEdge(doc: Document, from: string, outcome: string): void {
  for (const edge of edgeMaps(doc)) {
    if (scalar(edge, 'from') !== from) continue;
    const map = pair(edge, 'map')?.value;
    if (!isMap(map)) continue;
    const index = map.items.findIndex((item) => keyText(item.key) === outcome);
    if (index >= 0) {
      const item = map.items[index]!;
      const start = (item.key as Ranged).range?.[0] ?? (item.value as Ranged).range?.[0];
      const end = (item.value as Ranged).range?.[2] ?? (item.value as Ranged).range?.[1];
      if (start !== undefined && end !== undefined) removedOf(doc).push([start, end]);
      map.delete(index);
    }
  }
}

type Ranged = { range?: [number, number, number] | null };

function rememberRemoval(doc: Document, node: unknown): void {
  const range = (node as Ranged | null)?.range;
  if (range) removedOf(doc).push([range[0], range[2] ?? range[1]]);
}

function contentEnd(node: Ranged | null | undefined, fallback: number): number {
  return node?.range ? node.range[1] : fallback;
}

/** Splice changed scalars and new pairs into the original text. Untouched bytes stay, including flow style. */
export function writeRunGraphYaml(doc: Document): string {
  const original = (doc as Document & { src?: string }).src ?? '';
  if (!original) return doc.toString();
  const pieces: Array<{ start: number; end: number; text: string }> = [];
  const visit = (node: unknown): void => {
    if (isSeq(node)) {
      node.items.forEach((item, index) => {
        if (isMap(item) && !(item as Ranged).range) {
          const previous = index > 0 ? (node.items[index - 1] as Ranged) : null;
          const at = contentEnd(previous, contentEnd(node, original.length));
          const lines = item.items.map((entry) => {
            const key = entry.key instanceof YAMLMap || entry.key instanceof YAMLSeq ? '' : String((entry.key as { value?: unknown }).value ?? entry.key);
            const raw = entry.value as { value?: unknown; toString?: () => string };
            const value = raw && typeof raw === 'object' && 'value' in raw ? String(raw.value) : String(entry.value);
            return `  ${key}: ${value}`;
          });
          const first = lines[0]?.slice(2) ?? '';
          pieces.push({ start: at, end: at, text: `\n- ${first}${lines.length > 1 ? `\n${lines.slice(1).join('\n')}` : ''}` });
        } else visit(item);
      });
      return;
    }
    if (!isMap(node)) return;
    for (const item of node.items) {
      const key = keyText(item.key);
      if (isMap(item.value) || isSeq(item.value)) {
        if (!(item.value as Ranged).range && (node as Ranged).range && key) {
          const at = (node as Ranged).range![1];
          const body = isMap(item.value)
            ? `${key}:\n${item.value.toString().replace(/\n$/, '').split('\n').map((line) => `  ${line}`).join('\n')}`
            : `${key}: ${item.value.toString().trim()}`;
          pieces.push({ start: at, end: at, text: `\n${body}` });
        } else visit(item.value);
        continue;
      }
      const value = scalarNode(item.value);
      if (!key || !value) continue;
      if (!value.range && (node as Ranged).range) {
        const at = (node as Ranged).range![1];
        pieces.push({ start: at, end: at, text: `\n${key}: ${value.toString()}` });
        continue;
      }
      if (!value.range) continue;
      const before = original.slice(value.range[0], value.range[1]);
      const rendered = doc.createNode(value.value).toString();
      if (before !== rendered) pieces.push({ start: value.range[0], end: value.range[1], text: rendered });
    }
  };
  visit(doc.contents);
  for (const [start, end] of removedOf(doc)) pieces.push({ start, end, text: '' });
  removedOf(doc).length = 0;
  let text = original;
  for (const piece of pieces.sort((a, b) => b.start - a.start || b.end - a.end)) {
    text = `${text.slice(0, piece.start)}${piece.text}${text.slice(piece.end)}`;
  }
  return text;
}
