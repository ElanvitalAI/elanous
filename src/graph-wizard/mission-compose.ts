import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { validateGraphYaml } from '../nexus/api/graph-kinds.js';
import { edgeMapOf, parseGraphTemplateYaml, type GraphTemplateSpec } from '../self-implement/graph-yaml.js';
import { resolveGraphUnit } from '../self-implement/graph-unit-resolver.js';
import { inspectPipelineGraph } from '../self-implement/pipeline-shape.js';
import { debug } from '../debug/log.js';
import { loadPluginManifestFromDir } from '../plugins/core/manifest.js';
import { ensureInternalMarketIndex, ensureMarketIndex, listMarkets, MarketFetchError, type MarketFetchOptions } from '../plugins/install/market-fetch.js';
import { installPlugin, listInstalledPlugins, type InstallOptions, type InstalledPlugin } from '../plugins/install/plugin-install.js';
import { generateGraphFromPrompt, type GraphWizardDeps } from './generate.js';
import type { CompletionKind, CompositionSelection } from '../task-agent/task-hand.js';

export interface MissionComposeInput {
  text: string;
  completion: CompletionKind;
  root: string;
  ledgerPath: string;
  cardId: string;
  standard: CompositionSelection;
  /** Smart plugin wizard: only asked when the sub-assistant found a tool missing. */
  pluginWizard?: PluginWizardInput;
}

const wordsOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

export type MissionComposeDeps = Pick<GraphWizardDeps, 'callLLM'> & {
  deferPersistence?: boolean;
  pluginWizard?: PluginWizardDeps;
};

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

export async function composeMissionGraph(input: MissionComposeInput, deps: MissionComposeDeps = {}): Promise<{
  selection: CompositionSelection; reason: string; persist: () => void; plugin?: PluginWizardResult;
}> {
  // The smart plugin wizard is the junction in front of this composition path: when the sub-assistant found a tool
  // missing, the wizard searches the trusted markets / runs Claude Code and Codex side tabs, and this function then
  // composes the mission on the same validated graph path — never on a second, unvalidated one.
  const plugin = input.pluginWizard ? await composePluginMission(input.pluginWizard, deps.pluginWizard ?? {}) : undefined;
  const pluginFailed = plugin !== undefined && plugin.status !== 'done';
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
  const words = wordsOf(input.text);
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
  const pluginNote = plugin?.plugin
    ? ` · 플러그인 채택 ${plugin.plugin.name}@${plugin.plugin.version}`
    : pluginFailed ? ` · 플러그인 마법사 실패: ${plugin?.reason ?? '후보 없음'}` : '';
  let generated = '';
  let issues: string[] = [];
  let selection = fallback;
  if (pluginFailed) issues.push(`플러그인 마법사: ${plugin?.reason ?? '후보 없음'}`);
  if (base && base.file !== standardFile && fallback.launcher === 'graph-run' && !fallback.error && !pluginFailed) {
    const missingUnits: string[] = [];
    const { validateUnitCalls } = await import('../graph-runner/runner.js');
    try { validateUnitCalls(base.template, join(input.root, base.file), [], call => missingUnits.push(call)); }
    catch (error) { issues.push(`표준 조합 단위 해석 오류: ${error instanceof Error ? error.message : String(error)}`); }
    if (!issues.length && !missingUnits.length) selection = {
      composition: { file: base.file, version: base.template.version }, launcher: 'graph-run', unitsResolved: true, missingUnits: [],
    };
    else if (missingUnits.length) issues.push(`표준 조합 단위 미해석: ${missingUnits.join(', ')}`);
  }
  if (base && selection.composition && !selection.error && !issues.length && !pluginFailed &&
    (base.file === standardFile || selection.launcher === 'graph-run')) {
    try {
      const proposal = await generateGraphFromPrompt({ prompt: plugin?.plugin
          ? `${input.text}\n플러그인 ${plugin.plugin.name}@${plugin.plugin.version} 로 «${input.pluginWizard?.missing ?? ''}» 를 수행한다.`
          : input.text,
        kind: 'harness', missionBase: { id: base.template.graphId, text: base.yaml } },
        { callLLM: deps.callLLM, graphsDir: join(input.root, 'graphs'), existingIds: () => new Set(), maxAttempts: 1 });
      generated = proposal.yaml;
      const launcher = (parseYaml(base.yaml) as { launcher: string }).launcher;
      if (!(parseYaml(generated) as { launcher?: unknown }).launcher)
        generated = generated.replace(/^(graph_id:\s*[^\n]+\n)/, `$1launcher: ${launcher}\n`);
      issues.push(...missionGraphIssues(generated, base.yaml, input.root,
        join(dirname(input.ledgerPath), `${input.cardId}.generated.yaml`)));
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
  const reason = issues.length
    ? `${prefix}${pluginNote} → fallback-standard: ${issues.join('; ')}`
    : `${prefix}${pluginNote} → composed: 동사 단위 검증 통과`;
  const persist = (): void => {
    const directory = dirname(input.ledgerPath);
    mkdirSync(directory, { recursive: true });
    if (generated) writeFileSync(join(directory, `${input.cardId}.generated.yaml`), generated);
    if (selection.composition?.file === join(directory, `${input.cardId}.generated.yaml`) && !existsSync(join(directory, 'recipes.yaml')))
      writeFileSync(join(directory, 'recipes.yaml'), readFileSync(join(input.root, 'graphs/work/recipes.yaml'), 'utf8'), { flag: 'wx' });
    writeFileSync(join(directory, `${input.cardId}.composition.json`), JSON.stringify({ base: base?.file ?? null,
      selected: selection.composition?.file ?? null, reason, issues, generated: generated ? `${input.cardId}.generated.yaml` : null,
      plugin: plugin ? { status: plugin.status, origin: plugin.origin, name: plugin.plugin?.name ?? null,
        version: plugin.plugin?.version ?? null, reason: plugin.reason ?? null } : null }));
  };
  if (!deps.deferPersistence) persist();
  debug.log('graph.compose', issues.length ? 'fallback-standard' : 'composed', { card: input.cardId, base: base?.file ?? null, reason });
  return { selection, reason, persist, ...(plugin === undefined ? {} : { plugin }) };
}

// ── 스마트 플러그인 마법사 접합부 ─────────────────────────────────────────────
// 정본: seat-state/OP/DEMO-1104-THREE-SCENES.md «하나의 유기체 시나리오» 5막 ⊕ 씬 2 2:20 줄.
// 흐름: 도구 없음 감지 → 텔레그램 질문 1~2개 → ① market-fetch 신뢰 출처 검색 → 후보 설치·시험 사용
//       ② 부족하면 Claude Code·Codex 사이드탭 동시 개발 → 시험 비교·채택 → plugin-install 설치
//       → 같은 흐름에서 사용 → 리니어 Done · 보고. 터미널과 사이드탭은 같은 세션 작업실(workspace)을 쓴다.
// 안전: 실제 CLI 실행·네트워크 마켓·텔레그램 송신은 호출측이 deps 로 주입한다(로컬 설치·데모 범위).

export type PluginMaker = 'claude' | 'codex';

export interface PluginWizardInput {
  /** The one-line mission the sub-assistant is working on. */
  mission: string;
  /** The tool/capability the sub-assistant found missing. */
  missing: string;
  /** Local install root passed straight to `plugin-install`. */
  root: string;
  /** The session workroom shared by the terminal and both maker side tabs. */
  workspace: string;
  /** At most two questions; the default is generated from `missing`. */
  questions?: string[];
  /** Side-tab makers, in tie-break order. */
  makers?: PluginMaker[];
  marketDir?: string;
  configPath?: string;
  cwd?: string;
  enterpriseId?: string;
  allowUnsigned?: boolean;
  refresh?: boolean;
  wizardId?: string;
}

export interface PluginCandidate {
  market: string;
  name: string;
  version: string;
  /** `<name>@<market>` — the exact spec `installPlugin` already accepts. */
  spec: string;
  description?: string;
  score: number;
}

export interface PluginMarketSearchResult {
  candidates: PluginCandidate[];
  /** Markets that could not be read; a missing market is not a failed wizard. */
  unavailable: string[];
}

export interface PluginTrial {
  ok: boolean;
  score: number;
  detail: string;
}

export interface PluginWizardTrial extends PluginTrial {
  origin: 'market' | 'maker';
  spec: string;
  maker?: PluginMaker;
}

export interface PluginWizardEvent {
  ts: string;
  wizardId: string;
  /** Same six steps the existing WizardMarketScene timeline reads. */
  step: 'request' | 'research' | 'draft' | 'validate' | 'install' | 'done';
  text: string;
  detail?: unknown;
}

export interface PluginWizardDeps {
  /** Telegram question surface: at most two questions are handed over. */
  ask?: (questions: readonly string[]) => Promise<Record<string, string> | undefined> | Record<string, string> | undefined;
  searchMarket?: (request: { missing: string; mission: string; query: string }) => Promise<PluginMarketSearchResult>;
  /** Side-tab maker contract (Claude Code / Codex): same goal text, same session workroom. */
  develop?: (request: { maker: PluginMaker; goal: string; workspace: string }) => Promise<{ spec: string }>;
  /** Optional classic pair seam: one paired launch returns both maker artifacts from the same workroom. */
  developPair?: (request: { makers: readonly PluginMaker[]; goal: string; workspace: string }) => Promise<Partial<Record<PluginMaker, { spec: string }>>>;
  /** Resolved CLI path per maker; absent means the caller's `develop` owns it. */
  makerCli?: Partial<Record<PluginMaker, string>>;
  /** Called only when a maker CLI is missing — the installer is injected, never run implicitly. */
  installMakerCli?: (maker: PluginMaker) => Promise<string | undefined>;
  trial?: (request: { origin: 'market' | 'maker'; maker?: PluginMaker; spec: string; workspace: string; path: string }) => Promise<PluginTrial>;
  install?: (spec: string, options: InstallOptions) => Promise<InstalledPlugin>;
  use?: (plugin: InstalledPlugin, request: { mission: string; missing: string; workspace: string; root: string }) => Promise<{ ok: boolean; detail: string }> | { ok: boolean; detail: string };
  /** Telegram report sink. */
  notify?: (report: string) => Promise<void> | void;
  onEvent?: (event: PluginWizardEvent) => void;
}

export interface PluginWizardResult {
  status: 'done' | 'failed';
  origin: 'market' | 'maker' | null;
  plugin?: InstalledPlugin;
  questions: string[];
  answers: Record<string, string>;
  trials: PluginWizardTrial[];
  report: string;
  reason?: string;
  events: PluginWizardEvent[];
}

export const PLUGIN_WIZARD_MARKET_QUESTION = '마켓 후보를 먼저 시험할까, 아니면 Claude Code·Codex 에게 바로 개발을 맡길까?';

/** The wizard asks one or two questions — never an interrogation. */
export function pluginWizardQuestions(input: Pick<PluginWizardInput, 'missing' | 'mission'>): string[] {
  return [
    `«${input.missing}» 대신 할 일을 한 줄로 알려줘 — 무엇을 만들면 이 미션(${input.mission})이 끝나나?`,
    PLUGIN_WIZARD_MARKET_QUESTION,
  ];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function marketOptions(input: Pick<PluginWizardInput, 'root' | 'marketDir' | 'configPath' | 'refresh'>): MarketFetchOptions {
  return {
    root: input.root,
    ...(input.marketDir ? { marketDir: input.marketDir } : {}),
    ...(input.configPath ? { configPath: input.configPath } : {}),
    ...(input.refresh ? { refresh: true } : {}),
  };
}

function installOptions(input: PluginWizardInput): InstallOptions {
  return {
    root: input.root,
    yes: true,
    ...(input.marketDir ? { marketDir: input.marketDir } : {}),
    ...(input.configPath ? { configPath: input.configPath } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.enterpriseId ? { enterpriseId: input.enterpriseId } : {}),
    ...(input.allowUnsigned ? { allowUnsigned: true } : {}),
  };
}

async function trustedIndex(name: string, input: Pick<PluginWizardInput, 'root' | 'marketDir' | 'configPath' | 'refresh' | 'enterpriseId'>): Promise<Awaited<ReturnType<typeof ensureMarketIndex>>> {
  const options = marketOptions(input);
  try { return await ensureMarketIndex(name, options); }
  catch (error) {
    if (!(error instanceof MarketFetchError) || !/^market not configured: /.test(error.message) || input.enterpriseId === undefined) throw error;
    return ensureInternalMarketIndex(name, input.enterpriseId, options);
  }
}

/** ① 마켓 검색 — only the configured trusted indices, verified by `market-fetch` (no new trust rules). */
export async function searchTrustedMarketPlugins(
  request: Pick<PluginWizardInput, 'missing' | 'mission'>,
  input: Pick<PluginWizardInput, 'root' | 'marketDir' | 'configPath' | 'refresh' | 'enterpriseId'>,
): Promise<PluginMarketSearchResult> {
  const words = wordsOf(`${request.missing} ${request.mission}`);
  const candidates: PluginCandidate[] = [];
  const unavailable: string[] = [];
  for (const market of listMarkets(marketOptions(input))) {
    try {
      const verified = await trustedIndex(market.name, input);
      for (const plugin of verified.index.plugins) {
        const label = `${plugin.name} ${plugin.description ?? ''} ${plugin.category ?? ''}`.toLowerCase();
        const score = words.reduce((total, word) => total + (word.length > 1 && label.includes(word) ? 1 : 0), 0);
        if (words.length && score === 0) continue;
        candidates.push({ market: market.name, name: plugin.name, version: plugin.version,
          spec: `${plugin.name}@${market.name}`, score, ...(plugin.description ? { description: plugin.description } : {}) });
      }
    } catch (error) { unavailable.push(`${market.name}: ${errorText(error)}`); }
  }
  return { candidates: candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)), unavailable };
}

/** ② 시험 — the staged/installed package must carry the assets its manifest promises. */
export function trialPluginDir(path: string): PluginTrial {
  if (!existsSync(path)) return { ok: false, score: 0, detail: `패키지 없음: ${path}` };
  let manifest;
  try { manifest = loadPluginManifestFromDir(path, { id: basename(path) }).manifest; }
  catch (error) { return { ok: false, score: 0, detail: `매니페스트 오류: ${errorText(error)}` }; }
  const assets = [...(manifest.contributes.graphs ?? []), ...(manifest.contributes.nodes ?? [])];
  const missing = assets.filter(asset => !existsSync(join(path, asset)));
  const score = assets.length - missing.length + (manifest.contributes.skills?.length ?? 0) + (manifest.contributes.vocab?.length ?? 0);
  if (missing.length) return { ok: false, score, detail: `자산 없음: ${missing.join(', ')}` };
  return { ok: score > 0, score, detail: `자산 ${assets.length}개 · 스킬 ${manifest.contributes.skills?.length ?? 0}개` };
}

/** 같은 흐름에서 사용 — the adopted plugin from the ledger answers the missing capability. */
export function useInstalledPlugin(
  plugin: InstalledPlugin,
  request: { root: string; missing: string; mission: string; workspace: string },
): { ok: boolean; detail: string } {
  const listed = listInstalledPlugins(request.root)
    .find(entry => entry.name === plugin.name && entry.version === plugin.version && entry.market === plugin.market);
  if (!listed) return { ok: false, detail: `설치 원장에 없음: ${plugin.name}@${plugin.version}` };
  let manifest;
  try { manifest = loadPluginManifestFromDir(listed.path, { id: listed.name }).manifest; }
  catch (error) { return { ok: false, detail: `매니페스트 오류: ${errorText(error)}` }; }
  const assets = [...(manifest.contributes.graphs ?? []),
    ...(manifest.contributes.skills ?? []).map(skill => skill.name ?? skill.id ?? '').filter(Boolean)];
  return { ok: true, detail: `${plugin.name}@${plugin.version} 로 «${request.missing}» 사용 (${assets.join(', ') || '자산 없음'})` };
}

function makerBinary(maker: PluginMaker): string | undefined {
  const name = maker === 'claude' ? 'claude' : 'codex';
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function makerGoal(input: PluginWizardInput, answers: Record<string, string>): string {
  return [
    `[플러그인 골] ${input.missing}`,
    `미션: ${input.mission}`,
    Object.keys(answers).length ? `답: ${JSON.stringify(answers)}` : '답: 없음',
    `세션 작업실: ${input.workspace}`,
  ].join('\n');
}

/** The wizard body. Every side effect (telegram, market, CLI, install, use) has a production default that goes
 *  through market-fetch / plugin-install; the demo/mock stage injects them. */
export async function composePluginMission(input: PluginWizardInput, deps: PluginWizardDeps = {}): Promise<PluginWizardResult> {
  const wizardId = input.wizardId ?? randomUUID();
  const events: PluginWizardEvent[] = [];
  const emit = (step: PluginWizardEvent['step'], text: string, detail?: unknown): void => {
    const event: PluginWizardEvent = { ts: new Date().toISOString(), wizardId, step, text: text.slice(0, 500),
      ...(detail === undefined ? {} : { detail }) };
    events.push(event);
    try { debug.log('wizard.step', 'wizard.step', event); } catch { /* 관측은 마법사를 멈추지 않는다. */ }
    try { deps.onEvent?.(event); } catch { /* 리스너는 마법사를 멈추지 않는다. */ }
  };
  const finish = async (result: Omit<PluginWizardResult, 'events' | 'questions' | 'answers' | 'report' | 'trials'>,
    trials: PluginWizardTrial[], questions: string[], answers: Record<string, string>, report: string): Promise<PluginWizardResult> => {
    emit('done', result.status === 'done'
      ? `Done · ${result.plugin?.name}@${result.plugin?.version}`
      : `실패 · ${result.reason ?? '후보 없음'}`, { ok: result.status === 'done' });
    try { await deps.notify?.(report); } catch { /* 보고 실패는 설치를 되돌리지 않는다. */ }
    return { ...result, trials, questions, answers, report, events };
  };

  const questions = [...(input.questions ?? pluginWizardQuestions(input))];
  if (questions.length < 1 || questions.length > 2) throw new Error('plugin wizard asks one or two questions');
  emit('request', `도구 없음: ${input.missing} — 질문 ${questions.length}개`);
  let asked: Record<string, string> | undefined;
  try { asked = await deps.ask?.(questions); }
  catch (error) {
    const reason = `질문 입력 어댑터 실패: ${errorText(error)}`;
    return finish({ status: 'failed', origin: null, reason }, [], questions, {}, `[스마트 플러그인 마법사] 실패 · ${reason}`);
  }
  const answers: Record<string, string> = asked && typeof asked === 'object' && !Array.isArray(asked) ? { ...asked } : {};

  const query = `${input.missing} ${input.mission}`.trim();
  let search: PluginMarketSearchResult = { candidates: [], unavailable: [] };
  try {
    search = deps.searchMarket
      ? await deps.searchMarket({ missing: input.missing, mission: input.mission, query })
      : await searchTrustedMarketPlugins(input, input);
  } catch (error) { search = { candidates: [], unavailable: [errorText(error)] }; }
  emit('research', search.candidates.length
    ? `마켓 후보 ${search.candidates.length}건: ${search.candidates.map(candidate => candidate.spec).join(', ')}`
    : `마켓 후보 부족${search.unavailable.length ? ` · ${search.unavailable.join('; ')}` : ''}`,
    { candidates: search.candidates, unavailable: search.unavailable });

  const install = deps.install ?? ((spec: string, options: InstallOptions) => installPlugin(spec, options));
  const trial = deps.trial ?? (async (request: { path: string }) => trialPluginDir(request.path));
  const trials: PluginWizardTrial[] = [];
  let adopted: { spec: string; origin: 'market' | 'maker'; maker?: PluginMaker; installed: InstalledPlugin } | undefined;

  for (const candidate of search.candidates.slice(0, 2)) {
    let installed: InstalledPlugin;
    try { installed = await install(candidate.spec, installOptions(input)); }
    catch (error) {
      trials.push({ origin: 'market', spec: candidate.spec, ok: false, score: 0, detail: errorText(error) });
      continue;
    }
    let tested: PluginTrial;
    try { tested = await trial({ origin: 'market', spec: candidate.spec, workspace: input.workspace, path: installed.path }); }
    catch (error) { tested = { ok: false, score: 0, detail: `시험 어댑터 실패: ${errorText(error)}` }; }
    trials.push({ origin: 'market', spec: candidate.spec, ...tested });
    if (tested.ok) { adopted = { spec: candidate.spec, origin: 'market', installed }; break; }
  }

  if (!adopted) {
    const makers = [...new Set(input.makers ?? ['claude', 'codex'] as PluginMaker[])];
    const cli = await Promise.all(makers.map(async maker => {
      const found = deps.makerCli === undefined ? makerBinary(maker) : deps.makerCli[maker];
      if (found) return `${maker}: ${found}`;
      if (!deps.installMakerCli) return `${maker}: CLI 미발견 — 설치 필요`;
      try {
        const installedCli = await deps.installMakerCli(maker);
        return installedCli ? `${maker}: 설치됨 ${installedCli}` : `${maker}: 설치 실패`;
      } catch (error) { return `${maker}: 설치 실패 ${errorText(error)}`; }
    }));
    emit('draft', `사이드탭 동시 개발: ${makers.join(' · ')}`, { cli });
    const goal = makerGoal(input, answers);
    if (!deps.develop && !deps.developPair) {
      const reason = `채택할 플러그인 없음 (개발 계약 없음 · CLI: ${cli.join(' · ')}): ${trials.map(item => `${item.origin} ${item.ok ? 'ok' : item.detail}`).join('; ') || '후보 없음'}`;
      return finish({ status: 'failed', origin: null, reason }, trials, questions, answers,
        `[스마트 플러그인 마법사] 실패 · ${reason}`);
    }
    let settled: PromiseSettledResult<{ spec: string }>[];
    if (deps.developPair) {
      try {
        const paired = await deps.developPair({ makers, goal, workspace: input.workspace });
        settled = makers.map(maker => paired[maker]
          ? { status: 'fulfilled', value: paired[maker]! }
          : { status: 'rejected', reason: new Error(`${maker} pair result unavailable`) });
      } catch (error) {
        settled = makers.map(() => ({ status: 'rejected', reason: error }));
      }
    } else {
      settled = await Promise.allSettled(makers.map(maker => deps.develop!({ maker, goal, workspace: input.workspace })));
    }
    const candidates: Array<{ maker: PluginMaker; spec: string; path: string; trial: PluginTrial }> = [];
    for (const [index, outcome] of settled.entries()) {
      const maker = makers[index]!;
      if (outcome.status === 'rejected') {
        trials.push({ origin: 'maker', maker, spec: '', ok: false, score: 0, detail: errorText(outcome.reason) });
        continue;
      }
      const spec = outcome.value.spec;
      const path = isAbsolute(spec) ? spec : resolve(input.cwd ?? process.cwd(), spec);
      let tested: PluginTrial;
      try { tested = await trial({ origin: 'maker', maker, spec, workspace: input.workspace, path }); }
      catch (error) { tested = { ok: false, score: 0, detail: `시험 어댑터 실패: ${errorText(error)}` }; }
      trials.push({ origin: 'maker', maker, spec, ...tested });
      if (tested.ok) candidates.push({ maker, spec, path, trial: tested });
    }
    const best = candidates.sort((a, b) => b.trial.score - a.trial.score)[0];
    emit('validate', candidates.length
      ? `시험 비교: ${candidates.map(candidate => `${candidate.maker} ${candidate.trial.score}`).join(' · ')}`
      : '시험 비교: 채택 가능한 개발 산출 없음',
      { trials: trials.filter(item => item.origin === 'maker'),
        winner: best ? { maker: best.maker, spec: best.spec, score: best.trial.score } : null });
    if (best) {
      try { adopted = { spec: best.spec, origin: 'maker', maker: best.maker, installed: await install(best.spec, installOptions(input)) }; }
      catch (error) { trials.push({ origin: 'maker', maker: best.maker, spec: best.spec, ok: false, score: 0, detail: errorText(error) }); }
    }
  }

  if (!adopted) {
    const reason = `채택할 플러그인 없음: ${trials.map(item => `${item.origin}${item.maker ? `/${item.maker}` : ''} ${item.ok ? 'ok' : item.detail}`).join('; ') || '후보·개발 산출 없음'}`;
    return finish({ status: 'failed', origin: null, reason }, trials, questions, answers,
      `[스마트 플러그인 마법사] 실패 · ${reason}`);
  }

  const { installed: plugin } = adopted;
  emit('install', `plugin-install 설치: ${plugin.name}@${plugin.version} → ${plugin.path}`, { market: plugin.market, sha256: plugin.sha256 });
  const use = deps.use ?? ((target: InstalledPlugin, request: { root: string; missing: string; mission: string; workspace: string }) =>
    useInstalledPlugin(target, request));
  let used: { ok: boolean; detail: string };
  try { used = await use(plugin, { root: input.root, missing: input.missing, mission: input.mission, workspace: input.workspace }); }
  catch (error) { used = { ok: false, detail: `사용 어댑터 실패: ${errorText(error)}` }; }
  emit('install', `같은 흐름 사용: ${used.detail}`, { ok: used.ok });
  const route = adopted.origin === 'market' ? `마켓 ${plugin.market}` : `${adopted.maker} 개발`;
  const report = [
    `[스마트 플러그인 마법사] ${used.ok ? 'Done' : '실패'} · ${plugin.name}@${plugin.version} (${route})`,
    `미션: ${input.mission}`,
    `빠진 도구: ${input.missing}`,
    `질문: ${questions.join(' / ')}`,
    Object.keys(answers).length ? `답: ${JSON.stringify(answers)}` : '답: 없음',
    `시험: ${trials.map(item => `${item.origin}${item.maker ? `/${item.maker}` : ''} ${item.ok ? 'ok' : 'fail'} ${item.score}`).join(' · ') || '없음'}`,
    `설치: ${plugin.path}`,
    `사용: ${used.detail}`,
    `작업실: ${input.workspace}`,
  ].join('\n');
  if (!used.ok) return finish({ status: 'failed', origin: adopted.origin, plugin, reason: `사용 실패: ${used.detail}` }, trials, questions, answers, report);
  return finish({ status: 'done', origin: adopted.origin, plugin }, trials, questions, answers, report);
}
