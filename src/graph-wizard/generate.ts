/**
 * GRAPH-WIZARD — 말 한 줄(또는 대화 한 턴)에서 그래프 YAML 을 짓는다.
 *
 * 목표: «플러그인 마법사처럼 그래프도 말로 말하면 컨셉으로 생겨나게 · 채팅으로 쭉 치면 노드와 간선이 쭉 만들어진다».
 *
 * 흐름: ① 가장 가까운 기존 템플릿(graphs/**)을 고른다(키워드 점수 — LLM 이 목록에서 다시 고를 수 있다)
 *       ② LLM 이 «알려진 노드 종류·스키마»만으로 YAML 을 쓴다(편집이면 currentYaml 을 고쳐 «전체»를 돌려준다)
 *       ③ API 와 «같은» 검증기(validateGraphYaml)로 재고, 실패면 문제를 되먹여 최대 3회.
 * ⛔ 저장하지 않는다 — 저장은 편집기의 기존 POST /v1/graphs 몫이다.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { debug } from '../debug/log.js';
import { listNodeKinds, type GraphKind } from '../graph-kinds/registry.js';
import { validateGraphYaml } from '../nexus/api/graph-kinds.js';
import { defaultGraphsDir } from '../self-implement/graph-templates.js';
import { WORKFLOW_SYNTH_SYSTEM_PROMPT } from '../workflow-synth/system-prompt.js';
import { WIZARD_ARCHETYPES } from './archetypes.js';
import { WIZARD_MAX_RETRIES, WIZARD_STEPS, WIZARD_STEP_IDS, recipesYamlFor, type WizardNodeStep } from './steps.js';

export interface GraphWizardTurn { role: 'user' | 'assistant'; text: string }

export interface GraphWizardRequest {
  prompt: string;
  kind?: GraphKind;
  /** 있으면 prompt 는 «이 그래프를 고치라»는 지시다 — 결과는 고친 «전체» YAML. */
  currentYaml?: string;
  history?: GraphWizardTurn[];
}

export interface GraphWizardResult {
  ok: boolean;
  id: string;
  yaml: string;
  base?: string;
  /** 왜 그 기반을 골랐나 — 키워드 · LLM 재선택. */
  baseReason?: string;
  issues: string[];
  attempts: number;
  summary: string;
  /** 노드 id → 한국어 이름 (YAML 노드 줄 주석에서 읽는다). */
  labels?: Record<string, string>;
  /** 노드 id → 서재 단계(·인자). 하니스만. */
  steps?: Record<string, WizardNodeStep>;
  /** 이 그래프 옆에 둘 recipes.yaml — `elanous graph run` 이 cmd/approval 을 여기서 찾는다. 하니스만. */
  recipes?: string;
  /** 실행 가능성 증명: 그 recipes 로 `graph run --dry-run` 을 걸어 본 결과. 하니스만. */
  dryRun?: { status: string; path: string[] };
}

export interface GraphWizardDeps {
  /** LLM 한 번 부르기. 기본 = 역할 `graph-grow` 해석 ⊕ 설정 폴백 체인(streamLLM). */
  callLLM?: (prompt: string) => Promise<string>;
  /** 템플릿 뿌리(기본 graphs/). */
  graphsDir?: string;
  /** 이미 쓰인 graph_id(핵심 ⊕ 내 그래프). 기본 = graphs/** ⊕ <state>/graphs. */
  existingIds?: () => ReadonlySet<string>;
  maxAttempts?: number;
}

export const GRAPH_WIZARD_MAX_ATTEMPTS = 3;

/** 요청 자체가 틀렸다(400) — LLM 실패(502)와 가른다. */
export class GraphWizardInputError extends Error { override name = 'GraphWizardInputError'; }
const GRAPH_ID = /^[a-z0-9-]+$/;

interface TemplateEntry { id: string; description: string; text: string; runnable: boolean; keywords?: string[] }

function walkYaml(dir: string, depth = 0): string[] {
  if (depth > 3 || !existsSync(dir)) return [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  return names.flatMap((name) => {
    if (name.startsWith('.') || name === 'overlays' || name === 'catalog') return [];
    const path = join(dir, name);
    let dirLike = false;
    try { dirLike = statSync(path).isDirectory(); } catch { return []; }
    if (dirLike) return walkYaml(path, depth + 1);
    return /\.ya?ml$/.test(name) && !/^recipes\.ya?ml$/.test(name) ? [path] : [];
  });
}

function graphIdOf(text: string): string | undefined {
  try {
    const raw = parseYaml(text) as { graph_id?: unknown; name?: unknown } | null;
    if (raw && typeof raw === 'object') {
      if (typeof raw.graph_id === 'string') return raw.graph_id;
      if (typeof raw.name === 'string') return raw.name;
    }
  } catch { /* not a graph */ }
  return undefined;
}

/** 검증을 통과하는 하니스 템플릿만 «기반» 후보가 된다 — 깨진 표본을 보여주면 깨진 것을 배운다. */
export function listWizardTemplates(dir = defaultGraphsDir()): TemplateEntry[] {
  // 원형이 맨 앞 — 사람이 말로 시키는 일의 뼈대(운영 템플릿은 개발·출시 루프라 말과 낱말이 안 겹친다).
  const out: TemplateEntry[] = WIZARD_ARCHETYPES.map((a) => ({ id: a.id, description: a.description, text: a.text, runnable: true, keywords: a.keywords }));
  const seen = new Set<string>(out.map((t) => t.id));
  for (const file of walkYaml(dir)) {
    let text: string;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    let raw: Record<string, unknown> | null;
    try { raw = parseYaml(text) as Record<string, unknown> | null; } catch { continue; }
    if (!raw || typeof raw.graph_id !== 'string' || seen.has(raw.graph_id)) continue;
    if (!validateGraphYaml('harness', text).ok) continue;
    const loop = (raw.loop ?? {}) as { title?: unknown; description?: unknown };
    const description = [loop.title, loop.description].filter((v): v is string => typeof v === 'string').join(' — ') || raw.graph_id;
    const terminals = Array.isArray(raw.terminal_nodes) ? raw.terminal_nodes : [];
    seen.add(raw.graph_id);
    out.push({ id: raw.graph_id, description: description.slice(0, 160), text, runnable: terminals.every((t) => t === 'done' || t === 'failed') });
  }
  return out;
}

function grams(text: string): Set<string> {
  const lower = text.toLowerCase();
  const out = new Set<string>();
  for (const word of lower.split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    if (/^[a-z0-9]+$/.test(word)) { if (word.length > 2) out.add(word); continue; }
    for (let i = 0; i + 1 < word.length; i += 1) out.add(word.slice(i, i + 2));
  }
  return out;
}

export interface BasePick { template: TemplateEntry; reason: string }

/**
 * 원형 키워드(낱말이 말 안에 있으면 3점) ⊕ 설명 한글 2-gram 겹침(1점)으로 가장 가까운 «실행 가능한» 템플릿.
 * 동점이면 원형이 앞선다(목록 순서). 0점이면 «모아서 요약해 보내기» 원형. 이유를 함께 낸다.
 */
export function pickBaseTemplate(prompt: string, templates: readonly TemplateEntry[]): BasePick | undefined {
  const lower = prompt.toLowerCase();
  const wanted = grams(prompt);
  let best: BasePick | undefined;
  let bestScore = 0;
  for (const template of templates) {
    if (!template.runnable) continue;
    const hits = (template.keywords ?? []).filter((k) => lower.includes(k));
    const have = grams(`${template.id} ${template.description}`);
    let overlap = 0;
    for (const g of wanted) if (have.has(g)) overlap += 1;
    const score = hits.length * 3 + overlap;
    if (score > bestScore) {
      bestScore = score;
      best = { template, reason: hits.length ? `키워드 ${hits.slice(0, 5).join('·')}` : `설명 낱말 겹침 ${overlap}` };
    }
  }
  if (best) return best;
  const fallback = templates.find((t) => t.id === WIZARD_ARCHETYPES[0]!.id) ?? templates.find((t) => t.runnable);
  return fallback ? { template: fallback, reason: '겹치는 낱말이 없어 기본 원형' } : undefined;
}

export function existingGraphIds(dirs: readonly string[]): Set<string> {
  const ids = new Set<string>();
  for (const dir of dirs) {
    for (const file of walkYaml(dir)) {
      try { const id = graphIdOf(readFileSync(file, 'utf8')); if (id) ids.add(id); } catch { /* unreadable */ }
    }
  }
  return ids;
}

/** 슬러그 ⊕ 짧은 해시. 기존 id 와 겹치면 접미로 비켜 간다 — 덮어쓰지 않는다. */
export function wizardGraphId(prompt: string, hint: string | undefined, taken: ReadonlySet<string>): string {
  const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').filter(Boolean).slice(0, 5).join('-').slice(0, 40).replace(/-+$/, '');
  const stem = slugify(hint ?? '') || slugify(prompt) || 'graph';
  const hash = createHash('sha256').update(prompt).digest('hex').slice(0, 6);
  let id = `${stem}-${hash}`;
  for (let n = 2; taken.has(id); n += 1) id = `${stem}-${hash}-${n}`;
  return id;
}

export const HARNESS_EXAMPLE = `graph_id: example-digest
loop:
  title: 예시 — 뉴스를 모아 요약하고 승인 뒤 보낸다
  description: 뉴스를 검색해 요약하고 품질을 본 뒤 사람 승인을 받아 텔레그램으로 보낸다
  trigger:
    cron: "0 8 * * *"
version: 1
entry_node: collect
terminal_nodes: [done, failed]
nodes:
  - { node_id: collect, kind: agent, recipe: 'cmd:collect', max_visits: 1 }  # 뉴스 수집 | web-search | 오늘 AI 뉴스
  - { node_id: summarize, kind: agent, recipe: 'cmd:summarize', max_visits: 2 }  # 요약 | summarize | 핵심 5줄 한국어 요약
  - { node_id: check, kind: judge, recipe: 'cmd:check', max_visits: 2 }  # 요약 품질 판정 | check | 사실에 맞고 5줄 이내
  - { node_id: approve, kind: hitl, recipe: 'approval:approve', max_visits: 1 }  # 발송 승인 | approval
  - { node_id: send, kind: agent, recipe: 'cmd:send', max_visits: 1 }  # 텔레그램 발송 | telegram-send
  - { node_id: done, kind: gate, recipe: none, max_visits: 1 }  # 완료
  - { node_id: failed, kind: gate, recipe: none, max_visits: 1 }  # 실패
edges:
  - { from: collect, on: outcome, map: { ok: summarize, fail: failed } }
  - { from: summarize, on: outcome, map: { ok: check, fail: failed } }
  - { from: check, on: outcome, map: { ok: approve, rework: summarize, fail: failed } }
  - { from: approve, on: outcome, map: { ok: send, fail: failed } }
  - { from: send, on: outcome, map: { ok: done, fail: failed } }
`;

export const WORKFLOW_EXAMPLE = `name: example-digest
description: 자료를 모아 요약하고 승인 뒤 보낸다
nodes:
  - id: collect
    bash: "echo collect"
  - id: summarize
    prompt: "다음을 다섯 줄로 요약하라: $collect.output"
    depends_on: [collect]
  - id: approve
    approval:
      message: "요약을 보낼까요?"
    depends_on: [summarize]
  - id: send
    bash: "echo send"
    depends_on: [approve]
`;

function harnessRules(kinds: string): string {
  return [
    '스키마(하니스 실행 그래프 · YAML):',
    '- 최상위: graph_id, loop{title, description, trigger{cron|events}}, version: 1, entry_node, terminal_nodes: [done, failed], nodes, edges.',
    `- nodes[]: { node_id(kebab-case 영문), kind, recipe, max_visits(1 이상 정수) }. kind 는 이것만: ${kinds}.`,
    "- recipe 는 셋 중 하나뿐: 'none'(done·failed 같은 끝 노드), 'cmd:<kebab-id>'(실행 단계), 'approval:<kebab-id>'(사람 승인 — kind: hitl).",
    '- 끝 노드는 정확히 done 과 failed 두 개(kind: gate, recipe: none). 다른 끝 노드를 만들지 마라.',
    '- edges[]: { from, on: outcome, map: { ok: <다음>, fail: failed, <다른 결과>: <노드> } } — 모든 노드가 entry 에서 닿아야 하고, done·failed 외 노드는 나가는 간선이 있어야 한다.',
    '- 되돌아가는 고리(재작업)는 map 의 다른 결과로 앞 노드를 가리키고, 그 노드의 max_visits 를 2~3 으로.',
    '- 다른 키(contract, progress 등)는 쓰지 마라.',
    '',
    '노드 줄 형식(필수): 노드는 한 줄 흐름식 `- { node_id: …, kind: …, recipe: …, max_visits: … }` 으로 쓰고, 줄 끝 주석에 `# <한국어 이름> | <단계> | <인자>` 를 단다.',
    '- 한국어 이름은 사용자가 화면에서 보는 노드 이름이다(예: 뉴스 수집). 끝 노드는 `# 완료` · `# 실패`. 승인 노드는 `# <이름> | approval`.',
    "- cmd: 노드의 <단계> 는 아래 서재 중 하나다. 맞는 것이 없을 때만 custom(외부 연동 · 실행 시 «미구현»으로 실패). 인자에 `|`·`#` 을 쓰지 마라.",
    ...WIZARD_STEPS.map((step) => `  · ${step.id} — ${step.use} (결과: ${step.outcomes.join('/')})`),
    '- 간선 map 키는 그 단계가 내는 결과를 쓴다(예: check → ok/rework, retry-gate → retry/give-up, gh-pr-review → ok/must-fix).',
    '- «실패하면 다시 시도하고 N번 넘으면 알려줘» 패턴(간선을 늘리지 않는다): 재시도는 «단계 안»에서 한다 — 각 cmd 노드 주석 끝에 `| retry=N` 을 붙인다(인자가 없으면 `# 이름 | 단계 | | retry=N`). 재시도 노드·되돌이 간선을 만들지 마라. 알림 노드(notify-me) «하나»만 더하고, 실행 노드들의 `fail: failed` 를 `fail: <알림 노드>` 로 바꾸고, 알림 노드는 `{ ok: failed, fail: failed }`.',
  ].join('\n');
}

/** 워크플로 어휘는 `elanous wf synth` 의 시스템 프롬프트를 «그대로» 재사용한다(노드 변형·본문 모양·예시). 출력 형식만 이 마법사 것을 쓴다. */
function workflowRules(kinds: string): string {
  return [
    '--- wf synth 어휘(재사용 · 그 안의 «# Output» 절은 무시하고 아래 출력 형식을 따른다) ---',
    WORKFLOW_SYNTH_SYSTEM_PROMPT.trim(),
    '--- 끝 ---',
    '스키마(워크플로 · YAML):',
    '- 최상위: name(kebab-case), description, nodes.',
    `- nodes[]: { id, <종류 키 하나>, depends_on?: [id…] }. 종류: ${kinds}. 흔한 것 = prompt: "<지시>", bash: "<명령>", approval: { message }.`,
    '- 순환 금지 · depends_on 은 선언된 id 만.',
  ].join('\n');
}

function extractYaml(text: string): string {
  const fence = /```(?:ya?ml)?\s*\n([\s\S]*?)```/i.exec(text);
  const body = fence ? fence[1]! : text.split('\n').filter((line) => !/^\s*(BASE|SLUG|SUMMARY)\s*:/.test(line)).join('\n');
  return body.trim() + '\n';
}

function lineValue(text: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'mi').exec(text.split('```')[0] ?? '');
  return match?.[1]?.trim().replace(/^['"`]|['"`]$/g, '') || undefined;
}

/** 선언된 id 줄만 바꾼다 — 나머지 바이트(주석 포함)는 그대로. */
function forceId(yaml: string, kind: GraphKind, id: string): string {
  const key = kind === 'harness' ? 'graph_id' : 'name';
  const re = new RegExp(`^([ \\t]*${key}:[ \\t]*)([^\\n#]*?)([ \\t]*(?:#.*)?)$`, 'm');
  return re.test(yaml) ? yaml.replace(re, `$1${id}$3`) : `${key}: ${id}\n${yaml}`;
}

function fmtIssue(issue: unknown): string {
  if (typeof issue === 'string') return issue;
  if (issue && typeof issue === 'object') {
    const { path, message } = issue as { path?: unknown; message?: unknown };
    if (typeof message === 'string') return typeof path === 'string' && path ? `${path}: ${message}` : message;
  }
  return JSON.stringify(issue);
}

/** API 검증기 ⊕ (하니스) `elanous graph run` 이 실제로 받는 모양 — 통과해도 못 도는 그래프를 «ok» 라 하지 않는다. */
export function validateWizardYaml(kind: GraphKind, yaml: string): string[] {
  const checked = validateGraphYaml(kind, yaml);
  const issues = checked.errors.map(fmtIssue);
  if (kind !== 'harness' || issues.length > 0) return issues;
  const raw = parseYaml(yaml) as { terminal_nodes?: unknown; nodes?: Array<{ node_id?: unknown; kind?: unknown; recipe?: unknown }> };
  const terminals = Array.isArray(raw.terminal_nodes) ? raw.terminal_nodes : [];
  for (const t of terminals) if (t !== 'done' && t !== 'failed') issues.push(`terminal_nodes: '${String(t)}' — 끝 노드는 done·failed 만 쓴다`);
  for (const node of raw.nodes ?? []) {
    const recipe = typeof node.recipe === 'string' ? node.recipe : '';
    if (recipe !== 'none' && !/^(cmd|approval):[a-z0-9][a-z0-9-]*$/.test(recipe)) {
      issues.push(`nodes/${String(node.node_id)}/recipe: '${recipe}' — none · cmd:<id> · approval:<id> 중 하나여야 한다`);
    }
  }
  return issues;
}

/** 노드 줄 끝 주석 `# 이름 | 단계 | 인자` 를 읽는다. 흐름식 노드 줄에서만. */
export function parseNodeAnnotations(yaml: string): Record<string, WizardNodeStep> {
  const out: Record<string, WizardNodeStep> = {};
  for (const line of yaml.split('\n')) {
    const match = /node_id:\s*['"]?([a-z0-9][a-z0-9-]*)['"]?[^#]*\}\s*#\s*(.+)$/.exec(line);
    if (!match) continue;
    const parts = match[2]!.split('|').map((part) => part.trim());
    let retries: number | undefined;
    const retryAt = parts.findIndex((part, index) => index >= 2 && /^retry\s*=\s*\d+$/i.test(part));
    if (retryAt >= 0) retries = Number.parseInt(parts.splice(retryAt, 1)[0]!.split('=')[1]!, 10);
    const [label, step, ...rest] = parts;
    const arg = rest.join('|').trim();
    out[match[1]!] = { ...(label ? { label } : {}), ...(step ? { step } : {}), ...(arg ? { arg } : {}), ...(retries ? { retries } : {}) };
  }
  return out;
}

/** cmd 노드마다 서재 단계가 있는지 — 없으면 «이름만 있는» 노드라 실제로 못 돈다. */
export function stepIssues(yaml: string, steps: Record<string, WizardNodeStep>): string[] {
  const raw = parseYaml(yaml) as {
    nodes?: Array<{ node_id?: unknown; kind?: unknown; recipe?: unknown }>;
    edges?: Array<{ from?: unknown; to?: unknown; map?: Record<string, unknown> }>;
  };
  const issues: string[] = [];
  const recipeOwner = new Map<string, string>();
  const kindOf = new Map((raw.nodes ?? []).map((n) => [String(n.node_id), String(n.kind)]));
  for (const node of raw.nodes ?? []) {
    const id = String(node.node_id);
    const recipe = typeof node.recipe === 'string' ? node.recipe : '';
    const meta = steps[id];
    // recipes.yaml 은 recipe 이름으로 한 줄 — 두 노드가 같은 이름을 쓰면 둘째 노드의 단계·인자가 사라진다.
    if (recipe !== 'none' && recipeOwner.has(recipe)) issues.push(`nodes/${id}: recipe '${recipe}' 를 ${recipeOwner.get(recipe)} 도 쓴다 — 노드마다 고유한 recipe 이름(보통 cmd:<node_id>)`);
    else recipeOwner.set(recipe, id);
    if ((meta?.retries ?? 0) > WIZARD_MAX_RETRIES) issues.push(`nodes/${id}: retry=${meta!.retries} — 최대 ${WIZARD_MAX_RETRIES}`);
    // 머지는 사람 승인 «뒤»에만 — 들어오는 간선이 전부 hitl 노드에서 와야 한다.
    if (meta?.step === 'gh-pr-merge') {
      const sources = (raw.edges ?? []).filter((e) => e.to === id || Object.values(e.map ?? {}).includes(id)).map((e) => String(e.from));
      if (sources.length === 0 || sources.some((from) => kindOf.get(from) !== 'hitl')) issues.push(`nodes/${id}: PR 머지 앞에는 사람 승인(kind: hitl) 노드만 올 수 있다`);
    }
    if (!meta?.label) issues.push(`nodes/${id}: 줄 끝 주석 \`# <한국어 이름> | …\` 이 없다`);
    if (recipe.startsWith('cmd:') && !(meta?.step && WIZARD_STEP_IDS.has(meta.step))) {
      issues.push(`nodes/${id}: cmd 노드의 단계가 서재(${[...WIZARD_STEP_IDS].join(', ')})에 없다 — 주석 \`# 이름 | <단계> | <인자>\``);
    }
  }
  return issues;
}

/** 실제 recipes 로 `graph run --dry-run` 을 걸어 «도는가»를 잰다(명령 실행 0). */
export async function dryRunWizardGraph(yaml: string, recipes: string): Promise<{ status: string; path: string[]; error?: string }> {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { runGraph } = await import('../graph-runner/runner.js');
  const dir = mkdtempSync(join(tmpdir(), 'elanous-graph-wizard-'));
  try {
    writeFileSync(join(dir, 'graph.yaml'), yaml);
    writeFileSync(join(dir, 'recipes.yaml'), recipes);
    const state = await runGraph(join(dir, 'graph.yaml'), { dryRun: true, deps: { root: join(dir, 'state'), log: () => {} } });
    return { status: state.status, path: state.path };
  } catch (error) {
    return { status: 'error', path: [], error: error instanceof Error ? error.message : String(error) };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

interface Shape { nodes: string[]; labels: Record<string, string>; retries: Record<string, number>; edges: Map<string, string> }
function shapeOf(kind: GraphKind, yaml: string | undefined): Shape {
  const empty: Shape = { nodes: [], labels: {}, retries: {}, edges: new Map() };
  if (!yaml) return empty;
  try {
    const raw = parseYaml(yaml) as Record<string, unknown>;
    const nodes = Array.isArray(raw.nodes) ? raw.nodes as Array<Record<string, unknown>> : [];
    if (kind === 'workflow') {
      const edges = new Map<string, string>();
      for (const n of nodes) for (const d of Array.isArray(n.depends_on) ? n.depends_on : []) edges.set(`${String(d)}>${String(n.id)}`, String(n.id));
      return { ...empty, nodes: nodes.map((n) => String(n.id)), edges };
    }
    // 간선 = (from, 결과) → to. 같은 칸의 목적지만 바뀌면 «재연결»이지 새 간선이 아니다.
    const edges = new Map<string, string>();
    for (const e of Array.isArray(raw.edges) ? raw.edges as Array<Record<string, unknown>> : []) {
      if (typeof e.to === 'string') { edges.set(`${String(e.from)}:*`, e.to); continue; }
      const map = e.map && typeof e.map === 'object' ? e.map as Record<string, unknown> : {};
      for (const [outcome, to] of Object.entries(map)) edges.set(`${String(e.from)}:${outcome}`, String(to));
    }
    const notes = parseNodeAnnotations(yaml);
    return {
      nodes: nodes.map((n) => String(n.node_id)), edges,
      labels: Object.fromEntries(Object.entries(notes).filter(([, v]) => v.label).map(([k, v]) => [k, v.label!])),
      retries: Object.fromEntries(Object.entries(notes).filter(([, v]) => v.retries).map(([k, v]) => [k, v.retries!])),
    };
  } catch { return empty; }
}

/** 결정적 변경 요약 — LLM 의 한 줄 요약이 없거나 틀려도 «무엇이 바뀌었나»는 센 값으로 남는다. 노드 이름은 한국어 라벨. */
export function summarizeChange(kind: GraphKind, before: string | undefined, after: string): string {
  const a = shapeOf(kind, before);
  const b = shapeOf(kind, after);
  const name = (id: string) => b.labels[id] ?? a.labels[id] ?? id;
  if (!before) return `새 그래프: 노드 ${b.nodes.length}개 (${b.nodes.map(name).join(' → ')}) · 간선 ${b.edges.size}개`;
  const added = b.nodes.filter((n) => !a.nodes.includes(n));
  const removed = a.nodes.filter((n) => !b.nodes.includes(n));
  let edgesAdded = 0;
  let rewired = 0;
  for (const [key, to] of b.edges) {
    if (!a.edges.has(key)) edgesAdded += 1;
    else if (a.edges.get(key) !== to) rewired += 1;
  }
  const edgesRemoved = [...a.edges.keys()].filter((key) => !b.edges.has(key)).length;
  const retryChanged = b.nodes.filter((n) => (b.retries[n] ?? 0) !== (a.retries[n] ?? 0));
  const parts: string[] = [];
  if (added.length) parts.push(`노드 ${added.length}개 추가: ${added.map(name).join(' → ')}`);
  if (removed.length) parts.push(`노드 ${removed.length}개 삭제: ${removed.map(name).join(', ')}`);
  if (edgesAdded) parts.push(`간선 ${edgesAdded}개 추가`);
  if (edgesRemoved) parts.push(`간선 ${edgesRemoved}개 삭제`);
  if (rewired) parts.push(`간선 ${rewired}개 재연결`);
  if (retryChanged.length) parts.push(`재시도 설정 ${retryChanged.length}개 노드(${retryChanged.map((n) => `${name(n)} ${b.retries[n] ?? 0}회`).join(', ')})`);
  return parts.length ? parts.join(' · ') : '구조 변경 없음';
}

async function defaultCallLLM(prompt: string): Promise<string> {
  const [{ PROVIDERS, streamLLM }, { getUserConfig }, { graphGrowthLlmOptions }] = await Promise.all([
    import('../llm.js'), import('../user-config.js'), import('../graph-runner/graph-grow-llm.js'),
  ]);
  const selected = graphGrowthLlmOptions(getUserConfig());
  return streamLLM([{ role: 'user', content: prompt }], () => {}, {
    ...(selected.model ? { model: selected.model, provider: PROVIDERS[selected.provider!] } : {}),
    reasoningEffort: 'low',
  });
}

function buildPrompt(input: {
  req: GraphWizardRequest; kind: GraphKind; id: string; base?: TemplateEntry; templates: readonly TemplateEntry[];
  previous?: { yaml: string; issues: string[] };
}): string {
  const { req, kind, id, base, templates, previous } = input;
  const kinds = listNodeKinds(kind).map((k) => k.kind).join(', ');
  const editing = typeof req.currentYaml === 'string' && req.currentYaml.trim() !== '';
  const lines: string[] = [
    '너는 엘라누스 «그래프 마법사»다. 사용자의 말을 실행 그래프 YAML 로 짓는다.',
    kind === 'harness' ? harnessRules(kinds) : workflowRules(kinds),
    `- ${kind === 'harness' ? 'graph_id' : 'name'} 는 정확히 "${id}" 로 쓴다.`,
    '- 노드 id 는 사용자의 업무 단계를 드러내는 짧은 영문 kebab-case(예: collect-news, summarize, send-telegram). 단계 수는 3~10개.',
    '- 사용자가 말한 것만 짓는다. 승인(hitl)·품질 판정(check)·재시도·알림은 사용자가 말했을 때만 넣는다 — 예외는 PR 머지·결제·공개 게시(외부 공개) 앞의 승인뿐이다. 텔레그램 발송·나에게 알림 앞에는 말하지 않은 승인을 넣지 마라.',
    '',
    '예시(사용자가 «품질을 보고, 내가 승인하면 보내»라고 «말했을 때»의 모양 — 말하지 않은 단계는 넣지 않는다):',
    '```yaml', kind === 'harness' ? HARNESS_EXAMPLE.trim() : WORKFLOW_EXAMPLE.trim(), '```',
  ];
  if (kind === 'harness' && !editing) {
    lines.push('', '기존 템플릿 목록(id — 설명):', ...templates.filter((t) => t.runnable).slice(0, 30).map((t) => `- ${t.id} — ${t.description}`));
    if (base) lines.push('', `가장 가까운 템플릿(${base.id}) — 구조를 참고하라:`, '```yaml', base.text.trim(), '```');
  }
  if (req.history?.length) {
    lines.push('', '지금까지의 대화:', ...req.history.slice(-10).map((t) => `${t.role === 'user' ? '사용자' : '마법사'}: ${t.text.slice(0, 500)}`));
  }
  if (editing) {
    lines.push('', '지금 그래프(이것을 고친다 — 바뀌지 않는 노드의 id 는 그대로 둔다):', '```yaml', req.currentYaml!.trim(), '```',
      '', `사용자의 수정 지시: ${req.prompt}`,
      '최소 변경 규칙: 지시가 요구하는 노드·간선만 더하거나 바꾼다. 나머지 노드 줄(id·kind·recipe·주석)과 간선은 글자 그대로 둔다. id 를 바꾸지 마라. loop.title·description 은 바뀐 내용만 반영한다.',
      '고친 «전체» YAML 을 돌려준다.');
  } else {
    lines.push('', `사용자의 말: ${req.prompt}`);
  }
  if (previous) {
    lines.push('', '직전 시도가 검증에 실패했다. 아래 문제를 «전부» 고쳐 전체 YAML 을 다시 써라:', ...previous.issues.map((i) => `- ${i}`),
      '직전 YAML:', '```yaml', previous.yaml.trim(), '```');
  }
  lines.push('', '출력 형식(이 순서 · 다른 설명 금지):',
    ...(editing || kind !== 'harness' ? [] : ['BASE: <참고한 템플릿 id 또는 none>']),
    'SLUG: <이 그래프를 나타내는 영문 kebab-case 2~4 낱말>',
    'SUMMARY: <무엇을 만들었/바꿨는지 한국어 한 줄 — 예: 노드 2개 추가: 요약 → 텔레그램 발송 · 간선 2개>',
    '```yaml', '<전체 YAML>', '```');
  return lines.join('\n');
}

export async function generateGraphFromPrompt(req: GraphWizardRequest, deps: GraphWizardDeps = {}): Promise<GraphWizardResult> {
  const kind: GraphKind = req.kind === 'workflow' ? 'workflow' : 'harness';
  const prompt = typeof req.prompt === 'string' ? req.prompt.trim() : '';
  if (!prompt) throw new GraphWizardInputError('prompt is required');
  const editing = typeof req.currentYaml === 'string' && req.currentYaml.trim() !== '';
  const graphsDir = deps.graphsDir ?? defaultGraphsDir();
  const templates = kind === 'harness' ? listWizardTemplates(graphsDir) : [];
  const pick = kind === 'harness' && !editing ? pickBaseTemplate(prompt, templates) : undefined;
  const keywordBase = pick?.template;
  let baseReason = pick?.reason;
  const taken = deps.existingIds?.() ?? existingGraphIds([graphsDir, join((await import('../autopilot/state-paths.js')).elanousStateRoot(), 'graphs')]);
  // 편집이면 지금 그래프의 id 를 지킨다 — 캔버스와 저장 경로가 그 id 를 쥐고 있다.
  const currentId = editing ? graphIdOf(req.currentYaml!) : undefined;
  // 편집인데 id 를 지킬 수 없으면(없음·형식 밖) 새 id 로 바꿔 «다른 그래프»를 돌려주지 않고 거절한다.
  if (editing && !(currentId && GRAPH_ID.test(currentId))) {
    debug.log('graph.wizard', 'rejected', { reason: 'current-id-invalid', kind });
    throw new GraphWizardInputError(`currentYaml has no valid ${kind === 'harness' ? 'graph_id' : 'name'} ([a-z0-9-])`);
  }
  let id = editing ? currentId! : wizardGraphId(prompt, undefined, taken);
  const callLLM = deps.callLLM ?? defaultCallLLM;
  const maxAttempts = Math.max(1, deps.maxAttempts ?? GRAPH_WIZARD_MAX_ATTEMPTS);
  let base = keywordBase?.id;
  let yaml = '';
  let issues: string[] = [];
  let llmSummary: string | undefined;
  let attempts = 0;
  let steps: Record<string, WizardNodeStep> = {};
  let recipes: string | undefined;
  let dryRun: { status: string; path: string[] } | undefined;
  const startedAt = Date.now();
  debug.log('graph.wizard', 'start', { kind, editing, base, id, prompt: prompt.slice(0, 300), historyTurns: req.history?.length ?? 0 });
  for (attempts = 1; attempts <= maxAttempts; attempts += 1) {
    let text: string;
    try {
      text = await callLLM(buildPrompt({ req: { ...req, prompt }, kind, id, base: keywordBase, templates,
        ...(attempts > 1 ? { previous: { yaml, issues } } : {}) }));
    } catch (error) {
      debug.log('graph.wizard', 'error', { id, kind, attempt: attempts, base, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    if (attempts === 1 && !editing) {
      const picked = lineValue(text, 'BASE');
      if (picked && picked !== base && templates.some((t) => t.id === picked)) { base = picked; baseReason = `LLM 재선택 (키워드 후보 ${keywordBase?.id ?? '-'})`; }
      const slug = lineValue(text, 'SLUG');
      if (slug && !currentId) id = wizardGraphId(prompt, slug, taken);
    }
    llmSummary = lineValue(text, 'SUMMARY') ?? llmSummary;
    yaml = forceId(extractYaml(text), kind, id);
    try { issues = validateWizardYaml(kind, yaml); }
    catch (error) { issues = [`검증 실패: ${error instanceof Error ? error.message : String(error)}`]; }
    steps = kind === 'harness' ? parseNodeAnnotations(yaml) : {};
    recipes = undefined;
    dryRun = undefined;
    if (kind === 'harness' && issues.length === 0) {
      issues = stepIssues(yaml, steps);
      const nodes = ((parseYaml(yaml) as { nodes?: Array<{ node_id?: unknown; recipe?: unknown }> }).nodes ?? [])
        .map((n) => ({ nodeId: String(n.node_id), recipe: typeof n.recipe === 'string' ? n.recipe : '' }));
      recipes = recipesYamlFor(nodes, steps);
      const walked = await dryRunWizardGraph(yaml, recipes);
      dryRun = { status: walked.status, path: walked.path };
      if (walked.status !== 'done') issues.push(`graph run --dry-run: ${walked.status}${walked.error ? ` — ${walked.error}` : ''} (경로 ${walked.path.join(' → ')})`);
    }
    debug.log('graph.wizard', 'attempt', { id, attempt: attempts, base, ok: issues.length === 0, issues: issues.slice(0, 10) });
    if (issues.length === 0) break;
  }
  attempts = Math.min(attempts, maxAttempts);
  const ok = issues.length === 0;
  const counted = summarizeChange(kind, editing ? req.currentYaml : undefined, yaml);
  const summary = llmSummary ? `${llmSummary} (${counted})` : counted;
  debug.log('graph.wizard', ok ? 'validated' : 'failed', { id, kind, base, attempts, editing, issues: issues.slice(0, 10), summary, dryRun: dryRun?.status, ms: Date.now() - startedAt });
  const labels = Object.fromEntries(Object.entries(steps).filter(([, v]) => v.label).map(([k, v]) => [k, v.label!]));
  return { ok, id, yaml, ...(base ? { base } : {}), ...(base && baseReason ? { baseReason } : {}), issues, attempts, summary, labels, steps, ...(recipes ? { recipes } : {}), ...(dryRun ? { dryRun } : {}) };
}

/** v1 이름 유지 — 생성 YAML 의 노드 주석(단계·인자)으로 실제 recipes.yaml 을 낸다(v1 의 «미구현» 자리표시를 대체). */
export function stubRecipesFor(yaml: string): string {
  const raw = parseYaml(yaml) as { nodes?: Array<{ node_id?: unknown; recipe?: unknown }> };
  const nodes = (raw.nodes ?? []).map((n) => ({ nodeId: String(n.node_id), recipe: typeof n.recipe === 'string' ? n.recipe : '' }));
  return recipesYamlFor(nodes, parseNodeAnnotations(yaml));
}
