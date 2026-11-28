// FED-ANALYST-LOOP-AGENT (0.3.39 P1 · owner OP) — the 30-minute federation signal ⊕ topology analysis, deterministic.
//
// S: since 11-26 a Claude OP subagent read each 30-min chat-log window (fed-chatlog/<HHMM>/mail.jsonl) ⊕ `eln fed kpi` ⊕
//    `eln pulse throughput` ⊕ `eln fed snapshot` and wrote six «finding → action (who · what · re-check)» lines plus a
//    topology pass board (seat-state/OP/design-archive-1126/fed-ontology-bottleneck-REPORT.md «Δ 변화 HH:MM»).
// C: it depended on a Claude session staying armed (11-27 13:07–15:27 gap) and its numbers were re-derived by hand each time.
// A: this module is the analyst's arithmetic — pure, LLM 0, the same definitions as the Claude analyst's scripts
//    (fed-chatlog-metrics.py machine ratio · fed-topology.py eigenvector · fed-sim-v2-topology.py pass board) so the loop
//    agent's numbers match the hand analysis. The prose of each line is the ONLY LLM part (src/fed-analyst/prose.ts).
//
// 세 얼굴: 관측 = the window's mail rows ⊕ fed-state KPI ⊕ throughput controller row ⊕ open ✋ ⊕ loop exceptions ⊕ board /
//   판단 근거 = the pass board thresholds (agent.yaml policies) ⊕ the owner table (graphs/policies/fed-analyst.yaml) /
//   수복과 인계 = every breached finding carries an action line (who · what · re-check time) and a case (kit/case-ledger) for
//   its owner; a finding that reads ok again resolves its case. «① 본다 ② 정상화» — no finding without an action or an owner.

export interface MailRow { readonly id: number; readonly from: string; readonly to: string; readonly kind: string; readonly createdAt: string; readonly body: string }

/** Lists (graphs/policies/fed-analyst.yaml) — names, not numbers. */
export interface AnalystLists {
  /** Coordinator seats — the eigenvector check takes the max over these. */
  readonly coordinators: readonly string[];
  /** Senders whose mail is machine-made (fed-chatlog-metrics.py MACHINE) — template bodies count too. */
  readonly machineSenders: readonly string[];
  /** Loop agents / stewards — their requests are not «unanswered edges» (a machine re-asks by design). */
  readonly agentSenders: readonly string[];
  /** Addresses never treated as dormant (advisors read by a session, not a pane). */
  readonly notDormant: readonly string[];
  /** Hand seat prefixes (a ✋ sender / a hand edge). */
  readonly handPrefixes: readonly string[];
}

/** Numbers (agent.yaml policies — read through pv() in the body). */
export interface AnalystNumbers {
  readonly window_min: number;
  readonly op_inbound_per_h_max: number;
  readonly machine_ratio_max_pct: number;
  readonly edge_min_requests: number;
  readonly edge_answer_min_pct: number;
  readonly dormant_edges_max: number;
  readonly hand_to_tc_per_h_max: number;
  readonly coord_eigen_max_pct: number;
  readonly hand_stale_min: number;
  readonly lands_per_h_min: number;
  readonly greens_per_h_min: number;
  readonly recheck_min: number;
}

export const DEFAULT_NUMBERS: AnalystNumbers = {
  window_min: 30, op_inbound_per_h_max: 20, machine_ratio_max_pct: 10, edge_min_requests: 3, edge_answer_min_pct: 80,
  dormant_edges_max: 0, hand_to_tc_per_h_max: 10, coord_eigen_max_pct: 40, hand_stale_min: 15, lands_per_h_min: 10,
  greens_per_h_min: 10, recheck_min: 30,
};

export const DEFAULT_LISTS: AnalystLists = {
  coordinators: ['OP', 'TC', 'JUD', 'UX', 'MK', 'RES', 'REL'],
  machineSenders: ['ORCHESTRATOR', 'LAND-GRAPH'],
  agentSenders: ['ORCHESTRATOR', 'LAND-GRAPH', 'LAND-STEWARD', 'JUDGE-BUTLER', 'GUARDIAN', 'SIGNAL-DIGEST', 'GRAPH-TRIGGER', 'POSTOFFICE', 'TC-ADV', 'FED-ANALYST'],
  notDormant: ['CLAUDE-OP', 'OP', 'CEO'],
  handPrefixes: ['TC-H', 'MVP', 'HAND', 'MOB'],
};

const TEMPLATE_PREFIX = ['[✋ RESOLVED', '[OP · re-ask', '[연방 공보', '[pulse', '[행정관', '[BOARD'] as const;
/** fed-chatlog-metrics.py is_machine — a machine sender or a template body. */
export function isMachineMail(m: Pick<MailRow, 'from' | 'body'>, l: AnalystLists): boolean {
  return l.machineSenders.includes(m.from) || TEMPLATE_PREFIX.some(p => m.body.startsWith(p)) || m.body.includes('writer-check');
}
export const isHandRaise = (m: Pick<MailRow, 'body'>): boolean => m.body.includes('NEED HUMAN');
const isRequest = (m: MailRow): boolean => m.kind === 'request' || m.kind === 'question' || isHandRaise(m);

export interface Topology {
  readonly mails: number;
  readonly opInboundPerH: number;
  readonly machineRatioPct: number;
  readonly handToTcPerH: number;
  /** request edges (≥ edge_min_requests) answered below edge_answer_min_pct · «a>b n/answered» */
  readonly badEdges: ReadonlyArray<{ edge: string; requests: number; answered: number }>;
  /** mail to an address with no live reader · «→X n» */
  readonly dormantEdges: ReadonlyArray<{ to: string; mails: number }>;
  readonly eigen: ReadonlyArray<{ seat: string; value: number }>;
  readonly coordEigenMax: { seat: string; value: number } | null;
  readonly topPair: { pair: string; mails: number } | null;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** fed-topology.py eigenvector centrality — undirected weighted, power iteration 200×, self-loops dropped. */
export function eigenvector(mails: readonly Pick<MailRow, 'from' | 'to'>[]): Map<string, number> {
  const U = new Map<string, Map<string, number>>();
  const nodes = new Set<string>();
  for (const m of mails) {
    nodes.add(m.from); nodes.add(m.to);
    if (m.from === m.to) continue;
    for (const [a, b] of [[m.from, m.to], [m.to, m.from]] as const) {
      const row = U.get(a) ?? new Map<string, number>(); row.set(b, (row.get(b) ?? 0) + 1); U.set(a, row);
    }
  }
  const N = [...nodes].sort();
  let x = new Map(N.map(n => [n, 1]));
  for (let i = 0; i < 200; i++) {
    const y = new Map(N.map(n => { let s = 0; for (const [k, w] of U.get(n) ?? []) s += w * (x.get(k) ?? 0); return [n, s] as const; }));
    const norm = Math.sqrt([...y.values()].reduce((a, v) => a + v * v, 0)) || 1;
    x = new Map(N.map(n => [n, y.get(n)! / norm]));
  }
  return x;
}

export function topology(mailsIn: readonly MailRow[], n: AnalystNumbers, l: AnalystLists, live: { panes: ReadonlySet<string> | null; dormantTable: readonly string[] }): Topology {
  const mails = [...mailsIn].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const perH = 60 / n.window_min;
  const opIn = mails.filter(m => m.to === 'OP').length;
  const machine = mails.filter(m => isMachineMail(m, l)).length;
  const handToTc = mails.filter(m => m.to === 'TC' && isHandRaise(m)).length;
  // request edges — a machine/loop-agent sender is excluded (it re-asks by design; its silence is silence-watch's)
  const req = new Map<string, { requests: number; answered: number }>();
  mails.forEach((m, i) => {
    if (!isRequest(m) || l.agentSenders.includes(m.from) || isMachineMail(m, l)) return;
    const t = Date.parse(m.createdAt);
    const ans = mails.slice(i + 1).some(x => x.from === m.to && x.to === m.from && Date.parse(x.createdAt) >= t);
    const k = `${m.from}>${m.to}`; const e = req.get(k) ?? { requests: 0, answered: 0 };
    req.set(k, { requests: e.requests + 1, answered: e.answered + (ans ? 1 : 0) });
  });
  const badEdges = [...req].filter(([, e]) => e.requests >= n.edge_min_requests && (e.answered / e.requests) * 100 < n.edge_answer_min_pct)
    .map(([edge, e]) => ({ edge, ...e })).sort((a, b) => b.requests - a.requests);
  // dormant = the mail-route dormant table ⊕ (when the pane list is known) an address with no pane — minus loop agents/advisors
  const dormantSet = (to: string) => !l.notDormant.includes(to) && !l.agentSenders.includes(to)
    && (live.dormantTable.includes(to) || (live.panes !== null && !live.panes.has(to)));
  const dm = new Map<string, number>();
  for (const m of mails) if (dormantSet(m.to)) dm.set(m.to, (dm.get(m.to) ?? 0) + 1);
  const dormantEdges = [...dm].map(([to, c]) => ({ to, mails: c })).sort((a, b) => b.mails - a.mails || a.to.localeCompare(b.to));
  const ev = eigenvector(mails);
  const eigen = [...ev].map(([seat, value]) => ({ seat, value: r3(value) })).sort((a, b) => b.value - a.value || a.seat.localeCompare(b.seat));
  const coordEigenMax = eigen.find(e => l.coordinators.includes(e.seat)) ?? null;
  const pairs = new Map<string, number>();
  for (const m of mails) { const k = [m.from, m.to].sort().join('<>'); pairs.set(k, (pairs.get(k) ?? 0) + 1); }
  const top = [...pairs].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  return {
    mails: mails.length,
    opInboundPerH: Math.round(opIn * perH),
    machineRatioPct: mails.length ? Math.round((machine / mails.length) * 100) : 0,
    handToTcPerH: Math.round(handToTc * perH),
    badEdges, dormantEdges, eigen: eigen.slice(0, 8), coordEigenMax,
    topPair: top ? { pair: top[0], mails: top[1] } : null,
  };
}

export interface PassCheck { readonly key: 'op-inbound' | 'machine' | 'edges' | 'dormant' | 'hand-tc' | 'eigen'; readonly label: string; readonly value: string; readonly ok: boolean }

/** The topology pass board (fed-sim-v2-topology.py · six lines). */
export function passBoard(t: Topology, n: AnalystNumbers): PassCheck[] {
  const eig = t.coordEigenMax;
  return [
    { key: 'op-inbound', label: `OP 수신 ≤${n.op_inbound_per_h_max}/h`, value: `${t.opInboundPerH}/h`, ok: t.opInboundPerH <= n.op_inbound_per_h_max },
    { key: 'machine', label: `기계 ≤${n.machine_ratio_max_pct}%`, value: `${t.machineRatioPct}%`, ok: t.machineRatioPct <= n.machine_ratio_max_pct },
    { key: 'edges', label: `답·행동 <${n.edge_answer_min_pct}% 간선 0`, value: t.badEdges.length ? t.badEdges.slice(0, 3).map(e => `${e.edge} ${e.requests}/${e.answered}`).join(' · ') : '0', ok: t.badEdges.length === 0 },
    { key: 'dormant', label: `잠든 간선 ≤${n.dormant_edges_max}`, value: t.dormantEdges.length ? t.dormantEdges.slice(0, 3).map(d => `→${d.to} ${d.mails}`).join(' · ') : '0', ok: t.dormantEdges.length <= n.dormant_edges_max },
    { key: 'hand-tc', label: `✋→TC ≤${n.hand_to_tc_per_h_max}/h`, value: `${t.handToTcPerH}/h`, ok: t.handToTcPerH <= n.hand_to_tc_per_h_max },
    { key: 'eigen', label: `조율자 고유벡터 ≤${(n.coord_eigen_max_pct / 100).toFixed(2)}`, value: eig ? `${eig.seat} ${eig.value.toFixed(2)}` : '?', ok: eig !== null && eig.value * 100 <= n.coord_eigen_max_pct },
  ];
}

// ── the six findings ────────────────────────────────────────────────────────────────────────────────────────────────

export interface OpenHandFact { readonly id: number; readonly from: string; readonly to: string; readonly reason: string; readonly waitedMin: number }
export interface Inputs {
  readonly windowStart: Date; readonly windowEnd: Date;
  readonly mails: readonly MailRow[];
  readonly panes: ReadonlySet<string> | null;
  readonly dormantTable: readonly string[];
  /** fed kpi over the last hour / the window (null = unread). */
  readonly kpi1h: { landedPerHour: number; idleWithWorkHands: number; idleWithWorkSeats: readonly string[]; greens: number } | null;
  readonly kpiWin: { claims: number; greens: number } | null;
  /** throughput controller row (latest at or before the window end). */
  readonly throughput: { verdict: string; lever: string; owner: string | null; lands: number | null; greens: number | null } | null;
  readonly hands: readonly OpenHandFact[] | null;
  readonly loops: { total: number; exceptions: ReadonlyArray<{ id: string; owner: string | null; at: string | null }> } | null;
  readonly board: { version: string; total: number; green: number; done: number; p0Yellow: number } | null;
}

export type FindingKey = 'hands' | 'loops' | 'throughput' | 'board' | 'mail-path' | 'op-topology';
export interface Action { readonly who: string; readonly what: string; readonly recheckAt: string; readonly criterion: string }
export interface Finding {
  readonly key: FindingKey; readonly title: string;
  /** ok · breach · unknown (a source unread — shown «?», never 0) */
  readonly status: 'ok' | 'breach' | 'unknown';
  /** the numbers line (deterministic — the prose may rephrase, never renumber) */
  readonly facts: string;
  readonly action: Action | null;
}
export interface Analysis {
  readonly at: string; readonly windowStart: string; readonly windowEnd: string;
  readonly topology: Topology; readonly pass: PassCheck[]; readonly passed: number;
  readonly findings: Finding[];
  /** The one-line answer to «지난 30분 병목?» — the first breached finding (or «병목 없음»). */
  readonly bottleneck: string;
}

const hhmm = (d: Date): string => {
  // KST clock (the federation's working clock · the Claude analyst wrote «재확인 HH:MM» in KST)
  const k = new Date(d.getTime() + 9 * 3_600_000);
  return `${String(k.getUTCHours()).padStart(2, '0')}:${String(k.getUTCMinutes()).padStart(2, '0')}`;
};
const q = (v: number | null | undefined): string => (v === null || v === undefined ? '?' : String(v));

export function analyze(i: Inputs, n: AnalystNumbers = DEFAULT_NUMBERS, l: AnalystLists = DEFAULT_LISTS): Analysis {
  const t = topology(i.mails, n, l, { panes: i.panes, dormantTable: i.dormantTable });
  const pass = passBoard(t, n);
  const recheck = hhmm(new Date(i.windowEnd.getTime() + n.recheck_min * 60_000));
  const act = (who: string, what: string, criterion: string): Action => ({ who, what, recheckAt: recheck, criterion });
  const F: Finding[] = [];

  // 1 ✋ — open hand raises · stale ones need their receiver
  if (!i.hands) F.push({ key: 'hands', title: '열린 ✋', status: 'unknown', facts: '열린 ✋ ? (eln msg hand list 읽기 실패)', action: act('OP', 'eln msg hand list 로 열린 ✋ 직접 확인', '✋ 원장 읽힘') });
  else {
    const stale = i.hands.filter(h => h.waitedMin >= n.hand_stale_min).sort((a, b) => b.waitedMin - a.waitedMin);
    const byTo = new Map<string, number>(); for (const h of stale) byTo.set(h.to, (byTo.get(h.to) ?? 0) + 1);
    const top = [...byTo].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
    // a ✋ parked on a loop agent / dormant address has no one to answer it there — its L0 (OP) re-routes it
    const who = top && (l.agentSenders.includes(top) || i.dormantTable.includes(top)) ? 'OP' : top;
    F.push({
      key: 'hands', title: '열린 ✋', status: stale.length ? 'breach' : 'ok',
      facts: `열린 ✋ ${i.hands.length} · ${n.hand_stale_min}분 넘은 것 ${stale.length}${stale.length ? ` — ${stale.slice(0, 4).map(h => `#${h.id} ${h.from}→${h.to} ${h.waitedMin}분${h.reason ? ` (${h.reason})` : ''}`).join(' · ')}` : ''}`,
      action: stale.length && who && top ? act(who, `${n.hand_stale_min}분 넘은 ✋ ${byTo.get(top)}건 처분(${stale.filter(h => h.to === top).slice(0, 4).map(h => `#${h.id}`).join(' ')})${who !== top ? ` — ${top} 는 답하지 않는 주소 → 도메인 주인에게 재지정` : ' — 답 또는 주인·기한 붙여 재지정'}`, `${n.hand_stale_min}분 초과 ✋ 0`) : null,
    });
  }

  // 2 루프 — exception triggers
  if (!i.loops) F.push({ key: 'loops', title: '멈춘 루프', status: 'unknown', facts: '루프 상태 ? (eln loop trigger list 읽기 실패)', action: act('OP', 'eln loop trigger list 직접 확인', '트리거 원장 읽힘') });
  else {
    const ex = i.loops.exceptions;
    const owner = ex[0]?.owner || 'RUN-DOCTOR';
    F.push({
      key: 'loops', title: '멈춘 루프', status: ex.length ? 'breach' : 'ok',
      facts: `루프 ok ${i.loops.total - ex.length}/${i.loops.total}${ex.length ? ` · exception ${ex.slice(0, 4).map(x => x.id).join(' · ')}` : ''}`,
      action: ex.length ? act(owner, `eln loop trigger watch ${ex[0]!.id} 로 예외 원문 확인 → 재실행 또는 원인 칸${ex.length > 1 ? ` (외 ${ex.length - 1})` : ''}`, 'exception 0') : null,
    });
  }

  // 3 처리량 — lands/h · greens/h · claims · idle-with-work · the controller's lever
  {
    const k = i.kpi1h; const w = i.kpiWin; const tp = i.throughput;
    // fed kpi at the window end (point in time: git «(#N)» lands ⊕ fed-state greens) · the controller row only when kpi is unread
    const lands = k?.landedPerHour ?? tp?.lands ?? null; const greens = k ? k.greens : tp?.greens ?? null;
    const status: Finding['status'] = lands === null || greens === null ? 'unknown' : lands < n.lands_per_h_min || greens < n.greens_per_h_min ? 'breach' : 'ok';
    F.push({
      key: 'throughput', title: '처리량', status,
      facts: `착지 ${q(lands)}/h · 초록 ${q(greens)}/h · claims ${q(w?.claims)}/${n.window_min}분 · 일 있는 유휴 손 ${q(k?.idleWithWorkHands)}${k?.idleWithWorkSeats.length ? `(${k.idleWithWorkSeats.slice(0, 6).join(' · ')}${k.idleWithWorkSeats.length > 6 ? ' …' : ''})` : ''} · 제어기 ${tp ? `${tp.verdict} → ${tp.lever}` : '?'}`,
      action: status === 'ok' ? null : act(tp?.owner || 'OP', tp ? `지렛대 ${tp.lever} (${tp.verdict}) 집행` : 'eln pulse throughput 로 묶는 병목 확인', `착지 ≥${n.lands_per_h_min}/h · 초록 ≥${n.greens_per_h_min}/h`),
    });
  }

  // 4 판 — the active board (P0 yellow is what a cut has to face)
  if (!i.board) F.push({ key: 'board', title: '판', status: 'unknown', facts: '판 ? (eln release checklist 읽기 실패)', action: act('OP', 'eln release checklist status --version <active> 확인', '판 읽힘') });
  else {
    const b = i.board;
    F.push({
      key: 'board', title: '판', status: b.p0Yellow > 0 ? 'breach' : 'ok',
      facts: `${b.version} 칸 ${b.total} · green ${b.green} · done ${b.done} · P0 노랑 ${b.p0Yellow}`,
      action: b.p0Yellow > 0 ? act('OP', `P0 노랑 ${b.p0Yellow} 을 «컷 필수 / 면제(known-issue)» 로 나눈 표`, `P0 노랑 < ${b.p0Yellow} 또는 면제 표 존재`) : null,
    });
  }

  // 5 우편 경로 — ✋→TC · unanswered edges · dormant edges
  {
    const p = (k: PassCheck['key']) => pass.find(x => x.key === k)!;
    const breach = !p('hand-tc').ok || !p('edges').ok || !p('dormant').ok;
    const first = !p('dormant').ok ? { who: 'GUARDIAN', what: `잠든 수신처 ${t.dormantEdges.map(d => `→${d.to} ${d.mails}`).join(' · ')} 재경로(hand-routes dormant) 확인 · 보낸 이에게 살아 있는 주인 안내`, crit: '잠든 간선 0' }
      : !p('edges').ok ? { who: t.badEdges[0]!.edge.split('>')[1]!, what: `답 없는 요청 ${t.badEdges[0]!.edge} ${t.badEdges[0]!.requests}/${t.badEdges[0]!.answered} 회신 또는 처분`, crit: `답·행동 <${n.edge_answer_min_pct}% 간선 0` }
        : { who: 'TC', what: `✋→TC ${t.handToTcPerH}/h — 분류기(hand-routes) 경로로 도메인 주인에게 · 반복 ✋ 는 참조 답`, crit: `✋→TC ≤${n.hand_to_tc_per_h_max}/h` };
    F.push({
      key: 'mail-path', title: '우편 경로', status: breach ? 'breach' : 'ok',
      facts: `우편 ${t.mails} · ✋→TC ${t.handToTcPerH}/h · 답 없는 간선 ${p('edges').value} · 잠든 간선 ${p('dormant').value}${t.topPair ? ` · 최다 짝 ${t.topPair.pair} ${t.topPair.mails}` : ''}`,
      action: breach ? act(first.who, first.what, first.crit) : null,
    });
  }

  // 6 OP · 토폴로지 — the pass board
  {
    const passed = pass.filter(x => x.ok).length;
    const failing = pass.filter(x => !x.ok);
    F.push({
      key: 'op-topology', title: 'OP · 토폴로지', status: failing.length ? 'breach' : 'ok',
      facts: `합격판 ${passed}/6 — ${pass.map(x => `${x.label.split(' ')[0]} ${x.value} ${x.ok ? '✓' : '✗'}`).join(' · ')} · 고유벡터 ${t.eigen.slice(0, 3).map(e => `${e.seat} ${e.value.toFixed(2)}`).join(' · ')}`,
      action: failing.length ? act('OP', failing[0]!.key === 'op-inbound' ? `OP 수신 ${t.opInboundPerH}/h — steward:mail 몫: 상태 회신·정보·중복은 다이제스트로(턴 0) · ✋/CEO/P0/결정만 즉시` : `${failing[0]!.label} 미달(${failing[0]!.value}) — 원인 간선 확인`, failing.map(x => x.label).join(' · ')) : null,
    });
  }

  const passed = pass.filter(x => x.ok).length;
  const firstBreach = F.find(f => f.status === 'breach');
  return {
    at: i.windowEnd.toISOString(), windowStart: i.windowStart.toISOString(), windowEnd: i.windowEnd.toISOString(),
    topology: t, pass, passed, findings: F,
    bottleneck: firstBreach ? `${firstBreach.title}: ${firstBreach.facts}${firstBreach.action ? ` → ${firstBreach.action.who} · ${firstBreach.action.what}` : ''}` : '병목 없음 — 여섯 줄 모두 기준 안',
  };
}

/** The six lines (+ pass board) — one per finding, «→ 조치: who — what · 재확인 HH:MM(criterion)». `prose` (optional) replaces
 *  the facts sentence of a line by key; the action line is always the deterministic one. */
export function renderAnalysis(a: Analysis, prose: Partial<Record<FindingKey, string>> = {}): string[] {
  const mark = (s: Finding['status']) => (s === 'ok' ? '🟢' : s === 'breach' ? '🔴' : '❔');
  const L: string[] = [`### 연방 분석 ${hhmm(new Date(a.windowStart))}–${hhmm(new Date(a.windowEnd))} KST · 우편 ${a.topology.mails} · 합격판 ${a.passed}/6 [src: eln fed analyze]`];
  a.findings.forEach((f, idx) => {
    L.push(`${idx + 1}. ${mark(f.status)} **${f.title}** — ${prose[f.key] ?? f.facts}`);
    if (f.action) L.push(`   → 조치: ${f.action.who} — ${f.action.what} · 재확인 ${f.action.recheckAt}(${f.action.criterion})`);
  });
  L.push(`- 병목: ${a.bottleneck}`);
  return L;
}
