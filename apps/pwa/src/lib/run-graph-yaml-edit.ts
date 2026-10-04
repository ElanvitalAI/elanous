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

function setScalar(doc: Document, map: YAMLMap, key: string, value: string): void {
  const existing = scalarNode(pair(map, key)?.value);
  if (existing) {
    existing.value = value;
    return;
  }
  map.set(doc.createNode(key), doc.createNode(value));
}

type TrackedDocument = Document & { src: string; removed: Array<[number, number]>; structural?: boolean };

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
    root.set(doc.createNode('nodes'), doc.createNode([]));
    (doc as TrackedDocument).structural = true;
    seq = seqOf(root, 'nodes');
  }
  if (!seq) throw new Error('nodes is not a sequence');
  if (findNode(doc, node.nodeId)) throw new Error(`node already exists: ${node.nodeId}`);
  const created = new YAMLMap();
  created.set(doc.createNode('node_id'), doc.createNode(node.nodeId));
  created.set(doc.createNode('kind'), doc.createNode(node.kind));
  created.set(doc.createNode('recipe'), doc.createNode(node.recipe));
  created.set(doc.createNode('max_visits'), doc.createNode(node.maxVisits ?? 1));
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
  setScalar(doc, node, 'kind', kind);
}

export function setRunGraphNodeRecipe(doc: Document, nodeId: string, recipe: string): void {
  const node = findNode(doc, nodeId);
  if (!node) throw new Error(`node not found: ${nodeId}`);
  setScalar(doc, node, 'recipe', recipe);
}

function edgeMaps(doc: Document): YAMLMap[] {
  const root = rootMap(doc);
  const seq = root ? seqOf(root, 'edges') : null;
  return seq ? seq.items.flatMap((item) => { const map = mapOf(item); return map ? [map] : []; }) : [];
}

function ensureMap(doc: Document, edge: YAMLMap): YAMLMap {
  const existing = pair(edge, 'map')?.value;
  if (isMap(existing)) return existing;
  const created = new YAMLMap();
  edge.set(doc.createNode('map'), created);
  return created;
}

/** Add one `map` entry on the edge that already leaves `from`. Creates that edge when absent. */
export function addRunGraphEdge(doc: Document, edge: RunGraphEdgeEdit): void {
  const root = rootMap(doc);
  if (!root) throw new Error('graph yaml root is not a map');
  let seq = seqOf(root, 'edges');
  if (!seq) {
    root.set(doc.createNode('edges'), doc.createNode([]));
    (doc as TrackedDocument).structural = true;
    seq = seqOf(root, 'edges');
  }
  if (!seq) throw new Error('edges is not a sequence');
  // Generic edge edits only touch an edge that already routes by an outcome map —
  // never a plain `to` edge or another `on:` edge that happens to come first.
  let owner = edgeMaps(doc).find((item) => scalar(item, 'from') === edge.from && pair(item, 'map'));
  if (!owner) {
    owner = new YAMLMap();
    owner.set(doc.createNode('from'), doc.createNode(edge.from));
    owner.set(doc.createNode('on'), doc.createNode('outcome'));
    seq.add(owner);
    (doc as TrackedDocument).structural = true;
  }
  if (!pair(owner, 'map')) (doc as TrackedDocument).structural = true;
  setScalar(doc, ensureMap(doc, owner), edge.outcome, edge.to);
}

/** The editor's failure picker reads the existing outcome map, not a node-level setting. */
export function runGraphFailTarget(doc: Document, from: string): string | undefined {
  const edge = edgeMaps(doc).find((item) => scalar(item, 'from') === from);
  const map = edge && pair(edge, 'map')?.value;
  return map && isMap(map) ? scalar(map, 'fail') : undefined;
}

/** Why the failure picker cannot edit this node, or null when it can. */
export function runGraphFailRouteBlocked(doc: Document, from: string): string | null {
  const edges = edgeMaps(doc).filter((edge) => scalar(edge, 'from') === from);
  const other = edges.find((edge) => scalar(edge, 'on') !== undefined && scalar(edge, 'on') !== 'outcome');
  return other ? `이 노드는 «${scalar(other, 'on')}» 간선으로 이어져 실패 경로를 따로 둘 수 없습니다` : null;
}

export function setRunGraphFailTarget(doc: Document, from: string, target: string | null): void {
  if (!findNode(doc, from)) throw new Error(`node not found: ${from}`);
  if (target !== null && (!findNode(doc, target) || target === from)) throw new Error(`invalid failure target: ${target}`);
  const blocked = runGraphFailRouteBlocked(doc, from);
  if (blocked) throw new Error(`failure route requires an outcome edge: ${from}`);
  if (target === null) { removeRunGraphEdge(doc, from, 'fail'); return; }
  const withMap = edgeMaps(doc).find((edge) => scalar(edge, 'from') === from && pair(edge, 'map'));
  if (!withMap) {
    // Dedicated conversion: a single plain `to` edge becomes an outcome map that keeps it as `ok`.
    const plain = edgeMaps(doc).find((edge) => scalar(edge, 'from') === from && scalar(edge, 'to') !== undefined);
    if (plain) {
      const previous = scalar(plain, 'to')!;
      plain.delete('to');
      plain.set(doc.createNode('on'), doc.createNode('outcome'));
      const map = new YAMLMap();
      map.set(doc.createNode('ok'), doc.createNode(previous));
      map.set(doc.createNode('fail'), doc.createNode(target));
      plain.set(doc.createNode('map'), map);
      (doc as TrackedDocument).structural = true;
      return;
    }
  }
  if (runGraphFailTarget(doc, from) === undefined) (doc as TrackedDocument).structural = true;
  addRunGraphEdge(doc, { from, outcome: 'fail', to: target });
}

export function removeRunGraphEdge(doc: Document, from: string, outcome: string): void {
  for (const edge of edgeMaps(doc)) {
    if (scalar(edge, 'from') !== from) continue;
    const map = pair(edge, 'map')?.value;
    if (!isMap(map)) continue;
    const index = map.items.findIndex((item) => keyText(item.key) === outcome);
    if (index >= 0) {
      const item = map.items[index]!;
      let start = (item.key as Ranged).range?.[0] ?? (item.value as Ranged).range?.[0];
      let end = (item.value as Ranged).range?.[2] ?? (item.value as Ranged).range?.[1];
      if (map.flow && start !== undefined && end !== undefined) {
        const src = (doc as TrackedDocument).src;
        const preceding = src.slice(0, start).match(/,\s*$/);
        if (preceding) {
          start -= preceding[0].length;
          end = (item.value as Ranged).range?.[1] ?? end;
        } else {
          const following = src.slice(end).match(/^\s*,\s*/);
          if (following) end += following[0].length;
        }
      }
      if (start !== undefined && end !== undefined) removedOf(doc).push([start, end]);
      map.items.splice(index, 1);
    }
  }
}

type Ranged = { range?: [number, number, number] | null };

function rememberRemoval(doc: Document, node: unknown): void {
  const range = (node as Ranged | null)?.range;
  if (range) removedOf(doc).push([range[0], range[2] ?? range[1]]);
}

/** Splice changed scalars and new pairs into the original text. Untouched bytes stay, including flow style. */
export function writeRunGraphYaml(doc: Document): string {
  const original = (doc as Document & { src?: string }).src ?? '';
  const fallback = (reason: string): string => {
    console.debug('run-graph-yaml', 'fallback-to-string', { reason });
    return doc.toString();
  };
  if (!original) return fallback('missing-source');
  if ((doc as TrackedDocument).structural) return fallback('structural-edit');
  const pieces: Array<{ start: number; end: number; text: string }> = [];
  let newPairs = 0;
  let insertedPairs = 0;
  let structuralReason: string | undefined;
  const visit = (node: unknown): void => {
    if (isSeq(node)) {
      node.items.forEach((item, index) => {
        if (isMap(item) && !(item as Ranged).range) {
          if (node.flow || !item.items.every((entry) => keyText(entry.key) !== undefined && scalarNode(entry.value))) {
            structuralReason = 'new-sequence-map';
            return;
          }
          const previous = index > 0 ? node.items[index - 1] : null;
          const firstKey = isMap(previous) ? previous.items[0]?.key as Ranged | undefined : undefined;
          const lineStart = firstKey?.range ? original.lastIndexOf('\n', firstKey.range[0] - 1) + 1 : -1;
          const prefix = lineStart >= 0 ? original.slice(lineStart, firstKey!.range![0]) : '';
          if (!isMap(previous) || !previous.range || !/^ *- $/.test(prefix)) {
            structuralReason = 'unknown-sequence-indent';
            return;
          }
          const indent = prefix.slice(0, -2);
          const at = previous.range[1];
          const lines = item.items.map((entry) => {
            const key = keyText(entry.key)!;
            const value = scalarNode(entry.value)!;
            const renderedKey = doc.createNode(key).toString();
            const renderedValue = value.toString();
            const probe = parseDocument(`${renderedKey}: ${renderedValue}\n`);
            const parsed = isMap(probe.contents) && probe.contents.items.length === 1 ? probe.contents.items[0] : undefined;
            if (probe.errors.length || keyText(parsed?.key) !== key || !isScalar(parsed?.value) || parsed.value.value !== value.value) {
              structuralReason = 'unsafe-new-sequence-scalar';
            }
            return `  ${renderedKey}: ${renderedValue}`;
          });
          if (structuralReason) return;
          const first = lines[0]?.slice(2) ?? '';
          pieces.push({ start: at, end: at, text: `\n${indent}- ${first}${lines.length > 1 ? `\n${lines.slice(1).map((line) => `${indent}${line}`).join('\n')}` : ''}` });
        } else visit(item);
      });
      return;
    }
    if (!isMap(node)) return;
    for (const item of node.items) {
      const key = keyText(item.key);
      if (!key && !(item.key as Ranged).range) {
        structuralReason = 'unreadable-key';
        continue;
      }
      if (isMap(item.value) || isSeq(item.value)) {
        if (!(item.value as Ranged).range && (node as Ranged).range && key) {
          if (node.flow || !(item.key as Ranged).range) {
            structuralReason = 'new-collection-pair';
            continue;
          }
          const at = (node as Ranged).range![1];
          const body = isMap(item.value)
            ? `${key}:\n${item.value.toString().replace(/\n$/, '').split('\n').map((line) => `  ${line}`).join('\n')}`
            : `${key}: ${item.value.toString().trim()}`;
          pieces.push({ start: at, end: at, text: `\n${body}` });
        } else visit(item.value);
        continue;
      }
      const value = scalarNode(item.value);
      if (!key || !value) {
        if (!(item.key as Ranged).range || (!value && item.value !== null)) structuralReason = 'unreadable-pair';
        continue;
      }
      if (!value.range) {
        newPairs++;
        const range = (node as Ranged).range;
        const firstKey = node.items.find((entry) => (entry.key as Ranged).range)?.key as Ranged | undefined;
        if (!range || !firstKey?.range) {
          structuralReason = 'missing-map-range';
          continue;
        }
        const renderedKey = doc.createNode(key).toString();
        const renderedValue = value.toString();
        const probe = parseDocument(node.flow
          ? `{ ${renderedKey}: ${renderedValue} }`
          : `${renderedKey}: ${renderedValue}\n`);
        const probedPair = isMap(probe.contents) && probe.contents.items.length === 1 ? probe.contents.items[0] : undefined;
        if (probe.errors.length || keyText(probedPair?.key) !== key || !isScalar(probedPair?.value) || probedPair.value.value !== value.value) {
          structuralReason = 'unsafe-new-scalar';
          continue;
        }
        if (node.flow) {
          const close = range[1] - 1;
          if (original[close] !== '}' || original.slice(firstKey.range[0], close).trimEnd().endsWith(',')) {
            structuralReason = 'unknown-flow-map';
            continue;
          }
          const at = original.slice(0, close).trimEnd().length;
          if (original.slice(original.lastIndexOf('\n', at - 1) + 1, at).includes('#')) {
            structuralReason = 'flow-map-comment-before-close';
            continue;
          }
          pieces.push({ start: at, end: at, text: `${node.items.some((entry) => (entry.key as Ranged).range) ? ', ' : ''}${renderedKey}: ${renderedValue}` });
        } else {
          const lineStart = original.lastIndexOf('\n', firstKey.range[0] - 1) + 1;
          const prefix = original.slice(lineStart, firstKey.range[0]);
          const indent = /^ *(?:- )?$/.test(prefix) ? prefix.replace(/- $/, '  ') : null;
          if (indent === null || range[1] < firstKey.range[0]) {
            structuralReason = 'unknown-block-indent';
            continue;
          }
          const at = range[1];
          pieces.push({ start: at, end: at, text: `${at > 0 && original[at - 1] !== '\n' ? '\n' : ''}${indent}${renderedKey}: ${renderedValue}\n` });
        }
        insertedPairs++;
        continue;
      }
      const before = original.slice(value.range[0], value.range[1]);
      const rendered = doc.createNode(value.value).toString();
      if (before !== rendered) pieces.push({ start: value.range[0], end: value.range[1], text: rendered });
    }
  };
  visit(doc.contents);
  if (structuralReason || insertedPairs !== newPairs) {
    return fallback(structuralReason ?? 'uninserted-new-pair');
  }
  for (const [start, end] of removedOf(doc)) pieces.push({ start, end, text: '' });
  removedOf(doc).length = 0;
  let text = original;
  for (const piece of pieces.sort((a, b) => b.start - a.start || b.end - a.end)) {
    text = `${text.slice(0, piece.start)}${piece.text}${text.slice(piece.end)}`;
  }
  return text;
}
