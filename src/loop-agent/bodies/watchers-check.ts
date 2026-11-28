// 감시자의 감시 (watchers-check) — LOOP-AGENT v2 body (SUPERVISOR-REVIVE-1127 · L0 OP) · a KPI roll-up read (LOOP-AGENTS-AS-PLUGINS P1).
//
// S: the trigger graph watchers-check (graphs/triggers/watchers-check.yaml → src/cli/watch-cli.ts runWatchCheck) judged only
//    the 4 watchers that happened to beat (release-graph-tick · res-patrol · trigger-tick · itself) and could only card
//    CLAUDE-OP (≥100 unread) — a supervisor that never beat was invisible. Its later `restart` lane was the third copy of
//    «stopped → wake once → card the owner» (with the guardian 맥박 and the peer-watch kind).
// C: every LOOP-AGENT v2 card owes a `loop:<id>` beat (runtime beatName); a card with no beat at all is a missing
//    supervisor, not «nothing to see». Waking it is NOT this agent's: a registered agent is refired every window by the
//    trigger registry (goal deadline → retry → one exception card to its owner) and the registry tick itself by the outside
//    clock (src/loops/trigger-clock.ts · the nexus sweep). This agent is fired by that same tick — it cannot help when it stops.
// A: 세 얼굴 —
//   관측 = the beats ledger (`{stateRoot}/watchers/beats.jsonl`, src/kit/heartbeat/index.ts readBeats) judged by judgeWatchers
//          (DEAD > 2× cadence · BROKEN 3 errored beats · BLIND source moved past the cursor) ⊕ every v2 card
//          (src/loop-agent/card.ts listCards → expected `loop:<id>`) ⊕ the core graph watchers. KPI = expected watchers that
//          are MISSING (never beat) or DEAD/BROKEN/BLIND ⊕ recently-alive (24 h) watchers that went bad. Self excluded.
//          A failing reader → KPI null («모름»).
//   판단 근거 = the card · each subject names who owns it now (the registry · the outside clock · the watcher's owner).
//   수복과 인계 = no action of its own (the one right `quiet` is the roll-up itself) — the runtime's KPI ladder cards OP after
//          escalate_after_min when the roll-up stays in breach.
import type { BodyEnv } from '../registry.js';
import type { AgentBody, Observation, Subject } from '../runtime.js';
import { pn } from '../policy-context.js';
import type { Beat, SourceHead, WatcherVerdict } from '../../kit/heartbeat/index.js';
import { judgeWatchers } from '../../kit/heartbeat/index.js';

export const SELF_BEAT = 'loop:watchers-check';
/** Graph watchers that beat today and must keep beating (census 11-27 §2a). */
export const CORE_WATCHERS: readonly string[] = ['trigger-tick', 'res-patrol', 'release-graph-tick'];

export interface WatchersCheckDeps {
  /** The beats ledger tail (null = unreadable). */
  beats(): Beat[] | null;
  sourceHead: SourceHead;
  /** Ids of every v2 card (null = card dir unreadable). */
  cardIds(): string[] | null;
  /** Registered trigger graph ids that still run (null = registry unreadable → the owner line says «?»). */
  triggerIds(): Set<string> | null;
  /** Retired trigger ids — their old beat is history, not a watcher (an absorbed job never beats again). */
  retiredIds?(): ReadonlySet<string> | null;
}

export type WatchStatus = WatcherVerdict['status'] | 'MISSING';
export interface WatchRow { readonly name: string; readonly status: WatchStatus; readonly ageMin: number | null; readonly reason: string; readonly expected: boolean }

/** Pure: expected ∪ recently-alive watchers with their status (self excluded). */
export function watchRows(verdicts: readonly WatcherVerdict[], expected: readonly string[]): WatchRow[] {
  const byName = new Map(verdicts.map(v => [v.name, v]));
  const exp = new Set(expected.filter(n => n !== SELF_BEAT));
  const rows: WatchRow[] = [];
  for (const name of [...exp].sort()) {
    const v = byName.get(name);
    rows.push(v ? { name, status: v.status, ageMin: v.ageMin, reason: v.reason, expected: true } : { name, status: 'MISSING', ageMin: null, reason: 'no beat at all', expected: true });
  }
  for (const v of verdicts) {
    if (exp.has(v.name) || v.name === SELF_BEAT || v.ageMin > pn('recent_min')) continue;
    rows.push({ name: v.name, status: v.status, ageMin: v.ageMin, reason: v.reason, expected: false });
  }
  return rows;
}

/** Who wakes / fixes this watcher now (LOOP-AGENTS-AS-PLUGINS P1 — never this agent). */
function ownerOf(name: string, status: WatchStatus, cards: ReadonlySet<string>, triggers: ReadonlySet<string> | null): string {
  if (status === 'BROKEN' || status === 'BLIND') return '주인이 고칠 것';
  const loop = /^loop:([a-z][a-z0-9-]{0,62})$/u.exec(name);
  if (name === 'trigger-tick') return '바깥 시계(nexus trigger-clock)가 깨움';
  if (CORE_WATCHERS.includes(name)) return '크론 감시자 — 주인이 볼 것';
  if (loop && !cards.has(loop[1]!)) return '카드 없음';
  if (triggers === null) return '레지스트리 ?';
  const id = loop ? loop[1]! : name;
  return triggers.has(id) || triggers.has(`${id}-agent`) ? '레지스트리가 다시 쏘고 주인 카드' : '레지스트리 미등록 — 주인이 등록할 것';
}

export function createBody(_env: BodyEnv, deps: WatchersCheckDeps = liveDeps(_env.stateRoot)): AgentBody {
  const observe = (ctx: { now: Date }): Observation => {
    const beats = deps.beats(); const ids = deps.cardIds();
    if (beats === null || ids === null) return { kpi: null, subjects: [], facts: [beats === null ? 'beats 원장 읽기 실패 → 모름' : 'loop-agent 카드 목록 읽기 실패 → 모름'] };
    const cards = new Set(ids); const triggers = deps.triggerIds();
    const expected = [...CORE_WATCHERS, ...ids.map(id => `loop:${id}`)];
    const retired = deps.retiredIds?.() ?? new Set<string>();
    const rows = watchRows(judgeWatchers(beats, ctx.now, deps.sourceHead, { retired }), expected);
    const bad = rows.filter(r => r.status !== 'OK');
    const subjects: Subject[] = bad.map(r => ({ id: r.name, kind: `watcher-${r.status.toLowerCase()}`,
      summary: `${r.status} · ${r.reason}${r.expected ? '' : ' · (카드 밖 · 24h 안에 살아 있었음)'} · ${ownerOf(r.name, r.status, cards, triggers)}`,
      ...(r.ageMin !== null ? { ageMin: r.ageMin } : {}) }));
    const count = (s: WatchStatus) => bad.filter(r => r.status === s).length;
    const facts = [
      `감시 대상 ${rows.length}(카드 ${ids.length} · 핵심 ${CORE_WATCHERS.length}) · 정상 ${rows.length - bad.length}`,
      `결손 ${bad.length}: MISSING ${count('MISSING')} · DEAD ${count('DEAD')} · BROKEN ${count('BROKEN')} · BLIND ${count('BLIND')}`,
      ...(triggers === null ? ['트리거 레지스트리 읽기 실패 → 주인 ?'] : []),
    ];
    const patterns = bad.filter(r => r.status === 'DEAD').map(r => ({ key: `dead:${r.name}`,
      lesson: `${r.name} 가 일주일에 3번 DEAD 가 됐다 — 레지스트리가 다시 쏴도 멈춘다. 그 루프의 트리거(조건·cron)나 몸의 예외를 주인이 먼저 본다.` }));
    return { kpi: bad.length, subjects, facts, patterns };
  };
  // the roll-up acts on nothing: the registry refires, the outside clock wakes the registry tick, the runtime ladder cards OP
  const plan: AgentBody['plan'] = () => [];
  const actions: AgentBody['actions'] = {
    quiet: {
      describe: '롤업만 — 깨우기·재기동은 트리거 레지스트리(목표 마감 → 재시도 → 주인 카드)와 바깥 시계(레지스트리 틱)의 몫 · 되돌릴 것 없음',
      run(target) { return { ok: true, line: `${target}: 롤업만(행동 없음)` }; },
    },
  };
  return { observe, plan, actions };
}

// ── live deps ────────────────────────────────────────────────────────────────────────────────────────────────────────
export function liveDeps(stateRoot: string): WatchersCheckDeps {
  return {
    beats: () => {
      try { const hb = require('../../kit/heartbeat/index.js') as typeof import('../../kit/heartbeat/index.js'); return hb.readBeats(hb.beatLedgerPath(stateRoot)); }
      catch { return null; }
    },
    sourceHead: (source) => {
      try { return (require('../../cli/watch-cli.js') as typeof import('../../cli/watch-cli.js')).defaultSourceHead()(source); } catch { return null; }
    },
    cardIds: () => {
      try {
        const { cards, errors } = (require('../card.js') as typeof import('../card.js')).listCards();
        // a broken v2 card is still a supervisor we expect to beat — keep its directory name
        const broken = errors.flatMap(e => { const m = /loop-agents\/([a-z][a-z0-9-]{0,62})\/goal\.yaml/u.exec(e); return m ? [m[1]!] : []; });
        return [...new Set([...cards.map(c => c.id), ...broken])];
      } catch { return null; }
    },
    triggerIds: () => {
      try {
        const reg = require('../../loops/trigger-registry.js') as typeof import('../../loops/trigger-registry.js');
        const db = reg.openTriggerRegistry(stateRoot);
        try { return new Set(reg.listLiveTriggers(db).map(r => r.graphId)); } finally { db.close(); }
      } catch { return null; }
    },
    retiredIds: () => {
      try {
        const reg = require('../../loops/trigger-registry.js') as typeof import('../../loops/trigger-registry.js');
        const db = reg.openTriggerRegistry(stateRoot);
        try { return reg.retiredTriggerIds(db); } finally { db.close(); }
      } catch { return null; }
    },
  };
}
