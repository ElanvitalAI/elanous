// «Trace» 탭 데이터 층(RFC v6 `내부 문서 `RFC-trace-tab-lens-resolution-interactive-observation-2026-09-28`` §2·§3) — 순수 · 시험 대상.
// T2(🅕): 🅣 `GET /v1/trace` 전까지 기존 끝점(`/v1/logs` 연합 `@active` · 원장)으로 짓는다. 모양은 RFC §3 을 따른다 —
// T1 이 착지하면 원천만 바꾼다(화면은 이 모델만 읽는다).
// 해상도: L0 플릿(우주) → L1 런 → L2 런 한 개(단계·판단 사슬·신호) · L3/L4 는 T3.
// 렌즈 = 필터의 누적(우주 › 런 › …) · URL 상태로 같은 화면을 공유한다.

import type { HarnessRunEntry, LogRow, TraceEventWire, TraceResponse } from '@/nexus/client';
import { buildLiveBoard, classifySignal, DECISION_KINDS, LIVE_STAGES, type DecisionKind, type DecisionLine, type LiveStage } from './live-signals';

export type TraceLevel = 'L0' | 'L1' | 'L2' | 'L3';
export const TRACE_LEVELS: readonly TraceLevel[] = ['L0', 'L1', 'L2', 'L3'];

export interface TraceLens {
  level: TraceLevel;
  universe?: string;
  runId?: string;
  /** L3 — 그 런의 판단 사슬에서 몇 번째(0 = 가장 옛것). */
  decision?: number;
  /** 상태 칩: running · landed · blocked. */
  status?: TraceRunStatus;
  q?: string;
  /** «같은 지적»(RFC §7 · T4) — 이 지적 서명이 나온 런만. */
  finding?: string;
  /** 시간 브러시(RFC §4) — 이 구간과 겹치는 런만(ms). */
  from?: number;
  to?: number;
  windowMin: number;
}

/** `quiet` = 서버 집계엔 있는데 이 창에 단계 신호가 없고 원장도 결과를 모른다(신호 끊김 · 결과 모름). */
export type TraceRunStatus = 'running' | 'landed' | 'blocked' | 'quiet';

export interface TraceRun {
  runId: string;
  universe: string;
  status: TraceRunStatus;
  current: LiveStage | null;
  stages: Partial<Record<LiveStage, 'ok' | 'bad' | 'info'>>;
  events: number;
  firstTs: string;
  lastTs: string;
  pr: string | null;
  parentRunId: string | null;
  decisions: number;
}

export interface TraceUniverse { name: string; runs: number; running: number; blocked: number; signals: number }

export interface TraceNode { id: string; kind: 'universe' | 'run' | 'stage' | 'decision'; label: string; status?: TraceRunStatus | 'ok' | 'bad' | 'info'; weight: number }
export interface TraceEdge { source: string; target: string; kind: 'contains' | 'parent' | 'next' | 'decides' }

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export interface TraceModel {
  universes: TraceUniverse[];
  runs: TraceRun[];
  /** 창 안 판단(최신이 앞) — L2 판단 사슬의 원천. */
  decisions: DecisionLine[];
  /** 판단마다 우주(연합) — 렌즈 필터용. */
  rows: readonly LogRow[];
}

/** 로그 줄 ⊕ 원장 → trace 모델. 런의 우주 = 그 런을 처음 쓴 인스턴스(연합 조회의 `instance`). */
export function buildTraceModel(rows: readonly LogRow[], ledger: readonly HarnessRunEntry[], opts: { now: number; windowMinutes: number }): TraceModel {
  const board = buildLiveBoard(rows, ledger, opts);
  const uni = new Map<string, string>();
  const first = new Map<string, string>();
  const parent = new Map<string, string>();
  const perUniverse = new Map<string, number>();
  for (const row of rows) {
    const inst = row.instance ?? 'this';
    perUniverse.set(inst, (perUniverse.get(inst) ?? 0) + 1);
    const runId = str(row.data?.runId);
    if (!runId) continue;
    if (!uni.has(runId)) uni.set(runId, inst);
    const f = first.get(runId);
    if (!f || row.ts < f) first.set(runId, row.ts);
    const p = str(row.data?.parentRunId);
    if (p && p !== runId) parent.set(runId, p);
  }
  const decisionsByRun = new Map<string, number>();
  for (const d of board.stream) if (d.runId) decisionsByRun.set(d.runId, (decisionsByRun.get(d.runId) ?? 0) + 1);
  const runs: TraceRun[] = board.snapshot.runs.map((r) => ({
    runId: r.runId,
    universe: uni.get(r.runId) ?? 'this',
    status: r.blocked ? 'blocked' : r.stages.land === 'ok' ? 'landed' : 'running',
    current: r.current,
    stages: r.stages,
    events: r.events,
    firstTs: first.get(r.runId) ?? r.lastTs,
    lastTs: r.lastTs,
    pr: r.pr,
    parentRunId: parent.get(r.runId) ?? null,
    decisions: decisionsByRun.get(r.runId) ?? 0,
  }));
  const universes = [...perUniverse.entries()].map(([name, signals]) => {
    const mine = runs.filter((r) => r.universe === name);
    return { name, signals, runs: mine.length, running: mine.filter((r) => r.status === 'running').length, blocked: mine.filter((r) => r.status === 'blocked').length };
  }).sort((a, b) => b.runs - a.runs || b.signals - a.signals);
  return { universes, runs, decisions: board.stream, rows };
}

/** 렌즈를 적용한 런 목록(L1 표·그래프). 검색어는 runId·PR·우주에 부분 일치. */
export function lensRuns(model: TraceModel, lens: TraceLens): TraceRun[] {
  const q = lens.q?.trim().toLowerCase();
  return model.runs.filter((r) =>
    (!lens.universe || r.universe === lens.universe)
    && (!lens.status || r.status === lens.status)
    && (!q || r.runId.toLowerCase().includes(q) || (r.pr ?? '').includes(q) || r.universe.toLowerCase().includes(q))
    && (!lens.finding || runFindingSigs(model, r.runId).has(lens.finding))
    && (lens.from === undefined || Date.parse(r.lastTs) >= lens.from)
    && (lens.to === undefined || Date.parse(r.firstTs) <= lens.to));
}

/** 칩 개수(facet) — 지금 렌즈에서 «그 칩을 누르면» 몇 개가 남나. 자기 칸은 빼고 센다. */
export function facets(model: TraceModel, lens: TraceLens): { universe: Record<string, number>; status: Record<TraceRunStatus, number> } {
  const universe: Record<string, number> = {};
  for (const r of lensRuns(model, { ...lens, universe: undefined })) universe[r.universe] = (universe[r.universe] ?? 0) + 1;
  const status: Record<TraceRunStatus, number> = { running: 0, landed: 0, blocked: 0, quiet: 0 };
  for (const r of lensRuns(model, { ...lens, status: undefined })) status[r.status] += 1;
  return { universe, status };
}

/** 지금 층의 그래프(노드·간선). L0 = 우주 ⊕ 그 런들 · L1 = 렌즈의 런 ⊕ 부모 링크 · L2 = 런 한 개의 단계 ⊕ 판단. */
export function traceGraph(model: TraceModel, lens: TraceLens): { nodes: TraceNode[]; edges: TraceEdge[] } {
  const nodes: TraceNode[] = [];
  const edges: TraceEdge[] = [];
  const runs = lensRuns(model, lens);
  if (lens.level === 'L0') {
    for (const u of model.universes.filter((u) => !lens.universe || u.name === lens.universe)) {
      nodes.push({ id: `u:${u.name}`, kind: 'universe', label: u.name, weight: Math.max(1, u.runs), status: u.blocked ? 'bad' : u.running ? 'info' : 'ok' });
    }
    for (const r of runs) {
      if (!nodes.some((n) => n.id === `u:${r.universe}`)) continue;
      nodes.push({ id: `r:${r.runId}`, kind: 'run', label: r.runId.replace(/^run-/, '').slice(0, 8), weight: 1, status: r.status });
      edges.push({ source: `u:${r.universe}`, target: `r:${r.runId}`, kind: 'contains' });
    }
    return { nodes, edges };
  }
  if (lens.level === 'L1') {
    const ids = new Set(runs.map((r) => r.runId));
    for (const r of runs) nodes.push({ id: `r:${r.runId}`, kind: 'run', label: r.runId.replace(/^run-/, '').slice(0, 8), weight: 1 + Math.log2(1 + r.events), status: r.status });
    for (const r of runs) if (r.parentRunId && ids.has(r.parentRunId)) edges.push({ source: `r:${r.parentRunId}`, target: `r:${r.runId}`, kind: 'parent' });
    return { nodes, edges };
  }
  // L2·L3 — 런 한 개(L3 는 같은 그래프에서 판단 하나를 고른다).
  const run = model.runs.find((r) => r.runId === lens.runId);
  if (!run) return { nodes, edges };
  nodes.push({ id: `r:${run.runId}`, kind: 'run', label: run.runId.replace(/^run-/, '').slice(0, 8), weight: 3, status: run.status });
  let prev = `r:${run.runId}`;
  for (const s of LIVE_STAGES) {
    const tone = run.stages[s];
    if (!tone) continue;
    const id = `s:${s}`;
    nodes.push({ id, kind: 'stage', label: s, weight: 2, status: tone });
    edges.push({ source: prev, target: id, kind: 'next' });
    prev = id;
  }
  const chain = runDecisions(model, run.runId);
  chain.forEach((d, i) => {
    const id = `d:${i}`;
    nodes.push({ id, kind: 'decision', label: d.kind, weight: 1 });
    edges.push({ source: nodes.some((n) => n.id === `s:${stageOfDecision(d) ?? ''}`) ? `s:${stageOfDecision(d)}` : `r:${run.runId}`, target: id, kind: 'decides' });
  });
  return { nodes, edges };
}

/** 한 런의 판단 사슬(옛것 → 최신) — L2 가로 흐름·L3 의 원천. */
export function runDecisions(model: TraceModel, runId: string): DecisionLine[] {
  return model.decisions.filter((d) => d.runId === runId).slice().reverse();
}

/** L4 증거 — 그 판단을 만든 원 로그 줄(같은 시각·런) ⊕ 앞뒤 1분의 같은 런 신호 ⊕ 다시 찾는 명령. */
export function decisionEvidence(model: TraceModel, d: Pick<DecisionLine, 'ts' | 'runId' | 'target'>, universe?: string): {
  source: LogRow | null;
  around: LogRow[];
  command: string;
  pr: string | null;
} {
  const t = Date.parse(d.ts);
  const sameRun = (row: LogRow) => (d.runId ? row.data?.runId === d.runId : true);
  const source = model.rows.find((row) => row.ts === d.ts && sameRun(row)) ?? null;
  const around = model.rows
    .filter((row) => sameRun(row) && row !== source && Math.abs(Date.parse(row.ts) - t) <= 60_000)
    .sort((a, b) => (a.ts < b.ts ? -1 : 1))
    .slice(0, 20);
  const since = new Date(t - 60_000).toISOString();
  const until = new Date(t + 60_000).toISOString();
  const store = universe && universe !== 'this' ? ` --instance ${universe}` : '';
  const command = `elanous logs${store}${source ? ` --category ${source.category}` : ''} --since ${since} --until ${until}${d.runId ? ` --grep ${d.runId}` : ''} --json --json-data`;
  const pr = d.target && /^#?\d+$/.test(d.target) ? d.target.replace(/^#/, '') : null;
  return { source, around, command, pr };
}

/** «발표» 무대에 먹일 줄 — 렌즈에 남은 런의 줄만(런 없는 줄 — LLM 요청·계정 판단 — 은 그대로 둔다: 무대의 봉·띠가 쓴다).
 *  렌즈가 비어 있으면(전체) 줄을 건드리지 않는다. */
export function lensRows(model: TraceModel, lens: TraceLens): readonly LogRow[] {
  const narrowed = !!(lens.universe || lens.status || lens.q || lens.runId || lens.finding || lens.from !== undefined);
  if (!narrowed) return model.rows;
  const keep = new Set(lens.runId ? [lens.runId] : lensRuns(model, lens).map((r) => r.runId));
  return model.rows.filter((row) => {
    const runId = row.data?.runId;
    return typeof runId !== 'string' || keep.has(runId);
  });
}

/** 지적 서명 — 리뷰 판단(VERIFY)의 «왜»를 정규화한다(숫자·PR 번호·경로 줄 번호·공백 차이를 지운다).
 *  🅣 후반부 계측(#21539 류)이 must-fix 를 VERIFY 판단의 `reason` 에 싣는다 — 그 문장이 «같은 지적»의 원천이다. */
export function findingSignature(d: Pick<DecisionLine, 'kind' | 'why' | 'what'>): string | null {
  if (d.kind !== 'VERIFY') return null;
  const text = d.why ?? null;
  if (!text) return null;
  const sig = text.toLowerCase().replace(/#\d+/g, '#').replace(/:\d+(:\d+)?/g, '').replace(/\d+/g, 'n').replace(/\s+/g, ' ').trim();
  return sig.length >= 6 ? sig : null;
}

function runFindingSigs(model: TraceModel, runId: string): Set<string> {
  const out = new Set<string>();
  for (const d of model.decisions) if (d.runId === runId) { const s = findingSignature(d); if (s) out.add(s); }
  return out;
}

/** «같은 지적» 칩 — 둘 이상의 런에서 나온 지적만(한 런의 반복은 라운드일 뿐). 런 수가 많은 순. */
export function repeatedFindings(model: TraceModel, min = 2): Array<{ sig: string; runs: number }> {
  const by = new Map<string, Set<string>>();
  for (const d of model.decisions) {
    const s = findingSignature(d);
    if (!s || !d.runId) continue;
    const set = by.get(s) ?? new Set<string>();
    set.add(d.runId);
    by.set(s, set);
  }
  return [...by.entries()].filter(([, v]) => v.size >= min).map(([sig, v]) => ({ sig, runs: v.size })).sort((a, b) => b.runs - a.runs);
}

/** L2 간트 — 단계마다 처음·마지막 신호 시각(ms). 신호가 없는 단계는 빠진다. */
export function runGantt(model: TraceModel, runId: string): Array<{ stage: LiveStage; start: number; end: number; tone: 'ok' | 'bad' | 'info' }> {
  const by = new Map<LiveStage, { start: number; end: number; tone: 'ok' | 'bad' | 'info' }>();
  for (const s of runSignals(model, runId)) {
    if (!s.stage) continue;
    const t = Date.parse(s.ts);
    const cur = by.get(s.stage);
    if (!cur) by.set(s.stage, { start: t, end: t, tone: s.tone });
    else { cur.start = Math.min(cur.start, t); cur.end = Math.max(cur.end, t); if (s.tone === 'bad') cur.tone = 'bad'; else if (s.tone === 'ok' && cur.tone !== 'bad') cur.tone = 'ok'; }
  }
  return LIVE_STAGES.filter((s) => by.has(s)).map((stage) => ({ stage, ...by.get(stage)! }));
}

/** 판단이 속한 단계 — 종류로 가늠한다(정확한 단계는 T0 `phase` 칸이 오면 그것을 쓴다). */
export function stageOfDecision(d: Pick<DecisionLine, 'kind'>): LiveStage | null {
  return d.kind === 'PLAN' ? 'author' : d.kind === 'ROUTE' ? 'build' : d.kind === 'VERIFY' ? 'review' : d.kind === 'HEAL' ? 'review' : d.kind === 'SHIP' ? 'land' : null;
}

/** 한 런의 신호 줄(L2 옆 패널 · 증거로 가는 길). */
export function runSignals(model: TraceModel, runId: string): Array<{ ts: string; category: string; event: string; stage: LiveStage | null; tone: 'ok' | 'bad' | 'info' }> {
  return model.rows
    .filter((r) => r.data?.runId === runId)
    .map((r) => ({ ts: r.ts, category: r.category, event: r.event, ...classifySignal(r) }))
    .sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

// ── URL 상태(RFC §4 «링크 하나로 같은 화면») ─────────────────────────────

export function lensFromSearch(search: string): TraceLens {
  const p = new URLSearchParams(search);
  const level = (TRACE_LEVELS as readonly string[]).includes(p.get('level') ?? '') ? (p.get('level') as TraceLevel) : 'L1';
  const status = p.get('status');
  const windowMin = Number(p.get('window'));
  return {
    level,
    ...(p.get('universe') ? { universe: p.get('universe')! } : {}),
    ...(p.get('run') ? { runId: p.get('run')! } : {}),
    ...(Number.isInteger(Number(p.get('dec'))) && p.get('dec') !== null && p.get('dec') !== '' ? { decision: Number(p.get('dec')) } : {}),
    ...(status === 'running' || status === 'landed' || status === 'blocked' || status === 'quiet' ? { status } : {}),
    ...(p.get('q') ? { q: p.get('q')! } : {}),
    ...(p.get('finding') ? { finding: p.get('finding')! } : {}),
    ...(Number(p.get('from')) > 0 && Number(p.get('to')) > Number(p.get('from')) ? { from: Number(p.get('from')), to: Number(p.get('to')) } : {}),
    windowMin: Number.isFinite(windowMin) && windowMin > 0 ? windowMin : 1440,
  };
}

export function lensToSearch(lens: TraceLens): string {
  const p = new URLSearchParams();
  p.set('level', lens.level);
  if (lens.universe) p.set('universe', lens.universe);
  if (lens.runId) p.set('run', lens.runId);
  if (lens.decision !== undefined) p.set('dec', String(lens.decision));
  if (lens.status) p.set('status', lens.status);
  if (lens.q) p.set('q', lens.q);
  if (lens.finding) p.set('finding', lens.finding);
  if (lens.from !== undefined && lens.to !== undefined) { p.set('from', String(Math.round(lens.from))); p.set('to', String(Math.round(lens.to))); }
  if (lens.windowMin !== 1440) p.set('window', String(lens.windowMin));
  return `?${p.toString()}`;
}

/** 빵부스러기 — 렌즈의 칸을 순서대로. 하나를 빼면 그 칸만 사라진다. */
export function crumbs(lens: TraceLens): Array<{ key: 'universe' | 'runId' | 'status' | 'q' | 'time' | 'finding'; label: string }> {
  const out: Array<{ key: 'universe' | 'runId' | 'status' | 'q' | 'time' | 'finding'; label: string }> = [];
  if (lens.finding) out.push({ key: 'finding', label: `같은 지적: ${lens.finding.slice(0, 24)}${lens.finding.length > 24 ? '…' : ''}` });
  if (lens.from !== undefined && lens.to !== undefined) {
    const hm = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    out.push({ key: 'time', label: `시간: ${hm(lens.from)}–${hm(lens.to)}` });
  }
  if (lens.universe) out.push({ key: 'universe', label: `우주: ${lens.universe}` });
  if (lens.status) out.push({ key: 'status', label: `상태: ${lens.status}` });
  if (lens.runId) out.push({ key: 'runId', label: `런: ${lens.runId.replace(/^run-/, '').slice(0, 8)}` });
  if (lens.q) out.push({ key: 'q', label: `검색: ${lens.q}` });
  return out;
}

/** 한 층 내려가기(더블클릭) — 노드에 렌즈를 맞춘다. */
export function drillDown(lens: TraceLens, node: Pick<TraceNode, 'id' | 'kind'>): TraceLens {
  if (node.kind === 'universe') return { ...lens, level: 'L1', universe: node.id.slice(2) };
  if (node.kind === 'run') return { ...lens, level: 'L2', runId: node.id.slice(2) };
  if (node.kind === 'decision') return { ...lens, level: 'L3', decision: Number(node.id.slice(2)) };
  return lens;
}

/** 한 층 위로(Esc) — 그 층이 더한 렌즈 칸을 뺀다. */
export function drillUp(lens: TraceLens): TraceLens {
  if (lens.level === 'L3') { const { decision: _d, ...rest } = lens; void _d; return { ...rest, level: 'L2' }; }
  if (lens.level === 'L2') { const { runId: _r, ...rest } = lens; void _r; return { ...rest, level: 'L1' }; }
  if (lens.level === 'L1') { const { universe: _u, ...rest } = lens; void _u; return { ...rest, level: 'L0' }; }
  return lens;
}

/** 서버 판단 사슬(🅣 `/v1/trace?level=L3&runId=`) → 화면 줄. 판단 여섯 가지만 사슬로 친다(리뷰·게이트·LLM 줄은 사슬이 아니다).
 *  서버는 최신순으로 준다 — 사슬은 옛것 → 최신. `logId` 는 L4 원문을 여는 열쇠다. */
export function serverDecisionChain(events: readonly TraceEventWire[], runId: string): Array<DecisionLine & { logId: string; pr: string | null; commit: string | null; universe: string }> {
  return events
    .filter((e) => e.runId === runId && (DECISION_KINDS as readonly string[]).includes(e.kind))
    .slice()
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
    .map((e) => ({
      ts: e.ts,
      kind: e.kind as DecisionKind,
      runId: e.runId ?? null,
      what: e.what,
      why: e.why ?? null,
      purpose: e.purpose ?? null,
      target: e.target ?? null,
      ...(typeof e.paths === 'number' ? { paths: e.paths } : Array.isArray(e.paths) ? { paths: e.paths.length } : {}),
      logId: e.refs.logId,
      pr: e.refs.pr !== undefined ? String(e.refs.pr).replace(/^#/, '') : null,
      commit: e.refs.commit ?? null,
      universe: e.universe,
    }));
}

/** 원장 상태 문자열 → 런 상태. 모르면 null(지어내지 않는다). */
export function ledgerRunStatus(status: string | undefined): TraceRunStatus | null {
  if (!status) return null;
  if (/complet|merged|landed|success|done/i.test(status)) return 'landed';
  if (/fail|block|park|cancel|abort|error|stall/i.test(status)) return 'blocked';
  if (/run|progress|active|review|build/i.test(status)) return 'running';
  return null;
}

/** 🅣 `/v1/trace?level=L1`(#21624 런 집계) 의 런 중 이 창 조회에 없는 것을 더한다 — 창 조회는 행 상한에 밀려
 *  런을 덜 센다(실측 09-28: 창 8 ↔ 서버 70). 이미 있는 런은 건드리지 않는다(창 조회가 단계·PR 을 더 안다).
 *  상태: 원장이 알면 원장 · 모르면 15분 안 신호면 running, 아니면 quiet(«결과 모름»을 «도는»으로 쓰지 않는다). */
export function mergeServerRuns(model: TraceModel, server: Pick<TraceResponse, 'nodes' | 'edges'> | undefined, ledger: readonly HarnessRunEntry[], now: number): TraceModel {
  const nodes = (server?.nodes ?? []).filter((n) => n.level === 'L1' && n.runId);
  if (nodes.length === 0) return model;
  const known = new Set(model.runs.map((r) => r.runId));
  const byLedger = new Map(ledger.map((e) => [e.runId, e]));
  const parentOf = new Map<string, string>();
  for (const e of server?.edges ?? []) if (e.kind === 'parent') parentOf.set(e.target, e.source);
  const added: TraceRun[] = [];
  for (const n of nodes) {
    const runId = n.runId!;
    if (known.has(runId)) continue;
    known.add(runId);
    const lastTs = n.lastTs ?? n.firstTs ?? new Date(now).toISOString();
    const fromLedger = ledgerRunStatus(byLedger.get(runId)?.status);
    const status: TraceRunStatus = fromLedger ?? (now - Date.parse(lastTs) <= 15 * 60_000 ? 'running' : 'quiet');
    const parentNode = parentOf.get(n.id);
    const parentRunId = parentNode ? nodes.find((p) => p.id === parentNode)?.runId ?? null : null;
    added.push({ runId, universe: n.universe ?? 'this', status, current: null, stages: {}, events: n.count, firstTs: n.firstTs ?? lastTs, lastTs, pr: null, parentRunId, decisions: 0 });
  }
  if (added.length === 0) return model;
  const runs = [...model.runs, ...added];
  const universes = new Map(model.universes.map((u) => [u.name, { ...u }]));
  for (const r of added) {
    const u = universes.get(r.universe) ?? { name: r.universe, signals: 0, runs: 0, running: 0, blocked: 0 };
    u.runs += 1; u.signals += r.events;
    if (r.status === 'running') u.running += 1;
    if (r.status === 'blocked') u.blocked += 1;
    universes.set(r.universe, u);
  }
  return { ...model, runs, universes: [...universes.values()].sort((a, b) => b.runs - a.runs || b.signals - a.signals) };
}
