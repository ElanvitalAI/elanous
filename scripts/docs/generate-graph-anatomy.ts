#!/usr/bin/env bun
/**
 * DOC-GEN① — 그래프 아나토미를 코드에서 생성한다.
 *
 * 원천은 둘뿐이다.
 *   노드 종류 = src/graph-kinds/registry.ts (HARNESS_CORE_KINDS · WORKFLOW_CORE_KINDS · listNodeKinds)
 *   그래프     = graphs/ YAML 을 src/self-implement/graph-yaml.ts 의 loadGraphTemplates · edgeMapOf 가 읽는다
 *
 * renderGraphAnatomy · diffAnatomy 는 순수하다 — 파일을 쓰지 않고 process.cwd() 를 읽지 않는다.
 * 뿌리·커밋·시각은 인자로만 받는다. 쓰기는 main 만 한다.
 * main: `--out <path>` (기본 내부 문서 `graph-anatomy`) 와 같은 이름 `.json` 옆 파일.
 * git 트리가 아니면 죽지 않고 `commit: (설치본 v<package.json version>)`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listNodeKinds, type GraphKind, type NodeKindEntry } from '../../src/graph-kinds/registry.js';
import {
  edgeMapOf,
  loadGraphTemplates,
  parseGraphTemplateYaml,
  type GraphLoadResult,
  type GraphParseIssue,
  type GraphTemplateSpec,
} from '../../src/self-implement/graph-yaml.js';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** drafts/ · overlays/ 는 스캔에서 뺀다(실측 10-05). 그 이름인 디렉터리와 그 아래는 안 읽는다. */
const EXCLUDED_DIR_NAMES = new Set(['drafts', 'overlays']);

export interface RenderGraphAnatomyInput {
  readonly graphsRoot: string;
  readonly commit: string;
  readonly generatedAt: string;
}

/** `<out>.json` 옆 파일. graphs 값은 graph_id → nodeId 목록. */
export interface AnatomySnapshot {
  readonly generatedAt: string;
  readonly commit: string;
  readonly graphs: Readonly<Record<string, readonly string[]>>;
}

export interface AnatomyDiff {
  readonly addedGraphs: readonly string[];
  readonly removedGraphs: readonly string[];
  /** `graph_id/nodeId` */
  readonly addedNodes: readonly string[];
  /** `graph_id/nodeId` */
  readonly removedNodes: readonly string[];
}

export interface ScannedGraphDir {
  /** graphsRoot 기준 상대 경로. 뿌리 자신은 '.' */
  readonly dir: string;
  readonly result: GraphLoadResult;
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function edgeCountOf(template: GraphTemplateSpec): number {
  return Object.values(edgeMapOf(template)).reduce((sum, targets) => sum + targets.length, 0);
}

function edgeLinesOf(template: GraphTemplateSpec): string[] {
  const lines: string[] = [];
  for (const edge of template.edges) {
    if (edge.to !== undefined) lines.push(`${edge.from} → ${edge.to}`);
    for (const [key, target] of Object.entries(edge.map ?? {})) lines.push(`${edge.from} → ${target} (${key})`);
    for (const fallback of edge.fallback ?? []) lines.push(`${edge.from} → ${fallback.node} (fallback)`);
  }
  return lines;
}

/**
 * A directory with recipes.yaml holds workflow graphs run by `elanous graph run` (src/graph-runner/runner.ts), not
 * harness templates. The runner gives a recipe-less node (done · failed) `recipe: 'none'` before the shared parser
 * (runner.ts «command-less node … represented internally as `none`»); read those graphs the same way, and do not
 * read recipes.yaml itself as a graph.
 */
function isRunnerDir(abs: string): boolean { return existsSync(join(abs, 'recipes.yaml')); }

function parseLikeRunner(source: string, label: string): ReturnType<typeof parseGraphTemplateYaml> {
  let raw: unknown;
  try { raw = parseYaml(source); } catch { return parseGraphTemplateYaml(source, label); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return parseGraphTemplateYaml(source, label);
  const document = raw as Record<string, unknown>;
  if (Array.isArray(document.nodes)) {
    document.nodes = document.nodes.map((node: unknown) => node && typeof node === 'object' && !Array.isArray(node) && !('recipe' in node)
      ? { ...node, recipe: 'none' } : node);
  }
  return parseGraphTemplateYaml(stringifyYaml(document), label);
}

function graphFileNames(abs: string): string[] {
  const runner = isRunnerDir(abs);
  return readdirSync(abs).filter((name) => (name.endsWith('.yaml') || name.endsWith('.yml')) && !(runner && name === 'recipes.yaml')).sort();
}

/** loadGraphTemplates for harness dirs; the runner's reading for workflow-graph dirs (same result shape). */
function loadDir(abs: string): GraphLoadResult {
  if (!isRunnerDir(abs)) return loadGraphTemplates(abs);
  const errors: GraphParseIssue[] = [];
  const warnings: GraphParseIssue[] = [];
  const templates: Record<string, GraphTemplateSpec> = {};
  let files: string[];
  try { files = graphFileNames(abs); }
  catch (error) { return { templates, errors: [{ path: abs, message: `그래프 디렉토리를 못 읽었다: ${String(error)}` }], warnings, scannedFiles: 0 }; }
  for (const file of files) {
    let source: string;
    try { source = readFileSync(join(abs, file), 'utf8'); }
    catch (error) { errors.push({ path: file, message: `읽기 실패: ${String(error)}` }); continue; }
    const result = parseLikeRunner(source, file);
    errors.push(...result.errors);
    warnings.push(...result.warnings);
    if (!result.template) continue;
    if (templates[result.template.graphId]) { errors.push({ path: file, message: `graph_id '${result.template.graphId}' 가 중복이다` }); continue; }
    templates[result.template.graphId] = result.template;
  }
  return { templates, errors, warnings, scannedFiles: files.length };
}

/** 뿌리와 하위 디렉터리를 돈다. drafts/ · overlays/ 와 그 아래는 제외. 디렉터리마다 loadGraphTemplates 를 그대로 부른다. */
export function scanGraphDirs(graphsRoot: string): ScannedGraphDir[] {
  const scanned: ScannedGraphDir[] = [];
  const visit = (dir: string): void => {
    scanned.push({ dir: relative(graphsRoot, dir) || '.', result: loadDir(dir) });
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !EXCLUDED_DIR_NAMES.has(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch {
      return;
    }
    for (const name of names) visit(join(dir, name));
  };
  visit(graphsRoot);
  return scanned;
}

/**
 * loadGraphTemplates 는 파일명을 템플릿에 안 남긴다.
 * 같은 디렉터리 yaml 을 parseGraphTemplateYaml 로 한 번씩 읽어 graph_id → 상대 경로를 붙인다.
 * 파싱에 실패한 파일은 표에 안 들어가므로 맵에도 안 넣는다.
 */
/** 그 디렉터리에서 loadGraphTemplates 가 센 yaml 이름. 못 읽으면 빈 목록. */
function yamlNames(graphsRoot: string, dir: string): readonly string[] {
  const abs = dir === '.' ? graphsRoot : join(graphsRoot, dir);
  try {
    return graphFileNames(abs);
  } catch {
    return [];
  }
}

function graphIdPaths(graphsRoot: string, dir: string): ReadonlyMap<string, string> {
  const abs = dir === '.' ? graphsRoot : join(graphsRoot, dir);
  const prefix = dir === '.' ? '' : `${dir}/`;
  const paths = new Map<string, string>();
  let names: string[];
  try {
    names = graphFileNames(abs);
  } catch {
    return paths;
  }
  for (const name of names) {
    let source: string;
    try { source = readFileSync(join(abs, name), 'utf8'); }
    catch { continue; }
    const parsed = isRunnerDir(abs) ? parseLikeRunner(source, name) : parseGraphTemplateYaml(source, name);
    if (!parsed.template) continue;
    const rel = `${prefix}${name}`;
    const prev = paths.get(parsed.template.graphId);
    paths.set(parsed.template.graphId, prev === undefined ? rel : `${prev}, ${rel}`);
  }
  return paths;
}

function sortedIds(ids: Iterable<string>): string[] {
  return [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** 순수. 어제 판과 오늘 판의 그래프·노드 차이. 파일을 읽거나 쓰지 않는다. */
export function diffAnatomy(prev: AnatomySnapshot, next: AnatomySnapshot): AnatomyDiff {
  const prevIds = new Set(Object.keys(prev.graphs));
  const nextIds = new Set(Object.keys(next.graphs));
  const addedGraphs = sortedIds([...nextIds].filter((id) => !prevIds.has(id)));
  const removedGraphs = sortedIds([...prevIds].filter((id) => !nextIds.has(id)));
  const addedNodes: string[] = [];
  const removedNodes: string[] = [];
  // A graph that appears or disappears contributes all of its nodes, so the node list never hides them (ACP must-fix).
  for (const id of sortedIds([...new Set([...prevIds, ...nextIds])])) {
    const before = new Set(prev.graphs[id] ?? []);
    const after = new Set(next.graphs[id] ?? []);
    for (const nodeId of sortedIds([...after].filter((node) => !before.has(node)))) addedNodes.push(`${id}/${nodeId}`);
    for (const nodeId of sortedIds([...before].filter((node) => !after.has(node)))) removedNodes.push(`${id}/${nodeId}`);
  }
  return { addedGraphs, removedGraphs, addedNodes, removedNodes };
}

/** 머리(`# Graph anatomy` 와 생성물 경고) 바로 아래. 파일을 쓰지 않는다. */
export function renderYesterdaySection(prev: AnatomySnapshot | null, next: AnatomySnapshot): string {
  if (prev === null) return ['## 어제 대비', '', '이전 판 없음(첫 생성)', ''].join('\n');
  const diff = diffAnatomy(prev, next);
  const lines = ['## 어제 대비', ''];
  const changed = diff.addedGraphs.length + diff.removedGraphs.length + diff.addedNodes.length + diff.removedNodes.length;
  if (changed === 0) {
    lines.push('변화 없음', '');
    return lines.join('\n');
  }
  for (const id of diff.addedGraphs) lines.push(`+ ${id}`);
  for (const id of diff.removedGraphs) lines.push(`- ${id}`);
  for (const node of diff.addedNodes) lines.push(`+ ${node}`);
  for (const node of diff.removedNodes) lines.push(`- ${node}`);
  lines.push('');
  return lines.join('\n');
}

function snapshotOf(scanned: readonly ScannedGraphDir[], commit: string, generatedAt: string): AnatomySnapshot {
  const graphs: Record<string, string[]> = {};
  for (const { result } of scanned) {
    for (const template of Object.values(result.templates)) {
      const ids = template.nodes.map((node) => node.nodeId);
      const prev = graphs[template.graphId];
      graphs[template.graphId] = prev === undefined ? ids : [...prev, ...ids.filter((id) => !prev.includes(id))];
    }
  }
  return { generatedAt, commit, graphs };
}

function kindRows(entries: readonly NodeKindEntry[]): string[] {
  return [...entries]
    .sort((a, b) => (a.graph < b.graph ? -1 : a.graph > b.graph ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
    .map((entry) => `| ${cell(entry.graph)} | ${cell(entry.kind)} | ${entry.core ? 'core' : 'plugin'} |`);
}

function issueLines(label: string, issues: readonly GraphParseIssue[]): string[] {
  if (issues.length === 0) return [`- ${label}: 0`];
  return [`- ${label}: ${issues.length}`, ...issues.map((issue) => `  - ${cell(issue.path)} — ${issue.message}`)];
}

/**
 * 마크다운 한 장. 파일을 쓰지 않는다. graphsRoot · commit · generatedAt 만 읽는다.
 */
export function renderGraphAnatomy(input: RenderGraphAnatomyInput, yesterday?: string): string {
  const scanned = scanGraphDirs(input.graphsRoot);
  const templates: { dir: string; fileLabel: string; template: GraphTemplateSpec }[] = [];
  for (const { dir, result } of scanned) {
    for (const template of Object.values(result.templates)) {
      templates.push({ dir, fileLabel: dir === '.' ? `${template.graphId}` : `${dir}/${template.graphId}`, template });
    }
  }
  templates.sort((a, b) => (a.template.graphId < b.template.graphId ? -1 : a.template.graphId > b.template.graphId ? 1 : a.dir < b.dir ? -1 : 1));

  const scannedFiles = scanned.reduce((sum, entry) => sum + entry.result.scannedFiles, 0);
  const missingDirs = scanned.filter((entry) =>
    entry.result.scannedFiles === 0
    && entry.result.errors.some((issue) => issue.message.startsWith('그래프 디렉토리를 못 읽었다')),
  );

  const lines: string[] = [
    '# Graph anatomy',
    '',
    '> 이 문서는 생성물이다 — 손으로 고치지 마라',
    '',
    `- generatedAt: ${input.generatedAt}`,
    `- commit: ${input.commit}`,
    `- graphsRoot: (인자)`,
    `- scannedFiles: ${scannedFiles}`,
    `- scannedDirs: ${scanned.length}`,
    `- templates: ${templates.length}`,
    '',
    ...(yesterday === undefined ? [] : [yesterday.trimEnd(), '']),
    '## 표 1 노드 종류',
    '',
    '원천: `src/graph-kinds/registry.ts` — `HARNESS_CORE_KINDS` · `WORKFLOW_CORE_KINDS` · `listNodeKinds()`.',
    '',
    '| graph | kind | core/plugin |',
    '| --- | --- | --- |',
    ...kindRows(listNodeKinds()),
    '',
    '## 표 2 그래프',
    '',
    '원천: `loadGraphTemplates(dir)` ⊕ `edgeMapOf(template)`. 간선 수는 edgeMapOf 합(to · map · fallback, 중복 목적지는 한 번). `drafts/` · `overlays/` 는 제외.',
    '',
    '| 파일 경로 | graph_id | 노드 수 | 간선 수 | entryNode | terminalNodes |',
    '| --- | --- | --- | --- | --- | --- |',
  ];

  if (templates.length === 0) {
    lines.push('| (없음) | — | 0 | 0 | — | — |');
  }
  const pathCache = new Map<string, ReadonlyMap<string, string>>();
  for (const { dir, template } of templates) {
    let paths = pathCache.get(dir);
    if (paths === undefined) {
      paths = graphIdPaths(input.graphsRoot, dir);
      pathCache.set(dir, paths);
    }
    const where = paths.get(template.graphId) ?? (dir === '.' ? `${template.graphId}.yaml` : `${dir}/`);
    lines.push(`| ${cell(where)} | ${cell(template.graphId)} | ${template.nodes.length} | ${edgeCountOf(template)} | ${cell(template.entryNode)} | ${cell(template.terminalNodes.join(', '))} |`);
  }

  lines.push('', '## 그래프별 노드 · 간선', '');
  if (templates.length === 0) lines.push('(읽힌 그래프 없음)', '');
  for (const { dir, template } of templates) {
    const where = dir === '.' ? '(graphs root)' : dir;
    lines.push(`### ${template.graphId}`, '', `- path: ${where}`, '', '#### 노드', '', '| nodeId | kind |', '| --- | --- |');
    for (const node of template.nodes) lines.push(`| ${cell(node.nodeId)} | ${cell(node.kind)} |`);
    lines.push('', '#### 간선', '');
    const edges = edgeLinesOf(template);
    if (edges.length === 0) lines.push('(간선 없음)');
    else for (const edge of edges) lines.push(`- ${edge}`);
    lines.push('');
  }

  lines.push('## 스캔한 파일', '');
  lines.push('loadGraphTemplates 가 센 yaml. 파싱에 실패한 파일은 표 2에 없고 여기와 오류 절에만 있다.', '');
  lines.push('| 디렉터리 | 파일 |', '| --- | --- |');
  for (const { dir } of scanned) {
    const names = yamlNames(input.graphsRoot, dir);
    const prefix = dir === '.' ? '' : `${dir}/`;
    if (names.length === 0) {
      lines.push(`| ${cell(dir === '.' ? '(graphs root)' : dir)} | (yaml 0) |`);
      continue;
    }
    for (const name of names) lines.push(`| ${cell(dir === '.' ? '(graphs root)' : dir)} | ${cell(`${prefix}${name}`)} |`);
  }
  lines.push('', '## 로드 오류 · 경고 · scannedFiles', '');
  lines.push(`scannedFiles 합: ${scannedFiles}`, '');
  if (missingDirs.length > 0) {
    lines.push('디렉토리 없음 (0개 읽음과 구분):', '');
    for (const entry of missingDirs) {
      for (const issue of entry.result.errors) lines.push(`- ${cell(issue.path)} — ${issue.message}`);
    }
    lines.push('');
  }
  for (const { dir, result } of scanned) {
    const label = dir === '.' ? '(graphs root)' : dir;
    const unreadable = result.scannedFiles === 0 && result.errors.some((issue) => issue.message.startsWith('그래프 디렉토리를 못 읽었다'));
    lines.push(`### ${label}`, '');
    lines.push(`- scannedFiles: ${result.scannedFiles}${unreadable ? ' (디렉토리 없음)' : result.scannedFiles === 0 ? ' (0개 읽음)' : ''}`);
    lines.push(...issueLines('errors', result.errors));
    lines.push(...issueLines('warnings', result.warnings));
    lines.push('');
  }

  const axes: GraphKind[] = ['harness', 'workflow'];
  lines.push('## 축별 종류 수', '');
  for (const axis of axes) lines.push(`- ${axis}: ${listNodeKinds(axis).length}`);
  lines.push('');
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

function repoRootFromHere(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** git 트리가 아니면 죽지 않는다. 설치본은 package.json version 으로 적는다. */
export function readCommit(repoRoot: string): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    let version = 'unknown';
    try {
      const raw = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown };
      if (typeof raw.version === 'string' && raw.version.length > 0) version = raw.version;
    } catch { /* 설치본인데 package.json 도 없으면 unknown */ }
    return `(설치본 v${version})`;
  }
}

export function defaultOutputPath(repoRoot: string): string {
  return join(repoRoot, 'docs', 'generated', 'graph-anatomy.md');
}

/** 옆 파일 이름. `a.md` → `a.md.json`. */
export function snapshotPathOf(out: string): string {
  return `${out}.json`;
}

function isSnapshot(value: unknown): value is AnatomySnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.generatedAt !== 'string' || typeof record.commit !== 'string') return false;
  if (!record.graphs || typeof record.graphs !== 'object' || Array.isArray(record.graphs)) return false;
  return Object.values(record.graphs as Record<string, unknown>).every((nodes) => Array.isArray(nodes) && nodes.every((node) => typeof node === 'string'));
}

/** 쓰기 전의 옆 파일. 없거나 깨졌으면 null(첫 생성). 파일을 쓰지 않는다. */
export function readPreviousSnapshot(out: string): AnatomySnapshot | null {
  const path = snapshotPathOf(out);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return isSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseFlag(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (index >= 0 && (value === undefined || value.startsWith('--'))) throw new Error(`${name} 에는 경로가 필요하다`);
  return value;
}

export function parseOutArg(argv: readonly string[], fallback: string): string {
  return parseFlag(argv, '--out') ?? fallback;
}

function main(): void {
  const repoRoot = repoRootFromHere();
  const argv = process.argv.slice(2);
  const graphsRoot = parseFlag(argv, '--graphs') ?? join(repoRoot, 'graphs');
  const generatedAt = new Date().toISOString();
  const commit = readCommit(parseFlag(argv, '--repo') ?? repoRoot);
  const out = parseOutArg(argv, defaultOutputPath(repoRoot));
  const scanned = scanGraphDirs(graphsRoot);
  const next = snapshotOf(scanned, commit, generatedAt);
  const prev = readPreviousSnapshot(out);
  const markdown = renderGraphAnatomy({ graphsRoot, commit, generatedAt }, renderYesterdaySection(prev, next));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, markdown);
  writeFileSync(snapshotPathOf(out), `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(`${out}\n`);
}

if (import.meta.main) main();
