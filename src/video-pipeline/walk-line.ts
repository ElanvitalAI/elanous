/**
 * 🚶 영상 선언을 레시피로 «걷는» 한 벌 — vlog·film·character 라인 ⊕ `video-pipeline walk` 가 같이 쓴다.
 *
 * 🩸 2026-09-23: 라인 스크립트 셋이 «같은» 걸음 함수(레시피 호출 → state 합치기 → 「못 쟀다」 라우팅 → 흔적)를
 *   각자 복사해 들고 있었다. 셋째 복사본에서 «못 쟀다 → null» 규칙을 빼먹으면 걷는 자가 `no-edge` 로 죽고
 *   「못 쟀다」가 「길이 없다」로 둔갑한다 — 규칙이 한 곳에 있어야 하는 이유다.
 *
 * ⛔ 레시피 표는 «하나»다(`ALL_RECIPES`). 같은 이름이 두 맵에 있으면 뒤가 이긴다 — 📏 2026-09-23 전수:
 *   겹침은 `ink-ruler`(FILM ⊕ CHARACTER) 하나뿐이고, CHARACTER 쪽(`inkRulerAny`)이 입력 모양으로 두 계약을 다 받는다.
 * ⛔ 걷는 자(walker)는 이 저장소 «밖»에 있다(`GRAPH_WALKER` · 기본 ~/temp/agentic-consulting/scripts/graph-walk.ts).
 *   못 찾으면 null — 「못 돌렸다」다. 시험은 걷는 자를 «주입»한다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BROLL } from './recipes/broll.js';
import { CHARACTER } from './recipes/character.js';
import { EXPLAINER } from './recipes/explainer.js';
import { FILM } from './recipes/film.js';
import { FREE_LINE } from './recipes/free-line.js';
import { HYPERFRAMES } from './recipes/hyperframes.js';
import { UPSTREAM } from './recipes/upstream.js';
import { VLOG } from './recipes/vlog.js';
import { UNOBSERVED, type Recipe, type RecipeCtx } from './recipes/types.js';

/** ⛔ 순서가 뜻이다 — 같은 이름이면 뒤가 이긴다. HYPERFRAMES · EXPLAINER 는 기존 키를 덮지 않는다. */
export const ALL_RECIPES: Readonly<Record<string, Recipe>> = { ...UPSTREAM, ...FREE_LINE, ...VLOG, ...FILM, ...CHARACTER, ...HYPERFRAMES, ...BROLL, ...EXPLAINER };

export interface GraphSpecLike {
  readonly graph_id: string;
  readonly nodes: readonly { readonly node_id: string; readonly recipe?: string }[];
  readonly edges: readonly { readonly from: string; readonly to?: string; readonly map?: Record<string, string> }[];
}
export interface WalkerApi {
  readGraphSpec(path: string): { spec?: GraphSpecLike; error?: string };
  walkGraph(spec: GraphSpecLike, step: (node: { node_id: string; recipe?: string }) => Promise<string | null>,
    opts: { state: Record<string, unknown>; unobservedNode: string; maxSteps: number }): Promise<{ terminal: string | null; stopReason: string; steps: { node: string; visit: number }[] }>;
}

export const DEFAULT_WALKER = `${process.env.HOME}/temp/agentic-consulting/scripts/graph-walk.ts`;
export async function loadWalker(path: string = process.env.GRAPH_WALKER ?? DEFAULT_WALKER): Promise<WalkerApi | null> {
  try { const m = await import(path); return m.readGraphSpec && m.walkGraph ? (m as WalkerApi) : null; } catch { return null; }
}

/** `graph_id` → 선언 파일. ⛔ 파일 이름이 아니라 «선언 안의» graph_id 로 찾는다(vlog 는 이름에 `.declaration` 이 붙는다). */
export function findTemplate(graphId: string, dir: string): string | null {
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.yaml')).sort()) {
    const m = /^graph_id:\s*["']?([\w-]+)/m.exec(readFileSync(join(dir, f), 'utf8'));
    if (m?.[1] === graphId) return join(dir, f);
  }
  return null;
}

export interface TraceRow { node: string; recipe: string; outcome: string; note?: string; secs: number }
export interface LineResult {
  terminal: string | null; stopReason: string; steps: number; path: string;
  trace: TraceRow[];
  /** 구현이 «없는» 레시피에서 멎었으면 그 노드. */
  unknownRecipe: string | null;
}

/** 그 노드의 간선이 이 outcome 을 «받나». */
export const accepts = (spec: GraphSpecLike, nodeId: string, outcome: string): boolean =>
  spec.edges.some((e) => e.from === nodeId && (e.to !== undefined || (e.map !== undefined && outcome in e.map)));

export async function walkLine(o: {
  spec: GraphSpecLike; walker: WalkerApi; state: Record<string, unknown>; workdir: string;
  recipes?: Readonly<Record<string, Recipe>>; maxSteps?: number;
  onStep?: (row: TraceRow) => void;
  /** 레시피 «안»의 관측(`ctx.log`). 없으면 버린다. */
  log?: RecipeCtx['log'];
}): Promise<LineResult> {
  const recipes = o.recipes ?? ALL_RECIPES;
  const trace: TraceRow[] = [];
  let unknownRecipe: string | null = null;
  const step = async (node: { node_id: string; recipe?: string }): Promise<string | null> => {
    const name = node.recipe ?? '';
    const r = recipes[name];
    if (!r) { unknownRecipe = `${node.node_id}(${name || '레시피 이름 없음'})`; return null; }
    const t0 = Date.now();
    const ctx: RecipeCtx = { workdir: o.workdir, state: o.state, log: o.log ?? (() => {}) };
    const out = await r(ctx);
    for (const [k, v] of Object.entries(out.produced ?? {})) o.state[k] = v;
    const row: TraceRow = { node: node.node_id, recipe: name, outcome: out.outcome, note: out.note, secs: (Date.now() - t0) / 1000 };
    trace.push(row);
    o.onStep?.(row);
    // ⛔⭐ 「못 쟀다」를 받는 간선이 없는 노드에서 그 문자열을 그대로 넘기면 걷는 자가 «no-edge» 로 죽는다
    //   — 「못 쟀다」가 「길이 없다」로 둔갑한다. ⇒ 받지 않으면 null 로 넘겨 `unobserved` 종단으로 보낸다.
    return out.outcome === UNOBSERVED && !accepts(o.spec, node.node_id, UNOBSERVED) ? null : out.outcome;
  };
  const w = await o.walker.walkGraph(o.spec, step, { state: o.state, unobservedNode: 'unobserved', maxSteps: o.maxSteps ?? 80 });
  return {
    terminal: w.terminal, stopReason: w.stopReason, steps: w.steps.length,
    path: w.steps.map((s) => s.node + (s.visit > 1 ? `#${s.visit}` : '')).join('→'),
    trace, unknownRecipe,
  };
}

/** 라인의 종료 코드 — 0 delivered · 2 「못 쟀다」(unobserved) · 1 그 밖의 종단. */
export const exitCodeOf = (terminal: string | null): number => (terminal === 'delivered' ? 0 : terminal === 'unobserved' ? 2 : 1);

/** 한 걸음을 사람이 읽는 두 줄로. */
export function formatStep(row: TraceRow, pad = 15): string {
  const mark = ['error', 'blocked'].includes(row.outcome) ? '⛔' : '▶';
  return `  ${mark} ${row.node.padEnd(pad)} ${row.recipe.padEnd(28)} → ${row.outcome}  (${row.secs.toFixed(1)}s)${row.note ? `\n     ${row.note}` : ''}`;
}
