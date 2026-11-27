// 착지 집사 (land-steward) — loop agent v2 (내부 문서 `LOOP-AGENT`): goal ⊕ soul ⊕ memory ⊕ body ⊕ voice ⊕ L0 = TC.
// Body = the land graph (tickLand) with its sub-loop agents: 기차 매니저 (order · lanes · slot advice), 마무리꾼 (finisher),
// 칸 연결 (cell link). One wake = one body tick → KPI from the body's records → one channel line per KPI breach (30 min) →
// a case row. «세 평면»: the steward is the terminal owner of land refusals — the body runs with terminalOwner set, so no land
// mail goes to TC/OP except the security-4 policy exceptions; everything else is in `eln land steward status` and the voice.
import { readBook, type FinishBook } from '../land-graph/finisher.js';
import { readLedger, tickLand, type LandDeps, type LedgerRow, type PrInfo, type TickResult } from '../land-graph/land-graph.js';
import { breaches, measure, type Breach, type Kpi } from './kpi.js';
import { debounceKeys } from '../kit/kpi/index.js';
import { refusalReport, supervisorSeat } from '../loop-agent/v3/agent-yaml.js';
import { appendJournal } from '../loop-agent/journal.js';
import { beginSmart, fileSmartStore, type Choice, type KnowhowSink, type Router, type SmartSession } from '../loop-agent/v3/smart.js';
import { fileAgentMemory } from '../loop-agent/memory.js';
import { STEWARD_ID, STEWARD_SEAT, STEWARD_SUPERVISOR, type StewardCards, type StewardLevel, type StewardMemory } from './memory.js';
import type { SweepReport } from '../land-graph/main-cell-link.js';
import { lanes, slotAdvice, trainOrder, type Lane, type SlotAdvice } from './train.js';
import { loadLandPolicy, policyOrder, type LandPolicy } from './policy.js';

export interface StewardPorts {
  memory: StewardMemory;
  /** One line into its own channel (els `loop:land-steward`) — never mail. Fail-open. */
  channel(line: string): void;
  book?(): FinishBook;
  /** Deduped mail to the L0 (key → once). Used only for a refused agent.yaml (LOOP-AGENT-V3-YAML) — fail-open. */
  report?(key: string, to: string, body: string): void;
  /** LAND-CELL-LINK-ALWAYS: the post-merge cell-link sweep over main — every merge, whatever path landed it. Fail-open. */
  cellSweep?(): Promise<SweepReport>;
  /** v3 LLM judgment node (only for an ambiguous plan · budget from agent.yaml) — absent = deterministic fallback. */
  router?: Router | null;
  /** v3 knowhow sink — default = the agent's v2 pack (<home>/knowhow/learned.md). */
  knowhow?: KnowhowSink | null;
}
export interface StewardReport {
  at: string; level: StewardLevel; mode: string; locked: boolean;
  landed: number[]; kpi: Kpi | null; breaches: string[]; posted: string[];
  lanes: Lane[]; slots: SlotAdvice | null; error?: string;
  decisions: TickResult['decisions'];
  /** agent.yaml refused by lint: the steward ran as `off` (plain body) and carded its L0 once per error set. */
  refused?: string[];
  cellLink?: Pick<SweepReport, 'version' | 'since' | 'scanned' | 'counts' | 'error'>;
  /** v3 (agent.yaml hook nodes): what the plan chose for each due breach · lessons now · promoted knowhow ids. */
  smart?: { choices: Array<{ key: string; action: string; to: string; why: string; judgedBy: Choice['judgedBy']; fallback?: string }>; lessons: number; created: string[]; cleared: string[]; promoted: string[]; resolved: { acted: number; unacted: number } };
}

/** The body deps the steward runs with: live = train order ⊕ terminal owner · shadow / off = the plain body (as before the
 *  steward) — the level never stops landing, it only takes the steward's own hands off. */
export function stewardDeps(d: LandDeps, level: StewardLevel, capture: (prs: PrInfo[]) => void, policy: LandPolicy | null = loadLandPolicy()): LandDeps {
  // live: the train manager's order — the policy pack's (graphs/loop-agents/land-steward/policies.yaml) when it declares one,
  // else the built-in train order. shadow / off: the body's deps as given (the land-graph CLI applies only explicit pins).
  return {
    ...d, ...(level === 'live' ? { order: policy ? policyOrder(policy) : trainOrder, terminalOwner: STEWARD_SEAT } : {}),
    listPrs: async () => { const v = await d.listPrs(); capture(v); return v; },
  };
}

export async function stewardTick(d: LandDeps, ports: StewardPorts, cards: StewardCards): Promise<StewardReport> {
  // A refused agent.yaml never runs half-defined: the steward takes its hands off (= level off · the plain body keeps landing)
  // and its L0 gets one card per distinct error set.
  if (cards.refused?.length) {
    const to = supervisorSeat(cards.supervisor ?? { duty: 'landing' }, STEWARD_SUPERVISOR, d.org ?? {});
    const r = refusalReport(STEWARD_ID, cards.refused, to);
    try { ports.report?.(r.key, r.to, r.body); } catch { /* fail-open: the report field keeps it */ }
  }
  const lvl = cards.refused?.length ? 'off' : ports.memory.level().level;
  const started = d.now().toISOString();
  const empty: StewardReport = { at: started, level: lvl, mode: d.mode, locked: false, landed: [], kpi: null, breaches: [], posted: [], lanes: [], slots: null, decisions: [] };
  let prs: PrInfo[] = [];
  const res = await tickLand(stewardDeps(d, lvl, v => { prs = v; }));
  if (res.locked) return { ...empty, locked: true };
  // LAND-CELL-LINK-ALWAYS: after the body tick (its own lands included), link every merge to main since the cursor — whatever
  // path merged it (land graph · op-direct-land-v2 · coach-land · pr land · TA). Runs at every level: linking never lands.
  const cellLink = await (async () => {
    if (!ports.cellSweep) return undefined;
    try { const c = await ports.cellSweep(); return { version: c.version, since: c.since, scanned: c.scanned, counts: c.counts, ...(c.error ? { error: c.error } : {}) }; }
    catch (e) { return { version: null, since: '', scanned: 0, counts: {}, error: String(e).slice(0, 160) }; }
  })();
  const withCells = cellLink ? { cellLink } : {};
  if (lvl === 'off') return { ...empty, ...withCells, landed: res.landed, decisions: res.decisions, ...(res.error ? { error: res.error } : {}), ...(cards.refused?.length ? { refused: cards.refused } : {}) };
  // A failed body tick (gh list · lock · …) is NOT «0 lands»: no KPI, no breach line, breach state and case untouched —
  // the CLI keeps the last valid report on disk and exits 1.
  if (res.error) return { ...empty, ...withCells, landed: res.landed, decisions: res.decisions, error: res.error };
  // The body tick can take tens of minutes (live lands): measure at its END, so its own lands / finisher starts are not «future».
  const now = d.now(); const at = now.toISOString();
  const rows = readLedger(d.stateRoot);
  const open = prs.filter(p => p.state === 'OPEN');
  const kpi = measure({ rows, tick: res, book: (ports.book ?? (() => readBook(d.stateRoot)))(), prs: open, now });
  const br = breaches(kpi, cards.goal);
  // One line per breach key per window · a key that recovers is forgotten (the next breach posts again).
  const state = ports.memory.readState(); const posted: string[] = [];
  const deb = debounceKeys(state.breaches, br.map(b => b.key), now, cards.goal.report.breach_line_every_min);
  // v3 (LOOP-AGENT-V3-SMART): reflect on the last lines (did the KPI move?) → plan line · L0 card · quiet. No hook → v2 exactly.
  const smart = lvl === 'live' && cards.smart ? openSmart(d, ports, cards, now, kpi) : null;
  const choices: NonNullable<StewardReport['smart']>['choices'] = [];
  for (const b of br) {
    if (!deb.due.includes(b.key)) continue;
    const line = `[착지 집사 · KPI] ${b.line} · ${at.slice(11, 16)}Z · eln land steward status`;
    const kpiName = BREACH_KPI[b.key];
    const ch = smart ? await smart.chooseJudged({ intent: `breach:${b.key}`, to: 'channel', kpis: [kpiName] }, ports.router ?? null, b.line).catch(() => null) : null;
    const action = ch?.action ?? 'breach-line';
    const row = { intent: `breach:${b.key}`, key: `${b.key}:${at}`, kpi: kpiName, base: kpiValue(kpi, kpiName) };
    if (ch) choices.push({ key: b.key, action, to: ch.to, why: ch.why, judgedBy: ch.judgedBy, ...(ch.fallback ? { fallback: ch.fallback } : {}) });
    if (action === 'l0-card') {
      const body = `[착지 집사 → L0 ${ch!.to} · 결정 카드] ${b.line} — 채널 줄이 KPI 를 움직이지 못했다(${ch!.why}). 선택지: ① 슬롯·호스트 조정 ② 막힌 다음 주인 재배정 ③ 목표 조정(agent.yaml policies) · 추천 ${kpi.waitingForSlot ? '①' : '②'} · eln land steward status`;
      try { ports.report?.(`land-steward-v3:${b.key}:${at.slice(0, 13)}`, ch!.to, body); } catch { /* fail-open */ }
      smart!.record({ ...row, action, to: ch!.to });
      continue;
    }
    if (action === 'quiet') { smart!.record({ ...row, action, to: 'none' }); continue; }
    if (lvl === 'live') { try { ports.channel(line); } catch { /* fail-open: the case row keeps it */ } }
    posted.push(line);
    smart?.record({ ...row, action: 'breach-line', to: 'channel' });
  }
  smart?.save();
  state.breaches = deb.next;
  if (lvl === 'live') { state.lastTickAt = at; ports.memory.writeState(state); }
  const report: StewardReport = {
    at, level: lvl, mode: res.mode, locked: false, landed: res.landed, kpi, breaches: br.map(b => b.line), posted,
    lanes: lanes(open).slice(0, 8), slots: slotAdvice(d.slots, kpi.waitingForSlot, kpi.landsLastHour, cards.goal.kpi.lands_per_hour_min),
    decisions: res.decisions, ...withCells, ...(res.error ? { error: res.error } : {}),
    ...(smart ? { smart: { choices, lessons: smart.lessons.filter(l => l.status === 'active').length, created: smart.learned.created, cleared: smart.learned.cleared, promoted: smart.learned.promoted, resolved: smart.reflection.resolved } } : {}),
  };
  // SUPERVISOR-CORRECTION-JOURNAL: the steward's real corrections = lands ⊕ stale-PR closes (one journal row each).
  if (lvl === 'live') {
    const dec = (n: number) => res.decisions.find(d => d.pr === n);
    journalRows(ports.memory.root, [
      ...res.landed.map(n => ({ v: 1 as const, at, agent: 'land-steward', status: 'acted' as const, action: 'land', target: `pr:#${n}`, what: `landed #${n}`, why: dec(n)?.why ?? 'ready', before: 'open · ready', after: 'merged', evidence: [`pr:#${n}`, 'ledger:land-graph'], undo: `git revert the merge of #${n}`, source: 'tick' as const, by: STEWARD_SEAT })),
      ...(res.reaped ?? []).filter(r => r.action !== 'would-close').map(r => ({ v: 1 as const, at, agent: 'land-steward', status: (r.action === 'closed' ? 'acted' : 'failed') as 'acted' | 'failed', action: 'close-stale', target: `pr:#${r.pr}`, what: `${r.action} #${r.pr}`, why: r.why, before: 'open · stale', after: r.action === 'closed' ? 'closed' : null, evidence: [`pr:#${r.pr}`], undo: r.action === 'closed' ? `gh pr reopen ${r.pr}` : null, source: 'tick' as const, by: STEWARD_SEAT })),
    ]);
  }
  if (lvl === 'live') ports.memory.appendCase({ at, kind: 'tick', subject: `landed ${res.landed.length}`, why: `ready ${kpi.ready}/${kpi.judged} · lands/h ${kpi.landsLastHour} · breaches ${br.length}`, refs: res.landed.map(n => `pr:#${n}`), extra: { started, supervisedBy: STEWARD_SUPERVISOR } });
  return report;
}

// ── v3 smartness ────────────────────────────────────────────────────────────────────────────────────────────────

const BREACH_KPI: Readonly<Record<Breach['key'], string>> = { lands: 'lands_per_hour', landable: 'landable_ratio', 'finisher-wait': 'needs_finisher_wait_p50', 'no-next': 'refusals_without_next' };
function kpiValue(k: Kpi, name: string): number | null {
  if (name === 'lands_per_hour') return k.landsLastHour;
  if (name === 'landable_ratio') return k.landableRatio;
  if (name === 'needs_finisher_wait_p50') return k.needsFinisherWaitP50Min;
  return k.refusalsWithoutNext.length;
}
/** One v3 session for this tick. Fail-open: a broken v3 store never stops the voice (null → the v2 line). */
function openSmart(d: LandDeps, ports: StewardPorts, cards: StewardCards, now: Date, kpi: Kpi): SmartSession | null {
  try {
    const l0 = supervisorSeat(cards.supervisor ?? { duty: 'landing' }, STEWARD_SUPERVISOR, d.org ?? {});
    const shell = ports.knowhow === undefined ? fileAgentMemory(d.stateRoot, STEWARD_ID, l0) : null;
    const knowhow: KnowhowSink | null = ports.knowhow !== undefined ? ports.knowhow : { text: () => shell!.knowhow().text, add: (item, by, at) => shell!.addKnowhow(item, by, at) };
    return beginSmart({ cfg: cards.smart!, store: fileSmartStore(ports.memory.root), now, l0, knowhow,
      readings: cards.smart!.kpis.map(k => ({ name: k.name, value: kpiValue(kpi, k.name) })) });
  } catch { return null; }
}

// ── Voice ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface VoiceView { now: Date; plan: TickResult; prs: readonly PrInfo[]; rows: readonly LedgerRow[]; kpi: Kpi; slots: number }
const journalRows = (home: string, rows: Parameters<typeof appendJournal>[1]): void => { try { appendJournal(home, rows); } catch { /* fail-soft */ } };

export interface VoiceAnswer { text: string; evidence: string[]; kind: 'why' | 'blocked' | 'next-hour' | 'knowhow' | 'help' }

const fmt = (d: TickResult['decisions'][number]) => `#${d.pr} @${d.head.slice(0, 12)} ${d.action}${d.cls ? ` ${d.cls}` : ''} — ${d.why.slice(0, 140)}${d.next ? ` · 다음: ${d.next.owner} (${d.next.action})` : ''}`;

/** Deterministic, evidence-first answers to the three questions the CEO asks (no LLM: every word comes from the records). */
export function answer(text: string, v: VoiceView, cards?: Pick<StewardCards, 'soulText' | 'knowhowText'>): VoiceAnswer {
  const t = text.trim();
  if (/노하우|knowhow|규칙|rule/iu.test(t) && cards?.knowhowText) {
    const rows = cards.knowhowText.split('\n').filter(l => /^\| T\d+ \|/u.test(l)).map(l => l.split('|').map(x => x.trim()));
    return { kind: 'knowhow', evidence: ['card:graphs/loop-agents/land-steward/knowhow.md'], text: ['기차 매니저 노하우(knowhow.md):', ...rows.map(r => `${r[1]} ${r[2]} → ${r[4]}`)].join('\n') };
  }
  const m = /#(\d{1,7})\b|\b(\d{4,7})\b/u.exec(t); const pr = m?.[1] ?? m?.[2]; // «#12» or a bare 4–7 digit number
  if (pr && /왜|why|안 ?들어|안 ?가|막혀|blocked|stuck|상태/iu.test(t)) {
    const n = Number(pr);
    const d = v.plan.decisions.find(x => x.pr === n);
    const hist = v.rows.filter(r => r.pr === n && !r.synthetic).slice(-4);
    const ev = [`pr:#${n}`, ...hist.map(r => `ledger:${r.at}:${r.event}${r.cls ? `:${r.cls}` : ''}`)];
    if (!d) {
      const p = v.prs.find(x => x.number === n);
      if (!p) {
        const last = hist[hist.length - 1];
        const landed = hist.some(r => r.event === 'landed');
        return { kind: 'why', evidence: ev, text: landed ? `#${n} 은 원장상 착지됨(${hist.find(r => r.event === 'landed')!.at.slice(5, 16)}) — 열린 목록에 없다.`
          : `#${n} 은 열린 PR 목록에 없다 — 상태 미확인(닫힘·병합·없는 번호 중 하나 · gh pr view ${n}).${last ? ` 마지막 기록: ${last.at.slice(5, 16)} ${last.event}${last.cls ? ` ${last.cls}` : ''}` : ''}` };
      }
      return { kind: 'why', evidence: ev, text: `#${n} 은 판단 대상이 아니다: ${p.draft ? 'draft — 작성자가 ready 로 바꾸면 다음 틱에 본다' : 'skip'}` };
    }
    const fin = (v.plan.finisher ?? []).filter(f => f.pr === n).map(f => `마무리꾼 ${f.kind} ${f.state} (${f.why})`);
    return { kind: 'why', evidence: ev, text: [fmt(d), ...fin].join('\n') };
  }
  if (/막힌|막혀|blocked|stuck|지금/iu.test(t)) {
    const non = v.plan.decisions.filter(d => d.action !== 'land');
    if (!non.length) return { kind: 'blocked', evidence: [], text: `막힌 PR 없음 — 준비 ${v.kpi.ready} · 착지 ${v.kpi.landsLastHour}/h` };
    const by = new Map<string, typeof non>();
    for (const d of non) { const k = `${d.next?.owner ?? '주인 없음'} · ${d.cls ?? d.action}`; by.set(k, [...(by.get(k) ?? []), d]); }
    const lines = [...by.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)
      .map(([k, ds]) => `${k}: ${ds.length} (${ds.slice(0, 6).map(d => `#${d.pr}`).join(' ')})`);
    return { kind: 'blocked', evidence: non.slice(0, 12).map(d => `pr:#${d.pr}`), text: [`막힌 ${non.length} · 준비 ${v.kpi.ready}/${v.kpi.judged}`, ...lines].join('\n') };
  }
  if (/다음 ?1?\s*시간|몇 ?건|next hour|how many|forecast/iu.test(t)) {
    const running = (v.plan.finisher ?? []).filter(f => f.state === 'queued' || f.state === 'running' || f.state === 'resolving' || f.state === 'would-run').length;
    const capacity = Math.max(v.kpi.landsLastHour, v.slots * 3); // a live land ≈ 20 min on the merge result → ≤ 3 per slot per hour
    const est = Math.min(v.kpi.ready + running, capacity);
    return { kind: 'next-hour', evidence: v.plan.decisions.filter(d => d.action === 'land').slice(0, 12).map(d => `pr:#${d.pr}`),
      text: `다음 1시간 예상 ${est}건 = min(준비 ${v.kpi.ready} + 마무리 중 ${running}, 용량 ${capacity} = max(지난 1시간 ${v.kpi.landsLastHour}, 슬롯 ${v.slots}×3))` };
  }
  const who = (cards?.soulText ?? '').split('\n').find(l => l.includes('**자리**'))?.replace(/^-\s*\*\*자리\*\*:\s*/u, '') ?? `L0 = ${STEWARD_SUPERVISOR}`;
  return { kind: 'help', evidence: ['card:graphs/loop-agents/land-steward/soul.md'], text: `착지 집사(${who}) — 착지 ${v.kpi.landsLastHour}/h(오늘 ${v.kpi.landsToday}) · 준비 ${v.kpi.ready}/${v.kpi.judged} · 마무리 대기 p50 ${v.kpi.needsFinisherWaitP50Min === null ? '—' : Math.round(v.kpi.needsFinisherWaitP50Min)}분\n묻기: «왜 #N 안 들어가?» · «지금 막힌 것?» · «다음 1시간 몇 건?» · «노하우?»` };
}

/** The view for one voice answer: a dry plan of the body (no lock · no ledger · no cards). */
export async function voiceView(d: LandDeps, book?: FinishBook): Promise<VoiceView> {
  let prs: PrInfo[] = [];
  const plan = await tickLand({ ...stewardDeps(d, 'live', v => { prs = v; }), dry: true });
  // A failed plan (gh down · lock) must never read as «closed» / «nothing blocked»: refuse to answer from it.
  if (plan.error) throw new Error(`body plan failed — ${plan.error}`);
  if (plan.locked) throw new Error('body plan unavailable — a tick holds the lock');
  const rows = readLedger(d.stateRoot);
  const open = prs.filter(p => p.state === 'OPEN');
  return { now: d.now(), plan, prs: open, rows, kpi: measure({ rows, tick: plan, book: book ?? readBook(d.stateRoot), prs: open, now: d.now() }), slots: d.slots };
}
