'use client';

// «화려함 MAX» 무대 v5 — 스토리보드 `내부 문서 `STORYBOARD-live-max-v5-dense-stage-2026-09-28`` §1 격자 13칸
// (RFC §7 · 대표 09:4x 레퍼런스 두 장 · 톤은 지금 MAX 그대로 — 남색·인디고 · 보라 광채 · 파스텔 · 원색 네온 없음).
// 레퍼런스에서 가져온 것은 «밀도·격자·요소»다: ①② 흐르는 띠 · ③ 거대 숫자 · ④ 오늘 최고의 런 · ⑤ 분당 봉 ⊕ 요청 창 ·
// ⑥ 실행 사이클 · ⑦ 밀집 힘-그래프(신호 종류·사이트·계정까지 수백 노드) · ⑧ 통계 상자 · ⑨ 히트맵 · ⑩ 분포 · ⑪ 수렴 ⊕ 게이트 ·
// ⑫ 실행 로그 띠 · ⑬ 아래 띠. 움직임 세 층(🅣): 상시(간선 입자·띠·노드 숨) · 박동(숫자 굴림·로그 한 줄) · 사건(판단 카드 → 입자 · SHIP 섬광).
// ⛔ 보이는 수는 전부 진짜 신호다 — 없는 칸은 만들지 않는다(`llm.usage` 에 역할·지연이 없어 히트맵은 «모델 × 사이트»).
// ⛔ 캔버스는 마운트 뒤에만 그린다(정적 export 하이드레이션). `prefers-reduced-motion` 이면 정지 화면 · 무대가 사라지면 rAF 도 멈춘다.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LogRow } from '@/nexus/client';
import { clockTime, DECISION_KINDS, foldForRole, LIVE_STAGES, LIVE_STAGE_LABEL, type DecisionKind, type DecisionLine, type LiveBoardData, type LiveRun } from '@/lib/live-signals';
import type { PwaRole } from '@/lib/pwa-role';
import { buildJudgmentGraph, newDecisionKeys, stepForces, type GraphNode, type JudgmentGraph } from '@/lib/live-graph';
import { gateTally, histogram, modelSiteHeatmap, modelTicker, planPieces, podDispatches, runEventKinds, runSpans, runUniverses, stageLoad, stageRetries, usageCandles, usageRequests, type UsageReq } from '@/lib/live-v5';

export const KIND_COLOR: Record<DecisionKind, string> = {
  PLAN: '#38bdf8',
  ROUTE: '#a78bfa',
  VERIFY: '#fbbf24',
  HEAL: '#34d399',
  ESCALATE: '#fb7185',
  SHIP: '#4ade80',
};
const NODE_COLOR: Record<GraphNode['kind'], string> = {
  harness: '#e0e7ff', run: '#818cf8', phase: '#c7d2fe', pr: '#4ade80', model: '#f0abfc', target: '#93c5fd',
  event: '#a5b4fc', site: '#f5d0fe', account: '#fbcfe8', request: '#f0abfc', universe: '#67e8f9', piece: '#7dd3fc', pod: '#fcd34d',
};
const TONE_COLOR = { ok: '#4ade80', bad: '#fb7185', info: '#c7d2fe' } as const;
/** 모델 색 — 파스텔(판단 색과 겹치지 않게). */
const MODEL_PALETTE = ['#f0abfc', '#c4b5fd', '#93c5fd', '#67e8f9', '#a7f3d0', '#fde68a', '#fca5a5'];
/** 카드가 떠 있는 시간(ms) · 리플레이는 빨리. */
export const CARD_MS = 1500;
const REPLAY_CARD_MS = 550;
/** 폴링 주기(다음 갱신까지 초 — ⑥·⑧ «NEXT»). */
const POLL_S = 5;
/** 노드 반경(🅣: 허브 18 · 런 10 · 페이즈 7 · 잔 노드 3~4). */
const RADIUS: Record<GraphNode['kind'], number> = { harness: 16, run: 8, phase: 5.5, pr: 5, model: 7, target: 4, event: 2.6, site: 3, account: 6, request: 1.2, universe: 7, piece: 3.4, pod: 7 };
/** 라벨은 큰 노드만(레퍼런스도 약 30%). */
const LABELED: ReadonlySet<GraphNode['kind']> = new Set(['harness', 'run', 'phase', 'pr', 'model', 'account', 'target', 'universe', 'pod']);

/** ⛔ 기본값을 `[]` 리터럴로 두면 렌더마다 새 배열 → 메모가 매번 깨져 그래프 갱신 ↔ 상태 갱신이 무한히 돈다(시험이 잡았다). */
const NO_ROWS: readonly LogRow[] = [];

/** 카드로 띄울 만한 판단 — «왜» 나 «어디로» 가 있다(🅞 09-28: 빈 칸 카드는 녹화에서 비어 보인다 → 스트림에만 흘린다). */
export function cardWorthy(line: Pick<DecisionLine, 'why' | 'purpose' | 'target'>): boolean {
  return !!(line.why || line.purpose || line.target);
}

/** 판단 카드 한 장 — 무엇·왜·어디로 ⊕ 접힐 때 쏠 입자. */
export interface DecisionCardItem { key: string; line: DecisionLine; from: string; to: string }
interface Particle { from: string; to: string; kind: DecisionKind; t: number; speed: number; alpha: number; size: number }
interface Flash { id: string; t: number }

export interface LiveMaxStageProps {
  board: LiveBoardData;
  /** 이 창의 원 신호 — 밀도 칸(봉·요청 창·히트맵·분포·그래프 잔 노드)의 원천. */
  rows?: readonly LogRow[];
  windowMinutes?: number;
  sourceLabel?: string;
  /** SHIPPED 가 어디서 왔나 — `github`(병합 PR 수) · `log`(판단 이벤트 · 옛 데몬). */
  shippedSource?: 'github' | 'log';
  /** 공개 캡처 — 과금 환산 칸을 숨기고 아래 띠에 표시한다(가림 자체는 줄 단계에서). */
  publicCapture?: boolean;
  /** 무대를 열면 리플레이 한 바퀴(기본 켬 · 시험은 끈다). */
  autoReplay?: boolean;
  onSelectRun?: (runId: string) => void;
  /** 없으면 오너 — 디버깅 무대는 원문 그대로. */
  role?: PwaRole;
}

/** ④ 오늘 최고의 런 — 병합된 런 중 라운드(스스로 고친 횟수)가 가장 많은 것 · 없으면 지금 도는 런. */
export function bestRun(board: LiveBoardData): { run: LiveRun; why: 'merged' | 'in-flight' } | null {
  const landed = board.snapshot.runs.filter((r) => r.stages.land === 'ok');
  if (landed.length) {
    const best = [...landed].sort((a, b) => (board.rounds[b.runId] ?? 0) - (board.rounds[a.runId] ?? 0) || b.events - a.events)[0]!;
    return { run: best, why: 'merged' };
  }
  const flying = board.snapshot.runs.find((r) => r.current && !r.blocked) ?? board.snapshot.runs[0];
  return flying ? { run: flying, why: 'in-flight' } : null;
}

export function LiveMaxStage({ board, rows = NO_ROWS, windowMinutes = 60, sourceLabel = 'this instance', shippedSource = 'log', autoReplay = true, publicCapture = false, onSelectRun, role = 'owner' }: LiveMaxStageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const graphRef = useRef<JudgmentGraph>({ nodes: [], edges: [] });
  const particlesRef = useRef<Particle[]>([]);
  const flashesRef = useRef<Flash[]>([]);
  const seenRef = useRef<Set<string> | null>(null);
  const queueRef = useRef<DecisionCardItem[]>([]);
  const [card, setCard] = useState<{ item: DecisionCardItem; folding: boolean } | null>(null);
  const [replaying, setReplaying] = useState(false);
  const [pump, setPump] = useState(0);
  const [clock, setClock] = useState<string>('');
  const [nextIn, setNextIn] = useState(POLL_S);
  const [graphSize, setGraphSize] = useState({ nodes: 0, edges: 0 });
  const cardMsRef = useRef(CARD_MS);
  const reduceMotion = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fire = (p: { from: string; to: string; kind: DecisionKind }) => {
    particlesRef.current.push({ from: p.from, to: p.to, kind: p.kind, t: 0, speed: 0.022, alpha: 1, size: 3.6 });
    if (p.kind === 'SHIP') flashesRef.current.push({ id: p.to, t: 0 });
  };

  const reqs = useMemo(() => usageRequests(rows), [rows]);
  const derived = useMemo(() => {
    const now = Date.now();
    const windowMs = windowMinutes * 60_000;
    const spans = runSpans(rows).map((s) => s.ms / 60_000).filter((m) => m > 0);
    const tokensPerReq = reqs.map((r) => r.input + r.output).filter((t) => t > 0);
    return {
      now,
      candles: usageCandles(reqs, now, 40, Math.max(60_000, Math.ceil(windowMs / 40 / 60_000) * 60_000)),
      bucketMin: Math.max(1, Math.ceil(windowMs / 40 / 60_000)),
      ticker: modelTicker(reqs, now, windowMs),
      heat: modelSiteHeatmap(reqs),
      hist: histogram(spans, 40),
      tokHist: histogram(tokensPerReq.map((t) => Math.log10(t)), 40),
      spans: spans.length,
      gate: gateTally(rows),
      load: stageLoad(board),
      events: runEventKinds(rows),
      universes: runUniverses(rows),
      plans: planPieces(rows),
      pods: podDispatches(rows),
      retries: stageRetries(rows),
    };
  }, [reqs, rows, board, windowMinutes]);
  const modelColor = useMemo(() => {
    const m = new Map<string, string>();
    derived.ticker.forEach((t, i) => m.set(t.model, MODEL_PALETTE[i % MODEL_PALETTE.length]!));
    return (model: string) => m.get(model) ?? '#a5b4fc';
  }, [derived.ticker]);

  // 시계 ⊕ 다음 갱신 초 — 박동 층.
  useEffect(() => {
    const tick = () => { setClock(new Date().toLocaleTimeString(undefined, { hour12: false })); setNextIn((n) => (n <= 1 ? POLL_S : n - 1)); };
    tick();
    const h = window.setInterval(tick, 1000);
    return () => window.clearInterval(h);
  }, []);
  useEffect(() => { setNextIn(POLL_S); }, [rows]);

  // 그래프 갱신 — 기존 노드 위치는 유지(물리가 이어지게).
  useEffect(() => {
    const next = buildJudgmentGraph(board, { events: derived.events, reqs, universes: derived.universes, plans: derived.plans, pods: derived.pods, retries: derived.retries });
    const prev = new Map(graphRef.current.nodes.map((n) => [n.id, n]));
    for (const n of next.nodes) {
      const old = prev.get(n.id);
      if (old) { n.x = old.x; n.y = old.y; n.vx = old.vx; n.vy = old.vy; }
    }
    graphRef.current = next;
    setGraphSize((cur) => (cur.nodes === next.nodes.length && cur.edges === next.edges.length ? cur : { nodes: next.nodes.length, edges: next.edges.length }));
    // 조각이 Pod 로 — 새 Pod 발사마다 하니스 → Pod 입자(첫 로드는 쏘지 않는다).
    const podKeys = derived.pods.map((d) => `pod|${d.ts}|${d.pool}`);
    if (seenRef.current) {
      for (const d of derived.pods) {
        const k = `pod|${d.ts}|${d.pool}`;
        if (!seenRef.current.has(k)) fire({ from: 'harness', to: `pod:${d.pool}`, kind: 'ROUTE' });
      }
    }
    const fresh = newDecisionKeys(seenRef.current ?? new Set(), board);
    if (seenRef.current) {
      // 첫 로드는 쏘지 않는다(쌓인 과거가 한꺼번에 터지지 않게) — 그 뒤 새 판단만.
      const byKey = new Map(board.stream.map((l) => [`${l.ts}|${l.kind}|${l.runId ?? ''}|${l.what}`, l]));
      // 새 것이 많으면 최근 6장만 카드로(나머지는 바로 입자) — 카드가 밀려 몇 분 늦게 뜨지 않게.
      const ordered = [...fresh].reverse();
      ordered.forEach((f, i) => {
        const line = byKey.get(f.key);
        if (!line || !cardWorthy(line) || reduceMotion() || i < ordered.length - 6) fire(f);
        else queueRef.current.push({ key: f.key, line, from: f.from, to: f.to });
      });
      setPump((n) => n + 1);
    }
    seenRef.current = new Set([...(seenRef.current ?? []), ...fresh.map((f) => f.key), ...podKeys]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board, derived.events, derived.universes, derived.plans, derived.pods, derived.retries, reqs]);

  // 카드 펌프 — 한 장씩: 뜬다(CARD_MS) → 접힌다(250ms · 입자 발사) → 다음 장.
  useEffect(() => {
    if (card) return;
    const next = queueRef.current.shift();
    if (!next) { if (replaying) setReplaying(false); return; }
    setCard({ item: next, folding: false });
  }, [card, pump, replaying]);
  useEffect(() => {
    if (!card) return;
    if (!card.folding) {
      const t = setTimeout(() => setCard({ item: card.item, folding: true }), cardMsRef.current);
      return () => clearTimeout(t);
    }
    fire({ from: card.item.from, to: card.item.to, kind: card.item.line.kind });
    const t = setTimeout(() => setCard(null), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [card]);
  useEffect(() => { cardMsRef.current = replaying ? REPLAY_CARD_MS : CARD_MS; }, [replaying]);
  // 무대를 열면 리플레이 한 바퀴(🅢 ⑤ «판단 수가 적어 무대가 조용하다») — 판단이 처음 들어온 뒤 한 번만.
  const autoReplayed = useRef(false);
  useEffect(() => {
    if (!autoReplay || autoReplayed.current || board.stream.length === 0 || reduceMotion()) return;
    autoReplayed.current = true;
    const t = setTimeout(() => replay(), 1200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.stream.length]);

  const replay = () => {
    // 이 창의 판단을 옛것부터 빨리 감는다(최근 40) — 도는 런이 없을 때 무대를 채우는 «진짜» 기록.
    const lines = board.stream.filter(cardWorthy).slice(0, 40).reverse();
    queueRef.current = lines.map((l) => {
      const from = l.runId ? `run:${l.runId}` : 'harness';
      const to = l.kind === 'SHIP' && l.target ? `pr:${l.target.replace(/^#/, '')}` : l.target ? `target:${l.target}` : from;
      return { key: `replay|${l.ts}|${l.what}`, line: l, from, to };
    });
    setReplaying(true);
    setPump((n) => n + 1);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduce = reduceMotion();
    // 글로우 스프라이트 — 색마다 한 번 그려 두고 drawImage(수백 노드에 filter 를 쓰면 프레임이 떨어진다).
    const sprites = new Map<string, HTMLCanvasElement>();
    const sprite = (color: string): HTMLCanvasElement => {
      const cached = sprites.get(color);
      if (cached) return cached;
      const s = document.createElement('canvas');
      s.width = 64; s.height = 64;
      const g = s.getContext('2d');
      if (g) {
        const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
        grad.addColorStop(0, `${color}ff`);
        grad.addColorStop(0.25, `${color}88`);
        grad.addColorStop(1, `${color}00`);
        g.fillStyle = grad;
        g.fillRect(0, 0, 64, 64);
      }
      sprites.set(color, s);
      return s;
    };
    let raf = 0;
    let tick = 0;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const g = graphRef.current;
      if (!reduce) stepForces(g);
      tick += 1;
      const byId = new Map(g.nodes.map((n) => [n.id, n]));
      // 숨 — 수렴한 뒤에도 ±1~2px(멈춘 그래프는 죽어 보인다).
      const breathe = (n: GraphNode) => (reduce ? 0 : Math.sin(tick / 40 + (n.id.length % 7)) * 1.4);
      const P = (id: string) => { const n = byId.get(id); return n ? { x: n.x * w + breathe(n), y: n.y * h + breathe(n) * 0.7 } : null; };
      ctx.clearRect(0, 0, w, h);
      // 간선 — 더해서 밝아지게(겹치는 곳이 빛난다).
      ctx.globalCompositeOperation = 'lighter';
      for (const e of g.edges) {
        const a = P(e.from); const b = P(e.to);
        if (!a || !b) continue;
        ctx.strokeStyle = KIND_COLOR[e.kind];
        ctx.globalAlpha = e.to.startsWith('ev:') || e.to.startsWith('site:') ? 0.15 : 0.25;
        ctx.lineWidth = e.kind === 'SHIP' ? 1.4 : 0.7;
        ctx.beginPath();
        if (e.from === e.to) ctx.arc(a.x + 8, a.y - 8, 8, 0, Math.PI * 2);
        else { ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); }
        ctx.stroke();
      }
      // 상시 층 — 간선 위를 흐르는 옅은 입자.
      if (!reduce && g.edges.length && tick % 4 === 0 && particlesRef.current.length < 110) {
        const e = g.edges[(tick * 7919) % g.edges.length]!;
        if (e.from !== e.to) particlesRef.current.push({ from: e.from, to: e.to, kind: e.kind, t: 0, speed: 0.008, alpha: 0.45, size: 1.6 });
      }
      particlesRef.current = particlesRef.current.filter((p) => p.t <= 1);
      for (const p of particlesRef.current) {
        const a = P(p.from); const b = P(p.to);
        if (!a || !b) { p.t = 2; continue; }
        p.t += reduce ? 1 : p.speed;
        const x = a.x + (b.x - a.x) * p.t;
        const y = a.y + (b.y - a.y) * p.t - (p.from === p.to ? Math.sin(p.t * Math.PI) * 24 : 0);
        const s = p.size * 5;
        ctx.globalAlpha = p.alpha;
        ctx.drawImage(sprite(KIND_COLOR[p.kind]), x - s, y - s, s * 2, s * 2);
      }
      // SHIP 섬광 — 확대 → 소멸.
      flashesRef.current = flashesRef.current.filter((f) => f.t <= 1);
      for (const f of flashesRef.current) {
        const c = P(f.id); if (!c) { f.t = 2; continue; }
        f.t += reduce ? 1 : 0.014;
        const r = 10 + Math.min(1, f.t / 0.3) * 70;
        ctx.globalAlpha = 1 - f.t;
        ctx.strokeStyle = KIND_COLOR.SHIP; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.stroke();
        ctx.drawImage(sprite(KIND_COLOR.SHIP), c.x - r, c.y - r, r * 2, r * 2);
      }
      // 노드 — 글로우(작은 노드 ×3 · 큰·지금 노드 ×8) ⊕ 코어.
      for (const n of g.nodes) {
        const c = P(n.id)!;
        const phase = n.kind === 'phase';
        const beat = n.kind === 'harness' || (phase && n.current);
        const base = RADIUS[n.kind] + (n.kind === 'model' || n.kind === 'run' ? Math.min(4, n.weight * 0.4) : n.kind === 'event' ? Math.min(3, n.weight * 0.5) : 0);
        const r = beat && !reduce ? base * (1 + Math.sin(tick / (phase ? 9 : 20)) * (phase ? 0.35 : 0.12)) : base;
        const color = (phase || n.kind === 'event') && n.tone ? TONE_COLOR[n.tone] : NODE_COLOR[n.kind];
        const big = beat || n.kind === 'run' || n.kind === 'model' || n.kind === 'account' || n.kind === 'universe';
        const gr = r * (big ? 8 : 3);
        ctx.globalAlpha = big ? 0.6 : 0.35;
        ctx.drawImage(sprite(color), c.x - gr, c.y - gr, gr * 2, gr * 2);
        ctx.globalAlpha = n.kind === 'event' ? 0.85 : 1;
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(c.x, c.y, r, 0, Math.PI * 2); ctx.fill();
        // 재시도 고리 — 같은 단계에 다시 들어간 횟수만큼 점선 고리를 겹쳐 천천히 돈다.
        if (phase && n.retries) {
          ctx.globalAlpha = 0.75; ctx.strokeStyle = KIND_COLOR.HEAL; ctx.lineWidth = 1;
          ctx.setLineDash([3, 3]);
          for (let k = 1; k <= Math.min(4, n.retries); k += 1) {
            ctx.lineDashOffset = reduce ? 0 : -(tick * (0.4 + k * 0.1));
            ctx.beginPath(); ctx.arc(c.x, c.y, r + 4 + k * 4, 0, Math.PI * 2); ctx.stroke();
          }
          ctx.setLineDash([]);
        }
        if (phase && n.current && !reduce) {
          const k = (tick % 60) / 60;
          ctx.strokeStyle = color; ctx.globalAlpha = 1 - k; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(c.x, c.y, r + k * 18, 0, Math.PI * 2); ctx.stroke();
        }
      }
      // 라벨 — 큰 노드만 · 모노 대문자.
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      for (const n of g.nodes) {
        if (!LABELED.has(n.kind)) continue;
        const c = P(n.id)!;
        ctx.fillStyle = n.kind === 'harness' ? '#eef2ff' : n.kind === 'phase' ? 'rgba(199,210,254,.65)' : 'rgba(226,232,240,.82)';
        ctx.font = n.kind === 'harness' ? '600 12px ui-monospace, SFMono-Regular, monospace' : '10px ui-monospace, SFMono-Regular, monospace';
        const label = n.kind === 'harness' ? 'ELANOUS HARNESS' : n.kind === 'phase' ? n.label : n.label.toUpperCase();
        ctx.fillText(label, c.x + RADIUS[n.kind] + 4, c.y + 3);
      }
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    const click = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const x = (ev.clientX - rect.left) / rect.width;
      const y = (ev.clientY - rect.top) / rect.height;
      const hit = graphRef.current.nodes.find((n) => n.kind === 'run' && Math.hypot(n.x - x, n.y - y) < 0.02);
      if (hit) onSelectRun?.(hit.id.replace(/^run:/, ''));
    };
    canvas.addEventListener('click', click);
    return () => { cancelAnimationFrame(raf); canvas.removeEventListener('click', click); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSelectRun]);

  const g = board.gauges;
  const best = bestRun(board);
  const cycleRun = best?.run ?? null;
  const rounds = Object.values(board.rounds);
  const kindCounts = DECISION_KINDS.map((k) => ({ k, n: board.stream.filter((s) => s.kind === k).length }));
  const reqTokens = reqs.reduce((n, r) => n + r.input + r.output, 0);
  const apiUsd = reqs.reduce((n, r) => n + r.apiUsd, 0);
  const topBook = Math.max(1, ...reqs.slice(0, 10).map((x) => x.input + x.output));
  const bestChips = cycleRun ? LIVE_STAGES.filter((s) => cycleRun.stages[s]) : [];

  return (
    <div className="live-stage live-v5 space-y-1.5 rounded-xl p-1.5 text-slate-100" data-live-max-stage data-live-v5>
      {/* ① 위 띠 A — 워드마크 · LIVE · 판단 요약 흐름 · 시계 */}
      <div className="flex items-center gap-3 rounded-md border border-indigo-400/10 bg-slate-950/60 px-2 py-1">
        <span className="shrink-0 text-xl tracking-tight text-slate-50" style={{ fontFamily: 'Georgia, "Times New Roman", serif' }}>Elanous</span>
        <span className="hidden shrink-0 font-mono text-[11px] sm:inline lg:text-[10.5px] tracking-[.18em] text-indigo-200/80">× HARNESS · 판단</span>
        <Badge tone="live">● LIVE</Badge>
        <div className="min-w-0 flex-1">
          <Ticker ariaLabel="판단 띠" bare items={board.stream.slice(0, 16).map((s, i) => (
            <span key={`${s.ts}-${i}`} className="mx-4 whitespace-nowrap"><span style={{ color: KIND_COLOR[s.kind] }}>▸ {s.kind}</span> <span className="text-slate-300">{s.what}</span>{s.target && <span className="text-slate-500"> → {s.target}</span>}</span>
          ))} />
        </div>
        <span className="shrink-0 font-mono text-lg tabular-nums text-slate-200" suppressHydrationWarning>{clock}</span>
      </div>
      {/* ② 위 띠 B — 모델별 요청 ▲▼ · 런 · 병합 */}
      <Ticker ariaLabel="모델 띠" slow items={[
        <span key="live" className="mx-4 whitespace-nowrap"><span className="text-rose-300">● LIVE RUNS</span> {g.live}</span>,
        <span key="ship" className="mx-4 whitespace-nowrap"><span className="text-emerald-300">SHIPPED</span> {g.shipped}</span>,
        <span key="dpm" className="mx-4 whitespace-nowrap"><span className="text-indigo-300">DECISIONS/MIN</span> {g.decisionsPerMin}</span>,
        <span key="burn" className="mx-4 whitespace-nowrap"><span className="text-indigo-300">BURN/MIN</span> {compact(g.burnTokensPerMin)}</span>,
        ...derived.ticker.map((t) => (
          <span key={t.model} className="mx-4 whitespace-nowrap">
            <span style={{ color: modelColor(t.model) }}>{t.model.toUpperCase()}</span>{' '}
            <span className={t.delta > 0 ? 'text-emerald-300' : t.delta < 0 ? 'text-rose-300' : 'text-slate-400'}>{t.delta > 0 ? '▲' : t.delta < 0 ? '▼' : '■'}</span>{' '}
            {t.count} req · {compact(t.tokens)} tok
          </span>
        )),
      ]} />

      {/* ③④⑤ 영웅 셋 */}
      <div className="grid grid-cols-12 gap-1.5">
        <Panel className="col-span-12 lg:col-span-4" title="SHIPPED · 병합된 PR" stat={`${shippedSource === 'github' ? 'GITHUB' : 'LOG'} · ${windowMinutes >= 60 ? `${windowMinutes / 60}H` : `${windowMinutes}M`}`}>
          <div className="flex items-end gap-3">
            <Big value={g.shipped} accent={KIND_COLOR.SHIP} />
            <div className="mb-3 flex flex-col gap-1">
              <Badge tone="ok">MERGED</Badge>
              {g.selfHealRuns > 0 && <Badge tone="heal">SELF-HEALED</Badge>}
              {board.snapshot.counters.blocked > 0 && <Badge tone="bad">BLOCKED {board.snapshot.counters.blocked}</Badge>}
            </div>
          </div>
          <div className="mt-1 grid grid-cols-3 gap-2 border-t border-indigo-400/10 pt-2">
            <Small label="SELF-HEAL" value={g.selfHealRate === null ? '—' : `${g.selfHealRate}%`} color={KIND_COLOR.HEAL} />
            <Small label="RUNS" value={String(board.snapshot.runs.length)} color="#c7d2fe" />
            <Small label="DECISIONS" value={String(g.decisions)} color={KIND_COLOR.PLAN} />
          </div>
        </Panel>
        <Panel className="col-span-12 lg:col-span-4" title={best?.why === 'merged' ? 'BEST RUN · 오늘 최고의 런' : 'NOW · 지금 런'} stat={cycleRun ? `R ${board.rounds[cycleRun.runId] ?? 0}/3` : '—'}>
          {cycleRun ? (
            <button type="button" className="block w-full text-left" onClick={() => onSelectRun?.(cycleRun.runId)} data-live-v5-best>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-slate-400">{role === 'owner' ? cycleRun.runId : '런'}</span>
                {best?.why === 'merged' ? <Badge tone="ok">VERIFIED · MERGED{cycleRun.pr ? ` #${cycleRun.pr}` : ''}</Badge> : <Badge tone="live">IN FLIGHT</Badge>}
              </div>
              <div className="mt-1 flex items-baseline gap-3">
                <span className="font-mono text-6xl font-semibold tabular-nums text-indigo-100" style={{ textShadow: '0 0 24px #818cf888' }}>{cycleRun.pr ? `#${cycleRun.pr}` : cycleRun.current ? LIVE_STAGE_LABEL[cycleRun.current] : '—'}</span>
                <span className="font-mono text-xs text-slate-400">{cycleRun.events} signals · 라운드 {board.rounds[cycleRun.runId] ?? 0}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {bestChips.map((s) => {
                  const tone = cycleRun.stages[s];
                  return <Badge key={s} tone={tone === 'bad' ? 'bad' : tone === 'ok' ? 'ok' : 'dim'}>{LIVE_STAGE_LABEL[s]}{tone === 'ok' ? ' ✓' : tone === 'bad' ? ' ✗' : ''}</Badge>;
                })}
              </div>
            </button>
          ) : <p className="py-6 text-xs text-slate-500">이 창에 런 신호가 없다 — ▶ REPLAY 로 최근 판단을 본다.</p>}
        </Panel>
        <Panel className="col-span-12 lg:col-span-4" title={`LLM · ${derived.bucketMin}분 봉 ⊕ 요청 창`} stat={`${reqs.length} REQ · ${compact(reqTokens)} TOK`}>
          <div className="grid grid-cols-5 gap-2">
            <Candles candles={derived.candles} color={modelColor} unit={`/${derived.bucketMin}M`} className="col-span-3" />
            <ul className="col-span-2 h-28 space-y-0.5 overflow-hidden font-mono text-[11px] lg:text-[10px]" data-live-v5-book>
              {reqs.slice(0, 10).map((r, i) => (
                <li key={`${r.ts}-${i}`} className={`relative flex justify-between gap-1 overflow-hidden px-1 ${i === 0 ? 'live-line-in' : ''}`}>
                  <span className="absolute inset-y-0 right-0 opacity-20" style={{ width: `${((r.input + r.output) / topBook) * 100}%`, background: modelColor(r.model) }} />
                  <span className="relative truncate" style={{ color: modelColor(r.model) }}>{r.model}</span>
                  <span className="relative tabular-nums text-slate-300">{compact(r.input + r.output)}</span>
                </li>
              ))}
              {reqs.length === 0 && <li className="text-slate-500">요청 없음</li>}
            </ul>
          </div>
        </Panel>
      </div>

      {/* ⑥ 실행 사이클 */}
      <Panel title="EXECUTION CYCLE · 하니스 한 바퀴" stat={`${cycleRun ? `ROUND ${board.rounds[cycleRun.runId] ?? 0}/3 · ` : ''}NEXT ${nextIn}S`}>
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-6">
          {LIVE_STAGES.map((s, i) => {
            const hot = cycleRun ? cycleRun.current === s : derived.load.busiest === s;
            const tone = cycleRun?.stages[s];
            return (
              <div key={s} data-live-v5-stage={s} data-hot={hot ? '1' : undefined} className={`rounded-md border px-3 py-2 ${hot ? 'live-v5-hot' : ''}`} style={hot ? { borderColor: '#a78bfa', boxShadow: '0 0 18px #a78bfa66, inset 0 0 18px #a78bfa33', background: 'rgba(124,58,237,.28)' } : { borderColor: 'rgba(99,102,241,.18)', background: 'rgba(2,6,23,.55)' }}>
                <div className="flex justify-between font-mono text-[11px] lg:text-[10px] text-slate-400">
                  <span>{String(i + 1).padStart(2, '0')}</span>
                  {tone && <span style={{ color: TONE_COLOR[tone] }}>{tone === 'ok' ? '✓' : tone === 'bad' ? '✗' : '●'}</span>}
                </div>
                <div className="flex items-baseline justify-between">
                  <span className={hot ? 'text-sm font-semibold text-white' : 'text-sm text-slate-300'}>{LIVE_STAGE_LABEL[s]}</span>
                  <span className="font-mono text-xs tabular-nums text-slate-400" title="지금 이 단계에 있는 런">{derived.load.counts[s]}</span>
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      {/* ⑦ 판단 그래프 ⊕ ⑧ 통계 상자 */}
      <div className="grid grid-cols-12 gap-1.5">
        <Panel className="relative col-span-12 xl:col-span-10" title="JUDGMENT GRAPH · FORCE" stat={`NODES ${graphSize.nodes} · EDGES ${graphSize.edges}`} bodyClass="p-0" hot>
          <canvas ref={canvasRef} className="h-[370px] w-full bg-[radial-gradient(ellipse_at_center,rgba(79,70,229,.26),rgba(2,6,23,.96)_70%)]" aria-label="판단 그래프" />
          <div className="pointer-events-none absolute left-3 top-9 flex flex-col gap-0.5 rounded-md bg-slate-950/60 p-2 font-mono text-[11px] lg:text-[10px]">
            {kindCounts.map(({ k, n }) => <span key={k} style={{ color: KIND_COLOR[k] }}>● {k} <span className="text-slate-400">{n}</span></span>)}
          </div>
          <button
            type="button"
            onClick={replay}
            disabled={replaying || board.stream.length === 0}
            data-elanous-action="live-replay"
            className="absolute bottom-3 right-3 rounded-full border border-indigo-400/40 bg-slate-950/70 px-3 py-1 font-mono text-[11px] lg:text-[10px] text-indigo-200 hover:bg-indigo-500/20 disabled:opacity-40"
            title="이 창의 판단을 옛것부터 빨리 감기(최근 40)"
          >
            {replaying ? `REPLAY · ${queueRef.current.length}` : '▶ REPLAY'}
          </button>
          {card && <DecisionCard item={card.item} folding={card.folding} role={role} />}
        </Panel>
        <Panel className="col-span-12 xl:col-span-2" title="STATS" stat={`${nextIn}S`}>
          <dl className="grid grid-cols-2 gap-x-2 gap-y-1.5 font-mono" data-live-v5-stats>
            <Stat label="PATHS" value={board.stream.reduce((s, d) => s + (d.paths ?? 0), 0) || '—'} />
            <Stat label="CONV" value={board.convergence.length ? `${board.convergence.filter((c) => c.points.at(-1)?.asks === 0).length}/${board.convergence.length}` : '—'} />
            <Stat label="ROUNDS AVG" value={rounds.length ? (rounds.reduce((a, b) => a + b, 0) / rounds.length).toFixed(1) : '—'} />
            <Stat label="DECISIONS/MIN" value={g.decisionsPerMin} />
            <Stat label="SIGNALS" value={rows.length} />
            <Stat label="LLM REQ" value={reqs.length} />
            {publicCapture ? <Stat label="MODELS" value={derived.ticker.length} /> : <Stat label="API ≈ USD" value={`$${apiUsd.toFixed(2)}`} />}
            <Stat label="NEXT POLL" value={`${nextIn}s`} />
          </dl>
        </Panel>
      </div>

      {/* ⑨ 히트맵 · ⑩ 분포 · ⑪ 수렴 ⊕ 게이트 · ⑫ 실행 로그(한 화면 1920×1080 에 들어가게 아래 줄 넷째 칸으로) */}
      <div className="grid grid-cols-12 gap-1.5">
        <Panel className="col-span-12 md:col-span-6 xl:col-span-3" title="MODEL × SITE · 요청 수" stat={`MAX ${derived.heat.max}`}>
          <Heat heat={derived.heat} color={modelColor} />
        </Panel>
        <Panel className="col-span-12 md:col-span-6 xl:col-span-3" title="DISTRIBUTION · 런 소요 ⊕ 요청 토큰" stat={`${derived.spans} RUNS · ${reqs.length} REQ`}>
          <div className="grid grid-cols-2 gap-2">
            <Hist hist={derived.hist} label={(v) => `${v.toFixed(0)}분`} />
            <Hist hist={derived.tokHist} label={(v) => compact(10 ** v)} />
          </div>
        </Panel>
        <Panel className="col-span-12 md:col-span-6 xl:col-span-3" title="CONVERGENCE · must-fix ⊕ GATE" stat={`${board.convergence.length} PR`}>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2"><Convergence series={board.convergence} /></div>
            <GateBars pass={derived.gate.pass} fail={derived.gate.fail} verdicts={board.snapshot.reviewVerdicts} />
          </div>
        </Panel>
        <Panel className="col-span-12 md:col-span-6 xl:col-span-3" title="EXECUTION LOG · LIVE" stat={`${board.stream.length}`} bodyClass="px-2 py-1">
          <ul className="h-[124px] space-y-0.5 overflow-hidden font-mono text-[11px] lg:text-[10.5px]" data-live-max-stream>
            {board.stream.slice(0, 9).map((s, i) => (
              <li key={`${s.ts}-${i}`} className={`flex gap-1.5 ${i === 0 ? 'live-line-in' : ''}`} style={s.kind === 'SHIP' ? { textShadow: `0 0 10px ${KIND_COLOR.SHIP}` } : undefined}>
                <span className="shrink-0 text-slate-500" title={s.ts}>{clockTime(s.ts)}</span>
                <span className="w-14 shrink-0 rounded px-1 text-center" style={{ color: KIND_COLOR[s.kind], background: `${KIND_COLOR[s.kind]}1f` }}>{s.kind}</span>
                <span className="truncate">{s.what}{s.target && <span className="text-slate-500"> → {s.target}</span>}</span>
              </li>
            ))}
            {board.stream.length === 0 && <li className="text-slate-500">이 창에 판단 신호가 없다.</li>}
          </ul>
        </Panel>
      </div>

      {/* ⑬ 아래 띠 */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-md border border-indigo-400/10 bg-slate-950/60 px-3 py-1 font-mono text-[11px] lg:text-[10px] text-slate-400">
        <span>STACK <span className="text-slate-200">elanous-core</span></span>
        <span>SOURCE <span className="text-slate-200">{sourceLabel}</span></span>
        <span>SIGNALS <span className="text-slate-200">{rows.length}</span></span>
        <span>LLM <span className="text-slate-200">{reqs.length} req</span></span>
        <span>EMITTED <span className="text-slate-200">{board.emitted}</span></span>
        {publicCapture && <span className="text-emerald-300" data-live-public-capture>PUBLIC CAPTURE · 계정·과금 가림</span>}
        <span className="ml-auto">EVERY NUMBER IS REAL · 보이는 수는 전부 진짜</span>
      </div>
    </div>
  );
}

function compact(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(Math.round(n));
}

/** 칸 — 머리 `▸ 대문자 모노` ⊕ 오른쪽 위 작은 수. `hot` 이면 «지금» 칸(보라 광채 테두리 · 화면에 한두 칸만). */
function Panel({ title, stat, children, className = '', bodyClass = 'p-2.5', hot = false }: { title: string; stat?: string; children: React.ReactNode; className?: string; bodyClass?: string; hot?: boolean }) {
  return (
    <section
      className={`overflow-hidden rounded-lg border bg-slate-950/70 ${className}`}
      style={hot ? { borderColor: 'rgba(167,139,250,.7)', boxShadow: '0 0 22px #a78bfa33' } : { borderColor: 'rgba(99,102,241,.16)' }}
      aria-label={title}
      data-live-v5-panel={title}
    >
      <header className="flex items-center justify-between border-b border-indigo-400/10 px-2.5 py-1 font-mono text-[11px] lg:text-[10.5px] tracking-[.08em] text-slate-400">
        <span>▸ {title}</span>
        {stat && <span className="tabular-nums text-slate-300">{stat}</span>}
      </header>
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

function Badge({ tone, children }: { tone: 'live' | 'ok' | 'bad' | 'heal' | 'dim'; children: React.ReactNode }) {
  const c = tone === 'ok' ? KIND_COLOR.SHIP : tone === 'bad' ? KIND_COLOR.ESCALATE : tone === 'heal' ? KIND_COLOR.HEAL : tone === 'dim' ? '#a5b4fc' : '#f0abfc';
  return (
    <span className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[11px] lg:text-[10px] font-semibold tracking-wider ${tone === 'live' ? 'live-v5-blink' : ''}`} style={{ color: c, background: `${c}22`, boxShadow: `inset 0 0 0 1px ${c}66` }}>
      {children}
    </span>
  );
}

function Small({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div>
      <div className="font-mono text-[11px] lg:text-[9.5px] tracking-widest text-slate-500">{label}</div>
      <div className="font-mono text-3xl font-semibold tabular-nums" style={{ color, textShadow: `0 0 14px ${color}55` }}>{value}</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="border-b border-indigo-400/10 pb-1">
      <dt className="text-[11px] lg:text-[9.5px] tracking-widest text-slate-500">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-indigo-100">{value}</dd>
    </div>
  );
}

/** 흐르는 띠 — 같은 목록을 두 번 이어 붙여 끊김 없이 흐른다(`prefers-reduced-motion` 이면 멈춘다). */
function Ticker({ items, ariaLabel, slow = false, bare = false }: { items: React.ReactNode[]; ariaLabel: string; slow?: boolean; bare?: boolean }) {
  return (
    <div className={`relative overflow-hidden font-mono text-[11px] ${bare ? '' : 'rounded-md border border-indigo-400/10 bg-slate-950/60 py-1'}`} aria-label={ariaLabel}>
      {items.length === 0 ? <span className="px-3 text-slate-500">—</span> : (
        <div className="live-v5-marquee flex w-max" style={{ animationDuration: `${Math.max(30, items.length * (slow ? 9 : 6))}s` }}>
          <div className="flex">{items}</div>
          <div className="flex" aria-hidden>{items}</div>
        </div>
      )}
    </div>
  );
}

/** 굴러가는 거대 숫자 — 새 값으로 부드럽게 따라간다(마운트 뒤에만 움직인다). */
function Big({ value, accent }: { value: number; accent: string }) {
  const [shown, setShown] = useState(value);
  const [flash, setFlash] = useState(false);
  const prev = useRef(value);
  useEffect(() => {
    const from = prev.current;
    const to = value;
    if (to > from) { setFlash(true); setTimeout(() => setFlash(false), 700); }
    prev.current = to;
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / 900);
      setShown(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return (
    <div className="font-mono text-[112px] font-semibold leading-none tabular-nums" style={{ color: accent, textShadow: `0 0 ${flash ? 40 : 26}px ${accent}${flash ? 'cc' : '66'}` }} data-live-max-gauge="SHIPPED">
      {Math.round(shown)}
    </div>
  );
}

/** 분당 봉 — 막대 = 요청 수, 모델 색으로 쌓는다. */
function Candles({ candles, color, unit, className = '' }: { candles: ReturnType<typeof usageCandles>; color: (m: string) => string; unit: string; className?: string }) {
  const top = Math.max(1, ...candles.map((c) => c.count));
  const W = 240; const H = 120; const bw = W / candles.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={`h-28 w-full ${className}`} data-live-v5-candles aria-label="분당 LLM 요청">
      {[0.25, 0.5, 0.75].map((f) => <line key={f} x1={0} x2={W} y1={H * f} y2={H * f} stroke="#1e293b" strokeDasharray="2 3" />)}
      {candles.map((c, i) => {
        let y = H;
        return Object.entries(c.byModel).map(([m, n]) => {
          const h = (n / top) * (H - 6);
          y -= h;
          return <rect key={`${i}-${m}`} x={i * bw + 1} y={y} width={Math.max(1, bw - 2)} height={h} fill={color(m)} opacity={0.85} />;
        });
      })}
      <text x={W - 2} y={10} fill="#64748b" fontSize={8} fontFamily="monospace" textAnchor="end">{top}{unit}</text>
    </svg>
  );
}

function Heat({ heat, color }: { heat: ReturnType<typeof modelSiteHeatmap>; color: (m: string) => string }) {
  if (heat.models.length === 0) return <p className="py-6 text-xs text-slate-500">이 창에 요청이 없다.</p>;
  const level = (n: number) => (n === 0 ? 0 : Math.min(5, Math.ceil((n / Math.max(1, heat.max)) * 5)));
  return (
    <table className="w-full border-separate border-spacing-0.5 font-mono text-[11px] lg:text-[10px]" data-live-v5-heat>
      <thead><tr><th />{heat.sites.map((s) => <th key={s} className="max-w-16 truncate font-normal text-slate-500">{s}</th>)}</tr></thead>
      <tbody>
        {heat.models.map((m) => (
          <tr key={m}>
            <td className="max-w-24 truncate pr-1" style={{ color: color(m) }}>{m}</td>
            {heat.sites.map((s) => {
              const n = heat.cells[`${m}|${s}`] ?? 0;
              const lv = level(n);
              return (
                <td key={s} className="rounded-sm px-1 py-0.5 text-center tabular-nums" style={{ background: lv ? `rgba(167,139,250,${0.12 + lv * 0.15})` : 'rgba(30,41,59,.5)', color: lv >= 4 ? '#fff' : '#cbd5e1' }}>
                  {n || '·'}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Hist({ hist, label }: { hist: ReturnType<typeof histogram>; label: (v: number) => string }) {
  const W = 200; const H = 90; const bw = W / hist.bins.length;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-20 w-full" data-live-v5-hist aria-label="분포">
        <defs>
          <linearGradient id="v5hist" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor={KIND_COLOR.HEAL} />
            <stop offset="60%" stopColor={KIND_COLOR.PLAN} />
            <stop offset="100%" stopColor={KIND_COLOR.ROUTE} />
          </linearGradient>
        </defs>
        {hist.bins.map((n, i) => {
          const h = hist.max ? (n / hist.max) * (H - 4) : 0;
          return <rect key={i} x={i * bw + 0.5} y={H - h} width={Math.max(1, bw - 1)} height={h} fill="url(#v5hist)" opacity={0.9} />;
        })}
        <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} stroke="#334155" />
      </svg>
      <div className="flex justify-between font-mono text-[11px] lg:text-[9.5px] text-slate-500">
        <span>{hist.max ? label(hist.lo) : '—'}</span>
        <span>{hist.max ? label(hist.hi) : ''}</span>
      </div>
    </div>
  );
}

function GateBars({ pass, fail, verdicts }: { pass: number; fail: number; verdicts: Array<{ name: string; count: number }> }) {
  const items = [{ name: 'GATE ✓', count: pass, c: KIND_COLOR.SHIP }, { name: 'GATE ✗', count: fail, c: KIND_COLOR.ESCALATE },
    ...verdicts.slice(0, 3).map((v) => ({ name: v.name.toUpperCase(), count: v.count, c: KIND_COLOR.VERIFY }))];
  const top = Math.max(1, ...items.map((i) => i.count));
  return (
    <ul className="space-y-1 font-mono text-[11px] lg:text-[9.5px]" data-live-v5-gate>
      {items.map((i) => (
        <li key={i.name}>
          <div className="flex justify-between text-slate-400"><span className="truncate">{i.name}</span><span className="tabular-nums text-slate-200">{i.count}</span></div>
          <div className="h-1.5 rounded-full bg-slate-800"><div className="h-1.5 rounded-full" style={{ width: `${(i.count / top) * 100}%`, background: i.c, boxShadow: `0 0 8px ${i.c}88` }} /></div>
        </li>
      ))}
    </ul>
  );
}

/** 판단 카드 — 세 칸(무엇·왜·어디로). 접히면 작아지며 사라지고 그 순간 입자가 날아간다. */
function DecisionCard({ item, folding, role }: { item: DecisionCardItem; folding: boolean; role: PwaRole }) {
  const { line } = item;
  const color = KIND_COLOR[line.kind];
  return (
    <div
      data-live-decision-card={line.kind}
      className="pointer-events-none absolute left-1/2 top-12 w-[min(92%,580px)] rounded-xl border bg-slate-950/85 p-3 backdrop-blur transition-all duration-200"
      style={{ borderColor: `${color}88`, boxShadow: `0 0 32px ${color}55`, opacity: folding ? 0 : 1, transform: `translateX(-50%) scale(${folding ? 0.6 : 1})` }}
    >
      <div className="mb-2 flex items-center gap-2 font-mono text-[11px] lg:text-[10px]">
        <span style={{ color }}>● {line.kind}</span>
        <span className="text-slate-500">{clockTime(line.ts)}</span>
        {role === 'owner' && line.runId && <span className="text-slate-500">{line.runId.replace(/^run-/, '').slice(0, 8)}</span>}
        {line.paths ? <span className="ml-auto text-slate-400">PATHS {line.paths}</span> : null}
      </div>
      <div className="grid grid-cols-3 gap-2 text-[11px] leading-snug">
        <Cell label="무엇 · WHAT" value={line.what} strong />
        <Cell label="왜 · WHY" value={foldForRole(line.why, role) ?? line.purpose} />
        <Cell label="어디로 · TO" value={line.target} accent={color} />
      </div>
    </div>
  );
}

function Cell({ label, value, strong = false, accent }: { label: string; value: string | null; strong?: boolean; accent?: string }) {
  return (
    <div className="min-w-0">
      <div className="font-mono text-[11px] lg:text-[9px] tracking-widest text-slate-500">{label}</div>
      <div className={strong ? 'line-clamp-3 font-medium text-slate-100' : 'line-clamp-3 text-slate-300'} style={accent && value ? { color: accent } : undefined}>{value ?? '—'}</div>
    </div>
  );
}

/** 수렴(§0b ⑤) — PR 마다 라운드별 must-fix. 0 에 닿으면 초록. */
function Convergence({ series }: { series: LiveBoardData['convergence'] }) {
  const top = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.asks)));
  const rounds = Math.max(3, ...series.flatMap((s) => s.points.map((p) => p.round)));
  const W = 200; const H = 100;
  const L = 20; const R = 34; const B = 16; const T = 12;
  const x = (r: number) => L + ((r - 1) / Math.max(1, rounds - 1)) * (W - L - R);
  const y = (a: number) => H - B - (a / top) * (H - B - T);
  const ticks = Array.from({ length: rounds }, (_, i) => i + 1);
  return (
    <div data-live-convergence>
      {series.length === 0 ? <div className="py-8 text-center text-[11px] text-slate-500">이 창에 리뷰 라운드가 없다.</div> : (
        <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full">
          <line x1={L} y1={H - B} x2={W - R} y2={H - B} stroke="#334155" />
          <line x1={L} y1={T} x2={L} y2={H - B} stroke="#334155" />
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} y1={T} x2={x(t)} y2={H - B} stroke="#1e293b" strokeDasharray="2 3" />
              <text x={x(t)} y={H - 4} fill="#64748b" fontSize={8} fontFamily="monospace" textAnchor="middle">R{t}</text>
            </g>
          ))}
          <text x={L - 3} y={y(top) + 3} fill="#64748b" fontSize={8} fontFamily="monospace" textAnchor="end">{top}</text>
          <text x={L - 3} y={y(0) + 3} fill={KIND_COLOR.SHIP} fontSize={8} fontFamily="monospace" textAnchor="end">0</text>
          {series.slice(0, 6).map((s, i) => {
            const last = s.points.at(-1)!;
            const c = last.asks === 0 ? KIND_COLOR.SHIP : ['#818cf8', '#fbbf24', '#38bdf8', '#f0abfc', '#fb7185'][i % 5]!;
            return (
              <g key={s.pr}>
                <polyline fill="none" stroke={c} strokeWidth={1.6} points={s.points.map((p) => `${x(p.round)},${y(p.asks)}`).join(' ')} />
                {s.points.map((p) => <circle key={p.round} cx={x(p.round)} cy={y(p.asks)} r={2.5} fill={c} />)}
                <text x={x(last.round) + 4} y={y(last.asks) - 3} fill={c} fontSize={8} fontFamily="monospace">#{s.pr} {last.asks}</text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
