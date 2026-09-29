// Live 탭 «판단 그래프»(기획 §0b ②) — 판단 스트림·런·성적표를 노드·간선으로 접는다(순수 · 시험 대상).
// 세 겹(🅢 09-28 08:4x): 가운데 하니스 → 런 → 페이즈(저작·분해·구현·게이트·리뷰·착지) → 조각·PR.
// 모델·행선지(계정·Pod·경로)는 바깥 고리. 간선 색 = 판단 종류 · 런의 «지금» 페이즈가 맥박.
// 물리(힘) 한 걸음도 여기 둔다 — 캔버스는 그리기만. 의존성 없음(노드 20~40 이라 O(n²) 로 충분).

import { LIVE_STAGES, LIVE_STAGE_LABEL, type DecisionKind, type LiveBoardData, type LiveStage } from './live-signals';
import type { UsageReq } from './live-v5';

export type GraphNodeKind = 'harness' | 'run' | 'phase' | 'pr' | 'model' | 'target' | 'event' | 'site' | 'account' | 'request' | 'universe' | 'piece' | 'pod';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** 크기 가중(요청 수·판단 수) — 1 이상. */
  weight: number;
  /** 페이즈 노드 — 그 런의 «지금» 단계면 맥박. */
  current?: boolean;
  /** 페이즈 노드 — 같은 단계에 다시 들어간 횟수(재시도 고리). */
  retries?: number;
  /** 페이즈 노드 — 마지막으로 본 성격. */
  tone?: 'ok' | 'bad' | 'info';
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: DecisionKind;
}

export interface JudgmentGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const MAX_RUNS = 12;
const MAX_MODELS = 6;
const MAX_TARGETS = 10;
/** 페이즈 겹을 펼치는 런 수 — 노드가 100 을 넘지 않게(O(n²) 물리). */
const MAX_PHASE_RUNS = 8;

/** 단계 → 간선 색(판단 종류). 막힌 단계는 ESCALATE. */
const STAGE_KIND: Record<LiveStage, DecisionKind> = { author: 'PLAN', decompose: 'PLAN', build: 'ROUTE', gate: 'VERIFY', review: 'VERIFY', land: 'SHIP' };

export const phaseId = (runId: string, stage: LiveStage) => `phase:${runId}:${stage}`;

/** 바깥 고리 노드 — 모델·행선지. */
const OUTER: ReadonlySet<GraphNodeKind> = new Set(['model', 'target', 'account', 'universe', 'pod']);
/** v5 밀도 — 신호 종류 노드 상한(물리 O(n²) · 노드 400 안쪽). */
const MAX_EVENTS = 180;
/** v5 밀도 — LLM 요청 한 건 = 점 하나(최근부터 · 상한). */
const MAX_REQUESTS = 220;

/** 그래프 밀도 재료(v5) — 없으면 v4 모양 그대로. */
export interface GraphExtra {
  events?: ReadonlyArray<{ runId: string; key: string; label: string; stage: LiveStage | null; count: number; bad: boolean }>;
  reqs?: readonly UsageReq[];
  /** 런 → 우주(연합 조회) — 바깥 고리 «우주» 노드. */
  universes?: ReadonlyArray<{ runId: string; instance: string }>;
  /** 기획 트리 — 런마다 조각 이름(분해 단계 곁 가지). */
  plans?: ReadonlyArray<{ runId: string; pieces: readonly string[] }>;
  /** Pod 발사 — 하니스 → Pod(바깥 고리). */
  pods?: ReadonlyArray<{ pool: string; ts: string }>;
  /** 재시도 고리 — 단계 노드에 겹칠 고리 수. */
  retries?: ReadonlyArray<{ runId: string; stage: LiveStage; retries: number }>;
}

/** 결정적 초기 위치(같은 id 는 같은 자리) — 새로고침·녹화마다 모양이 뒤집히지 않게. */
function seed(id: string): { x: number; y: number } {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const a = ((h >>> 0) % 3600) / 3600 * Math.PI * 2;
  const r = 0.25 + (((h >>> 12) % 1000) / 1000) * 0.2;
  return { x: 0.5 + Math.cos(a) * r, y: 0.5 + Math.sin(a) * r };
}

export function buildJudgmentGraph(board: LiveBoardData, extra: GraphExtra = {}): JudgmentGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const add = (id: string, kind: GraphNodeKind, label: string, weight = 1) => {
    const cur = nodes.get(id);
    if (cur) { cur.weight += weight; return cur; }
    const p = kind === 'harness' ? { x: 0.5, y: 0.5 } : seed(id);
    const n: GraphNode = { id, kind, label, weight, x: p.x, y: p.y, vx: 0, vy: 0 };
    nodes.set(id, n);
    return n;
  };
  const edge = (from: string, to: string, kind: DecisionKind) => {
    if (!edges.some((e) => e.from === from && e.to === to && e.kind === kind)) edges.push({ from, to, kind });
  };
  add('harness', 'harness', 'harness', 3);
  const runs = board.snapshot.runs.slice(0, MAX_RUNS);
  runs.forEach((run, ri) => {
    const id = `run:${run.runId}`;
    add(id, 'run', run.runId.replace(/^run-/, '').slice(0, 6), 2);
    edge('harness', id, 'PLAN');
    // 페이즈 겹 — 본 단계만(신호 없는 단계는 그리지 않는다 · 가짜 노드 금지).
    let last: string | null = null;
    if (ri < MAX_PHASE_RUNS) {
      let prev = id;
      for (const stage of LIVE_STAGES) {
        const tone = run.stages[stage];
        if (!tone && run.current !== stage) continue;
        const pid = phaseId(run.runId, stage);
        const n = add(pid, 'phase', LIVE_STAGE_LABEL[stage]);
        n.current = run.current === stage;
        n.tone = tone ?? 'info';
        edge(prev, pid, tone === 'bad' ? 'ESCALATE' : STAGE_KIND[stage]);
        prev = pid;
        last = pid;
      }
    }
    if (run.pr) {
      add(`pr:${run.pr}`, 'pr', `#${run.pr}`);
      edge(last ?? id, `pr:${run.pr}`, run.stages.land === 'ok' ? 'SHIP' : 'VERIFY');
    }
    if (run.blocked) edge(id, 'harness', 'ESCALATE');
  });
  for (const m of board.scorecard.slice(0, MAX_MODELS)) {
    add(`model:${m.model}`, 'model', m.model.length > 18 ? `${m.model.slice(0, 17)}…` : m.model, Math.max(1, Math.round(Math.log2(1 + m.requests))));
    edge('harness', `model:${m.model}`, 'ROUTE');
  }
  // v5 밀도: 런의 신호 종류 — 그 단계 노드 곁(없으면 런 곁). 크기 = 신호 수.
  let events = 0;
  for (const ev of extra.events ?? []) {
    if (events >= MAX_EVENTS) break;
    const runNode = `run:${ev.runId}`;
    if (!nodes.has(runNode)) continue;
    const phase = ev.stage ? phaseId(ev.runId, ev.stage) : null;
    const parent = phase && nodes.has(phase) ? phase : runNode;
    const n = add(`ev:${ev.key}`, 'event', ev.label, Math.max(1, Math.round(Math.log2(1 + ev.count))));
    if (ev.bad) n.tone = 'bad';
    edge(parent, n.id, ev.bad ? 'ESCALATE' : ev.stage ? STAGE_KIND[ev.stage] : 'PLAN');
    events += 1;
  }
  // v5 밀도: 모델 → 사이트(부른 자리) · 과금 계정(바깥 고리).
  const siteSeen = new Set<string>();
  let requests = 0;
  for (const r of extra.reqs ?? []) {
    const mid = `model:${r.model}`;
    if (!nodes.has(mid)) continue;
    const sid = `site:${r.model}|${r.site}`;
    if (!siteSeen.has(sid)) { siteSeen.add(sid); add(sid, 'site', r.site); edge(mid, sid, 'ROUTE'); }
    else nodes.get(sid)!.weight += 0.05;
    if (r.provider) {
      const aid = `acct:${r.provider}`;
      if (!nodes.has(aid)) add(aid, 'account', r.provider, 2);
      edge(aid, mid, 'ROUTE');
    }
    // 요청 한 건 = 점 하나(그 사이트 곁) — 크기 = 토큰(로그). 라벨 없음.
    if (requests < MAX_REQUESTS) {
      const q = add(`req:${r.model}|${r.site}|${r.ts}|${requests}`, 'request', '', Math.max(1, Math.log10(1 + r.input + r.output)));
      edge(sid, q.id, 'ROUTE');
      requests += 1;
    }
  }
  for (const u of extra.universes ?? []) {
    const rid = `run:${u.runId}`;
    if (!nodes.has(rid)) continue;
    const id = `uni:${u.instance}`;
    if (!nodes.has(id)) add(id, 'universe', u.instance, 2);
    else nodes.get(id)!.weight += 1;
    edge(id, rid, 'PLAN');
  }
  for (const plan of extra.plans ?? []) {
    const rid = `run:${plan.runId}`;
    if (!nodes.has(rid)) continue;
    const dec = phaseId(plan.runId, 'decompose');
    const parent = nodes.has(dec) ? dec : rid;
    plan.pieces.forEach((label, i) => {
      const id = `piece:${plan.runId}:${i}`;
      add(id, 'piece', label.length > 22 ? `${label.slice(0, 21)}…` : label, 1.5);
      edge(parent, id, 'PLAN');
    });
  }
  for (const d of extra.pods ?? []) {
    const id = `pod:${d.pool}`;
    if (!nodes.has(id)) add(id, 'pod', d.pool.replace(/^pool-/, '').split('@')[0] ?? d.pool, 2);
    else nodes.get(id)!.weight += 0.2;
    edge('harness', id, 'ROUTE');
  }
  for (const r of extra.retries ?? []) {
    const n = nodes.get(phaseId(r.runId, r.stage));
    if (n) n.retries = Math.max(n.retries ?? 0, r.retries);
  }
  let targets = 0;
  for (const s of board.stream) {
    const from = s.runId && nodes.has(`run:${s.runId}`) ? `run:${s.runId}` : 'harness';
    if (s.kind === 'SHIP' && s.target) {
      add(`pr:${s.target.replace(/^#/, '')}`, 'pr', s.target);
      edge(from, `pr:${s.target.replace(/^#/, '')}`, 'SHIP');
    } else if (s.target && targets < MAX_TARGETS && !s.target.startsWith('#')) {
      const tid = `target:${s.target}`;
      if (!nodes.has(tid)) targets += 1;
      add(tid, 'target', s.target.length > 18 ? `${s.target.slice(0, 17)}…` : s.target);
      edge(from, tid, s.kind);
    } else if (s.kind === 'HEAL' || s.kind === 'VERIFY') {
      edge(from, from, s.kind);
    }
  }
  return { nodes: [...nodes.values()], edges };
}

/** 힘 한 걸음 — 밀어냄(모든 쌍) · 간선 스프링 · 가운데 당김 · 감쇠. 좌표는 0~1. 하니스는 가운데 고정. */
export function stepForces(graph: JudgmentGraph, dt = 1): void {
  const { nodes, edges } = graph;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // 노드가 많으면 반발을 줄인다 — 444 노드(v5 연합 실측)에서 합이 너무 커져 전부 테두리에 붙었다.
  const crowd = Math.min(1, 60 / Math.max(1, nodes.length));
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1e-6) { dx = 0.01; dy = 0.01; d2 = 2e-4; }
      // 페이즈는 제 런 곁에 모여야 한다 — 밀어냄을 약하게.
      const light = (k: GraphNodeKind) => k === 'phase' || k === 'request' || k === 'event' || k === 'piece';
      const f = crowd * (light(a.kind) || light(b.kind) ? (a.kind === 'request' || b.kind === 'request' ? 0.000012 : 0.00005) : 0.00018) / d2;
      a.vx += dx * f; a.vy += dy * f;
      b.vx -= dx * f; b.vy -= dy * f;
    }
  }
  for (const e of edges) {
    if (e.from === e.to) continue;
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1e-3;
    const rest = b.kind === 'request' ? 0.035 : b.kind === 'site' ? 0.06 : OUTER.has(a.kind) || OUTER.has(b.kind) ? 0.34 : a.kind === 'harness' || b.kind === 'harness' ? 0.2 : a.kind === 'phase' || b.kind === 'phase' ? 0.07 : 0.12;
    const f = (d - rest) * (a.kind === 'phase' || b.kind === 'phase' ? 0.05 : 0.02);
    a.vx += (dx / d) * f; a.vy += (dy / d) * f;
    b.vx -= (dx / d) * f; b.vy -= (dy / d) * f;
  }
  for (const n of nodes) {
    if (n.kind === 'harness') { n.x = 0.5; n.y = 0.5; n.vx = 0; n.vy = 0; continue; }
    if (OUTER.has(n.kind)) {
      // 바깥 고리 — 가운데서 반지름 0.36 으로 끌어 둔다(0.42 면 넓은 캔버스 가장자리에 붙었다 · v5 실측).
      const dx = n.x - 0.5; const dy = n.y - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy) || 1e-3;
      const k = ((n.kind === 'universe' ? 0.44 : 0.3) - d) * 0.01;
      n.vx += (dx / d) * k; n.vy += (dy / d) * k;
    } else {
      n.vx += (0.5 - n.x) * 0.003;
      n.vy += (0.5 - n.y) * 0.003;
    }
    // 부드러운 벽 — 가장자리 띠(8%)에 들어오면 안쪽으로 민다. 딱딱한 벽(클램프)만 두면 밀린 노드가 테두리에 «붙어» 줄을 선다(v5 실측 608 노드).
    const edgeBand = 0.08;
    if (n.x < edgeBand) n.vx += (edgeBand - n.x) * 0.06;
    if (n.x > 1 - edgeBand) n.vx -= (n.x - (1 - edgeBand)) * 0.06;
    if (n.y < 0.1 + edgeBand) n.vy += (0.1 + edgeBand - n.y) * 0.06;
    if (n.y > 0.95 - edgeBand) n.vy -= (n.y - (0.95 - edgeBand)) * 0.06;
    n.vx *= 0.86; n.vy *= 0.86;
    n.x = Math.min(0.97, Math.max(0.03, n.x + n.vx * dt));
    n.y = Math.min(0.95, Math.max(0.1, n.y + n.vy * dt));
  }
}

/** 두 스냅샷 사이 «새» 판단 — 입자를 쏠 것. 키 = 시각·종류·런·무엇. */
export function newDecisionKeys(prev: ReadonlySet<string>, board: LiveBoardData): Array<{ key: string; kind: DecisionKind; from: string; to: string }> {
  const out: Array<{ key: string; kind: DecisionKind; from: string; to: string }> = [];
  for (const s of board.stream) {
    const key = `${s.ts}|${s.kind}|${s.runId ?? ''}|${s.what}`;
    if (prev.has(key)) continue;
    const from = s.runId ? `run:${s.runId}` : 'harness';
    const to = s.kind === 'SHIP' && s.target ? `pr:${s.target.replace(/^#/, '')}` : s.target ? `target:${s.target}` : from;
    out.push({ key, kind: s.kind, from, to });
  }
  return out;
}
