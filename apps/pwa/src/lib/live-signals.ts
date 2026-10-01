// Live 탭 집계 — 로그 줄(진짜 신호)을 «런 막대 · 판단 카드 · 카운터 · 분포»로 접는다.
// 순수 함수라 react·DOM 없이 시험한다. 화면은 이 결과를 그리기만 한다.
// 기획: 내부 문서 `PLAN-live-signals-tab-teaser-and-web-2026-09-28` §0·§2
//
// ⛔ 값을 지어내지 않는다 — 로그에 없는 단계는 «안 보였다»로 남는다(«통과»로 칠하지 않는다).

import type { HarnessRunEntry, LogRow } from '@/nexus/client';
import { gateDecisionText } from './live-gate-decision';

export const LIVE_STAGES = ['author', 'decompose', 'build', 'gate', 'review', 'land'] as const;
export type LiveStage = (typeof LIVE_STAGES)[number];

export const LIVE_STAGE_LABEL: Record<LiveStage, string> = {
  author: '저작',
  decompose: '분해',
  build: '구현',
  gate: '게이트',
  review: '리뷰',
  land: '착지',
};

/** 로그가 가리키는 단계와 성격. 카테고리는 접두 일치. 없으면 null(단계 밖 신호 — 로그 줄로만 흐른다). */
export function classifySignal(row: Pick<LogRow, 'category' | 'event' | 'level'> & { data?: LogRow['data'] }): {
  stage: LiveStage | null;
  tone: 'ok' | 'bad' | 'info';
} {
  const c = row.category;
  const e = row.event;
  const bad = row.level === 'error'
    || /(fail|reject|block|abandon|conflict|error|unconvergeable|timeout)/i.test(e);
  const tone = bad ? 'bad' : /(merged|pass|done|ok|opened|completed|approved)/i.test(e) ? 'ok' : 'info';
  // 파드 런(S4a #22329) — 게이트·리뷰는 파드 안에서 돌고 호스트엔 `self-implement.pod.ledger` 사건이 `data.stage` 로 온다.
  //   이 칸이 없으면 파드 런의 게이트·리뷰가 Trace·Live 에 영영 안 켜진다(2026-10-01 06:2x 실측: 단계 줄이 저작·분해·구현뿐).
  if (c === 'self-implement.pod.ledger' && typeof row.data?.stage === 'string') {
    const st = row.data.stage;
    const status = typeof row.data.status === 'string' ? row.data.status : '';
    const podTone = /(fail|block|abandon|reject|error)/i.test(status) || /(fail|block|abandon)/i.test(st) ? 'bad' : tone;
    const stage: LiveStage | null = /^(implement|repair)/i.test(st) ? 'build' : /^gat/i.test(st) ? 'gate' : /^review/i.test(st) ? 'review'
      : /(merged|pr-opened|landed|auto-merge)/i.test(st) ? 'land' : null;
    if (stage) return { stage, tone: stage === 'land' && podTone !== 'bad' ? 'ok' : podTone };
  }
  if (c.startsWith('goal-author') || c.startsWith('harness.frontdoor') || (c === 'dev-pipeline' && /^(plan|selection|base-selection)$/.test(e))) return { stage: 'author', tone };
  if ((c.startsWith('self-dev') && /decompos/i.test(e)) || (c === 'self-dev.orchestrate' && e === 'start')) return { stage: 'decompose', tone };
  if (c.startsWith('self-dev.spawn') || c.startsWith('harness.substrate') || c === 'self-implement' || (c === 'dev-pipeline' && e === 'harness.launch')) return { stage: 'build', tone };
  if (c.startsWith('self-gate') || (c.startsWith('self-dev.reduce') && /gate/i.test(e))) return { stage: 'gate', tone };
  if (c.startsWith('review-loop') && /(merged|auto-merge)/i.test(e)) return { stage: 'land', tone: 'ok' };
  if (c.startsWith('review-loop')) return { stage: 'review', tone };
  if ((c.startsWith('self-dev.reduce') && /(pr-opened|merged)/i.test(e)) || (c === 'dev-pipeline' && e === 'done')) return { stage: 'land', tone };
  return { stage: null, tone };
}

export interface LiveRun {
  runId: string;
  /** 단계마다 마지막으로 본 성격 — 없으면 그 단계 신호를 못 봤다. */
  stages: Partial<Record<LiveStage, 'ok' | 'bad' | 'info'>>;
  current: LiveStage | null;
  lastTs: string;
  events: number;
  blocked: boolean;
  pr: string | null;
  /** 원장에서 온 상태(있으면). */
  ledgerStatus: string | null;
}

export interface LiveCard {
  ts: string;
  runId: string | null;
  tone: 'ok' | 'bad' | 'info';
  text: string;
}

export interface LiveSnapshot {
  runs: LiveRun[];
  cards: LiveCard[];
  counters: {
    activeRuns: number;
    llmRequests: number;
    llmRequestsPerMin: number;
    tokens: number;
    landed: number;
    blocked: number;
  };
  providers: Array<{ name: string; count: number }>;
  reviewVerdicts: Array<{ name: string; count: number }>;
  windowMinutes: number;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 사람이 읽는 판단 카드 문장 — 알려진 결정만. 모르는 것은 카드로 만들지 않는다. */
export function cardText(row: LogRow): string | null {
  const d = row.data ?? {};
  const pr = str(d.pr) ?? (num(d.prNumber) ? String(d.prNumber) : null);
  if (row.category.startsWith('review-loop') && row.event === 'judge-verdict') return `리뷰 판정: ${str(d.verdict) ?? '?'}${pr ? ` · #${pr}` : ''}${num(d.asks) ? ` · 요구 ${num(d.asks)}` : ''}`;
  if (row.category.startsWith('review-loop') && /merged/.test(row.event)) return `자동 병합${pr ? ` #${pr}` : ''}`;
  if (row.category.startsWith('review-loop') && row.event === 'rework-start') return `리뷰 반영 라운드 ${num(d.round) || '?'} 시작${pr ? ` · #${pr}` : ''}`;
  if (row.category.startsWith('llm.router') && /fallback/i.test(row.event)) return `모델 폴백: ${str(d.from) ?? '?'} → ${str(d.to) ?? '?'}`;
  if (row.category.startsWith('oauth') && /rotat/i.test(row.event)) return `계정 회전${str(d.account) ? `: ${str(d.account)}` : ''}`;
  if (row.category.startsWith('harness.boundary')) return `경계 밖 쓰기 거절${str(d.path) ? `: ${str(d.path)}` : ''}`;
  if (row.category.startsWith('self-dev.reduce') && /gate-failed/.test(row.event)) return '게이트 실패 → 수리 라운드';
  if (row.category === 'dev-pipeline' && row.event === 'rejected') return `발사 전 검사가 막았다${str(d.reason) ? `: ${str(d.reason)}` : ''}`;
  return null;
}

export function buildLiveSnapshot(
  logs: readonly LogRow[],
  ledger: readonly HarnessRunEntry[],
  opts: { now: number; windowMinutes: number },
): LiveSnapshot {
  const since = opts.now - opts.windowMinutes * 60_000;
  const rows = logs.filter((row) => Date.parse(row.ts) >= since).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const runs = new Map<string, LiveRun>();
  const cards: LiveCard[] = [];
  const providers = new Map<string, number>();
  const verdicts = new Map<string, number>();
  let llmRequests = 0;
  let tokens = 0;
  for (const row of rows) {
    const d = row.data ?? {};
    const runId = str(d.runId);
    if (row.category.startsWith('llm.usage')) {
      llmRequests += 1;
      tokens += num(d.inputTokens) + num(d.outputTokens) + num(d.totalTokens && !d.inputTokens ? d.totalTokens : 0);
      const name = str(d.model) ?? str(d.provider) ?? 'unknown';
      providers.set(name, (providers.get(name) ?? 0) + 1);
    }
    if (row.category.startsWith('review-loop') && row.event === 'judge-verdict') {
      const v = str(d.verdict) ?? 'unknown';
      verdicts.set(v, (verdicts.get(v) ?? 0) + 1);
    }
    const text = cardText(row);
    const { stage, tone } = classifySignal(row);
    if (text) cards.push({ ts: row.ts, runId, tone: /merged/.test(row.event) ? 'ok' : tone, text });
    if (!runId || !stage) continue;
    const run = runs.get(runId) ?? { runId, stages: {}, current: null, lastTs: row.ts, events: 0, blocked: false, pr: null, ledgerStatus: null };
    run.stages[stage] = tone;
    run.current = stage;
    run.lastTs = row.ts;
    run.events += 1;
    run.blocked = tone === 'bad';
    run.pr = str(d.pr) ?? (num(d.prNumber) ? String(num(d.prNumber)) : run.pr);
    runs.set(runId, run);
  }
  const ledgerById = new Map(ledger.map((entry) => [entry.runId, entry]));
  for (const run of runs.values()) run.ledgerStatus = ledgerById.get(run.runId)?.status ?? null;
  const list = [...runs.values()].sort((a, b) => Date.parse(b.lastTs) - Date.parse(a.lastTs));
  const activeRuns = list.filter((run) => run.current !== 'land' && opts.now - Date.parse(run.lastTs) < 15 * 60_000).length;
  const sortDesc = (m: Map<string, number>) => [...m.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  return {
    runs: list,
    cards: cards.slice(-40).reverse(),
    counters: {
      activeRuns,
      llmRequests,
      llmRequestsPerMin: opts.windowMinutes > 0 ? Math.round((llmRequests / opts.windowMinutes) * 10) / 10 : 0,
      tokens,
      landed: list.filter((run) => run.stages.land === 'ok').length,
      blocked: list.filter((run) => run.blocked).length,
    },
    providers: sortDesc(providers),
    reviewVerdicts: sortDesc(verdicts),
    windowMinutes: opts.windowMinutes,
  };
}

/** 흐르는 로그에 싣기 전 비밀처럼 보이는 조각을 가린다(키·토큰·Bearer). */
export function redactLogText(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|xox[abpr]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,})\b/g, '[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/("?(?:token|secret|password|apiKey|api_key|authorization)"?\s*[:=]\s*")[^"]{4,}"/gi, '$1[redacted]"');
}

/** 시각 = 보는 기기의 시간대(🅢 09-28 결정 · 대표 KST) — `HH:MM:SS`. 시험은 `timeZone` 을 고정한다. */
export function clockTime(ts: string, timeZone?: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts.slice(11, 19);
  return d.toLocaleTimeString('en-GB', { hour12: false, ...(timeZone ? { timeZone } : {}) });
}

/** 내부 오류·경로 원문인가 — 일반 역할 화면에 그대로 두면 안 되는 문면. */
export function isRawErrorText(s: string): boolean {
  return /Error:|ENOENT|EACCES|EPERM|ECONN|TypeError|\bstack\b|at\s+\S+\s+\(|\/Users\/|\/home\/|\\/.test(s);
}

/** 오너가 아니면 날것 오류 사유를 한 문장으로 접는다. 평문 사유는 그대로. */
export function foldForRole(why: string | null, role: string): string | null {
  if (why == null) return why;
  if (role !== 'owner' && isRawErrorText(why)) return '실패 — 자세한 사유는 오너 화면에서';
  return why;
}

/** 흐르는 로그 한 줄 — 시각(기기 시간대) · 카테고리 · 이벤트 · 짧은 요지. */
export function logLine(row: LogRow, timeZone?: string): string {
  const d = row.data ?? {};
  const bits = ['runId', 'pr', 'verdict', 'model', 'provider', 'round', 'reason']
    .map((k) => (d[k] !== undefined && d[k] !== null && d[k] !== '' ? `${k}=${String(d[k]).slice(0, 40)}` : null))
    .filter(Boolean)
    .join(' ');
  return redactLogText(`${clockTime(row.ts, timeZone)} ${row.category} ${row.event}${bits ? ` · ${bits}` : ''}`);
}

// ── v3·v4(🅢 기획 §0b·§0c) — 판단 종류 · 계기판 · 판단 스트림 · 성적표 · 빈 칸 표 ──────────────

export const DECISION_KINDS = ['PLAN', 'ROUTE', 'VERIFY', 'HEAL', 'ESCALATE', 'SHIP'] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** 한 로그 줄이 «판단»이면 그 종류 — 아니면 null. 알려진 결정만(지어내지 않는다). */
export function decisionKind(row: Pick<LogRow, 'category' | 'event'> & { data?: LogRow['data'] }): DecisionKind | null {
  const c = row.category;
  const e = row.event;
  // 하니스가 직접 낸 판단(🅢 #21452 `emitDecision`) — 종류를 그대로 믿는다(알려진 종류만).
  if (c === 'harness.decision') {
    const k = typeof row.data?.kind === 'string' ? row.data.kind.toUpperCase() : '';
    return (DECISION_KINDS as readonly string[]).includes(k) ? (k as DecisionKind) : null;
  }
  if ((c.startsWith('review-loop') && /merged/.test(e)) || (c.startsWith('self-dev.reduce') && /(pr-opened|merged)/.test(e))) return 'SHIP';
  if (/(needs-human|hitl|escalat|parked)/i.test(e) || (c === 'dev-pipeline' && e === 'rejected')) return 'ESCALATE';
  if ((c.startsWith('review-loop') && /^rework-start$/.test(e)) || /repair|rework-round/i.test(e) || (c.startsWith('self-dev.supervisor') && /(resume|retry)/i.test(e))) return 'HEAL';
  if ((c.startsWith('review-loop') && /verdict/.test(e)) || c.startsWith('self-gate') || (c.startsWith('self-dev.reduce') && /gate/.test(e))) return 'VERIFY';
  if (c.startsWith('oauth.codex-account') && /rotation$/.test(e) || (c.startsWith('llm.router') && /fallback/i.test(e)) || c.startsWith('harness.role-llm') || (c.startsWith('harness.substrate') && /dispatch/.test(e)) || c.startsWith('harness.boundary')) return 'ROUTE';
  if (c.startsWith('goal-author') && /(done|assembled|phase-end)/.test(e) || (c.startsWith('self-dev') && /decompos/i.test(e)) || (c === 'dev-pipeline' && e === 'plan')) return 'PLAN';
  return null;
}

export interface DecisionLine {
  ts: string;
  /** 검토한 선택지 수(`PATHS`) — 하니스가 낸 판단에만. */
  paths?: number;
  kind: DecisionKind;
  runId: string | null;
  what: string;
  why: string | null;
  purpose: string | null;
  target: string | null;
}

export interface LiveBoardData {
  snapshot: LiveSnapshot;
  gauges: {
    live: number;
    decisionsPerMin: number;
    shipped: number;
    selfHealRate: number | null;
    selfHealRuns: number;
    burnTokensPerMin: number;
    decisions: number;
  };
  stream: DecisionLine[];
  /** 하니스가 직접 낸 판단 수(MAX 스위치가 켜졌을 때만 쌓인다). */
  emitted: number;
  rounds: Record<string, number>;
  /** 수렴 곡선(§0b ⑤) — PR 마다 리뷰 라운드별 요구(must-fix) 수. 줄어들면 수렴, 늘면 발산. */
  convergence: Array<{ pr: string; points: Array<{ round: number; asks: number }> }>;
  scorecard: Array<{ model: string; requests: number; tokens: number; billing: string | null }>;
  missing: Array<{ key: string; count: number; lacks: string[] }>;
}

function decisionText(row: LogRow, kind: DecisionKind): string {
  void kind;
  if (row.category === 'harness.decision' && typeof row.data?.what === 'string') return row.data.what;
  return cardText(row) ?? `${row.category} ${row.event}`.slice(0, 80);
}

export function buildLiveBoard(
  logs: readonly LogRow[],
  ledger: readonly HarnessRunEntry[],
  opts: { now: number; windowMinutes: number },
): LiveBoardData {
  const snapshot = buildLiveSnapshot(logs, ledger, opts);
  const since = opts.now - opts.windowMinutes * 60_000;
  const rows = logs.filter((row) => Date.parse(row.ts) >= since).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const stream: DecisionLine[] = [];
  const rounds: Record<string, number> = {};
  const healed = new Set<string>();
  const missing = new Map<string, { count: number; lacks: Set<string> }>();
  const score = new Map<string, { requests: number; tokens: number; billing: string | null }>();
  const conv = new Map<string, Map<number, number>>();
  let tokens = 0;
  // 하니스가 직접 낸 판단(`harness.decision` · MAX 켜짐)이 있으면 그 종류는 그것이 정본 — 같은 종류의 합성 줄은 뺀다(🅢 09-28).
  const emittedKinds = new Set(rows.filter((row) => row.category === 'harness.decision').map((row) => decisionKind(row)).filter(Boolean) as DecisionKind[]);
  for (const row of rows) {
    const d = row.data ?? {};
    const runId = str(d.runId);
    if (row.category.startsWith('review-loop') && num(d.round) && runId) rounds[runId] = Math.max(rounds[runId] ?? 0, num(d.round));
    if (row.category.startsWith('review-loop') && row.event === 'judge-verdict' && str(d.pr) && num(d.round)) {
      const m = conv.get(str(d.pr)!) ?? new Map<number, number>();
      m.set(num(d.round), num(d.asks));
      conv.set(str(d.pr)!, m);
    }
    if (row.category.startsWith('llm.usage')) {
      const t = num(d.inputTokens) + num(d.outputTokens);
      tokens += t;
      const model = str(d.model) ?? 'unknown';
      const cur = score.get(model) ?? { requests: 0, tokens: 0, billing: str(d.billing) };
      cur.requests += 1; cur.tokens += t;
      score.set(model, cur);
    }
    const kind = decisionKind(row);
    if (!kind) continue;
    if (row.category !== 'harness.decision' && emittedKinds.has(kind)) continue;
    const gateText = row.category === 'harness.decision' && typeof d.what === 'string'
      ? gateDecisionText(d.what, str(d.reason) ?? undefined) : null;
    const why = gateText?.why ?? str(d.reason) ?? str(d.why);
    // Gate identifiers and free-form purpose may contain account names or local paths.
    const purpose = gateText ? null : str(d.purpose);
    const target = gateText ? null : str(d.target) ?? str(d.to) ?? str(d.account) ?? (kind === 'SHIP' && (str(d.pr) ?? (num(d.prNumber) ? String(num(d.prNumber)) : null)) ? `#${str(d.pr) ?? num(d.prNumber)}` : null);
    const cardRunId = gateText ? null : runId;
    if (kind === 'HEAL' && runId) healed.add(runId);
    const paths = num(d.paths) || undefined;
    stream.push({ ts: row.ts, kind, runId: cardRunId, what: gateText?.what ?? decisionText(row, kind), why, purpose, target, ...(paths ? { paths } : {}) });
    const lacks = [why ? null : 'why', purpose ? null : 'purpose', target ? null : 'target'].filter(Boolean) as string[];
    if (lacks.length) {
      const key = gateText ? 'harness.decision decision' : `${row.category} ${row.event}`;
      const m = missing.get(key) ?? { count: 0, lacks: new Set<string>() };
      m.count += 1; lacks.forEach((l) => m.lacks.add(l));
      missing.set(key, m);
    }
  }
  const healRuns = [...healed];
  const healedAndShipped = healRuns.filter((id) => snapshot.runs.find((r) => r.runId === id)?.stages.land === 'ok').length;
  return {
    snapshot,
    gauges: {
      live: snapshot.counters.activeRuns,
      decisions: stream.length,
      decisionsPerMin: opts.windowMinutes > 0 ? Math.round((stream.length / opts.windowMinutes) * 10) / 10 : 0,
      shipped: stream.filter((s) => s.kind === 'SHIP').length,
      selfHealRate: healRuns.length ? Math.round((healedAndShipped / healRuns.length) * 100) : null,
      selfHealRuns: healRuns.length,
      burnTokensPerMin: opts.windowMinutes > 0 ? Math.round(tokens / opts.windowMinutes) : 0,
    },
    stream: stream.slice(-80).reverse(),
    emitted: rows.filter((row) => row.category === 'harness.decision').length,
    rounds,
    convergence: [...conv.entries()].map(([pr, m]) => ({ pr, points: [...m.entries()].sort((a, b) => a[0] - b[0]).map(([round, asks]) => ({ round, asks })) })),
    scorecard: [...score.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.requests - a.requests),
    missing: [...missing.entries()].map(([key, v]) => ({ key, count: v.count, lacks: [...v.lacks] })).sort((a, b) => b.count - a.count),
  };
}
