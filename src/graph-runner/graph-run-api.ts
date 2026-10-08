// CGE-RUN — 편집기에서 «내 그래프»를 실행하고 노드별 상태를 읽는다.
// 실행은 `elanous graph run` 과 같은 범용 실행기(runGraph)다. 하니스(LLM) 런은 골 종류로만 그래프를 고르므로 여기서 다루지 않는다.
// 그래프와 레시피는 런마다 작업 폴더로 «복사»해서 돌린다 — 실행 중에 편집기가 파일을 바꿔도 이 런은 시작한 판으로 끝난다.
// ⛔ 레시피(실제로 도는 명령)는 «저장소»의 편집기 레시피(`graphs/demo/editor-recipes.yaml`)만 쓴다 — «mine» 폴더는 HTTP 로 쓸 수 있으므로
//    거기 레시피를 읽으면 «편집한 그래프 실행»이 «편집한 명령 실행»이 된다(TC 10-07 19:31). 그래프가 부르는 레시피가 그 목록에 없으면 시작 전에 거부한다.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { elanousStateRoot } from '../autopilot/state-paths.js';
import { debug } from '../debug/log.js';
import { effectiveInstanceRoot } from '../instance/resolve.js';
import { jsonResponse } from '../nexus/api/json-response.js';
import { defaultGraphsDir } from '../self-implement/graph-templates.js';
import { runGraph, type GraphRunState } from './runner.js';

const GRAPH_ID = /^[a-z0-9-]+$/;
const RUN_ID = /^ed-[a-z0-9]+-[a-f0-9]{6}$/;
/** 실행기가 받는 끝 노드 이름(runner.ts — `unsupported terminal node`). 미리 말해 준다. */
const RUNNABLE_TERMINALS = new Set(['done', 'failed']);

export interface GraphRunApiDeps {
  mineDir?: string;
  /** 편집기 실행이 쓰는 레시피 파일(저장소 것만) — 기본 `graphs/demo/editor-recipes.yaml`. */
  recipesFile?: string;
  root?: string;
  run?: typeof runGraph;
  now?: () => number;
}

/** 시작 전에 죽은 런(레시피 없음 등)은 원장 파일이 안 생긴다 — 그 이유를 여기 잠깐 들고 있다가 상태 조회에 돌려준다. */
const startFailures = new Map<string, { error: string; at: string }>();

const mineDirOf = (deps: GraphRunApiDeps) => deps.mineDir ?? join(elanousStateRoot(), 'graphs');
const rootOf = (deps: GraphRunApiDeps) => deps.root ?? effectiveInstanceRoot();

function decodeId(raw: string, pattern: RegExp): string | null {
  try {
    const id = decodeURIComponent(raw);
    return pattern.test(id) ? id : null;
  } catch { return null; }
}

/** 파일 이름이 아니라 선언된 graph_id 로 찾는다(graphs-api 와 같은 규칙). */
function findMine(dir: string, id: string): { file: string; doc: Record<string, unknown> } | null {
  let names: string[];
  try { names = readdirSync(dir).filter((name) => name.endsWith('.yaml') || name.endsWith('.yml')).sort(); }
  catch { return null; }
  for (const name of names) {
    if (name === 'recipes.yaml') continue;
    try {
      const doc: unknown = parseYaml(readFileSync(join(dir, name), 'utf8'));
      if (doc && typeof doc === 'object' && !Array.isArray(doc) && (doc as Record<string, unknown>).graph_id === id) {
        return { file: join(dir, name), doc: doc as Record<string, unknown> };
      }
    } catch { continue; }
  }
  return null;
}

/** 되돌이(순환) 위의 노드가 max_visits 1 이면 두 번째 방문에서 예산 초과로 멈춘다 — 시작 전에 말한다. */
function loopVisitIssues(doc: Record<string, unknown>): string[] {
  const next = new Map<string, Set<string>>();
  for (const edge of Array.isArray(doc.edges) ? doc.edges : []) {
    if (!edge || typeof edge !== 'object') continue;
    const { from, to, map } = edge as Record<string, unknown>;
    if (typeof from !== 'string') continue;
    const targets = [...(typeof to === 'string' ? [to] : []),
      ...(map && typeof map === 'object' ? Object.values(map as Record<string, unknown>).filter((v): v is string => typeof v === 'string') : [])];
    for (const target of targets) (next.get(from) ?? next.set(from, new Set()).get(from)!).add(target);
  }
  const reaches = (start: string, goal: string): boolean => {
    const seen = new Set<string>();
    const stack = [...(next.get(start) ?? [])];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === goal) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      stack.push(...(next.get(id) ?? []));
    }
    return false;
  };
  const issues: string[] = [];
  for (const node of Array.isArray(doc.nodes) ? doc.nodes : []) {
    if (!node || typeof node !== 'object') continue;
    const { node_id: id, max_visits: visits } = node as Record<string, unknown>;
    if (typeof id === 'string' && (typeof visits !== 'number' || visits < 2) && reaches(id, id)) {
      issues.push(`노드 '${id}' 는 되돌이 위에 있는데 max_visits 가 ${typeof visits === 'number' ? visits : '없음'} 이다 — 두 번째 방문에서 멈춘다 · 2 이상으로`);
    }
  }
  return issues;
}

/** 실행기가 받지 않을 모양을 시작 «전»에 사람 말로. 빈 배열이면 돌릴 수 있다. */
export function runnableIssues(doc: Record<string, unknown>, allowedRecipes: ReadonlySet<string>): string[] {
  const issues: string[] = [];
  for (const node of Array.isArray(doc.nodes) ? doc.nodes : []) {
    if (!node || typeof node !== 'object') continue;
    const { node_id: nodeId, recipe } = node as Record<string, unknown>;
    if (typeof recipe !== 'string' || recipe === 'none') continue;
    if (recipe.startsWith('approval:')) { issues.push(`노드 '${String(nodeId)}' 의 승인 레시피 '${recipe}' 는 편집기 데모 실행에서 쓸 수 없다`); continue; }
    const prefixed = /^cmd:(.*)$/.exec(recipe);
    if (prefixed && !allowedRecipes.has(prefixed[1]!)) {
      issues.push(`노드 '${String(nodeId)}' 의 레시피 '${recipe}' 는 편집기 실행 목록에 없다 — 쓸 수 있는 것: ${[...allowedRecipes].map((r) => `cmd:${r}`).join(' · ')}`);
    }
  }
  // grow 는 매핑 안 된 결과에서 LLM 제안기를 부른다 — 데모 실행 범위 밖(하니스 LLM 런은 0.2.21).
  if (doc.grow !== undefined) issues.push('grow(그래프 자라기)는 편집기 데모 실행에서 쓸 수 없다 — grow 줄을 지우고 저장하라');
  issues.push(...loopVisitIssues(doc));
  const terminals = Array.isArray(doc.terminal_nodes) ? doc.terminal_nodes.filter((t): t is string => typeof t === 'string') : [];
  if (!terminals.length) issues.push('끝 노드가 없다 — done 노드를 잇고 끝으로 지정하라');
  for (const t of terminals) if (!RUNNABLE_TERMINALS.has(t)) issues.push(`끝 노드 '${t}' 는 실행할 수 없다 — 끝 노드 이름은 done 또는 failed 여야 한다`);
  return issues;
}

export interface GraphRunNodeView { nodeId: string; ok: boolean; executed: boolean; startedAt?: string; endedAt?: string; error?: string }
export interface GraphRunView {
  graphId: string; runId: string; status: GraphRunState['status'] | 'starting';
  startedAt?: string; finishedAt?: string; path: string[];
  nodes: GraphRunNodeView[]; currentNode?: { nodeId: string; startedAt: string }; error?: string;
}

export function graphRunView(state: GraphRunState): GraphRunView {
  return {
    graphId: state.graphId, runId: state.runId, status: state.status,
    ...(state.startedAt ? { startedAt: state.startedAt } : {}), ...(state.finishedAt ? { finishedAt: state.finishedAt } : {}),
    path: state.path,
    nodes: state.nodes.map((node) => ({
      nodeId: node.nodeId, ok: node.ok, executed: node.executed,
      ...(node.startedAt ? { startedAt: node.startedAt } : {}), ...(node.endedAt ? { endedAt: node.endedAt } : {}),
      ...(node.error ? { error: node.error.slice(0, 300) } : {}),
    })),
    ...(state.currentNode ? { currentNode: state.currentNode } : {}),
  };
}

/** POST /v1/graphs/<id>/run — 내 그래프만 실행한다(핵심 그래프는 복제해서 돌린다). 응답은 기다리지 않는다(202 ⊕ runId). */
export function handleGraphRunStart(rawId: string, deps: GraphRunApiDeps = {}): Response {
  const id = decodeId(rawId, GRAPH_ID);
  if (!id) return jsonResponse({ error: 'bad_request', reason: 'invalid graph id' }, 400);
  const mine = findMine(mineDirOf(deps), id);
  if (!mine) return jsonResponse({ error: 'not-found', id, reason: '내 그래프에만 실행이 있다 — 핵심 그래프는 복제해서 돌린다' }, 404);
  const recipesFile = deps.recipesFile ?? join(defaultGraphsDir(), 'demo', 'editor-recipes.yaml');
  let recipeText: string;
  let allowed: Set<string>;
  try {
    recipeText = readFileSync(recipesFile, 'utf8');
    const parsed: unknown = parseYaml(recipeText);
    allowed = new Set(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : []);
  } catch {
    return jsonResponse({ error: 'recipes-unavailable' }, 503);
  }
  const issues = runnableIssues(mine.doc, allowed);
  if (issues.length) return jsonResponse({ error: 'not-runnable', id, issues }, 422);

  const now = deps.now?.() ?? Date.now();
  const runId = `ed-${now.toString(36)}-${randomBytes(3).toString('hex')}`;
  const root = rootOf(deps);
  const work = join(root, 'graph-run-work', id, runId);
  try {
    mkdirSync(work, { recursive: true });
    copyFileSync(mine.file, join(work, 'graph.yaml'));
    writeFileSync(join(work, 'recipes.yaml'), recipeText);
  } catch (error) {
    return jsonResponse({ error: 'run-workspace-failed', reason: error instanceof Error ? error.message.slice(0, 200) : 'unknown' }, 500);
  }
  debug.log('graphs.run', 'started', { id, runId });
  void (deps.run ?? runGraph)(join(work, 'graph.yaml'), { runId, input: { source: 'editor' }, deps: { root } })
    .then((state) => debug.log('graphs.run', 'finished', { id, runId, status: state.status, executed: state.executed }))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      startFailures.set(runId, { error: message.slice(0, 300), at: new Date().toISOString() });
      if (startFailures.size > 50) startFailures.delete(startFailures.keys().next().value!);
      debug.log('graphs.run', 'failed', { id, runId, error: message.slice(0, 200) }, { level: 'warn' });
    });
  return jsonResponse({ id, runId, demo: true }, 202);
}

/** GET /v1/graphs/<id>/runs/<runId> — 원장 그대로(노드별 ok·시각 · 지금 노드). 원장이 아직 없으면 starting, 시작 전에 죽었으면 failed ⊕ 이유. */
export function handleGraphRunGet(rawId: string, rawRunId: string, deps: GraphRunApiDeps = {}): Response {
  const id = decodeId(rawId, GRAPH_ID);
  const runId = decodeId(rawRunId, RUN_ID);
  if (!id || !runId) return jsonResponse({ error: 'bad_request', reason: 'invalid id' }, 400);
  const file = join(rootOf(deps), 'graph-runs', id, `${runId}.json`);
  let state: GraphRunState | null = null;
  try { state = JSON.parse(readFileSync(file, 'utf8')) as GraphRunState; } catch { state = null; }
  if (state && state.graphId === id && state.runId === runId) return jsonResponse(graphRunView(state));
  const failed = startFailures.get(runId);
  if (failed) return jsonResponse({ graphId: id, runId, status: 'failed', path: [], nodes: [], error: failed.error } satisfies GraphRunView);
  if (!existsSync(join(rootOf(deps), 'graph-run-work', id, runId))) return jsonResponse({ error: 'not-found', id, runId }, 404);
  return jsonResponse({ graphId: id, runId, status: 'starting', path: [], nodes: [] } satisfies GraphRunView);
}

const RUN_START = /^\/v1\/graphs\/([^/]+)\/run$/;
const RUN_GET = /^\/v1\/graphs\/([^/]+)\/runs\/([^/]+)$/;

/** http-server 가 인증 «뒤»에 부른다. 이 두 길이 아니면 null. */
export function handleGraphRunRoute(method: string, pathname: string, deps: GraphRunApiDeps = {}): Response | null {
  const start = RUN_START.exec(pathname);
  if (start && method === 'POST') return handleGraphRunStart(start[1]!, deps);
  const get = RUN_GET.exec(pathname);
  if (get && method === 'GET') return handleGraphRunGet(get[1]!, get[2]!, deps);
  return null;
}
