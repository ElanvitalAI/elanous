import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateGraphYaml } from '../nexus/api/graph-kinds.js';
import { edgeMapOf, parseGraphTemplateYaml, type GraphTemplateSpec } from '../self-implement/graph-yaml.js';
import { resolveGraphUnit } from '../self-implement/graph-unit-resolver.js';
import { inspectPipelineGraph } from '../self-implement/pipeline-shape.js';
import { debug } from '../debug/log.js';
import { generateGraphFromPrompt, type GraphWizardDeps } from './generate.js';
import type { CompletionKind, CompositionSelection } from '../task-agent/task-hand.js';

export interface MissionComposeInput {
  text: string;
  completion: CompletionKind;
  root: string;
  ledgerPath: string;
  cardId: string;
  standard: CompositionSelection;
}

/** The LLM may choose the order of existing verb calls, but not their authority or the hand's launcher. */
export function missionGraphIssues(yaml: string, baseYaml: string, root: string, generatedPath?: string): string[] {
  const checked = validateGraphYaml('harness', yaml);
  const issues = checked.errors.map(error => typeof error === 'string' ? error : JSON.stringify(error));
  const parsed = parseGraphTemplateYaml(yaml);
  const base = parseGraphTemplateYaml(baseYaml);
  issues.push(...parsed.errors.map(error => `${error.path}: ${error.message}`));
  if (!parsed.template || !base.template) return issues;
  const graph = parsed.template;
  const standard = base.template;
  const raw = parseYaml(yaml) as Record<string, unknown>;
  const baseRaw = parseYaml(baseYaml) as Record<string, unknown>;
  if (raw.launcher !== baseRaw.launcher) issues.push('I6: 표준 launcher 제어를 바꿀 수 없다');
  for (const key of new Set([...Object.keys(baseRaw), ...Object.keys(raw)])) {
    if (['graph_id', 'loop', 'nodes', 'edges'].includes(key)) continue;
    if (JSON.stringify(raw[key]) !== JSON.stringify(baseRaw[key])) issues.push(`I6: 표준 제어 ${key} 변경 금지`);
  }
  if (raw.entry_node !== baseRaw.entry_node) issues.push('I6: 표준 진입 노드를 바꿀 수 없다');
  if (JSON.stringify(raw.terminal_nodes) !== JSON.stringify(baseRaw.terminal_nodes)) issues.push('I4: 표준 종료 노드를 바꿀 수 없다');
  const baseLoop = baseRaw.loop as { trigger?: unknown } | undefined;
  const loop = raw.loop as { trigger?: unknown } | undefined;
  if (JSON.stringify(loop?.trigger) !== JSON.stringify(baseLoop?.trigger)) issues.push('I6: 표준 트리거 변경 금지');
  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes as Array<Record<string, unknown>> : [];
  const baseNodes = Array.isArray(baseRaw.nodes) ? baseRaw.nodes as Array<Record<string, unknown>> : [];
  for (const node of rawNodes) {
    const original = baseNodes.find(candidate => candidate.call && candidate.call === node.call)
      ?? baseNodes.find(candidate => candidate.node_id === node.node_id && candidate.kind === 'gate');
    if (!original) continue;
    const keys = new Set([...Object.keys(node), ...Object.keys(original)]);
    for (const key of keys) {
      if (key === 'node_id' || key === 'max_visits') continue;
      if (JSON.stringify(node[key]) !== JSON.stringify(original[key])) issues.push(`I6: ${String(node.node_id)} 권한 ${key} 변경 금지`);
    }
  }
  const rawEdges = Array.isArray(raw.edges) ? raw.edges as Array<Record<string, unknown>> : [];
  if (rawEdges.some(edge => Object.keys(edge).some(key => !['from', 'to', 'on', 'map'].includes(key))))
    issues.push('I6: 간선 조건·폴백 권한 추가 금지');
  const allowed = new Map(standard.nodes.filter(n => n.kind === 'subgraph' && n.call?.startsWith('verb-')).map(n => [n.call!, n]));
  const standardById = new Map(standard.nodes.map(n => [n.nodeId, n]));
  const seenCalls = new Set<string>();
  for (const node of graph.nodes) {
    const original = standardById.get(node.nodeId);
    if (!original && /(?:merge|publish|send|pay|charge|deploy|release)/i.test(`${node.nodeId} ${node.call ?? ''}`))
      issues.push(`I5: 외부 효과 동사 추가 금지 (${node.nodeId})`);
    if (original?.kind === 'gate' && node.kind === 'gate'
      && JSON.stringify(node) === JSON.stringify(original)) continue;
    const known = node.kind === 'subgraph' && node.call ? allowed.get(node.call) : undefined;
    if (!known || node.recipe !== 'none' || node.maxVisits > known.maxVisits
      || JSON.stringify(node.contract) !== JSON.stringify(known.contract)
      || JSON.stringify(node.budget) !== JSON.stringify(known.budget)
      || node.skipWhen !== undefined || node.callEntry !== undefined)
      issues.push(`권한 표: ${node.nodeId} 는 허용된 동사 단위가 아니다`);
    if (node.call) seenCalls.add(node.call);
  }
  for (const call of allowed.keys()) if (!seenCalls.has(call)) issues.push(`권한 표: 표준 동사 단위 ${call} 누락`);
  for (const required of standard.nodes.filter(n => n.kind === 'gate' || ['gate', 'freeze-check', 'review'].includes(n.nodeId))) {
    if (!graph.nodes.some(n => n.nodeId === required.nodeId && JSON.stringify(n) === JSON.stringify(required))) issues.push(`권한 표: 보호 노드 ${required.nodeId} 누락 또는 변경`);
  }
  for (const terminal of standard.terminalNodes) if (!graph.terminalNodes.includes(terminal)) issues.push(`I4: 종료 ${terminal} 누락`);
  const edges = edgeMapOf(graph);
  issues.push(...inspectPipelineGraph(edges, graph.entryNode).map(defect => `I4: ${JSON.stringify(defect)}`));
  for (const node of graph.nodes) {
    const reachable = new Set<string>();
    const queue = [node.nodeId];
    while (queue.length) {
      const id = queue.shift()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      queue.push(...(edges[id] ?? []));
    }
    if (![...reachable].some(id => graph.terminalNodes.includes(id))) issues.push(`I4: ${node.nodeId} 에서 종료 불가`);
  }
  const mergeNodes = graph.nodes.filter(n => n.nodeId.includes('merge') || n.call?.includes('merge'));
  for (const merge of mergeNodes) {
    const prerequisites = ['gate', 'freeze-check', 'review'];
    const walk = (id: string, seen: Set<string>, met: Set<string>): void => {
      if (id === merge.nodeId) {
        for (const required of prerequisites) if (!met.has(required)) issues.push(`I1~I3: merge 앞 ${required} 없음`);
        return;
      }
      if (seen.has(id)) return;
      const nextMet = new Set(met);
      if (prerequisites.includes(id)) nextMet.add(id);
      const nextSeen = new Set(seen).add(id);
      for (const target of edges[id] ?? []) walk(target, nextSeen, nextMet);
    };
    walk(graph.entryNode, new Set(), new Set());
  }
  for (const node of graph.nodes.filter(n => n.kind === 'subgraph')) {
    if (!node.call || !allowed.has(node.call)) continue;
    try {
      const canonical = resolveGraphUnit(node.call, join(root, 'graphs/work', 'generated.yaml'));
      const actual = resolveGraphUnit(node.call, generatedPath ?? join(root, 'graphs/work', 'generated.yaml'));
      const unit = actual.template;
      if (actual.hash !== canonical.hash || `${unit.graphId}@${unit.version}` !== node.call || !unit.unit ||
        JSON.stringify(unit.unit.inputs) !== JSON.stringify(node.contract?.inputs) ||
        JSON.stringify(unit.unit.outputs) !== JSON.stringify(node.contract?.outputs)) issues.push(`권한 표: 동사 단위 미해석 ${node.call}`);
    } catch { issues.push(`권한 표: 동사 단위 미해석 ${node.call}`); }
  }
  return [...new Set(issues)];
}

export async function composeMissionGraph(input: MissionComposeInput, deps: Pick<GraphWizardDeps, 'callLLM'> & { deferPersistence?: boolean } = {}): Promise<{
  selection: CompositionSelection; reason: string; persist: () => void;
}> {
  const fallback = input.standard;
  let files: string[] = [];
  try { files = readdirSync(join(input.root, 'graphs/work')).filter(name => name.endsWith('.yaml') && name !== 'recipes.yaml'); }
  catch { /* The fixed selection already carries the missing or unreadable-template reason. */ }
  const candidates = files.flatMap(file => {
    const path = join(input.root, 'graphs/work', file);
    try {
      const yaml = readFileSync(path, 'utf8');
      const parsed = parseGraphTemplateYaml(yaml, path);
      return parsed.template && !parsed.errors.length && (parseYaml(yaml) as { launcher?: unknown }).launcher
        ? [{ file: `graphs/work/${file}`, yaml, template: parsed.template }] : [];
    } catch { return []; }
  });
  const standardFile = fallback.composition?.file;
  const words = input.text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const score = (item: { file: string; template: GraphTemplateSpec }) => {
    const label = `${item.file} ${item.template.graphId} ${item.template.loop?.title ?? ''} ${item.template.loop?.description ?? ''}`.toLowerCase();
    return words.reduce((total, word) => total + (word.length > 1 && label.includes(word) ? 1 : 0), 0);
  };
  const standardLauncher = standardFile ? candidates.find(item => item.file === standardFile) : undefined;
  const compatible = candidates.filter(item => (parseYaml(item.yaml) as { launcher: unknown }).launcher ===
    (standardLauncher ? (parseYaml(standardLauncher.yaml) as { launcher: unknown }).launcher : undefined)
    && item.template.nodes.every(node => node.kind === 'gate' || node.kind === 'subgraph' && node.call?.startsWith('verb-')));
  const base = compatible.sort((a, b) => score(b) - score(a) || Number(b.file === standardFile) - Number(a.file === standardFile))[0];
  const prefix = base ? `문면 선택 ${base.file} (일치 ${score(base)})` : '표준 조합 없음';
  let generated = '';
  let issues: string[] = [];
  let selection = fallback;
  if (base && base.file !== standardFile && fallback.launcher === 'graph-run' && !fallback.error) {
    const missingUnits: string[] = [];
    const { validateUnitCalls } = await import('../graph-runner/runner.js');
    try { validateUnitCalls(base.template, join(input.root, base.file), [], call => missingUnits.push(call)); }
    catch (error) { issues.push(`표준 조합 단위 해석 오류: ${error instanceof Error ? error.message : String(error)}`); }
    if (!issues.length && !missingUnits.length) selection = {
      composition: { file: base.file, version: base.template.version }, launcher: 'graph-run', unitsResolved: true, missingUnits: [],
    };
    else if (missingUnits.length) issues.push(`표준 조합 단위 미해석: ${missingUnits.join(', ')}`);
  }
  if (base && selection.composition && !selection.error && !issues.length &&
    (base.file === standardFile || selection.launcher === 'graph-run')) {
    try {
      const proposal = await generateGraphFromPrompt({ prompt: input.text, kind: 'harness', missionBase: { id: base.template.graphId, text: base.yaml } },
        { callLLM: deps.callLLM, graphsDir: join(input.root, 'graphs'), existingIds: () => new Set(), maxAttempts: 1 });
      generated = proposal.yaml;
      const launcher = (parseYaml(base.yaml) as { launcher: string }).launcher;
      if (!(parseYaml(generated) as { launcher?: unknown }).launcher)
        generated = generated.replace(/^(graph_id:\s*[^\n]+\n)/, `$1launcher: ${launcher}\n`);
      issues = missionGraphIssues(generated, base.yaml, input.root,
        join(dirname(input.ledgerPath), `${input.cardId}.generated.yaml`));
      if (!proposal.ok) issues.push(...proposal.issues);
      if (launcher !== 'graph-run') issues.push('권한 표: harness-say 는 생성된 graph-run 조합으로 전환할 수 없다');
      const directory = dirname(input.ledgerPath);
      const recipePath = join(directory, 'recipes.yaml');
      if (existsSync(recipePath) && readFileSync(recipePath, 'utf8') !== readFileSync(join(input.root, 'graphs/work/recipes.yaml'), 'utf8'))
        issues.push('권한 표: 원장 옆 recipes.yaml 이 표준과 다르다');
      if (!issues.length) {
        const target = join(dirname(input.ledgerPath), `${input.cardId}.generated.yaml`);
        selection = { composition: { file: target, version: parseGraphTemplateYaml(generated).template!.version },
          launcher: launcher as 'graph-run' | 'harness-say', unitsResolved: true, missingUnits: [] };
      }
    } catch (error) { issues.push(`생성 실패: ${error instanceof Error ? error.message : String(error)}`); }
  } else if (!issues.length) issues.push('표준 조합을 읽을 수 없다');
  const reason = issues.length ? `${prefix} → fallback-standard: ${issues.join('; ')}` : `${prefix} → composed: 동사 단위 검증 통과`;
  const persist = (): void => {
    const directory = dirname(input.ledgerPath);
    mkdirSync(directory, { recursive: true });
    if (generated) writeFileSync(join(directory, `${input.cardId}.generated.yaml`), generated);
    if (selection.composition?.file === join(directory, `${input.cardId}.generated.yaml`) && !existsSync(join(directory, 'recipes.yaml')))
      writeFileSync(join(directory, 'recipes.yaml'), readFileSync(join(input.root, 'graphs/work/recipes.yaml'), 'utf8'), { flag: 'wx' });
    writeFileSync(join(directory, `${input.cardId}.composition.json`), JSON.stringify({ base: base?.file ?? null,
      selected: selection.composition?.file ?? null, reason, issues, generated: generated ? `${input.cardId}.generated.yaml` : null }));
  };
  if (!deps.deferPersistence) persist();
  debug.log('graph.compose', issues.length ? 'fallback-standard' : 'composed', { card: input.cardId, base: base?.file ?? null, reason });
  return { selection, reason, persist };
}
