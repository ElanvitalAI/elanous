/**
 * Invest Research Board — the framed view (tui-widgets-demo look) drawn on the widget kit's Canvas.
 * Design target 160×50 (good from 140×50, uses the room up to 200×60); 120×36 and 80×24 are fallbacks.
 *   title bar · question
 *   left:  Agents (FanoutBoard: tree · glyph · name · tools · bar · % · time · last line) · Expert panel (avatar chips,
 *          action colour, confidence bars; named experts first) · Graph (step chain) · Evidence (source badges · times)
 *   right: Market (KOSPI · USD/KRW · US10Y · foreign-flow sparkline · framework gauge) · Verdict (hero card)
 *   status bar
 * Every number comes from the run's events; nothing moves without one.
 */
import { ACTION_TONE, bigText, Canvas, sparkCells, stripEmoji, type Bg, type Tone } from '../canvas.js';
import { cells, clean, elapsed } from '../text.js';
import { BOARD_DISCLAIMER, BOARD_GROUPS, boardSteps, clock, displayTicker, EXPERT_LABEL, isExpertNode, isPanelNode, type BoardNode, type InvestBoardState } from './invest-board.js';
import { panelName, shortModel } from './invest-run.js';
import { groupAgentFor } from './invest-board.js';

const GLYPH: Readonly<Record<string, [string, Tone]>> = { running: ['●', 'c'], done: ['✓', 'g'], failed: ['✗', 'r'], waiting: ['◌', 'd2'] };
const STEP: Readonly<Record<string, [string, Tone]>> = { done: ['✓', 'g'], active: ['▸', 'c'], todo: ['○', 'd2'] };
const BADGE: Readonly<Record<string, [string, Bg]>> = { news: ['NEWS', 'acc'], 'event-shock': ['NEWS', 'acc'], 'x-pulse': [' X  ', 'sel'], 'conatus-research': ['DART', 'a'], score: ['DART', 'a'], market: ['EOD ', 'g'], flows: ['FLOW', 'g'] };
const host = (url: string): string => url.replace(/^https?:\/\//u, '').replace(/^www\./u, '').replace(/[/?#].*$/u, '');
const signed = (n: number, d = 1): string => `${n >= 0 ? '▲' : '▼'}${Math.abs(n).toFixed(d)}%`;
const expertName = (s: InvestBoardState, id: string) => s.meta.experts?.[id] ?? panelName(id);
const initials = (name: string): string => {
  const words = name.replace(/·.*$/u, '').replace(/[^A-Za-z0-9 /-]/gu, ' ').split(/[\s/-]+/u).filter(Boolean);
  return ((words[0]?.[0] ?? '?') + (words[1]?.[0] ?? words[0]?.[1] ?? '')).toUpperCase();
};
const verdictOf = (n: BoardNode): { action?: string; conf?: number } => {
  const m = /^(BUY|HOLD|SELL)\s+(\d+)/u.exec(n.verdict ?? '');
  return m ? { action: m[1]!, conf: Number(m[2]) } : {};
};

export function drawInvestBoard(state: InvestBoardState, width: number, height: number): Canvas {
  const W = Math.max(60, width), H = Math.max(20, height);
  const c = new Canvas(W, H);
  titleBar(c, state);
  c.fitText(1, 1, `Q  ${state.meta.question}`, W - 2, 'd');
  statusBar(c, state, H - 1);
  const top = 2, bottom = H - 1; // body rows [top, bottom)
  if (W < 110) { narrow(c, state, top, bottom); return c; }
  const L = W >= 180 ? Math.floor(W * 0.6) : W >= 140 ? Math.floor(W * 0.58) : 72;
  const R = W - L - 1;
  // left column
  let y = top;
  const agentsH = H >= 44 ? 9 : 8;
  agents(c, state, 0, y, L, agentsH, agentsH === 9); y += agentsH;
  const expertCount = [...state.nodes.values()].filter((n) => isPanelNode(n.id)).length;
  const cols = L >= 130 ? 3 : H >= 44 ? 2 : 3;
  const chipRows = Math.ceil(Math.max(1, expertCount) / cols);
  const expertsH = Math.min(chipRows + 3, Math.max(4, Math.floor((bottom - y) / 2.4)));
  experts(c, state, 0, y, L, expertsH, cols); y += expertsH;
  graph(c, state, 0, y, L); y += 3;
  evidence(c, state, 0, y, L, bottom - y);
  // right column
  const marketH = H >= 44 ? 9 : 7;
  market(c, state, L + 1, top, R, marketH);
  verdict(c, state, L + 1, top + marketH, R, bottom - top - marketH);
  return c;
}

function titleBar(c: Canvas, s: InvestBoardState): void {
  c.fillBg(0, 0, c.width, 'bar');
  let x = c.text(1, 0, '◆ Invest Research', 'w', c.width, true);
  x = c.text(x + 2, 0, s.meta.name, 'c', c.width - 40, true);
  x = c.text(x + 1, 0, displayTicker(s.meta.ticker), 'd', c.width - 40);
  const runMs = s.startedAt === undefined ? 0 : (s.endedAt ?? s.tMs) - s.startedAt;
  const [g, gt] = s.status === 'done' ? ['✓ DONE', 'g' as Tone] : s.status === 'failed' ? ['✗ FAILED', 'r' as Tone] : s.status === 'running' ? ['● LIVE', 'c' as Tone] : ['◌ READY', 'd' as Tone];
  const agents = [...s.nodes.values()].filter((n) => isPanelNode(n.id));
  const rt = new Map<string, number>();
  for (const n of agents) rt.set(n.runtime ?? 'agent', (rt.get(n.runtime ?? 'agent') ?? 0) + 1);
  const right = `${s.meta.mode === 'replay' ? 'REPLAY · ' : ''}${elapsed(Math.max(0, runMs))} · ${agents.length} agents · ${[...rt].map(([k, n]) => `${k} ${n}`).join(' · ')}`;
  const rx = c.width - 1 - cells(right) - cells(g) - 2;
  if (rx > x + 2) { const ex = c.text(rx, 0, g, gt, c.width, true); c.text(ex + 2, 0, right, 'd'); }
  else c.text(Math.max(x + 2, c.width - 1 - cells(g)), 0, g, gt, c.width, true);
}

function statusBar(c: Canvas, s: InvestBoardState, y: number): void {
  c.fillBg(0, y, c.width, 'bar');
  let x = c.text(1, y, 'graph', 'c', c.width, true);
  x = c.text(x + 1, y, 'invest-orch', 'd');
  x = c.text(x + 2, y, 'data', 'c', c.width, true);
  x = c.text(x + 1, y, s.meta.mode === 'replay' ? 'pinned live run' : 'live', 'd');
  const right = BOARD_DISCLAIMER;
  if (c.width - 1 - cells(right) > x + 2) c.text(c.width - 1 - cells(right), y, right, 'a');
}

function agents(c: Canvas, s: InvestBoardState, x: number, y: number, w: number, h: number, header: boolean): void {
  const kids = BOARD_GROUPS.map((g) => groupAgentFor(s, g));
  const counts = ['running', 'done', 'failed'].map((st) => [st, kids.filter((k) => k.state === st).length] as const).filter(([, n]) => n);
  c.box(x, y, w, h, { title: 'Agents', right: `${kids.length} lanes · ${counts.map(([st, n]) => `${n} ${st}`).join(' · ') || 'queued'}` });
  const nameW = 13, toolW = w >= 90 ? 24 : w >= 72 ? 18 : 0, barW = w >= 90 ? 14 : 10;
  let yy = y + 1;
  if (header) {
    let cx = c.text(x + 2, yy, `   ${'AGENT'.padEnd(nameW)}`, 'd2');
    if (toolW) cx = c.text(cx, yy, 'TOOLS'.padEnd(toolW), 'd2');
    cx = c.text(cx, yy, 'PROGRESS'.padEnd(barW + 6), 'd2');
    cx = c.text(cx, yy, 'TIME   ', 'd2'); c.text(cx, yy, 'LAST', 'd2'); yy++;
  }
  const parentState = s.status === 'waiting' ? 'waiting' : s.status;
  const rowOf = (tree: string, name: string, tool: string, st: string, ratio: number | null, ms: number, last: string, parent = false) => {
    let cx = c.text(x + 2, yy, tree, 'k');
    const [g, gt] = GLYPH[st] ?? GLYPH.waiting!;
    cx = c.text(cx, yy, g, gt, c.width, true) + 1;
    c.fitText(cx, yy, name, x + 2 + 3 + 2 + nameW - cx, parent ? 'w' : 't', parent);
    cx = x + 2 + 3 + 2 + nameW + 1;
    if (toolW) { c.fitText(cx, yy, tool, toolW - 1, 'm'); cx += toolW; }
    c.bar(cx, yy, barW, ratio ?? 0, st === 'failed' ? 'r' : st === 'done' ? 'g' : st === 'running' ? 'c' : 'k'); cx += barW + 1;
    c.text(cx, yy, st === 'waiting' ? '  —' : `${String(Math.round((ratio ?? 0) * 100)).padStart(3)}%`, 'd'); cx += 5;
    c.text(cx, yy, elapsed(ms).padStart(6), 'd'); cx += 7;
    c.fitText(cx, yy, last, x + w - 2 - cx, st === 'failed' ? 'r' : st === 'running' ? 't' : 'd');
    yy++;
  };
  const doneN = kids.filter((k) => k.state === 'done' || k.state === 'failed').length;
  rowOf('', 'Graph run', 'elanous graph runner', parentState, kids.length ? doneN / kids.length : 0, s.startedAt === undefined ? 0 : (s.endedAt ?? s.tMs) - s.startedAt, `${s.calls.reduce((a, k) => a + k.n, 0)} tool calls · ${s.evidence.length} cited`, true);
  const LANE: Readonly<Record<string, string>> = { News: 'news', 'X / social': 'x', 'Filings/DART': 'dart', 'Price / flow': 'price' };
  kids.forEach((k, i) => {
    const tab = s.tabs[LANE[k.name] ?? ''];
    if (yy < y + h - 1) rowOf(i < kids.length - 1 ? '├─ ' : '└─ ', k.name, k.modelTail ?? '', k.state, k.progress ?? null, k.elapsedMs ?? 0, `${tab ? `⧉ ${tab.split(' · ')[0]}  ` : k.name === 'Expert panel' && Object.keys(s.tabs).length ? '⧉ 15 tabs  ' : ''}${k.lastLine ?? ''}`);
  });
}

function experts(c: Canvas, s: InvestBoardState, x: number, y: number, w: number, h: number, cols: number): void {
  const all = [...s.nodes.values()].filter((n) => isPanelNode(n.id));
  const named = all.filter((n) => /^mentor-\d+$/u.test(n.id)), personas = all.filter((n) => isExpertNode(n.id));
  const p = s.meta.panel;
  const tally = { BUY: 0, HOLD: 0, SELL: 0 } as Record<string, number>;
  for (const n of all) { const a = verdictOf(n).action; if (a) tally[a]!++; }
  c.box(x, y, w, h, { title: 'Expert panel', right: `${named.length} named + ${personas.length}${p ? `/${p.total} sector (w ${p.weight.toFixed(2)})` : ' sector'} · BUY ${tally.BUY} HOLD ${tally.HOLD} SELL ${tally.SELL}` });
  const inner = w - 4, cw = Math.floor((inner - (cols - 1) * 2) / cols);
  const chips = [...named, ...personas];
  const rows = h - 3;
  const shown = chips.length <= rows * cols ? chips : chips.slice(0, rows * cols - 1);
  shown.forEach((n, i) => {
    const cx0 = x + 2 + (i % cols) * (cw + 2), yy = y + 1 + Math.floor(i / cols);
    const v = verdictOf(n);
    const name = expertName(s, n.id);
    const risk = /Risk/u.test(name);
    const bg: Bg = n.state === 'failed' ? 'r' : v.action === 'BUY' ? 'g' : v.action === 'SELL' ? 'r' : v.action === 'HOLD' ? 'a' : 'sel';
    c.fillBg(cx0, yy, 4, bg);
    let cx = c.text(cx0, yy, ` ${initials(name)} `, 'w', c.width, true) + 1;
    const tail = n.state === 'failed' ? 'no answer' : n.state === 'running' ? '● thinking' : n.state === 'waiting' ? '◌' : v.action ? `${v.action}` : 'done';
    const barW = cw >= 34 ? 6 : cw >= 28 ? 4 : 0;
    const tailW = 5 + (barW ? barW + 3 : 2);
    cx = c.fitText(cx, yy, name, cw - 5 - tailW, risk ? 'a' : n.id.startsWith('mentor-') ? 'w' : 't', risk || n.id.startsWith('mentor-'));
    let tx = cx0 + cw - tailW;
    if (v.action) {
      tx = c.text(tx, yy, v.action.padEnd(5), ACTION_TONE[v.action] ?? 't', c.width, true);
      if (barW) { c.bar(tx, yy, barW, (v.conf ?? 0) / 10, ACTION_TONE[v.action] ?? 't'); tx += barW + 1; }
      c.text(tx, yy, String(v.conf ?? ''), 'd');
    } else c.fitText(tx, yy, tail, tailW, n.state === 'failed' ? 'r' : n.state === 'running' ? 'c' : 'd2');
  });
  if (shown.length < chips.length) c.text(x + 2 + ((rows * cols - 1) % cols) * (cw + 2), y + rows, `+${chips.length - shown.length} more`, 'd');
  c.fitText(x + 2, y + h - 2, `${EXPERT_LABEL}`, w - 4, 'd2');
}

function graph(c: Canvas, s: InvestBoardState, x: number, y: number, w: number): void {
  const steps = boardSteps(s);
  const active = steps.find((st) => st.state === 'active');
  c.box(x, y, w, 3, { title: 'Graph', right: active ? `${active.label}${active.note ? ` · ${active.note}` : ''}` : steps.every((st) => st.state === 'done') ? 'all steps done' : 'ready' });
  let cx = x + 2;
  const need = steps.reduce((a, st) => a + cells(st.label) + 2, 0) + (steps.length - 1) * 3;
  const sep = need <= w - 4 ? ' ─ ' : ' ';
  steps.forEach((st, i) => {
    const [g, gt] = STEP[st.state]!;
    if (st.state === 'active') c.fillBg(cx, y + 1, cells(st.label) + 2, 'sel');
    cx = c.text(cx, y + 1, g, gt, x + w - 2, true) + 1;
    cx = c.text(cx, y + 1, st.label, st.state === 'todo' ? 'd2' : st.state === 'active' ? 'w' : 't', x + w - 2, st.state === 'active');
    if (i < steps.length - 1) cx = c.text(cx, y + 1, sep, 'k', x + w - 2);
  });
}

function evidence(c: Canvas, s: InvestBoardState, x: number, y: number, w: number, h: number): void {
  if (h < 3) return;
  const bySource = new Map<string, number>();
  for (const k of s.calls) if (k.n > 0) bySource.set(k.tool, (bySource.get(k.tool) ?? 0) + k.n);
  c.box(x, y, w, h, { title: 'Evidence', right: `${s.evidence.length} cited${bySource.size ? ` · ${[...bySource].map(([t, n]) => `${t.split(' ')[0]} ×${n}`).join(' · ')}` : ''}` });
  const rows = h - 2;
  if (!s.evidence.length) { c.text(x + 2, y + 1, s.status === 'waiting' ? 'Waiting for sources…' : s.status === 'running' ? 'No sources yet — collectors are running' : 'No sources cited in this run', 'd'); return; }
  const list = [...s.evidence].reverse().slice(0, rows);
  list.forEach((e, i) => {
    const yy = y + 1 + i;
    const [label, bg] = BADGE[e.source] ?? ['WEB ', 'sel'];
    const age = s.tMs - e.t;
    // the newest line slides in from the right during the first second after its event
    const lead = i === 0 && age >= 0 && age < 1000 ? Math.round((1 - (Math.floor(age / 250) + 1) / 4) * (w - 8)) : 0;
    let cx = x + 2 + lead;
    const t = clock(s, e.t).trim();
    if (t && w >= 70) cx = c.text(cx, yy, t, 'd2') + 1;
    c.fillBg(cx, yy, cells(label) + 2, bg);
    cx = c.text(cx, yy, ` ${label} `, 'w', x + w - 2, true) + 1;
    const hst = host(e.url);
    const room = x + w - 2 - cx;
    const titleRoom = Math.max(4, room - cells(hst) - 3);
    cx = c.fitText(cx, yy, stripEmoji(clean(e.title)), titleRoom, i === 0 ? 'w' : 't');
    c.fitText(cx + 1, yy, `— ${hst}`, x + w - 2 - cx - 1, 'bl');
  });
}

function market(c: Canvas, s: InvestBoardState, x: number, y: number, w: number, h: number): void {
  const m = s.market;
  c.box(x, y, w, h, { title: 'Market', right: 'omni-market · kr-flow' });
  const L = x + 2, R = x + w - 2;
  let yy = y + 1;
  const line = (label: string, value: string, tail: string, tailTone: Tone) => {
    if (yy >= y + h - 1) return;
    let cx = c.text(L, yy, label.padEnd(9), 'd');
    cx = c.text(cx, yy, value, 'w', R, true);
    c.fitText(cx + 1, yy, tail, R - cx - 1, tailTone);
    yy++;
  };
  if (m.kospi) line('KOSPI', Math.round(m.kospi.last).toLocaleString('en-US'), [m.kospi.chg1m !== undefined ? `${signed(m.kospi.chg1m)} 1m` : '', m.kospi.chg3m !== undefined ? `${signed(m.kospi.chg3m)} 3m` : ''].filter(Boolean).join('  '), (m.kospi.chg3m ?? 0) < 0 ? 'r' : 'g');
  if (m.usdkrw) line('USD/KRW', Math.round(m.usdkrw.last).toLocaleString('en-US'), m.usdkrw.chg1m !== undefined ? `${signed(m.usdkrw.chg1m)} 1m` : '', (m.usdkrw.chg1m ?? 0) > 0 ? 'r' : 'g');
  if (m.us10y) line('US10Y', `${m.us10y.last.toFixed(2)}%`, '', 'd');
  if (m.foreignDaily?.length && yy < y + h - 1) {
    let cx = c.text(L, yy, 'Foreign'.padEnd(9), 'd');
    const spark = sparkCells(m.foreignDaily.slice(-Math.max(5, Math.min(20, R - L - 30))));
    cx = c.text(cx, yy, spark, (m.foreign20dMillion ?? 0) < 0 ? 'r' : 'g');
    if (m.foreign20dMillion !== undefined) c.fitText(cx + 1, yy, `20d net ${m.foreign20dMillion < 0 ? '−' : '+'}₩${(Math.abs(m.foreign20dMillion) / 1e6).toFixed(1)}T`, R - cx - 1, (m.foreign20dMillion ?? 0) < 0 ? 'r' : 'g');
    yy++;
  }
  if (m.framework && yy < y + h - 1) {
    let cx = c.text(L, yy, 'Score'.padEnd(9), 'd');
    const bw = Math.max(6, Math.min(20, R - cx - 16));
    c.bar(cx, yy, bw, m.framework.total / 100, ACTION_TONE[m.framework.signal] ?? 'c'); cx += bw + 1;
    c.fitText(cx, yy, `${Math.round(m.framework.total)}/100 ${m.framework.signal}`, R - cx, ACTION_TONE[m.framework.signal] ?? 'c');
    yy++;
  }
  if (yy === y + 1) c.text(L, yy, s.status === 'waiting' ? 'Waiting for EOD prices…' : 'Fetching prices and flows…', 'd');
}

/** Final conclusion — Korean (대표 11-26, this panel only); every line from the run's structured result. */
export const VERDICT_DISCLAIMER_KO = '리서치 데모입니다 · 투자 권유가 아니며 주문하지 않습니다';
const ACT_KO: Readonly<Record<string, string>> = { BUY: '매수', HOLD: '보유', SELL: '매도' };
const RISK_KO: Readonly<Record<string, string>> = { REDUCE: '비중 축소', 'HOLD SIZE': '비중 유지', ADD: '비중 확대' };
/** The Risk box's verdict line («비중 유지 · 최대 비중 n%») — the stage caption uses this same function, so they never disagree. */
export const riskVerdictKo = (risk: { readonly verdict?: string; readonly maxPositionPct?: number | null }): string =>
  `${RISK_KO[risk.verdict ?? ''] ?? risk.verdict ?? '?'}${typeof risk.maxPositionPct === 'number' && risk.maxPositionPct > 0 ? ` · 최대 비중 ${risk.maxPositionPct}%` : ''}`;

function verdict(c: Canvas, s: InvestBoardState, x: number, y: number, w: number, h: number): void {
  const r = s.result;
  const tone: Tone = r ? ACTION_TONE[r.action] ?? 'w' : 'b';
  c.box(x, y, w, h, { title: '최종 결론', right: r ? '가중 패널 합의' : '대기 중', tone: r ? tone : 'b', titleTone: r ? tone : 'd' });
  const L = x + 2, R = x + w - 2, bottom = y + h - 1;
  const discLines = wrapTo(VERDICT_DISCLAIMER_KO, R - L);
  const lastBody = bottom - discLines.length - 1;
  discLines.forEach((l, i) => c.text(L, bottom - discLines.length + i, l, 'a'));
  if (!r) {
    c.text(L, y + 1, s.status === 'failed' ? '결론 없이 런이 끝났습니다.' : '전문가 패널의 답을 기다리는 중…', s.status === 'failed' ? 'r' : 'c');
    [0.9, 0.7, 0.8, 0.5, 0.75, 0.6].forEach((f, i) => { if (y + 3 + i < lastBody) c.repeat(L, y + 3 + i, Math.round((R - L) * f), '░', 'k'); });
    return;
  }
  const ko = r.ko;
  const actKo = ACT_KO[r.action] ?? r.action;
  let yy = y + 1;
  if (h >= 16) {
    const bw = bigText(c, L, yy, r.action, tone);
    const gx = L + bw + 3;
    c.text(gx, yy, actKo, tone, R, true);
    if (r.consensus) c.fitText(gx + 6, yy, `점수 ${r.consensus.score >= 0 ? '+' : ''}${r.consensus.score.toFixed(2)} · ${r.consensus.answered}/${r.consensus.of}명 응답`, R - gx - 6, 't');
    c.text(gx, yy + 1, '확신도', 'd');
    const bw2 = Math.max(6, Math.min(24, R - gx - 6));
    c.bar(gx, yy + 2, bw2, r.confidence, tone);
    c.text(gx + bw2 + 1, yy + 2, `${Math.round(r.confidence * 100)}%`, tone, R, true);
    yy += 4;
  } else {
    let cx = c.text(L, yy, actKo, tone, R, true) + 1;
    c.bar(cx, yy, 10, r.confidence, tone); cx += 11;
    c.fitText(cx, yy, `확신도 ${Math.round(r.confidence * 100)}%${r.consensus ? ` · 점수 ${r.consensus.score.toFixed(2)}` : ''}`, R - cx, 'd');
    yy += 1;
  }
  const put = (text: string, tn: Tone, indent = 0, bold = false): boolean => {
    if (yy > lastBody) return false;
    c.fitText(L + indent, yy, text, R - L - indent, tn, bold); yy++; return true;
  };
  const room = () => lastBody - yy + 1;
  const thesis = wrapTo(ko?.thesis ?? r.thesis, R - L);
  if (room() > 12) thesis.forEach((l) => put(l, 't'));
  const per = room() > 20 ? 3 : room() > 12 ? 2 : 1;
  const bull = ko?.bull ?? r.bull, bear = ko?.bear ?? r.bear;
  if (room() > 3) { put('강세 근거', 'g', 0, true); (bull.length ? bull : ['찾지 못함']).slice(0, per).forEach((b) => put(`+ ${b}`, 'g', 1)); }
  if (room() > 3) { put('약세 근거', 'r', 0, true); (bear.length ? bear : ['찾지 못함']).slice(0, per).forEach((b) => put(`− ${b}`, 'r', 1)); }
  if (r.risk && room() > 2) {
    put(`리스크 (${ko?.riskExpert ?? r.risk.expert.replace(/\s*\(.*$/u, '')} · 강의 프레임 적용)`, 'a', 0, true);
    if (r.risk.pending) put('출처 대기 — 강의 요약이 아직 없습니다', 'd', 1);
    else {
      put(riskVerdictKo(r.risk), 'a', 1, true);
      if (room() > 3) put(`레벨: ${ko?.stop ?? r.risk.stop ?? '?'}`, 't', 1);
      if (room() > 3) put(`헤지: ${ko?.hedge ?? r.risk.hedge ?? '?'}`, 't', 1);
    }
  }
  const div = ko?.divergences ?? r.divergences ?? [];
  if (div.length && room() > 2) { put('이견', 'm', 0, true); div.slice(0, per).forEach((d) => put(d, 't', 1)); }
  if (r.sources.length && room() > 2) { put('출처', 'bl', 0, true); r.sources.slice(0, Math.max(1, Math.min(per + 1, room() - 1))).forEach((src, i) => put(`[${i + 1}] ${host(src.url)} — ${stripEmoji(src.label)}`, 'd', 1)); }
}

function wrapTo(text: string, width: number): string[] {
  const out: string[] = []; let line = '';
  for (const word of clean(text).split(/\s+/u).filter(Boolean)) {
    if (!line) line = word; else if (cells(line) + 1 + cells(word) <= width) line += ` ${word}`; else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out;
}

/** < 110 columns: one column — agents, then the verdict when there is one, else experts and evidence. */
function narrow(c: Canvas, s: InvestBoardState, top: number, bottom: number): void {
  const W = c.width;
  let y = top;
  agents(c, s, 0, y, W, 8, false); y += 8;
  if (s.result) {
    const ex = [...s.nodes.values()].filter((n) => isPanelNode(n.id));
    const tally = { BUY: 0, HOLD: 0, SELL: 0 } as Record<string, number>;
    for (const n of ex) { const a = verdictOf(n).action; if (a) tally[a]!++; }
    c.fitText(1, y, `Experts BUY ${tally.BUY} · HOLD ${tally.HOLD} · SELL ${tally.SELL} — ${EXPERT_LABEL}`, W - 2, 'd'); y++;
    verdict(c, s, 0, y, W, bottom - y);
    return;
  }
  const cols = W >= 76 ? 3 : 2;
  const eh = Math.min(Math.ceil([...s.nodes.values()].filter((n) => isPanelNode(n.id)).length / cols) + 3, Math.max(4, Math.floor((bottom - y) * 0.55)));
  experts(c, s, 0, y, W, eh, cols); y += eh;
  graph(c, s, 0, y, W); y += 3;
  evidence(c, s, 0, y, W, bottom - y);
}

export { shortModel };
